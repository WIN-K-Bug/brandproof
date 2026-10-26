/**
 * Domain logic: guideline versions, submissions, revisions, comments, review workflow.
 * Mutating functions take a draft state (inside Store.mutate) and throw HttpError on rule breaks.
 * Read functions take committed state. Approval eligibility is always derived here, on the server.
 */
import { HttpError, canonical, sha256 } from './util.js';
import { runChecks, splitSentences } from './checks.js';
import { describeEngine } from './ai.js';
import { diffText } from './diff.js';
import { assignIds, highestIds } from './validate.js';
import { retainedEntry, describeImage } from './assets.js';
import { normaliseDraftText } from './ocr.js';
import { EMPTY_EVIDENCE_HASH, evidenceManifest, resolveEvidence, decorateFindings, registry, listSources, sourceSummary, versionState } from './sources.js';

/** Effective source evidence of the CURRENT guideline version: what each linked rule rests on and whether it is in force. */
export const evidenceFor = (state) => evidenceManifest(state, currentVersion(state).guidelines);
export const NO_EVIDENCE = Object.freeze({ hash: EMPTY_EVIDENCE_HASH, entries: [], broken: [], linked: 0, legacy: 0 });

export const ROLES = Object.freeze({
  creator: { label: 'Creator', actor: 'Demo Creator' },
  manager: { label: 'Manager', actor: 'Demo Manager' },
  reviewer: { label: 'Reviewer', actor: 'Demo Reviewer' },
});

export const STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  rejected: 'Rejected',
  approval_stale: 'Re-review required',
};

// Demo mode: the actor is just a role label. Authenticated mode passes a real actor { id, name, role }.
const actorOf = (role, actor) => (actor ? { id: actor.id, name: actor.name, role: actor.role } : { role, name: ROLES[role].actor });

// ---------- hashing / binding ----------

export const guidelineHash = (g) => sha256(canonical(g));
export const contentHash = (text) => sha256(canonical({ text }));
export const assetHash = (a) =>
  sha256(
    canonical({
      name: a.name,
      alt: a.alt,
      fileSha256: a.fileSha256,
      fg: a.fg,
      bg: a.bg,
      textSize: a.textSize,
      colors: [...a.colors].sort(),
      // Only present for a retained image, so assets without one hash exactly as before this feature existed.
      ...(a.retainedSha256 ? { retainedSha256: a.retainedSha256 } : {}),
    }),
  );

export const currentVersion = (state) => state.guidelineVersions.at(-1);

/** SHA-256 of the confirmed transcription AND the exact retained-image digest it was confirmed against. */
export const imageTextHash = (it) => sha256(canonical({ text: it.text, imageSha256: it.imageSha256 }));

export function bindingFor(rev, version, evidenceHash = EMPTY_EVIDENCE_HASH) {
  return {
    contentHash: contentHash(rev.text),
    assetHash: assetHash(rev.asset),
    guidelineHash: guidelineHash(version.guidelines),
    guidelineVersion: version.version,
    evidenceHash,
    // Present only when a person has confirmed a transcription, so every earlier binding hashes and compares exactly as before.
    ...(rev.imageText ? { imageTextHash: imageTextHash(rev.imageText) } : {}),
  };
}

export const evaluate = (rev, version) => runChecks({ text: rev.text, asset: rev.asset, imageText: rev.imageText?.text }, version.guidelines);

// ---------- guidelines ----------

export function publishGuidelines(d, { baseVersion, guidelines, note, role, actor, now }) {
  if (role !== 'manager') {
    throw new HttpError(403, 'forbidden', 'Only the Manager demo role can publish guideline versions.');
  }
  const cur = currentVersion(d);
  if (baseVersion !== cur.version) {
    throw new HttpError(409, 'version_conflict', `Guidelines changed: you edited version ${baseVersion} but version ${cur.version} is current. Reload and re-apply your edit.`, {
      currentVersion: cur.version,
    });
  }
  const reserved = {};
  for (const v of d.guidelineVersions) {
    for (const [k, n] of Object.entries(highestIds(v.guidelines))) reserved[k] = Math.max(reserved[k] || 0, n);
  }
  try {
    assignIds(guidelines, reserved);
  } catch (e) {
    if (e.duplicateId) throw new HttpError(422, 'validation_failed', `Duplicate id ${e.duplicateId}.`);
    throw e;
  }
  // Registered evidence: only the ACTIVE approved version of a source can be linked, and the quote/span are re-cut from
  // the registry text here. Typed (legacy) sources pass through untouched and stay legacy.
  resolveEvidence(d, guidelines);
  const hash = guidelineHash(guidelines);
  if (hash === cur.hash) throw new HttpError(422, 'no_change', 'These guidelines are identical to the current version; nothing to publish.');
  const version = { version: cur.version + 1, createdAt: now, createdBy: actor ? `${actor.name} (${actor.id})` : `${ROLES[role].actor} (demo role)`, note, hash, guidelines };
  d.guidelineVersions.push(version);
  return version;
}

