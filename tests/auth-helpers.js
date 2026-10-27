import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { tempDir, cleanContent } from './helpers.js';

/** scrypt cost used ONLY by tests, so they run fast. Production default is N=2^17 (OWASP minimum). */
export const TEST_COST = { N: 1024, r: 8, p: 1 };

/** Synthetic, random, throwaway passwords. They exist only in memory during a test run. */
export const synthPassword = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;

export function makeClock(start = Date.parse('2026-10-24T10:00:00Z')) {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
}

// ---------- transport diagnostics (m26) ----------
// A bare "TypeError: fetch failed" from the test client says nothing about WHY. The first clean run of m25b failed that way on the first login of
// "no sensitive payloads are logged…" and the cause was never captured (as with the m20 sources failure before tests/helpers.js got describeFetchFailure).
// When a request made through these helpers fails at the TRANSPORT level (nothing was answered), the error is replaced by one that says what happened:
// the underlying cause chain (code, errno, syscall, address, port, message), the method and route, and where in the app's life it happened (stage, request
// number, age, whether the server was listening, whether the port had served an earlier server in this process, process uptime).
// It only adds information to a failure that is already happening: it retries nothing, swallows nothing and changes no result (the original error is the `cause`).
// It NEVER includes a request body, header, cookie, token, password or user name: only the route (query removed, long id-like segments masked), and every string
// it prints has the request's own secret values removed first, as a second guard.
const HELPER_LOADED_AT = performance.now();
const portsUsed = new Map(); // port -> how many servers these helpers started on it in this process

const cleanText = (s, secrets) => {
  let out = String(s).replace(/\s+/gu, ' ');
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[removed]');
  return out.slice(0, 160);
};
const safeRoute = (route) => String(route).split('?')[0].split('/').map((seg) => (/^[A-Za-z0-9_-]{24,}$/u.test(seg) ? '<id>' : seg)).join('/');

/** One link of an error's cause chain, with only transport facts. */
function describeLink(x, secrets) {
  if (x === null || x === undefined) return 'none';
  if (typeof x !== 'object') return `non-error ${typeof x}`;
  const bits = [x.name ?? 'Error'];
  for (const k of ['code', 'errno', 'syscall', 'address', 'port']) if (x[k] !== undefined) bits.push(`${k}=${cleanText(x[k], secrets)}`);
  if (x.message) bits.push(`message=${JSON.stringify(cleanText(x.message, secrets))}`);
  return bits.join(' ');
}

/**
 * @param e the error fetch (or reading the response body) threw
 * @param {object} at what was being attempted and the app's state: { method, route, phase, step, stage, nth, requests, inflight, ageMs, server, secrets }
 */
export function describeTransportFailure(e, { method, route, phase, step = 'sending the request', stage, nth, requests, inflight, ageMs, server, secrets = [] }) {
  const chain = [];
  for (let cur = e, i = 0; cur !== undefined && cur !== null && i < 5; cur = cur.cause, i++) {
    chain.push(describeLink(cur, secrets));
    if (Array.isArray(cur?.errors) && cur.errors.length) chain.push(`errors[${cur.errors.length}] first: ${describeLink(cur.errors[0], secrets)}`);
  }
  const port = server?.address?.()?.port ?? null;
  const parts = [
    `${cleanText(e?.message ?? e, secrets)} [transport failure: no response] cause: ${chain.join(' <- ')}`,
    `request ${method} ${safeRoute(route)}`,
    `phase=${phase} step=${step} stage=${stage} request#=${nth} appRequests=${requests} inflight=${inflight} appAgeMs=${ageMs}`,
    `server.listening=${server?.listening ?? 'unknown'} server.port=${port} portServedEarlierServers=${port === null ? 'unknown' : (portsUsed.get(port) ?? 0) - 1}`,
    `processUptimeS=${process.uptime().toFixed(1)} helperAgeS=${((performance.now() - HELPER_LOADED_AT) / 1000).toFixed(1)}`,
  ];
  return new Error(parts.join(' | '), { cause: e });
}

