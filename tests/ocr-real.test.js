// Real-engine tests: they need the optional package and the pinned language data, and are SKIPPED (not faked) without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcr, ocrAvailability, ENGINE, LANG_FILE, OCR_LIMITS } from '../src/ocr.js';
import { fixture, fixtureSha } from './ocr-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const available = ocrAvailability();
const opts = { skip: available.ok ? false : `optional OCR not installed: ${available.reason}` };
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const spec = JSON.parse(readFileSync(path.join(here, 'fixtures', 'ocr', 'fixtures-spec.json'), 'utf8')).fixtures;

test('real engine: the clear fixtures are read exactly (whitespace-normalised) against transcriptions declared BEFORE any reading, and text-free images read as empty', opts, async () => {
  const ocr = createOcr();
  try {
    const exact = [];
    for (const id of ['clear-large', 'clear-30-hours', 'inverted-banner', 'wrapped-paragraph', 'small-text', 'low-contrast']) {
      const f = spec.find((x) => x.id === id);
      const r = await ocr.extract({ sha256: fixtureSha(id), bytes: fixture(id) });
      assert.equal(norm(r.text), norm(f.expected), id);
      assert.equal(r.imageSha256, fixtureSha(id));
      for (const phrase of f.mustContain) assert.ok(norm(r.text).includes(phrase), `${id}: ${phrase}`);
      assert.deepEqual((norm(r.text).match(/\d+/g) ?? []).sort(), [...f.numbers].sort(), `${id}: every number exact`);
      exact.push(id);
    }
    assert.equal(exact.length, 6);
    for (const id of ['text-free-blank', 'text-free-stripes']) {
      const r = await ocr.extract({ sha256: fixtureSha(id), bytes: fixture(id) });
      assert.equal(r.text, '', `${id}: nothing is invented for an image with no text`);
    }
    // the rotated fixture is a documented near miss: numbers right, one letter's case differs
    const rot = await ocr.extract({ sha256: fixtureSha('rotated-7deg'), bytes: fixture('rotated-7deg') });
    assert.deepEqual(norm(rot.text).match(/\d+/g), ['12']);
    assert.equal(norm(rot.text), 'Aurora Lamp lasts Up to 12 hours.', 'reported as read, not corrected to the expected "up to"');
  } finally {
    ocr.stop();
  }
});

test('real engine, review set: the corrected artwork prints EVERY approved qualifier and is read exactly; a monospace image of the wrong claim is read as printed (no failure is simulated)', opts, async () => {
  const review = JSON.parse(readFileSync(path.join(here, 'fixtures', 'ocr', 'fixtures-review.json'), 'utf8')).fixtures;
  const ocr = createOcr();
  try {
    for (const f of review) {
      const r = await ocr.extract({ sha256: fixtureSha(f.id), bytes: fixture(f.id) });
      assert.equal(norm(r.text), norm(f.expected), `${f.id}: the reading equals the words printed (declared before any reading)`);
      for (const phrase of f.mustContain) assert.ok(norm(r.text).includes(phrase), `${f.id}: ${phrase}`);
    }
    // the corrected artwork, read and confirmed unchanged, is consistent with the approved fact: no edit of the transcript was needed
    const banner = await ocr.extract({ sha256: fixtureSha('qualified-banner'), bytes: fixture('qualified-banner') });
    const { runChecks } = await import('../src/checks.js');
    const { guidelinesFixture, blankAsset } = await import('./helpers.js');
    const out = runChecks({ text: 'A reading lamp for your desk.', asset: blankAsset(), imageText: banner.text }, guidelinesFixture());
    const fct = out.findings.find((x) => x.field === 'imageText' && x.ruleId === 'FCT-001');
    assert.equal(fct.status, 'supported', 'every approved qualifier is printed in the artwork');
    assert.ok(!out.findings.some((x) => x.field === 'imageText' && x.severity === 'error'));
  } finally {
    ocr.stop();
  }
});

test('real engine: the hard fixtures fail in the ways recorded in the proof, and failures are reported as read, never repaired', opts, async () => {
  const stress = JSON.parse(readFileSync(path.join(here, 'fixtures', 'ocr', 'fixtures-stress.json'), 'utf8')).fixtures;
  const ocr = createOcr();
  try {
    const read = {};
    for (const f of stress) {
      const bytes = readFileSync(path.join(here, 'fixtures', 'ocr', 'stress', `${f.id}.png`));
      const r = await ocr.extract({ sha256: fixtureSha('clear-large') + f.id.length, bytes }); // distinct cache keys
      read[f.id] = norm(r.text);
    }
    assert.equal(read['gradient-busy-background'], '', 'white text on a busy gradient is read as nothing: reported as empty, not guessed');
    assert.notEqual(read['tiny-9px'], norm(stress.find((x) => x.id === 'tiny-9px').expected), 'tiny text keeps its misreadings');
    assert.match(read['tiny-9px'], /waranty/, 'a misspelling stays a misspelling');
    assert.notEqual(read['script-italic'], norm(stress.find((x) => x.id === 'script-italic').expected));
    assert.equal(read['blurred'], 'The battery lasts 30 hours.');
    assert.equal(read['decimals-and-percent'], 'Up to 12.5 hours of light. 100% recycled aluminium.');
    assert.equal(read['all-caps-banner'], 'NO MORE THAN 8 HOURS');
  } finally {
    ocr.stop();
  }
});

