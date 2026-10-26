// Start-up settings for the isolated judge demo: opt-in, a required dedicated root, strictly validated limits, refused combinations,
// and the start-up sequence (what it passes to the demo, what it logs, and that a failed listen releases the demo).
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveStartup, startServer, StartupError } from '../src/startup.js';
import { JUDGE_LIMITS } from '../src/judge.js';

const test = (name, fn) => baseTest(name, { timeout: 30_000 }, fn);
const root = path.resolve('/brandproof-root');
const resolve = (env) => resolveStartup(env, { root });
const ROOT = path.resolve('/srv/judge-demo');
const JUDGE = { BRANDPROOF_JUDGE_DEMO: '1', BRANDPROOF_JUDGE_ROOT: ROOT };
const refused = (env, pattern) => assert.throws(() => resolve(env), (e) => e instanceof StartupError && /^Could not start: /.test(e.message) && pattern.test(e.message), JSON.stringify(env));

test('judge demo is off unless switched on; the local default is unchanged', () => {
  assert.equal(resolve({}).judge, null);
  assert.equal(resolve({ BRANDPROOF_JUDGE_DEMO: '0' }).judge, null);
  assert.equal(resolve({ BRANDPROOF_JUDGE_DEMO: 'false' }).judge, null);
  refused({ BRANDPROOF_JUDGE_DEMO: 'yes' }, /BRANDPROOF_JUDGE_DEMO must be 1 or 0/);
});

test('switched on: a dedicated root is required, there is no single data file, and loopback with port retry stays the local default', () => {
  const c = resolve({ ...JUDGE, PORT: '5055' });
  assert.deepEqual(c.judge, { root: ROOT, limits: {}, secureCookie: false, ephemeral: false });
  assert.equal(c.dataFile, null);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.strictPort, false);
  assert.equal(c.preferredPort, 5055);
  assert.equal(c.mode, 'demo');
  assert.equal(resolve({ ...JUDGE, BRANDPROOF_JUDGE_ROOT: 'relative/judge' }).judge.root, path.resolve('relative/judge'));
  refused({ BRANDPROOF_JUDGE_DEMO: '1' }, /needs BRANDPROOF_JUDGE_ROOT, a dedicated folder.*will not use any folder that already holds anything else/);
});

test('with the deployment start-up it needs no data file, keeps the strict port and host rules, and accepts the Secure cookie option', () => {
  const c = resolve({ ...JUDGE, BRANDPROOF_DEPLOY: '1', PORT: '8080', BRANDPROOF_ALLOWED_HOSTS: 'judge.example.com', BRANDPROOF_JUDGE_SECURE_COOKIE: '1' });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.strictPort, true);
  assert.equal(c.preferredPort, 8080);
  assert.deepEqual(c.allowedHosts, ['judge.example.com']);
  assert.equal(c.judge.secureCookie, true);
  assert.equal(c.dataFile, null);
  refused({ ...JUDGE, BRANDPROOF_DEPLOY: '1' }, /needs the assigned PORT/);
});

