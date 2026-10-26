/**
 * Local authentication for the authenticated-workspace mode.
 *
 * Bounded threat model (see docs/authentication.md): a local, single-machine app used by a small team on a
 * trusted computer or LAN-less laptop. We defend against: a person at the keyboard guessing passwords, a
 * web page in the same browser trying to forge requests (CSRF) or read the session (XSS), a client lying about
 * its role, a stolen copy of the credential file, and a stolen/stale session. We do NOT claim protection against
 * a compromised computer, an attacker who can read the server's memory, network eavesdropping (no TLS here),
 * or multi-tenant isolation.
 *
 * Choices follow OWASP Cheat Sheets (Password Storage, Session Management, CSRF Prevention, Authentication)
 * and Node's built-in crypto. No custom cryptography.
 */
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from './store.js';
import { HttpError } from './util.js';

const scryptAsync = promisify(scrypt);

// OWASP Password Storage: scrypt minimum N=2^17, r=8, p=1 (128 MiB). Tests lower N explicitly and say so.
export const DEFAULT_COST = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
const KEYLEN = 32;
const MAX_N = 2 ** 20;

export const ROLE_IDS = ['creator', 'manager', 'reviewer'];
export const PASSWORD_MIN = 15; // OWASP/NIST SP 800-63B: 15 when no second factor
export const PASSWORD_MAX = 128;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const COMMON = new Set(
  ['password', 'passwordpassword', 'passwordpassword1', 'password123456789', '123456789012345', '1234567890123456', 'qwertyuiopasdfgh', 'qwertyqwertyqwerty', 'iloveyouiloveyou', 'letmeinletmein1', 'welcome12345678', 'changemechangeme', 'administrator123', 'brandproof123456', 'brandproofbrandproof'].map((s) => s.toLowerCase()),
);

const scryptOptions = ({ N, r, p }) => ({ N, r, p, maxmem: 256 * N * r });

export async function hashPassword(password, cost = DEFAULT_COST) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, scryptOptions(cost));
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function parseHash(record) {
  const parts = typeof record === 'string' ? record.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  return { N, r, p, salt: Buffer.from(parts[4], 'base64url'), key: Buffer.from(parts[5], 'base64url') };
}

export async function verifyPassword(password, record) {
  const h = parseHash(record);
  if (!h || h.key.length !== KEYLEN) return false;
  const key = await scryptAsync(password.normalize('NFKC'), h.salt, KEYLEN, scryptOptions(h));
  return timingSafeEqual(key, h.key);
}

export function passwordProblems(password, { username = '', displayName = '' } = {}) {
  const out = [];
  if (typeof password !== 'string') return ['Password is required.'];
  const len = [...password].length;
  if (len < PASSWORD_MIN) out.push(`Use at least ${PASSWORD_MIN} characters (a passphrase works well).`);
  if (len > PASSWORD_MAX) out.push(`Use at most ${PASSWORD_MAX} characters.`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) out.push('That password is too common.');
  for (const id of [username, displayName]) {
    if (id && id.length >= 3 && lower.includes(id.toLowerCase())) {
      out.push('The password must not contain the username or display name.');
      break;
    }
  }
  return out;
}

// ---------- rate limiting / lockout ----------

