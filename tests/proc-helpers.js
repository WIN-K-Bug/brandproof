// Helpers for tests that run the real entry point (`node server.js`) as a child process on isolated temp data.
// Every wait is bounded: a server that misbehaves makes a test FAIL with everything it printed, never hang the run, and every child is
// stopped when the test file ends (node reports a timed-out test as failed but does not run its cleanup).
import { after } from 'node:test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function freePort(host = '127.0.0.1') {
  const s = net.createServer();
  await new Promise((r, j) => s.once('error', j).listen(0, host, r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
export const hold = (port, host = '127.0.0.1') => {
  const s = net.createServer();
  return new Promise((r, j) => s.once('error', j).listen(port, host, () => r(s)));
};
export const release = (s) => new Promise((r) => s.close(r));

/** One HTTP request with an optional cookie; resolves with the status, parsed JSON (if any) and the first Set-Cookie. */
export const request = (host, port, { hostHeader, method = 'GET', p = '/api/meta', origin, role, body, cookie, raw } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (hostHeader) headers.host = hostHeader;
  if (origin) headers.origin = origin;
  if (role) headers['x-demo-role'] = role;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (raw !== undefined) headers['content-type'] = 'application/octet-stream';
  const req = http.request({ host, port, method, path: p, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const text = buffer.toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch {}
      resolve({ status: res.statusCode, headers: res.headers, text, buffer, json, setCookie: res.headers['set-cookie']?.[0] ?? null });
    });
  });
  req.setTimeout(15_000, () => req.destroy(new Error(`no answer from ${host}:${port} ${method} ${p} within 15 s`)));
  req.on('error', reject);
  req.end(raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body));
});

/** A browser-like visitor: its own cookie jar, talking to one server. */
export function visitor(port, name, extra = {}) {
  const v = {
    name,
    cookie: null,
    async call(method, p, o = {}) {
      const r = await request('127.0.0.1', port, { method, p, cookie: v.cookie, ...extra, ...o });
      if (r.setCookie) v.cookie = r.setCookie.split(';')[0];
      return r;
    },
    open: () => v.call('GET', '/'),
  };
  return v;
}

const live = new Set();
after(() => { for (const r of live) { try { r.child.kill(); } catch {} } });
process.on('exit', () => { for (const r of live) { try { r.child.kill(); } catch {} } });

/**
 * Runs `node server.js` with a clean environment plus `env` (never inheriting BRANDPROOF_* or PORT from whoever runs the tests).
 * `bannerEnd` is the pattern of the LAST start-up line, so "ready" means the whole banner has arrived, not just its first line.
 */
export function launch(label, env, { logTo, bannerEnd }) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('BRANDPROOF_') || k === 'PORT' || k === 'NODE_OPTIONS') delete clean[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const run = { label, out: '', err: '', code: undefined, signal: undefined, child };
  child.stdout.on('data', (c) => (run.out += c));
  child.stderr.on('data', (c) => (run.err += c));
  live.add(run);
  // 'close', not 'exit': it fires after stdout and stderr have ended, so run.out and run.err are COMPLETE once this resolves.
  run.exited = new Promise((resolve) => child.once('close', (code, signal) => { run.code = code; run.signal = signal; live.delete(run); resolve(code); }));
  run.waitExit = (ms = 15_000) => {
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} was expected to exit within ${ms} ms but is still running (pid ${child.pid}).\nstdout: ${run.out}\nstderr: ${run.err}`)), ms);
    });
    return Promise.race([run.exited, late]).finally(() => clearTimeout(timer));
  };
  run.ready = async (ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const m = /listening on (http:\/\/\S+)/.exec(run.out);
      if (m && (!bannerEnd || bannerEnd.test(run.out))) return new URL(m[1]);
      if (run.code !== undefined) throw new Error(`${label} exited (${run.code}) before listening.\nstdout: ${run.out}\nstderr: ${run.err}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${label} did not finish its start-up banner within ${ms} ms.\nstdout: ${run.out}\nstderr: ${run.err}`);
  };
  run.stop = async () => {
    if (run.code === undefined) child.kill();
    await Promise.race([run.exited, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
    if (run.code === undefined && run.signal === undefined) throw new Error(`${label} (pid ${child.pid}) did not stop within 10 s of being killed.`);
  };
  logTo.push(run);
  return run;
}
