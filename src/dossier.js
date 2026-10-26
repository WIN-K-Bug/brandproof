/**
 * Review dossier: ONE campaign's current saved state, the evidence behind it and the recorded decisions, as a single
 * portable object that the app renders as a readable report and offers as an explicit JSON download.
 *
 * It is a factual local snapshot. It is NOT a compliance certificate, a signature, a tamper-proof ledger or permission to
 * publish. Two kinds of information are kept apart and labelled as such:
 *   - RECORDED: what was stored when it happened (decisions, actors, notes, the binding hashes each decision covered);
 *   - RECOMPUTED: findings produced today by the rules against today's guidelines. The findings a reviewer actually saw in
 *     the past were never stored, so none are reconstructed or implied.
 *
 * buildDossier is pure and synchronous over ONE committed state, so everything in it is mutually coherent. The only
 * asynchronous input (image integrity, read from disk) is passed in; the caller must confirm the state did not change
 * while it was being read (see the route) and otherwise rebuild.
 *
 * Deliberately absent: filesystem paths, credentials, sessions, CSRF tokens, usernames or emails, source full texts,
 * image bytes, other campaigns, comment bodies, the model cache.
 */
import { canonical, sha256 } from './util.js';
import { currentVersion, evaluate, deriveWorkflow, bindingFor, bindingDiff, contentHash, assetHash, guidelineHash, evidenceFor, STATUS_LABELS } from './service.js';
import { decorateFindings, findSource, versionState, SOURCE_LIMITS } from './sources.js';
import { CHECKER_REVISION } from './checks.js';
import { describeImage } from './assets.js';

export const DOSSIER_FORMAT = 'brandproof-review-dossier';
export const DOSSIER_FORMAT_VERSION = 3;

/** What each digest in the file is a digest OF. These are descriptions of the existing, unchanged methods. */
export const HASH_METHODS = Object.freeze({
  note: 'Every digest is a lowercase hex SHA-256. They are digests of DIFFERENT things; do not compare one kind with another.',
  contentSha256: 'SHA-256 of the canonical JSON {"text": <saved copy>} (keys sorted, UTF-8). It is NOT a hash of the raw text bytes.',
  imageSha256: 'SHA-256 of the actual bytes of the retained PNG file, computed by the server.',
  sourceVersionTextSha256: 'SHA-256 of the UTF-8 bytes of the source version\'s NORMALISED text (LF line endings, composed accents). It is not a digest of any original file.',
  bindingHashes: 'assetHash, guidelineHash and evidenceHash are SHA-256 of canonical JSON of metadata: the image details (including the retained image digest as a string, not the bytes), the whole guideline set, and the list of linked rules with the state of the source version each cites.',
  imageTextHash: 'SHA-256 of the canonical JSON {"text": <confirmed transcription>, "imageSha256": <digest of the retained image it was confirmed against>}. It is present in a binding only when a person has confirmed a transcription.',
  checksum: 'SHA-256 of the canonical JSON of every other field of this file.',
  canonicalJson: 'JSON with object keys sorted at every level and no extra whitespace; undefined becomes null.',
});
const MAX_EVENTS = 200;

const person = (a) => (a ? { ...(a.id ? { id: a.id } : {}), name: a.name ?? null, role: a.role ?? null } : null);

const statusWord = { approved: 'approved', rejected: 'rejected', review_requested: 'review requested' };

function imageBlock(state, asset, integrity) {
  const d = describeImage(state, asset);
  const base = {
    name: asset.name || null,
    alt: asset.alt || null,
    // Only the legacy, metadata-only case is unverifiable. For a retained image the browser copies the server's digest into
    // the saved details, so the note says whether it still equals the digest the server computed.
    browserReportedFingerprint: asset.fileSha256
      ? {
          value: asset.fileSha256,
          note: asset.retainedSha256
            ? asset.fileSha256 === asset.retainedSha256
              ? 'Saved with the image details; it equals the retained image digest the server computed.'
              : 'Saved with the image details; it DIFFERS from the retained image digest. The server-computed digest is the one that is verified.'
            : 'Reported by the browser when the details were saved; the image itself was not held, so this cannot be checked.',
        }
      : null,
    textColour: asset.fg ?? null,
    backgroundColour: asset.bg ?? null,
    textSize: asset.textSize ?? null,
    colours: [...(asset.colors ?? [])],
    coloursNote: 'Colours are entered by hand; nothing about colour, contrast or logos is read from the image. Text in the image appears only as a person\'s confirmed transcription (see Image text).',
  };
  if (d.status === 'retained') {
    return {
      ...base,
      state: 'retained',
      integrity: integrity ?? 'unavailable',
      sha256: d.sha256,
      bytes: d.bytes,
      width: d.width,
      height: d.height,
      mime: d.mime,
      uploadedBy: person(d.uploadedBy),
      uploadedAt: d.uploadedAt,
      localLink: d.url,
      note:
        integrity === 'ok'
          ? 'The retained image was read back from storage and its digest matches.'
          : 'The retained image could NOT be verified right now (' + (integrity ?? 'unavailable') + '). It cannot be reviewed or approved until it is restored; a past approval does not make it available today.',
    };
  }
  if (d.status === 'missing') return { ...base, state: 'registry_entry_missing', integrity: 'missing', sha256: d.sha256, note: 'The revision refers to an image that is not registered in this workspace.' };
  if (d.status === 'metadata_only') return { ...base, state: 'metadata_only', integrity: 'not_applicable', note: d.note };
  return { ...base, state: 'none', integrity: 'not_applicable', note: 'No image is attached to this revision.' };
}

