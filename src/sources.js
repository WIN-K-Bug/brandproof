/**
 * Approved-source registry: register source text, have a manager approve an immutable version, link exact
 * passages into rules and facts, and compute the "effective evidence" that approvals are bound to.
 *
 * Trust model (see docs/sources.md):
 *  - A source version is IMMUTABLE text. Registering or editing never approves anything: a version starts `pending`.
 *  - A manager approves a specific version after seeing its digest. Approval also makes it the source's ACTIVE
 *    version (the one in effect); the previously active version becomes `superseded`.
 *  - A rule or fact is "registered" only if it carries a link { sourceId, version, start, end } whose quote the SERVER
 *    cut out of that version's text. Typed labels and quotes without a link stay explicitly "legacy".
 *  - The effective evidence manifest lists every linked rule/fact with the CURRENT state of its source version
 *    (active / superseded / withdrawn / missing). Its hash is part of every approval binding, so replacing or
 *    withdrawing governing evidence makes approvals stale, and while any link is not active nobody can approve.
 *  - A pending, rejected or merely drafted replacement changes nothing: only approval activates.
 *
 * Text normalisation (explicit, so offsets mean the same thing everywhere): a leading BOM is removed, CRLF and CR
 * become LF, the text is Unicode NFC, control characters other than LF and TAB are refused, U+FFFD (a decoding
 * failure) is refused. Offsets are UTF-16 code-unit indices into that normalised text, [start, end), and may not
 * split a surrogate pair. The digest is SHA-256 of the UTF-8 bytes of the NORMALISED text: it is not a digest of
 * any original file. Repeated passages are told apart by their offsets, not by their wording.
 */
import { HttpError, canonical, sha256 } from './util.js';

export const SOURCE_LIMITS = {
  textChars: 100_000,
  title: 120,
  filename: 120,
  note: 500,
  url: 300,
  sources: 200,
  versionsPerSource: 50,
  quoteMin: 3,
  quoteMax: 500,
  chunkChars: 500,
  chunksPerVersion: 150,
  chunksTotal: 600,
};

export const EMPTY_EVIDENCE_HASH = sha256(canonical([]));

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const bad = (message, path = 'text') => new HttpError(422, 'validation_failed', message, { fields: [{ path, message }] });

export function normalizeSourceText(raw) {
  if (typeof raw !== 'string') throw bad('text is required');
  if (raw.length > SOURCE_LIMITS.textChars * 2) throw bad(`text must be at most ${SOURCE_LIMITS.textChars} characters`);
  let t = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (t.includes('�')) throw bad('text contains characters that could not be decoded; save the file as UTF-8 and try again');
  if (CONTROL.test(t)) throw bad('text contains control characters');
  t = t.normalize('NFC');
  if (!t.trim()) throw bad('text is required');
  if (t.length > SOURCE_LIMITS.textChars) throw bad(`text must be at most ${SOURCE_LIMITS.textChars} characters`);
  return t;
}

export const textDigest = (normalizedText) => sha256(normalizedText);

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** Offsets must lie inside the text and must not cut a surrogate pair in half. Returns an error message or null. */
export function spanProblem(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'start and end must be whole numbers';
  if (start < 0 || end > text.length || start >= end) return 'the span is outside the source text';
  if (isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) return 'the span starts in the middle of a character';
  if (end < text.length && isLow(text.charCodeAt(end)) && isHigh(text.charCodeAt(end - 1))) return 'the span ends in the middle of a character';
  const len = end - start;
  if (len > SOURCE_LIMITS.quoteMax) return `a cited passage can be at most ${SOURCE_LIMITS.quoteMax} characters`;
  if (text.slice(start, end).trim().length < SOURCE_LIMITS.quoteMin) return `a cited passage needs at least ${SOURCE_LIMITS.quoteMin} non-space characters`;
  return null;
}

// ---------- state helpers ----------

export const registry = (state) => state.sources ?? [];
export const findSource = (state, id) => registry(state).find((s) => s.id === id);

/** pending | rejected | active | superseded | withdrawn */
export function versionState(src, v) {
  if (v.status === 'pending') return 'pending';
  if (v.status === 'rejected') return 'rejected';
  if (src.activeVersion === v.n) return 'active';
  return src.activeVersion == null && src.withdrawnAt ? 'withdrawn' : 'superseded';
}

const need = (cond, status, code, msg, details) => {
  if (!cond) throw new HttpError(status, code, msg, details);
};

const actorOf = (role, actor, ROLES) => (actor ? { id: actor.id, name: actor.name, role: actor.role } : { role, name: ROLES[role].actor });

