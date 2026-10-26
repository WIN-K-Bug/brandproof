// The Host and Origin guard with deployment host names. The default (no list) must stay exactly as strict as before; a deployment
// that lists its public host name is admitted by that name only, and its https:// origin (a TLS-terminating proxy) counts as the same site.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { tempDir, cleanContent } from './helpers.js';

// Every test here has a bound: one that stops making progress fails BY NAME after 30 s instead of silently stalling the whole run.
const test = (name, fn) => baseTest(name, { timeout: 30_000 }, fn);

async function withServer(appOptions, fn) {
  const tmp = await tempDir();
  const app = await createApp({ dataFile: path.join(tmp.dir, 'd.json'), semantic: null, ocr: null, ...appOptions });
  const url = await app.listen(0);
  const port = Number(new URL(url).port);
  // Always connects to this server; only the Host and Origin the request CLAIMS differ (as they do behind a proxy).
  const send = (host, { method = 'GET', p = '/api/meta', origin, role, body } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { host };
      if (origin) headers.origin = origin;
      if (role) headers['x-demo-role'] = role;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
      });
      req.setTimeout(15_000, () => req.destroy(new Error(`no answer for ${method} ${p} (Host ${host}) within 15 s`)));
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    await fn({ send, port, app });
  } finally {
    await app.close();
    await tmp.cleanup();
  }
}
const submission = { title: 'Host test', ...cleanContent() };

test('default: only localhost names are answered, so a public host name is refused exactly as before', async () => {
  await withServer({}, async ({ send, port }) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost']) assert.equal((await send(host)).status, 200, host);
    for (const host of ['judge.example.test', `judge.example.test:${port}`, 'evil.example', '203.0.113.7', `[::1]:${port}`, '0.0.0.0']) {
      const r = await send(host);
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error.code, 'bad_host', host);
      assert.equal(r.json.error.message, 'This server only answers on localhost.');
    }
    assert.equal((await send('judge.example.test', { p: '/' })).status, 403, 'the page is refused too, not only the API');
  });
});

test('a listed host name is answered (any case, with or without a port); lookalikes and unlisted names are not', async () => {
  await withServer({ allowedHosts: ['judge.example.test', '203.0.113.7'] }, async ({ send, port }) => {
    for (const host of ['judge.example.test', 'JUDGE.Example.Test', `judge.example.test:${port}`, '203.0.113.7', `203.0.113.7:${port}`, `localhost:${port}`, `127.0.0.1:${port}`]) {
      assert.equal((await send(host)).status, 200, host);
    }
    assert.equal((await send('judge.example.test', { p: '/' })).status, 200, 'the page is served on the listed name');
    for (const host of ['evil.example', 'judge.example.test.evil.example', 'xjudge.example.test', 'example.test', '203.0.113.8', `[::1]:${port}`, '0.0.0.0']) {
      const r = await send(host);
      assert.equal(r.status, 403, host);
      assert.equal(r.json.error.code, 'bad_host', host);
    }
  });
});

test('behind a TLS proxy: the https:// origin of a listed host is the same site; every other origin is refused', async () => {
  await withServer({ allowedHosts: ['judge.example.test'] }, async ({ send, port }) => {
    const write = (host, origin) => send(host, { method: 'POST', p: '/api/submissions', role: 'creator', body: submission, origin });
    assert.equal((await write('judge.example.test', 'https://judge.example.test')).status, 201, 'https origin of the listed host');
    assert.equal((await write('judge.example.test', 'http://judge.example.test')).status, 201, 'http origin of the listed host');
    assert.equal((await write('judge.example.test')).status, 201, 'demo mode still tolerates a missing Origin (scripts)');
    for (const origin of ['https://evil.example', 'http://evil.example', 'https://judge.example.test:9999', 'https://sub.judge.example.test', 'null']) {
      const r = await write('judge.example.test', origin);
      assert.equal(r.status, 403, origin);
      assert.equal(r.json.error.code, 'bad_origin', origin);
    }
    // https is never trusted for the loopback names: a page on https://localhost is not this server
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.equal((await write(host, `https://${host}`)).status, 403, host);
      assert.equal((await write(host, `http://${host}`)).status, 201, host);
    }
  });
});

test('"*" answers to any plain host name (including an IPv6 literal) but still enforces the same-site origin rule', async () => {
  await withServer({ allowedHosts: '*' }, async ({ send, port }) => {
    for (const host of ['anything.example', 'a.b.c.example:8443', '203.0.113.99', `[::1]:${port}`]) assert.equal((await send(host)).status, 200, host);
    const write = (host, origin) => send(host, { method: 'POST', p: '/api/submissions', role: 'creator', body: submission, origin });
    assert.equal((await write('anything.example', 'https://anything.example')).status, 201);
    assert.equal((await write('anything.example', 'https://evil.example')).status, 403);
  });
});

test('the guard does not loosen anything else: roles, validation and the approval gate behave the same on a listed name', async () => {
  await withServer({ allowedHosts: ['judge.example.test'] }, async ({ send }) => {
    const h = 'judge.example.test';
    const o = 'https://judge.example.test';
    assert.equal((await send(h, { method: 'POST', p: '/api/submissions', body: submission, origin: o })).status, 400, 'no role is still refused');
    assert.equal((await send(h, { method: 'POST', p: '/api/submissions', role: 'creator', body: { title: '', text: '' }, origin: o })).status, 422, 'validation still applies');
    const bad = (await send(h, { method: 'POST', p: '/api/submissions', role: 'creator', body: { ...submission, text: 'A full charge lasts 30 hours.' }, origin: o })).json;
    const approve = await send(h, { method: 'POST', p: `/api/submissions/${bad.id}/approve`, role: 'reviewer', body: { revision: 1, expected: bad.workflow.binding }, origin: o });
    assert.equal(approve.status, 403);
    assert.equal(approve.json.error.code, 'not_allowed');
  });
});

test('createApp refuses an unusable host list, and authenticated mode never accepts one', async () => {
  const tmp = await tempDir();
  try {
    for (const bad of ['judge.example.com', ['Judge.Example.com'], ['https://judge.example.com'], ['judge.example.com:8080'], [''], [1], null]) {
      await assert.rejects(createApp({ dataFile: path.join(tmp.dir, 'bad.json'), semantic: null, ocr: null, allowedHosts: bad }), /allowedHosts must be "\*" or a list of lower-case host names/, JSON.stringify(bad));
    }
    for (const list of [['judge.example.com'], '*']) {
      await assert.rejects(createApp({ dataFile: path.join(tmp.dir, 'a.json'), mode: 'authenticated', authFile: path.join(tmp.dir, 'u.json'), semantic: null, ocr: null, allowedHosts: list }), /Authenticated mode answers on localhost only/);
    }
  } finally {
    await tmp.cleanup();
  }
});
