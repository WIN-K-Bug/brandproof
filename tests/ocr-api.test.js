import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createOcr, OCR_LIMITS } from '../src/ocr.js';
import { sha256Hex } from '../src/assets.js';
import { startApp, blankAsset } from './helpers.js';
import { startAuthApp } from './auth-helpers.js';
import { makeNoisePng } from './png-helpers.js';
import { fakeOcr, fakeReader, fixture, fixtureSha, tick } from './ocr-helpers.js';

const OCTET = { 'content-type': 'application/octet-stream' };
// What the corrected artwork actually prints (tests/fixtures/ocr/fixtures-review.json, declared before any reading): every approved qualifier is in the pixels.
const QUALIFIED = 'Aurora Lamp\nA full charge lasts up to 12 hours at medium brightness.\nIndoor use only.';
const TEXTS = {
  [fixtureSha('clear-30-hours')]: 'The battery lasts 30 hours\non a single charge.',
  [fixtureSha('clear-large')]: 'Aurora Lamp\nA full charge lasts up to 12 hours.\nIndoor use only.',
  [fixtureSha('qualified-banner')]: QUALIFIED,
};
const reader = (extra = {}, limits = {}) => fakeOcr({ behave: (job) => ({ text: TEXTS[sha256Hex(Buffer.from(job.bytes))] ?? 'unlisted image text', confidence: 93.2 }), ...extra }, limits);

async function world(appOptions = {}) {
  const t = await startApp({ appOptions });
  const upload = async (bytes) => {
    const r = await t.call('POST', '/api/assets', { role: 'creator', raw: bytes, headers: OCTET });
    assert.ok([200, 201].includes(r.status), r.text);
    return r.json.asset.sha256;
  };
  const asset = (sha, extra = {}) => ({ ...blankAsset(), name: 'banner.png', alt: 'A banner with a short line of text on a plain background', retainedSha256: sha, ...extra });
  const create = async (body, role = 'creator') => t.call('POST', '/api/submissions', { role, body });
  const revise = async (id, body, role = 'creator') => t.call('POST', `/api/submissions/${id}/revisions`, { role, body });
  const extract = (sha, body = {}, role = 'creator') => t.call('POST', `/api/assets/${sha}/ocr`, { role, body });
  const detail = async (id, role = 'reviewer') => (await t.call('GET', `/api/submissions/${id}`, { role })).json;
  return { t, upload, asset, create, revise, extract, detail };
}

const cleanText = 'A reading lamp for your desk.';

test('extraction is bound to a retained digest: only registered digests, only creator or manager, and the draft carries its exact image', async () => {
  const f = reader();
  const w = await world({ ocr: f.ocr });
  try {
    const sha = await w.upload(fixture('clear-30-hours'));
    const r = await w.extract(sha);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.draft.imageSha256, sha);
    assert.equal(r.json.draft.text, 'The battery lasts 30 hours\non a single charge.');
    assert.match(r.json.draft.draftId, /^OCR-[0-9a-f]{16}$/);
    assert.equal(r.json.draft.engine.name, 'tesseract.js');
    assert.match(r.json.note, /automatic DRAFT/);
    assert.match(r.json.note, /not correctness/);
    assert.ok(!('createdMs' in r.json.draft));
    assert.ok(!/[A-Za-z]:\\\\|\/Users\//.test(r.text), 'no path in the response');
    assert.equal((await w.extract(sha)).json.draft.cached, true);
    assert.equal(f.log.jobs.length, 1, 'the second request came from the cache bound to the same digest');

    assert.equal((await w.extract(sha, {}, 'reviewer')).status, 403, 'reviewers cannot start a reading');
    assert.equal((await w.t.call('POST', `/api/assets/${sha}/ocr`, { body: {} })).status, 400, 'a role is required in demo mode');
    for (const bad of ['f'.repeat(64), 'nothex', '..%2f..%2fdata%2fbrandproof.json', 'C%3A%5Csecret', 'http%3A%2F%2Fexample.com%2Fx.png']) {
      assert.equal((await w.extract(bad)).status, 404, bad);
    }
    assert.equal((await w.extract(sha, { submissionId: 'SUB-1', revision: 'x' })).status, 422);
    assert.equal((await w.extract(sha, { url: 'http://example.com/x.png', path: 'C:/x.png' })).status, 200, 'unknown keys are ignored, never followed');
    assert.equal(f.log.jobs.length, 1);
  } finally {
    await w.t.close();
  }
});