// ---------- mutations (called inside Store.mutate with the draft state) ----------

export function registerSource(d, { title, filename, url, origin, text, note, role, actor, now }, ROLES) {
  need(['creator', 'manager'].includes(role), 403, 'forbidden', 'Only Creator or Manager roles can register sources.');
  d.sources ??= [];
  d.seq.source ??= 0;
  need(d.sources.length < SOURCE_LIMITS.sources, 422, 'limit', `At most ${SOURCE_LIMITS.sources} sources.`);
  const normalized = normalizeSourceText(text);
  const who = actorOf(role, actor, ROLES);
  const src = {
    id: `SRC-${++d.seq.source}`,
    title,
    url: url || null, // metadata only: never fetched, never verified
    createdAt: now,
    createdBy: who,
    activeVersion: null,
    withdrawnAt: null,
    versions: [makeVersion(1, normalized, { origin, filename, note, who, now })],
    events: [{ type: 'registered', version: 1, actor: who, at: now, note: note || '' }],
  };
  d.sources.push(src);
  return src;
}

function makeVersion(n, text, { origin, filename, note, who, now }) {
  return { n, text, textSha256: textDigest(text), chars: text.length, origin, filename: filename || null, note: note || '', status: 'pending', createdAt: now, createdBy: who, reviewedBy: null, reviewedAt: null, reviewNote: '' };
}

const getSource = (d, id) => {
  const s = findSource(d, id);
  need(s, 404, 'not_found', `No source ${id}.`);
  return s;
};
const getVersion = (src, n) => {
  const v = src.versions.find((x) => x.n === n);
  need(v, 404, 'not_found', `Source ${src.id} has no version ${n}.`);
  return v;
};

export function addSourceVersion(d, { id, baseVersion, text, filename, origin, note, role, actor, now }, ROLES) {
  need(['creator', 'manager'].includes(role), 403, 'forbidden', 'Only Creator or Manager roles can register sources.');
  const src = getSource(d, id);
  const latest = src.versions.at(-1);
  need(baseVersion === latest.n, 409, 'version_conflict', `Version ${latest.n} was added while you were working from version ${baseVersion}. Reload and compare.`, { latestVersion: latest.n });
  need(src.versions.length < SOURCE_LIMITS.versionsPerSource, 422, 'limit', `At most ${SOURCE_LIMITS.versionsPerSource} versions per source.`);
  const normalized = normalizeSourceText(text);
  need(textDigest(normalized) !== latest.textSha256, 422, 'no_change', 'This text is identical to the latest version.');
  const who = actorOf(role, actor, ROLES);
  const v = makeVersion(latest.n + 1, normalized, { origin, filename, note, who, now });
  src.versions.push(v); // pending: the active version is NOT touched
  src.events.push({ type: 'version_added', version: v.n, actor: who, at: now, note: note || '' });
  return v;
}

export function approveSourceVersion(d, { id, n, expectedSha256, note, role, actor, now }, ROLES) {
  need(role === 'manager', 403, 'forbidden', 'Only the Manager role can approve a source version.');
  const src = getSource(d, id);
  const v = getVersion(src, n);
  need(v.status === 'pending', 409, 'not_pending', `Version ${n} is ${v.status}; only a pending version can be approved.`);
  need(expectedSha256 === v.textSha256, 409, 'stale_view', 'The text you reviewed is not this version. Reload and review it again.');
  need(!(actor?.id && v.createdBy.id === actor.id), 403, 'not_allowed', 'You registered this version, so a different person must approve it.');
  const who = actorOf(role, actor, ROLES);
  const previous = src.activeVersion;
  v.status = 'approved';
  v.reviewedBy = who;
  v.reviewedAt = now;
  v.reviewNote = note || '';
  src.activeVersion = n;
  src.withdrawnAt = null;
  src.events.push({ type: 'approved', version: n, actor: who, at: now, note: note || '', replaced: previous ?? null });
  return v;
}

export function rejectSourceVersion(d, { id, n, note, role, actor, now }, ROLES) {
  need(role === 'manager', 403, 'forbidden', 'Only the Manager role can reject a source version.');
  const src = getSource(d, id);
  const v = getVersion(src, n);
  need(v.status === 'pending', 409, 'not_pending', `Version ${n} is ${v.status}; only a pending version can be rejected.`);
  const who = actorOf(role, actor, ROLES);
  v.status = 'rejected';
  v.reviewedBy = who;
  v.reviewedAt = now;
  v.reviewNote = note;
  src.events.push({ type: 'rejected', version: n, actor: who, at: now, note });
  return v;
}

