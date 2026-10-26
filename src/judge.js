/**
 * Isolated fictional judge demo: many visitors, one process, one HTTP listener, no sign-in, no shared workspace.
 *
 * How it works (docs/judge-demo.md has the trade-offs and limits):
 *  - This module is the ONLY thing that listens on a socket. A visitor is identified by one server-chosen, unpredictable,
 *    opaque cookie (256 random bits). The cookie value is never used as a file name: it is hashed (SHA-256), and the hash names the
 *    visitor's folder inside a dedicated demo root. The visitor's workspace is chosen from the cookie ONLY, never from a URL, query,
 *    header or body, so there is no identifier a visitor could change to reach someone else's data.
 *  - Each visitor's requests go to that visitor's own instance of the real app (createApp: the same rules, approval gates and
 *    evidence checks as everywhere else) running on its own workspace file. Those instances never call listen(); the dispatcher
 *    hands them requests directly.
 *  - Growth is bounded: a cap on sessions, on how many instances are open in memory at once (the least recently used idle one is
 *    closed and transparently re-opened from its file), on how fast new sessions can start, on bytes per session, and every session
 *    expires (idle and absolute lifetimes). At a cap the visitor gets a clear message, not a hang.
 *  - Everything it writes or deletes is inside ONE dedicated root that it created itself (marked, empty on first use). A folder
 *    that already holds anything else is refused, so real data cannot be adopted or swept by accident. Only entries it can prove are
 *    its own (a 64-hex folder name carrying its own marker file) are ever removed.
 *
 * Not authentication. Whoever holds a session's cookie is that visitor; the role picker inside the demo is a simulation.
 * Nothing here sends data anywhere. All data is fictional.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createApp, hostAllowed, hostAnswerer, loadPublicFiles, sameSite, serveStaticFile, LOCAL_HOST, SECURITY_HEADERS } from './app.js';
import { ASSET_LIMITS } from './assets.js';
import { acquireOwnership } from './lock.js';
import { createOcr } from './ocr.js';
import { createSemantic, createWorkerEmbedder } from './semantic.js';
import { HttpError } from './util.js';

export const ROOT_MARKER = '.brandproof-judge-root';
const ROOT_KIND = 'brandproof-judge-demo-root';
const SESSION_FILE = 'session.json';
const SESSION_KIND = 'brandproof-judge-session';
const WORKSPACE = 'workspace.json';
const HASH = /^[0-9a-f]{64}$/;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const MIB = 1024 * 1024;

/** Defaults and the range each limit may take (the same ranges are enforced for the environment settings). */
export const JUDGE_LIMITS = Object.freeze({
  maxSessions: { default: 100, min: 1, max: 5000, what: 'sessions that may exist at once' },
  maxLive: { default: 12, min: 1, max: 200, what: 'sessions held open in memory at once' },
  idleMinutes: { default: 120, min: 1, max: 1440, what: 'minutes of inactivity before a session expires' },
  maxHours: { default: 12, min: 1, max: 168, what: 'hours after which a session expires however active it is' },
  newPerMinute: { default: 20, min: 1, max: 1000, what: 'new sessions that may start per minute' },
  sessionKiB: { default: 5 * 1024, min: 64, max: 512 * 1024, what: 'KiB of storage per session (workspace file plus images)' },
  imageKiB: { default: 3 * 1024, min: 0, max: 256 * 1024, what: 'KiB of images per session' },
  imageCount: { default: 6, min: 0, max: 200, what: 'images per session' },
  maxConnections: { default: 200, min: 1, max: 10000, what: 'simultaneous connections' },
});

