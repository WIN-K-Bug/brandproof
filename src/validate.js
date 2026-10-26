import { normalizeHex } from './color.js';

export const LIMITS = {
  title: 120,
  text: 5000,
  alt: 300,
  assetName: 120,
  comment: 1000,
  imageText: 4000,
  note: 500,
  colors: 12,
  terms: 200,
  facts: 200,
  palette: 50,
};

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ENUM_SEVERITY = ['warning', 'error'];
const TERM_KINDS = ['naming', 'banned', 'tone'];

class Collector {
  constructor() {
    this.errors = [];
  }
  err(path, message) {
    this.errors.push({ path, message });
  }
  get ok() {
    return this.errors.length === 0;
  }

  str(v, path, { min = 0, max, required = false, multiline = false } = {}) {
    if (v === undefined || v === null || v === '') {
      if (required) this.err(path, 'is required');
      return '';
    }
    if (typeof v !== 'string') {
      this.err(path, 'must be a string');
      return '';
    }
    let s = v.replace(/\r\n?/g, '\n');
    if (CONTROL.test(s)) this.err(path, 'contains control characters');
    if (!multiline && s.includes('\n')) this.err(path, 'must be a single line');
    if (!multiline) s = s.trim();
    else if (s.trim() === '' && required) this.err(path, 'is required');
    if (s.length > max) this.err(path, `must be at most ${max} characters`);
    if (s.length < min) this.err(path, `must be at least ${min} characters`);
    return s;
  }

  bool(v, path, dflt = false) {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'boolean') {
      this.err(path, 'must be true or false');
      return dflt;
    }
    return v;
  }

  num(v, path, { min, max, int = false, dflt } = {}) {
    if (v === undefined || v === null || v === '') {
      if (dflt !== undefined) return dflt;
      this.err(path, 'is required');
      return NaN;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.err(path, 'must be a number');
      return NaN;
    }
    if (int && !Number.isInteger(v)) this.err(path, 'must be a whole number');
    if (v < min || v > max) this.err(path, `must be between ${min} and ${max}`);
    return v;
  }

  oneOf(v, path, allowed, dflt) {
    if ((v === undefined || v === null) && dflt !== undefined) return dflt;
    if (!allowed.includes(v)) {
      this.err(path, `must be one of: ${allowed.join(', ')}`);
      return dflt;
    }
    return v;
  }

  arr(v, path, { max, min = 0 } = {}) {
    if (v === undefined || v === null) {
      if (min > 0) this.err(path, 'is required');
      return [];
    }
    if (!Array.isArray(v)) {
      this.err(path, 'must be a list');
      return [];
    }
    if (v.length > max) {
      this.err(path, `must have at most ${max} items`);
      return [];
    }
    if (v.length < min) this.err(path, `must have at least ${min} item(s)`);
    return v;
  }

  obj(v, path) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      this.err(path, 'must be an object');
      return {};
    }
    return v;
  }

  hex(v, path, { nullable = true } = {}) {
    if (v === undefined || v === null || v === '') {
      if (!nullable) this.err(path, 'is required');
      return null;
    }
    const h = normalizeHex(v);
    if (!h) this.err(path, 'must be a hex colour like #0F2A43');
    return h;
  }
}

export const emptyAsset = () => ({
  name: '',
  alt: '',
  fileSha256: null,
  retainedSha256: null,
  fg: null,
  bg: null,
  textSize: 'normal',
  colors: [],
});

