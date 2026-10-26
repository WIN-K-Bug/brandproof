// The real entry point, run as a child process (`node server.js`) on isolated, fictional data in a temp folder: the local default, the
// preserved port retry, a configured host, the opt-in deployment start-up, the assigned-port conflict, refusals that happen before anything
// is opened, and the core product flow (campaign copy -> checks against approved evidence -> explained findings -> a human decision),
// including a restart and a second process on the same workspace. Every child's complete stdout and stderr is attached to the report.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, cleanContent } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DATA = path.join(root, 'data', 'brandproof.json');
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))?.address ?? null;
const T = { timeout: 90_000 };

// ---------- helpers ----------
async function freePort(host = '127.0.0.1') {
  const s = net.createServer();
  await new Promise((r, j) => s.once('error', j).listen(0, host, r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const hold = (port, host = '127.0.0.1') => {
  const s = net.createServer();
  return new Promise((r, j) => s.once('error', j).listen(port, host, () => r(s)));
};
const release = (s) => new Promise((r) => s.close(r));
const canBind = (host) => hold(0, host).then(release, () => false).then((r) => r !== false);
// Every wait in this file is bounded: a server that misbehaves must make a test FAIL with its output, never hang the run.
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.setTimeout(5_000, () => { s.destroy(); resolve('TIMEOUT'); });
  s.once('connect', () => { s.destroy(); resolve('open'); });
  s.once('error', (e) => resolve(e.code));
});
const request = (host, port, { hostHeader, method = 'GET', p = '/api/meta', origin, role, body } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (hostHeader) headers.host = hostHeader;
  if (origin) headers.origin = origin;
  if (role) headers['x-demo-role'] = role;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = http.request({ host, port, method, path: p, headers }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
  });
  req.setTimeout(15_000, () => req.destroy(new Error(`no answer from ${host}:${port} ${method} ${p} within 15 s`)));
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});

// A test that times out is reported as failed, but node does not run its `finally`, and a running child keeps the whole run alive.
// So every child is also tracked here and stopped when this file ends (or the process exits), whatever state the tests are in.
const live = new Set();
after(() => { for (const r of live) r.child.kill(); });
process.on('exit', () => { for (const r of live) { try { r.child.kill(); } catch {} } });

