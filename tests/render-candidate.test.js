// The Render free-tier candidate (render.yaml, .node-version, package.json "engines"): the file's own settings are checked, then the REAL
// `node server.js` is started with exactly the environment render.yaml declares (only the public host name, the root folder and the port are
// substituted) and exercised the way the platform and two visitors would: health check, strict host and origin, the Secure cookie, isolation,
// the core review path, and what a restart on temporary storage does. Local, Windows-or-any-OS, plain HTTP on loopback with the https-style
// Host and Origin headers a TLS-terminating proxy produces. This is NOT a test of Render, Linux containers or real TLS.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tempDir, cleanContent } from './helpers.js';
import { freePort, launch, request, root as projectRoot } from './proc-helpers.js';

const test = (name, fn) => baseTest(name, { timeout: 90_000 }, fn);
const HOST = 'brandproof-judge-demo.onrender.com'; // a stand-in: the real name exists only once a service does
const BANNER_END = /One process per judge root;.*fictional\.\r?\n/;

/** The small subset of YAML render.yaml uses: top-level service keys and the envVars list of `- key:` blocks. */
function parseRender(text) {
  const service = {};
  const env = {};
  let inEnv = false;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const line = raw.replace(/\s+#.*$/, '');
    let m;
    if (/^\s{4}envVars:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && (m = /^\s{6}- key: (\S+)\s*$/.exec(line))) { current = (env[m[1]] = {}); continue; }
    if (inEnv && current && (m = /^\s{8}(value|sync): (.*)$/.exec(line))) { current[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); continue; }
    if (!inEnv && (m = /^\s{4}([a-zA-Z]+): (.*)$/.exec(line))) service[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    if (!inEnv && (m = /^\s{2}- type: (\S+)/.exec(line))) service.type = m[1];
  }
  return { service, env };
}

const render = parseRender(readFileSync(path.join(projectRoot, 'render.yaml'), 'utf8'));
/** The environment render.yaml declares, with the three deployment-specific values filled in. */
const renderEnv = (judgeRoot, port, overrides = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(render.env)) if (v.value !== undefined) out[k] = v.value;
  out.BRANDPROOF_ALLOWED_HOSTS = HOST;
  out.BRANDPROOF_JUDGE_ROOT = judgeRoot;
  out.PORT = String(port); // Render sets PORT itself
  delete out.NODE_VERSION; // a platform setting, not read by the app
  return { ...out, ...overrides };
};

test('render.yaml: free plan, pinned tested Node, explicit host, health path, manual deploys, and no secrets, wildcard, real data or paid features', () => {
  assert.equal(render.service.type, 'web');
  assert.equal(render.service.plan, 'free');
  assert.equal(render.service.runtime, 'node');
  assert.equal(render.service.autoDeploy, 'false');
  assert.equal(render.service.healthCheckPath, '/healthz');
  assert.equal(render.service.startCommand, 'npm start');
  assert.doesNotMatch(render.service.buildCommand, /npm (ci|install)|curl|wget|fetch-(model|ocr)/, 'the core profile installs and downloads nothing');
  assert.equal(render.env.NODE_VERSION.value, '22.19.0');
  assert.equal(readFileSync(path.join(projectRoot, '.node-version'), 'utf8').trim(), '22.19.0', '.node-version agrees');
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.19.0 <23', 'package.json engines agrees');
  // the host name must be entered by a person, never defaulted to a wildcard
  assert.equal(render.env.BRANDPROOF_ALLOWED_HOSTS.sync, 'false');
  assert.equal(render.env.BRANDPROOF_ALLOWED_HOSTS.value, undefined);
  for (const forbidden of ['BRANDPROOF_DATA', 'BRANDPROOF_MODE', 'BRANDPROOF_AUTH_FILE', 'PORT', 'BRANDPROOF_HOST']) assert.equal(render.env[forbidden], undefined, `${forbidden} must not be set here`);
  const all = Object.values(render.env).map((v) => v.value ?? '').join(' ');
  assert.doesNotMatch(all, /\*|password|secret|token|key=|@/i);
  assert.equal(render.env.BRANDPROOF_JUDGE_ROOT.value, '/tmp/brandproof-judge-demo');
  assert.equal(render.env.BRANDPROOF_JUDGE_EPHEMERAL.value, '1');
  assert.equal(render.env.BRANDPROOF_JUDGE_SECURE_COOKIE.value, '1');
  assert.equal(render.env.BRANDPROOF_SEMANTIC.value, 'off');
  assert.equal(render.env.BRANDPROOF_DEPLOY.value, '1');
  assert.equal(render.env.BRANDPROOF_JUDGE_DEMO.value, '1');
  assert.ok(Object.keys(render.env).filter((k) => k.startsWith('BRANDPROOF_JUDGE_')).length >= 12);
});