function readAsset(a, c, path) {
  if (a === undefined || a === null) return emptyAsset();
  a = c.obj(a, path);
  const out = emptyAsset();
  out.name = c.str(a.name, `${path}.name`, { max: LIMITS.assetName });
  out.alt = c.str(a.alt, `${path}.alt`, { max: LIMITS.alt });
  if (a.fileSha256 !== undefined && a.fileSha256 !== null && a.fileSha256 !== '') {
    if (typeof a.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.fileSha256)) {
      c.err(`${path}.fileSha256`, 'must be a 64-character lowercase hex SHA-256');
    } else if (!out.name) {
      c.err(`${path}.name`, 'is required when a file digest is given');
    } else {
      out.fileSha256 = a.fileSha256;
    }
  }
  // A reference to a RETAINED image (the server-computed SHA-256 of bytes stored in this workspace). It is only a reference:
  // the service checks it resolves to retained bytes, and any client-supplied fileSha256 must equal it.
  if (a.retainedSha256 !== undefined && a.retainedSha256 !== null && a.retainedSha256 !== '') {
    if (typeof a.retainedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.retainedSha256)) c.err(`${path}.retainedSha256`, 'must be a 64-character lowercase hex SHA-256');
    else if (!out.name) c.err(`${path}.name`, 'is required when an image is attached');
    else {
      if (out.fileSha256 && out.fileSha256 !== a.retainedSha256) c.err(`${path}.fileSha256`, 'does not match the retained image');
      out.retainedSha256 = a.retainedSha256;
      out.fileSha256 = a.retainedSha256;
    }
  }
  out.fg = c.hex(a.fg, `${path}.fg`);
  out.bg = c.hex(a.bg, `${path}.bg`);
  out.textSize = c.oneOf(a.textSize, `${path}.textSize`, ['normal', 'large'], 'normal');
  const colors = c.arr(a.colors, `${path}.colors`, { max: LIMITS.colors });
  const seen = new Set();
  colors.forEach((col, i) => {
    const h = c.hex(col, `${path}.colors[${i}]`, { nullable: false });
    if (h && !seen.has(h)) {
      seen.add(h);
      out.colors.push(h);
    }
  });
  return out;
}

/**
 * Optional transcription of the text in the retained image. Only { text, draftId, confirmed } are read: who confirmed, when,
 * for which image and where the words came from are decided by the SERVER, never taken from the client.
 * undefined = the client says nothing (the server may carry a confirmation forward ONLY for the identical image).
 */
function readImageText(v, c, path) {
  if (v === undefined || v === null) return undefined;
  v = c.obj(v, path);
  const text = c.str(v.text, `${path}.text`, { max: LIMITS.imageText, multiline: true });
  let draftId = null;
  if (v.draftId !== undefined && v.draftId !== null) {
    if (typeof v.draftId === 'string' && /^OCR-[0-9a-f]{16}$/.test(v.draftId)) draftId = v.draftId;
    else c.err(`${path}.draftId`, 'is not a text-reading draft id');
  }
  return { text, draftId, confirmed: v.confirmed === true };
}

export function validateContent(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const text = c.str(b.text, 'text', { required: true, max: LIMITS.text, multiline: true });
  const asset = readAsset(b.asset, c, 'asset');
  const imageText = readImageText(b.imageText, c, 'imageText');
  return { errors: c.errors, value: { text, asset, ...(imageText ? { imageText } : {}) } };
}

/** Optional reference that ties an extraction to a SAVED revision: the server then checks that revision really holds this image. */
export function validateOcrRequest(body) {
  const c = new Collector();
  const b = body === undefined || body === null ? {} : c.obj(body, 'body');
  let submissionId = null;
  let revision = null;
  if (b.submissionId !== undefined || b.revision !== undefined) {
    if (typeof b.submissionId === 'string' && /^SUB-[0-9]{1,9}$/.test(b.submissionId)) submissionId = b.submissionId;
    else c.err('submissionId', 'must look like SUB-1');
    revision = c.num(b.revision, 'revision', { min: 1, max: 1e6, int: true });
  }
  return { errors: c.errors, value: { submissionId, revision } };
}

export function validateNewSubmission(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const title = c.str(b.title, 'title', { required: true, max: LIMITS.title });
  const content = validateContent(b);
  return { errors: [...c.errors, ...content.errors], value: { title, ...content.value } };
}

export function validateNewRevision(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const baseRevision = c.num(b.baseRevision, 'baseRevision', { min: 1, max: 1e6, int: true });
  const content = validateContent(b);
  return { errors: [...c.errors, ...content.errors], value: { baseRevision, ...content.value } };
}

export function validateComment(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const revision = c.num(b.revision, 'revision', { min: 1, max: 1e6, int: true });
  const text = c.str(b.text, 'text', { required: true, max: LIMITS.comment, multiline: true });
  let ruleId = null;
  if (b.ruleId !== undefined && b.ruleId !== null && b.ruleId !== '') {
    if (typeof b.ruleId !== 'string' || !/^[A-Z]{3}-\d{3,}$/.test(b.ruleId)) c.err('ruleId', 'must look like TRM-001');
    else ruleId = b.ruleId;
  }
  return { errors: c.errors, value: { revision, text, ruleId } };
}

