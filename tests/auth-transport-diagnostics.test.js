// Transport diagnostics of the auth test client (tests/auth-helpers.js, m26).
// The first clean run of m25b failed once with a bare "TypeError: fetch failed" on the first login of an auth test, and the cause was never captured. These tests
// prove that when a request made through the helpers fails at the TRANSPORT level the error now says what happened (cause chain, request, the app's lifecycle),
// never carries the request's body, password, cookie or token, retries nothing, hides nothing, and leaves every ordinary call exactly as it was.
// The failures here are INJECTED into an isolated synthetic app (or are a real refused connection to a server this test closed); nothing is a claim about the cause of
// the original failure, which remains unexplained.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { startAuthApp, describeTransportFailure } from './auth-helpers.js';

// Every test has a bound: one that stops making progress fails BY NAME after 60 s instead of silently stalling the run.
const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);

const SENTINELS = { password: 'PWSENTINEL-9f3a1c', cookie: 'bp_session=COOKIESENTINEL-77b2.TOKENSENTINEL-aa91', csrf: 'CSRFSENTINEL-5d0e42', body: 'BODYSENTINEL-c18f60', user: 'syn-sentinel-user' };

/** The error undici gives for a socket that was reset: fetch failed <- other side closed <- read ECONNRESET. Built by hand: an injected failure, not a captured one. */
function injectedReset() {
  const deepest = Object.assign(new Error(`read ECONNRESET while sending ${SENTINELS.password}`), { code: 'ECONNRESET', errno: -4077, syscall: 'read' });
  const socket = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET', cause: deepest });
  return new TypeError('fetch failed', { cause: socket });
}

test('describeTransportFailure: the cause chain, request and lifecycle are reported; the request\'s secrets are not, even if an error message carries one', () => {
  const original = injectedReset();
  const fakeServer = { listening: true, address: () => ({ port: 4242 }) };
  const e = describeTransportFailure(original, {
    method: 'POST',
    route: `/api/admin/users/0123456789abcdef0123456789abcdef/reset-password?token=${SENTINELS.csrf}`,
    phase: 'login',
    stage: 'ready',
    nth: 1,
    requests: 3,
    inflight: 1,
    ageMs: 187,
    server: fakeServer,
    secrets: [SENTINELS.password, SENTINELS.cookie, SENTINELS.csrf],
  });
  assert.equal(e.cause, original, 'the original error is kept as the cause, not swallowed');
  for (const want of ['fetch failed', 'transport failure: no response', 'code=UND_ERR_SOCKET', 'code=ECONNRESET', 'errno=-4077', 'syscall=read', 'request POST /api/admin/users/<id>/reset-password', 'phase=login', 'stage=ready', 'request#=1', 'appRequests=3', 'inflight=1', 'appAgeMs=187', 'server.listening=true', 'server.port=4242', 'processUptimeS=', 'helperAgeS=']) {
    assert.ok(e.message.includes(want), `missing ${want} in: ${e.message}`);
  }
  assert.ok(!/token=/.test(e.message), 'the query string is not printed');
  for (const secret of Object.values(SENTINELS)) assert.ok(!e.message.includes(secret), `a secret leaked: ${secret}`);
  assert.ok(e.message.includes('[removed]'), 'the secret in the error\'s own message was removed, not just hidden');
});

test('describeTransportFailure: a non-error value, an aggregate error and a missing server are all described without throwing', () => {
  const base = { method: 'GET', route: '/api/meta', phase: 'request', stage: 'ready', nth: 0, requests: 0, inflight: 0, ageMs: 1 };
  assert.match(describeTransportFailure('boom', { ...base, server: null }).message, /boom .*server\.listening=unknown server\.port=null portServedEarlierServers=unknown/);
  const agg = Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED ::1:9'), { code: 'ECONNREFUSED', address: '::1', port: 9 }), new Error('second')], 'all failed'), { name: 'AggregateError' });
  const m = describeTransportFailure(new TypeError('fetch failed', { cause: agg }), { ...base, server: { listening: false, address: () => null } }).message;
  assert.match(m, /errors\[2\] first: Error code=ECONNREFUSED address=::1 port=9/);
  assert.match(m, /server\.listening=false server\.port=null/);
});

