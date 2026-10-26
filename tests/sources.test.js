import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { createSemantic } from '../src/semantic.js';
import { normalizeSourceText, spanProblem, SOURCE_LIMITS, EMPTY_EVIDENCE_HASH } from '../src/sources.js';
import { startApp, tempDir, cleanContent, describeFetchFailure } from './helpers.js';
import { FACT_SHEET, FACT_SHEET_V2, FACT_SHEET_CHANGED, sha, demoAs, registerSource, approveVersion, link, span, publishWithLink } from './sources-helpers.js';

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';

async function world() {
  const t = await startApp();
  return { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer') };
}

/** Register + approve v1, link FCT-001 (battery) to it, publish. Returns ids and the link. */
async function linkedBattery(w) {
  const src = await registerSource(w.creator);
  assert.equal((await approveVersion(w.manager, src.id, 1, FACT_SHEET)).status, 201);
  const l = link(src.id, 1, FACT_SHEET, BATTERY);
  const { res } = await publishWithLink(w.manager, 'FCT-001', l);
  assert.equal(res.status, 201, res.text);
  return { src, l };
}

const batteryCopy = () => ({ title: 'Battery claim', text: 'A full charge lasts up to 12 hours.', asset: cleanContent().asset });

async function approvedSubmission(w) {
  const made = await w.creator('POST', '/api/submissions', batteryCopy());
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  const rr = await w.creator('POST', `/api/submissions/${id}/request-review`, { revision: 1, expected: made.json.workflow.binding });
  assert.equal(rr.status, 201, rr.text);
  const seen = (await w.reviewer('GET', `/api/submissions/${id}`)).json;
  const ok = await w.reviewer('POST', `/api/submissions/${id}/approve`, { revision: 1, expected: seen.workflow.binding });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.workflow.status, 'approved');
  return id;
}

const detail = async (w, id) => (await w.reviewer('GET', `/api/submissions/${id}`)).json;

// ---------- text normalisation and spans ----------

test('text normalisation is explicit: BOM, CRLF/CR, NFC; control characters, U+FFFD and empty text are refused', () => {
  assert.equal(normalizeSourceText('﻿a\r\nb\rc'), 'a\nb\nc');
  assert.equal(normalizeSourceText('café'), 'café'); // NFC
  assert.throws(() => normalizeSourceText('bad\u0000char'), (e) => e.status === 422);
  assert.throws(() => normalizeSourceText('bad � decode'), (e) => /could not be decoded/.test(e.message));
  assert.throws(() => normalizeSourceText('   \n  '), (e) => e.status === 422);
  assert.throws(() => normalizeSourceText('x'.repeat(SOURCE_LIMITS.textChars + 1)), (e) => e.status === 422);
  assert.throws(() => normalizeSourceText(42), (e) => e.status === 422);
  assert.equal(normalizeSourceText('tab\there'), 'tab\there'); // TAB and LF are allowed
});

test('span rules: inside the text, whole characters only, 3 to 500 non-space characters', () => {
  const t = 'hello \u{1F600} world and more words here';
  assert.equal(spanProblem(t, 0, 5), null);
  assert.match(spanProblem(t, 5, 5), /outside/);
  assert.match(spanProblem(t, -1, 4), /outside/);
  assert.match(spanProblem(t, 0, 999), /outside/);
  assert.match(spanProblem(t, 0.5, 4), /whole numbers/);
  assert.match(spanProblem(t, 7, 12), /middle of a character/); // starts on the low half of the emoji
  assert.match(spanProblem(t, 0, 7), /middle of a character/); // ends between the halves
  assert.match(spanProblem(t, 0, 2), /at least 3/);
  assert.match(spanProblem('a'.repeat(800), 0, 600), /at most 500/);
});

// ---------- registration ----------

test('registering a source preserves text, label, digest, actor and time, and approves NOTHING', async () => {
  const w = await world();
  try {
    const r = await w.creator('POST', '/api/sources', { title: 'Fernlight fact sheet (fictional)', filename: 'facts.txt', origin: 'file', text: '﻿' + FACT_SHEET.replace(/\n/g, '\r\n'), url: 'https://example.com/facts', note: 'first draft' });
    assert.equal(r.status, 201, r.text);
    const s = r.json.source;
    assert.equal(s.id, 'SRC-1');
    assert.equal(s.activeVersion, null);
    assert.equal(s.versions[0].status, 'pending');
    assert.equal(s.versions[0].state, 'pending');
    assert.equal(s.versions[0].textSha256, sha(FACT_SHEET), 'digest is of the NORMALISED text');
    assert.equal(s.versions[0].chars, FACT_SHEET.length);
    assert.equal(s.versions[0].filename, 'facts.txt');
    assert.deepEqual(s.createdBy, { role: 'creator', name: 'Demo Creator' });
    assert.ok(s.createdAt);
    assert.equal(s.url, 'https://example.com/facts');
    assert.match(s.urlNote, /never opens or verifies/);
    const v = (await w.reviewer('GET', '/api/sources/SRC-1/versions/1')).json;
    assert.equal(v.version.text, FACT_SHEET, 'stored text is LF-normalised and BOM-free');
    assert.equal((await w.reviewer('GET', '/api/sources')).json.sources[0].latestStatus, 'pending');
  } finally {
    await w.t.close();
  }
});

