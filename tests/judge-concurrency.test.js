// The judge demo's limits under SIMULTANEOUS requests. A limit that is checked and only later counted can be passed by many requests at once
// (the m20 review found 12 sessions admitted under a cap of 1). These tests start requests together and check the limits hold exactly, that a
// failed start rolls its claim back completely, and that simultaneous writes to one session cannot overshoot its storage cap.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createJudgeDemo } from '../src/judge.js';
import { tempDir, cleanContent } from './helpers.js';
import { makePng } from './png-helpers.js';

const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;
const tally = (xs) => xs.reduce((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

async function startDemo(t, opts = {}) {
  const tmp = await tempDir();
  const root = path.join(tmp.dir, 'demo-root');
  const time = { now: T0 };
  const demo = await createJudgeDemo({ root, semantic: null, ocr: null, clock: () => time.now, ...opts });
  const base = await demo.listen(0);
  t.after(async () => {
    await demo.close().catch(() => {});
    await tmp.cleanup();
  });
  /** One request; a visitor is whatever cookie it carries. */
  const call = async (method, p, { cookie, role, body, raw } = {}) => {
    const h = {};
    if (cookie) h.cookie = cookie;
    if (role) h['x-demo-role'] = role;
    let payload;
    if (raw !== undefined) {
      h['content-type'] = 'application/octet-stream';
      payload = raw;
    } else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, setCookie: res.headers.get('set-cookie')?.split(';')[0] ?? null, headers: res.headers };
  };
  return { demo, base, time, root, call, folders: () => readdirSync(path.join(root, 'sessions')), open: () => call('GET', '/') };
}
const outcome = (r) => `${r.status}${r.setCookie ? '+cookie' : ''}`;
const submission = (title, text = cleanContent().text) => ({ title, text, asset: cleanContent().asset });

test('the review\'s probe: 12 simultaneous page loads under maxSessions 1 and newPerMinute 1 admit exactly ONE session', async (t) => {
  const d = await startDemo(t, { limits: { maxSessions: 1, newPerMinute: 1 } });
  const results = await Promise.all(Array.from({ length: 12 }, () => d.open()));
  const admitted = results.filter((r) => r.setCookie);
  assert.equal(admitted.length, 1, JSON.stringify(tally(results.map(outcome))));
  assert.equal(admitted[0].status, 200);
  for (const r of results.filter((x) => !x.setCookie)) assert.ok([429, 503].includes(r.status), `refused with ${r.status}`);
  assert.equal(d.demo.stats().sessions, 1, 'one session in the index');
  assert.equal(d.folders().length, 1, 'and one folder on disk');
  assert.equal((await d.call('GET', '/api/submissions', { cookie: admitted[0].setCookie })).status, 200, 'the admitted visitor works');
});

test('the session cap alone: 30 simultaneous starts admit exactly the cap, the rest get the "demo is full" answer, and it stays so', async (t) => {
  const d = await startDemo(t, { limits: { maxSessions: 3, newPerMinute: 1000 } });
  const results = await Promise.all(Array.from({ length: 30 }, () => d.open()));
  assert.deepEqual(tally(results.map(outcome)), { '200+cookie': 3, 503: 27 });
  for (const r of results.filter((x) => x.status === 503)) {
    assert.equal(r.headers.get('retry-after'), '60');
    assert.match(r.text, /The demo is full/);
  }
  assert.equal(d.demo.stats().sessions, 3);
  assert.equal(d.folders().length, 3);
  assert.equal((await d.open()).status, 503, 'still full afterwards');
});

test('the start rate alone: 30 simultaneous starts admit exactly newPerMinute, the rest get the "busy" answer, and the window then reopens', async (t) => {
  const d = await startDemo(t, { limits: { maxSessions: 100, newPerMinute: 4 } });
  const results = await Promise.all(Array.from({ length: 30 }, () => d.open()));
  assert.deepEqual(tally(results.map(outcome)), { '200+cookie': 4, 429: 26 });
  assert.equal(d.demo.stats().sessions, 4);
  d.time.now = T0 + 61_000;
  const again = await Promise.all(Array.from({ length: 10 }, () => d.open()));
  assert.deepEqual(tally(again.map(outcome)), { '200+cookie': 4, 429: 6 }, 'a minute later exactly four more');
  assert.equal(d.demo.stats().sessions, 8);
});

test('slots freed by expiry are claimed exactly once each: 8 simultaneous starts into 2 expired slots admit 2, and the expired sessions are gone', async (t) => {
  const d = await startDemo(t, { limits: { maxSessions: 2, newPerMinute: 1000, idleMinutes: 120 } });
  const old = [await d.open(), await d.open()];
  assert.ok(old.every((r) => r.setCookie));
  d.time.now = T0 + 121 * MIN;
  const results = await Promise.all(Array.from({ length: 8 }, () => d.open()));
  assert.equal(results.filter((r) => r.setCookie).length, 2, JSON.stringify(tally(results.map(outcome))));
  assert.ok(d.demo.stats().sessions <= 2);
  await d.demo.sweep();
  assert.equal(d.folders().length, 2, 'only the two new sessions remain on disk');
  for (const o of old) assert.equal((await d.call('GET', '/api/submissions', { cookie: o.setCookie })).status, 401, 'the expired sessions never come back');
});

test('a failed start rolls its claim back completely: it uses up neither a session slot nor a place in the start rate, and never overwrites an existing session', async (t) => {
  const FIXED = Buffer.alloc(32, 7);
  let fixed = true;
  const idSource = () => (fixed ? FIXED : crypto.randomBytes(32));

  // cap accounting
  const a = await startDemo(t, { idSource, limits: { maxSessions: 2, newPerMinute: 1000 } });
  const first = await a.open();
  assert.equal(first.status, 200);
  const cookie = first.setCookie;
  assert.equal(cookie, `bp_judge=${FIXED.toString('base64url')}`);
  await a.call('POST', '/api/submissions', { cookie, role: 'creator', body: submission('survives the collisions') });
  // the next ids collide with the existing folder: those starts fail (and nothing is created or changed)...
  for (let i = 0; i < 3; i++) {
    const r = await a.open();
    assert.equal(r.status, 500);
    assert.equal(r.setCookie, null);
  }
  // ...also when they arrive together: while one holds the free slot the others see "full"; either way none is admitted and nothing is left behind
  const together = await Promise.all(Array.from({ length: 6 }, () => a.open()));
  for (const r of together) {
    assert.ok([500, 503].includes(r.status), `status ${r.status}`);
    assert.equal(r.setCookie, null);
  }
  assert.ok(together.some((r) => r.status === 500), 'one of them reached the collision');
  assert.equal(a.demo.stats().sessions, 1, 'no failed start left a session behind');
  assert.equal(a.folders().length, 1);
  assert.equal((await a.call('GET', '/api/submissions', { cookie })).json.submissions.some((s) => s.title === 'survives the collisions'), true, 'the existing session was not overwritten');
  // ...and did not consume the slot: the second slot is still available, and exactly one remains
  fixed = false;
  assert.equal((await a.open()).status, 200, 'the failures did not use up a slot');
  assert.equal((await a.open()).status, 503, 'and the cap is exactly 2');
  assert.equal(a.demo.stats().sessions, 2);

  // rate accounting
  fixed = true;
  const b = await startDemo(t, { idSource, limits: { maxSessions: 100, newPerMinute: 2 } });
  assert.equal((await b.open()).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await b.open()).status, 500);
  fixed = false;
  assert.equal((await b.open()).status, 200, 'the failures did not use up places in the start rate');
  assert.equal((await b.open()).status, 429, 'and the rate is exactly 2 per minute');
});

