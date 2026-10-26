import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcr, normaliseDraftText, ocrAvailability, OCR_LIMITS } from '../src/ocr.js';
import { fakeOcr, fixture, fixtureSha, tick } from './ocr-helpers.js';

const png = () => fixture('clear-30-hours');
const sha = () => fixtureSha('clear-30-hours');
const run = (ocr, extra = {}) => ocr.extract({ sha256: sha(), bytes: png(), ...extra });
const code = (e) => e.code;

test('a draft is bound to its exact image digest and engine, and is never "fixed": numbers pass through untouched', async () => {
  const { ocr } = fakeOcr({ behave: () => ({ text: 'The battery lasts 3O hours\r\non a  single charge.\u0007  \r\n\r\n\r\n\r\nUp to l2 hours', confidence: 87.6 }) });
  const r = await run(ocr);
  assert.equal(r.imageSha256, sha());
  assert.match(r.draftId, /^OCR-[0-9a-f]{16}$/);
  assert.equal(r.text, 'The battery lasts 3O hours\non a  single charge.\n\nUp to l2 hours', 'LF endings, control characters removed, trailing spaces trimmed; "3O" and "l2" are NOT corrected');
  assert.equal(r.confidence, 88);
  assert.equal(r.engine.name, 'tesseract.js');
  assert.equal(r.engine.version, '7.0.0');
  assert.match(r.engine.languageSha256, /^[0-9a-f]{64}$/);
  assert.equal(ocr.lookup(r.draftId).imageSha256, sha());
  assert.equal(ocr.lookup('OCR-0000000000000000'), null);
  assert.equal(normaliseDraftText('a\u0000b\r\nc'), 'ab\nc');
});