/** What a person confirmed as the text of this revision's image. A confirmation is a person's transcription, never proof the reading was right. */
function imageTextBlock(head) {
  const it = head.imageText;
  if (!it) {
    return { state: 'none', note: head.asset.retainedSha256 ? 'No transcription of the text in this image has been confirmed, so the text in the image has NOT been checked.' : 'No retained image is attached, so there is no image text.' };
  }
  const draft = it.provenance?.draft;
  return {
    state: 'confirmed',
    text: it.text,
    chars: it.text.length,
    imageSha256: it.imageSha256,
    matchesRetainedImage: it.imageSha256 === head.asset.retainedSha256,
    confirmedBy: person(it.confirmedBy),
    confirmedAt: it.confirmedAt,
    confirmedInRevision: it.confirmedInRevision ?? null,
    carriedFromRevision: it.carriedFromRevision ?? null,
    provenance: {
      kind: it.provenance?.kind ?? 'typed',
      editedAfterReading: it.provenance?.edited ?? null,
      automaticReading: draft ? { id: draft.id, engine: draft.engine, confidenceHeuristic: draft.confidence, confidenceNote: 'The reader\'s own heuristic, not a measure of correctness.', draftTextSha256: draft.textSha256 } : null,
      draftUnavailable: Boolean(it.provenance?.draftUnavailable),
    },
    note: 'A person saved this as their transcription of the text in this image and confirmed it against the image. That is not verification: the automatic reading (if one was used) can be wrong, and any text in the image that was not transcribed is not covered. Only this transcription was checked.',
    printedRule: 'Match the words actually printed. Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.',
    limit: 'BrandProof cannot compare the transcript with the pixels, so a person could still type words the image does not print. That would defeat this check, which is why who confirmed it is recorded.',
  };
}

function findingBlock(f) {
  const ev = f.sourceEvidence;
  return {
    id: f.id,
    ruleId: f.ruleId,
    ruleKind: f.ruleKind,
    status: f.status,
    severity: f.severity,
    title: f.title,
    explanation: f.explanation,
    field: f.field,
    quote: f.quote ?? null,
    span: f.span ?? null,
    correction: f.correction ? (f.correction.type === 'replace' ? { type: 'replace', replacement: f.correction.replacement } : { type: f.correction.type, text: f.correction.text ?? null }) : null,
    evidence: (f.evidence ?? []).map((e) => ({ type: e.type, id: e.id, label: e.label, statement: e.statement, quote: e.quote })),
    measured: f.measured ?? null,
    provenance: ev ? ev.provenance : null,
    source: f.source
      ? {
          doc: f.source.doc ?? null,
          section: f.source.section ?? null,
          quote: f.source.quote ?? null,
          ...(ev?.provenance === 'registered' ? { sourceId: ev.sourceId, version: ev.version, start: ev.start, end: ev.end, sourceVersionState: ev.state } : {}),
        }
      : null,
  };
}

/** Exact cited passages (cut from the registry text, bounded) for every registered source behind a current finding. */
function excerptsFor(state, findings) {
  const seen = new Map();
  for (const f of findings) {
    const ev = f.sourceEvidence;
    if (ev?.provenance !== 'registered') continue;
    const key = `${ev.sourceId}|${ev.version}|${ev.start}|${ev.end}`;
    if (seen.has(key)) {
      seen.get(key).citedBy.push(f.ruleId);
      continue;
    }
    const src = findSource(state, ev.sourceId);
    const v = src?.versions.find((x) => x.n === ev.version);
    const cut = v ? v.text.slice(ev.start, ev.end) : null;
    seen.set(key, {
      sourceId: ev.sourceId,
      title: src?.title ?? null,
      version: ev.version,
      versionState: src && v ? versionState(src, v) : 'missing',
      versionTextSha256: v?.textSha256 ?? null,
      start: ev.start,
      end: ev.end,
      excerpt: cut !== null && cut.length <= SOURCE_LIMITS.quoteMax ? cut : cut === null ? null : cut.slice(0, SOURCE_LIMITS.quoteMax),
      excerptMatchesCitedQuote: cut !== null && cut === f.source?.quote,
      localLink: `#/sources/${ev.sourceId}/${ev.version}?start=${ev.start}&end=${ev.end}`,
      citedBy: [f.ruleId],
    });
  }
  return [...seen.values()].map((x) => ({ ...x, citedBy: [...new Set(x.citedBy)] }));
}