test('every limit is its own setting, validated against its range; unusable values name the setting', () => {
  const env = {
    ...JUDGE,
    BRANDPROOF_JUDGE_MAX_SESSIONS: '40', BRANDPROOF_JUDGE_MAX_LIVE: '5', BRANDPROOF_JUDGE_IDLE_MINUTES: '30', BRANDPROOF_JUDGE_MAX_HOURS: '6',
    BRANDPROOF_JUDGE_NEW_PER_MINUTE: '10', BRANDPROOF_JUDGE_SESSION_KIB: '2048', BRANDPROOF_JUDGE_IMAGE_KIB: '1024', BRANDPROOF_JUDGE_IMAGE_COUNT: '2', BRANDPROOF_JUDGE_MAX_CONNECTIONS: '50',
  };
  assert.deepEqual(resolve(env).judge.limits, { maxSessions: 40, maxLive: 5, idleMinutes: 30, maxHours: 6, newPerMinute: 10, sessionKiB: 2048, imageKiB: 1024, imageCount: 2, maxConnections: 50 });
  const names = { maxSessions: 'BRANDPROOF_JUDGE_MAX_SESSIONS', maxLive: 'BRANDPROOF_JUDGE_MAX_LIVE', idleMinutes: 'BRANDPROOF_JUDGE_IDLE_MINUTES', maxHours: 'BRANDPROOF_JUDGE_MAX_HOURS', newPerMinute: 'BRANDPROOF_JUDGE_NEW_PER_MINUTE', sessionKiB: 'BRANDPROOF_JUDGE_SESSION_KIB', imageKiB: 'BRANDPROOF_JUDGE_IMAGE_KIB', imageCount: 'BRANDPROOF_JUDGE_IMAGE_COUNT', maxConnections: 'BRANDPROOF_JUDGE_MAX_CONNECTIONS' };
  assert.deepEqual(Object.keys(names).sort(), Object.keys(JUDGE_LIMITS).sort(), 'every limit has a setting');
  for (const [key, name] of Object.entries(names)) {
    const spec = JUDGE_LIMITS[key];
    for (const bad of ['abc', '-1', '1.5', ' 5', String(spec.max + 1), ...(spec.min > 0 ? [String(spec.min - 1)] : [])]) {
      refused({ ...JUDGE, [name]: bad }, new RegExp(`${name} must be a whole number from ${spec.min} to ${spec.max}`));
    }
    assert.equal(resolve({ ...JUDGE, [name]: String(spec.min) }).judge.limits[key], spec.min, `${name} accepts its minimum`);
    assert.equal(resolve({ ...JUDGE, [name]: String(spec.max) }).judge.limits[key], spec.max, `${name} accepts its maximum`);
  }
});

test('unsafe or confusing combinations are refused: real data file, authenticated mode, settings without the switch', () => {
  refused({ ...JUDGE, BRANDPROOF_DATA: '/real/brandproof.json' }, /BRANDPROOF_DATA is not used by the judge demo.*so no real workspace file is in play/);
  refused({ ...JUDGE, BRANDPROOF_MODE: 'authenticated' }, /cannot be combined with authenticated mode/);
  refused({ BRANDPROOF_JUDGE_ROOT: ROOT }, /BRANDPROOF_JUDGE_ROOT is set but the judge demo is not switched on/);
  refused({ BRANDPROOF_JUDGE_MAX_SESSIONS: '10' }, /BRANDPROOF_JUDGE_MAX_SESSIONS is set but the judge demo is not switched on/);
  refused({ BRANDPROOF_JUDGE_SECURE_COOKIE: '1' }, /is set but the judge demo is not switched on/);
});

test('start-up passes the settings to the demo, logs a clear banner, and releases the demo if listening fails', async () => {
  const lines = [];
  const seen = [];
  let closed = 0;
  const fake = async (opts) => {
    seen.push(opts);
    return { limits: { maxSessions: 7, maxLive: 3, idleMinutes: 45, maxHours: 4, sessionKiB: 2048 }, listen: async (p, host) => `http://${host}:${p}`, close: async () => { closed++; } };
  };
  const out = await startServer({ env: { ...JUDGE, PORT: '5099', BRANDPROOF_JUDGE_MAX_SESSIONS: '7', BRANDPROOF_ALLOWED_HOSTS: 'judge.example.com' }, root, createApp: () => assert.fail('the single-workspace app must not be created'), createJudgeDemo: fake, log: (l) => lines.push(l) });
  assert.deepEqual(seen, [{ root: ROOT, allowedHosts: ['judge.example.com'], limits: { maxSessions: 7 }, secureCookie: false, ephemeral: false }]);
  assert.equal(out.url, 'http://127.0.0.1:5099');
  assert.equal(lines[0], 'BrandProof judge demo (isolated fictional sessions) listening on http://127.0.0.1:5099');
  assert.equal(lines[1], `Judge root: ${ROOT}`);
  assert.match(lines[2], /Each visitor gets a private fictional workspace chosen by a server-issued cookie, with no sign-in \(roles are a simulation\)\. Up to 7 sessions \(3 open at once\), 45 min idle or 4 h absolute expiry, 2 MB per session\./);
  assert.equal(lines.length, 3);
  assert.equal(closed, 0);
  // a start that cannot listen (strict deployment port taken) closes the demo before failing
  const failing = async () => ({ limits: {}, listen: async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }); }, close: async () => { closed++; } });
  await assert.rejects(startServer({ env: { ...JUDGE, BRANDPROOF_DEPLOY: '1', PORT: '5099', BRANDPROOF_HOST: '127.0.0.1' }, root, createApp: () => {}, createJudgeDemo: failing }), (e) => e instanceof StartupError && /^Could not start server: port 5099 on 127\.0\.0\.1 cannot be used: it is already in use/.test(e.message));
  assert.equal(closed, 1, 'the demo (and so its root) is released');
  // a demo that cannot be created is reported as "Could not start:" with its reason
  await assert.rejects(startServer({ env: JUDGE, root, createApp: () => {}, createJudgeDemo: async () => { throw new Error('root is not empty'); } }), (e) => e instanceof StartupError && e.message === 'Could not start: root is not empty');
});