function child(args, env = {}) {
  return new Promise((resolve) => {
    const log = path.join(mkdtempSync(path.join(os.tmpdir(), 'bp-net-')), 'attempts.log');
    const p = spawn(process.execPath, ['--require', path.join(ROOT, 'scripts', 'ocr-proof', 'block-network.cjs'), path.join(ROOT, 'scripts', 'ocr-proof', 'offline-extract.mjs'), ...args], { cwd: ROOT, env: { ...process.env, NET_ATTEMPT_LOG: log, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on('exit', () => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(out.trim().split('\n').at(-1));
      } catch {}
      resolve({ json, out });
    });
  });
}

test('real engine, NETWORK DISABLED: recognition succeeds with a live network blocker in the process and its worker threads, and records zero attempts; the blocker is proven live by a control', opts, async () => {
  const r = await child([path.join(here, 'fixtures', 'ocr', 'clear-30-hours.png'), 'control']);
  assert.ok(r.json, r.out);
  assert.equal(r.json.controlBlocked, true, 'a deliberate request was blocked: the blocker works');
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.equal(norm(r.json.text), 'The battery lasts 30 hours on a single charge.');
  assert.equal(r.json.attempts, 1, 'exactly the one deliberate control attempt, nothing from the recognition');
});

test('real engine: missing or altered language data is UNAVAILABLE, with no download and no network attempt', opts, async () => {
  const png = path.join(here, 'fixtures', 'ocr', 'clear-30-hours.png');
  // 1. nothing there
  const empty = mkdtempSync(path.join(os.tmpdir(), 'bp-ocr-empty-'));
  const missing = await child([png], { BRANDPROOF_OCR_DIR: empty });
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.status, 503);
  assert.equal(missing.json.code, 'ocr_unavailable');
  assert.match(missing.json.message, /npm run fetch-ocr/);
  assert.equal(missing.json.attempts, 0, 'a missing file never turns into a CDN fetch');
  // 2. right size, one byte changed
  const altered = mkdtempSync(path.join(os.tmpdir(), 'bp-ocr-alt-'));
  mkdirSync(path.join(altered, ENGINE.language.code), { recursive: true });
  const bytes = readFileSync(LANG_FILE);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  writeFileSync(path.join(altered, ENGINE.language.code, ENGINE.language.file), bytes);
  const bad = await child([png], { BRANDPROOF_OCR_DIR: altered });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.code, 'ocr_unavailable');
  assert.match(bad.json.message, /pinned SHA-256/);
  assert.equal(bad.json.attempts, 0);
  rmSync(empty, { recursive: true, force: true });
  rmSync(altered, { recursive: true, force: true });
  void copyFileSync;
});

test('real engine: a timeout stops the worker thread and the next reading starts a fresh one; undecodable bytes fail cleanly and do not wedge the service', opts, async () => {
  const limits = { ...OCR_LIMITS, timeoutMs: 1 };
  const ocr = createOcr({ limits });
  try {
    await assert.rejects(ocr.extract({ sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') }), (e) => e.status === 504 && e.code === 'ocr_timeout');
    assert.equal(ocr.status().busy, false);
    limits.timeoutMs = 30_000;
    const ok = await ocr.extract({ sha256: fixtureSha('clear-large'), bytes: fixture('clear-large') });
    assert.match(norm(ok.text), /up to 12 hours/);
    const junk = Buffer.from('this is not an image at all, just text');
    const t0 = Date.now();
    const settled = await ocr.extract({ sha256: 'f'.repeat(64), bytes: junk }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
    assert.ok(Date.now() - t0 < 25_000, 'it settled well inside the limit');
    if (!settled.ok) assert.ok([502, 503, 504].includes(settled.e.status), String(settled.e.status));
    else assert.equal(settled.r.text, '', 'if the engine accepts garbage it must not invent text');
    const again = await ocr.extract({ sha256: fixtureSha('clear-30-hours'), bytes: fixture('clear-30-hours') });
    assert.match(norm(again.text), /30 hours/);
  } finally {
    ocr.stop();
  }
});

test('real engine: concurrency is bounded (one running, two waiting, a fourth is refused) and every accepted reading is correct for ITS image', opts, async () => {
  const ocr = createOcr();
  try {
    const ids = ['clear-large', 'clear-30-hours', 'inverted-banner', 'wrapped-paragraph'];
    const calls = ids.map((id) => ocr.extract({ sha256: fixtureSha(id), bytes: fixture(id) }).then((r) => ({ id, r }), (e) => ({ id, e })));
    const done = await Promise.all(calls);
    const refused = done.filter((d) => d.e);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].e.code, 'ocr_busy');
    for (const d of done.filter((x) => x.r)) {
      const want = norm(spec.find((s) => s.id === d.id).expected);
      assert.equal(norm(d.r.text), want, d.id);
      assert.equal(d.r.imageSha256, fixtureSha(d.id), 'each reading is bound to its own image');
    }
  } finally {
    ocr.stop();
  }
});