/** Runs `node server.js` with a clean environment plus `env`. Never inherits BRANDPROOF_* or PORT from the person running the tests. */
function launch(label, env, { logTo }) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('BRANDPROOF_') || k === 'PORT' || k === 'NODE_OPTIONS') delete clean[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const run = { label, out: '', err: '', code: undefined, child };
  child.stdout.on('data', (c) => (run.out += c));
  child.stderr.on('data', (c) => (run.err += c));
  live.add(run);
  // 'close', not 'exit': it fires only after the child's stdout and stderr have ended, so run.out and run.err are COMPLETE once this resolves.
  run.exited = new Promise((resolve) => child.once('close', (code, signal) => { run.code = code; run.signal = signal; live.delete(run); resolve(code); }));
  /** Resolves to the exit code; rejects with everything the process printed if it is still running after `ms`. */
  run.waitExit = (ms = 15_000) => {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} was expected to exit within ${ms} ms but is still running (pid ${child.pid}).\nstdout: ${run.out}\nstderr: ${run.err}`)), ms);
    });
    return Promise.race([run.exited, late]).finally(() => clearTimeout(timer));
  };
  // Ready means the whole start-up banner has ARRIVED, not just its first line (the lines are separate writes and can be read apart,
  // which is what made an early version of the first test read "listening on" without the "Workspace file:" line that follows it).
  // The banner ends with the workspace line locally and with the "all data is fictional." line in deployment start-up.
  const bannerEnd = env.BRANDPROOF_DEPLOY === '1' ? /all data is fictional\.\r?\n/ : /Workspace file: .*\r?\n/;
  run.ready = async (ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const m = /listening on (http:\/\/\S+)/.exec(run.out);
      if (m && bannerEnd.test(run.out)) return new URL(m[1]);
      if (run.code !== undefined) throw new Error(`${label} exited (${run.code}) before listening.\nstdout: ${run.out}\nstderr: ${run.err}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${label} did not finish its start-up banner within ${ms} ms.\nstdout: ${run.out}\nstderr: ${run.err}`);
  };
  run.stop = async () => {
    if (run.code === undefined) child.kill();
    // bounded: a child that cannot be stopped is reported, never waited for forever
    await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    if (run.code === undefined && run.signal === undefined) throw new Error(`${label} (pid ${child.pid}) did not stop within 10 s of being killed.`);
  };
  logTo.push(run);
  return run;
}

/** One workspace folder per test; every child is stopped and its output attached to the report whatever happens. */
async function scenario(t, fn) {
  const tmp = await tempDir();
  const runs = [];
  const dataFile = path.join(tmp.dir, 'volume', 'workspace.json');
  const realBefore = existsSync(REAL_DATA) ? statSync(REAL_DATA) : null;
  try {
    await fn({ dataFile, tmp, spawnServer: (label, env) => launch(label, { BRANDPROOF_DATA: dataFile, ...env }, { logTo: runs }), runs });
  } finally {
    for (const r of runs) {
      await r.stop();
      t.diagnostic(`[${r.label}] exit=${r.code} signal=${r.signal ?? ''}\n--- stdout ---\n${r.out.trim() || '(empty)'}\n--- stderr ---\n${r.err.trim() || '(empty)'}`);
    }
    await tmp.cleanup();
  }
  // none of these runs may have touched the real workspace file (checked by its size and modified time only)
  const realAfter = existsSync(REAL_DATA) ? statSync(REAL_DATA) : null;
  assert.deepEqual(realAfter && [realAfter.size, realAfter.mtimeMs], realBefore && [realBefore.size, realBefore.mtimeMs], 'the project\'s own data file must not be touched');
}

const bad = { title: 'Entry-point check', text: 'A full charge lasts 30 hours, and the lamp is waterproof.', asset: cleanContent().asset };
const lockFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => /\.lock(\.takeover)?$/.test(n)) : []);

// ---------- the local default ----------
test('npm start with nothing set: loopback only, the product is served, the pre-existing start-up lines are unchanged', T, async (t) => {
  await scenario(t, async ({ spawnServer, dataFile }) => {
    const port = await freePort();
    const s = spawnServer('local-default', { PORT: String(port) });
    const url = await s.ready();
    assert.equal(url.origin, `http://127.0.0.1:${port}`);
    // the pre-existing start-up output, EXACTLY, and nothing about deployment (the whole banner has arrived when ready() returns)
    assert.equal(s.out.replace(/\r\n/g, '\n'), `BrandProof (demo mode) listening on http://127.0.0.1:${port}\nWorkspace file: ${dataFile}\n`);
    const page = await request('127.0.0.1', port, { p: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    const meta = (await request('127.0.0.1', port)).json;
    assert.equal(meta.demo, true);
    assert.equal(meta.team, 'bhangaledhruv7');
    if (lanIp) assert.equal(await tcp(lanIp, port), 'ECONNREFUSED', `the local default must not listen on ${lanIp}`);
    else t.diagnostic('no non-loopback IPv4 address on this computer: the "not reachable from the network" half was not checked');
  });
});

test('local port retry is preserved: a busy PORT moves on to the next free one and says where', T, async (t) => {
  await scenario(t, async ({ spawnServer }) => {
    const p = await freePort();
    const blocker = await hold(p);
    try {
      const s = spawnServer('local-retry', { PORT: String(p) });
      const url = await s.ready();
      assert.ok(Number(url.port) > p, `${url.href} should be above the busy port ${p}`);
      assert.equal((await request('127.0.0.1', Number(url.port))).status, 200);
      assert.equal(s.err, '', 'a busy port is not an error locally');
    } finally {
      await release(blocker);
    }
  });
});