test('simultaneous writes cannot overshoot a session\'s storage cap: they take turns, at most one lands beyond it, the rest are refused clearly', async (t) => {
  const d = await startDemo(t, { limits: { sessionKiB: 64 } });
  const { setCookie: cookie } = await d.open();
  const long = 'A full charge lasts up to 12 hours. '.repeat(130); // about 5 KB per submission
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => d.call('POST', '/api/submissions', { cookie, role: 'creator', body: submission(`concurrent ${i}`, long) })));
  const t2 = tally(results.map((r) => r.status));
  assert.ok(t2[413] >= 1, `some simultaneous writes must be refused: ${JSON.stringify(t2)}`);
  assert.equal((t2[201] ?? 0) + (t2[413] ?? 0), 12, `every write gets a clear answer: ${JSON.stringify(t2)}`);
  for (const r of results.filter((x) => x.status === 413)) assert.equal(r.json.error.code, 'session_full');
  const info = (await d.call('GET', '/api/judge/session', { cookie })).json;
  assert.ok(info.storage.usedBytes <= info.storage.maxBytes + 9_000, `used ${info.storage.usedBytes} of ${info.storage.maxBytes}: at most one write beyond the cap`);
  assert.equal((await d.call('POST', '/api/submissions', { cookie, role: 'creator', body: submission('after', long) })).status, 413, 'and it stays full');
  assert.equal((await d.call('GET', '/api/submissions', { cookie })).status, 200, 'reads still work');
});

