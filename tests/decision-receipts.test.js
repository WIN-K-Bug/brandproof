// Decision-time review receipts (m27, src/receipt.js).
// An approval or rejection used to store only BINDINGS (hashes of what it covered), never the findings the person was looking at, so the dossier had to say the
// findings "were NOT stored". These tests prove the new record: the SERVER computes a compact receipt from the very evaluation that gated the decision and stores it
// inside the same successful transaction; nothing the client sends can shape it; a failed decision leaves nothing behind; a receipt is never rewritten by later changes
// (it is compared with today's recomputation instead); a decision recorded before receipts existed is shown as unavailable, never reconstructed; and growth is bounded.
// Everything is fictional and synthetic.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createJudgeDemo } from '../src/judge.js';
import { CHECKER_REVISION } from '../src/checks.js';
import { buildReceipt, receiptDiskBytes, RECEIPT_LIMITS, RECEIPT_MAX_BYTES } from '../src/receipt.js';
import { startApp, cleanContent, tempDir } from './helpers.js';
import { startAuthApp } from './auth-helpers.js';
import { FACT_SHEET, demoAs, authAs, registerSource, approveVersion, link, publishWithLink } from './sources-helpers.js';

// Every test has a bound: one that stops making progress fails BY NAME after 60 s instead of silently stalling the run.
const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';
const SHEET_8H = FACT_SHEET.replace('up to 12 hours', 'up to 8 hours');
const BATTERY_8H = 'A full charge lasts up to 8 hours at medium brightness.';
const COPY_12H = 'A full charge lasts up to 12 hours.';
const COPY_8H = 'A full charge lasts up to 8 hours.';
const COPY_WARN = 'A full charge lasts up to 12 hours! Wow!'; // two exclamation marks: a warning that needs acknowledgement, no blocking finding
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function world() {
  const t = await startApp({ appOptions: { clock: () => '2026-10-24T12:00:00.000Z' } });
  return { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer'), file: path.join(t.dir, 'data.json') };
}

async function linkedBattery(w) {
  const src = await registerSource(w.creator);
  assert.equal((await approveVersion(w.manager, src.id, 1, FACT_SHEET)).status, 201);
  const { res } = await publishWithLink(w.manager, 'FCT-001', link(src.id, 1, FACT_SHEET, BATTERY));
  assert.equal(res.status, 201, res.text);
  return src;
}

const make = async (w, text, title = 'Battery claim') => {
  const r = await w.creator('POST', '/api/submissions', { title, text, asset: cleanContent().asset });
  assert.equal(r.status, 201, r.text);
  return r.json;
};
const view = async (api, id) => (await api('GET', `/api/submissions/${id}`)).json;
const askReview = async (w, id) => {
  const d = await view(w.creator, id);
  const r = await w.creator('POST', `/api/submissions/${id}/request-review`, { revision: d.headRevision, expected: d.workflow.binding });
  assert.equal(r.status, 201, r.text);
};
/** What the reviewer is looking at, then the decision, exactly as the browser sends it. */
const decideNow = async (w, id, action = 'approve', extra = {}) => {
  const seen = await view(w.reviewer, id);
  const r = await w.reviewer('POST', `/api/submissions/${id}/${action}`, { revision: seen.headRevision, expected: seen.workflow.binding, ...(action === 'reject' ? { note: 'No.' } : {}), ...extra });
  return { seen, r };
};
const decisions = (d) => d.events.filter((e) => e.type === 'approved' || e.type === 'rejected');
const fileHash = async (f) => sha(await fs.readFile(f));
const brief = (f) => ({ ruleId: f.ruleId, field: f.field, status: f.status, severity: f.severity, title: f.title, explanation: f.explanation });

test('the receipt is the server\'s own record of what the reviewer was looking at: findings, counts, evidence, checker revision, warnings acknowledged', async () => {
  const w = await world();
  try {
    await linkedBattery(w);
    const made = await make(w, COPY_WARN);
    await askReview(w, made.id);
    const dossierBefore = (await w.reviewer('GET', `/api/submissions/${made.id}/dossier`)).json;
    const { seen, r } = await decideNow(w, made.id, 'approve', { acknowledgeWarnings: true });
    assert.equal(r.status, 201, r.text);
    assert.ok(seen.current.summary.warning >= 1, 'the fixture really has a warning to acknowledge');
    const ev = decisions(r.json).at(-1);
    assert.equal(ev.type, 'approved');
    const rc = ev.receipt;
    assert.ok(rc, 'the approval carries a receipt');
    assert.equal(rc.format, 1);
    assert.equal(rc.checkerRevision, CHECKER_REVISION);
    assert.equal(rc.engine.mode, 'rules');
    assert.match(rc.engine.note, /deterministic|rules/i);
    assert.equal(rc.acknowledgedWarnings, true);
    assert.equal(rc.counts.warning, seen.current.summary.warning);
    assert.equal(rc.counts.error, 0);
    assert.equal(rc.counts.supported, seen.current.summary.supported);
    // the same findings the reviewer's own view listed a moment before (computed by a separate request), nothing added and nothing missing
    const want = seen.current.findings.map(brief).sort((a, b) => (a.ruleId + a.field).localeCompare(b.ruleId + b.field));
    const got = rc.findings.map(brief).sort((a, b) => (a.ruleId + a.field).localeCompare(b.ruleId + b.field));
    assert.deepEqual(got, want);
    assert.equal(rc.omittedFindings, 0);
    // registered evidence: the entry, the source version and its state at that moment (taken from an independent dossier read before the decision)
    assert.deepEqual(rc.evidence.entries.map((e) => [e.entryId, e.sourceId, e.version, e.start, e.end, e.textSha256, e.state]), dossierBefore.evidence.entries.map((e) => [e.entryId, e.sourceId, e.version, e.start, e.end, e.textSha256, e.state]));
    const fct = rc.findings.find((f) => f.ruleId === 'FCT-001');
    assert.equal(fct.source.provenance, 'registered');
    assert.equal(fct.source.sourceId, rc.evidence.entries[0].sourceId);
    assert.equal(fct.source.state, 'active');
    // it states what it is NOT
    assert.match(rc.note, /not a (compliance|certificate)|does not certify|not a certificate/i);
    assert.equal(rc.semanticMatching, undefined, 'optional model matching is a separate, relevance-only feature and is never part of what an approval saw');
    // rejected decisions get one too, with the note the reviewer gave, and an earlier review request does not
    const second = await make(w, 'A full charge lasts up to 12 hours.', 'Second');
    await askReview(w, second.id);
    const rej = await decideNow(w, second.id, 'reject');
    assert.equal(rej.r.status, 201, rej.r.text);
    const evs = rej.r.json.events;
    assert.ok(evs.find((e) => e.type === 'rejected').receipt, 'a rejection records what it saw too');
    assert.equal(evs.find((e) => e.type === 'review_requested').receipt, undefined, 'only human decisions carry a receipt');
  } finally {
    await w.t.close();
  }
});

test('a decision that fails leaves nothing behind: no receipt, no event, not one byte of the data file changes', async () => {
  const w = await world();
  try {
    await linkedBattery(w);
    const made = await make(w, COPY_WARN);
    // not yet in review
    let before = await fileHash(w.file);
    let r = (await decideNow(w, made.id, 'approve', { acknowledgeWarnings: true })).r;
    assert.equal(r.status, 403, 'approval needs a requested review');
    assert.equal(await fileHash(w.file), before);
    await askReview(w, made.id);
    before = await fileHash(w.file);
    // missing acknowledgement of the warning
    r = (await decideNow(w, made.id, 'approve')).r;
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'acknowledgement_required');
    // a role that may not decide
    const seen = await view(w.creator, made.id);
    r = await w.creator('POST', `/api/submissions/${made.id}/approve`, { revision: seen.headRevision, expected: seen.workflow.binding, acknowledgeWarnings: true });
    assert.equal(r.status, 403);
    // the reviewer looked at an out-of-date view
    r = await w.reviewer('POST', `/api/submissions/${made.id}/approve`, { revision: seen.headRevision, expected: { ...seen.workflow.binding, contentHash: '0'.repeat(64) }, acknowledgeWarnings: true });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_view');
    // a rejection with no note
    r = await w.reviewer('POST', `/api/submissions/${made.id}/reject`, { revision: seen.headRevision, expected: seen.workflow.binding });
    assert.equal(r.status, 422);
    assert.equal(await fileHash(w.file), before, 'nothing was written by any refused decision');
    assert.deepEqual(decisions(await view(w.reviewer, made.id)), []);

    // blocking findings forbid approval
    const bad = await make(w, 'A full charge lasts up to 12 hours. Fully waterproof!', 'Blocked');
    await askReview(w, bad.id);
    before = await fileHash(w.file);
    r = (await decideNow(w, bad.id, 'approve', { acknowledgeWarnings: true })).r;
    assert.equal(r.status, 403);
    assert.equal(await fileHash(w.file), before);
    assert.deepEqual(decisions(await view(w.reviewer, bad.id)), []);
  } finally {
    await w.t.close();
  }
});