/** Failures are counted per account name (so rotating addresses does not help) and, more loosely, per address. */
export function createLimiter({ nowMs = Date.now, accountMax = 5, ipMax = 30, windowMs = 15 * 60_000, lockMs = 15 * 60_000, maxLockMs = 2 * 3_600_000 } = {}) {
  const buckets = new Map();
  const bucket = (key) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { fails: [], lockUntil: 0, locks: 0 }));
    return b;
  };
  const trim = (b, t) => {
    b.fails = b.fails.filter((x) => t - x < windowMs);
  };
  const sweep = (t) => {
    if (buckets.size < 5000) return;
    for (const [k, b] of buckets) if (b.lockUntil < t && !b.fails.some((x) => t - x < windowMs)) buckets.delete(k);
  };
  return {
    /** Returns seconds to wait, or 0 if the attempt may proceed. */
    retryAfter(account, ip) {
      const t = nowMs();
      let wait = 0;
      for (const key of [`a:${account}`, `i:${ip}`]) {
        const b = buckets.get(key);
        if (b && b.lockUntil > t) wait = Math.max(wait, Math.ceil((b.lockUntil - t) / 1000));
      }
      return wait;
    },
    fail(account, ip) {
      const t = nowMs();
      sweep(t);
      for (const [key, max] of [[`a:${account}`, accountMax], [`i:${ip}`, ipMax]]) {
        const b = bucket(key);
        trim(b, t);
        b.fails.push(t);
        if (b.fails.length >= max) {
          b.locks++;
          b.lockUntil = t + Math.min(maxLockMs, lockMs * 2 ** (b.locks - 1)); // doubles on repeat
          b.fails = [];
        }
      }
    },
    succeed(account) {
      const b = buckets.get(`a:${account}`);
      if (b) {
        b.fails = [];
        b.locks = 0;
        b.lockUntil = 0;
      }
    },
    size: () => buckets.size,
  };
}

/** At most `limit` scrypt jobs at once (each can use 128 MiB), with a bounded wait queue. */
function createGate(limit, maxQueue) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active < limit && q.length) {
      active++;
      q.shift()();
    }
  };
  return async (fn) => {
    if (active >= limit && q.length >= maxQueue) throw new HttpError(503, 'busy', 'Too many sign-ins at once. Try again in a moment.');
    await new Promise((resolve) => {
      q.push(resolve);
      next();
    });
    try {
      return await fn();
    } finally {
      active--;
      next();
    }
  };
}

// ---------- auth service ----------

export const AUTH_KIND = 'brandproof-auth';
const emptyAuthState = () => ({ schemaVersion: 1, kind: AUTH_KIND, seq: { user: 0 }, users: [], audit: [] });
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const safeId = (s) => (/^[a-z0-9._-]{1,64}$/.test(s) ? s : '(invalid)');

export async function openAuth(file, options = {}) {
  const store = await Store.open(file, emptyAuthState, {
    purpose: 'credentials',
    backup: true,
    fileMode: 0o600,
    validate: (s) => {
      if (s.kind !== AUTH_KIND) throw new Error(`${file} is not a BrandProof authentication file; refusing to use it.`);
    },
  });
  return createAuth(store, options);
}

/**
 * Credential generations: every change that should end old access (password change or reset, disable/enable)
 * bumps `credVersion` on the user inside the serialised store mutation. Anything that captured the old
 * generation (an in-flight login, an in-flight password change, a live session) is rejected against the
 * CURRENT record at the point it would take effect, never against a copy read before an await.
 *
 * Test seam: `hasher` replaces the scrypt functions so tests can count and park hashing deterministically.
 */