test('registration validation, size bounds and roles', async () => {
  const w = await world();
  try {
    const bad = async (body, status = 422) => assert.equal((await w.creator('POST', '/api/sources', body)).status, status, JSON.stringify(body).slice(0, 80));
    await bad({ text: FACT_SHEET }); // no title
    await bad({ title: 'x' }); // no text
    await bad({ title: 'x', text: '   ' });
    await bad({ title: 'x', text: 'ok text here', url: 'javascript:alert(1)' });
    await bad({ title: 'x', text: 'ok text here', url: 'ftp://example.com/a' });
    await bad({ title: 'x', text: 'ok text here', url: 'https://exa mple.com' });
    await bad({ title: 'x', text: 'bad\u0000text' });
    await bad({ title: 'x', text: 'decode � failure' });
    await bad({ title: 'x'.repeat(121), text: 'ok text here' });
    await bad({ title: 'x', text: 'y'.repeat(SOURCE_LIMITS.textChars + 1) });
    await bad({ title: 'x', text: 'ok text here', origin: 'url' });
    assert.equal((await w.reviewer('POST', '/api/sources', { title: 'x', text: 'ok text here' })).status, 403);
    const huge = await w.t.call('POST', '/api/sources', { role: 'creator', raw: JSON.stringify({ title: 'x', text: 'y'.repeat(600 * 1024) }), headers: { 'content-type': 'application/json' } });
    assert.equal(huge.status, 413);
    assert.equal((await w.reviewer('GET', '/api/sources')).json.sources.length, 0, 'nothing was stored by the refused requests');
    // hostile text is inert data
    const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
    const ok = await w.creator('POST', '/api/sources', { title: evil, text: evil + ' more words' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.source.title, evil);
  } finally {
    await w.t.close();
  }
});

test('URLs are metadata only: no fetching ever happens (the server has no outbound call for them)', async () => {
  const w = await world();
  try {
    const calls = [];
    const real = globalThis.fetch;
    // a registered URL pointing at an address nobody serves must not cause any request from the server process
    globalThis.fetch = (...a) => (String(a[0]).startsWith(w.t.url) ? real(...a) : (calls.push(String(a[0])), Promise.reject(new Error('blocked'))));
    try {
      const r = await w.creator('POST', '/api/sources', { title: 'Linked doc', text: 'some approved wording here', url: 'http://127.0.0.1:1/never-fetched' });
      assert.equal(r.status, 201);
      await approveVersion(w.manager, 'SRC-1', 1, 'some approved wording here');
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(calls, []);
  } finally {
    await w.t.close();
  }
});

// ---------- approval ----------

test('approval: only a manager, only a pending version, only the digest they reviewed; reject needs a reason', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator);
    assert.equal((await approveVersion(w.creator, src.id, 1, FACT_SHEET)).status, 403);
    assert.equal((await approveVersion(w.reviewer, src.id, 1, FACT_SHEET)).status, 403);
    const wrong = await w.manager('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: sha('some other text') });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.error.code, 'stale_view');
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/1/approve`, {})).status, 422);
    const ok = await approveVersion(w.manager, src.id, 1, FACT_SHEET, 'looks right');
    assert.equal(ok.status, 201);
    const v = ok.json.source.versions[0];
    assert.equal(v.status, 'approved');
    assert.equal(v.state, 'active');
    assert.deepEqual(v.reviewedBy, { role: 'manager', name: 'Demo Manager' });
    assert.equal(v.reviewNote, 'looks right');
    assert.equal(ok.json.source.activeVersion, 1);
    assert.equal((await approveVersion(w.manager, src.id, 1, FACT_SHEET)).json.error.code, 'not_pending');
    assert.equal((await approveVersion(w.manager, src.id, 9, FACT_SHEET)).status, 404);
    assert.equal((await approveVersion(w.manager, 'SRC-99', 1, FACT_SHEET)).status, 404);

    const v2 = await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    assert.equal(v2.status, 201);
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/2/reject`, {})).status, 422, 'a reason is required');
    const rej = await w.manager('POST', `/api/sources/${src.id}/versions/2/reject`, { note: 'Not what we agreed.' });
    assert.equal(rej.status, 201);
    assert.equal(rej.json.source.versions[1].status, 'rejected');
    assert.equal(rej.json.source.activeVersion, 1, 'rejecting a draft never touches the active version');
    assert.equal((await approveVersion(w.manager, src.id, 2, FACT_SHEET_V2)).json.error.code, 'not_pending');
    assert.equal((await w.creator('POST', `/api/sources/${src.id}/versions/2/reject`, { note: 'x' })).status, 403);
  } finally {
    await w.t.close();
  }
});