test('nothing the client sends can shape a receipt: injected receipts, findings and verdicts are ignored, and no route can edit a stored one', async () => {
  const w = await world();
  try {
    await linkedBattery(w);
    const made = await make(w, COPY_12H);
    await askReview(w, made.id);
    const inject = { format: 1, checkerRevision: 'INJECTED-REVISION', counts: { error: 0, warning: 0, supported: 99 }, findings: [{ ruleId: 'INJECTED-VERDICT', status: 'supported', severity: 'info', title: 'INJECTED-VERDICT' }], note: 'INJECTED-VERDICT' };
    const seen = await view(w.reviewer, made.id);
    const r = await w.reviewer('POST', `/api/submissions/${made.id}/approve`, { revision: seen.headRevision, receipt: inject, findings: inject.findings, verdict: 'INJECTED-VERDICT', expected: { ...seen.workflow.binding, findings: inject.findings, receipt: inject } });
    assert.equal(r.status, 201, r.text);
    assert.ok(!r.text.includes('INJECTED'), 'not one injected value is stored or echoed');
    const rc = decisions(r.json).at(-1).receipt;
    assert.equal(rc.checkerRevision, CHECKER_REVISION);
    assert.ok(rc.findings.length > 0 && rc.findings.every((f) => f.ruleId !== 'INJECTED-VERDICT'));
    assert.ok(!(await fs.readFile(w.file, 'utf8')).includes('INJECTED'), 'and nothing injected reached the data file');
    // there is no way to write to an event afterwards
    const evId = decisions(r.json).at(-1).id;
    const before = await fileHash(w.file);
    for (const [m, p] of [['PUT', `/api/submissions/${made.id}/events/${evId}`], ['PATCH', `/api/submissions/${made.id}/events/${evId}`], ['POST', `/api/submissions/${made.id}/events`], ['DELETE', `/api/submissions/${made.id}/events/${evId}`], ['POST', `/api/submissions/${made.id}/receipt`], ['PUT', `/api/submissions/${made.id}`]]) {
      const x = await w.manager(m, p, { receipt: inject, type: 'approved' });
      assert.ok([404, 405].includes(x.status), `${m} ${p} must not exist (got ${x.status})`);
    }
    assert.equal(await fileHash(w.file), before);
    // a second approval attempt on the same revision is refused and does not touch the first receipt
    const again = await w.reviewer('POST', `/api/submissions/${made.id}/approve`, { revision: seen.headRevision, expected: seen.workflow.binding });
    assert.ok(again.status >= 400);
    assert.deepEqual(decisions(await view(w.reviewer, made.id)).at(-1).receipt, rc);
  } finally {
    await w.t.close();
  }
});