// ---------- the opt-in deployment start-up ----------
test('a configured host is honoured: bound to 127.0.0.2 it answers there and not on the default 127.0.0.1', T, async (t) => {
  if (!(await canBind('127.0.0.2'))) return t.skip('this computer has no 127.0.0.2 loopback address');
  await scenario(t, async ({ spawnServer }) => {
    const port = await freePort('127.0.0.2');
    const s = spawnServer('configured-host', { BRANDPROOF_DEPLOY: '1', PORT: String(port), BRANDPROOF_HOST: '127.0.0.2', BRANDPROOF_ALLOWED_HOSTS: '127.0.0.2' });
    const url = await s.ready();
    assert.equal(url.host, `127.0.0.2:${port}`);
    assert.match(s.out, new RegExp(`Deployment start-up: host 127\\.0\\.0\\.2, assigned port ${port} \\(strict, no fallback\\)\\. Answers to Host names: 127\\.0\\.0\\.2 \\(and localhost\\)`));
    assert.equal((await request('127.0.0.2', port)).status, 200, 'answers on the configured address (Host 127.0.0.2 is on the list)');
    assert.equal(await tcp('127.0.0.1', port), 'ECONNREFUSED', 'and is not listening on the loopback default');
  });
});

test('deployment start-up with no host set listens on every interface, and answers only to the listed host names', T, async (t) => {
  await scenario(t, async ({ spawnServer }) => {
    const port = await freePort();
    const s = spawnServer('deploy-all-interfaces', { BRANDPROOF_DEPLOY: '1', PORT: String(port), BRANDPROOF_ALLOWED_HOSTS: ['judge.example.test', lanIp].filter(Boolean).join(',') });
    const url = await s.ready();
    assert.equal(url.host, `0.0.0.0:${port}`);
    assert.match(s.out, new RegExp(`Deployment start-up: host 0\\.0\\.0\\.0, assigned port ${port} \\(strict, no fallback\\)`));
    assert.equal((await request('127.0.0.1', port)).status, 200, 'reachable on loopback');
    assert.equal((await request('127.0.0.1', port, { hostHeader: 'judge.example.test' })).status, 200, 'the listed public host name is answered');
    const stranger = await request('127.0.0.1', port, { hostHeader: 'evil.example' });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.json.error.code, 'bad_host');
    if (lanIp) {
      assert.equal(await tcp(lanIp, port), 'open', `every-interface mode must be reachable on ${lanIp}`);
      assert.equal((await request(lanIp, port)).status, 200, 'and answered by its address, which is on the list');
    } else t.diagnostic('no non-loopback IPv4 address on this computer: reachability on a network address was not checked');
  });
});

test('assigned-port conflict: deployment start-up fails with a clear message, exits non-zero, never moves to another port, leaves no lock', T, async (t) => {
  await scenario(t, async ({ spawnServer, dataFile }) => {
    const p = await freePort();
    const blocker = await hold(p);
    try {
      const s = spawnServer('port-conflict', { BRANDPROOF_DEPLOY: '1', PORT: String(p), BRANDPROOF_HOST: '127.0.0.1' });
      assert.equal(await s.waitExit(), 1);
      assert.match(s.err, new RegExp(`Could not start server: port ${p} on 127\\.0\\.0\\.1 cannot be used: it is already in use\\. Deployment start-up uses exactly the assigned PORT and never tries another one`));
      assert.doesNotMatch(s.out, /listening on/);
      assert.deepEqual(lockFiles(path.dirname(dataFile)), [], 'the workspace must be released when the start fails');
    } finally {
      await release(blocker);
    }
  });
});

