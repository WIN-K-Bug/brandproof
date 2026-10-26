// The real entry point as the isolated judge demo (`BRANDPROOF_JUDGE_DEMO=1 node server.js`), run as a child process on a temp folder that is the
// demo's own root: isolation over real HTTP, a restart after a hard stop, refusals before anything is opened, and the deployment style with an
// https-style host and the Secure cookie. Every child's complete stdout and stderr is attached to the test report; every wait is bounded.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir, cleanContent } from './helpers.js';
import { freePort, hold, release, launch, request, visitor, root as projectRoot } from './proc-helpers.js';

const test = (name, fn) => baseTest(name, { timeout: 90_000 }, fn);
const REAL_DATA = path.join(projectRoot, 'data', 'brandproof.json');
const LOCAL_END = /Each visitor gets a private fictional workspace.*\r?\n/;
const DEPLOY_END = /One process per judge root;.*fictional\.\r?\n/;
const bad = (title) => ({ title, text: 'A full charge lasts 30 hours, and the lamp is waterproof.', asset: cleanContent().asset });

/** One temp folder per test, a child-process launcher bound to it, and the report attachment of every child's output. */
async function scenario(t, fn) {
  const tmp = await tempDir();
  const runs = [];
  const judgeRoot = path.join(tmp.dir, 'judge-root');
  const realBefore = existsSync(REAL_DATA) ? statSync(REAL_DATA) : null;
  try {
    await fn({
      tmp,
      judgeRoot,
      server: (label, env, { bannerEnd = LOCAL_END } = {}) => launch(label, { BRANDPROOF_JUDGE_DEMO: '1', BRANDPROOF_JUDGE_ROOT: judgeRoot, ...env }, { logTo: runs, bannerEnd }),
      raw: (label, env) => launch(label, env, { logTo: runs }),
    });
  } finally {
    for (const r of runs) {
      await r.stop();
      t.diagnostic(`[${r.label}] exit=${r.code} signal=${r.signal ?? ''}\n--- stdout ---\n${r.out.trim() || '(empty)'}\n--- stderr ---\n${r.err.trim() || '(empty)'}`);
    }
    await tmp.cleanup();
  }
  const realAfter = existsSync(REAL_DATA) ? statSync(REAL_DATA) : null;
  assert.deepEqual(realAfter && [realAfter.size, realAfter.mtimeMs], realBefore && [realBefore.size, realBefore.mtimeMs], 'the project\'s own data file must not be touched');
}

