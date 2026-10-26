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

/** Start an authenticated-mode app in an isolated temp directory, with synthetic accounts. */
export async function startAuthApp({ users = ['owner', 'creator', 'creator2', 'manager', 'reviewer'], clock = makeClock(), dir, secureCookies = false, semantic = null, appOptions = {} } = {}) {
  const tmp = dir ? { dir, cleanup: async () => {} } : await tempDir();
  await mkdir(path.join(tmp.dir, 'auth'), { recursive: true });
  const files = { dataFile: path.join(tmp.dir, 'workspace.json'), authFile: path.join(tmp.dir, 'auth', 'users.json') };
  const open = async () => {
    const app = await createApp({ ...files, mode: 'authenticated', semantic, ...appOptions, authOptions: { cost: TEST_COST, nowMs: clock.now, secureCookies } });
    const url = await app.listen(0);
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
    const c = { cookie: null, csrf: null, user: null };
    c.call = async (method, p, { body, headers = {}, origin = url, csrf = c.csrf, cookie = c.cookie, raw } = {}) => {
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
      const res = await fetch(url + p, { method, headers: h, body: payload });
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = buffer.toString("utf8");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, text, buffer, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [] };
    };
    c.login = async (name, password = passwords[name], extra = {}) => {
      const r = await c.call('POST', '/api/auth/login', { body: { username: name.startsWith('syn-') ? name : `syn-${name}`, password }, csrf: null, cookie: null, ...extra });
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
      await app.close();
      ({ app, url } = await open());
    },
    async listDir(sub = '') {
      return readdir(path.join(tmp.dir, sub));
    },
    async readAuthFile() {
      return readFile(files.authFile, 'utf8');
    },
    async close() {
      await app.close();
      await tmp.cleanup();
    },
  };
}

export const newSubmission = (extra = {}) => ({ title: 'Auth test', ...cleanContent(), ...extra });