/** What the person was looking at when they acted; the server rejects the action if any of it changed. */
function readExpected(v, c, path = 'expected') {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    c.err(path, 'is required: send the binding you reviewed');
    return null;
  }
  const hash = (x, p) => {
    if (typeof x !== 'string' || !/^[0-9a-f]{64}$/.test(x)) {
      c.err(`${path}.${p}`, 'must be a 64-character hex hash');
      return null;
    }
    return x;
  };
  return {
    guidelineVersion: c.num(v.guidelineVersion, `${path}.guidelineVersion`, { min: 1, max: 1e6, int: true }),
    guidelineHash: hash(v.guidelineHash, 'guidelineHash'),
    contentHash: hash(v.contentHash, 'contentHash'),
    assetHash: hash(v.assetHash, 'assetHash'),
    // The effective source-evidence hash the person saw. Optional only for workspaces with no registered evidence;
    // the service refuses an omitted value when evidence is linked.
    evidenceHash: v.evidenceHash === undefined || v.evidenceHash === null ? undefined : hash(v.evidenceHash, 'evidenceHash'),
    // The confirmed image-text hash the person saw. Omitted means "I saw no confirmed transcription": the service refuses that when one exists.
    imageTextHash: v.imageTextHash === undefined || v.imageTextHash === null ? undefined : hash(v.imageTextHash, 'imageTextHash'),
  };
}

export function validateDecision(body, { noteRequired = false } = {}) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const revision = c.num(b.revision, 'revision', { min: 1, max: 1e6, int: true });
  const note = c.str(b.note, 'note', { max: LIMITS.note, multiline: true, required: noteRequired });
  const acknowledgeWarnings = c.bool(b.acknowledgeWarnings, 'acknowledgeWarnings');
  const expected = readExpected(b.expected, c);
  return { errors: c.errors, value: { revision, expected, note, acknowledgeWarnings } };
}

export function validateSemanticRequest(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  let submissionId = '';
  if (typeof b.submissionId !== 'string' || !/^SUB-[0-9]{1,9}$/.test(b.submissionId)) c.err('submissionId', 'must look like SUB-1');
  else submissionId = b.submissionId;
  const revision = c.num(b.revision, 'revision', { min: 1, max: 1e6, int: true });
  const passages = [];
  c.arr(b.passages, 'passages', { max: 8, min: 1 }).forEach((p, i) => {
    p = c.obj(p, `passages[${i}]`);
    const start = c.num(p.start, `passages[${i}].start`, { min: 0, max: 1e6, int: true });
    const end = c.num(p.end, `passages[${i}].end`, { min: 1, max: 1e6, int: true });
    if (start >= end) c.err(`passages[${i}]`, 'start must be before end');
    passages.push({ start, end });
  });
  const e = b.expected && typeof b.expected === 'object' ? b.expected : null;
  if (!e) c.err('expected', 'is required: send the binding you are looking at');
  const hash = (v, p) => {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) {
      c.err(`expected.${p}`, 'must be a 64-character hex hash');
      return null;
    }
    return v;
  };
  const expected = e ? { contentHash: hash(e.contentHash, 'contentHash'), guidelineHash: hash(e.guidelineHash, 'guidelineHash'), evidenceHash: e.evidenceHash === undefined ? undefined : hash(e.evidenceHash, 'evidenceHash') } : null;
  return { errors: c.errors, value: { submissionId, revision, passages, expected } };
}

export function validateReviewRequest(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const revision = c.num(b.revision, 'revision', { min: 1, max: 1e6, int: true });
  const expected = readExpected(b.expected, c);
  return { errors: c.errors, value: { revision, expected } };
}

// ---------- guidelines ----------

