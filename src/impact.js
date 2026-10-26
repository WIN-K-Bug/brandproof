/**
 * Source change-impact preview: what activating a pending source version, or withdrawing an active source, would change.
 *
 * A preview is a PURE, READ-ONLY calculation on a committed snapshot. It never writes, never creates a proposed guideline
 * version and never touches the registry: the change is simulated on shallow copies and the existing evidence manifest and
 * workflow derivation are run against that simulation, so the numbers are the ones the real change would produce.
 *
 * Three different things are reported and must not be confused:
 *  (a) exact dependencies: rules and facts of the CURRENT guidelines that cite this source, and whether each quote
 *      survives in the proposed text (exact textual continuity only; equal words are not equal meaning);
 *  (b) campaign finding references: findings on each campaign's current revision that cite one of those rules;
 *  (c) workflow consequences: approvals are bound to the WHOLE guideline + evidence set, so when the evidence hash changes
 *      EVERY approved campaign becomes "Re-review required", whether or not any of its findings cite this source.
 *
 * Nothing here infers that a changed passage contradicts a claim, repairs a link, or approves anything.
 */
import { HttpError, canonical, sha256 } from './util.js';
import { SOURCE_LIMITS, findSource, versionState, linkedEntries, evidenceManifest, retrievalSources } from './sources.js';
import { currentVersion, evaluate, deriveWorkflow, contentHash, assetHash, guidelineHash, evidenceFor } from './service.js';

const need = (cond, status, code, msg, details) => {
  if (!cond) throw new HttpError(status, code, msg, details);
};

const PREVIEW_VERSION = 1;
const MAX_OCCURRENCES = 50;
const MAX_LISTED = 200;
const LINE_CAP = 12;
const LINE_TEXT_CAP = 300;

// ---------- exact textual continuity ----------

/** Where `quote` occurs in `text` (overlaps included), as start offsets; stops counting after MAX_OCCURRENCES. */
function occurrences(text, quote) {
  const at = [];
  for (let i = text.indexOf(quote); i !== -1 && at.length < MAX_OCCURRENCES; i = text.indexOf(quote, i + 1)) at.push(i);
  return at;
}

/**
 * Conservative continuity of a linked passage against a proposed text. Only exact text counts:
 *  unchanged: the same words at the same offsets;  moved: exactly one occurrence elsewhere;
 *  ambiguous: several occurrences and none at the original offsets;  absent: no occurrence;
 *  not_comparable: too short or blank to match on.
 * A match never relinks anything, and equal words are not equal meaning.
 */
export function classifyPassage(quote, start, end, newText) {
  if (typeof quote !== 'string' || quote.trim().length < SOURCE_LIMITS.quoteMin) return { kind: 'not_comparable', occurrences: 0 };
  const at = occurrences(newText, quote);
  if (newText.slice(start, end) === quote) return { kind: 'unchanged', occurrences: at.length, newStart: start, newEnd: end, repeated: at.length > 1 };
  if (at.length === 0) return { kind: 'absent', occurrences: 0 };
  if (at.length === 1) return { kind: 'moved', occurrences: 1, newStart: at[0], newEnd: at[0] + quote.length };
  return { kind: 'ambiguous', occurrences: at.length, atLeast: at.length >= MAX_OCCURRENCES, positions: at.slice(0, 5) };
}

function lines(text) {
  const out = [];
  let pos = 0;
  for (const t of text.split('\n')) {
    if (t.trim()) out.push({ text: t, start: pos, end: pos + t.length });
    pos += t.length + 1;
  }
  return out;
}