test('the exact render.yaml environment starts the real server, answers the health check without a session, and refuses what it should', async (t) => {
  const tmp = await tempDir();
  const runs = [];
  t.after(async () => {
    for (const r of runs) {
      await r.stop();
      t.diagnostic(`[${r.label}] exit=${r.code} signal=${r.signal ?? ''}\n--- stdout ---\n${r.out.trim() || '(empty)'}\n--- stderr ---\n${r.err.trim() || '(empty)'}`);
    }
    await tmp.cleanup();
  });
  const judgeRoot = path.join(tmp.dir, 'tmp-brandproof-judge-demo');
  const port = await freePort();
  const s = launch('render-profile', renderEnv(judgeRoot, port), { logTo: runs, bannerEnd: BANNER_END });
  const url = await s.ready();
  // deployment start-up: every interface, exactly the assigned port, the listed host name only, temporary storage said plainly
  assert.equal(url.host, `0.0.0.0:${port}`);
  assert.match(s.out, new RegExp(`Deployment start-up: host 0\\.0\\.0\\.0, assigned port ${port} \\(strict, no fallback\\)\\. Answers to Host names: ${HOST.replace(/\./g, '\\.')} \\(and localhost\\)`));
  assert.match(s.out, /Up to 30 sessions \(5 open at once\), 60 min idle or 6 h absolute expiry, 2 MB per session\. Temporary storage: sessions are lost when the service restarts or sleeps\./);

  // health check: any Host, no cookie, no session, and the demo root stays empty of sessions
  for (const host of [`127.0.0.1:${port}`, HOST, '10.0.0.5:10000', 'evil.example']) {
    const h = await request('127.0.0.1', port, { hostHeader: host, p: '/healthz' });
    assert.equal(h.status, 200, host);
    assert.equal(h.text, '{"status":"ok"}');
    assert.equal(h.setCookie, null);
  }
  assert.deepEqual(readdirSync(path.join(judgeRoot, 'sessions')), [], 'health checks allocated no session');

  // strict host and origin
  for (const host of ['evil.example', `${HOST}.evil.example`, 'onrender.com', '203.0.113.9']) {
    const r = await request('127.0.0.1', port, { hostHeader: host, p: '/' });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.error.code, 'bad_host');
    assert.equal(r.setCookie, null);
  }
  assert.deepEqual(readdirSync(path.join(judgeRoot, 'sessions')), [], 'refused hosts started no session');

  // the page: a Secure, HttpOnly, SameSite=Strict, host-only __Host- cookie
  const page = await request('127.0.0.1', port, { hostHeader: HOST, p: '/' });
  assert.equal(page.status, 200);
  assert.match(page.setCookie, /^__Host-bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(page.setCookie, /Domain=/i);
  // optional features: the core profile says why each is unavailable, and the core path does not need them
  const meta = (await request('127.0.0.1', port, { hostHeader: HOST, cookie: page.setCookie.split(';')[0] })).json;
  assert.equal(meta.judge.enabled, true);
  assert.equal(meta.semantic.state, 'unavailable');
  assert.match(meta.semantic.reason, /switched off/);
  assert.ok(['ready', 'unavailable'].includes(meta.ocr.state));
  if (meta.ocr.state === 'unavailable') assert.match(meta.ocr.reason, /not installed|missing/);
  t.diagnostic(`optional OCR in this run: ${meta.ocr.state}${meta.ocr.reason ? ` (${meta.ocr.reason})` : ''}; matching: ${meta.semantic.state} (${meta.semantic.reason})`);
});