export function withdrawSource(d, { id, expectedActiveVersion, note, role, actor, now }, ROLES) {
  need(role === 'manager', 403, 'forbidden', 'Only the Manager role can withdraw a source.');
  const src = getSource(d, id);
  need(src.activeVersion != null, 409, 'not_active', 'This source has no active version to withdraw.');
  need(src.activeVersion === expectedActiveVersion, 409, 'stale_view', `Version ${src.activeVersion} is active now, not ${expectedActiveVersion}. Reload.`);
  const who = actorOf(role, actor, ROLES);
  const was = src.activeVersion;
  src.activeVersion = null;
  src.withdrawnAt = now;
  src.events.push({ type: 'withdrawn', version: was, actor: who, at: now, note });
  return src;
}

// ---------- reads ----------

export function sourceSummary(src) {
  return {
    id: src.id,
    title: src.title,
    url: src.url,
    urlNote: src.url ? 'Metadata only. BrandProof never opens or verifies this address.' : null,
    createdAt: src.createdAt,
    createdBy: src.createdBy,
    activeVersion: src.activeVersion,
    withdrawn: src.activeVersion == null && Boolean(src.withdrawnAt),
    withdrawnAt: src.withdrawnAt,
    latestVersion: src.versions.at(-1).n,
    versions: src.versions.map((v) => ({
      n: v.n,
      status: v.status,
      state: versionState(src, v),
      chars: v.chars,
      textSha256: v.textSha256,
      origin: v.origin,
      filename: v.filename,
      note: v.note,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      reviewedBy: v.reviewedBy,
      reviewedAt: v.reviewedAt,
      reviewNote: v.reviewNote,
    })),
    events: src.events,
  };
}

export function listSources(state) {
  return registry(state).map((s) => {
    const sum = sourceSummary(s);
    const { versions, events, ...rest } = sum;
    const latest = versions.at(-1);
    const pending = versions.filter((v) => v.status === 'pending').length;
    return { ...rest, versionCount: versions.length, latestStatus: latest.status, pendingVersions: pending, linkedEntries: 0 };
  });
}

export function sourceVersionDetail(state, id, n) {
  const src = findSource(state, id);
  need(src, 404, 'not_found', `No source ${id}.`);
  const v = getVersion(src, n);
  return { source: sourceSummary(src), version: { ...sourceSummary(src).versions.find((x) => x.n === n), text: v.text } };
}

// ---------- linking evidence into guidelines ----------

/** The guideline lists that may carry registered evidence. Policies keep legacy typed sources in this slice. */
const LINKABLE = ['terms', 'facts'];

export function linkedEntries(guidelines) {
  const out = [];
  for (const key of LINKABLE) {
    guidelines[key].forEach((e, i) => out.push({ list: key, index: i, id: e.id, label: e.label ?? e.preferred ?? e.avoid?.[0]?.text ?? e.id, source: e.source, linked: Boolean(e.source?.sourceId) }));
  }
  return out;
}

/**
 * Validate every evidence link in `guidelines` against the registry and REWRITE each linked source from the registry
 * text (the client only chooses source, version and span). Only the ACTIVE approved version of a source can be linked.
 * Throws 422 listing every problem so a manager can repair them all at once.
 */
export function resolveEvidence(state, guidelines) {
  const problems = [];
  for (const key of LINKABLE) {
    guidelines[key].forEach((e, i) => {
      const s = e.source;
      const path = `${key}[${i}].source`;
      if (!s?.sourceId) return;
      const fail = (message) => problems.push({ path, id: e.id ?? null, message });
      const src = findSource(state, s.sourceId);
      if (!src) return fail(`source ${s.sourceId} does not exist`);
      const v = src.versions.find((x) => x.n === s.version);
      if (!v) return fail(`source ${src.id} has no version ${s.version}`);
      const st = versionState(src, v);
      if (st !== 'active') {
        const why = { pending: 'is only a draft awaiting approval', rejected: 'was rejected', superseded: `has been replaced by version ${src.activeVersion}; link the passage again`, withdrawn: 'is withdrawn' }[st];
        return fail(`${src.id} version ${v.n} ${why}`);
      }
      const problem = spanProblem(v.text, s.start, s.end);
      if (problem) return fail(`${src.id} version ${v.n}: ${problem}`);
      const quote = v.text.slice(s.start, s.end);
      if (s.clientQuote !== undefined && s.clientQuote !== '' && s.clientQuote !== quote) return fail(`the quote does not match ${src.id} version ${v.n} at characters ${s.start} to ${s.end}`);
      e.source = {
        doc: `${src.title} (${src.id})`,
        section: `version ${v.n}, characters ${s.start} to ${s.end}`,
        quote,
        sourceId: src.id,
        version: v.n,
        start: s.start,
        end: s.end,
        textSha256: v.textSha256,
      };
    });
  }
  if (problems.length) {
    throw new HttpError(422, 'evidence_invalid', `${problems.length} evidence link${problems.length === 1 ? ' is' : 's are'} not valid. Fix or unlink them, then publish again.`, { problems });
  }
  return guidelines;
}