test('the judge demo on the real entry point: exact start-up lines, two cookie jars cannot see each other, the real data file is never involved', async (t) => {
  await scenario(t, async ({ server, judgeRoot }) => {
    const port = await freePort();
    const s = server('judge-local', { PORT: String(port) });
    const url = await s.ready();
    assert.equal(url.origin, `http://127.0.0.1:${port}`);
    const lines = s.out.replace(/\r\n/g, '\n').split('\n');
    assert.equal(lines[0], `BrandProof judge demo (isolated fictional sessions) listening on http://127.0.0.1:${port}`);
    assert.equal(lines[1], `Judge root: ${judgeRoot}`);
    assert.match(lines[2], /^Each visitor gets a private fictional workspace chosen by a server-issued cookie, with no sign-in \(roles are a simulation\)\. Up to 100 sessions \(12 open at once\), 120 min idle or 12 h absolute expiry, 5 MB per session\.$/);
    assert.equal(lines.length, 4, 'three lines and the trailing newline');
    assert.doesNotMatch(s.out, /Workspace file:/, 'there is no single workspace file in this mode');

    const a = visitor(port, 'A');
    const b = visitor(port, 'B');
    const pageA = await a.open();
    assert.equal(pageA.status, 200);
    assert.match(pageA.setCookie, /^bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=(7200|7199)$/, 'a real clock: the lifetime is 120 minutes less however long the request took');
    await b.open();
    assert.notEqual(a.cookie, b.cookie);
    const meta = (await a.call('GET', '/api/meta')).json;
    assert.equal(meta.judge.enabled, true);
    assert.equal(meta.demo, true);
    assert.equal((await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY over real HTTP') })).status, 201);
    const titles = async (v) => (await v.call('GET', '/api/submissions')).json.submissions.map((x) => x.title);
    assert.ok((await titles(a)).includes('A-ONLY over real HTTP'));
    assert.ok(!(await titles(b)).includes('A-ONLY over real HTTP'));
    assert.equal((await request('127.0.0.1', port, { p: '/api/submissions' })).status, 401, 'no cookie, no workspace');
    // everything it wrote is inside its own root
    assert.ok(existsSync(path.join(judgeRoot, '.brandproof-judge-root')));
    assert.equal(readdirSync(path.join(judgeRoot, 'sessions')).length, 2);
  });
});

test('a restart after a hard stop: the same cookies reach the same workspaces (the stale runtime lock of the killed process is recovered)', async (t) => {
  await scenario(t, async ({ server, judgeRoot }) => {
    const p1 = await freePort();
    const first = server('judge-first-process', { PORT: String(p1) });
    await first.ready();
    const a = visitor(p1, 'A');
    const b = visitor(p1, 'B');
    await a.open();
    await b.open();
    const made = await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY survives a hard stop') });
    assert.equal(made.status, 201);
    await b.call('POST', '/api/submissions', { role: 'creator', body: { title: 'B-ONLY survives too', ...cleanContent() } });
    const createdA = (await a.call('GET', '/api/judge/session')).json.createdAt;
    await first.stop(); // a hard stop: no graceful shutdown, so lock markers are left behind
    const left = readdirSync(path.join(judgeRoot, 'sessions')).flatMap((d) => readdirSync(path.join(judgeRoot, 'sessions', d)));
    assert.ok(left.some((n) => /\.lock$/i.test(n)) || existsSync(path.join(judgeRoot, 'root-owner.lock')), 'the killed process left runtime lock markers (that is the situation under test)');

    const p2 = await freePort();
    const second = server('judge-restarted-process', { PORT: String(p2) });
    await second.ready();
    const a2 = visitor(p2, 'A-after');
    const b2 = visitor(p2, 'B-after');
    a2.cookie = a.cookie; // the browsers keep their cookies
    b2.cookie = b.cookie;
    const titles = async (v) => (await v.call('GET', '/api/submissions')).json.submissions.map((x) => x.title);
    assert.ok((await titles(a2)).includes('A-ONLY survives a hard stop'));
    assert.ok(!(await titles(a2)).includes('B-ONLY survives too'));
    assert.ok((await titles(b2)).includes('B-ONLY survives too'));
    assert.equal((await a2.call('GET', '/api/judge/session')).json.createdAt, createdA, 'it is the same session, not a new one');
  });
});

test('settings that cannot work are refused before anything is opened; a non-empty folder is never used; a second process on the same root is refused', async (t) => {
  await scenario(t, async ({ server, raw, judgeRoot, tmp }) => {
    const precious = path.join(tmp.dir, 'precious');
    mkdirSync(precious);
    writeFileSync(path.join(precious, 'workspace.json'), '{"real":"data"}');
    const cases = [
      ['no root', { BRANDPROOF_JUDGE_DEMO: '1', PORT: '18150' }, /needs BRANDPROOF_JUDGE_ROOT/],
      ['a data file as well', { BRANDPROOF_JUDGE_DEMO: '1', BRANDPROOF_JUDGE_ROOT: judgeRoot, BRANDPROOF_DATA: path.join(tmp.dir, 'real.json'), PORT: '18150' }, /BRANDPROOF_DATA is not used by the judge demo/],
      ['authenticated mode', { BRANDPROOF_JUDGE_DEMO: '1', BRANDPROOF_JUDGE_ROOT: judgeRoot, BRANDPROOF_MODE: 'authenticated', PORT: '18150' }, /cannot be combined with authenticated mode/],
      ['a root setting without the switch', { BRANDPROOF_JUDGE_ROOT: judgeRoot, PORT: '18150' }, /is set but the judge demo is not switched on/],
      ['an unusable limit', { BRANDPROOF_JUDGE_DEMO: '1', BRANDPROOF_JUDGE_ROOT: judgeRoot, BRANDPROOF_JUDGE_MAX_SESSIONS: '0', PORT: '18150' }, /BRANDPROOF_JUDGE_MAX_SESSIONS must be a whole number from 1 to 5000/],
      ['a folder that holds something else', { BRANDPROOF_JUDGE_DEMO: '1', BRANDPROOF_JUDGE_ROOT: precious, PORT: '18150' }, /not empty and was not created by the judge demo/],
    ];
    for (const [name, env, pattern] of cases) {
      const s = raw(name, env);
      assert.equal(await s.waitExit(), 1, name);
      assert.match(s.err, /^Could not start: /, name);
      assert.match(s.err, pattern, name);
      assert.doesNotMatch(s.out, /listening on/, name);
    }
    assert.deepEqual(readdirSync(precious), ['workspace.json'], 'the non-empty folder got nothing added');
    assert.equal(readFileSync(path.join(precious, 'workspace.json'), 'utf8'), '{"real":"data"}');
    assert.equal(existsSync(judgeRoot), false, 'no root was created by any refused start');
    // a second process on a root that is in use
    const port = await freePort();
    const first = server('judge-owner', { PORT: String(port) });
    await first.ready();
    const second = server('judge-second-on-same-root', { PORT: String(await freePort()) });
    assert.equal(await second.waitExit(), 1);
    assert.match(second.err, /^Could not start: This judge-demo root is already in use by another BrandProof process \(one process per root\)\./);
    assert.doesNotMatch(second.out, /listening on/);
    assert.equal((await visitor(port, 'ok').open()).status, 200, 'the first process is unharmed');
  });
});

test('deployment style: https-style host name, Secure __Host- cookie, strict port; a taken port fails clearly and releases the root', async (t) => {
  await scenario(t, async ({ server, judgeRoot }) => {
    const port = await freePort();
    const hostName = 'judge.example.test';
    const env = { BRANDPROOF_DEPLOY: '1', PORT: String(port), BRANDPROOF_HOST: '127.0.0.1', BRANDPROOF_ALLOWED_HOSTS: hostName, BRANDPROOF_JUDGE_SECURE_COOKIE: '1' };
    const s = server('judge-deploy', env, { bannerEnd: DEPLOY_END });
    await s.ready();
    assert.match(s.out, new RegExp(`Deployment start-up: host 127\\.0\\.0\\.1, assigned port ${port} \\(strict, no fallback\\)\\. Answers to Host names: ${hostName} \\(and localhost\\)`));
    const page = await request('127.0.0.1', port, { hostHeader: hostName, p: '/' });
    assert.equal(page.status, 200);
    assert.match(page.setCookie, /^__Host-bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    const cookie = page.setCookie.split(';')[0];
    const write = (origin) => request('127.0.0.1', port, { hostHeader: hostName, method: 'POST', p: '/api/submissions', origin, cookie, role: 'creator', body: { title: 'through the proxy', ...cleanContent() } });
    assert.equal((await write('https://judge.example.test')).status, 201);
    assert.equal((await write('https://evil.example')).status, 403);
    const stranger = await request('127.0.0.1', port, { hostHeader: 'evil.example', p: '/' });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.setCookie, null);
    // the same root and port from a second process: the root is refused first (one process per root)
    const again = server('judge-deploy-second', env, { bannerEnd: DEPLOY_END });
    assert.equal(await again.waitExit(), 1);
    assert.match(again.err, /already in use by another BrandProof process/);
    await s.stop();
  });
  // a strict port that is taken
  await scenario(t, async ({ server, judgeRoot }) => {
    const port = await freePort();
    const blocker = await hold(port);
    try {
      const s = server('judge-deploy-port-conflict', { BRANDPROOF_DEPLOY: '1', PORT: String(port), BRANDPROOF_HOST: '127.0.0.1' }, { bannerEnd: DEPLOY_END });
      assert.equal(await s.waitExit(), 1);
      assert.match(s.err, new RegExp(`^Could not start server: port ${port} on 127\\.0\\.0\\.1 cannot be used: it is already in use\\. Deployment start-up uses exactly the assigned PORT`));
      assert.doesNotMatch(s.out, /listening on/);
      assert.equal(existsSync(path.join(judgeRoot, 'root-owner.lock')), false, 'the root is released when the start fails');
    } finally {
      await release(blocker);
    }
  });
});
