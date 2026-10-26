// The liveness route for a hosting platform's health check (/healthz): it must allocate no session, use no admission slot or rate, need no
// cookie, answer whatever Host the checker sends, and reveal nothing (no path, token or state).
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { createJudgeDemo } from '../src/judge.js';
import { tempDir } from './helpers.js';

const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);

async function start(t, opts = {}) {
  const tmp = await tempDir();
  const root = path.join(tmp.dir, 'demo-root');
  const demo = await createJudgeDemo({ root, semantic: null, ocr: null, ...opts });
  const base = await demo.listen(0);
  const port = Number(new URL(base).port);
  t.after(async () => {
    await demo.close().catch(() => {});
    await tmp.cleanup();
  });
  // a raw request that can claim any Host (a platform's checker may send its own)
  const raw = (p, { method = 'GET', host = `127.0.0.1:${port}`, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error('no answer')));
    req.on('error', reject);
    req.end();
  });
  return { demo, root, raw, folders: () => readdirSync(path.join(root, 'sessions')) };
}

test('/healthz answers 200 with a constant body, no cookie, no caching, and the security headers', async (t) => {
  const d = await start(t);
  const r = await d.raw('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"status":"ok"}');
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['set-cookie'], undefined, 'a health check is never given a session cookie');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  const head = await d.raw('/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal((await d.raw('/healthz?probe=1')).status, 200, 'a query string does not matter');
});

test('/healthz allocates nothing: hundreds of probes, with any Host and no cookie, create no session and use no slot or rate', async (t) => {
  const d = await start(t, { limits: { maxSessions: 1, newPerMinute: 1 } });
  const hosts = ['127.0.0.1', 'localhost', 'brandproof-judge-demo.onrender.com', '10.0.0.7:10000', 'anything.example', 'evil.example'];
  // in batches of 50: the demo's own connection cap (200 at once by default) is a different limit and is not what is tested here
  const results = [];
  for (let batch = 0; batch < 6; batch++) results.push(...(await Promise.all(Array.from({ length: 50 }, (_, i) => d.raw('/healthz', { host: hosts[(batch * 50 + i) % hosts.length] })))));
  assert.ok(results.every((r) => r.status === 200 && r.text === '{"status":"ok"}' && !r.headers['set-cookie']), 'every probe, whatever Host it claims');
  assert.equal(d.demo.stats().sessions, 0, 'no session was allocated');
  assert.deepEqual(d.folders(), [], 'and nothing was written under the demo root');
  // the single slot and the single start per minute are all still available to a real visitor
  const first = await d.raw('/', { host: '127.0.0.1' });
  assert.equal(first.status, 200);
  assert.match(first.headers['set-cookie'][0], /^bp_judge=/);
  // and probes keep working while the demo is full
  assert.equal((await d.raw('/', { host: '127.0.0.1' })).status, 429, 'the start rate is spent by real visitors only');
  assert.equal((await d.raw('/healthz')).status, 200, 'a full demo is still alive');
  assert.equal(d.demo.stats().sessions, 1);
});

test('/healthz reveals nothing: no path, token, session or count, and no other method or look-alike route is treated as health', async (t) => {
  const d = await start(t);
  await d.raw('/', {}); // one real session exists
  const r = await d.raw('/healthz');
  assert.equal(r.text, '{"status":"ok"}');
  for (const secret of [d.root, 'session', 'cookie', 'root', 'workspace', 'limit', 'bp_judge']) assert.ok(!r.text.toLowerCase().includes(secret.toLowerCase()), `the body must not mention ${secret}`);
  assert.ok(!Object.values(r.headers).join(' ').includes(path.basename(d.root)), 'nor may a header');
  const post = await d.raw('/healthz', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal(post.headers['set-cookie'], undefined);
  // look-alikes are ordinary (unlisted) paths, not health
  for (const p of ['/healthz/', '/healthz/x', '/healthzz', '/health', '/HEALTHZ']) {
    const x = await d.raw(p);
    assert.ok(x.status === 404, `${p} -> ${x.status}`);
    assert.notEqual(x.text, '{"status":"ok"}');
  }
});

test('the host guard still applies to everything else: a foreign Host is refused on the page, the API and static files, while /healthz alone answers', async (t) => {
  const d = await start(t, { allowedHosts: ['judge.example.test'] });
  for (const p of ['/', '/api/meta', '/app.js', '/styles.css']) {
    const r = await d.raw(p, { host: 'evil.example' });
    assert.equal(r.status, 403, p);
    assert.equal(r.headers['set-cookie'], undefined, p);
  }
  assert.equal((await d.raw('/healthz', { host: 'evil.example' })).status, 200);
  assert.deepEqual(d.folders(), []);
});

test('the session info says whether storage is temporary, so the page can say sessions are lost on a restart', async (t) => {
  for (const ephemeral of [true, false]) {
    const d = await start(t, ephemeral ? { ephemeral: true } : {});
    const page = await d.raw('/', { host: '127.0.0.1' });
    const cookie = page.headers['set-cookie'][0].split(';')[0];
    const info = JSON.parse((await d.raw('/api/judge/session', { host: '127.0.0.1', headers: { cookie } })).text);
    assert.equal(info.ephemeral, ephemeral);
  }
});