test('a new version is pending and does NOT replace the approved one; only approval activates it', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const before = (await w.reviewer('GET', '/api/submissions')).json;
    const v2 = await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2, note: 'adds care advice' });
    assert.equal(v2.status, 201);
    const s = v2.json.source;
    assert.equal(s.activeVersion, 1);
    assert.equal(s.versions[1].status, 'pending');
    assert.equal(s.versions[0].state, 'active');
    // optimistic concurrency and no-op protection
    assert.equal((await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET + ' extra words' })).status, 409);
    assert.equal((await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 2, text: FACT_SHEET_V2 })).json.error.code, 'no_change');
    assert.equal((await w.reviewer('POST', `/api/sources/${src.id}/versions`, { baseVersion: 2, text: 'something else entirely' })).status, 403);
    assert.deepEqual((await w.reviewer('GET', '/api/submissions')).json, before, 'a draft replacement changes nothing about any submission');
    assert.equal((await w.reviewer('GET', '/api/sources')).json.evidence.broken.length, 0);
  } finally {
    await w.t.close();
  }
});

test('approved versions are immutable: text and digest never change, history is append-only, no edit route exists', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator);
    await approveVersion(w.manager, src.id, 1, FACT_SHEET);
    const first = (await w.reviewer('GET', `/api/sources/${src.id}/versions/1`)).json.version;
    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    await approveVersion(w.manager, src.id, 2, FACT_SHEET_V2);
    const again = (await w.reviewer('GET', `/api/sources/${src.id}/versions/1`)).json.version;
    assert.equal(again.text, first.text);
    assert.equal(again.textSha256, first.textSha256);
    assert.equal(again.state, 'superseded');
    assert.equal(again.status, 'approved', 'history keeps that it WAS approved, by whom and when');
    assert.deepEqual(again.reviewedBy, first.reviewedBy);
    const events = (await w.reviewer('GET', `/api/sources/${src.id}`)).json.source.events.map((e) => [e.type, e.version]);
    assert.deepEqual(events, [['registered', 1], ['approved', 1], ['version_added', 2], ['approved', 2]]);
    for (const m of ['PUT', 'PATCH', 'DELETE']) assert.ok([404, 405].includes((await w.manager(m, `/api/sources/${src.id}/versions/1`, { text: 'tampered text here' })).status));
  } finally {
    await w.t.close();
  }
});

// ---------- linking evidence into rules ----------

test('publishing a link: the server cuts the quote from the approved text and rewrites doc/section/quote itself', async () => {
  const w = await world();
  try {
    const { src, l } = await linkedBattery(w);
    const g = (await w.reviewer('GET', '/api/guidelines')).json.guidelines;
    const fact = g.facts.find((f) => f.id === 'FCT-001');
    assert.equal(fact.source.quote, BATTERY);
    assert.equal(fact.source.sourceId, src.id);
    assert.equal(fact.source.version, 1);
    assert.equal(fact.source.start, l.start);
    assert.equal(fact.source.end, l.end);
    assert.equal(fact.source.textSha256, sha(FACT_SHEET));
    assert.match(fact.source.doc, /Fernlight fact sheet \(fictional\) \(SRC-1\)/);
    assert.match(fact.source.section, /version 1, characters/);
    assert.equal(FACT_SHEET.slice(fact.source.start, fact.source.end), fact.source.quote);
    // forged doc/section in the request are replaced, not trusted
    const g2 = (await w.reviewer('GET', '/api/guidelines')).json;
    const e = structuredClone(g2.guidelines);
    e.facts.find((f) => f.id === 'FCT-002').source = { ...link(src.id, 1, FACT_SHEET, 'Indoor use only; not waterproof or water resistant.'), doc: 'Totally Official Standard', section: '99.9', quote: 'Indoor use only; not waterproof or water resistant.' };
    const pub = await w.manager('PUT', '/api/guidelines', { baseVersion: g2.version, guidelines: e });
    assert.equal(pub.status, 201, pub.text);
    const after = (await w.reviewer('GET', '/api/guidelines')).json.guidelines.facts.find((f) => f.id === 'FCT-002').source;
    assert.match(after.doc, /SRC-1/);
    assert.doesNotMatch(after.doc + after.section, /Official|99\.9/);
  } finally {
    await w.t.close();
  }
});