test('reading is unavailable, not faked, when the reader is off, and the manual workflow is unaffected', async () => {
  const w = await world({ ocr: null });
  try {
    const sha = await w.upload(fixture('clear-30-hours'));
    const r = await w.extract(sha);
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'ocr_unavailable');
    assert.match(r.json.error.message, /Type the text instead/);
    assert.equal((await w.t.call('GET', '/api/ocr/status', { role: 'creator' })).json.state, 'unavailable');
    // a person can still confirm a typed transcription
    const made = await w.create({ title: 'Typed', text: cleanText, asset: w.asset(sha), imageText: { text: 'The battery lasts 30 hours on a single charge.', confirmed: true } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.revisions[0].imageText.provenance.kind, 'typed');
  } finally {
    await w.t.close();
  }
});

test('missing or damaged image bytes block reading (the engine is never reached); restoring them unblocks it', async () => {
  const f = reader();
  const w = await world({ ocr: f.ocr });
  try {
    const png = fixture('clear-30-hours');
    const sha = await w.upload(png);
    const file = path.join(`${path.join(w.t.dir, 'data.json')}.assets`, `${sha}.png`);
    const bytes = await fs.readFile(file);
    const hurt = Buffer.from(bytes);
    hurt[Math.floor(hurt.length / 2)] ^= 1;
    await fs.writeFile(file, hurt);
    const corrupt = await w.extract(sha);
    assert.equal(corrupt.status, 409);
    assert.equal(corrupt.json.error.code, 'asset_corrupt');
    await fs.rm(file);
    const missing = await w.extract(sha);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'asset_missing');
    assert.equal(f.log.created, 0, 'no worker was even started');
    assert.equal((await w.t.call('POST', '/api/assets', { role: 'creator', raw: png, headers: OCTET })).status, 200, 'identical re-upload restores it');
    assert.equal((await w.extract(sha)).status, 200);
  } finally {
    await w.t.close();
  }
});

test('an extraction can be tied to a SAVED revision, which must really hold that image; a revision saved meanwhile is reported', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fakeOcr({ behave: (job, wk) => { gate.then(() => setImmediate(() => !wk.dead && wk.emit('message', { type: 'result', id: job.id, text: 'late text', confidence: 80, ms: 1 }))); return 'hang'; } });
  const w = await world({ ocr: f.ocr });
  try {
    const a = await w.upload(fixture('clear-30-hours'));
    const b = await w.upload(fixture('clear-large'));
    const made = (await w.create({ title: 'Two images', text: cleanText, asset: w.asset(a) })).json;
    assert.equal((await w.revise(made.id, { baseRevision: 1, text: cleanText, asset: w.asset(b) })).status, 201);
    assert.equal((await w.extract(b, { submissionId: made.id, revision: 1 })).status, 409, 'revision 1 holds image A, not B');
    assert.equal((await w.extract(b, { submissionId: made.id, revision: 1 })).json.error.code, 'image_mismatch');
    assert.equal((await w.extract(b, { submissionId: made.id, revision: 9 })).status, 404);
    // slow extraction for revision 2; a new revision is saved while it runs
    const pending = w.extract(b, { submissionId: made.id, revision: 2 });
    await tick(100);
    assert.equal((await w.revise(made.id, { baseRevision: 2, text: `${cleanText} Calm.`, asset: w.asset(b) })).status, 201);
    release();
    const r = await pending;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.revision.superseded, true);
    assert.equal(r.json.revision.headRevision, 3);
    assert.equal(r.json.draft.imageSha256, b, 'the late result is still bound to the image it was read from');
  } finally {
    release();
    await w.t.close();
  }
});