function readSource(s, c, path, { allowLink = false } = {}) {
  s = c.obj(s, path);
  if (s.sourceId !== undefined && s.sourceId !== null && s.sourceId !== '') {
    // A registered-evidence link. The client only CHOOSES source, version and span; the server cuts the quote out of the
    // registered text and rewrites doc/section/quote. A quote sent along is only checked, never trusted.
    if (!allowLink) {
      c.err(`${path}.sourceId`, 'registered evidence can only be linked from terminology rules and approved facts');
      return { doc: '', section: '', quote: '' };
    }
    if (typeof s.sourceId !== 'string' || !/^SRC-[0-9]{1,9}$/.test(s.sourceId)) c.err(`${path}.sourceId`, 'must look like SRC-1');
    const version = c.num(s.version, `${path}.version`, { min: 1, max: 1e6, int: true });
    const start = c.num(s.start, `${path}.start`, { min: 0, max: 1e6, int: true });
    const end = c.num(s.end, `${path}.end`, { min: 1, max: 1e6, int: true });
    const out = { sourceId: s.sourceId, version, start, end };
    if (s.quote !== undefined && s.quote !== null) {
      if (typeof s.quote !== 'string' || s.quote.length > 600) c.err(`${path}.quote`, 'must be text of at most 600 characters');
      else out.clientQuote = s.quote;
    }
    return out;
  }
  return {
    doc: c.str(s.doc, `${path}.doc`, { required: true, max: 120 }),
    section: c.str(s.section, `${path}.section`, { required: true, max: 80 }),
    quote: c.str(s.quote, `${path}.quote`, { required: true, max: 400 }),
  };
}

function phraseList(v, c, path, { max, min = 0, itemMax = 60 }) {
  const list = c.arr(v, path, { max, min });
  const out = [];
  list.forEach((p, i) => {
    const s = c.str(p, `${path}[${i}]`, { required: true, max: itemMax });
    if (s) out.push(s);
  });
  return out;
}

const ID_PREFIX = { term: 'TRM', fact: 'FCT', color: 'COL' };

function readId(v, prefix, c, path) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !new RegExp(`^${prefix}-\\d{3,}$`).test(v)) {
    c.err(path, `must look like ${prefix}-001`);
    return null;
  }
  return v;
}