test('the result cache is bound to the exact inputs: same image is served from the cache, a different image is read again', async () => {
  const { ocr, log } = fakeOcr();
  const a = await run(ocr);
  const b = await run(ocr);
  assert.equal(b.cached, true);
  assert.equal(b.draftId, a.draftId);
  assert.equal(log.jobs.length, 1);
  const other = await ocr.extract({ sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') });
  assert.notEqual(other.draftId, a.draftId);
  assert.equal(other.imageSha256, fixtureSha('clear-large'));
  assert.equal(log.jobs.length, 2);
});

test('cache entries expire and the cache is bounded', async () => {
  let t = 1_000_000;
  const { ocr, log } = fakeOcr({ service: { now: () => t } }, { cacheTtlMs: 5000, cacheEntries: 2 });
  const names = ['clear-30-hours', 'clear-large', 'inverted-banner'];
  const drafts = [];
  for (const n of names) drafts.push(await ocr.extract({ sha256: fixtureSha(n), bytes: fixture(n) }));
  assert.equal(ocr.lookup(drafts[0].draftId), null, 'the oldest entry was evicted past the bound');
  assert.ok(ocr.lookup(drafts[2].draftId));
  t += 6000;
  assert.equal(ocr.lookup(drafts[2].draftId), null, 'expired');
  const again = await ocr.extract({ sha256: fixtureSha(names[2]), bytes: fixture(names[2]) });
  assert.equal(again.cached, false);
  assert.equal(log.jobs.length, 4);
});

test('one recognition at a time, at most two waiting, then 429; the queue drains and accepts work again', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { ocr } = fakeOcr({ behave: (job) => (job.n === 1 ? () => 'ok' : 'ok') });
  // hold the first job open by answering late
  const fake = fakeOcr({
    behave: (job, w) => {
      gate.then(() => setImmediate(() => !w.dead && w.emit('message', { type: 'result', id: job.id, text: `t${job.n}`, confidence: 90, ms: 1 })));
      return 'hang';
    },
  });
  const names = ['clear-30-hours', 'clear-large', 'inverted-banner', 'wrapped-paragraph', 'text-free-blank'];
  const send = (n) => fake.ocr.extract({ sha256: fixtureSha(n), bytes: fixture(n) });
  const first = send(names[0]);
  await tick(20);
  const second = send(names[1]);
  const third = send(names[2]);
  await assert.rejects(send(names[3]), (e) => e.status === 429 && code(e) === 'ocr_busy');
  assert.equal(fake.ocr.status().queued, 2);
  assert.equal(fake.ocr.status().busy, true);
  release();
  const done = await Promise.all([first, second, third]);
  assert.equal(done.length, 3);
  assert.equal(fake.log.workers.length, 1, 'one worker served all three');
  assert.equal(fake.ocr.status().busy, false);
  await send(names[4]); // accepted again
  void ocr;
});

test('a timeout stops the worker thread, fails only that job, and the next job starts a fresh worker; a late answer from the old worker is ignored', async () => {
  let n = 0;
  const { ocr, log } = fakeOcr({ behave: () => (++n === 1 ? 'hang' : 'ok') }, { timeoutMs: 60 });
  await assert.rejects(run(ocr), (e) => e.status === 504 && code(e) === 'ocr_timeout');
  assert.equal(log.terminated, 1);
  const old = log.workers[0];
  const next = await ocr.extract({ sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') });
  assert.equal(log.created, 2, 'a fresh worker');
  assert.equal(next.imageSha256, fixtureSha('clear-large'));
  // the dead worker wakes up and answers for the job it was running: nothing happens
  old.emit('message', { type: 'result', id: log.jobs[0].id, text: 'STALE ANSWER', confidence: 99, ms: 1 });
  old.emit('error', new Error('late crash'));
  await tick(10);
  assert.equal(ocr.status().busy, false);
  assert.equal(ocr.lookup(next.draftId).text, 'DRAFT TEXT');
});

test('worker crash, exit and engine errors fail the running job with a sanitised message, and the service recovers', async () => {
  for (const how of ['crash', 'exit', 'error']) {
    let n = 0;
    const { ocr, log } = fakeOcr({ behave: () => (++n === 1 ? how : 'ok') });
    await assert.rejects(run(ocr), (e) => {
      assert.equal(e.status, 502, how);
      assert.equal(code(e), 'ocr_failed');
      assert.ok(!/C:\\|Users|\/home|secret/.test(e.message), `no path in: ${e.message}`);
      return true;
    });
    const ok = await run(ocr, { sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') });
    assert.ok(ok.draftId);
    assert.equal(log.created, 2, `${how}: restarted`);
    assert.match(ocr.status().lastError ?? '', /./);
    assert.ok(!/C:\\|Users|secret/.test(ocr.status().lastError));
  }
});

test('start-up failures are unavailable, never a hang: language data error, no ready signal, and the factory is not reached when the data is bad', async () => {
  const bad = fakeOcr({ startup: 'error' });
  await assert.rejects(run(bad.ocr), (e) => e.status === 503 && code(e) === 'ocr_unavailable' && !/C:\\/.test(e.message));
  assert.equal(bad.log.terminated, 1);
  const never = fakeOcr({ startup: 'never' }, { startTimeoutMs: 50 });
  await assert.rejects(run(never.ocr), (e) => e.status === 503 && /did not start in time/.test(e.message));
  assert.equal(never.log.terminated, 1);
  const unverified = fakeOcr({ service: { verify: () => { throw new Error('the English language data does not match its pinned SHA-256'); } } });
  await assert.rejects(run(unverified.ocr), (e) => e.status === 503 && /pinned SHA-256/.test(e.message));
  assert.equal(unverified.log.created, 0, 'no worker was started on unverified data');
  const off = createOcr({ availability: () => ({ ok: false, reason: 'the optional package tesseract.js is not installed (run: npm install)' }), workerFactory: () => assert.fail('never') });
  await assert.rejects(run(off), (e) => e.status === 503 && /Type the text instead/.test(e.message));
  assert.equal(off.status().state, 'unavailable');
});

test('an oversized result is refused, not kept', async () => {
  const { ocr } = fakeOcr({ behave: () => ({ text: 'x'.repeat(OCR_LIMITS.maxTextChars + 1), confidence: 50 }) });
  await assert.rejects(run(ocr), (e) => e.status === 422 && code(e) === 'ocr_result_too_large');
  assert.equal(ocr.lookup('anything'), null);
});

test('cancellation: a queued request is removed; a running one stops the worker; neither leaves the service stuck', async () => {
  const fake = fakeOcr({ behave: () => 'hang' });
  const ac1 = new AbortController();
  const first = run(fake.ocr, { signal: ac1.signal });
  await tick(20);
  const ac2 = new AbortController();
  const queued = fake.ocr.extract({ sha256: fixtureSha('clear-large'), bytes: fixture('clear-large'), signal: ac2.signal });
  assert.equal(fake.ocr.status().queued, 1);
  ac2.abort();
  await assert.rejects(queued, (e) => code(e) === 'ocr_cancelled');
  assert.equal(fake.ocr.status().queued, 0);
  ac1.abort();
  await assert.rejects(first, (e) => code(e) === 'ocr_cancelled');
  assert.equal(fake.log.terminated, 1, 'the running job\'s worker was stopped');
  assert.equal(fake.ocr.status().busy, false);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(run(fake.ocr, { signal: pre.signal }), (e) => code(e) === 'ocr_cancelled');
  // it still works afterwards
  const ok = createOcr({ workerFactory: fakeOcr().factory, availability: () => ({ ok: true }), verify: () => {} });
  assert.ok((await run(ok)).draftId);
});

test('the worker is stopped after it has been idle, and stop() fails everything pending', async () => {
  const fake = fakeOcr({}, { idleMs: 40 });
  await run(fake.ocr);
  assert.equal(fake.log.terminated, 0);
  await tick(120);
  assert.equal(fake.log.terminated, 1, 'idle worker released');
  await run(fake.ocr, { sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') });
  assert.equal(fake.log.created, 2);

  const busy = fakeOcr({ behave: () => 'hang' });
  const a = run(busy.ocr);
  await tick(20);
  const b = busy.ocr.extract({ sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') });
  busy.ocr.stop();
  await assert.rejects(a, (e) => code(e) === 'ocr_unavailable');
  await assert.rejects(b, (e) => code(e) === 'ocr_unavailable');
  assert.ok(busy.log.terminated >= 1);
});

test('status is honest about what the reader is and is not', () => {
  const { ocr } = fakeOcr();
  const s = ocr.status();
  assert.equal(s.engine.name, 'tesseract.js');
  assert.match(s.note, /DRAFT/);
  assert.match(s.note, /not correctness/);
  assert.match(s.note, /no image or text is sent anywhere/);
  assert.equal(s.limits.queued, 2);
  assert.ok(!JSON.stringify(s).includes('C:\\'), 'no path');
  const a = ocrAvailability({ langFile: 'Z:/definitely/missing/eng.traineddata' });
  assert.equal(a.ok, false);
  assert.match(a.reason, /npm run fetch-ocr/);
});