/** Start an authenticated-mode app in an isolated temp directory, with synthetic accounts. */
export async function startAuthApp({ users = ['owner', 'creator', 'creator2', 'manager', 'reviewer'], clock = makeClock(), dir, secureCookies = false, semantic = null, appOptions = {} } = {}) {
  const tmp = dir ? { dir, cleanup: async () => {} } : await tempDir();
  await mkdir(path.join(tmp.dir, 'auth'), { recursive: true });
  const files = { dataFile: path.join(tmp.dir, 'workspace.json'), authFile: path.join(tmp.dir, 'auth', 'users.json') };
  // Where this app instance is in its life, for transport diagnostics only (no secrets, nothing here changes behaviour).
  const life = { stage: 'opening', openedAt: performance.now(), requests: 0, inflight: 0 };
  const open = async () => {
    life.stage = 'opening';
    const app = await createApp({ ...files, mode: 'authenticated', semantic, ...appOptions, authOptions: { cost: TEST_COST, nowMs: clock.now, secureCookies } });
    const url = await app.listen(0);
    const port = Number(new URL(url).port);
    portsUsed.set(port, (portsUsed.get(port) ?? 0) + 1);
    life.stage = 'ready';
    life.openedAt = performance.now();
    life.requests = 0;
    return { app, url };
  };
  let { app, url } = await open();

  const passwords = {};
  const ROLE = { owner: 'manager', manager: 'manager', creator: 'creator', creator2: 'creator', reviewer: 'reviewer', manager2: 'manager', reviewer2: 'reviewer' };
  const ids = {};
  if (!dir) {
    for (const name of users) {
      passwords[name] = synthPassword();
      const u = await app.auth.createUser({ username: `syn-${name}`, displayName: `Synthetic ${name}`, role: ROLE[name], password: passwords[name], owner: name === 'owner' });
      ids[name] = u.id;
    }
  }

  /** A browser-like client: keeps the cookie and CSRF token from its own login. */
  const client = () => {
    const c = { cookie: null, csrf: null, user: null, requests: 0 };
    c.call = async (method, p, { body, headers = {}, origin = url, csrf = c.csrf, cookie = c.cookie, raw, phase = 'request' } = {}) => {
      const h = { ...headers };
      if (origin) h.origin = origin;
      if (cookie) h.cookie = cookie;
      if (csrf) h['x-csrf-token'] = csrf;
      let payload;
      if (raw !== undefined) payload = raw;
      else if (body !== undefined) {
        h['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      // What a transport failure may print: the route and the app's state, never the request. The request's own secret values are removed from it as a second guard.
      const secrets = [cookie, csrf, ...String(cookie ?? '').split(/[=;.]/u), ...(body && typeof body === 'object' ? Object.values(body).filter((v) => typeof v === 'string') : [])].filter((s) => typeof s === 'string' && s.length >= 4);
      const fail = (e, step) => describeTransportFailure(e, { method, route: p, phase, step, stage: life.stage, nth: c.requests, requests: life.requests, inflight: life.inflight, ageMs: Math.round(performance.now() - life.openedAt), server: app.server, secrets });
      c.requests++;
      life.requests++;
      life.inflight++;
      let res;
      let buffer;
      try {
        res = await fetch(url + p, { method, headers: h, body: payload }).catch((e) => {
          throw fail(e, 'sending the request');
        });
        buffer = Buffer.from(await res.arrayBuffer().catch((e) => {
          throw fail(e, 'reading the response body');
        }));
      } finally {
        life.inflight--;
      }
      const text = buffer.toString("utf8");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text, buffer, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [] };
    };
    c.login = async (name, password = passwords[name], extra = {}) => {
      const r = await c.call('POST', '/api/auth/login', { body: { username: name.startsWith('syn-') ? name : `syn-${name}`, password }, csrf: null, cookie: null, phase: 'login', ...extra });
      if (r.status === 200) {
        c.cookie = r.setCookie[0].split(';')[0];
        c.csrf = r.json.csrf;
        c.user = r.json.user;
      }
      return r;
    };
    return c;
  };

  const as = async (name) => {
    const c = client();
    const r = await c.login(name);
    if (r.status !== 200) throw new Error(`synthetic login failed for ${name}: ${r.status}`);
    return c;
  };

  return {
    clock,
    files,
    dir: tmp.dir,
    passwords,
    ids,
    get app() {
      return app;
    },
    get url() {
      return url;
    },
    client,
    as,
    async restart() {
      life.stage = 'restarting (closing the first server)';
      await app.close();
      ({ app, url } = await open());
    },
    /** Where this app is in its life (stage, requests so far, age): what a transport failure reports. No secrets. */
    lifecycle: () => ({ stage: life.stage, requests: life.requests, inflight: life.inflight, ageMs: Math.round(performance.now() - life.openedAt), listening: app.server.listening }),
    async listDir(sub = '') {
      return readdir(path.join(tmp.dir, sub));
    },
    async readAuthFile() {
      return readFile(files.authFile, 'utf8');
    },
    async close() {
      life.stage = 'closing';
      await app.close();
      life.stage = 'closed';
      await tmp.cleanup();
    },
  };
}

export const newSubmission = (extra = {}) => ({ title: 'Auth test', ...cleanContent(), ...extra });