function entryMap(list) {
  return new Map(list.map((e) => [e.id, canonical(e)]));
}

export function diffGuidelines(a, b) {
  const out = {};
  const lists = { terms: [a.terms, b.terms], facts: [a.facts, b.facts], colors: [a.palette.colors, b.palette.colors] };
  for (const [k, [x, y]] of Object.entries(lists)) {
    const mx = entryMap(x);
    const my = entryMap(y);
    out[k] = {
      added: [...my.keys()].filter((id) => !mx.has(id)),
      removed: [...mx.keys()].filter((id) => !my.has(id)),
      changed: [...my.keys()].filter((id) => mx.has(id) && mx.get(id) !== my.get(id)),
    };
  }
  const settings = ['claims', 'style', 'accessibility', 'altText', 'brand'];
  out.settingsChanged = settings.filter((k) => canonical(a[k]) !== canonical(b[k]));
  if (canonical({ ...a.palette, colors: 0 }) !== canonical({ ...b.palette, colors: 0 })) out.settingsChanged.push('palette');
  return out;
}

export function versionSummary(v, prev) {
  return {
    version: v.version,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    note: v.note,
    hash: v.hash,
    counts: { terms: v.guidelines.terms.length, facts: v.guidelines.facts.length, colors: v.guidelines.palette.colors.length },
    changes: prev ? diffGuidelines(prev.guidelines, v.guidelines) : null,
  };
}

// ---------- submissions ----------

const need = (cond, status, code, msg, details) => {
  if (!cond) throw new HttpError(status, code, msg, details);
};

const findSub = (state, id) => {
  const s = state.submissions.find((x) => x.id === id);
  need(s, 404, 'not_found', `No submission ${id}.`);
  return s;
};

const head = (sub) => sub.revisions.at(-1);

/** An image reference is only accepted if it resolves to bytes this workspace retains. Never trust the client's reference. */
function assertRetained(d, asset) {
  if (!asset.retainedSha256) return;
  const e = retainedEntry(d, asset.retainedSha256);
  need(e, 422, 'asset_unretained', 'The image reference does not match any image retained in this workspace. Upload the image again.', { fields: [{ path: 'asset.retainedSha256', message: 'is not a retained image' }] });
}

/**
 * The transcription stored with a revision. Everything about it is decided HERE, on the server:
 *  - a person's confirmation (input.confirmed === true) makes a new record: the text they confirmed, bound to the digest of the
 *    image THIS revision retains, attributed to the signed-in actor, with honest provenance;
 *  - an OCR draft only counts as a source if it is still held AND was made for this very image (else 409: a late or stale
 *    result can never attach to another image); an unknown draft id (expired, server restarted) is recorded as typed;
 *  - with no new confirmation, the previous one carries forward ONLY for the identical image, otherwise there is none.
 * "Confirmed" means a person saved this as their transcription of the image. It is never evidence that the OCR was right.
 */
function resolveImageText(prev, { input, draft, asset, role, actor, now, n }) {
  const sha = asset.retainedSha256 ?? null;
  if (input) {
    need(sha, 422, 'no_retained_image', 'Text can only be transcribed from an image retained in this workspace. Attach a PNG first.', { fields: [{ path: 'imageText', message: 'needs a retained image' }] });
    need(input.confirmed === true, 422, 'confirmation_required', 'Confirm that you compared the text with the image before saving it.', { fields: [{ path: 'imageText.confirmed', message: 'must be confirmed by a person' }] });
    if (draft) need(draft.imageSha256 === sha, 409, 'ocr_draft_stale', 'That automatic reading was made for a different image, so it cannot be attached here. Read the text from this image again.', { draftImage: draft.imageSha256, currentImage: sha });
    const text = input.text.replace(/\r\n?/g, '\n').trim();
    return {
      text,
      imageSha256: sha,
      confirmedBy: actorOf(role, actor),
      confirmedAt: now,
      confirmedInRevision: n,
      provenance: draft
        ? { kind: 'ocr-draft', edited: sha256Text(text) !== sha256Text(normaliseDraftText(draft.text)), draft: { id: draft.draftId, textSha256: draft.textSha256, confidence: draft.confidence, engine: draft.engine } }
        : { kind: 'typed', edited: null, ...(input.draftId ? { draftUnavailable: true } : {}) },
    };
  }
  if (prev?.imageText && sha && prev.imageText.imageSha256 === sha) return { ...prev.imageText, carriedFromRevision: prev.n };
  return undefined;
}
const sha256Text = (t) => sha256(t);