test('a later source, guideline or content change never rewrites a receipt: it survives, reloads from disk and a restart, and is compared with today instead', async () => {
  const w = await world();
  let app2;
  try {
    const src = await linkedBattery(w);
    const made = await make(w, COPY_12H);
    await askReview(w, made.id);
    assert.equal((await decideNow(w, made.id)).r.status, 201);
    const first = decisions(await view(w.reviewer, made.id))[0];
    const stored = structuredClone(first.receipt);

    // the source changes: version 2 says 8 hours and is approved (the registered passage the fact cites is now superseded)
    assert.equal((await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: SHEET_8H, origin: 'paste' })).status, 201);
    assert.equal((await approveVersion(w.manager, src.id, 2, SHEET_8H)).status, 201);
    // the guidelines change too (a new published version of everything)
    const g = (await w.manager('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    const fct = edited.facts.find((f) => f.id === 'FCT-001');
    fct.value = 8;
    fct.statement = BATTERY_8H;
    fct.source = link(src.id, 2, SHEET_8H, BATTERY_8H);
    const pub = await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, note: 'battery is 8 hours, relinked to version 2', guidelines: edited });
    assert.equal(pub.status, 201, pub.text);

    const after = await view(w.reviewer, made.id);
    const ev = decisions(after)[0];
    assert.deepEqual(ev.receipt, stored, 'the recorded receipt is byte-for-byte what was stored then');
    assert.equal(after.workflow.status, 'approval_stale');
    assert.equal(ev.receiptStatus, 'recorded');
    // ...while the comparison with today's recomputation is a separate, labelled computation
    const cmp = ev.receiptComparison;
    assert.ok(cmp, 'a comparison is offered');
    assert.match(cmp.basis, /recomputed now/i);
    assert.equal(cmp.revision, 1);
    assert.ok(cmp.bindingDiffers.includes('evidence') && cmp.bindingDiffers.includes('guideline'));
    assert.equal(cmp.appliesNow, false);
    assert.ok(cmp.findings.changed.some((c) => c.ruleId === 'FCT-001' && c.then?.status === 'supported' && c.now?.status === 'contradicted'), JSON.stringify(cmp.findings));
    assert.ok(cmp.evidence.changed.some((c) => c.entryId === 'FCT-001' && c.then === 'active' && c.now !== 'active'), JSON.stringify(cmp.evidence));
    assert.equal(cmp.guidelines.then, 2);
    assert.ok(cmp.guidelines.now > 2);

    // the dossier shows the same recorded receipt and the same comparison
    const dz = (await w.reviewer('GET', `/api/submissions/${made.id}/dossier`)).json;
    const dev = dz.recordedEvents.events.find((e) => e.type === 'approved');
    assert.deepEqual(dev.receipt, stored);
    assert.equal(dev.receiptStatus, 'recorded');
    assert.deepEqual(dev.receiptComparison.findings, cmp.findings);

    // it is on disk, and survives a restart
    assert.deepEqual(JSON.parse(await fs.readFile(w.file, 'utf8')).submissions.find((s) => s.id === made.id).events.find((e) => e.type === 'approved').receipt, stored);
    await w.t.app.close();
    app2 = await createApp({ dataFile: w.file, semantic: null, clock: () => '2026-10-25T12:00:00.000Z' });
    const url = await app2.listen(0);
    const res = await fetch(`${url}/api/submissions/${made.id}`, { headers: { 'x-demo-role': 'reviewer' } });
    assert.deepEqual(decisions(await res.json())[0].receipt, stored);
  } finally {
    await app2?.close();
    await w.t.close().catch(() => {});
  }
});