test('queue bound over HTTP: one reading at a time, two waiting, then 429, and it recovers', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = fakeOcr({ behave: (job, wk) => { gate.then(() => setImmediate(() => !wk.dead && wk.emit('message', { type: 'result', id: job.id, text: `t${job.n}`, confidence: 80, ms: 1 }))); return 'hang'; } });
  const w = await world({ ocr: f.ocr });
  try {
    const shas = [];
    for (let i = 1; i <= 5; i++) shas.push(await w.upload(makeNoisePng({ seed: i })));
    const calls = shas.slice(0, 3).map((s) => w.extract(s));
    await tick(150);
    const refused = await w.extract(shas[3]);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error.code, 'ocr_busy');
    release();
    assert.deepEqual((await Promise.all(calls)).map((r) => r.status), [200, 200, 200]);
    assert.equal((await w.extract(shas[4])).status, 200);
  } finally {
    release();
    await w.t.close();
  }
});

test('closing the browser connection cancels a running reading: the worker is stopped and the service keeps working', async () => {
  let hang = true;
  const f = fakeOcr({ behave: () => (hang ? 'hang' : 'ok') });
  const w = await world({ ocr: f.ocr });
  try {
    const sha = await w.upload(fixture('clear-30-hours'));
    const ac = new AbortController();
    const req = fetch(`${w.t.url}/api/assets/${sha}/ocr`, { method: 'POST', headers: { 'x-demo-role': 'creator', 'content-type': 'application/json' }, body: '{}', signal: ac.signal }).catch((e) => e.name);
    await tick(200);
    assert.equal(f.ocr.status().busy, true);
    ac.abort();
    assert.equal(await req, 'AbortError');
    for (let i = 0; i < 40 && f.log.terminated === 0; i++) await tick(25);
    assert.equal(f.log.terminated, 1, 'the abandoned reading\'s worker was stopped');
    assert.equal(f.ocr.status().busy, false);
    hang = false;
    assert.equal((await w.extract(sha)).status, 200);
  } finally {
    await w.t.close();
  }
});

// ---------- confirmation, provenance, forged input ----------

test('a confirmed transcription is stored with provenance decided by the server; forged fields are ignored', async () => {
  const f = reader();
  const w = await world({ ocr: f.ocr });
  try {
    const sha = await w.upload(fixture('clear-30-hours'));
    const draft = (await w.extract(sha)).json.draft;
    // 1. the reading, confirmed unchanged
    const same = (await w.create({ title: 'Unchanged', text: cleanText, asset: w.asset(sha), imageText: { text: draft.text, draftId: draft.draftId, confirmed: true } })).json;
    const r1 = same.revisions[0].imageText;
    assert.equal(r1.imageSha256, sha);
    assert.deepEqual(r1.confirmedBy, { role: 'creator', name: 'Demo Creator' });
    assert.equal(r1.provenance.kind, 'ocr-draft');
    assert.equal(r1.provenance.edited, false);
    assert.equal(r1.provenance.draft.id, draft.draftId);
    assert.equal(r1.provenance.draft.textSha256, draft.textSha256);
    assert.equal(r1.confirmedInRevision, 1);
    // 2. corrected by the person
    const fixedBy = (await w.create({ title: 'Corrected', text: cleanText, asset: w.asset(sha), imageText: { text: 'The battery lasts 8 hours on a single charge.', draftId: draft.draftId, confirmed: true } })).json;
    assert.equal(fixedBy.revisions[0].imageText.provenance.edited, true);
    assert.equal(fixedBy.revisions[0].imageText.provenance.kind, 'ocr-draft');
    // 3. forged fields: who, when, which image, what kind of provenance
    const forged = await w.create({ title: 'Forged', text: cleanText, asset: w.asset(sha), imageText: { text: 'Aurora Lamp', confirmed: true, imageSha256: 'a'.repeat(64), confirmedBy: { id: 'U-1', name: 'The Owner', role: 'manager' }, confirmedAt: '2001-01-01T00:00:00Z', provenance: { kind: 'ocr-draft', edited: false }, confirmedInRevision: 99 } });
    assert.equal(forged.status, 201, forged.text);
    const rf = forged.json.revisions[0].imageText;
    assert.equal(rf.imageSha256, sha);
    assert.deepEqual(rf.confirmedBy, { role: 'creator', name: 'Demo Creator' });
    assert.notEqual(rf.confirmedAt, '2001-01-01T00:00:00Z');
    assert.equal(rf.provenance.kind, 'typed');
    assert.equal(rf.confirmedInRevision, 1);
    // 4. an unknown (expired or restarted) draft id is recorded honestly as typed
    const gone = (await w.create({ title: 'Gone', text: cleanText, asset: w.asset(sha), imageText: { text: 'x', draftId: 'OCR-0123456789abcdef', confirmed: true } })).json;
    assert.deepEqual([gone.revisions[0].imageText.provenance.kind, gone.revisions[0].imageText.provenance.draftUnavailable], ['typed', true]);
  } finally {
    await w.t.close();
  }
});