function makeRevision(sub, version, { text, asset, imageText, role, actor, now }) {
  return {
    n: (sub.revisions.at(-1)?.n ?? 0) + 1,
    createdAt: now,
    author: actorOf(role, actor),
    text,
    asset,
    ...(imageText ? { imageText } : {}),
    guidelineVersion: version.version,
    guidelineHash: guidelineHash(version.guidelines),
  };
}

export function createSubmission(d, { title, text, asset, imageText: imageTextInput, draft = null, role, actor, now }) {
  need(['creator', 'manager'].includes(role), 403, 'forbidden', 'Only Creator or Manager demo roles can create submissions.');
  assertRetained(d, asset);
  const sub = {
    id: `SUB-${++d.seq.submission}`,
    title,
    createdAt: now,
    createdBy: actorOf(role, actor),
    revisions: [],
    comments: [],
    events: [],
  };
  const imageText = resolveImageText(null, { input: imageTextInput, draft, asset, role, actor, now, n: 1 });
  sub.revisions.push(makeRevision(sub, currentVersion(d), { text, asset, imageText, role, actor, now }));
  d.submissions.push(sub);
  return sub;
}

export function addRevision(d, { id, baseRevision, text, asset, imageText: imageTextInput, draft = null, role, actor, now }) {
  need(['creator', 'manager'].includes(role), 403, 'forbidden', 'Only Creator or Manager demo roles can save revisions.');
  const sub = findSub(d, id);
  assertRetained(d, asset);
  const h = head(sub);
  need(baseRevision === h.n, 409, 'revision_conflict', `Someone saved revision ${h.n} while you were editing revision ${baseRevision}. Reload to see it; your text was not saved.`, {
    currentRevision: h.n,
  });
  const imageText = resolveImageText(h, { input: imageTextInput, draft, asset, role, actor, now, n: h.n + 1 });
  const itKey = (it) => (it ? imageTextHash(it) : null);
  need(contentHash(text) !== contentHash(h.text) || assetHash(asset) !== assetHash(h.asset) || itKey(imageText) !== itKey(h.imageText), 422, 'no_change', 'Nothing changed since the latest revision.');
  const rev = makeRevision(sub, currentVersion(d), { text, asset, imageText, role, actor, now });
  sub.revisions.push(rev);
  return rev;
}

export function addComment(d, { id, revision, text, ruleId, role, actor, now }) {
  const sub = findSub(d, id);
  need(revision >= 1 && revision <= head(sub).n, 422, 'validation_failed', `Revision ${revision} does not exist.`);
  const c = { id: `C-${++d.seq.comment}`, revision, author: actorOf(role, actor), text, ruleId, createdAt: now };
  sub.comments.push(c);
  return c;
}

// ---------- workflow ----------

const REASONS = {
  noRole: 'Choose a demo role first.',
};

export function bindingDiff(bound, now) {
  const reasons = [];
  if (bound.contentHash !== now.contentHash) reasons.push('content');
  if (bound.assetHash !== now.assetHash) reasons.push('asset');
  // Approvals recorded before image text existed have no imageTextHash: they were bound to "no confirmed transcription".
  if ((bound.imageTextHash ?? null) !== (now.imageTextHash ?? null)) reasons.push('imagetext');
  if (bound.guidelineHash !== now.guidelineHash) reasons.push('guideline');
  // Approvals recorded before source registration existed have no evidenceHash: they were bound to "no registered evidence".
  if ((bound.evidenceHash ?? EMPTY_EVIDENCE_HASH) !== now.evidenceHash) reasons.push('evidence');
  return reasons;
}