test('a decision recorded before receipts existed is shown as unavailable: no receipt is invented, and the comparison is not offered', async () => {
  const w = await world();
  let app2;
  try {
    await linkedBattery(w);
    const made = await make(w, COPY_12H);
    await askReview(w, made.id);
    assert.equal((await decideNow(w, made.id)).r.status, 201);
    await w.t.app.close();
    // simulate an older workspace: the same file as an earlier version wrote it, with no receipt on the decision
    const data = JSON.parse(await fs.readFile(w.file, 'utf8'));
    for (const s of data.submissions) for (const e of s.events) delete e.receipt;
    await fs.writeFile(w.file, JSON.stringify(data, null, 2));
    app2 = await createApp({ dataFile: w.file, semantic: null, clock: () => '2026-10-25T12:00:00.000Z' });
    const url = await app2.listen(0);
    const get = async (p) => (await (await fetch(url + p, { headers: { 'x-demo-role': 'reviewer' } })).json());
    const d = await get(`/api/submissions/${made.id}`);
    const ev = decisions(d)[0];
    assert.equal(ev.receipt, undefined);
    assert.equal(ev.receiptStatus, 'unavailable');
    assert.equal(ev.receiptComparison ?? null, null);
    assert.match(ev.receiptNote, /before decision-time receipts existed/i);
    assert.match(ev.receiptNote, /not (stored|reconstructed)|cannot be reconstructed/i);
    const dz = await get(`/api/submissions/${made.id}/dossier`);
    const dev = dz.recordedEvents.events.find((e) => e.type === 'approved');
    assert.equal(dev.receiptStatus, 'unavailable');
    assert.equal(dev.receipt, undefined);
    assert.match(dz.recordedEvents.note, /NOT stored and are not reconstructed/);
    assert.equal(dz.recordedEvents.receipts.recorded, 0);
    assert.equal(dz.recordedEvents.receipts.unavailable, 1);
    // the bindings that WERE stored still compare, as before
    assert.equal(dev.bindingComparedWithCurrentInputs.matches, true);
  } finally {
    await app2?.close();
    await w.t.close().catch(() => {});
  }
});