test('temporary storage is declared, not guessed: BRANDPROOF_JUDGE_EPHEMERAL is a switch that reaches the demo and its start-up line', async () => {
  assert.equal(resolve(JUDGE).judge.ephemeral, false);
  assert.equal(resolve({ ...JUDGE, BRANDPROOF_JUDGE_EPHEMERAL: '1' }).judge.ephemeral, true);
  assert.equal(resolve({ ...JUDGE, BRANDPROOF_JUDGE_EPHEMERAL: '0' }).judge.ephemeral, false);
  refused({ ...JUDGE, BRANDPROOF_JUDGE_EPHEMERAL: 'maybe' }, /BRANDPROOF_JUDGE_EPHEMERAL must be 1 or 0/);
  refused({ BRANDPROOF_JUDGE_EPHEMERAL: '1' }, /BRANDPROOF_JUDGE_EPHEMERAL is set but the judge demo is not switched on/);
  const seen = [];
  const lines = [];
  const fake = async (o) => { seen.push(o); return { limits: { maxSessions: 7, maxLive: 3, idleMinutes: 45, maxHours: 4, sessionKiB: 2048 }, listen: async (p, host) => `http://${host}:${p}`, close: async () => {} }; };
  await startServer({ env: { ...JUDGE, BRANDPROOF_JUDGE_EPHEMERAL: '1', PORT: '5099' }, root, createApp: () => {}, createJudgeDemo: fake, log: (l) => lines.push(l) });
  assert.equal(seen[0].ephemeral, true);
  assert.match(lines[2], /Temporary storage: sessions are lost when the service restarts or sleeps.$/);
});

test('a Secure cookie needs a listed public host name: without one the start fails instead of looking healthy and refusing every visitor', () => {
  refused({ ...JUDGE, BRANDPROOF_JUDGE_SECURE_COOKIE: '1' }, /BRANDPROOF_JUDGE_SECURE_COOKIE=1 is for a public https address, which must be listed in BRANDPROOF_ALLOWED_HOSTS/);
  refused({ ...JUDGE, BRANDPROOF_JUDGE_SECURE_COOKIE: '1', BRANDPROOF_ALLOWED_HOSTS: '  ' }, /must be listed in BRANDPROOF_ALLOWED_HOSTS/);
  assert.equal(resolve({ ...JUDGE, BRANDPROOF_JUDGE_SECURE_COOKIE: '1', BRANDPROOF_ALLOWED_HOSTS: 'judge.example.com' }).judge.secureCookie, true);
  assert.equal(resolve({ ...JUDGE, BRANDPROOF_JUDGE_SECURE_COOKIE: '0' }).judge.secureCookie, false, 'switched off needs no host name');
});