/** Everything the UI needs to know about where a submission stands and what this role may do. */
export function deriveWorkflow(sub, version, evaluation, role, viewer = null, evidence = NO_EVIDENCE) {
  const h = head(sub);
  const binding = bindingFor(h, version, evidence.hash);
  const decisions = sub.events.filter((e) => ['review_requested', 'approved', 'rejected'].includes(e.type));
  const last = decisions.filter((e) => e.revision === h.n).at(-1);

  let status = 'draft';
  let staleApproval = null;
  if (last?.type === 'approved') {
    const reasons = bindingDiff(last.binding, binding);
    if (reasons.length) {
      status = 'approval_stale';
      staleApproval = { fromRevision: last.revision, approvedAt: last.at, reasons };
    } else status = 'approved';
  } else if (last?.type === 'rejected') status = 'rejected';
  else if (last?.type === 'review_requested') status = 'in_review';

  if (!staleApproval) {
    const lastApproval = sub.events.filter((e) => e.type === 'approved').at(-1);
    if (lastApproval && status !== 'approved') {
      const reasons = bindingDiff(lastApproval.binding, binding);
      if (reasons.length) {
        staleApproval = { fromRevision: lastApproval.revision, approvedAt: lastApproval.at, reasons };
        // A new revision of something that was approved is NOT a fresh draft: re-review is required,
        // until a new review is requested (in_review) or the reviewer rejects it.
        if (status === 'draft') status = 'approval_stale';
      }
    }
  }

  const blocking = evaluation.findings.filter((f) => f.severity === 'error');
  const warnings = evaluation.findings.filter((f) => f.severity === 'warning');
  const gate = (allowedRoles, ok, reasons) => {
    const rs = [];
    if (!role) rs.push(REASONS.noRole);
    else if (!allowedRoles.includes(role)) rs.push(viewer ? `Your role (${ROLES[role].label}) cannot do this.` : `The ${ROLES[role].label} demo role cannot do this.`);
    if (role && allowedRoles.includes(role)) rs.push(...reasons);
    return { allowed: Boolean(role) && rs.length === 0 && ok, reasons: rs };
  };

  // Accountable review: someone who wrote or edited this submission cannot approve it (needs a real identity).
  const contributors = new Set([sub.createdBy.id, ...sub.revisions.map((r) => r.author.id)].filter(Boolean));
  const selfReview = Boolean(viewer?.id) && contributors.has(viewer.id);
  const reviewable = ['draft', 'rejected', 'approval_stale'].includes(status);
  const decidable = status === 'in_review';
  const eligibility = {
    revise: gate(['creator', 'manager'], true, []),
    comment: { allowed: Boolean(role), reasons: role ? [] : [REASONS.noRole] },
    requestReview: gate(['creator', 'manager'], reviewable, reviewable ? [] : [status === 'approved' ? 'This revision is already approved.' : 'A review is already requested.']),
    approve: {
      ...gate(['manager', 'reviewer'], decidable && blocking.length === 0 && !selfReview && evidence.broken.length === 0, [
        ...(decidable ? [] : ['Approval needs a requested review on the latest revision.']),
        ...(selfReview ? ['You wrote or edited this submission, so a different person must approve it.'] : []),
        ...(blocking.length ? [`${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} must be fixed first.`] : []),
        ...(evidence.broken.length ? [`${evidence.broken.length} rule${evidence.broken.length === 1 ? ' cites' : 's cite'} source evidence that is no longer in force (replaced or withdrawn). A manager must relink or unlink it and publish before anything can be approved.`] : []),
      ]),
      requiresAcknowledgement: warnings.length > 0,
      warningCount: warnings.length,
      blockingCount: blocking.length,
      selfReview,
      evidenceBroken: evidence.broken.length,
    },
    reject: gate(['manager', 'reviewer'], decidable, decidable ? [] : ['Rejection needs a requested review on the latest revision.']),
  };

  return { status, statusLabel: STATUS_LABELS[status], staleApproval, binding, eligibility, blockingCount: blocking.length, warningCount: warnings.length };
}

/** The caller must have seen exactly what the server is about to act on. */
function assertExpected(expected, binding) {
  const changed = [];
  // An omitted evidenceHash means "I saw no registered evidence": fine only while there is none.
  if ((expected.evidenceHash ?? EMPTY_EVIDENCE_HASH) !== binding.evidenceHash) changed.push('evidence');
  if (expected.contentHash !== binding.contentHash) changed.push('content');
  if (expected.assetHash !== binding.assetHash) changed.push('asset');
  if ((expected.imageTextHash ?? null) !== (binding.imageTextHash ?? null)) changed.push('imagetext');
  if (expected.guidelineVersion !== binding.guidelineVersion || expected.guidelineHash !== binding.guidelineHash) changed.push('guideline');
  need(
    changed.length === 0,
    409,
    'stale_view',
    `What you reviewed is out of date (${changed.join(', ')} changed). Reload and review the current findings before continuing.`,
    { changed, currentGuidelineVersion: binding.guidelineVersion },
  );
}