/** Lines present in one text and not the other (multiset), with offsets so each can be opened highlighted. */
export function lineChanges(oldText, newText) {
  const left = lines(oldText);
  const right = lines(newText);
  const counts = new Map();
  for (const l of right) counts.set(l.text, (counts.get(l.text) ?? 0) + 1);
  const removed = [];
  for (const l of left) {
    const c = counts.get(l.text) ?? 0;
    if (c > 0) counts.set(l.text, c - 1);
    else removed.push(l);
  }
  const back = new Map();
  for (const l of left) back.set(l.text, (back.get(l.text) ?? 0) + 1);
  const added = [];
  for (const l of right) {
    const c = back.get(l.text) ?? 0;
    if (c > 0) back.set(l.text, c - 1);
    else added.push(l);
  }
  const trim = (l) => ({ text: l.text.length > LINE_TEXT_CAP ? `${l.text.slice(0, LINE_TEXT_CAP)}…` : l.text, start: l.start, end: l.end });
  return { removedCount: removed.length, addedCount: added.length, removed: removed.slice(0, LINE_CAP).map(trim), added: added.slice(0, LINE_CAP).map(trim), truncated: removed.length > LINE_CAP || added.length > LINE_CAP };
}

const NEXT_STEP = {
  unchanged: 'The same words are at the same place. A manager still has to link this rule to the new version in the Brand library and publish; nothing is relinked automatically, and equal words do not prove the surrounding meaning is unchanged.',
  moved: 'The exact words occur once, at the position shown. A manager still has to relink and publish; nothing is relinked automatically, and equal words do not prove the meaning is unchanged.',
  ambiguous: 'The exact words occur several times in the new text. A manager must choose the passage by hand in the Brand library; nothing is guessed.',
  absent: 'These exact words are not in the new text. A manager has to decide whether the rule still holds, then relink to a new passage, edit the rule, or unlink it. This preview does not say whether the rule is now wrong.',
  not_comparable: 'The cited passage is too short to match on. A manager has to relink it by hand.',
  withdrawn: 'The rule stops having registered evidence. A manager can relink it to another active source or unlink it (it then shows as legacy).',
};

// ---------- simulation ----------

/** Shallow copy of the registry in which the proposed change has happened. The committed state is not touched. */
function simulate(state, src, action, candidate) {
  const sim = { ...src };
  if (action === 'activate') {
    sim.versions = src.versions.map((v) => (v.n === candidate.n ? { ...v, status: 'approved' } : v));
    sim.activeVersion = candidate.n;
    sim.withdrawnAt = null;
  } else {
    sim.activeVersion = null;
    sim.withdrawnAt = '(preview)';
  }
  return { sources: (state.sources ?? []).map((s) => (s.id === src.id ? sim : s)), guidelineVersions: state.guidelineVersions };
}

const decisionEvents = new Set(['review_requested', 'approved', 'rejected']);

/** Everything about the campaigns that a preview depends on (a stale preview is one where any of this has moved). */
function campaignFingerprint(state) {
  return state.submissions.map((sub) => {
    const h = sub.revisions.at(-1);
    const last = sub.events.filter((e) => decisionEvents.has(e.type)).at(-1);
    return { id: sub.id, head: h.n, content: contentHash(h.text), asset: assetHash(h.asset), lastDecision: last ? last.id : null };
  });
}

/**
 * previewSourceChange(state, { sourceId, action: 'activate' | 'withdraw', version?, actor? }) -> preview
 * `state` is read-only (committed state, or the draft inside a mutation when the write re-checks the digest).
 */