test('a receipt is bounded: findings, evidence and every string are capped, the counts stay complete, and the most serious findings are the ones kept', () => {
  const findings = [];
  for (let i = 0; i < 400; i++) {
    findings.push({
      id: `TRM-${i}|text|${i}-${i + 3}`,
      ruleId: `TRM-${String(i).padStart(3, '0')}`,
      ruleKind: 'term',
      field: 'text',
      status: i === 399 ? 'contradicted' : i % 3 ? 'supported' : 'violation',
      severity: i === 399 ? 'error' : i % 3 ? 'info' : 'warning',
      title: `T${i} ${'t'.repeat(5000)}`,
      explanation: `E${i} ${'e'.repeat(5000)}`,
      span: { start: i, end: i + 3 },
      quote: `Q${i} ${'q'.repeat(5000)}`,
      source: { doc: 'D'.repeat(5000), section: 'S'.repeat(5000), quote: 'R'.repeat(5000), sourceId: 'SRC-1', version: 1, start: 0, end: 40 },
      sourceEvidence: { provenance: 'registered', sourceId: 'SRC-1', version: 1, start: 0, end: 40, state: 'active' },
    });
  }
  const entries = Array.from({ length: 300 }, (_, i) => ({ entryId: `FCT-${i}`, label: 'L'.repeat(3000), sourceId: 'SRC-1', version: 1, start: 0, end: 40, textSha256: 'a'.repeat(64), state: 'active' }));
  const summary = { error: 1, warning: 133, info: 266, violation: 133, contradicted: 1, unverified: 0, needs_review: 0, supported: 266 };
  const rc = buildReceipt({ evaluation: { findings, notChecked: Array.from({ length: 200 }, (_, i) => ({ ruleId: `N-${i}`, reason: 'r'.repeat(3000) })), summary }, evidence: { entries, linked: 300, legacy: 0 }, acknowledgedWarnings: true, imageTextConfirmed: false });
  const bytes = Buffer.byteLength(JSON.stringify(rc));
  assert.ok(bytes <= RECEIPT_MAX_BYTES, `receipt is ${bytes} bytes, limit ${RECEIPT_MAX_BYTES}`);
  assert.ok(RECEIPT_MAX_BYTES <= 32 * 1024, 'the limit itself is small');
  assert.ok(receiptDiskBytes(rc) <= RECEIPT_MAX_BYTES, 'and so is what it adds to the workspace file, pretty-printed and indented as the store writes it');
  assert.equal(rc.findings.length, RECEIPT_LIMITS.findings);
  assert.equal(rc.omittedFindings, 400 - RECEIPT_LIMITS.findings, 'what was left out is counted, not hidden');
  assert.equal(rc.counts.warning, 133, 'counts describe ALL findings, not just the kept ones');
  assert.equal(rc.counts.error, 1);
  assert.equal(rc.findings[0].ruleId, 'TRM-399', 'the blocking finding is kept first even though it came last');
  assert.ok(rc.findings.every((f) => f.title.length <= RECEIPT_LIMITS.title + 1 && f.explanation.length <= RECEIPT_LIMITS.explanation + 1));
  assert.equal(rc.evidence.entries.length, RECEIPT_LIMITS.evidenceEntries);
  assert.equal(rc.evidence.omittedEntries, 300 - RECEIPT_LIMITS.evidenceEntries);
  assert.equal(rc.evidence.linked, 300);
  assert.ok(rc.notChecked.length <= RECEIPT_LIMITS.notChecked);
  // a copy of the whole document or of a source's full text is never what is stored
  assert.ok(!JSON.stringify(rc).includes('t'.repeat(RECEIPT_LIMITS.title + 50)));
});

test('hostile text in the copy, a source and a note is stored as plain data and returned as data', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator, { title: '<img src=x onerror=alert(1)> sheet', text: `${FACT_SHEET}\n\n<script>alert("src")</script> Care. Wipe with a dry cloth.` });
    assert.equal((await approveVersion(w.manager, src.id, 1, `${FACT_SHEET}\n\n<script>alert("src")</script> Care. Wipe with a dry cloth.`)).status, 201);
    const hostile = '<img src=x onerror=alert(1)> A full charge lasts up to 12 hours. </td></tr><script>alert(2)</script> `${1+1}` {{7*7}}';
    const made = await make(w, hostile, '<b>"quoted"</b> title');
    await askReview(w, made.id);
    const { r } = await decideNow(w, made.id, 'approve', { note: '<svg onload=alert(3)> reviewed' });
    assert.equal(r.status, 201, r.text);
    const rc = decisions(r.json).at(-1).receipt;
    assert.ok(rc.findings.some((f) => /<img src=x onerror=alert\(1\)>/.test(f.quote ?? '') || /12 hours/.test(f.quote ?? '')), 'quotes are kept verbatim as text');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(rc)));
    const dz = (await w.reviewer('GET', `/api/submissions/${made.id}/dossier`)).json;
    assert.deepEqual(dz.recordedEvents.events.find((e) => e.type === 'approved').receipt, rc);
    assert.match(dz.recordedEvents.events.find((e) => e.type === 'approved').note, /<svg onload=alert\(3\)>/, 'the note is data, not markup');
  } finally {
    await w.t.close();
  }
});