test('settings that cannot work are refused before anything is opened: nothing listens, nothing is created, the real data file is untouched', T, async (t) => {
  await scenario(t, async ({ spawnServer, dataFile, tmp }) => {
    const cases = [
      ['no assigned PORT', { BRANDPROOF_DEPLOY: '1' }, /needs the assigned PORT, and PORT is not set/],
      ['PORT that is not a port', { BRANDPROOF_DEPLOY: '1', PORT: 'abc' }, /PORT must be a whole number from 1 to 65535/],
      ['a host name instead of an address', { BRANDPROOF_DEPLOY: '1', PORT: '18123', BRANDPROOF_HOST: 'localhost' }, /BRANDPROOF_HOST must be an IP address/],
      ['"*" outside a deployment', { BRANDPROOF_ALLOWED_HOSTS: '*' }, /only accepted with BRANDPROOF_DEPLOY=1/],
      ['authenticated mode deployed', { BRANDPROOF_MODE: 'authenticated', BRANDPROOF_DEPLOY: '1', PORT: '18123', BRANDPROOF_AUTH_FILE: path.join(tmp.dir, 'users.json') }, /authenticated mode is local sign-in over plain HTTP.*not offered/],
    ];
    for (const [name, env, pattern] of cases) {
      const s = spawnServer(name, env);
      assert.equal(await s.waitExit(), 1, name);
      assert.match(s.err, /^Could not start: /, name);
      assert.match(s.err, pattern, name);
      assert.doesNotMatch(s.out, /listening on/, name);
      assert.equal(existsSync(dataFile), false, `${name}: no workspace file may be created`);
    }
    // No BRANDPROOF_DATA at all: it must not fall back to the project's data folder. (launch() directly, so no data file is injected.)
    const runs = [];
    const s = launch('deploy-without-data-file', { BRANDPROOF_DEPLOY: '1', PORT: '18123' }, { logTo: runs });
    assert.equal(await s.waitExit(), 1);
    assert.match(s.err, /needs BRANDPROOF_DATA.*never falls back to the project's own data folder/);
    t.diagnostic(`[deploy-without-data-file] stderr: ${s.err.trim()}`);
  });
});

// ---------- the harness itself: a server that does not exit must fail a test quickly, with its output, and be stoppable ----------
test('harness: waiting for a server that keeps running fails within the bound, reports what it printed, and the child can be stopped', T, async (t) => {
  await scenario(t, async ({ spawnServer }) => {
    const port = await freePort();
    const s = spawnServer('healthy-server-that-never-exits', { PORT: String(port) });
    await s.ready();
    const started = Date.now();
    await assert.rejects(s.waitExit(400), (e) => {
      assert.match(e.message, /healthy-server-that-never-exits was expected to exit within 400 ms but is still running \(pid \d+\)/);
      assert.match(e.message, /stdout: BrandProof \(demo mode\) listening on http:\/\/127\.0\.0\.1:\d+/, 'the failure carries what the process printed');
      return true;
    });
    assert.ok(Date.now() - started < 3_000, 'the bound is honoured (no hang)');
    assert.equal(s.code, undefined, 'it is still running when the wait gives up');
    await s.stop();
    assert.notEqual(s.code, undefined, 'stop() ends the child (it reports an exit, by signal on Windows)');
    assert.equal(live.has(s), false, 'a stopped child is no longer tracked');
  });
});

// ---------- the core product flow on the deployment entry point ----------
test('core flow on the deployment entry point, through a TLS-proxy style Host/Origin: check, explain, gate, decide, restart, second process refused', T, async (t) => {
  await scenario(t, async ({ spawnServer, dataFile }) => {
    const host = 'judge.example.test';
    const origin = `https://${host}`;
    const env = (port) => ({ BRANDPROOF_DEPLOY: '1', PORT: String(port), BRANDPROOF_HOST: '127.0.0.1', BRANDPROOF_ALLOWED_HOSTS: host });
    const port = await freePort();
    const a = spawnServer('flow-first-process', env(port));
    await a.ready();
    const call = (method, p, { role, body, o = origin } = {}) => request('127.0.0.1', port, { hostHeader: host, method, p, role, body, origin: body === undefined && method === 'GET' ? undefined : o });

    // the page and its security headers
    const page = await call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.text, /<title>BrandProof<\/title>/);

    // simulation is stated, the engine says what it is, and optional features say whether they are available (never a silent gap)
    const meta = (await call('GET', '/api/meta')).json;
    assert.equal(meta.demo, true, 'demo roles are reported as a simulation');
    assert.deepEqual(meta.roles.map((r) => r.id), ['creator', 'manager', 'reviewer']);
    assert.equal(meta.engine.mode, 'rules');
    assert.equal(meta.engine.contextualAi.available, false);
    for (const feature of ['ocr', 'semantic']) {
      assert.ok(['ready', 'running', 'idle', 'loading', 'unavailable', 'error'].includes(meta[feature].state), `${feature}: ${meta[feature].state}`);
      // "ready", "running", "idle" and "loading" are normal; "unavailable" (not installed, data missing, switched off) and "error" must explain themselves
      if (['unavailable', 'error'].includes(meta[feature].state)) assert.ok(meta[feature].reason && meta[feature].reason.length > 5, `${feature} is ${meta[feature].state}, so it must say why`);
      t.diagnostic(`optional feature ${feature}: ${meta[feature].state}${meta[feature].reason ? ` (${meta[feature].reason})` : ''}`);
    }

    // 1. campaign input, checked against the approved facts, with explained findings
    const created = await call('POST', '/api/submissions', { role: 'creator', body: bad });
    assert.equal(created.status, 201, created.text);
    const sub = created.json;
    assert.equal(sub.workflow.status, 'draft');
    const blocking = sub.current.findings.filter((f) => f.severity === 'error');
    assert.equal(blocking.length, 2);
    assert.deepEqual(blocking.map((f) => f.evidence.map((e) => e.id)).flat().sort(), ['FCT-001', 'FCT-002'], 'each blocking finding names the approved fact it contradicts');
    for (const f of blocking) {
      assert.equal(f.status, 'contradicted');
      assert.ok(f.explanation && f.quote && f.source?.quote, 'a finding explains itself: the claim, the reason and the source passage');
    }

    // 2. the approval gate holds on this entry point
    const early = await call('POST', `/api/submissions/${sub.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: sub.workflow.binding } });
    assert.equal(early.status, 403);
    assert.equal(early.json.error.code, 'not_allowed');
    assert.match(JSON.stringify(early.json), /2 blocking findings must be fixed first/);

    // 3. a corrected revision, a review request, and a human decision by the reviewer role
    const revised = await call('POST', `/api/submissions/${sub.id}/revisions`, { role: 'creator', body: { baseRevision: 1, text: cleanContent().text, asset: cleanContent().asset } });
    assert.equal(revised.status, 201, revised.text);
    assert.equal(revised.json.current.summary.error, 0);
    const requested = await call('POST', `/api/submissions/${sub.id}/request-review`, { role: 'creator', body: { revision: 2, expected: revised.json.workflow.binding } });
    assert.equal(requested.status, 201);
    assert.equal(requested.json.workflow.status, 'in_review');
    const forReview = (await call('GET', `/api/submissions/${sub.id}`, { role: 'reviewer' })).json;
    const decided = await call('POST', `/api/submissions/${sub.id}/approve`, { role: 'reviewer', body: { revision: 2, expected: forReview.workflow.binding, note: 'Checked against the fact sheet.' } });
    assert.equal(decided.status, 201, decided.text);
    assert.equal(decided.json.workflow.status, 'approved');
    assert.equal(decided.json.events.at(-1).actor.name, 'Demo Reviewer');
    const binding = decided.json.workflow.binding;

    // a cross-site write is refused even on a listed host
    const cross = await call('POST', '/api/submissions', { role: 'creator', body: bad, o: 'https://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error.code, 'bad_origin');

    // 4. the workspace file is saved, and a second process on the same workspace is refused (single process per workspace)
    assert.ok(existsSync(dataFile), 'the workspace file is on the volume path that was configured');
    const port2 = await freePort();
    const b = spawnServer('flow-second-process-same-workspace', env(port2));
    assert.equal(await b.waitExit(), 1);
    assert.match(b.err, /^Could not start: Another BrandProof process \(pid \d+.*\) has this workspace file open/);
    assert.doesNotMatch(b.out, /listening on/);
    assert.equal((await call('GET', `/api/submissions/${sub.id}`)).json.workflow.status, 'approved', 'the first process is unharmed');

    // 5. restart: the process is stopped hard (no graceful shutdown), a new one takes over the same workspace and sees the same approval
    await a.stop();
    const port3 = await freePort();
    const c = spawnServer('flow-restarted-process', env(port3));
    await c.ready();
    const after = await request('127.0.0.1', port3, { hostHeader: host, p: `/api/submissions/${sub.id}`, role: 'reviewer' });
    assert.equal(after.status, 200, after.text);
    assert.equal(after.json.workflow.status, 'approved', 'the approval survived the restart');
    assert.deepEqual(after.json.workflow.binding, binding, 'bound to exactly the same content, image and guideline version');
    assert.equal(after.json.revisions.length, 2);
    const listed = (await request('127.0.0.1', port3, { hostHeader: host, p: '/api/submissions' })).json.submissions;
    assert.equal(listed.find((s) => s.id === sub.id).status, 'approved');
  });
});