function recordEvent(d, sub, type, { revision, role, actor, note, binding, now }) {
  const e = { id: `E-${++d.seq.event}`, type, revision, actor: actorOf(role, actor), note: note || '', binding, at: now };
  sub.events.push(e);
  return e;
}

function guardHead(sub, revision) {
  const h = head(sub);
  need(revision === h.n, 409, 'revision_conflict', `Revision ${revision} is no longer the latest (latest is ${h.n}). Reload before deciding.`, { currentRevision: h.n });
  return h;
}

export function requestReview(d, { id, revision, expected, role, actor, now }) {
  const sub = findSub(d, id);
  const h = guardHead(sub, revision);
  const version = currentVersion(d);
  const evidence = evidenceFor(d);
  assertExpected(expected, bindingFor(h, version, evidence.hash));
  const wf = deriveWorkflow(sub, version, evaluate(h, version), role, actor, evidence);
  const g = wf.eligibility.requestReview;
  need(g.allowed, 403, 'not_allowed', g.reasons.join(' '), { reasons: g.reasons });
  return recordEvent(d, sub, 'review_requested', { revision: h.n, role, actor, binding: wf.binding, now });
}

export function decide(d, { id, decision, revision, expected, note, acknowledgeWarnings, role, actor, now }) {
  const sub = findSub(d, id);
  const h = guardHead(sub, revision);
  const version = currentVersion(d);
  const evidence = evidenceFor(d);
  assertExpected(expected, bindingFor(h, version, evidence.hash));
  const wf = deriveWorkflow(sub, version, evaluate(h, version), role, actor, evidence);
  const g = wf.eligibility[decision === 'approved' ? 'approve' : 'reject'];
  need(g.allowed, 403, 'not_allowed', g.reasons.join(' '), { reasons: g.reasons });
  if (decision === 'approved' && g.requiresAcknowledgement) {
    need(acknowledgeWarnings === true, 422, 'acknowledgement_required', `This revision has ${g.warningCount} warning(s). Confirm you have reviewed them to approve.`, { warningCount: g.warningCount });
  }
  return recordEvent(d, sub, decision, { revision: h.n, role, actor, note, binding: wf.binding, now });
}

// ---------- reads ----------

export function listSubmissions(state) {
  const version = currentVersion(state);
  const evidence = evidenceFor(state);
  return state.submissions.map((sub) => {
    const h = head(sub);
    const ev = evaluate(h, version);
    const wf = deriveWorkflow(sub, version, ev, null, null, evidence);
    return {
      id: sub.id,
      title: sub.title,
      createdAt: sub.createdAt,
      createdBy: sub.createdBy,
      revisionCount: sub.revisions.length,
      headRevision: h.n,
      updatedAt: [h.createdAt, ...sub.events.map((e) => e.at), ...sub.comments.map((c) => c.createdAt)].sort().at(-1),
      status: wf.status,
      statusLabel: wf.statusLabel,
      staleApproval: wf.staleApproval,
      summary: ev.summary,
      commentCount: sub.comments.length,
    };
  });
}

export function describeSubmission(state, id, role, viewer = null) {
  const sub = findSub(state, id);
  const version = currentVersion(state);
  const h = head(sub);
  const ev = evaluate(h, version);
  const evidence = evidenceFor(state);
  const wf = deriveWorkflow(sub, version, ev, role, viewer, evidence);
  decorateFindings(ev.findings, state);
  return {
    id: sub.id,
    title: sub.title,
    createdAt: sub.createdAt,
    createdBy: sub.createdBy,
    headRevision: h.n,
    revisions: sub.revisions.map((r) => ({
      ...r,
      contentHash: contentHash(r.text),
      assetHash: assetHash(r.asset),
      ...(r.imageText ? { imageTextHash: imageTextHash(r.imageText) } : {}),
      image: describeImage(state, r.asset),
      summary: evaluate(r, version).summary,
    })),
    comments: sub.comments,
    events: sub.events,
    current: {
      revision: h.n,
      guidelineVersion: version.version,
      guidelineHash: guidelineHash(version.guidelines),
      engine: describeEngine(),
      findings: ev.findings,
      notChecked: ev.notChecked,
      summary: ev.summary,
      sentences: splitSentences(h.text),
      evidence: { hash: evidence.hash, linked: evidence.linked, legacy: evidence.legacy, broken: evidence.broken },
      image: describeImage(state, h.asset),
    },
    workflow: wf,
  };
}