test('invented, mismatched or invalid references are rejected with the reason; nothing is published', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator);
    await approveVersion(w.manager, src.id, 1, FACT_SHEET);
    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 }); // v2 pending
    const before = (await w.reviewer('GET', '/api/guidelines')).json;
    const good = link(src.id, 1, FACT_SHEET, BATTERY);
    const tries = {
      'invented quote': { ...good, quote: 'Battery life: up to 40 hours.' },
      'quote from a different offset': { ...good, quote: 'Indoor use only' },
      'end before start': { ...good, start: good.end, end: good.start },
      'empty span': { ...good, end: good.start },
      'past the end': { ...good, start: 0, end: FACT_SHEET.length + 5 },
      'negative start': { ...good, start: -3 },
      'fractional offsets': { ...good, start: 1.5 },
      'too long': { ...good, start: 0, end: FACT_SHEET.length, ...(FACT_SHEET.length > 500 ? {} : { end: 0 }) },
      'unknown source': { ...good, sourceId: 'SRC-77' },
      'malformed source id': { ...good, sourceId: '../../etc' },
      'unknown version': { ...good, version: 9 },
      'pending version': { ...good, version: 2 },
      'whitespace only': { ...good, start: FACT_SHEET.indexOf('\n\n'), end: FACT_SHEET.indexOf('\n\n') + 2 },
    };
    for (const [name, source] of Object.entries(tries)) {
      if (name === 'too long') continue; // covered by the span unit test (the fixture is under 500 characters)
      const r = await publishWithLink(w.manager, 'FCT-001', source);
      assert.ok([422].includes(r.res.status), `${name}: ${r.res.status} ${r.res.text.slice(0, 160)}`);
    }
    // a pending version names itself in the reason
    const pend = await publishWithLink(w.manager, 'FCT-001', { ...good, version: 2 });
    assert.equal(pend.res.json.error.code, 'evidence_invalid');
    assert.match(pend.res.json.error.details.problems[0].message, /only a draft/);
    // policies cannot carry registered links in this slice
    const g = (await w.reviewer('GET', '/api/guidelines')).json;
    const e = structuredClone(g.guidelines);
    e.claims.source = good;
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: e })).status, 422);
    assert.deepEqual((await w.reviewer('GET', '/api/guidelines')).json, before, 'no refused request changed the guidelines');
  } finally {
    await w.t.close();
  }
});

test('a rejected or withdrawn source cannot be linked either, and the failure lists every problem at once', async () => {
  const w = await world();
  try {
    const s1 = await registerSource(w.creator, { title: 'Rejected doc' });
    await w.manager('POST', `/api/sources/${s1.id}/versions/1/reject`, { note: 'no' });
    const s2 = await registerSource(w.creator, { title: 'Withdrawn doc' });
    await approveVersion(w.manager, s2.id, 1, FACT_SHEET);
    await w.manager('POST', `/api/sources/${s2.id}/withdraw`, { expectedActiveVersion: 1, note: 'retired' });
    const g = (await w.reviewer('GET', '/api/guidelines')).json;
    const e = structuredClone(g.guidelines);
    e.facts[0].source = link(s1.id, 1, FACT_SHEET, BATTERY);
    e.facts[1].source = link(s2.id, 1, FACT_SHEET, 'Indoor use only');
    const r = await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: e });
    assert.equal(r.status, 422);
    const problems = r.json.error.details.problems;
    assert.equal(problems.length, 2);
    assert.match(problems[0].message, /rejected/);
    assert.match(problems[1].message, /withdrawn/);
    assert.deepEqual(problems.map((p) => p.path), ['facts[0].source', 'facts[1].source']);
  } finally {
    await w.t.close();
  }
});

test('repeated passages are told apart by offset; Unicode and CRLF sources keep offsets consistent', async () => {
  const w = await world();
  try {
    const text = 'Rule one: keep it calm.\r\nRule two: keep it calm.\r\nCafé note \u{1F600} done here.';
    const src = await registerSource(w.creator, { title: 'Repeats', text });
    const norm = normalizeSourceText(text);
    await approveVersion(w.manager, src.id, 1, norm);
    const second = span(norm, 'keep it calm.', 1);
    const first = span(norm, 'keep it calm.', 0);
    assert.notEqual(second.start, first.start);
    for (const [which, sp] of [['second', second], ['first', first]]) {
      const { res } = await publishWithLink(w.manager, 'TRM-003', { sourceId: src.id, version: 1, ...sp, quote: 'keep it calm.' });
      assert.equal(res.status, 201, `${which}: ${res.text}`);
      const saved = (await w.reviewer('GET', '/api/guidelines')).json.guidelines.terms.find((t) => t.id === 'TRM-003').source;
      assert.equal(saved.start, sp.start, 'the exact occurrence is pinned');
    }
    // offsets are into the NORMALISED text (accent composed, LF only): the combining sequence counts as one character
    const cafe = span(norm, 'Café note');
    assert.equal((await publishWithLink(w.manager, 'TRM-003', { sourceId: src.id, version: 1, ...cafe })).res.status, 201);
    // an offset computed on the ORIGINAL (CRLF, decomposed) text lands somewhere else and the stated quote exposes it
    const naive = span(text, 'keep it calm.', 1);
    const wrong = await publishWithLink(w.manager, 'TRM-003', { sourceId: src.id, version: 1, ...naive, quote: 'keep it calm.' });
    assert.equal(wrong.res.status, 422);
    // splitting the emoji is refused; including all of it is fine
    const emoji = norm.indexOf('\u{1F600}');
    assert.equal((await publishWithLink(w.manager, 'TRM-003', { sourceId: src.id, version: 1, start: emoji + 1, end: emoji + 8 })).res.status, 422);
    assert.equal((await publishWithLink(w.manager, 'TRM-003', { sourceId: src.id, version: 1, start: emoji - 5, end: emoji + 2 })).res.status, 201);
  } finally {
    await w.t.close();
  }
});