export function validateGuidelines(input) {
  const c = new Collector();
  const g = c.obj(input, 'guidelines');
  const brand = c.obj(g.brand, 'brand');
  const out = {
    brand: {
      name: c.str(brand.name, 'brand.name', { required: true, max: 80 }),
      fictional: c.bool(brand.fictional, 'brand.fictional'),
      summary: c.str(brand.summary, 'brand.summary', { max: 300 }),
    },
    terms: [],
    facts: [],
    palette: null,
    accessibility: null,
    altText: null,
    claims: null,
    style: null,
  };

  c.arr(g.terms, 'terms', { max: LIMITS.terms }).forEach((t, i) => {
    const p = `terms[${i}]`;
    t = c.obj(t, p);
    const term = {
      id: readId(t.id, 'TRM', c, `${p}.id`),
      kind: c.oneOf(t.kind, `${p}.kind`, TERM_KINDS, 'banned'),
      preferred: c.str(t.preferred, `${p}.preferred`, { max: 80 }),
      enforceCase: c.bool(t.enforceCase, `${p}.enforceCase`),
      avoid: [],
      reason: c.str(t.reason, `${p}.reason`, { required: true, max: 300 }),
      severity: c.oneOf(t.severity, `${p}.severity`, ENUM_SEVERITY, 'warning'),
      source: readSource(t.source, c, `${p}.source`, { allowLink: true }),
    };
    c.arr(t.avoid, `${p}.avoid`, { max: 30 }).forEach((a, j) => {
      a = c.obj(a, `${p}.avoid[${j}]`);
      const text = c.str(a.text, `${p}.avoid[${j}].text`, { required: true, max: 80 });
      const replacement = c.str(a.replacement, `${p}.avoid[${j}].replacement`, { max: 80 });
      if (text) term.avoid.push({ text, replacement: replacement || null });
    });
    if (term.kind === 'naming' && !term.preferred) c.err(`${p}.preferred`, 'is required for naming rules');
    if (term.avoid.length === 0 && !(term.preferred && term.enforceCase)) {
      c.err(`${p}.avoid`, 'needs at least one phrase to avoid, or a preferred name with case enforcement');
    }
    out.terms.push(term);
  });

  c.arr(g.facts, 'facts', { max: LIMITS.facts }).forEach((f, i) => {
    const p = `facts[${i}]`;
    f = c.obj(f, p);
    const type = c.oneOf(f.type, `${p}.type`, ['numeric', 'statement'], 'numeric');
    const fact = {
      id: readId(f.id, 'FCT', c, `${p}.id`),
      type,
      label: c.str(f.label, `${p}.label`, { required: true, max: 80 }),
      statement: c.str(f.statement, `${p}.statement`, { required: true, max: 300 }),
      source: readSource(f.source, c, `${p}.source`, { allowLink: true }),
    };
    if (type === 'numeric') {
      fact.topicTerms = phraseList(f.topicTerms, c, `${p}.topicTerms`, { max: 20, min: 1 });
      fact.unit = c.str(f.unit, `${p}.unit`, { required: true, max: 20 });
      fact.unitAliases = phraseList(f.unitAliases, c, `${p}.unitAliases`, { max: 10, itemMax: 20 });
      if (fact.unit && !fact.unitAliases.includes(fact.unit)) fact.unitAliases.unshift(fact.unit);
      fact.value = c.num(f.value, `${p}.value`, { min: 0, max: 1e9 });
      fact.claimRule = c.oneOf(f.claimRule, `${p}.claimRule`, ['exact', 'at-most'], 'exact');
      // Optional, additive scope. Absent means "not recorded" (the checks then never rewrite the figure on their own);
      // the keys are left out when absent so guideline hashes of older versions stay unchanged.
      if (f.conditions !== undefined && f.conditions !== null) {
        fact.conditions = phraseList(f.conditions, c, `${p}.conditions`, { max: 5, itemMax: 80 });
      }
      if (f.conditionTerms !== undefined && f.conditionTerms !== null) {
        fact.conditionTerms = phraseList(f.conditionTerms, c, `${p}.conditionTerms`, { max: 10, itemMax: 40 });
      }
    } else {
      fact.contradictedBy = phraseList(f.contradictedBy, c, `${p}.contradictedBy`, { max: 20 });
      fact.confirmedBy = phraseList(f.confirmedBy, c, `${p}.confirmedBy`, { max: 20 });
      if (!fact.contradictedBy.length && !fact.confirmedBy.length) {
        c.err(`${p}.contradictedBy`, 'needs at least one contradicting or confirming phrase');
      }
    }
    out.facts.push(fact);
  });

  const pal = c.obj(g.palette, 'palette');
  out.palette = {
    ruleId: 'PAL-001',
    tolerance: c.num(pal.tolerance, 'palette.tolerance', { min: 0, max: 50, dflt: 10 }),
    source: readSource(pal.source, c, 'palette.source'),
    colors: [],
  };
  c.arr(pal.colors, 'palette.colors', { max: LIMITS.palette, min: 1 }).forEach((col, i) => {
    const p = `palette.colors[${i}]`;
    col = c.obj(col, p);
    out.palette.colors.push({
      id: readId(col.id, 'COL', c, `${p}.id`),
      name: c.str(col.name, `${p}.name`, { required: true, max: 60 }),
      hex: c.hex(col.hex, `${p}.hex`, { nullable: false }),
    });
  });

  const acc = c.obj(g.accessibility, 'accessibility');
  out.accessibility = {
    ruleId: 'ACC-001',
    minNormal: c.num(acc.minNormal, 'accessibility.minNormal', { min: 1, max: 21, dflt: 4.5 }),
    minLarge: c.num(acc.minLarge, 'accessibility.minLarge', { min: 1, max: 21, dflt: 3 }),
    source: readSource(acc.source, c, 'accessibility.source'),
  };

  const alt = c.obj(g.altText, 'altText');
  out.altText = {
    ruleId: 'ACC-002',
    minLength: c.num(alt.minLength, 'altText.minLength', { min: 0, max: 200, int: true, dflt: 20 }),
    source: readSource(alt.source, c, 'altText.source'),
  };

  const claims = c.obj(g.claims, 'claims');
  out.claims = {
    ruleId: 'CLM-001',
    signals: phraseList(claims.signals, c, 'claims.signals', { max: 100 }),
    flagPercentages: c.bool(claims.flagPercentages, 'claims.flagPercentages', true),
    source: readSource(claims.source, c, 'claims.source'),
  };

  const style = c.obj(g.style, 'style');
  const ex = c.obj(style.exclamation, 'style.exclamation');
  out.style = {
    exclamation: {
      ruleId: 'STY-001',
      max: c.num(ex.max, 'style.exclamation.max', { min: 0, max: 10, int: true, dflt: 1 }),
      source: readSource(ex.source, c, 'style.exclamation.source'),
    },
  };

  return { errors: c.errors, value: out };
}