export function previewSourceChange(state, { sourceId, action, version, actor = null }) {
  need(action === 'activate' || action === 'withdraw', 422, 'validation_failed', 'action must be "activate" or "withdraw".', { fields: [{ path: 'action', message: 'must be activate or withdraw' }] });
  const src = findSource(state, sourceId);
  need(src, 404, 'not_found', `No source ${sourceId}.`);
  const active = src.activeVersion != null ? src.versions.find((v) => v.n === src.activeVersion) : null;

  let candidate = null;
  if (action === 'activate') {
    need(Number.isInteger(version) && version >= 1, 422, 'validation_failed', 'version must be a whole number.', { fields: [{ path: 'version', message: 'must be a whole number' }] });
    candidate = src.versions.find((v) => v.n === version);
    need(candidate, 404, 'not_found', `Source ${src.id} has no version ${version}.`);
    need(candidate.status === 'pending', 409, 'not_pending', `Version ${version} is ${versionState(src, candidate)}; only a pending version can be activated.`);
  } else {
    need(active, 409, 'not_active', 'This source has no active version to withdraw.');
  }

  const guidelineVersion = currentVersion(state);
  const guidelines = guidelineVersion.guidelines;
  const gHash = guidelineHash(guidelines);
  const nowEvidence = evidenceFor(state);
  const sim = simulate(state, src, action, candidate);
  const proposedEvidence = evidenceManifest(sim, guidelines);
  const evidenceChanges = proposedEvidence.hash !== nowEvidence.hash;
  const proposedText = candidate?.text ?? null;

  // (a) exact dependencies of the current guidelines on THIS source
  const all = linkedEntries(guidelines);
  const mine = all.filter((e) => e.linked && e.source.sourceId === src.id);
  const dependencies = mine.map((e) => {
    const s = e.source;
    const linkedVersion = src.versions.find((v) => v.n === s.version);
    const cut = linkedVersion ? linkedVersion.text.slice(s.start, s.end) : null;
    const quote = cut ?? s.quote;
    const before = versionState(src, linkedVersion ?? { status: 'approved', n: s.version });
    const afterSim = sim.sources.find((x) => x.id === src.id);
    const simV = afterSim.versions.find((v) => v.n === s.version);
    const after = simV ? versionState(afterSim, simV) : 'missing';
    let continuity;
    if (action === 'withdraw') continuity = { kind: 'withdrawn' };
    else continuity = classifyPassage(quote, s.start, s.end, proposedText);
    return {
      entryId: e.id,
      label: e.label,
      list: e.list,
      link: { version: s.version, start: s.start, end: s.end },
      quote,
      stateNow: before,
      stateAfter: after,
      continuity,
      proposedPassage: continuity.newStart != null ? { start: continuity.newStart, end: continuity.newEnd, text: proposedText.slice(continuity.newStart, continuity.newEnd) } : null,
      nextStep: NEXT_STEP[continuity.kind],
    };
  });
  const depIds = new Set(dependencies.map((d) => d.entryId));

  // (b) + (c) every campaign, derived with the real engine against the current and the proposed evidence
  const referenced = [];
  const workflow = [];
  const counts = { total: state.submissions.length, approvedNewlyStale: 0, alreadyStale: 0, inReviewViewChanges: 0, inReviewBlocked: 0, draftsWithReferences: 0, unaffected: 0 };
  for (const sub of state.submissions) {
    const h = sub.revisions.at(-1);
    const ev = evaluate(h, guidelineVersion);
    const refs = ev.findings.filter((f) => depIds.has(f.ruleId));
    const now = deriveWorkflow(sub, guidelineVersion, ev, null, null, nowEvidence);
    const next = deriveWorkflow(sub, guidelineVersion, ev, null, null, proposedEvidence);
    if (refs.length) {
      referenced.push({
        submissionId: sub.id,
        title: sub.title,
        revision: h.n,
        status: now.status,
        findings: refs.map((f) => ({ ruleId: f.ruleId, status: f.status, quote: f.quote ?? null, field: f.field })),
      });
    }
    let effect = null;
    if (now.status === 'approved' && next.status === 'approval_stale') {
      effect = 'approved_becomes_stale';
      counts.approvedNewlyStale++;
    } else if (now.status === 'approval_stale') {
      effect = 'already_stale';
      counts.alreadyStale++;
    } else if (now.status === 'in_review' && evidenceChanges) {
      effect = 'review_view_changes';
      counts.inReviewViewChanges++;
      if (proposedEvidence.broken.length) counts.inReviewBlocked++;
    } else if ((now.status === 'draft' || now.status === 'rejected') && refs.length) {
      effect = 'draft_with_references';
      counts.draftsWithReferences++;
    } else counts.unaffected++;
    if (effect && workflow.length < MAX_LISTED) {
      workflow.push({ submissionId: sub.id, title: sub.title, revision: h.n, before: now.status, after: next.status, effect, reasonsAfter: next.staleApproval?.reasons ?? [], referencesBySource: refs.length });
    }
  }

  const otherLinked = all.filter((e) => e.linked && e.source.sourceId !== src.id).length;
  const legacy = all.filter((e) => !e.linked).length;

  const approvalGate =
    action === 'activate'
      ? (() => {
          const reasons = [];
          if (actor?.id && candidate.createdBy.id === actor.id) reasons.push('You registered this version, so a different person must approve it.');
          return { allowed: reasons.length === 0, reasons };
        })()
      : { allowed: true, reasons: [] };

  const retrieval = { passagesNow: retrievalSources(state).items.length, passagesAfter: retrievalSources(sim).items.length };
  const direction = action === 'withdraw' ? 'withdraw' : !active ? 'first' : candidate.n > active.n ? 'replaces_older' : 'replaces_newer';

  const baseline = {
    guidelineVersion: guidelineVersion.version,
    guidelineHash: gHash,
    evidenceHash: nowEvidence.hash,
    activeVersion: active?.n ?? null,
    activeSha256: active?.textSha256 ?? null,
    candidateVersion: candidate?.n ?? null,
    candidateSha256: candidate?.textSha256 ?? null,
  };
  const digest = sha256(canonical({ v: PREVIEW_VERSION, action, sourceId: src.id, baseline, proposedEvidenceHash: proposedEvidence.hash, campaigns: campaignFingerprint(state) }));

  return {
    previewVersion: PREVIEW_VERSION,
    action,
    direction,
    digest,
    readOnly: true,
    source: { id: src.id, title: src.title },
    baseline,
    proposed: { activeVersion: action === 'activate' ? candidate.n : null, evidenceHash: proposedEvidence.hash, evidenceChanges, brokenLinks: proposedEvidence.broken.length, linked: proposedEvidence.linked },
    versions: { active: active ? { n: active.n, chars: active.chars, textSha256: active.textSha256 } : null, candidate: candidate ? { n: candidate.n, chars: candidate.chars, textSha256: candidate.textSha256, registeredBy: candidate.createdBy, registeredAt: candidate.createdAt, note: candidate.note } : null },
    textChange: active && candidate ? lineChanges(active.text, candidate.text) : null,
    dependencies,
    coverage: { entries: all.length, citingThisSource: mine.length, citingOtherSources: otherLinked, legacy },
    campaigns: { references: referenced, counts, workflow, listTruncated: workflow.length >= MAX_LISTED },
    retrieval,
    approvalGate,
    notes: [
      'This preview is read-only: nothing was saved, approved, relinked or rewritten.',
      'Approvals are bound to the whole guideline and evidence set, so every approved campaign becomes Re-review required when the evidence hash changes, including campaigns with no finding that cites this source.',
      'Exact-text continuity is not a judgement about meaning. A changed passage is not shown as proof that a claim is wrong.',
      'Legacy rules (typed sources) are not linked to any registered document, so this preview cannot say whether they rest on this source.',
    ],
  };
}

/** Throws 409 stale_preview when the caller's preview no longer describes the state the write would act on. */
export function assertPreviewCurrent(state, { sourceId, action, version, actor, previewDigest }) {
  const now = previewSourceChange(state, { sourceId, action, version, actor });
  need(now.digest === previewDigest, 409, 'stale_preview', 'The impact preview you read is out of date: the source, the guidelines or a campaign changed since you loaded it. Reload the preview and read it again before continuing.', { reason: 'preview_changed' });
}