test('legacy entries stay explicitly legacy: never relabelled, even if their typed label mentions a registered source', async () => {
  const w = await world();
  try {
    await linkedBattery(w);
    const g = (await w.reviewer('GET', '/api/guidelines')).json;
    const e = structuredClone(g.guidelines);
    e.facts.find((f) => f.id === 'FCT-003').source.doc = 'SRC-1 (looks registered, is not)';
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: e })).status, 201);
    const made = await w.creator('POST', '/api/submissions', { title: 'Mixed', text: 'A full charge lasts up to 12 hours. The body is 100% recycled aluminium.', asset: cleanContent().asset });
    const byRule = Object.fromEntries(made.json.current.findings.filter((f) => f.ruleKind === 'fact').map((f) => [f.ruleId, f]));
    assert.equal(byRule['FCT-001'].sourceEvidence.provenance, 'registered');
    assert.equal(byRule['FCT-001'].sourceEvidence.state, 'active');
    assert.equal(byRule['FCT-001'].source.sourceId, 'SRC-1');
    assert.equal(byRule['FCT-003'].sourceEvidence.provenance, 'legacy');
    assert.equal(byRule['FCT-003'].source.sourceId, undefined);
    assert.match(byRule['FCT-003'].sourceEvidence.note, /not linked to a registered source/);
    const check = await w.creator('POST', '/api/check', { text: 'A full charge lasts 30 hours.', asset: {} });
    assert.equal(check.json.findings[0].sourceEvidence.provenance, 'registered');
  } finally {
    await w.t.close();
  }
});

// ---------- effect on approvals ----------

test('the effective evidence is part of every approval binding', async () => {
  const w = await world();
  try {
    const before = await w.creator('POST', '/api/submissions', batteryCopy());
    assert.equal(before.json.workflow.binding.evidenceHash, EMPTY_EVIDENCE_HASH, 'no registered evidence: the empty manifest');
    await linkedBattery(w);
    const after = await detail(w, before.json.id);
    assert.notEqual(after.workflow.binding.evidenceHash, EMPTY_EVIDENCE_HASH);
    assert.equal(after.current.evidence.linked, 1);
    assert.ok(after.current.evidence.legacy >= 3);
    const id = await approvedSubmission(w);
    const ev = (await detail(w, id)).events.find((e) => e.type === 'approved');
    assert.equal(ev.binding.evidenceHash, after.workflow.binding.evidenceHash);
  } finally {
    await w.t.close();
  }
});

test('replacing governing evidence makes approvals stale and blocks new approvals until a manager repairs the link', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const id = await approvedSubmission(w);

    // drafting a replacement changes nothing
    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    assert.equal((await detail(w, id)).workflow.status, 'approved');

    // activating it replaces the governing version: the approval is no longer green anywhere
    const act = await approveVersion(w.manager, src.id, 2, FACT_SHEET_V2);
    assert.equal(act.status, 201);
    const d = await detail(w, id);
    assert.equal(d.workflow.status, 'approval_stale');
    assert.deepEqual(d.workflow.staleApproval.reasons, ['evidence']);
    assert.equal((await w.reviewer('GET', '/api/submissions')).json.submissions.find((s) => s.id === id).status, 'approval_stale');
    assert.equal(d.current.evidence.broken.length, 1);
    assert.equal(d.current.evidence.broken[0].state, 'superseded');
    assert.equal(d.current.findings.find((f) => f.ruleId === 'FCT-001').sourceEvidence.state, 'superseded');

    // a new review can be requested, but nobody can approve while evidence is broken
    const rr = await w.creator('POST', `/api/submissions/${id}/request-review`, { revision: 1, expected: d.workflow.binding });
    assert.equal(rr.status, 201, rr.text);
    const seen = await detail(w, id);
    assert.equal(seen.workflow.eligibility.approve.allowed, false);
    assert.match(seen.workflow.eligibility.approve.reasons.join(' '), /no longer in force/);
    const blocked = await w.reviewer('POST', `/api/submissions/${id}/approve`, { revision: 1, expected: seen.workflow.binding });
    assert.equal(blocked.status, 403);

    // repair: publishing with the OLD link is refused and says exactly what to fix
    const g = (await w.manager('GET', '/api/guidelines')).json;
    const same = structuredClone(g.guidelines);
    same.terms[0].reason += ' (edited)';
    const refused = await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: same });
    assert.equal(refused.status, 422);
    assert.match(refused.json.error.details.problems[0].message, /replaced by version 2/);
    // relink to the same passage in version 2, publish
    const fixed = structuredClone(g.guidelines);
    fixed.facts.find((f) => f.id === 'FCT-001').source = link(src.id, 2, FACT_SHEET_V2, BATTERY);
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, note: 'relink to v2', guidelines: fixed })).status, 201);
    const repaired = await detail(w, id);
    assert.equal(repaired.current.evidence.broken.length, 0);
    assert.deepEqual(repaired.workflow.staleApproval.reasons.sort(), ['evidence', 'guideline']);
    const ok = await w.reviewer('POST', `/api/submissions/${id}/approve`, { revision: 1, expected: repaired.workflow.binding });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.workflow.status, 'approved');
    assert.equal(ok.json.workflow.staleApproval, null);
  } finally {
    await w.t.close();
  }
});