test('a flood of simultaneous writes to one session is bounded: the queue is capped, the surplus gets a clear "busy" answer, and the session stays healthy', async (t) => {
  const d = await startDemo(t);
  const { setCookie: cookie } = await d.open();
  const results = await Promise.all(Array.from({ length: 80 }, (_, i) => d.call('POST', '/api/submissions', { cookie, role: 'creator', body: submission(`flood ${i}`) })));
  const t2 = tally(results.map((r) => r.status));
  assert.ok(t2[429] >= 1, `the write queue must be bounded: ${JSON.stringify(t2)}`);
  assert.ok(Object.keys(t2).every((s) => ['201', '429'].includes(s)), JSON.stringify(t2));
  for (const r of results.filter((x) => x.status === 429)) assert.equal(r.json.error.code, 'session_busy');
  const ok = results.filter((x) => x.status === 201).length;
  const titles = (await d.call('GET', '/api/submissions', { cookie })).json.submissions.filter((s) => s.title.startsWith('flood '));
  assert.equal(titles.length, ok, 'every accepted write is saved, every refused one is not');
  assert.equal((await d.call('POST', '/api/submissions', { cookie, role: 'creator', body: submission('after the flood') })).status, 201, 'the session is healthy afterwards');
});

test('simultaneous image uploads cannot pass the image count: with a limit of 1, exactly one of eight different images is kept', async (t) => {
  const d = await startDemo(t, { limits: { imageCount: 1 } });
  const { setCookie: cookie } = await d.open();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => d.call('POST', '/api/assets', { cookie, role: 'creator', raw: makePng({ width: 16 + i, height: 16, pixel: [i * 20, 60, 90] }) })));
  assert.deepEqual(tally(results.map((r) => r.status)), { 201: 1, 413: 7 });
  for (const r of results.filter((x) => x.status === 413)) assert.equal(r.json.error.code, 'asset_quota');
  assert.equal((await d.call('GET', '/api/assets/usage', { cookie })).json.count, 1);
});

test('simultaneous work from many visitors stays isolated: each of six visitors, writing six things at once, sees exactly its own', async (t) => {
  const d = await startDemo(t, { limits: { maxLive: 3 } });
  const visitors = await Promise.all(Array.from({ length: 6 }, async (_, v) => ({ v, cookie: (await d.open()).setCookie })));
  assert.equal(new Set(visitors.map((x) => x.cookie)).size, 6);
  const writes = await Promise.all(visitors.flatMap(({ v, cookie }) => Array.from({ length: 6 }, (_, k) => d.call('POST', '/api/submissions', { cookie, role: 'creator', body: submission(`v${v}-w${k}`) }))));
  assert.ok(writes.every((r) => r.status === 201), JSON.stringify(tally(writes.map((r) => r.status))));
  assert.ok(d.demo.stats().live <= 3);
  for (const { v, cookie } of visitors) {
    const titles = (await d.call('GET', '/api/submissions', { cookie })).json.submissions.map((s) => s.title).filter((x) => /^v\d+-w\d+$/.test(x));
    assert.deepEqual(titles.sort(), Array.from({ length: 6 }, (_, k) => `v${v}-w${k}`).sort(), `visitor ${v}`);
  }
  assert.ok(existsSync(d.root));
});