test('end to end: approved at 12 hours, the source moves to 8 hours, the old receipt is compared with today, the repair is re-approved, and two different receipts persist in the dossier', async () => {
  const w = await world();
  try {
    const src = await linkedBattery(w);
    const made = await make(w, COPY_12H);
    await askReview(w, made.id);
    assert.equal((await decideNow(w, made.id)).r.status, 201);
    const first = structuredClone(decisions(await view(w.reviewer, made.id))[0].receipt);
    assert.equal(first.findings.find((f) => f.ruleId === 'FCT-001').status, 'supported');

    // the source says 8 hours from now on; the old approval stops applying
    assert.equal((await w.creator('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: SHEET_8H, origin: 'paste' })).status, 201);
    assert.equal((await approveVersion(w.manager, src.id, 2, SHEET_8H)).status, 201);
    let d = await view(w.reviewer, made.id);
    assert.equal(d.workflow.status, 'approval_stale');
    assert.deepEqual(d.workflow.staleApproval.reasons, ['evidence']);
    const oldCmp = decisions(d)[0].receiptComparison;
    assert.equal(oldCmp.appliesNow, false);
    assert.deepEqual(oldCmp.bindingDiffers, ['evidence']);
    assert.ok(oldCmp.evidence.changed.some((c) => c.entryId === 'FCT-001' && c.then === 'active' && c.now === 'superseded'));
    assert.deepEqual(decisions(d)[0].receipt, first, 'the original receipt is untouched by the source change');

    // repair: relink the fact to version 2 (and its value), then correct the copy and ask again
    const { res } = await publishWithLink(w.manager, 'FCT-001', link(src.id, 2, SHEET_8H, BATTERY_8H));
    assert.equal(res.status, 201, res.text);
    const g = (await w.manager('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    const fct = edited.facts.find((f) => f.id === 'FCT-001');
    fct.value = 8;
    fct.statement = BATTERY_8H;
    assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, note: 'battery is 8 hours', guidelines: edited })).status, 201);
    d = await view(w.creator, made.id);
    const rev = await w.creator('POST', `/api/submissions/${made.id}/revisions`, { baseRevision: d.headRevision, text: COPY_8H, asset: d.revisions.at(-1).asset });
    assert.equal(rev.status, 201, rev.text);
    await askReview(w, made.id);
    const second = await decideNow(w, made.id);
    assert.equal(second.r.status, 201, second.r.text);

    d = await view(w.reviewer, made.id);
    const [a, b] = decisions(d);
    assert.equal(d.workflow.status, 'approved');
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.receipt, first, 'the first receipt is still exactly what was recorded');
    assert.notDeepEqual(a.receipt, b.receipt);
    assert.equal(b.receipt.findings.find((f) => f.ruleId === 'FCT-001').status, 'supported');
    assert.equal(b.receipt.findings.find((f) => f.ruleId === 'FCT-001').source.version, 2, 'the second approval rested on version 2 of the source');
    assert.equal(a.receipt.findings.find((f) => f.ruleId === 'FCT-001').source.version, 1);
    assert.ok(b.receipt.evidence.entries.every((e) => e.version === 2));
    assert.equal(a.receiptComparison.revision, 1);
    assert.equal(a.receipt.acknowledgedWarnings, false, 'no warning was on screen, so none was acknowledged: the flag is not simply "true"');
    assert.equal(b.receipt.acknowledgedWarnings, false);
    // today's rules applied to exactly the 12-hour copy that was approved: it now contradicts the 8-hour fact (not judged on the latest, corrected copy)
    assert.ok(a.receiptComparison.findings.changed.some((c) => c.ruleId === 'FCT-001' && c.then.status === 'supported' && c.now.status === 'contradicted' && c.now.severity === 'error'), JSON.stringify(a.receiptComparison.findings));
    assert.ok(a.receiptComparison.counts.now.error >= 1 && b.receiptComparison.counts.now.error === 0);
    assert.equal(a.receiptComparison.appliesNow, false, 'the first approval covered revision 1, which is no longer the latest');
    assert.equal(b.receiptComparison.appliesNow, true);
    assert.deepEqual(b.receiptComparison.bindingDiffers, []);
    assert.deepEqual(b.receiptComparison.findings.changed, [], 'what the second reviewer saw is what today\'s rules say');

    const dz = (await w.reviewer('GET', `/api/submissions/${made.id}/dossier`)).json;
    const [da, db] = dz.recordedEvents.events.filter((e) => e.type === 'approved');
    assert.deepEqual(da.receipt, a.receipt);
    assert.deepEqual(db.receipt, b.receipt);
    assert.deepEqual(da.receiptComparison, a.receiptComparison);
    assert.equal(dz.recordedEvents.receipts.recorded, 2);
    assert.equal(dz.recordedEvents.receipts.unavailable, 0);
    assert.equal(dz.formatVersion, 3, 'additive: every earlier field of the dossier is unchanged');
    assert.equal(dz.recordedEvents.receipts.formatVersion, 1);
    assert.match(dz.limitations.join(' '), /receipt/i);
  } finally {
    await w.t.close();
  }
});