test('withdrawing a source has the same effect; a new approved version restores it; unlinking to legacy is explicit', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const id = await approvedSubmission(w);
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1 })).status, 422, 'a reason is required');
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 5, note: 'x' })).json.error.code, 'stale_view');
    assert.equal((await w.reviewer('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'x' })).status, 403);
    const wd = await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'Retired by owner.' });
    assert.equal(wd.status, 201);
    assert.equal(wd.json.source.withdrawn, true);
    assert.equal(wd.json.source.activeVersion, null);
    assert.equal(wd.json.source.versions[0].state, 'withdrawn');
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'again' })).json.error.code, 'not_active');
    const d = await detail(w, id);
    assert.equal(d.workflow.status, 'approval_stale');
    assert.deepEqual(d.workflow.staleApproval.reasons, ['evidence']);
    assert.equal(d.current.evidence.broken[0].state, 'withdrawn');
    assert.equal(d.current.findings.find((f) => f.ruleId === 'FCT-001').sourceEvidence.state, 'withdrawn');
    // linking a withdrawn source is refused
    const g = (await w.manager('GET', '/api/guidelines')).json;
    const e = structuredClone(g.guidelines);
    e.terms[0].reason += ' (edited)';
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: e })).status, 422);
    // explicit unlink: the rule goes back to a typed (legacy) label and says so
    const legacy = structuredClone(g.guidelines);
    legacy.facts.find((f) => f.id === 'FCT-001').source = { doc: 'Typed again (fictional)', section: '1', quote: 'Battery life: up to 12 hours at medium brightness.' };
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: legacy })).status, 201);
    const after = await detail(w, id);
    assert.equal(after.current.evidence.broken.length, 0);
    assert.equal(after.current.findings.find((f) => f.ruleId === 'FCT-001').sourceEvidence.provenance, 'legacy');
    assert.equal(after.workflow.status, 'approval_stale', 'the old approval stays stale: the evidence it rested on is gone');
  } finally {
    await w.t.close();
  }
});

test('approvals recorded before source registration existed stay valid while there is no linked evidence, and go stale once there is', async () => {
  const w = await world();
  try {
    const sub = (await w.reviewer('GET', '/api/submissions/SUB-2')).json; // seeded approved submission
    assert.equal(sub.workflow.status, 'approved');
    // Simulate a workspace file written BEFORE this milestone: its approval bindings have no evidenceHash at all.
    await w.t.app.store.mutate((d) => {
      for (const e of d.submissions.find((s) => s.id === 'SUB-2').events) if (e.binding) delete e.binding.evidenceHash;
    });
    assert.equal((await w.reviewer('GET', '/api/submissions/SUB-2')).json.workflow.status, 'approved', 'no linked evidence: an old approval is still valid');
    await linkedBattery(w);
    assert.equal((await w.reviewer('GET', '/api/submissions/SUB-2')).json.workflow.status, 'approval_stale');
    assert.deepEqual((await w.reviewer('GET', '/api/submissions/SUB-2')).json.workflow.staleApproval.reasons.sort(), ['evidence', 'guideline']);
  } finally {
    await w.t.close();
  }
});

// ---------- races ----------

test('RACE: a source activation between a reviewer seeing a submission and deciding is refused (409) and records nothing', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const made = await w.creator('POST', '/api/submissions', batteryCopy());
    await w.creator('POST', `/api/submissions/${made.json.id}/request-review`, { revision: 1, expected: made.json.workflow.binding });
    const seen = await detail(w, made.json.id); // the reviewer's screen
    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    await approveVersion(w.manager, src.id, 2, FACT_SHEET_V2); // activation lands before the decision
    const r = await w.reviewer('POST', `/api/submissions/${made.json.id}/approve`, { revision: 1, expected: seen.workflow.binding });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_view');
    assert.ok(r.json.error.details.changed.includes('evidence'));
    assert.equal((await detail(w, made.json.id)).events.filter((e) => e.type === 'approved').length, 0);
    // omitting the evidence hash does not dodge the check once evidence is linked
    const omitted = { ...seen.workflow.binding };
    delete omitted.evidenceHash;
    assert.equal((await w.reviewer('POST', `/api/submissions/${made.json.id}/reject`, { revision: 1, expected: omitted, note: 'x' })).status, 409);
  } finally {
    await w.t.close();
  }
});

test('RACE: withdrawal during a request-review is refused the same way', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const made = await w.creator('POST', '/api/submissions', batteryCopy());
    await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'retired' });
    const r = await w.creator('POST', `/api/submissions/${made.json.id}/request-review`, { revision: 1, expected: made.json.workflow.binding });
    assert.equal(r.status, 409);
    assert.ok(r.json.error.details.changed.includes('evidence'));
  } finally {
    await w.t.close();
  }
});