test('confirmation is explicit and the draft must be for THIS image: unconfirmed, image-less and stale drafts are refused', async () => {
  const f = reader();
  const w = await world({ ocr: f.ocr });
  try {
    const a = await w.upload(fixture('clear-30-hours'));
    const b = await w.upload(fixture('clear-large'));
    const draftA = (await w.extract(a)).json.draft;
    const base = { title: 'T', text: cleanText };
    for (const unconfirmed of [{ text: 'x' }, { text: 'x', confirmed: false }, { text: 'x', confirmed: 'yes' }]) {
      const r = await w.create({ ...base, asset: w.asset(a), imageText: unconfirmed });
      assert.equal(r.status, 422, JSON.stringify(unconfirmed));
      assert.equal(r.json.error.code, 'confirmation_required');
    }
    const noImage = await w.create({ ...base, asset: blankAsset(), imageText: { text: 'x', confirmed: true } });
    assert.equal(noImage.status, 422);
    assert.equal(noImage.json.error.code, 'no_retained_image');
    // a late reading of image A cannot attach to a revision that holds image B
    const stale = await w.create({ ...base, asset: w.asset(b), imageText: { text: draftA.text, draftId: draftA.draftId, confirmed: true } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'ocr_draft_stale');
    assert.equal((await w.t.call('GET', '/api/submissions', { role: 'creator' })).json.submissions.filter((s) => s.title === 'T').length, 0, 'nothing was saved');
    // same for a revision of an existing submission
    const made = (await w.create({ ...base, asset: w.asset(a) })).json;
    const stale2 = await w.revise(made.id, { baseRevision: 1, text: cleanText, asset: w.asset(b), imageText: { text: draftA.text, draftId: draftA.draftId, confirmed: true } });
    assert.equal(stale2.status, 409);
    assert.equal((await w.detail(made.id)).headRevision, 1);
    // malformed draft id and over-long text
    assert.equal((await w.create({ ...base, asset: w.asset(a), imageText: { text: 'x', draftId: '../../etc', confirmed: true } })).status, 422);
    assert.equal((await w.create({ ...base, asset: w.asset(a), imageText: { text: 'x'.repeat(4001), confirmed: true } })).status, 422);
  } finally {
    await w.t.close();
  }
});

test('the confirmed transcription is checked as its OWN field: exact quote and span in the transcript, a source, and advice instead of a rewrite', async () => {
  const w = await world({ ocr: reader().ocr });
  try {
    const sha = await w.upload(fixture('clear-30-hours'));
    const transcript = 'The battery lasts 30 hours\non a single charge.';
    const made = (await w.create({ title: 'Image claim', text: cleanText, asset: w.asset(sha), imageText: { text: transcript, confirmed: true } })).json;
    const f = made.current.findings.find((x) => x.field === 'imageText' && x.ruleId === 'FCT-001');
    assert.equal(f.status, 'contradicted');
    assert.equal(f.severity, 'error');
    assert.equal(f.quote, '30 hours');
    assert.equal(transcript.slice(f.span.start, f.span.end), '30 hours', 'offsets refer to the transcription');
    assert.match(f.id, /\|imageText\|/);
    assert.equal(f.correction.type, 'advice', 'words inside an image are never rewritten automatically');
    assert.match(f.correction.text, /printed inside the image/);
    assert.match(f.correction.text, /editing the transcript does not change the image/);
    assert.match(f.correction.text, /replace the image, then transcribe and confirm again/);
    assert.match(f.correction.text, /up to 12 hours at medium brightness/);
    assert.equal(f.source.doc.includes('Fact Sheet'), true);
    assert.equal(made.workflow.eligibility.approve.blockingCount, 1);
    assert.ok(!made.current.findings.some((x) => x.field === 'text' && x.ruleId === 'FCT-001'), 'the campaign copy itself is untouched');
    // a transcription that is fine produces consistent findings, and the "not checked" note is honest either way
    const ok = (await w.create({ title: 'Fine', text: cleanText, asset: w.asset(await w.upload(fixture('qualified-banner'))), imageText: { text: QUALIFIED, confirmed: true } })).json;
    assert.equal(ok.current.findings.find((x) => x.field === 'imageText' && x.ruleId === 'FCT-001').status, 'supported');
    assert.ok(ok.current.notChecked.some((n) => n.ruleId === 'IMG-TXT' && /only as far as a person transcribed/.test(n.reason)));
    const none = (await w.create({ title: 'No transcript', text: cleanText, asset: w.asset(sha) })).json;
    assert.ok(none.current.notChecked.some((n) => n.ruleId === 'IMG-TXT' && /no transcription of it has been confirmed/.test(n.reason)));
    assert.ok(!none.current.findings.some((x) => x.field === 'imageText'));
  } finally {
    await w.t.close();
  }
});

// ---------- the approval covers the transcription and the exact image ----------

async function approved(w, id, role = 'reviewer') {
  const made = await w.detail(id);
  const rr = await w.t.call('POST', `/api/submissions/${id}/request-review`, { role: 'creator', body: { revision: made.headRevision, expected: made.workflow.binding } });
  assert.equal(rr.status, 201, rr.text);
  const seen = await w.detail(id);
  const ok = await w.t.call('POST', `/api/submissions/${id}/approve`, { role, body: { revision: seen.headRevision, expected: seen.workflow.binding } });
  assert.equal(ok.status, 201, ok.text);
}

test('approval binds the confirmed transcription and the exact image; changing either stales it, server-side', async () => {
  const w = await world({ ocr: reader().ocr });
  try {
    const clearLarge = await w.upload(fixture('qualified-banner'));
    const other = await w.upload(fixture('inverted-banner'));
    const good = QUALIFIED;
    const made = (await w.create({ title: 'Bound', text: cleanText, asset: w.asset(clearLarge), imageText: { text: good, confirmed: true } })).json;
    assert.match(made.workflow.binding.imageTextHash, /^[0-9a-f]{64}$/);
    await approved(w, made.id);
    assert.equal((await w.detail(made.id)).workflow.status, 'approved');

    // (a) only the transcription changes: same copy, same image
    const r2 = await w.revise(made.id, { baseRevision: 1, text: cleanText, asset: w.asset(clearLarge), imageText: { text: good.replace(/\n/g, ' '), confirmed: true } });
    assert.equal(r2.status, 201, r2.text);
    const d2 = await w.detail(made.id);
    assert.equal(d2.workflow.status, 'approval_stale');
    assert.deepEqual(d2.workflow.staleApproval.reasons, ['imagetext']);
    // (b) only the copy changes: the confirmation is carried forward for the identical image
    const r3 = await w.revise(made.id, { baseRevision: 2, text: `${cleanText} Calm.`, asset: w.asset(clearLarge) });
    assert.equal(r3.status, 201, r3.text);
    const d3 = await w.detail(made.id);
    const carried = d3.revisions.at(-1).imageText;
    assert.equal(carried.text, good.replace(/\n/g, ' '));
    assert.equal(carried.carriedFromRevision, 2);
    assert.equal(carried.confirmedInRevision, 2, 'the original confirmation is not re-attributed');
    assert.equal(d3.workflow.binding.imageTextHash, d2.workflow.binding.imageTextHash);
    // (c) the image is replaced and nothing new is confirmed: the confirmation is gone, not carried
    const r4 = await w.revise(made.id, { baseRevision: 3, text: `${cleanText} Calm.`, asset: w.asset(other) });
    assert.equal(r4.status, 201, r4.text);
    const d4 = await w.detail(made.id);
    assert.equal(d4.revisions.at(-1).imageText, undefined);
    assert.equal(Object.hasOwn(d4.workflow.binding, 'imageTextHash'), false);
    assert.ok(d4.current.notChecked.some((n) => n.ruleId === 'IMG-TXT' && /no transcription/.test(n.reason)));
    // (d) the image is removed
    const r5 = await w.revise(made.id, { baseRevision: 4, text: `${cleanText} Calm and bright.`, asset: blankAsset() });
    assert.equal(r5.status, 201, r5.text);
    assert.equal((await w.detail(made.id)).revisions.at(-1).imageText, undefined);
  } finally {
    await w.t.close();
  }
});

test('stale image-text state cannot be decided on: an old expected binding is refused, and a saved approval names the transcription', async () => {
  const w = await world({ ocr: reader().ocr });
  try {
    const sha = await w.upload(fixture('qualified-banner'));
    const good = QUALIFIED;
    const made = (await w.create({ title: 'Decide', text: cleanText, asset: w.asset(sha), imageText: { text: good, confirmed: true } })).json;
    const rr = await w.t.call('POST', `/api/submissions/${made.id}/request-review`, { role: 'creator', body: { revision: 1, expected: made.workflow.binding } });
    assert.equal(rr.status, 201);
    const seen = await w.detail(made.id);
    // a client that omits the transcription hash (an old view, or a forgery) is not "current"
    const { imageTextHash, ...without } = seen.workflow.binding;
    assert.ok(imageTextHash);
    const refused = await w.t.call('POST', `/api/submissions/${made.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: without } });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'stale_view');
    assert.deepEqual(refused.json.error.details.changed, ['imagetext']);
    assert.equal((await w.detail(made.id)).events.filter((e) => e.type === 'approved').length, 0);
    // a forged hash for different text is refused too
    const forged = await w.t.call('POST', `/api/submissions/${made.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: { ...seen.workflow.binding, imageTextHash: 'b'.repeat(64) } } });
    assert.equal(forged.status, 409);
    const ok = await w.t.call('POST', `/api/submissions/${made.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(ok.status, 201, ok.text);
    const ev = ok.json.events.find((e) => e.type === 'approved');
    assert.equal(ev.binding.imageTextHash, imageTextHash, 'the recorded decision names the transcription it covered');
  } finally {
    await w.t.close();
  }
});

test('older approvals (no transcription) are unaffected: their binding has no imageTextHash and stays approved', async () => {
  const w = await world({ ocr: reader().ocr });
  try {
    const seeded = (await w.t.call('GET', '/api/submissions', { role: 'reviewer' })).json.submissions.find((s) => s.status === 'approved' || s.status === 'in_review');
    const d = await w.detail(seeded.id);
    assert.equal(Object.hasOwn(d.workflow.binding, 'imageTextHash'), false);
    assert.equal(d.revisions.every((r) => r.imageText === undefined), true);
    assert.equal(d.workflow.status, seeded.status);
  } finally {
    await w.t.close();
  }
});

// ---------- dossier ----------

test('the dossier states what was confirmed, by whom, and what it does not prove', async () => {
  const w = await world({ ocr: reader().ocr });
  try {
    const sha = await w.upload(fixture('clear-large'));
    const draft = (await w.extract(sha)).json.draft;
    const made = (await w.create({ title: 'Dossier', text: cleanText, asset: w.asset(sha), imageText: { text: `${draft.text} `, draftId: draft.draftId, confirmed: true } })).json;
    const d = (await w.t.call('GET', `/api/submissions/${made.id}/dossier`, { role: 'reviewer' })).json;
    assert.equal(d.imageText.state, 'confirmed');
    assert.equal(d.imageText.text, draft.text);
    assert.equal(d.imageText.imageSha256, sha);
    assert.equal(d.imageText.matchesRetainedImage, true);
    assert.deepEqual(d.imageText.confirmedBy, { role: 'creator', name: 'Demo Creator' });
    assert.equal(d.imageText.provenance.kind, 'ocr-draft');
    assert.equal(d.imageText.provenance.editedAfterReading, false);
    assert.equal(d.imageText.provenance.automaticReading.id, draft.draftId);
    assert.match(d.imageText.provenance.automaticReading.confidenceNote, /not a measure of correctness/);
    assert.match(d.imageText.note, /not verification/);
    assert.match(d.imageText.printedRule, /^Match the words actually printed\. Editing this transcript does not change the image\. To fix a claim in the artwork, replace the image, then transcribe and confirm again\.$/);
    assert.match(d.imageText.limit, /cannot compare the transcript with the pixels/);
    assert.match(d.hashMethods.imageTextHash, /imageSha256/);
    assert.ok(d.limitations.some((l) => /draft and can be wrong; it is never source evidence/.test(l)));
    assert.equal(d.currentBinding.imageTextHash, made.workflow.binding.imageTextHash);
    assert.match(d.image.coloursNote, /nothing about colour, contrast or logos is read from the image/);
    const none = (await w.create({ title: 'Plain', text: cleanText, asset: w.asset(sha) })).json;
    assert.equal((await w.t.call('GET', `/api/submissions/${none.id}/dossier`, { role: 'reviewer' })).json.imageText.state, 'none');
  } finally {
    await w.t.close();
  }
});

// ---------- authenticated mode ----------

test('authenticated mode: sessions, CSRF and roles apply to reading and confirming; the confirmer is the signed-in account', async () => {
  const f = reader();
  const t = await startAuthApp({ users: ['creator', 'reviewer', 'manager'], appOptions: { ocr: f.ocr } });
  try {
    const [creator, reviewer, manager] = [await t.as('creator'), await t.as('reviewer'), await t.as('manager')];
    const up = await creator.call('POST', '/api/assets', { raw: fixture('qualified-banner'), headers: OCTET });
    assert.ok([200, 201].includes(up.status), up.text);
    const sha = up.json.asset.sha256;
    const url = `/api/assets/${sha}/ocr`;
    assert.equal((await t.client().call('POST', url, { body: {} })).status, 401);
    assert.equal((await t.client().call('POST', url, { body: {}, headers: { 'x-demo-role': 'creator' } })).status, 401, 'the demo header means nothing here');
    assert.equal((await creator.call('POST', url, { body: {}, csrf: null })).status, 403, 'no CSRF token');
    assert.equal((await creator.call('POST', url, { body: {}, origin: 'http://evil.example' })).status, 403);
    assert.equal((await reviewer.call('POST', url, { body: {} })).status, 403, 'reviewers cannot start a reading');
    assert.equal((await creator.call('POST', url, { body: {}, headers: { 'x-demo-role': 'reviewer' } })).status, 200, 'a forged role header changes nothing');
    const draft = (await manager.call('POST', url, { body: {} })).json.draft;
    assert.equal(draft.cached, true);

    const body = { title: 'Auth', text: cleanText, asset: { name: 'b.png', alt: 'A banner with a short line of text on a plain background', retainedSha256: sha }, imageText: { text: QUALIFIED.replace(/\n/g, ' '), draftId: draft.draftId, confirmed: true, confirmedBy: { id: 'U-1', name: 'Forged', role: 'manager' } } };
    const made = await creator.call('POST', '/api/submissions', { body });
    assert.equal(made.status, 201, made.text);
    const it = made.json.revisions[0].imageText;
    assert.deepEqual(it.confirmedBy, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' });
    assert.equal(it.provenance.edited, true);
    // the creator cannot approve their own campaign; a different signed-in reviewer can, and the decision names the transcription
    const rr = await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } });
    assert.equal(rr.status, 201, rr.text);
    const seen = (await reviewer.call('GET', `/api/submissions/${made.json.id}`)).json;
    const self = await creator.call('POST', `/api/submissions/${made.json.id}/approve`, { body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(self.status, 403);
    const ok = await reviewer.call('POST', `/api/submissions/${made.json.id}/approve`, { body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.events.find((e) => e.type === 'approved').binding.imageTextHash, seen.workflow.binding.imageTextHash);
    const dossier = (await reviewer.call('GET', `/api/submissions/${made.json.id}/dossier`)).json;
    assert.equal(dossier.imageText.confirmedBy.id, t.ids.creator);
    assert.ok(!JSON.stringify(dossier).includes('Forged'));
  } finally {
    await t.close();
  }
});

test('the reader is released when the app closes', async () => {
  const f = reader();
  const w = await world({ ocr: f.ocr });
  const sha = await w.upload(fixture('clear-30-hours'));
  assert.equal((await w.extract(sha)).status, 200);
  assert.equal(f.log.terminated, 0);
  await w.t.close();
  assert.equal(f.log.terminated, 1, 'closing the app stopped the reader\'s worker');
  void createOcr; void OCR_LIMITS; void fakeReader;
});