/**
 * state: committed (or frozen) workspace state. id: submission id. integrity: 'ok' | 'missing' | 'corrupt' | 'unavailable'
 * for the CURRENT revision's retained image (undefined when it has none). mode: 'demo' | 'authenticated'.
 */
export function buildDossier(state, id, { integrity, now, mode }) {
  const sub = state.submissions.find((s) => s.id === id);
  if (!sub) return null;
  const version = currentVersion(state);
  const head = sub.revisions.at(-1);
  const evidence = evidenceFor(state);
  const ev = evaluate(head, version);
  decorateFindings(ev.findings, state);
  const wf = deriveWorkflow(sub, version, ev, null, null, evidence);
  const binding = bindingFor(head, version, evidence.hash);
  const image = imageBlock(state, head.asset, integrity);

  const decisions = sub.events.filter((e) => statusWord[e.type]);
  const last = decisions.filter((e) => e.revision === head.n).at(-1) ?? decisions.at(-1) ?? null;
  const events = sub.events.slice(-MAX_EVENTS).map((e) => {
    const reasons = e.binding ? bindingDiff(e.binding, binding) : null;
    return {
      id: e.id,
      type: e.type,
      revision: e.revision ?? null,
      actor: person(e.actor),
      note: e.note || '',
      at: e.at,
      binding: e.binding ?? null,
      bindingComparedWithCurrentInputs: reasons ? { matches: reasons.length === 0, differs: reasons } : null,
    };
  });

  const contributors = new Set([sub.createdBy?.id, ...sub.revisions.map((r) => r.author?.id)].filter(Boolean));
  const authed = mode === 'authenticated';
  const blocks = [];
  const blocking = ev.findings.filter((f) => f.severity === 'error').length;
  if (blocking) blocks.push(`${blocking} blocking finding${blocking === 1 ? '' : 's'} (recomputed today) must be fixed before approval.`);
  if (evidence.broken.length) blocks.push(`${evidence.broken.length} rule${evidence.broken.length === 1 ? ' cites' : 's cite'} source evidence that is no longer in force (${evidence.broken.map((b) => b.entryId).join(', ')}); a manager must relink or unlink it.`);
  if (image.state === 'retained' && image.integrity !== 'ok') blocks.push(`The retained image is ${image.integrity}: it cannot be reviewed or approved until it is restored.`);
  if (image.state === 'registry_entry_missing') blocks.push('The revision refers to an image that is not registered in this workspace.');

  const lastReasons = last?.binding ? bindingDiff(last.binding, binding) : null;
  let headline;
  if (!last) headline = 'No review has been requested or decided on this campaign yet.';
  else {
    const who = last.actor?.name ?? 'someone';
    const when = `${last.type === 'review_requested' ? 'Review was requested' : last.type === 'approved' ? 'Approved' : 'Rejected'} by ${who} on revision ${last.revision} (${last.at})`;
    if (last.type === 'approved') {
      headline = lastReasons?.length ? `${when}. The saved inputs now differ from what that approval covered (${lastReasons.join(', ')} changed), so it no longer applies: Re-review required.` : `${when}. The saved inputs still match the binding recorded with that approval.`;
    } else headline = `${when}.`;
  }

  // A record that was approved once is not thereby ready today: say what stands in the way right now.
  if (blocks.length) headline += ` It is not ready today: ${blocks.join(' ')}`;

  const body = {
    format: DOSSIER_FORMAT,
    formatVersion: DOSSIER_FORMAT_VERSION,
    snapshot: {
      generatedAt: now,
      engine: {
        mode: 'rules',
        description: 'Deterministic text, number, palette, contrast and alt-text rules. Contextual (generative) AI review is unavailable.',
        checkerRevision: CHECKER_REVISION,
        checkerRevisionNote: 'A hand-maintained label bumped by the authors when the rules change. It is not derived from the code, not a build identity or signature, and a forgotten bump is possible. The rules are otherwise unversioned.',
      },
      outdatedNote: 'This is a snapshot of saved data at the time above. It can be out of date as soon as anything changes (a revision, a decision, the guidelines, a source or an image). Open the campaign for the current state.',
    },
    workspace: {
      mode: authed ? 'authenticated' : 'demo',
      identityNote: authed
        ? 'People are local accounts with stable ids, recorded by the server from the signed-in session. Local sign-in only: no HTTPS, no encryption at rest.'
        : 'Demo mode: actors are role labels chosen in a switch, not authenticated people.',
    },
    campaign: { id: sub.id, title: sub.title, createdAt: sub.createdAt, createdBy: person(sub.createdBy), revisionCount: sub.revisions.length, commentCount: sub.comments.length, commentBodiesIncluded: false },
    currentRevision: { n: head.n, createdAt: head.createdAt, author: person(head.author), text: head.text, chars: head.text.length, contentSha256: contentHash(head.text) },
    revisionHistory: sub.revisions.map((r) => ({ n: r.n, createdAt: r.createdAt, author: person(r.author), contentSha256: contentHash(r.text), assetBindingHash: assetHash(r.asset), retainedImageSha256: r.asset.retainedSha256 ?? null })),
    image,
    imageText: imageTextBlock(head),
    guidelines: { version: version.version, hash: guidelineHash(version.guidelines), createdAt: version.createdAt, createdBy: version.createdBy ?? null, note: version.note ?? '' },
    evidence: {
      hash: evidence.hash,
      linkedEntries: evidence.linked,
      legacyEntries: evidence.legacy,
      entries: evidence.entries.map((e) => ({ entryId: e.entryId, label: e.label, sourceId: e.sourceId, version: e.version, start: e.start, end: e.end, textSha256: e.textSha256, state: e.state })),
      brokenEntries: evidence.broken.map((e) => e.entryId),
      note: 'Legacy entries have a typed document name and quote that are not linked to any registered document; they cannot be opened or verified here.',
    },
    currentBinding: binding,
    status: {
      workflow: wf.status,
      label: STATUS_LABELS[wf.status],
      staleApproval: wf.staleApproval,
      headline,
      currentBlocks: blocks,
      counts: { blocking, warnings: ev.findings.filter((f) => f.severity === 'warning').length, needsReview: ev.findings.filter((f) => f.status === 'needs_review').length, unverified: ev.findings.filter((f) => f.status === 'unverified').length, supported: ev.findings.filter((f) => f.status === 'supported').length },
      separationOfDuties: last?.type === 'approved' ? (authed ? { approverWasContributor: Boolean(last.actor?.id && contributors.has(last.actor.id)), note: 'Compared by stable account id.' } : { approverWasContributor: null, note: 'Not applicable in demo mode: roles are not identities.' }) : null,
    },
    recordedEvents: {
      kind: 'RECORDED',
      note: 'Stored when each event happened. Each decision carries the hashes of the content, image details, guideline version and evidence it covered. The findings the person saw at that time were NOT stored and are not reconstructed here.',
      truncated: sub.events.length > MAX_EVENTS,
      events,
    },
    recomputedFindings: {
      kind: 'RECOMPUTED',
      note: `Produced now by the rules against guidelines v${version.version} and the current text. They are not what any reviewer saw in the past.`,
      summary: ev.summary,
      findings: ev.findings.map(findingBlock),
      notChecked: ev.notChecked.map((n) => ({ ruleId: n.ruleId, reason: n.reason })),
    },
    sourceExcerpts: excerptsFor(state, ev.findings),
    hashMethods: HASH_METHODS,
    links: { note: 'Links are addresses inside THIS local workspace (they work only here, for signed-in people). They are not public or shareable links.' },
    limitations: [
      'Not a compliance certificate, legal review, signature or tamper-proof record, and not permission to publish. An approval applies only while the saved inputs it covered are unchanged.',
      'Text in the image is covered only as far as a person transcribed and confirmed it. An automatic reading is a draft and can be wrong; it is never source evidence and never approved by itself.',
      'Findings are recomputed by deterministic rules today. They can miss paraphrased claims, and they are not what a reviewer saw when deciding.',
      'Source full texts, image bytes, other campaigns, comment bodies, credentials and file paths are not included. Excerpts are the exact cited passages only.',
      'The checksum covers every other field of this file. It detects accidental changes only: anyone can recompute it, so it does not prove who produced the file, which build produced it, or that nothing was altered.',
      'Data in this workspace is stored unencrypted on one computer.',
    ],
  };
  // Normalise through JSON first so the checksum is over exactly what a reader of the file sees (no undefined keys).
  const plain = JSON.parse(JSON.stringify(body));
  return { ...plain, checksum: { algorithm: 'sha256', over: 'canonical JSON (sorted keys) of every other field of this file', value: sha256(canonical(plain)), note: 'Detects accidental change only; not an authenticity check.' } };
}