test('an injected transport failure through the real helper is reported with its cause, request and lifecycle, with none of the request\'s secrets, and nothing is retried or hidden', async () => {
  const t = await startAuthApp();
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    const c = t.client();
    globalThis.fetch = async () => {
      calls++;
      throw injectedReset();
    };
    let caught;
    try {
      await c.call('POST', '/api/auth/login', { body: { username: SENTINELS.user, password: SENTINELS.password, note: SENTINELS.body }, cookie: SENTINELS.cookie, csrf: SENTINELS.csrf, phase: 'login' });
    } catch (e) {
      caught = e;
    }
    globalThis.fetch = realFetch;
    assert.ok(caught, 'the failure is raised, not swallowed');
    assert.equal(calls, 1, 'no automatic retry');
    assert.equal(caught.cause.code, undefined);
    assert.equal(caught.cause.cause.code, 'UND_ERR_SOCKET', 'the original error chain is intact');
    for (const want of ['fetch failed', 'code=UND_ERR_SOCKET', 'code=ECONNRESET', 'request POST /api/auth/login', 'phase=login', 'step=sending the request', 'stage=ready', 'request#=1', 'appRequests=1', 'inflight=1', 'server.listening=true', 'portServedEarlierServers=0']) {
      assert.ok(caught.message.includes(want), `missing ${want} in: ${caught.message}`);
    }
    // not the body, not the password, not the user name, not the cookie, not the token, not the CSRF value
    for (const secret of [...Object.values(SENTINELS), 'COOKIESENTINEL', 'TOKENSENTINEL']) assert.ok(!caught.message.includes(secret), `a secret leaked: ${secret}`);

    // ordinary behaviour is untouched once the injection is gone: the same client logs in and calls normally
    const ok = await c.login('creator');
    assert.equal(ok.status, 200);
    assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
    const bad = await t.client().login('creator', 'wrong-password-for-diagnostics-test');
    assert.equal(bad.status, 401, 'a refused login is an answer, not a transport failure: it is not rewritten');
  } finally {
    globalThis.fetch = realFetch;
    await t.close();
  }
});

test('a real refused connection (this test closed the server) is reported with ECONNREFUSED and the server\'s state', async () => {
  const t = await startAuthApp();
  try {
    const c = t.client();
    await new Promise((resolve) => t.app.server.close(() => resolve()));
    let caught;
    try {
      await c.call('GET', '/api/meta');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'a failed connection is raised');
    for (const want of ['transport failure: no response', 'code=ECONNREFUSED', 'syscall=connect', 'request GET /api/meta', 'server.listening=false', 'stage=ready']) {
      assert.ok(caught.message.includes(want), `missing ${want} in: ${caught.message}`);
    }
    assert.ok(caught.cause instanceof TypeError, 'the original TypeError is the cause');
  } finally {
    await t.close();
  }
});

test('the lifecycle stage follows the app: ready, restarting, ready again, closed; a client on the restarted app counts its own requests', async () => {
  const t = await startAuthApp();
  assert.equal(t.lifecycle().stage, 'ready');
  assert.equal(t.lifecycle().listening, true);
  const c = await t.as('creator');
  assert.equal(t.lifecycle().requests, 1);
  assert.equal(c.requests, 1);
  const restarting = t.restart();
  assert.match(t.lifecycle().stage, /restarting/);
  await restarting;
  const lc = t.lifecycle();
  assert.equal(lc.stage, 'ready');
  assert.equal(lc.requests, 0, 'the count is per server instance');
  assert.equal(lc.inflight, 0);
  assert.equal((await (await t.as('creator')).call('GET', '/api/auth/me')).status, 200, 'the restarted app answers');
  await t.close();
  assert.equal(t.lifecycle().stage, 'closed');
});