export function createAuth(store, { nowMs = Date.now, cost = DEFAULT_COST, idleMs = 30 * 60_000, absoluteMs = 8 * 3_600_000, secureCookies = false, limiter, maxSessionsPerUser = 5, hasher = { hashPassword, verifyPassword } } = {}) {
  const H = hasher;
  const lim = limiter ?? createLimiter({ nowMs });
  const sessions = new Map(); // sid -> { userId, credVersion, secretHash, csrf, createdAt, lastSeen }
  const gate = createGate(2, 8); // every scrypt computation, including the dummy one, goes through this
  const COOKIE = secureCookies ? '__Host-bp_session' : 'bp_session';
  const gen = (u) => u.credVersion ?? 1;

  // One shared dummy hash (used so unknown accounts cost the same as real ones), computed once, under the gate.
  let dummyPromise = null;
  const getDummy = () => {
    dummyPromise ??= gate(() => H.hashPassword(randomBytes(12).toString('hex'), cost)).catch((e) => {
      dummyPromise = null; // allow a later retry
      throw e;
    });
    return dummyPromise;
  };
  getDummy().catch(() => {}); // warm it at start-up so the first unknown-account sign-in is not special

  const audit = (d, event, actor, subject, ip) => {
    d.audit.push({ at: new Date(nowMs()).toISOString(), event, actor: actor ?? null, subject: subject ?? null, ip: ip ?? null });
    if (d.audit.length > 2000) d.audit.splice(0, d.audit.length - 2000);
  };
  /** Failure events are recorded best-effort: an audit write problem must not turn a refusal into a different outcome. */
  const auditQuietly = (...args) => store.mutate((d) => audit(d, ...args)).catch(() => {});
  const publicUser = (u) => ({ id: u.id, username: u.username, name: u.displayName, role: u.role, owner: Boolean(u.owner), disabled: Boolean(u.disabled), createdAt: u.createdAt });
  const findByName = (name) => store.state.users.find((u) => u.username === name);
  const findById = (id) => store.state.users.find((u) => u.id === id);
  const normName = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

  function validateNewUser({ username, displayName, role, password }) {
    const problems = [];
    const u = normName(username);
    if (!USERNAME_RE.test(u)) problems.push({ path: 'username', message: 'must be 3 to 32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit' });
    const dn = typeof displayName === 'string' ? displayName.trim() : '';
    if (!dn || dn.length > 60 || /[\u0000-\u001f\u007f]/.test(dn)) problems.push({ path: 'displayName', message: 'is required (1 to 60 characters, one line)' });
    if (!ROLE_IDS.includes(role)) problems.push({ path: 'role', message: `must be one of: ${ROLE_IDS.join(', ')}` });
    for (const m of passwordProblems(password, { username: u, displayName: dn })) problems.push({ path: 'password', message: m });
    if (problems.length) throw new HttpError(422, 'validation_failed', 'Some fields are invalid.', { fields: problems });
    return { username: u, displayName: dn };
  }

  async function createUser({ username, displayName, role, password, owner = false, createdBy = 'setup' }) {
    const v = validateNewUser({ username, displayName, role, password });
    if (findByName(v.username)) throw new HttpError(409, 'username_taken', 'That username is already in use.');
    const passwordHash = await gate(() => H.hashPassword(password, cost));
    return store.mutate((d) => {
      if (d.users.some((u) => u.username === v.username)) throw new HttpError(409, 'username_taken', 'That username is already in use.');
      const at = new Date(nowMs()).toISOString();
      const user = { id: `U-${++d.seq.user}`, username: v.username, displayName: v.displayName, role, owner: Boolean(owner), disabled: false, passwordHash, credVersion: 1, createdAt: at, createdBy, passwordChangedAt: at };
      d.users.push(user);
      audit(d, 'user_created', createdBy, user.id);
      return publicUser(user);
    });
  }

  function revokeUser(userId, exceptSid) {
    for (const [sid, s] of sessions) if (s.userId === userId && sid !== exceptSid) sessions.delete(sid);
  }

  /** Synchronous: callers rely on there being no await between their last check and this. */
  function startSession(user) {
    const sid = randomBytes(16).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    // The per-user cap evicts the oldest FINISHED sessions only; one still being recorded (pending) is never evicted by a sibling.
    const mine = [...sessions.entries()].filter(([, s]) => s.userId === user.id && !s.pending).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length >= maxSessionsPerUser) sessions.delete(mine.shift()[0]);
    const t = nowMs();
    const csrf = randomBytes(32).toString('base64url');
    sessions.set(sid, { userId: user.id, credVersion: gen(user), secretHash: sha256hex(secret), csrf, createdAt: t, lastSeen: t, pending: true });
    return { cookieValue: `${sid}.${secret}`, sid, csrf };
  }

  const cookieHeader = (value, { clear = false } = {}) =>
    `${COOKIE}=${clear ? '' : value}; HttpOnly; SameSite=Strict; Path=/${secureCookies ? '; Secure' : ''}${clear ? '; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}`;

  async function login(username, password, ip) {
    const name = normName(username);
    const account = safeId(name);
    const wait = lim.retryAfter(account, ip);
    if (wait) {
      await auditQuietly('login_blocked', null, account, ip);
      throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again later.', { retryAfterSeconds: wait });
    }
    const start = typeof password === 'string' && password.length <= 1024 ? findByName(name) : undefined;
    // The credential generation we are about to verify against (a snapshot taken before any await).
    const snap = start && !start.disabled ? { id: start.id, hash: start.passwordHash, v: gen(start) } : null;
    // Unknown or disabled accounts still pay for one scrypt computation, against the shared dummy hash.
    const record = snap ? snap.hash : await getDummy();
    const ok = await gate(() => H.verifyPassword(typeof password === 'string' ? password : '', record));

    // ---- atomic success boundary: from the next line to startSession() there is NO await ----
    const cur = snap ? findById(snap.id) : null;
    const valid = ok && cur && !cur.disabled && cur.passwordHash === snap.hash && gen(cur) === snap.v;
    if (!valid) {
      lim.fail(account, ip);
      await auditQuietly('login_failure', null, account, ip);
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
    }
    lim.succeed(account);
    const s = startSession(cur); // fresh id every time: no fixation; stamped with the generation just checked
    try {
      await store.mutate((d) => audit(d, 'login_success', cur.id, cur.username, ip));
    } catch (e) {
      sessions.delete(s.sid); // fail closed: no audit trail, no session
      throw e;
    }
    // A reset or disable that landed while the audit entry was being written has already revoked this session.
    const live = sessions.get(s.sid);
    if (live) live.pending = false;
    if (!live) throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
    return { user: publicUser(cur), csrf: s.csrf, cookie: cookieHeader(s.cookieValue), idleSeconds: idleMs / 1000, absoluteSeconds: absoluteMs / 1000 };
  }

  /** Resolve a Cookie header to a live session and the CURRENT user record (role changes apply immediately). */
  function authenticate(cookies) {
    const raw = String(cookies ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const value = raw.slice(COOKIE.length + 1);
    const dot = value.indexOf('.');
    if (dot < 1) return null;
    const sid = value.slice(0, dot);
    const s = sessions.get(sid);
    if (!s) return null;
    const given = Buffer.from(sha256hex(value.slice(dot + 1)));
    const have = Buffer.from(s.secretHash);
    if (given.length !== have.length || !timingSafeEqual(given, have)) return null;
    const t = nowMs();
    if (t - s.createdAt > absoluteMs || t - s.lastSeen > idleMs) {
      sessions.delete(sid);
      return null;
    }
    const user = findById(s.userId);
    // A session from an obsolete credential generation is dead, even if its revocation was somehow missed.
    if (!user || user.disabled || gen(user) !== s.credVersion) {
      sessions.delete(sid);
      return null;
    }
    s.lastSeen = t;
    return { user: publicUser(user), session: { sid, csrf: s.csrf, expiresAt: new Date(Math.min(s.createdAt + absoluteMs, t + idleMs)).toISOString() } };
  }

  const csrfOk = (session, token) => {
    if (typeof token !== 'string') return false;
    const a = Buffer.from(token);
    const b = Buffer.from(session.csrf);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  async function logout(sid, user, ip) {
    sessions.delete(sid);
    await store.mutate((d) => audit(d, 'logout', user.id, user.username, ip));
    return cookieHeader('', { clear: true });
  }

  async function changePassword(auth, { current, next }, ip) {
    const user = findById(auth.user.id);
    if (!user || user.disabled) throw new HttpError(401, 'invalid_credentials', 'The current password is not correct.');
    const snap = { hash: user.passwordHash, v: gen(user) }; // the credential the caller proved they know
    const account = safeId(user.username);
    const wait = lim.retryAfter(account, ip);
    if (wait) throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.', { retryAfterSeconds: wait });
    if (typeof current !== 'string' || !(await gate(() => H.verifyPassword(current, snap.hash)))) {
      lim.fail(account, ip);
      await auditQuietly('password_change_failure', user.id, user.username, ip);
      throw new HttpError(401, 'invalid_credentials', 'The current password is not correct.');
    }
    const problems = passwordProblems(next, { username: user.username, displayName: user.displayName });
    if (problems.length) throw new HttpError(422, 'validation_failed', 'Some fields are invalid.', { fields: problems.map((m) => ({ path: 'password', message: m })) });
    const passwordHash = await gate(() => H.hashPassword(next, cost));
    await store.mutate((d) => {
      const u = d.users.find((x) => x.id === user.id);
      // Decided against the CURRENT record inside the serialised mutation: a reset, change or disable that landed
      // while we were hashing wins, and this stale change is refused instead of overwriting it.
      if (!u || u.disabled || u.passwordHash !== snap.hash || gen(u) !== snap.v) {
        throw new HttpError(409, 'credential_changed', 'Your credentials changed while this request was running. Sign in again.');
      }
      u.passwordHash = passwordHash;
      u.credVersion = gen(u) + 1;
      u.passwordChangedAt = new Date(nowMs()).toISOString();
      audit(d, 'password_changed', user.id, user.username, ip);
    });
    revokeUser(user.id); // every session, including this one
    const s = startSession(findById(user.id)); // fresh id, stamped with the new generation
    sessions.get(s.sid).pending = false;
    return { cookie: cookieHeader(s.cookieValue), csrf: s.csrf };
  }

  // ----- administration (owner only; the route layer checks the caller) -----

  async function adminSetDisabled(actorId, id, disabled) {
    await store.mutate((d) => {
      const u = d.users.find((x) => x.id === id);
      if (!u) throw new HttpError(404, 'not_found', 'No such user.');
      if (Boolean(u.disabled) === disabled) return;
      // The last-owner invariant is enforced HERE, against the draft, inside the serialised mutation, so two owners
      // disabling each other (or themselves) at once cannot both pass it.
      if (disabled && u.owner && !d.users.some((x) => x.owner && !x.disabled && x.id !== u.id)) {
        throw new HttpError(409, 'last_owner', 'You cannot disable the only active owner.');
      }
      u.disabled = disabled;
      u.credVersion = gen(u) + 1;
      audit(d, disabled ? 'user_disabled' : 'user_enabled', actorId, id);
    });
    if (disabled) revokeUser(id);
    return publicUser(findById(id));
  }

  async function adminResetPassword(actorId, id, password) {
    const u = findById(id);
    if (!u) throw new HttpError(404, 'not_found', 'No such user.');
    const problems = passwordProblems(password, { username: u.username, displayName: u.displayName });
    if (problems.length) throw new HttpError(422, 'validation_failed', 'Some fields are invalid.', { fields: problems.map((m) => ({ path: 'password', message: m })) });
    const passwordHash = await gate(() => H.hashPassword(password, cost));
    await store.mutate((d) => {
      const x = d.users.find((y) => y.id === id);
      if (!x) throw new HttpError(404, 'not_found', 'No such user.');
      x.passwordHash = passwordHash;
      x.credVersion = gen(x) + 1; // ends every in-flight login, password change and live session of the old credential
      x.passwordChangedAt = new Date(nowMs()).toISOString();
      audit(d, 'password_reset', actorId, id);
    });
    revokeUser(id);
    return publicUser(findById(id));
  }

  return {
    store,
    cookieName: COOKIE,
    idleSeconds: idleMs / 1000,
    userCount: () => store.state.users.length,
    listUsers: () => store.state.users.map(publicUser),
    recentAudit: (n = 100) => store.state.audit.slice(-n).reverse(),
    createUser,
    login,
    authenticate,
    csrfOk,
    logout,
    changePassword,
    adminSetDisabled,
    adminResetPassword,
    sessionCount: () => sessions.size,
    limiter: lim,
    /** Let pending credential writes finish, then release ownership of the credential file. */
    close: () => store.close(),
  };
}