test('RACE: concurrent approvals of one version, concurrent new versions and concurrent registrations stay consistent', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator);
    const two = await Promise.all([approveVersion(w.manager, src.id, 1, FACT_SHEET), approveVersion(w.manager, src.id, 1, FACT_SHEET)]);
    assert.deepEqual(two.map((r) => r.status).sort(), [201, 409]);
    const vs = await Promise.all(Array.from({ length: 6 }, (_, i) => w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: `${FACT_SHEET}\n\nVariant ${i}.` })));
    assert.equal(vs.filter((r) => r.status === 201).length, 1);
    assert.equal(vs.filter((r) => r.status === 409).length, 5);
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => w.creator('POST', '/api/sources', { title: `Parallel ${i}`, text: `Parallel source text number ${i}.` })));
    assert.ok(many.every((r) => r.status === 201));
    assert.equal(new Set(many.map((r) => r.json.source.id)).size, 12);
  } finally {
    await w.t.close();
  }
});

test('RACE: publishing a link while its version is being replaced can never leave a green approval on replaced evidence', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator);
    await approveVersion(w.manager, src.id, 1, FACT_SHEET);
    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    const g = (await w.manager('GET', '/api/guidelines')).json;
    const e = structuredClone(g.guidelines);
    e.facts.find((f) => f.id === 'FCT-001').source = link(src.id, 1, FACT_SHEET, BATTERY);
    const [pub, act] = await Promise.all([w.manager('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: e }), approveVersion(w.manager, src.id, 2, FACT_SHEET_V2)]);
    assert.equal(act.status, 201);
    const overview = (await w.reviewer('GET', '/api/sources')).json.evidence;
    if (pub.status === 201) assert.equal(overview.broken.length, 1, 'published first, then replaced: the broken link is visible and blocks approval');
    else assert.equal(pub.json.error.code, 'evidence_invalid', 'replaced first: the stale link was refused');
    assert.ok(pub.status === 201 || pub.status === 422);
  } finally {
    await w.t.close();
  }
});