test('through a TLS-proxy style Host and Origin: two visitors are isolated, the core path works, cross-site writes are refused, and a restart on temporary storage ends sessions clearly', async (t) => {
  const tmp = await tempDir();
  const runs = [];
  t.after(async () => {
    for (const r of runs) {
      await r.stop();
      t.diagnostic(`[${r.label}] exit=${r.code} signal=${r.signal ?? ''}\n--- stdout ---\n${r.out.trim() || '(empty)'}\n--- stderr ---\n${r.err.trim() || '(empty)'}`);
    }
    await tmp.cleanup();
  });
  const rootA = path.join(tmp.dir, 'root-a');
  const port = await freePort();
  const first = launch('render-profile-first', renderEnv(rootA, port), { logTo: runs, bannerEnd: BANNER_END });
  await first.ready();
  const origin = `https://${HOST}`;
  const person = (name) => {
    const v = { name, cookie: null, call: async (method, pth, o = {}) => { const r = await request('127.0.0.1', port, { hostHeader: HOST, method, p: pth, cookie: v.cookie, origin: method === 'GET' ? undefined : origin, ...o }); if (r.setCookie) v.cookie = r.setCookie.split(';')[0]; return r; } };
    return v;
  };
  const a = person('A');
  const b = person('B');
  await a.call('GET', '/');
  await b.call('GET', '/');
  assert.notEqual(a.cookie, b.cookie);
  const bad = { title: 'A-ONLY on the render profile', text: 'A full charge lasts 30 hours, and the lamp is waterproof.', asset: cleanContent().asset };
  const made = await a.call('POST', '/api/submissions', { role: 'creator', body: bad });
  assert.equal(made.status, 201, made.text);
  const sub = made.json;
  assert.equal(sub.current.findings.filter((f) => f.severity === 'error').length, 2);
  // the gate, then fix, request review and a (simulated) reviewer's decision
  assert.equal((await a.call('POST', `/api/submissions/${sub.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: sub.workflow.binding } })).status, 403);
  const fixed = await a.call('POST', `/api/submissions/${sub.id}/revisions`, { role: 'creator', body: { baseRevision: 1, text: cleanContent().text, asset: cleanContent().asset } });
  assert.equal(fixed.status, 201);
  assert.equal((await a.call('POST', `/api/submissions/${sub.id}/request-review`, { role: 'creator', body: { revision: 2, expected: fixed.json.workflow.binding } })).status, 201);
  const forReview = (await a.call('GET', `/api/submissions/${sub.id}`, { role: 'reviewer' })).json;
  const approved = await a.call('POST', `/api/submissions/${sub.id}/approve`, { role: 'reviewer', body: { revision: 2, expected: forReview.workflow.binding, note: 'ok' } });
  assert.equal(approved.status, 201);
  assert.equal(approved.json.workflow.status, 'approved');
  // B sees none of it
  const bTitles = (await b.call('GET', '/api/submissions')).json.submissions.map((x) => x.title);
  assert.equal(bTitles.length, 3);
  assert.ok(!bTitles.includes('A-ONLY on the render profile'));
  assert.equal((await b.call('GET', `/api/submissions/${sub.id}`, { role: 'reviewer' })).status, 404);
  // cross-site writes are refused even with a valid cookie; the plain-http origin of the listed host is the same site
  assert.equal((await a.call('POST', '/api/submissions', { role: 'creator', body: bad, origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.call('POST', '/api/submissions', { role: 'creator', body: bad, origin: 'http://localhost' })).status, 403);
  assert.equal((await a.call('POST', '/api/judge/reset', { body: {}, origin: 'https://evil.example' })).status, 403);
  const info = (await a.call('GET', '/api/judge/session')).json;
  assert.equal(info.ephemeral, true, 'the page is told the storage is temporary');

  // restart on the SAME folder (what a persistent disk would give): the session survives
  await first.stop();
  const second = launch('render-profile-restart-same-root', renderEnv(rootA, port), { logTo: runs, bannerEnd: BANNER_END });
  await second.ready();
  assert.ok((await a.call('GET', '/api/submissions')).json.submissions.some((x) => x.title === 'A-ONLY on the render profile'));
  await second.stop();

  // restart on a NEW, empty folder (what Render's free tier gives after a sleep, restart or redeploy): every old cookie is unknown
  const rootB = path.join(tmp.dir, 'root-b-after-restart');
  const third = launch('render-profile-restart-lost-root', renderEnv(rootB, port), { logTo: runs, bannerEnd: BANNER_END });
  await third.ready();
  const lost = await a.call('GET', '/api/submissions');
  assert.equal(lost.status, 401);
  assert.equal(lost.json.error.code, 'session_unavailable');
  assert.match(lost.json.error.message, /ended or was not found.*Reload the page to start a new demo session/);
  const again = await request('127.0.0.1', port, { hostHeader: HOST, p: '/', cookie: a.cookie });
  assert.equal(again.status, 200, 'reloading the page recovers: a new session');
  const fresh = { cookie: again.setCookie.split(';')[0] };
  assert.notEqual(fresh.cookie, a.cookie);
  const info2 = (await request('127.0.0.1', port, { hostHeader: HOST, p: '/api/judge/session', cookie: fresh.cookie })).json;
  assert.equal(info2.replacedPrevious, true, 'and it says the earlier session was lost');
  assert.equal(info2.ephemeral, true);
  const titles = (await request('127.0.0.1', port, { hostHeader: HOST, p: '/api/submissions', cookie: fresh.cookie })).json.submissions.map((x) => x.title);
  assert.equal(titles.length, 3, 'with fresh fictional data only');
  assert.ok(existsSync(rootB));
});

test('settings that would silently misbehave on the platform are refused: the Secure cookie without a host name, a real data file, a wildcard outside deployment', async (t) => {
  const tmp = await tempDir();
  const runs = [];
  t.after(async () => {
    for (const r of runs) {
      await r.stop();
      t.diagnostic(`[${r.label}] exit=${r.code}\n--- stderr ---\n${r.err.trim() || '(empty)'}`);
    }
    await tmp.cleanup();
  });
  const base = (port) => renderEnv(path.join(tmp.dir, 'r'), port);
  const cases = [
    ['no host name with the Secure cookie', (() => { const e = base(18181); delete e.BRANDPROOF_ALLOWED_HOSTS; return e; })(), /BRANDPROOF_JUDGE_SECURE_COOKIE=1 is for a public https address, which must be listed in BRANDPROOF_ALLOWED_HOSTS/],
    ['an empty host name', { ...base(18181), BRANDPROOF_ALLOWED_HOSTS: '' }, /must be listed in BRANDPROOF_ALLOWED_HOSTS/],
    ['a malformed host name (with a scheme) is refused', { ...base(18181), BRANDPROOF_ALLOWED_HOSTS: 'https://brandproof-judge-demo.onrender.com' }, /not a plain host name or IPv4 address/],
    ['a real data file alongside the judge demo', { ...base(18181), BRANDPROOF_DATA: path.join(tmp.dir, 'real.json') }, /BRANDPROOF_DATA is not used by the judge demo/],
    ['no assigned port', (() => { const e = base(18181); delete e.PORT; return e; })(), /needs the assigned PORT, and PORT is not set/],
  ];
  for (const [name, env, pattern] of cases) {
    const r = launch(name, env, { logTo: runs });
    assert.equal(await r.waitExit(), 1, name);
    assert.match(r.err, /^Could not start: /, name);
    assert.match(r.err, pattern, name);
    assert.doesNotMatch(r.out, /listening on/, name);
  }
});