/** Fill in missing ids. `reserved` holds the highest number ever used per prefix (across all versions). */
export function assignIds(g, reserved = {}) {
  const next = {};
  const lists = { term: g.terms, fact: g.facts, color: g.palette.colors };
  for (const [kind, list] of Object.entries(lists)) {
    const prefix = ID_PREFIX[kind];
    let max = reserved[prefix] || 0;
    for (const e of list) {
      if (e.id) max = Math.max(max, Number(e.id.slice(prefix.length + 1)));
    }
    next[kind] = max;
  }
  const ids = new Set();
  for (const [kind, list] of Object.entries(lists)) {
    const prefix = ID_PREFIX[kind];
    for (const e of list) {
      if (!e.id) e.id = `${prefix}-${String(++next[kind]).padStart(3, '0')}`;
      if (ids.has(e.id)) throw Object.assign(new Error(`Duplicate id ${e.id}`), { duplicateId: e.id });
      ids.add(e.id);
    }
  }
  return g;
}

export function highestIds(guidelines) {
  const out = {};
  const lists = { TRM: guidelines.terms, FCT: guidelines.facts, COL: guidelines.palette.colors };
  for (const [prefix, list] of Object.entries(lists)) {
    out[prefix] = list.reduce((m, e) => Math.max(m, Number(e.id.slice(prefix.length + 1))), 0);
  }
  return out;
}

// ---------- source registry ----------

const SRC = { title: 120, filename: 120, note: 500, url: 300, raw: 200_000 };

function optionalUrl(v, c, path) {
  if (v === undefined || v === null || v === '') return null;
  const s = c.str(v, path, { max: SRC.url });
  if (s && !/^https?:\/\/[^\s<>"']+$/i.test(s)) c.err(path, 'must be an http or https address (stored as a label only; it is never opened)');
  return s || null;
}

function sourceText(v, c, path) {
  if (typeof v !== 'string') {
    c.err(path, 'is required');
    return '';
  }
  if (v.length > SRC.raw) c.err(path, 'is too long');
  return v; // normalised and size-checked by the registry (it owns the text rules)
}

function origin(v, c) {
  return c.oneOf(v, 'origin', ['paste', 'file'], 'paste');
}

export function validateNewSource(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const value = {
    title: c.str(b.title, 'title', { required: true, max: SRC.title }),
    filename: c.str(b.filename, 'filename', { max: SRC.filename }) || null,
    url: optionalUrl(b.url, c, 'url'),
    origin: origin(b.origin, c),
    text: sourceText(b.text, c, 'text'),
    note: c.str(b.note, 'note', { max: SRC.note, multiline: true }),
  };
  return { errors: c.errors, value };
}

export function validateNewSourceVersion(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const value = {
    baseVersion: c.num(b.baseVersion, 'baseVersion', { min: 1, max: 1e6, int: true }),
    filename: c.str(b.filename, 'filename', { max: SRC.filename }) || null,
    origin: origin(b.origin, c),
    text: sourceText(b.text, c, 'text'),
    note: c.str(b.note, 'note', { max: SRC.note, multiline: true }),
  };
  return { errors: c.errors, value };
}

/** Optional: the digest of the impact preview the manager read. When present the server refuses the write if it is stale. */
function readPreviewDigest(b, c) {
  if (b.previewDigest === undefined || b.previewDigest === null) return null;
  if (typeof b.previewDigest === 'string' && /^[0-9a-f]{64}$/.test(b.previewDigest)) return b.previewDigest;
  c.err('previewDigest', 'must be the 64-character digest of an impact preview');
  return null;
}

export function validateSourceApproval(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  const sha = typeof b.expectedSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.expectedSha256) ? b.expectedSha256 : null;
  if (!sha) c.err('expectedSha256', 'must be the 64-character digest of the text you reviewed');
  return { errors: c.errors, value: { expectedSha256: sha, note: c.str(b.note, 'note', { max: SRC.note, multiline: true }), previewDigest: readPreviewDigest(b, c) } };
}

export function validateSourceRejection(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  return { errors: c.errors, value: { note: c.str(b.note, 'note', { required: true, max: SRC.note, multiline: true }) } };
}

export function validateSourceWithdrawal(body) {
  const c = new Collector();
  const b = c.obj(body, 'body');
  return {
    errors: c.errors,
    value: {
      expectedActiveVersion: c.num(b.expectedActiveVersion, 'expectedActiveVersion', { min: 1, max: 1e6, int: true }),
      note: c.str(b.note, 'note', { required: true, max: SRC.note, multiline: true }),
      previewDigest: readPreviewDigest(b, c),
    },
  };
}