/** Test double embedder with a gate, to hold inference open while the registry changes. */
function gatedEmbedder() {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let hold = false;
  return {
    calls,
    hold: () => (hold = true),
    release: () => release(),
    state: 'ready',
    error: null,
    runtime: 'test double',
    available: () => ({ ok: true }),
    start: async () => {},
    async embed(texts) {
      calls.push(texts);
      if (hold) await gate;
      return texts.map((t) => {
        const v = new Float32Array(32);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 32;
          v[h] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

test('RACE: a source activation DURING inference discards the matching result (409)', async () => {
  const emb = gatedEmbedder();
  const t = await startApp({ semantic: createSemantic({ embedder: emb }) });
  const w = { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer') };
  try {
    const { src } = await linkedBattery(w);
    const made = await w.creator('POST', '/api/submissions', batteryCopy());
    const d = made.json;
    emb.hold();
    const pending = t.call('POST', '/api/semantic/match', { body: { submissionId: d.id, revision: 1, passages: [{ start: 0, end: 20 }], expected: d.workflow.binding } });
    for (let i = 0; i < 400 && emb.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(emb.calls.length > 0, 'inference started');
    await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    await approveVersion(w.manager, src.id, 2, FACT_SHEET_V2);
    emb.release();
    const r = await pending;
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_result');
    assert.match(r.json.error.message, /approved sources changed|guidelines/);
  } finally {
    emb.release();
    await t.close();
  }
});

// ---------- contextual retrieval ----------

test('retrieval includes passages only from ACTIVE approved sources; relevance is labelled as relevance', async () => {
  const emb = gatedEmbedder();
  const t = await startApp({ semantic: createSemantic({ embedder: emb }) });
  const w = { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer') };
  try {
    const made = await w.creator('POST', '/api/submissions', batteryCopy());
    const ask = async (d) => (await t.call('POST', '/api/semantic/match', { body: { submissionId: d.id, revision: 1, passages: [{ start: 0, end: 20 }], expected: d.workflow.binding } })).json;
    const embeddedTexts = () => emb.calls.flat().join(' | ');

    const draft = await registerSource(w.creator, { text: 'DRAFTONLYMARKER wording that nobody approved yet.' });
    const rejected = await registerSource(w.creator, { title: 'Rej', text: 'REJECTEDMARKER wording a manager refused.' });
    await w.manager('POST', `/api/sources/${rejected.id}/versions/1/reject`, { note: 'no' });
    const active = await registerSource(w.creator, { title: 'Active doc', text: 'ACTIVEMARKER A full charge lasts up to 12 hours at medium brightness.' });
    await approveVersion(w.manager, active.id, 1, 'ACTIVEMARKER A full charge lasts up to 12 hours at medium brightness.');
    const out = await ask(made.json);
    const texts = embeddedTexts();
    assert.match(texts, /ACTIVEMARKER/);
    assert.doesNotMatch(texts, /DRAFTONLYMARKER|REJECTEDMARKER/);
    assert.match(out.retrievalNote, /ACTIVE approved registered sources/);
    assert.match(out.retrievalNote, /not truth or compliance/);
    const reg = out.results[0].matches.find((m) => m.registered);
    if (reg) assert.equal(reg.registered.sourceId, active.id);

    // a replacement draft is not retrieved; a withdrawn source disappears
    await w.creator('POST', `/api/sources/${active.id}/versions`, { baseVersion: 1, text: 'REPLACEMENTDRAFTMARKER different wording.' });
    emb.calls.length = 0;
    await ask((await detail(w, made.json.id)));
    assert.doesNotMatch(embeddedTexts(), /REPLACEMENTDRAFTMARKER/);
    await w.manager('POST', `/api/sources/${active.id}/withdraw`, { expectedActiveVersion: 1, note: 'retired' });
    emb.calls.length = 0;
    await ask((await detail(w, made.json.id)));
    assert.doesNotMatch(embeddedTexts(), /ACTIVEMARKER/, 'a withdrawn source is no longer a retrieval candidate');
    assert.ok(draft.id);
  } finally {
    await t.close();
  }
});

// ---------- persistence and compatibility ----------

test('persistence: sources, versions, events and links survive a restart; a workspace file with no registry still loads', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'data.json');
  let app = await createApp({ dataFile: file, semantic: null });
  let url = await app.listen(0);
  let phase = 'before the restart (first server)';
  try {
    const fresh = JSON.parse(await readFile(file, 'utf8'));
    assert.equal('sources' in fresh, false, 'an untouched workspace has no registry key (old files look the same)');
    // A failed request is reported with its cause, URL and phase (diagnostics only: no result changes, nothing is retried).
    const call = (method, p, body, role = 'manager') =>
      fetch(url + p, { method, headers: { 'content-type': 'application/json', 'x-demo-role': role }, body: body ? JSON.stringify(body) : undefined })
        .catch((e) => { throw describeFetchFailure(e, { method, url: url + p, phase, server: app.server }); })
        .then(async (r) => ({ status: r.status, json: await r.json() }));
    assert.deepEqual((await call('GET', '/api/sources')).json.sources, []);
    assert.equal((await call('POST', '/api/sources', { title: 'Persisted', text: FACT_SHEET })).status, 201);
    assert.equal((await call('POST', '/api/sources/SRC-1/versions/1/approve', { expectedSha256: sha(FACT_SHEET) })).status, 201);
    const g = (await call('GET', '/api/guidelines')).json;
    const e = structuredClone(g.guidelines);
    e.facts[0].source = link('SRC-1', 1, FACT_SHEET, BATTERY);
    assert.equal((await call('PUT', '/api/guidelines', { baseVersion: g.version, guidelines: e })).status, 201);
    const before = (await call('GET', '/api/sources/SRC-1')).json;

    await app.close();
    app = await createApp({ dataFile: file, semantic: null });
    url = await app.listen(0);
    phase = 'after the restart (second server, listening)';
    const after = (await call('GET', '/api/sources/SRC-1')).json;
    assert.deepEqual(after, before);
    assert.equal(after.citedBy.length, 1);
    assert.equal((await call('GET', '/api/sources/SRC-1/versions/1')).json.version.text, FACT_SHEET);
    assert.equal((await call('GET', '/api/guidelines')).json.guidelines.facts[0].source.sourceId, 'SRC-1');
    // ids keep counting from where they were
    assert.equal((await call('POST', '/api/sources', { title: 'Second', text: 'second source text' })).json.source.id, 'SRC-2');
  } finally {
    await app.close();
    await tmp.cleanup();
  }
});

test('expected-binding compatibility: clients that omit evidenceHash still work while no evidence is linked', async () => {
  const w = await world();
  try {
    const made = await w.creator('POST', '/api/submissions', batteryCopy());
    const { evidenceHash, ...old } = made.json.workflow.binding;
    assert.equal(evidenceHash, EMPTY_EVIDENCE_HASH);
    const rr = await w.creator('POST', `/api/submissions/${made.json.id}/request-review`, { revision: 1, expected: old });
    assert.equal(rr.status, 201, rr.text);
    assert.equal((await w.reviewer('POST', `/api/submissions/${made.json.id}/approve`, { revision: 1, expected: old })).status, 201);
  } finally {
    await w.t.close();
  }
});

test('source read routes return 404 for unknown ids/versions and never leak other data', async () => {
  const w = await world();
  try {
    assert.equal((await w.reviewer('GET', '/api/sources/SRC-404')).status, 404);
    await registerSource(w.creator);
    assert.equal((await w.reviewer('GET', '/api/sources/SRC-1/versions/7')).status, 404);
    assert.equal((await w.reviewer('GET', '/api/sources/SRC-1/versions/abc')).status, 404);
    assert.equal((await w.reviewer('GET', '/api/sources/..%2F..%2Fpackage.json')).status, 404);
  } finally {
    await w.t.close();
  }
});