/** The effective evidence: every linked rule/fact with the CURRENT state of the source version it cites. */
export function evidenceManifest(state, guidelines) {
  const entries = [];
  let legacy = 0;
  for (const e of linkedEntries(guidelines)) {
    if (!e.linked) {
      legacy++;
      continue;
    }
    const s = e.source;
    const src = findSource(state, s.sourceId);
    const v = src?.versions.find((x) => x.n === s.version);
    entries.push({
      entryId: e.id,
      label: e.label,
      sourceId: s.sourceId,
      version: s.version,
      start: s.start,
      end: s.end,
      textSha256: v?.textSha256 ?? s.textSha256 ?? null,
      state: src && v ? versionState(src, v) : 'missing',
    });
  }
  entries.sort((a, b) => a.entryId.localeCompare(b.entryId));
  // Hash only what governs findings: which text each linked rule rests on, and whether that text is in force.
  const hash = entries.length ? sha256(canonical(entries.map(({ entryId, sourceId, version, start, end, textSha256, state }) => ({ entryId, sourceId, version, start, end, textSha256, state })))) : EMPTY_EVIDENCE_HASH;
  const broken = entries.filter((x) => x.state !== 'active');
  return { hash, entries, broken, linked: entries.length, legacy };
}

/** Annotate findings: registered (cites an active/replaced/withdrawn registry version) or legacy (typed label only). */
export function decorateFindings(findings, state) {
  for (const f of findings) {
    if (!f.source) continue;
    const s = f.source;
    if (s.sourceId) {
      const src = findSource(state, s.sourceId);
      const v = src?.versions.find((x) => x.n === s.version);
      f.sourceEvidence = { provenance: 'registered', sourceId: s.sourceId, version: s.version, start: s.start, end: s.end, state: src && v ? versionState(src, v) : 'missing' };
    } else {
      f.sourceEvidence = { provenance: 'legacy', note: 'Typed by a manager; not linked to a registered source.' };
    }
  }
  return findings;
}

// ---------- contextual retrieval: passages from ACTIVE approved sources only ----------

export function chunkText(text) {
  const out = [];
  const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g; // paragraphs: runs of non-blank lines
  let m;
  while ((m = re.exec(text))) {
    let start = m.index;
    const end = m.index + m[0].length;
    while (start < end) {
      let stop = Math.min(end, start + SOURCE_LIMITS.chunkChars);
      if (stop < end) {
        const cut = text.lastIndexOf(' ', stop);
        if (cut > start + 100) stop = cut;
        if (isHigh(text.charCodeAt(stop - 1))) stop--;
      }
      const piece = text.slice(start, stop);
      const lead = piece.length - piece.trimStart().length;
      const s = start + lead;
      const e = start + piece.trimEnd().length;
      if (e - s >= 12) out.push({ start: s, end: e });
      start = stop;
    }
  }
  return out;
}

export function activeSourceVersions(state) {
  return registry(state).flatMap((s) => (s.activeVersion != null ? [{ src: s, v: s.versions.find((x) => x.n === s.activeVersion) }] : []));
}

/** Retrieval candidates and a hash that changes whenever the set of active approved passages changes. */
export function retrievalSources(state) {
  const items = [];
  const idHash = [];
  for (const { src, v } of activeSourceVersions(state)) {
    idHash.push({ id: src.id, version: v.n, sha: v.textSha256 });
    for (const c of chunkText(v.text).slice(0, SOURCE_LIMITS.chunksPerVersion)) {
      if (items.length >= SOURCE_LIMITS.chunksTotal) break;
      const quote = v.text.slice(c.start, c.end);
      items.push({
        id: `${src.id}@v${v.n}:${c.start}`,
        kind: 'Registered source passage',
        label: src.title,
        text: quote,
        quote,
        doc: `${src.title} (${src.id})`,
        section: `version ${v.n}, characters ${c.start} to ${c.end}`,
        registered: { sourceId: src.id, version: v.n, start: c.start, end: c.end },
      });
    }
  }
  return { items, hash: sha256(canonical(idHash)) };
}
