/**
 * Decision-time review receipts (m27).
 *
 * A decision (approve or reject) used to store only BINDINGS: hashes of the copy, image details, guideline version and evidence it covered. It did not store what
 * the reviewer was looking at, so "why was this approval reasonable then?" could not be answered. A receipt is the server's compact record of exactly that:
 * the findings the rules reported for the saved copy at the moment the decision was saved, their severities, the registered evidence they rested on, the checker
 * revision, and whether the warnings were acknowledged.
 *
 * What a receipt is NOT:
 *   - It is not supplied by the client. buildReceipt is called inside the successful decision transaction (service.decide) over the SAME evaluation that decided
 *     whether the decision was allowed; nothing in a request body reaches it.
 *   - It is not a compliance certificate, a legal review, a signature or a proof of who decided (in demo mode actors are role labels).
 *   - It is not the document: no full text, no image, no source full text. Findings carry a short quote and cited-passage coordinates, every string is capped, the
 *     number of findings and evidence entries is capped, and the whole receipt is held under RECEIPT_MAX_BYTES (counts always describe ALL findings).
 *   - It is never rewritten. Later guideline, source or checker changes do not touch it; they are shown beside it by compareReceipt, which is computed on read.
 * Decisions recorded before this existed have no receipt and are labelled unavailable. Nothing is reconstructed for them.
 */
import { CHECKER_REVISION } from './checks.js';

export const RECEIPT_FORMAT = 1;

export const RECEIPT_LIMITS = Object.freeze({
  findings: 16,
  evidenceEntries: 16,
  notChecked: 8,
  title: 120,
  explanation: 240,
  quote: 100,
  sourceQuote: 80,
  doc: 60,
  label: 40,
});

/** An upper bound on what one receipt adds to the workspace file (pretty-printed, as the store writes it, with the nesting indentation). The public demo reserves this much room before it accepts a decision. */
export const RECEIPT_MAX_BYTES = 32 * 1024;

const RANK_SEVERITY = { error: 0, warning: 1, info: 2 };
const RANK_STATUS = { contradicted: 0, violation: 1, needs_review: 2, unverified: 3, supported: 4 };
const SUMMARY_KEYS = ['error', 'warning', 'info', 'violation', 'contradicted', 'unverified', 'needs_review', 'supported'];

const cut = (s, n) => {
  if (s === null || s === undefined) return null;
  const t = String(s);
  if (t.length <= n) return t;
  let end = n - 1;
  if (end > 0 && t.charCodeAt(end - 1) >= 0xd800 && t.charCodeAt(end - 1) <= 0xdbff) end--; // never split a surrogate pair
  return `${t.slice(0, end)}…`;
};

/** The size the receipt would add to the workspace file: pretty-printed, plus about 12 bytes of nesting indentation on every line. */
export const receiptDiskBytes = (receipt) => {
  const pretty = JSON.stringify(receipt, null, 2);
  return Buffer.byteLength(pretty) + (pretty.split('\n').length - 1) * 12;
};

function sourceRef(f) {
  const ev = f.sourceEvidence;
  if (!f.source && !ev) return null;
  if (ev?.provenance === 'registered') return { provenance: 'registered', sourceId: ev.sourceId, version: ev.version, start: ev.start, end: ev.end, state: ev.state, doc: cut(f.source?.doc, RECEIPT_LIMITS.doc), quote: cut(f.source?.quote, RECEIPT_LIMITS.sourceQuote) };
  return { provenance: ev?.provenance ?? 'legacy', doc: cut(f.source?.doc, RECEIPT_LIMITS.doc), quote: cut(f.source?.quote, RECEIPT_LIMITS.sourceQuote) };
}

const rank = (f) => [RANK_SEVERITY[f.severity] ?? 3, RANK_STATUS[f.status] ?? 5];

/**
 * @param evaluation  what runChecks returned for the saved copy (findings already decorated with their source evidence), the very evaluation the gates used
 * @param evidence    evidenceFor(state): the registered-evidence manifest in force
 */