test('authenticated mode: the receipt is recorded for the signed-in decider by id, a contributor\'s refused self-approval leaves nothing, and no secret or username is in it', async () => {
  const t = await startAuthApp();
  try {
    const creator = authAs(await t.as('creator'));
    const manager = authAs(await t.as('manager'));
    const made = (await creator('POST', '/api/submissions', { title: 'Auth receipts', text: COPY_WARN, asset: cleanContent().asset })).json;
    const req = await creator('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding });
    assert.equal(req.status, 201, req.text);
    const seen = (await creator('GET', `/api/submissions/${made.id}`)).json;
    const before = await fs.readFile(t.files.dataFile);
    const self = await creator('POST', `/api/submissions/${made.id}/approve`, { revision: 1, expected: seen.workflow.binding, acknowledgeWarnings: true });
    assert.equal(self.status, 403);
    assert.ok(before.equals(await fs.readFile(t.files.dataFile)), 'a refused self-approval writes nothing');
    const ok = await manager('POST', `/api/submissions/${made.id}/approve`, { revision: 1, expected: seen.workflow.binding, acknowledgeWarnings: true });
    assert.equal(ok.status, 201, ok.text);
    const ev = decisions(ok.json).at(-1);
    assert.equal(ev.actor.id, t.ids.manager);
    assert.equal(ev.receipt.acknowledgedWarnings, true);
    assert.ok(ev.receipt.counts.warning >= 1);
    assert.ok(!/syn-|password|csrf|cookie|token|scrypt/i.test(JSON.stringify(ev.receipt)), 'no account name or credential material in a receipt');
    // reading is for signed-in people only
    const anon = await t.client().call('GET', `/api/submissions/${made.id}`);
    assert.equal(anon.status, 401);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- the public judge demo

async function startJudge(t, opts = {}) {
  const tmp = await tempDir();
  const demo = await createJudgeDemo({ root: path.join(tmp.dir, 'demo-root'), semantic: null, ocr: null, ...opts });
  const base = await demo.listen(0);
  t.after(async () => {
    await demo.close().catch(() => {});
    await tmp.cleanup();
  });
  const visitor = () => {
    const v = { cookie: null };
    v.call = async (method, p, { role, body } = {}) => {
      const h = {};
      if (v.cookie) h.cookie = v.cookie;
      if (role) h['x-demo-role'] = role;
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
      const sc = res.headers.getSetCookie?.()[0];
      if (sc) v.cookie = sc.split(';')[0];
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text };
    };
    v.as = (role) => (method, p, body) => v.call(method, p, { role, body });
    return v;
  };
  return { demo, base, root: path.join(tmp.dir, 'demo-root'), visitor };
}

test('public demo: each visitor\'s receipts stay inside that visitor\'s own session, and nobody can read or shape another\'s', async (t) => {
  const j = await startJudge(t);
  const a = j.visitor();
  const b = j.visitor();
  await a.call('GET', '/');
  await b.call('GET', '/');
  const MARK = 'ZEBRA-MARKER-VISITOR-A';
  const made = await a.as('creator')('POST', '/api/submissions', { title: `${MARK} title`, text: `A full charge lasts up to 12 hours. ${MARK}`, asset: cleanContent().asset });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  assert.equal((await a.as('creator')('POST', `/api/submissions/${id}/request-review`, { revision: 1, expected: made.json.workflow.binding })).status, 201);
  const seen = (await a.as('reviewer')('GET', `/api/submissions/${id}`)).json;
  const done = await a.as('reviewer')('POST', `/api/submissions/${id}/approve`, { revision: 1, expected: seen.workflow.binding, acknowledgeWarnings: true, receipt: { findings: [{ ruleId: 'INJECTED-VERDICT' }] } });
  assert.equal(done.status, 201, done.text);
  assert.ok(decisions(done.json).at(-1).receipt.findings.length > 0);
  assert.ok(!done.text.includes('INJECTED-VERDICT'));

  // visitor B reads everything it can reach: nothing of A's, in any list, detail or dossier
  const list = (await b.as('reviewer')('GET', '/api/submissions')).json;
  const everything = [JSON.stringify(list)];
  for (const s of list.submissions ?? list) {
    everything.push((await b.as('reviewer')('GET', `/api/submissions/${s.id}`)).text);
    everything.push((await b.as('reviewer')('GET', `/api/submissions/${s.id}/dossier`)).text);
  }
  everything.push((await b.as('reviewer')('GET', `/api/submissions/${id}`)).text, (await b.as('reviewer')('GET', `/api/submissions/${id}/dossier`)).text);
  for (const text of everything) assert.ok(!text.includes(MARK), 'a visitor\'s marker never appears in another visitor\'s responses');

  // B decides on its own campaign: its receipt is its own
  const bm = await b.as('creator')('POST', '/api/submissions', { title: 'B campaign', text: 'A full charge lasts up to 12 hours.', asset: cleanContent().asset });
  assert.equal((await b.as('creator')('POST', `/api/submissions/${bm.json.id}/request-review`, { revision: 1, expected: bm.json.workflow.binding })).status, 201);
  const bs = (await b.as('reviewer')('GET', `/api/submissions/${bm.json.id}`)).json;
  const bd = await b.as('reviewer')('POST', `/api/submissions/${bm.json.id}/approve`, { revision: 1, expected: bs.workflow.binding, acknowledgeWarnings: true });
  assert.equal(bd.status, 201, bd.text);
  assert.ok(!JSON.stringify(decisions(bd.json).at(-1).receipt).includes(MARK));
});

test('public demo: a decision reserves room for its receipt, so a session at its storage cap is refused with the usual message and nothing is written', async (t) => {
  const j = await startJudge(t, { limits: { sessionKiB: 64 } });
  const a = j.visitor();
  await a.call('GET', '/');
  const one = await a.as('creator')('POST', '/api/submissions', { title: 'to decide', text: 'A full charge lasts up to 12 hours.', asset: cleanContent().asset });
  assert.equal(one.status, 201, one.text);
  assert.equal((await a.as('creator')('POST', `/api/submissions/${one.json.id}/request-review`, { revision: 1, expected: one.json.workflow.binding })).status, 201);
  const long = 'A full charge lasts up to 12 hours. '.repeat(130);
  let refused = null;
  for (let i = 0; i < 20 && !refused; i++) {
    const r = await a.as('creator')('POST', '/api/submissions', { title: `bulk ${i}`, text: long, asset: cleanContent().asset });
    if (r.status === 413) refused = r;
    else assert.equal(r.status, 201, r.text);
  }
  assert.ok(refused, 'the session reaches its cap');
  const ws = path.join(j.root, 'sessions');
  const files = async () => {
    const out = [];
    for (const dir of await fs.readdir(ws)) out.push(sha(await fs.readFile(path.join(ws, dir, 'workspace.json'))));
    return out;
  };
  const before = await files();
  const seen = (await a.as('reviewer')('GET', `/api/submissions/${one.json.id}`)).json;
  const r = await a.as('reviewer')('POST', `/api/submissions/${one.json.id}/approve`, { revision: 1, expected: seen.workflow.binding, acknowledgeWarnings: true });
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json.error.code, 'session_full');
  assert.deepEqual(await files(), before, 'refused before any write');
  assert.equal((await a.as('reviewer')('GET', `/api/submissions/${one.json.id}`)).status, 200, 'reads still work');
  // Reset starts again, and a decision then works
  const reset = await fetch(`${j.base}/api/judge/reset`, { method: 'POST', headers: { cookie: a.cookie, origin: j.base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(reset.status, 200);
});

test('the size limit holds for multi-byte text too: three-byte characters trim detail and say so, instead of passing the limit', () => {
  const wide = (c, n) => c.repeat(n);
  const findings = Array.from({ length: 40 }, (_, i) => ({
    id: `X-${i}`, ruleId: `X-${String(i).padStart(3, '0')}`, ruleKind: 'term', field: 'text', status: 'supported', severity: 'info',
    title: wide('語', 500), explanation: wide('語', 900), span: { start: i, end: i + 1 }, quote: wide('😀', 400),
    source: { doc: wide('語', 200), quote: wide('語', 300) }, sourceEvidence: { provenance: 'registered', sourceId: 'SRC-1', version: 1, start: 0, end: 9, state: 'active' },
  }));
  const entries = Array.from({ length: 50 }, (_, i) => ({ entryId: `FCT-${i}`, label: wide('語', 300), sourceId: 'SRC-1', version: 1, start: 0, end: 9, textSha256: 'b'.repeat(64), state: 'active' }));
  const rc = buildReceipt({ evaluation: { findings, notChecked: [], summary: { supported: 40, info: 40 } }, evidence: { entries, linked: 50, legacy: 0 }, acknowledgedWarnings: false, imageTextConfirmed: false });
  assert.ok(receiptDiskBytes(rc) <= RECEIPT_MAX_BYTES, `${receiptDiskBytes(rc)} bytes`);
  assert.equal(rc.findings.length + rc.omittedFindings, 40, 'every finding is either listed or counted as left out');
  assert.equal(rc.counts.supported, 40);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(rc)), 'no character was cut in half');
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(JSON.stringify(rc)) && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(JSON.stringify(rc)), 'no lone surrogate from truncating an emoji');
});