export function compareRevisions(state, id, from, to) {
  const sub = findSub(state, id);
  const a = sub.revisions.find((r) => r.n === from);
  const b = sub.revisions.find((r) => r.n === to);
  need(a && b, 404, 'not_found', 'Revision not found.');
  const version = currentVersion(state);
  const key = (f) => `${f.ruleId}|${f.field}|${f.quote ?? ''}`;
  const fa = evaluate(a, version).findings.filter((f) => f.status !== 'supported');
  const fb = evaluate(b, version).findings.filter((f) => f.status !== 'supported');
  const ka = new Set(fa.map(key));
  const kb = new Set(fb.map(key));
  const assetFields = ['name', 'alt', 'fileSha256', 'retainedSha256', 'fg', 'bg', 'textSize'].filter((k) => (a.asset[k] ?? null) !== (b.asset[k] ?? null));
  if (canonical([...a.asset.colors].sort()) !== canonical([...b.asset.colors].sort())) assetFields.push('colors');
  return {
    from,
    to,
    text: diffText(a.text, b.text),
    assetFields,
    findings: {
      resolved: fa.filter((f) => !kb.has(key(f))),
      introduced: fb.filter((f) => !ka.has(key(f))),
      persisting: fb.filter((f) => ka.has(key(f))),
    },
    note: 'Findings for both revisions are evaluated against the current guideline version.',
  };
}

export function insights(state) {
  const version = currentVersion(state);
  const evidence = evidenceFor(state);
  const rules = new Map();
  const statuses = {};
  let revisionTotal = 0;
  let stale = 0;
  for (const sub of state.submissions) {
    const evals = sub.revisions.map((r) => evaluate(r, version));
    revisionTotal += sub.revisions.length;
    const headKeys = new Set(evals.at(-1).findings.filter((f) => f.status !== 'supported').map((f) => f.ruleId));
    const seenInSub = new Set();
    evals.forEach((ev) => {
      for (const f of ev.findings) {
        if (f.status === 'supported') continue;
        let r = rules.get(f.ruleId);
        if (!r) {
          r = { ruleId: f.ruleId, ruleKind: f.ruleKind, title: f.title, status: f.status, occurrences: 0, submissions: new Set(), openNow: 0, resolved: 0 };
          rules.set(f.ruleId, r);
        }
        r.occurrences++;
        r.submissions.add(sub.id);
        if (!seenInSub.has(f.ruleId)) {
          seenInSub.add(f.ruleId);
          if (headKeys.has(f.ruleId)) r.openNow++;
          else r.resolved++;
        }
      }
    });
    const wf = deriveWorkflow(sub, version, evals.at(-1), null, null, evidence);
    statuses[wf.status] = (statuses[wf.status] || 0) + 1;
    if (wf.staleApproval) stale++;
  }
  const list = [...rules.values()]
    .map((r) => ({ ...r, submissions: r.submissions.size }))
    .sort((x, y) => y.occurrences - x.occurrences || x.ruleId.localeCompare(y.ruleId));
  return {
    submissions: state.submissions.length,
    revisions: revisionTotal,
    staleApprovals: stale,
    statuses,
    recurring: list,
    note: 'Counts are computed from saved revisions evaluated against the current guideline version. Demo data is fictional.',
  };
}

// ---------- sources (thin wrappers that add the evidence picture) ----------

export { registry, versionState };

/** Source list with, per source, how many current rules/facts cite it and whether any citation is broken. */
export function sourcesOverview(state) {
  const evidence = evidenceFor(state);
  return {
    sources: listSources(state).map((s) => {
      const cited = evidence.entries.filter((e) => e.sourceId === s.id);
      return { ...s, linkedEntries: cited.length, brokenLinks: cited.filter((e) => e.state !== 'active').length };
    }),
    evidence: { hash: evidence.hash, linked: evidence.linked, legacy: evidence.legacy, broken: evidence.broken, entries: evidence.entries },
  };
}

export function sourceDetail(state, id) {
  const src = registry(state).find((x) => x.id === id);
  need(src, 404, 'not_found', `No source ${id}.`);
  const evidence = evidenceFor(state);
  return { source: sourceSummary(src), citedBy: evidence.entries.filter((e) => e.sourceId === id) };
}