export function buildReceipt({ evaluation, evidence, acknowledgedWarnings, imageTextConfirmed }) {
  const all = evaluation.findings;
  const order = all.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f)[0] - rank(b.f)[0] || rank(a.f)[1] - rank(b.f)[1] || a.i - b.i);
  const kept = order.slice(0, RECEIPT_LIMITS.findings).map(({ f }) => ({
    key: f.id,
    ruleId: f.ruleId,
    ruleKind: f.ruleKind,
    field: f.field,
    status: f.status,
    severity: f.severity,
    title: cut(f.title, RECEIPT_LIMITS.title),
    explanation: cut(f.explanation, RECEIPT_LIMITS.explanation),
    quote: cut(f.quote, RECEIPT_LIMITS.quote),
    span: f.span ? { start: f.span.start, end: f.span.end } : null,
    source: sourceRef(f),
  }));
  const counts = {};
  for (const k of SUMMARY_KEYS) counts[k] = Number(evaluation.summary?.[k]) || 0;
  const receipt = {
    format: RECEIPT_FORMAT,
    kind: 'RECORDED_AT_DECISION',
    note: 'Written by the server when this decision was saved, from the rules\' own report on the saved copy, never from anything the browser sent. It records what was on screen: it is not a compliance certificate, a legal review or a signature, and it does not show that the copy is true or safe to publish. It is never changed afterwards; later changes are compared beside it.',
    checkerRevision: CHECKER_REVISION,
    engine: { mode: 'rules', note: 'Deterministic text, number, palette, contrast and alt-text rules. Contextual (generative) AI review was not part of this decision.' },
    acknowledgedWarnings: Boolean(acknowledgedWarnings),
    imageTextConfirmed: Boolean(imageTextConfirmed),
    counts,
    findings: kept,
    omittedFindings: all.length - kept.length,
    evidence: {
      linked: evidence.linked ?? 0,
      legacy: evidence.legacy ?? 0,
      entries: evidence.entries.slice(0, RECEIPT_LIMITS.evidenceEntries).map((e) => ({ entryId: e.entryId, label: cut(e.label, RECEIPT_LIMITS.label), sourceId: e.sourceId, version: e.version, start: e.start, end: e.end, textSha256: e.textSha256, state: e.state })),
      omittedEntries: Math.max(0, evidence.entries.length - RECEIPT_LIMITS.evidenceEntries),
    },
    notChecked: evaluation.notChecked.slice(0, RECEIPT_LIMITS.notChecked).map((n) => n.ruleId),
    omittedNotChecked: Math.max(0, evaluation.notChecked.length - RECEIPT_LIMITS.notChecked),
  };
  // The caps above already hold the receipt far below its limit for ordinary text. Non-ASCII text can take three bytes a character, so the limit itself is enforced:
  // drop the least important detail first, and say so.
  let trimmed = false;
  while (receiptDiskBytes(receipt) > RECEIPT_MAX_BYTES && receipt.findings.length) {
    trimmed = true;
    const loud = receipt.findings.findIndex((f) => f.status === 'supported' && (f.quote || f.source?.quote));
    if (loud >= 0) {
      receipt.findings[loud].quote = null;
      if (receipt.findings[loud].source) receipt.findings[loud].source.quote = null;
    } else {
      receipt.findings.pop();
      receipt.omittedFindings++;
    }
  }
  while (receiptDiskBytes(receipt) > RECEIPT_MAX_BYTES && receipt.evidence.entries.length) {
    trimmed = true;
    receipt.evidence.entries.pop();
    receipt.evidence.omittedEntries++;
  }
  if (trimmed) receipt.trimmed = true;
  return receipt;
}

const thenNow = (f) => (f ? { status: f.status, severity: f.severity, title: f.title } : null);

/**
 * Recorded-then versus recomputed-now, for ONE decision. Computed on read, never stored.
 * @param receipt  the stored receipt
 * @param now      { findings (decorated), summary, evidenceEntries, guidelineVersion, checkerRevision } for the exact revision the decision covered, computed today
 * @param context  { revision, headRevision, type, bindingDiffers (against the latest saved inputs), guidelineVersionThen }
 */
export function compareReceipt(receipt, now, { revision, headRevision, type, bindingDiffers, guidelineVersionThen }) {
  const partial = receipt.omittedFindings > 0;
  const thenByKey = new Map(receipt.findings.map((f) => [f.key, f]));
  const nowByKey = new Map(now.findings.map((f) => [f.id, f]));
  const changed = [];
  let unchanged = 0;
  for (const [key, was] of thenByKey) {
    const is = nowByKey.get(key);
    if (!is) changed.push({ key, ruleId: was.ruleId, field: was.field, kind: 'cleared', then: thenNow(was), now: null });
    else if (is.status !== was.status || is.severity !== was.severity) changed.push({ key, ruleId: was.ruleId, field: was.field, kind: 'changed', then: thenNow(was), now: thenNow(is) });
    else unchanged++;
  }
  // A finding that is new today can only be called new when the receipt kept every finding it saw.
  if (!partial) for (const [key, is] of nowByKey) if (!thenByKey.has(key)) changed.push({ key, ruleId: is.ruleId, field: is.field, kind: 'new', then: null, now: thenNow(is) });
  const sev = (c) => RANK_SEVERITY[(c.now ?? c.then).severity] ?? 3;
  changed.sort((a, b) => sev(a) - sev(b));
  const nowEntries = new Map(now.evidenceEntries.map((e) => [e.entryId, e]));
  const evChanged = [];
  let evSame = 0;
  for (const was of receipt.evidence.entries) {
    const is = nowEntries.get(was.entryId);
    const sameRef = is && is.sourceId === was.sourceId && is.version === was.version && is.start === was.start && is.end === was.end;
    if (is && sameRef && is.state === was.state) evSame++;
    else evChanged.push({ entryId: was.entryId, then: was.state, now: is ? (sameRef ? is.state : `relinked to ${is.sourceId} v${is.version} (${is.state})`) : 'no longer linked', thenSource: `${was.sourceId} v${was.version}`, nowSource: is ? `${is.sourceId} v${is.version}` : null });
  }
  const counts = {};
  for (const k of SUMMARY_KEYS) counts[k] = Number(now.summary?.[k]) || 0;
  return {
    basis: `Recomputed now: today's rules (guidelines v${now.guidelineVersion}) and today's registered evidence, applied to exactly the revision ${revision} text this decision covered. The recorded side is what was stored then; neither is a verdict on the copy.`,
    revision,
    headRevision,
    checker: { then: receipt.checkerRevision, now: now.checkerRevision, same: receipt.checkerRevision === now.checkerRevision },
    guidelines: { then: guidelineVersionThen, now: now.guidelineVersion },
    counts: { then: receipt.counts, now: counts },
    findings: { changed, unchanged, partial },
    evidence: { changed: evChanged, unchanged: evSame, omittedThen: receipt.evidence.omittedEntries },
    bindingDiffers,
    appliesNow: type === 'approved' ? revision === headRevision && bindingDiffers.length === 0 : null,
  };
}