export function normalizeLimits(given = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(JUDGE_LIMITS)) {
    const v = given[key] ?? spec.default;
    if (!Number.isInteger(v) || v < spec.min || v > spec.max) throw new Error(`Judge demo limit ${key} (${spec.what}) must be a whole number from ${spec.min} to ${spec.max}; it is ${JSON.stringify(v)}.`);
    out[key] = v;
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_GONE = 'This demo session has ended or was not found. Reload the page to start a new demo session.';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A plain page for a visitor who cannot get a session (capacity, rate). Uses the app's own stylesheet; no script. */
function noticePage(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · BrandProof</title><link rel="stylesheet" href="/styles.css"></head><body><main class="page-notice"><div class="notice warn" role="status"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p class="small">BrandProof judge demo. Everything here is fictional, and each visitor's session is kept separate.</p></div></main></body></html>`;
}

async function isRealDirectory(p) {
  try {
    const st = await fs.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Make sure `root` is a folder this feature may own: absent (created), empty (adopted), or already marked as a judge-demo root.
 * Anything else is refused untouched.
 */
async function prepareRoot(root) {
  let entries = null;
  try {
    const st = await fs.lstat(root);
    if (st.isSymbolicLink()) throw new Error(`The judge-demo root ${root} is a symbolic link. Use the real folder.`);
    if (!st.isDirectory()) throw new Error(`The judge-demo root ${root} exists but is not a folder.`);
    entries = await fs.readdir(root);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const marker = path.join(root, ROOT_MARKER);
  if (entries === null) await fs.mkdir(root, { recursive: true });
  else if (entries.length) {
    let ok = false;
    try {
      ok = JSON.parse(await fs.readFile(marker, 'utf8'))?.kind === ROOT_KIND;
    } catch {}
    if (!ok) {
      throw new Error(`The judge-demo root ${root} is not empty and was not created by the judge demo. It only ever writes inside a folder it made itself, so it will not use this one (nothing was read, changed or deleted). Choose a new or empty folder.`);
    }
  }
  try {
    await fs.writeFile(marker, JSON.stringify({ kind: ROOT_KIND, v: 1, createdAt: new Date().toISOString(), note: 'Disposable fictional demo sessions only. Safe to delete this whole folder when the demo is stopped.' }), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
}

/**
 * @param {object} options
 * @param {string} options.root                 dedicated demo root (required)
 * @param {Array<string>|'*'} [options.allowedHosts]
 * @param {object} [options.limits]             see JUDGE_LIMITS
 * @param {boolean} [options.secureCookie]      add Secure and the __Host- prefix (set it when the public address is https)
 * @param {() => number} [options.clock]        milliseconds (tests move it)
 * @param {object|null} [options.semantic]      shared matching service; undefined = default, null = off
 * @param {object|null} [options.ocr]           shared reading service; undefined = default, null = off
 * @param {boolean} [options.ephemeral]         the demo root is on temporary storage (a free hosting tier): the page then says sessions are lost when the
 *                                              service restarts or sleeps
 * @param {() => Buffer} [options.idSource]     the 32 random bytes of a new session id. A test seam (to force a collision and test the rollback);
 *                                              the default is crypto.randomBytes and nothing in the product replaces it.
 */
export async function createJudgeDemo({ root, allowedHosts = [], limits: limitsIn, secureCookie = false, clock = () => Date.now(), semantic, ocr, idSource = () => crypto.randomBytes(32), ephemeral = false } = {}) {
  if (!root || typeof root !== 'string') throw new Error('The judge demo needs its own root folder.');
  if (allowedHosts !== '*' && !(Array.isArray(allowedHosts) && allowedHosts.every((h) => typeof h === 'string'))) throw new Error('allowedHosts must be "*" or a list of host names.');
  const limits = normalizeLimits(limitsIn);
  const rootDir = path.resolve(root);
  await prepareRoot(rootDir);
  let ownership;
  try {
    ownership = await acquireOwnership(path.join(rootDir, 'root-owner'), { purpose: 'judge-root' });
  } catch (e) {
    throw new Error(`This judge-demo root is already in use by another BrandProof process (one process per root). ${e.message}`);
  }

  const sessionsDir = path.join(rootDir, 'sessions');
  const idleMs = limits.idleMinutes * 60_000;
  const maxAgeMs = limits.maxHours * 3_600_000;
  const cookieName = secureCookie ? '__Host-bp_judge' : 'bp_judge';
  const answersTo = hostAnswerer(allowedHosts);
  const assetLimits = { ...ASSET_LIMITS, totalBytes: limits.imageKiB * 1024, count: limits.imageCount };

  // The matching and reading services are heavy and stateless per workspace, so every visitor's app shares ONE of each
  // (their own queues and limits then bound the total work). Whoever creates a service stops it.
  const ownsServices = { semantic: semantic === undefined, ocr: ocr === undefined };
  const sem = semantic === undefined ? createSemantic({ embedder: process.env.BRANDPROOF_SEMANTIC === 'off' ? null : createWorkerEmbedder() }) : (semantic ?? createSemantic({ embedder: null }));
  const reader = ocr === undefined ? createOcr() : (ocr ?? createOcr({ availability: () => ({ ok: false, reason: 'reading text from images is switched off' }) }));
  if (semantic === undefined) sem.warm?.();

  const stopOwnedServices = () => {
    if (ownsServices.semantic) sem.stop?.();
    if (ownsServices.ocr) reader.stop?.();
  };

  let files;
  try {
    files = await loadPublicFiles();
  } catch (e) {
    stopOwnedServices();
    await ownership.release();
    throw e;
  }

  const index = new Map(); // hash -> record, for every session that exists on disk and has not expired
  const createdAt = []; // start times of recent new sessions (rate limit)
  let live = 0; // session apps currently open
  let admitting = 0; // new sessions that have claimed a slot but are not committed yet
  let closed = false;

  // ---------- session records ----------
  const expiresAtOf = (r) => Math.min(r.lastSeen + idleMs, r.created + maxAgeMs);
  const isExpired = (r) => clock() >= expiresAtOf(r);
  const dirOf = (hash) => path.join(sessionsDir, hash);

  async function writeSessionFile(r) {
    r.persistedSeen = r.lastSeen;
    await fs.writeFile(path.join(r.dir, SESSION_FILE), JSON.stringify({ kind: SESSION_KIND, v: 1, created: r.created, lastSeen: r.lastSeen, replaced: r.replaced }), { mode: 0o600 });
  }

  /** Remove one session's folder. Only a real folder with a 64-hex name inside the sessions folder that carries our own marker file. */
  async function removeSessionDir(hash) {
    if (!HASH.test(hash)) return;
    const dir = dirOf(hash);
    if (!(await isRealDirectory(dir))) return;
    try {
      if (JSON.parse(await fs.readFile(path.join(dir, SESSION_FILE), 'utf8'))?.kind !== SESSION_KIND) return;
    } catch {
      return; // not ours (or unreadable): leave it alone
    }
    await fs.rm(dir, { recursive: true, force: true });
  }

  async function loadIndex() {
    for (const name of await fs.readdir(sessionsDir)) {
      if (!HASH.test(name) || !(await isRealDirectory(dirOf(name)))) continue;
      let m;
      try {
        m = JSON.parse(await fs.readFile(path.join(dirOf(name), SESSION_FILE), 'utf8'));
      } catch {
        continue;
      }
      if (m?.kind !== SESSION_KIND || !Number.isFinite(m.created) || !Number.isFinite(m.lastSeen)) continue;
      const r = newRecord(name, m.created, m.lastSeen, Boolean(m.replaced));
      if (isExpired(r)) await removeSessionDir(name);
      else index.set(name, r);
    }
  }

  const newRecord = (hash, created, lastSeen, replaced) => ({ hash, dir: dirOf(hash), created, lastSeen, persistedSeen: lastSeen, replaced, app: null, gate: Promise.resolve(), inflight: 0, lastUsed: 0, writes: 0, writeTail: Promise.resolve() });

  /** Run a lifecycle step (open, close, reset) for one session after any other step on it has finished. */
  const serial = (r, fn) => {
    const p = r.gate.then(fn);
    r.gate = p.catch(() => {});
    return p;
  };

  async function purge(r) {
    if (r.inflight > 0) return false;
    await serial(r, async () => {
      if (r.app) await closeApp(r);
    });
    index.delete(r.hash);
    await removeSessionDir(r.hash);
    return true;
  }

  async function sweep() {
    if (closed) return;
    for (const r of [...index.values()]) if (isExpired(r)) await purge(r).catch(() => {});
    // Close instances that have been idle a while so locks and memory are not held for nothing (they re-open on the next request).
    const idleBefore = clock() - 5 * 60_000;
    for (const r of [...index.values()]) if (r.app && r.inflight === 0 && r.lastUsed < idleBefore) await serial(r, () => (r.app && r.inflight === 0 ? closeApp(r) : undefined)).catch(() => {});
  }
  const sweeper = setInterval(() => void sweep(), 60_000);
  sweeper.unref();

  // ---------- opening and closing a visitor's app ----------
  async function closeApp(r) {
    const app = r.app;
    r.app = null;
    live--;
    await app.close();
  }

  async function reserveLive(except) {
    // Every open session may be in the middle of a request for a moment: wait a little for one to become idle, then say so plainly.
    const giveUpAt = Date.now() + 3000;
    while (live >= limits.maxLive) {
      const victim = [...index.values()].filter((x) => x.app && x !== except && x.inflight === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (victim) await serial(victim, () => (victim.app && victim.inflight === 0 ? closeApp(victim) : undefined)).catch(() => {});
      else if (Date.now() >= giveUpAt) throw new HttpError(503, 'demo_busy', 'The demo is very busy right now. Please try again in a moment.');
      else await new Promise((r) => setTimeout(r, 20));
    }
    live++;
  }

  const appOptions = (r) => ({
    dataFile: path.join(r.dir, WORKSPACE),
    clock: () => new Date(clock()).toISOString(),
    semantic: sem,
    ocr: reader,
    sharedServices: true,
    assetLimits,
    allowedHosts,
    metaExtra: { judge: { enabled: true } },
  });

  /** Open (or return) the visitor's app and count one request in flight against it. */
  function acquire(r) {
    return serial(r, async () => {
      if (!r.app) {
        await reserveLive(r);
        try {
          try {
            r.app = await createApp(appOptions(r));
          } catch (e) {
            // A previous run that was killed can leave this session's runtime lock marker behind. Everything under the demo root belongs to
            // this process (it holds the root), so a stale marker inside this one session folder is cleared and the open is tried once more.
            if (e.code !== 'workspace_in_use') throw e;
            for (const name of await fs.readdir(r.dir)) if (/^workspace\.json\.lock(\.takeover)?$/i.test(name)) await fs.rm(path.join(r.dir, name), { force: true });
            r.app = await createApp(appOptions(r));
          }
        } catch (e) {
          live--;
          throw e;
        }
      }
      r.inflight++;
      r.lastUsed = clock();
      return r.app;
    });
  }
  const release = (r) => {
    r.inflight = Math.max(0, r.inflight - 1);
  };

  // ---------- cookies and sessions ----------
  /** { present, value }: value is the cookie's value only if there is exactly one cookie of our name and it has the right shape. */
  function readCookie(req) {
    const found = [];
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === cookieName) found.push(part.slice(eq + 1).trim());
    }
    return { present: found.length > 0, value: found.length === 1 && COOKIE_VALUE.test(found[0]) ? found[0] : null };
  }

  function lookup(value) {
    if (!value) return null;
    const r = index.get(sha256(value));
    if (!r) return null;
    if (isExpired(r)) {
      void purge(r).catch(() => {});
      return null;
    }
    return r;
  }

  function touch(r) {
    r.lastSeen = clock();
    if (r.lastSeen - r.persistedSeen > 60_000) void writeSessionFile(r).catch(() => {});
  }

  function cookieHeader(value, r) {
    const seconds = Math.max(1, Math.floor((expiresAtOf(r) - clock()) / 1000));
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secureCookie ? '; Secure' : ''}`;
  }

  /**
   * Claim a slot for a new session. The checks (start rate, session cap) and the claim happen in ONE synchronous step, with no await in
   * between, so many simultaneous starts cannot all pass the same check before any of them has been counted. A claim counts against both
   * limits at once (`admitting` against the cap, a time stamp against the rate) until the session is committed or the claim is rolled back.
   */
  function claimSlot() {
    const now = clock();
    while (createdAt.length && createdAt[0] <= now - 60_000) createdAt.shift();
    if (createdAt.length >= limits.newPerMinute) return { refusal: new HttpError(429, 'demo_busy', 'Many people are starting the demo at once. Please try again in a minute.') };
    if (index.size + admitting >= limits.maxSessions) return { refusal: new HttpError(503, 'demo_full', 'The demo is at capacity right now: every demo session slot is in use. Please try again later.') };
    admitting++;
    createdAt.push(now);
    return { now };
  }

  async function createSession(replaced) {
    let claim = claimSlot();
    if (claim.refusal?.code === 'demo_full') {
      await sweep(); // expired sessions may free a slot; the claim is then tried again as one step
      claim = claimSlot();
    }
    if (claim.refusal) throw claim.refusal;
    const { now } = claim;
    try {
      const id = idSource().toString('base64url');
      const hash = sha256(id);
      const r = newRecord(hash, now, now, replaced);
      await fs.mkdir(r.dir); // fails (and touches nothing) if the folder already exists, so an existing session is never overwritten
      try {
        await writeSessionFile(r);
      } catch (e) {
        await fs.rm(r.dir, { recursive: true, force: true }); // our own, half-made folder
        throw e;
      }
      index.set(hash, r);
      return { id, record: r };
    } catch (e) {
      // roll the claim back completely: a failed start must not use up a slot or a place in the start rate
      const i = createdAt.lastIndexOf(now);
      if (i >= 0) createdAt.splice(i, 1);
      throw e;
    } finally {
      admitting--;
    }
  }

  // Writes to one session take turns (a read never waits). Each write's storage check then sees the result of the one before it, so
  // simultaneous writes cannot all pass the same check and overshoot the cap; at most ONE write can land beyond it.
  const MAX_QUEUED_WRITES = 16;
  function enterWrite(r) {
    if (r.writes >= MAX_QUEUED_WRITES) throw new HttpError(429, 'session_busy', 'Too many changes are being made to this demo session at once. Please wait a moment and try again.');
    r.writes++;
    const before = r.writeTail;
    let open;
    r.writeTail = new Promise((resolve) => (open = resolve));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      r.writes--;
      open();
    };
    return before.then(() => release);
  }

  /** Bytes this session uses on disk: its workspace file and its images (our own files only; links are not followed). */
  async function sessionBytes(r) {
    let total = 0;
    for (const name of await fs.readdir(r.dir)) {
      if (!name.startsWith(WORKSPACE)) continue;
      const p = path.join(r.dir, name);
      const st = await fs.lstat(p);
      if (st.isDirectory()) for (const f of await fs.readdir(p)) total += (await fs.lstat(path.join(p, f))).size;
      else total += st.size;
    }
    return total;
  }

  async function resetSession(r) {
    for (let waited = 0; r.inflight > 0; waited += 50) {
      if (waited >= 5000) throw new HttpError(409, 'demo_busy', 'The session is busy; try again in a moment.');
      await new Promise((res) => setTimeout(res, 50));
    }
    await serial(r, async () => {
      if (r.app) await closeApp(r);
      for (const name of await fs.readdir(r.dir)) if (name.startsWith(WORKSPACE)) await fs.rm(path.join(r.dir, name), { recursive: true, force: true });
    });
  }

  // ---------- requests ----------
  async function handle(req, res) {
    const send = (status, payload, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
    };
    try {
      // Liveness for a hosting platform's health check: answered first, from nothing but a constant. It allocates no session, takes no
      // admission slot, counts toward no rate, needs no cookie and reveals no path, token or state; so it also answers whatever Host
      // the checker sends (a Host-guard refusal would make a healthy service look dead).
      if ((req.url ?? '').split('?')[0] === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, undefined, { allow: 'GET, HEAD' });
        return send(closed ? 503 : 200, { status: closed ? 'stopping' : 'ok' });
      }
      const host = req.headers.host || '';
      const local = LOCAL_HOST.test(host);
      if (!local && !hostAllowed(host, answersTo)) throw new HttpError(403, 'bad_host', 'This server only answers on localhost.');
      const url = new URL(req.url, `http://${host}`);
      const p = url.pathname;
      const read = req.method === 'GET' || req.method === 'HEAD';

      if (p.startsWith('/api/')) {
        const { value } = readCookie(req);
        const r = lookup(value);
        if (!r) throw new HttpError(401, 'session_unavailable', SESSION_GONE);
        touch(r);
        const cookie = cookieHeader(value, r);

        if (p === '/api/judge/session') {
          if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
          return send(
            200,
            {
              enabled: true,
              fictional: true,
              createdAt: new Date(r.created).toISOString(),
              expiresAt: new Date(expiresAtOf(r)).toISOString(),
              idleMinutes: limits.idleMinutes,
              maxHours: limits.maxHours,
              replacedPrevious: r.replaced,
              ephemeral: Boolean(ephemeral),
              storage: { usedBytes: await sessionBytes(r), maxBytes: limits.sessionKiB * 1024 },
            },
            undefined,
            { 'set-cookie': cookie },
          );
        }
        if (p === '/api/judge/reset') {
          if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
          if (req.headers.origin === undefined || !sameSite(req.headers.origin, host, local)) throw new HttpError(403, 'bad_origin', 'Cross-origin requests are not allowed.');
          await resetSession(r);
          touch(r);
          return send(200, { reset: true, expiresAt: new Date(expiresAtOf(r)).toISOString() }, undefined, { 'set-cookie': cookie });
        }
        if (p.startsWith('/api/judge/')) throw new HttpError(404, 'not_found', 'No such API route.');

        // Writes take turns per session and are refused once the session's storage cap is reached (reads keep working and never wait),
        // so a session cannot grow without bound, not even through simultaneous writes.
        let releaseWrite = () => {};
        if (!read) {
          releaseWrite = await enterWrite(r);
          try {
            if (res.destroyed) return releaseWrite(); // the visitor went away while waiting for its turn
            const incoming = Number(req.headers['content-length']) || 0;
            const used = await sessionBytes(r);
            if (used + incoming > limits.sessionKiB * 1024) {
              throw new HttpError(413, 'session_full', `This demo session's storage is full (${(used / MIB).toFixed(1)} of ${(limits.sessionKiB / 1024).toFixed(1)} MB). Use “Reset my demo” to start again with fresh fictional data.`);
            }
          } catch (e) {
            releaseWrite();
            throw e;
          }
        }
        let app;
        try {
          app = await acquire(r);
        } catch (e) {
          releaseWrite();
          throw e;
        }
        // the turn (and the request count) end when the response has been sent, i.e. after the write has been saved
        res.once('close', () => {
          release(r);
          releaseWrite();
        });
        res.setHeader('set-cookie', cookie);
        app.server.emit('request', req, res);
        return;
      }

      if (!read) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      if (p === '/') {
        // The page is the one place a session starts. A cookie that does not name a live session (never valid, tampered, expired, or
        // from before a restart that lost it) is never adopted: a NEW session is made and the page says the earlier one is gone.
        const c = readCookie(req);
        let r = lookup(c.value);
        let value = c.value;
        if (!r && req.method === 'GET') {
          const made = await createSession(c.present);
          r = made.record;
          value = made.id;
        }
        const extra = r ? { 'set-cookie': cookieHeader(value, r) } : {};
        if (r) touch(r);
        return await serveStaticFile(files.get('/index.html'), req, res, extra);
      }
      const entry = files.get(p);
      if (!entry) throw new HttpError(404, 'not_found', 'Not found.');
      await serveStaticFile(entry, req, res);
    } catch (e) {
      if (!(e instanceof HttpError)) {
        console.error('Unhandled error:', e);
        e = new HttpError(500, 'internal', 'Something went wrong on the server.');
      }
      if (res.headersSent) return res.end();
      if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === '/' && (e.code === 'demo_full' || e.code === 'demo_busy')) {
        return send(e.status, noticePage(e.code === 'demo_full' ? 'The demo is full' : 'The demo is busy', e.message), 'text/html; charset=utf-8', { 'retry-after': '60' });
      }
      send(e.status, { error: { code: e.code, message: e.message, details: e.details } }, undefined, e.status === 503 || e.status === 429 ? { 'retry-after': '60' } : {});
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.maxConnections = limits.maxConnections;
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  try {
    await loadIndex();
  } catch (e) {
    clearInterval(sweeper);
    stopOwnedServices();
    await ownership.release();
    throw e;
  }

  return {
    server,
    mode: 'judge',
    limits,
    rootDir,
    /** Listen on `wantedPort` at `host`. This is the only listener: visitors' apps never listen. */
    listen(wantedPort = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onListening = () => {
          server.off('error', onError);
          resolve(`http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`);
        };
        const onError = (e) => {
          server.off('listening', onListening);
          reject(e);
        };
        server.once('error', onError);
        server.listen(wantedPort, host, onListening);
      });
    },
    stats: () => ({ sessions: index.size, live, maxSessions: limits.maxSessions, maxLive: limits.maxLive }),
    sweep,
    /** Stop serving, let every open visitor's saves finish, release the root and stop the services this created. */
    async close() {
      closed = true;
      clearInterval(sweeper);
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      for (const r of index.values()) {
        await serial(r, async () => {
          if (r.app) await closeApp(r);
          if (r.lastSeen !== r.persistedSeen) await writeSessionFile(r).catch(() => {});
        }).catch(() => {});
      }
      stopOwnedServices();
      await ownership.release();
    },
  };
}
