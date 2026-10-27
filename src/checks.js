/**
 * Deterministic brand checks. Pure functions: (content, guidelines) -> findings.
 *
 * Finding statuses
 *   violation    breaks an explicit guideline rule (term, style, palette, contrast, alt text)
 *   contradicted conflicts with an approved fact (cites that fact)
 *   unverified   makes a claim no approved fact covers. NOT "false": it only lacks evidence,
 *                so it cites the substantiation policy and carries no fact evidence.
 *   needs_review a figure/phrase may relate to an approved fact but the wording is too ambiguous
 *                (negation, qualifier, different clause) to call it supported or contradicted
 *   supported    consistent with an approved fact / rule (shown as positive evidence)
 */
import { contrastRatio, displayRatio, nearestColor } from './color.js';
import { escapeRegExp } from './util.js';

const BEFORE = '(?<![\\p{L}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{N}_])';

const phraseRegex = (p) => new RegExp(BEFORE + escapeRegExp(p) + AFTER, 'giu');

function* matches(re, text) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    yield m;
    if (m[0].length === 0) re.lastIndex++;
  }
}

export function splitSentences(text) {
  const out = [];
  const re = /[.!?]+(?=\s|$)|\n+/g;
  const push = (s, e) => {
    const seg = text.slice(s, e);
    const start = s + (seg.length - seg.trimStart().length);
    const end = s + seg.trimEnd().length;
    if (end > start) out.push({ start, end, text: text.slice(start, end) });
  };
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    push(start, m[0][0] === '\n' ? m.index : m.index + m[0].length);
    start = m.index + m[0].length;
  }
  push(start, text.length);
  return out;
}


function mk(f) {
  const span = f.span ?? null;
  return {
    id: `${f.ruleId}|${f.field}|${span ? span.start + '-' + span.end : f.key ?? ''}`,
    field: f.field,
    ruleId: f.ruleId,
    ruleKind: f.ruleKind,
    status: f.status,
    severity: f.severity,
    title: f.title,
    explanation: f.explanation,
    span,
    quote: f.quote ?? null,
    source: f.source ?? null,
    evidence: f.evidence ?? [],
    correction: f.correction ?? null,
    measured: f.measured ?? null,
  };
}

const spanOf = (m, offset = 0) => ({ start: offset + m.index, end: offset + m.index + m[0].length });

function matchCase(matched, replacement) {
  if (/^\p{Lu}/u.test(matched) && /^\p{Ll}/u.test(replacement) && matched !== matched.toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function checkTerms(field, text, terms, out) {
  for (const t of terms) {
    const seen = new Set();
    const add = (m, replacement) => {
      const span = spanOf(m);
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      const quote = m[0];
      const correction = replacement
        ? { type: 'replace', replacement: t.kind === 'naming' ? replacement : matchCase(quote, replacement) }
        : { type: 'advice', text: t.preferred ? `Use “${t.preferred}”.` : 'Rephrase without this term; describe what the product does instead.' };
      out.push(
        mk({
          field,
          ruleId: t.id,
          ruleKind: 'terminology',
          status: 'violation',
          severity: t.severity,
          title: t.kind === 'naming' ? `Use “${t.preferred}”` : `Avoid “${quote}”`,
          explanation: t.reason,
          span,
          quote,
          source: t.source,
          correction,
        }),
      );
    };
    for (const a of t.avoid) for (const m of matches(phraseRegex(a.text), text)) add(m, a.replacement);
    if (t.enforceCase && t.preferred) {
      for (const m of matches(phraseRegex(t.preferred), text)) if (m[0] !== t.preferred) add(m, t.preferred);
    }
  }
}

function checkExclamations(text, rule, out) {
  let i = 0;
  for (const m of matches(/!+/g, text)) {
    const tooMany = i >= rule.max;
    if (tooMany || m[0].length > 1) {
      out.push(
        mk({
          field: 'text',
          ruleId: rule.ruleId,
          ruleKind: 'style',
          status: 'violation',
          severity: 'warning',
          title: tooMany ? 'Too many exclamation marks' : 'Repeated exclamation marks',
          explanation: `Copy may use at most ${rule.max} exclamation mark${rule.max === 1 ? '' : 's'}, each written once.`,
          span: spanOf(m),
          quote: m[0],
          source: rule.source,
          correction: { type: 'replace', replacement: tooMany ? '.' : '!' },
        }),
      );
    }
    i++;
  }
}

function parseNumber(s) {
  return Number(s.replace(/,(?=\d{3}(?!\d))/g, '').replace(',', '.'));
}

const fmt = (n) => String(Number(n.toFixed(6)));

function numberUnitRegex(aliases) {
  const alts = [...aliases].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_.,])(\\d+(?:[.,]\\d+)?)[\\s\\u00A0-]*(?:${alts})${AFTER}`, 'giu');
}

const factEvidence = (f, type = 'approved-fact') => [{ type, id: f.id, label: f.label, statement: f.statement, quote: f.source.quote }];

// A sentence is split into clauses; a figure is only compared with a fact when the fact's
// topic is in the SAME clause. Anything murkier becomes "needs review", never a guess.
const CLAUSE_BREAK = /[,;:()—–]|\s-\s|\b(?:and|but|while|whereas|although|though|yet)\b/giu;

function splitClauses(sentence) {
  const out = [];
  const push = (s, e) => {
    const seg = sentence.text.slice(s, e);
    const start = s + (seg.length - seg.trimStart().length);
    const end = s + seg.trimEnd().length;
    if (end > start) out.push({ start: sentence.start + start, end: sentence.start + end, text: sentence.text.slice(start, end) });
  };
  let start = 0;
  for (const m of matches(new RegExp(CLAUSE_BREAK.source, 'giu'), sentence.text)) {
    push(start, m.index);
    start = m.index + m[0].length;
  }
  push(start, sentence.text.length);
  return out;
}

const NEGATION = /(?:\bnot|\bnever|\bno|\bnon|n['’]t)[\s-]+(?:[\p{L}'’-]+\s+){0,2}$/iu;
const NOT_ONLY = /\bnot\s+(?:only|just)\b/iu;
const isNegated = (before) => NEGATION.test(before) && !NOT_ONLY.test(before.slice(-30));

const QUALIFIERS = [
  ['upper', /(?:up\s+to|under|below|less\s+than|at\s+most|no\s+more\s+than|maximum\s+of|max\.?)\s*$/iu],
  ['over', /(?:over|more\s+than|above|exceeding|beyond)\s*$/iu],
  ['least', /(?:at\s+least|no\s+less\s+than|minimum\s+of|min\.?|\+)\s*$/iu],
  ['approx', /(?:about|around|approximately|approx\.?|roughly|nearly|almost|~)\s*$/iu],
];

function qualifierOf(before) {
  for (const [kind, re] of QUALIFIERS) {
    const m = re.exec(before);
    if (m) return { kind, rest: before.slice(0, m.index) };
  }
  return { kind: 'plain', rest: before };
}

// ---------- scope and strength of a numeric claim ----------
// An approved "up to N" fact does NOT establish that a product lasts N, always lasts N, or is guaranteed to last at least N,
// and it was approved for ITS subject and ITS conditions. The checks below decide only what can be decided from the words:
// anything else is reported as "needs review" with advice for a person, never as green support and never as an automatic rewrite.
const GUARANTEE = /(?<![\p{L}\p{N}_])(?:guarantee[ds]?|guaranteeing|promise[ds]?|promising|ensure[ds]?|ensuring|assured|at least|minimum|no less than|not less than|never (?:less|fewer|below))(?![\p{L}\p{N}_])/iu;
const EXACT_WORD = /(?<![\p{L}\p{N}_])(?:exactly|precisely|always|every time|without fail|consistently)(?![\p{L}\p{N}_])/iu;
const OTHER_SUBJECT = /(?<![\p{L}\p{N}_])(?:competitors?|competition|rivals?|other (?:brands?|lamps?|products?|makers?|manufacturers?|models?)|others?|their|theirs)(?![\p{L}\p{N}_])/iu;
const ATTRIBUTION = /(?<![\p{L}\p{N}_])(?:says?|said|claims?|claimed|claiming|according to|reports?|reported|reviewers?|allegedly|wrote|states?|stated)(?![\p{L}\p{N}_])/iu;

// A figure inside a DENIED or RETIRED claim: the sentence tells people NOT to make the claim ("Do not advertise that the
// battery lasts 30 hours"), or says the figure is old, withdrawn or wrong ("The old specification of 30 hours was incorrect").
// Replacing such a figure with the approved one would turn the instruction or the history into a different statement, so these
// are sent to a person and never rewritten. This is a bounded word list, not an understanding of language: wording outside it
// (other phrasings, other languages, an implied denial) is still judged as an ordinary claim. See docs/claims-scope.md.
const DENY_LEAD = /(?<![\p{L}\p{N}_])(?:do(?:es)?\s*n[o'’]t|do(?:es)?\s+not|don[’']t|never|must\s*n[o'’]t|must\s+not|should\s*n[o'’]t|should\s+not|cannot|can[’']?t|may\s+not|avoid\w*|stop(?:s|ped)?|refrain\w*|no\s+longer|not\s+to|prohibit\w*|forbid\w*|forbidden|ban(?:ned)?|not\s+allowed\s+to)(?![\p{L}\p{N}_])/iu;
const DENY_VERB = /(?<![\p{L}\p{N}_])(?:advertis\w*|claim\w*|say\w*|stat\w*|promis\w*|market\w*|promot\w*|publish\w*|print\w*|writ\w*|mention\w*|us(?:e|es|ed|ing)|quot\w*|cit\w*|repeat\w*|list\w*|show\w*|display\w*|impl\w*|suggest\w*|boast\w*|tout\w*|assert\w*|declar\w*|put|include\w*|offer\w*|guarantee\w*|call\w*|describe\w*|present\w*|communicat\w*|share\w*|post\w*|tell\w*|speak\w*|announc\w*|give\w*)(?![\p{L}\p{N}_])/iu;
const DENIED_DIRECTIVE = new RegExp(`${DENY_LEAD.source}[^.!?]{0,60}?${DENY_VERB.source}`, 'iu');
const RETIRED_FIGURE = /(?<![\p{L}\p{N}_])(?:incorrect(?:ly)?|wrong(?:ly)?|mistaken(?:ly)?|erroneous(?:ly)?|inaccura\w+|misprints?|typos?|errors?|untrue|false(?:ly)?|outdated|out[\s-]of[\s-]date|obsolete|superseded|retire[ds]?|retiring|deprecated|discontinu\w*|withdrawn|withdraw|scrap(?:ped|ping)?|drop(?:ped)?|overstated|exaggerated|misleading|old|older|former(?:ly)?|previous(?:ly)?|no\s+longer|used\s+to)(?![\p{L}\p{N}_])/iu;

function insideQuote(sentence, idx) {
  const before = sentence.slice(0, idx);
  const straight = (before.match(/"/g) ?? []).length % 2 === 1;
  const curly = before.lastIndexOf('“') > before.lastIndexOf('”');
  return straight || curly;
}

// ---------- applicability: whose claim is it, and is the sentence a claim at all? (m25) ----------
// An approved fact was approved for ITS subject (here the Aurora Lamp). The first checks matched a topic word and a figure in one clause and nothing
// else, so "Our phone battery lasts up to 12 hours" and "The office printer includes a 2-year warranty" were shown as SUPPORTED by lamp facts, and an
// editing instruction ("Please delete the sentence: …lasts 30 hours") was rewritten as if it were a product claim. Two conservative gates now sit in
// front of every verdict, and anything they cannot place goes to a person, never to green support and never to an automatic rewrite:
//   1. SUBJECT (positive scope, m25b). A sentence is read as about the approved product only when its words say so (the product's name next to the claim,
//      with nothing unknown between the name and the claim) or say nothing about any subject (every word is ordinary wording, claim-strength wording, a
//      word of the fact itself or part of the brand or product name). Any other word in the subject position, whatever part of speech ("phone", "printer",
//      "flaunt"), makes the subject unknown, and an unknown subject goes to a person. See unplacedIn and foreignSubject below.
//   2. INTENT. A sentence that is an editing instruction ("delete the sentence", "this line should be removed"), or that disowns itself as an example,
//      placeholder or fictional text, is not asserting the figure; replacing its number would change what the instruction says.
// These are closed word classes and shapes, NOT language understanding and NOT a list of wrong nouns: the rule is "unknown subject → person". A
// workspace that declares no product name (no naming rule besides the company) has no subject to compare with, so the subject gate stays off there.
// What it costs and what it misses: docs/claims-scope.md ("Subject and intent", m25).
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'our', 'your', 'their', 'its', 'my', 'his', 'her', 'each', 'every', 'any', 'another', 'some', 'all', 'both']);
// Words that end a phrase but are never a subject: prepositions, conjunctions, pronouns, adverbs, auxiliaries.
const PHRASE_BREAKS = new Set(`of for with without on in at by from to into onto over under per after before during up out off about around across than as inside within aboard through between among against near via
  and or but so if while when then yet also just only now here there even still more most very really totally completely fully truly simply always never not no too quite almost nearly roughly approximately
  we you they it i he she them us me him what which who whose where how why`.split(/\s+/u));
// Common verbs that attach a figure to a subject ("<subject> lasts / includes / comes with / has …") and the usual marketing imperatives ("Enjoy up to …").
const SUBJECT_VERBS = new Set(`is are was were be been being am isnt arent wasnt werent has have had having does do did doesnt dont didnt will would can could may might must should shall cannot cant wont
  include includes included including come comes came coming carry carries carried offer offers offered provide provides provided deliver delivers delivered give gives gave given feature features featured
  last lasts lasted lasting run runs ran running keep keeps kept cover covers covered backed backs back support supports get gets got use uses used enjoy enjoys expect expects experience experiences
  power powers powered read reads work works boast boasts sport sports pack packs bring brings ships ship need needs go goes going went stay stays staying hold holds holding`.split(/\s+/u));
// Ordinary descriptive and quantity words that say nothing about WHICH product a sentence is about.
const NEUTRAL_WORDS = new Set(`new newest latest great good best better long longer short big small little full extra whole entire brand same own many much few single one two three first second next
  hour hours hr hrs day days week weeks month months year years yr yrs minute minutes min mins second seconds time times limited
  designed built made rated tested engineered ideal perfect suited`.split(/\s+/u));

// Wording about HOW STRONGLY a figure is claimed (the guarantee, exactness, qualifier and hedge gates above already judge these): never a subject.
const CLAIM_STRENGTH = new Set(`guarantee guaranteed guarantees guaranteeing promise promised promises promising ensure ensured ensures ensuring assured least minimum maximum exactly precisely
  always consistently exact typically typical fail less more under below above over exceeding beyond max min about around approximately approx roughly nearly almost
  might may could would should must possibly perhaps probably`.split(/\s+/u));

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
/** Words of a phrase, lower-cased, possessive "'s" removed. `numeric` marks tokens that hold a digit ("12", "2-year", "100%"). */
function wordsOf(text) {
  const out = [];
  for (const m of text.matchAll(WORD)) {
    const raw = m[0].toLowerCase().replace(/['’]s$/u, '').replace(/['’]/gu, '');
    out.push({ w: raw, numeric: /\p{N}/u.test(raw), at: m.index, end: m.index + m[0].length });
  }
  return out;
}
const hasWord = (set, w) => set.has(w) || w.split('-').every((p) => set.has(p));

const factVocabulary = new WeakMap();
/** The words an approved fact itself uses: its label, statement, source quote, topic, unit and condition words. */
function vocabularyOf(f) {
  let v = factVocabulary.get(f);
  if (v) return v;
  v = new Set();
  const add = (s) => {
    for (const x of wordsOf(String(s ?? ''))) for (const p of x.w.split('-')) if (p) v.add(p);
  };
  for (const s of [f.label, f.statement, f.source?.quote, ...(f.topicTerms ?? []), ...(f.unitAliases ?? []), ...(f.conditions ?? []), ...(f.conditionTerms ?? []), ...(f.confirmedBy ?? []), ...(f.contradictedBy ?? [])]) add(s);
  factVocabulary.set(f, v);
  return v;
}

const approvedSubjects = new WeakMap();
/** What the approved data says the facts are ABOUT: product names (naming rules other than the company name) and the noun each ends in; brand words are known but name no product. */
function subjectsOf(guidelines) {
  let s = approvedSubjects.get(guidelines);
  if (s) return s;
  const brand = String(guidelines.brand?.name ?? '').trim();
  const brandWords = new Set(wordsOf(brand).flatMap((x) => x.w.split('-')));
  const phrases = [];
  const heads = new Set();
  for (const t of guidelines.terms ?? []) {
    if (t.kind !== 'naming' || !t.preferred) continue;
    if (t.preferred.trim().toLowerCase() === brand.toLowerCase()) continue; // the company is not a product
    for (const p of [t.preferred, ...(t.avoid ?? []).map((a) => a.text)]) if (p) phrases.push(p);
    const parts = wordsOf(t.preferred);
    if (parts.length > 1) heads.add(parts.at(-1).w); // "Aurora Lamp" → "lamp"
  }
  const productWords = new Set(phrases.flatMap((p) => wordsOf(p).flatMap((x) => x.w.split('-'))));
  const trust = [...phrases.map(phraseRegex), ...[...heads].map(phraseRegex)];
  s = { active: phrases.length > 0, brandWords, productWords, trust, name: guidelines.terms?.find((t) => t.kind === 'naming' && t.preferred && t.preferred.trim().toLowerCase() !== brand.toLowerCase())?.preferred ?? 'the approved product' };
  approvedSubjects.set(guidelines, s);
  return s;
}

/**
 * POSITIVE SCOPE (m25b). Which words of a stretch of the sentence are unaccounted for?
 * A word is accounted for when it is ordinary wording (a determiner, preposition, conjunction, pronoun, adverb, auxiliary or one of the usual verbs that attach a
 * figure to a subject, or an ordinary descriptive or quantity word), a word the approved fact itself uses, or part of the product's or the company's name.
 * Anything else is UNKNOWN, whatever part of speech it is: an unfamiliar verb is as unknown as an unfamiliar noun ("Printers flaunt …").
 * The product's name settles only the words it actually governs. A stretch that names the product is about the product when nothing unknown stands between the
 * name and the claim, and only the words immediately before the name (up to its determiner) are excused as describing it ("our new reading lamp"). So the name
 * never blesses a possessive phrase about something else ("Aurora Lamp owners' phone battery": "owners" and "phone" follow the name and are unknown).
 */
function unplacedIn(text, f, subj) {
  const words = wordsOf(text);
  const vocab = vocabularyOf(f);
  const known = (w) => DETERMINERS.has(w) || PHRASE_BREAKS.has(w) || SUBJECT_VERBS.has(w) || CLAIM_STRENGTH.has(w) || hasWord(NEUTRAL_WORDS, w) || hasWord(vocab, w) || hasWord(subj.productWords, w) || hasWord(subj.brandWords, w);
  const unknown = (x) => !x.numeric && !known(x.w);
  let anchor = null; // the last place the product is named: { start, end } in characters
  for (const re of subj.trust) {
    re.lastIndex = 0; // the cached patterns are global: reset them, or .test()/.exec() would remember where the last text matched
    for (const m of text.matchAll(re)) if (!anchor || m.index + m[0].length > anchor.end) anchor = { start: m.index, end: m.index + m[0].length };
  }
  if (!anchor) return words.filter(unknown).map((x) => x.w);
  // the words right before the name, back to (and including) a determiner, describe the product; stop at anything that is not a modifier
  let excusedFrom = anchor.start;
  const before = words.filter((x) => x.end <= anchor.start);
  for (let k = before.length - 1; k >= 0; k--) {
    const x = before[k];
    if (x.numeric || SUBJECT_VERBS.has(x.w) || (PHRASE_BREAKS.has(x.w) && !DETERMINERS.has(x.w))) break;
    excusedFrom = x.at;
    if (DETERMINERS.has(x.w)) break;
  }
  return words.filter((x) => unknown(x) && !(x.at >= excusedFrom && x.end <= anchor.start)).map((x) => x.w);
}

/** The noun phrase a topic term ends: walk back from `at` to its determiner (kept) or to a verb, a preposition or conjunction, or a figure (not kept). Returns the start offset. */
function phraseStart(text, at) {
  const lead = wordsOf(text.slice(0, at));
  let start = at;
  for (let k = lead.length - 1; k >= 0; k--) {
    const x = lead[k];
    if (x.numeric || SUBJECT_VERBS.has(x.w) || (PHRASE_BREAKS.has(x.w) && !DETERMINERS.has(x.w))) break;
    start = x.at;
    if (DETERMINERS.has(x.w)) break;
  }
  return start;
}

/**
 * Does the sentence say, or leave open, that this fact is about something other than the approved product? Returns the unknown words or null.
 * `before` is the clause text before the figure (or before the matched phrase), `after` the clause text after it, `topic(text)` finds the fact's first topic term
 * ({ index, length }). Positive scope: the claim is read as about the approved product only if the words that stand for its subject name the product or are all
 * accounted for (see unplacedIn). Which words stand for the subject:
 *  - when the first topic term in `before` is itself a verb ("The Aurora Lamp lasts …") or is followed by a verb ("a full charge lasts …"), the phrase that term
 *    ends, back to its determiner: whatever came before that belongs to another thought ("We tell readers a full charge lasts …");
 *  - otherwise everything before the figure ("Printers flaunt a …", "The battery of the phone lasts …", "Phones flaunt battery life of …");
 *  - plus, after the figure, the phrase around a topic noun ("12 hours of phone battery") and "on / in / for / from / inside / within / aboard the …" phrases.
 */
function foreignSubject({ f, subj, before, after = '', topic = null }) {
  if (!subj.active) return null; // no declared product: nothing to compare with (legacy behaviour)
  const found = (text) => {
    const r = unplacedIn(text, f, subj);
    return r.length ? [...new Set(r)] : null;
  };
  let lead = before;
  const t = topic ? topic(before) : null;
  if (t) {
    const bw = wordsOf(before);
    const next = bw.find((x) => x.at >= t.index + t.length);
    const topicIsVerb = wordsOf(before.slice(t.index, t.index + t.length)).some((x) => SUBJECT_VERBS.has(x.w));
    let npStart = -1;
    if (topicIsVerb) {
      npStart = phraseStart(before, t.index);
      lead = before.slice(npStart, t.index);
    } else if (next && SUBJECT_VERBS.has(next.w)) {
      npStart = phraseStart(before, t.index);
      lead = before.slice(npStart, t.index + t.length);
    }
    if (npStart >= 0) {
      // What came before the claim's own phrase belongs to another thought, except a prepositional adjunct right in front of it ("On the brightest setting | a full
      // charge lasts …"): that states where or when the claim holds, so its words must be accounted for too.
      const pre = wordsOf(before.slice(0, npStart));
      let from = -1;
      for (let k = pre.length - 1; k >= 0; k--) {
        const x = pre[k];
        if (['and', 'or', 'but', 'so', 'if', 'when', 'while'].includes(x.w) || SUBJECT_VERBS.has(x.w) || x.numeric) break;
        if (['on', 'in', 'under', 'at', 'with', 'during', 'using', 'for', 'from', 'inside', 'within'].includes(x.w)) {
          from = k;
          break;
        }
      }
      if (from > 0) {
        lead = before; // the preposition hangs on words before it ("Phone cases for | Aurora Lamp battery lasts"): the subject is among them, so the whole lead counts
      } else if (from === 0 && pre[from].end <= npStart) {
        const adjunct = found(before.slice(pre[from].end, npStart)); // a clause-initial adjunct ("On the brightest setting | a full charge lasts …")
        if (adjunct) return adjunct;
      }
    }
  }
  let hit = found(lead);
  if (hit) return hit;
  const t2 = topic ? topic(after) : null;
  if (t2) {
    hit = found(after.slice(phraseStart(after, t2.index), t2.index + t2.length));
    if (hit) return hit;
  }
  const pp = /(?<![\p{L}\p{N}_])(?:on|in|for|from|inside|within|aboard)\s+(?:the|a|an|our|your|their|this|that|its)\s+[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,3}/giu;
  for (const m of after.matchAll(pp)) {
    const words = wordsOf(m[0]).slice(1);
    const run = [];
    for (const x of words) {
      if (x.numeric || SUBJECT_VERBS.has(x.w) || (PHRASE_BREAKS.has(x.w) && !DETERMINERS.has(x.w))) break;
      run.push(x.w);
    }
    hit = found(run.join(' '));
    if (hit) return hit;
  }
  return null;
}

const firstTopicAt = (f, text) => {
  let best = null;
  for (const term of f.topicTerms ?? []) {
    const m = phraseRegex(term).exec(text);
    if (m && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length };
  }
  return best;
};

/** The two gates for a boolean fact's phrase: a note about the text, or an explicit subject the approved data does not know. Returns { why, detail } or null. */
function unsureWhose({ f, subj, s, previous, clauseText, at, length }) {
  if (isEditingNote(s.text, previous)) return { why: 'editing' };
  const foreign = foreignSubject({ f, subj, before: clauseText.slice(0, at), after: clauseText.slice(at + length) });
  return foreign ? { why: 'other-subject', detail: foreign } : null;
}

const TEXT_OBJECT = '(?:sentences?|claims?|lines?|text|copy|figures?|numbers?|statements?|paragraphs?|wording|phrases?|headlines?|slogans?|captions?|bullets?|passages?|quotes?|specs?|specifications?|stats?|content|blurb|banner|draft)';
const EDIT_VERB = '(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|omit(?:s|ted|ting)?|drop(?:s|ped|ping)?|cut(?:s|ting)?|strik(?:e|es|ing)|struck|eras(?:e|es|ed|ing)|redact(?:s|ed|ing)?|exclud(?:e|es|ed|ing)|leav(?:e|es|ing)\\s+out|left\\s+out|tak(?:e|es|ing)\\s+out|taken\\s+out|scrap(?:s|ped|ping)?|rewrit(?:e|es|ing|ten)|rewrote|revis(?:e|es|ed|ing)|reword(?:s|ed|ing)?|rephras(?:e|es|ed|ing)|edit(?:s|ed|ing)?|fix(?:es|ed|ing)?|correct(?:s|ed|ing)?|amend(?:s|ed|ing)?|chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|substitut(?:e|es|ed|ing)|flag(?:s|ged|ging)?|highlight(?:s|ed|ing)?)';
// "delete the sentence", "please remove this claim", "replace the number" (an instruction aimed at a piece of text) …
const EDIT_INSTRUCTION = new RegExp(`${BEFORE}${EDIT_VERB}${AFTER}[^.!?]{0,50}?${BEFORE}${TEXT_OBJECT}${AFTER}`, 'iu');
// … and "this line should be removed", "the figure needs to be corrected".
const EDIT_PASSIVE = new RegExp(`${BEFORE}${TEXT_OBJECT}${AFTER}[^.!?]{0,30}?${BEFORE}(?:should|must|needs?\\s+to|has\\s+to|have\\s+to|is\\s+to|ought\\s+to|to|will|can|could)\\s+(?:also\\s+)?be\\s+(?:deleted|removed|omitted|dropped|cut|struck|erased|redacted|excluded|scrapped|rewritten|revised|reworded|rephrased|edited|fixed|corrected|amended|changed|updated|replaced|flagged|left\\s+out|taken\\s+out)${AFTER}`, 'iu');
// A sentence that says it is not a real claim: an example, a placeholder, fictional or made-up text.
const DISOWNED = new RegExp(`${BEFORE}(?:fictional|fictitious|placeholder|dummy|lorem|hypothetical|made[\\s-]up|not\\s+real|(?:sample|example|test|draft|mock|fake)\\s+${TEXT_OBJECT})${AFTER}`, 'iu');
const POINTS_FORWARD = /(?<![\p{L}\p{N}_])(?:next|following|below|after|here|this one|that one|the one)(?![\p{L}\p{N}_])/iu;

/** Is this sentence a note or instruction about the text rather than a statement of the claim? `previous` is the sentence before it (an instruction may point forward). */
function isEditingNote(sentence, previous = '') {
  if (EDIT_INSTRUCTION.test(sentence) || EDIT_PASSIVE.test(sentence) || DISOWNED.test(sentence)) return true;
  return Boolean(previous) && EDIT_INSTRUCTION.test(previous) && POINTS_FORWARD.test(previous);
}

// Wording that describes how long a product lasts WITHOUT a figure ("continuously", "all day", "until midnight", "without needing a charge"). An approved
// "up to N hours" fact does not cover any of these, and no figure is there to compare, so it goes to a person. A short closed list for duration facts
// only (bounded coverage, not a paraphrase detector): other ways of saying it are still missed. See docs/claims-scope.md.
const ENDURANCE = new RegExp(
  `${BEFORE}(?:continuous(?:ly)?|non-?stop|round\\s+the\\s+clock|all\\s+day|all\\s+night|all\\s+week|day\\s+and\\s+night|days\\s+on\\s+end|forever|endless(?:ly)?|never\\s+(?:runs?\\s+out|dies|needs?\\s+(?:a\\s+)?(?:re)?charg\\w*)|without\\s+(?:ever\\s+)?(?:needing|requiring|having\\s+to\\s+(?:re)?charge|a\\s+(?:re)?charge)(?:\\s+(?:a\\s+|an\\s+)?(?:re)?charg\\w*)?|without\\s+(?:re)?charging|(?:until|till)\\s+(?:midnight|morning|evening|night|bedtime|dawn|dusk|sunrise|sunset)|from\\s+\\p{L}+\\s+(?:until|till|to)\\s+(?:midnight|morning|evening|night|bedtime|dawn|dusk|sunrise|sunset))${AFTER}`,
  'iu',
);
const isDuration = (f) => (f.unitAliases ?? []).some((u) => /^(?:hours?|hrs?|h|minutes?|mins?|days?|weeks?|months?)$/iu.test(u));

/**
 * Decide what one figure in one clause can honestly be called, against one numeric fact.
 * Returns { verdict: 'supported' | 'contradicted' | 'review', why?, fix?: 'replace' | 'advice', note? }.
 */
function judgeFigure({ f, c, m, s, clauses, ci, n, kind, rest, subj, previous }) {
  const clause = c.text;
  const figureAt = c.start - s.start + m.index;
  if (isNegated(rest)) return { verdict: 'review', why: 'negated' };
  if (OTHER_SUBJECT.test(clause)) return { verdict: 'review', why: 'subject' };
  // A note or instruction about the text is not a claim: never judged as one, never rewritten (its number is not ours to replace).
  if (isEditingNote(s.text, previous)) return { verdict: 'review', why: 'editing' };
  // Attribution is looked for in the three clauses before the figure, its own clause and the next one, and inside quotation marks.
  const nearby = clauses.slice(Math.max(0, ci - 3), ci + 2).map((x) => x.text).join(' ');
  if (ATTRIBUTION.test(nearby) || insideQuote(s.text, figureAt)) return { verdict: 'review', why: 'attributed' };
  // A denied or retired claim is judged by a person, whatever the figure is: never supported, never rewritten.
  const lead = `${clauses[ci - 1]?.text ?? ''} ${clause.slice(0, m.index)}`;
  if (DENIED_DIRECTIVE.test(lead) || RETIRED_FIGURE.test(s.text)) return { verdict: 'review', why: 'denied' };
  // Whose figure is it? An explicit subject the approved data does not know goes to a person, not to support, contradiction or a rewrite.
  const foreign = foreignSubject({ f, subj, before: rest, after: clause.slice(m.index + m[0].length), topic: (t) => firstTopicAt(f, t) });
  if (foreign) return { verdict: 'review', why: 'other-subject', detail: foreign };

  const guarantee = GUARANTEE.test(clause);
  const exactWord = EXACT_WORD.test(clause);
  const conditions = Array.isArray(f.conditions) ? f.conditions : null;
  // Conditions are read across the whole sentence: "30 hours, at maximum brightness" puts the condition in the next clause.
  const sentenceLower = s.text.toLowerCase();
  const mentionsConditionTopic = Boolean(f.conditionTerms?.some((t) => phraseRegex(t).test(s.text)));
  const statesApprovedCondition = Boolean(conditions?.some((p) => sentenceLower.includes(p.toLowerCase())));
  const conditionConflict = mentionsConditionTopic && !statesApprovedCondition;
  const eq = Math.abs(n - f.value) < 1e-9;

  if (f.claimRule === 'at-most') {
    if (kind === 'least') return { verdict: 'review', why: 'guarantee' };
    if (kind === 'over') return n >= f.value ? { verdict: 'contradicted', fix: 'advice' } : { verdict: 'review', why: 'qualifier' };
    if (kind === 'approx') return n > f.value ? { verdict: 'review', why: 'qualifier' } : { verdict: 'review', why: 'exact' };
    if (n > f.value) {
      // Beyond even the upper limit: contradicted whatever the wording. A rewrite is offered only when it keeps the approved
      // "up to" and conditions without surprises; otherwise a person must rewrite it.
      const after = clause.slice(m.index + m[0].length).replace(/[\s.!?]+$/u, '').trimStart();
      const cond0 = conditions?.[0];
      // What follows the figure must be empty, the approved condition itself, or a short neutral tail ("on a single charge").
      const tail = after === '' || (cond0 && after.toLowerCase().startsWith(cond0.toLowerCase())) || (after.split(/\s+/u).length <= 5 && !/\d/u.test(after));
      // A guarantee or "exactly" anywhere in the sentence would survive the rewrite and contradict it, so it blocks the rewrite too.
      const safe = conditions !== null && !GUARANTEE.test(s.text) && !EXACT_WORD.test(s.text) && !conditionConflict && tail;
      return { verdict: 'contradicted', fix: safe ? 'replace' : 'advice' };
    }
    // The figure is within the upper limit.
    if (conditionConflict) return { verdict: 'review', why: 'condition' };
    if (guarantee) return { verdict: 'review', why: 'guarantee' };
    if (kind === 'upper') {
      if (exactWord) return { verdict: 'review', why: 'exact' };
      const omitted = conditions?.length && !statesApprovedCondition;
      return { verdict: 'supported', note: omitted ? ` The approved fact applies ${conditions[0]}, which this sentence does not state.` : '' };
    }
    return { verdict: 'review', why: 'exact' }; // a plain figure ("lasts 8 hours") is not entailed by "up to 12"
  }

  // exact facts: the figure must equal the approved value
  if (kind === 'plain' || kind === 'upper') {
    if (eq) return conditionConflict ? { verdict: 'review', why: 'condition' } : { verdict: 'supported' };
    return { verdict: 'contradicted', fix: conditionConflict ? 'advice' : 'replace' };
  }
  if (kind === 'approx' && eq) return { verdict: 'supported' };
  return { verdict: 'review', why: 'qualifier' };
}

const REVIEW_WHY = {
  negated: 'the wording negates the figure',
  qualifier: 'the wording qualifies the figure (for example “over” or “at least”)',
  'different-clause': 'the figure and the fact’s topic are in different parts of the sentence',
  'negated-confirmation': 'the wording negates a phrase the approved fact confirms',
  guarantee: 'the wording promises the figure or sets a minimum (“guaranteed”, “at least”…), but the approved fact only sets an upper limit',
  exact: 'the figure is stated as exact or typical, but the approved fact only sets an upper limit (“up to …”)',
  condition: 'the sentence gives an operating condition that differs from the approved one',
  subject: 'the sentence appears to be about something other than the approved product (a competitor, other brands or a comparison)',
  attributed: 'the figure is quoted or attributed to someone else',
  denied: 'the sentence appears to tell people NOT to make this claim, or to say the figure is old, retired or wrong',
  editing: 'the sentence appears to be an instruction or a note about the text (for example “delete the sentence”, or an example or placeholder), not a claim',
  'other-subject': (words) => `the sentence appears to be about something the approved fact does not mention (${words.map((w) => `“${w}”`).join(', ')}), not about the approved product`,
  unquantified: 'the sentence describes how long the product lasts without a figure the approved fact can be compared with',
};

function reviewAdvice(f, why, detail, subj) {
  const cond = Array.isArray(f.conditions) && f.conditions[0];
  switch (why) {
    case 'guarantee':
    case 'exact':
      return `A person should rewrite it to match the approved fact, keeping its “up to” and conditions: “${f.statement}”`;
    case 'condition':
      return `A person should rewrite it to match the approved fact${cond ? `, which applies “${cond}”` : ''}: “${f.statement}” Another condition needs a new approved fact; nothing is rewritten automatically.`;
    case 'subject':
      return 'Check whose figure this is. An approved fact about our product cannot confirm or correct another subject’s figure, so nothing is rewritten automatically.';
    case 'denied':
      return `Nothing is rewritten automatically: replacing the figure could reverse what the sentence says (for example turn “Do not advertise 30 hours” into “Do not advertise up to 12 hours”). Read the sentence yourself. The approved fact is: “${f.statement}”`;
    case 'other-subject':
      return `Check what this sentence is about. The approved fact is about ${subj?.name ?? 'the approved product'}; it cannot confirm or correct a claim about ${(detail ?? []).map((w) => `“${w}”`).join(', ')}. If the sentence is about our product, say so; if it is about something else, it needs its own approved fact. Nothing is rewritten automatically.`;
    case 'editing':
      return `Nothing is rewritten automatically: the sentence reads as an instruction or a note about the text (for example “delete the sentence”), and replacing its figure could change what it says. Read it yourself and carry out the instruction if that is what it is. The approved fact is: “${f.statement}”`;
    case 'unquantified':
      return `A person should check what is promised. The approved fact is “${f.statement}”; it does not say the product lasts continuously or without recharging. Restate it with the approved “up to” figure and conditions, or ask a manager for an approved fact that supports it. Nothing is rewritten automatically.`;
    case 'attributed':
      return 'Check who said it. A quoted or attributed figure is not a claim about our product unless the copy adopts it, so nothing is rewritten automatically.';
    default:
      return 'Check the wording against the approved fact and make the claim explicit.';
  }
}

function reviewFinding(f, span, quote, why, detail, subj) {
  return mk({
    field: 'text',
    ruleId: f.id,
    ruleKind: 'fact',
    status: 'needs_review',
    severity: 'warning',
    title: `Needs review: ${f.label}`,
    explanation: `“${quote}” may relate to the approved fact “${f.statement}”, but ${typeof REVIEW_WHY[why] === 'function' ? REVIEW_WHY[why](detail) : REVIEW_WHY[why]}, so BrandProof cannot tell whether it matches. This is not a finding that the copy is wrong.`,
    span,
    quote,
    source: f.source,
    evidence: factEvidence(f, 'possibly-related-fact'),
    correction: { type: 'advice', text: reviewAdvice(f, why, detail, subj) },
  });
}

function checkFactsAndClaims(text, guidelines, out) {
  const { facts, claims } = guidelines;
  const subj = subjectsOf(guidelines);
  const covered = []; // spans already accounted for by a fact; only signals inside them are suppressed
  const overlaps = (m, off) => covered.some((c) => m.index + off < c.end && m.index + off + m[0].length > c.start);

  const sentences = splitSentences(text);
  for (const [si, s] of sentences.entries()) {
    const clauses = splitClauses(s);
    const previous = sentences[si - 1]?.text ?? '';

    for (const f of facts) {
      if (f.type === 'numeric') {
        const topicIn = (t) => f.topicTerms.some((term) => phraseRegex(term).test(t));
        const sentenceHasTopic = topicIn(s.text);
        const judgedBefore = covered.length;
        for (const [ci, c] of clauses.entries()) {
          for (const m of matches(numberUnitRegex(f.unitAliases), c.text)) {
            const span = spanOf(m, c.start);
            const quote = m[0];
            if (!topicIn(c.text)) {
              if (sentenceHasTopic) {
                covered.push(span);
                out.push(reviewFinding(f, span, quote, 'different-clause'));
              }
              continue;
            }
            covered.push(span);
            const { kind, rest } = qualifierOf(c.text.slice(0, m.index));
            const n = parseNumber(m[1]);
            const j = judgeFigure({ f, c, m, s, clauses, ci, n, kind, rest, subj, previous });
            if (j.verdict === 'review') {
              out.push(reviewFinding(f, span, quote, j.why, j.detail, subj));
            } else if (j.verdict === 'supported') {
              out.push(
                mk({
                  field: 'text',
                  ruleId: f.id,
                  ruleKind: 'fact',
                  status: 'supported',
                  severity: 'info',
                  title: `Matches approved fact: ${f.label}`,
                  explanation: `“${quote}” is consistent with the approved fact: ${f.statement}${j.note ?? ''}`,
                  span,
                  quote,
                  source: f.source,
                  evidence: factEvidence(f),
                }),
              );
            } else {
              const unit = m[0].slice(m[1].length);
              const after = c.text.slice(m.index + m[0].length);
              let replacement = null;
              if (j.fix === 'replace') {
                if (f.claimRule === 'at-most') {
                  const cond0 = f.conditions?.[0];
                  replacement = (kind === 'plain' ? 'up to ' : '') + fmt(f.value) + unit;
                  if (cond0 && !after.trimStart().toLowerCase().startsWith(cond0.toLowerCase())) replacement += ` ${cond0}`;
                } else {
                  replacement = fmt(f.value) + unit;
                }
              }
              out.push(
                mk({
                  field: 'text',
                  ruleId: f.id,
                  ruleKind: 'fact',
                  status: 'contradicted',
                  severity: 'error',
                  title: `Contradicts approved fact: ${f.label}`,
                  explanation: `The copy says “${quote}”${kind === 'plain' ? '' : ` (${kind} wording)`}, but the approved fact says: ${f.statement}`,
                  span,
                  quote,
                  source: f.source,
                  evidence: factEvidence(f),
                  correction:
                    replacement && replacement !== quote
                      ? { type: 'replace', replacement }
                      : { type: 'advice', text: `A person should rewrite it to match the approved fact, keeping its qualifiers and conditions: “${f.statement}”` },
                }),
              );
            }
          }
        }
        // No figure here was compared with this fact: wording that promises endurance without one is still not green (bounded list, duration facts only).
        // The topic must be a noun of the fact ("battery", "charge"), not one of its verbs ("lasts"): "The party lasts all night" is not about the battery.
        const topicNoun = f.topicTerms.some((term) => !wordsOf(term).some((x) => SUBJECT_VERBS.has(x.w)) && phraseRegex(term).test(s.text));
        if (covered.length === judgedBefore && isDuration(f)) {
          for (const c of clauses) {
            if (!topicNoun) break;
            const e = ENDURANCE.exec(c.text);
            if (!e) continue;
            const span = { start: c.start + e.index, end: c.start + e.index + e[0].length };
            covered.push(span);
            out.push(reviewFinding(f, span, e[0], 'unquantified', undefined, subj));
            break;
          }
        }
      } else {
        for (const c of clauses) {
          for (const phrase of f.contradictedBy) {
            for (const m of matches(phraseRegex(phrase), c.text)) {
              const span = spanOf(m, c.start);
              covered.push(span);
              if (isNegated(c.text.slice(0, m.index))) continue; // "not waterproof" agrees with the fact
              const unsure = unsureWhose({ f, subj, s, previous, clauseText: c.text, at: m.index, length: m[0].length });
              if (unsure) {
                out.push(reviewFinding(f, span, m[0], unsure.why, unsure.detail, subj));
                continue;
              }
              out.push(
                mk({
                  field: 'text',
                  ruleId: f.id,
                  ruleKind: 'fact',
                  status: 'contradicted',
                  severity: 'error',
                  title: `Contradicts approved fact: ${f.label}`,
                  explanation: `The copy says “${m[0]}”, but the approved fact says: ${f.statement}`,
                  span,
                  quote: m[0],
                  source: f.source,
                  evidence: factEvidence(f),
                  correction: { type: 'advice', text: `Remove “${m[0]}” or restate it to match the approved fact: ${f.statement}` },
                }),
              );
            }
          }
          for (const phrase of f.confirmedBy) {
            for (const m of matches(phraseRegex(phrase), c.text)) {
              const span = spanOf(m, c.start);
              covered.push(span);
              if (isNegated(c.text.slice(0, m.index))) {
                out.push(reviewFinding(f, span, m[0], 'negated-confirmation'));
                continue;
              }
              const unsure = unsureWhose({ f, subj, s, previous, clauseText: c.text, at: m.index, length: m[0].length });
              if (unsure) {
                out.push(reviewFinding(f, span, m[0], unsure.why, unsure.detail, subj));
                continue;
              }
              out.push(
                mk({
                  field: 'text',
                  ruleId: f.id,
                  ruleKind: 'fact',
                  status: 'supported',
                  severity: 'info',
                  title: `Matches approved fact: ${f.label}`,
                  explanation: `“${m[0]}” is consistent with the approved fact: ${f.statement}`,
                  span,
                  quote: m[0],
                  source: f.source,
                  evidence: factEvidence(f),
                }),
              );
            }
          }
        }
      }
    }

    const hits = [];
    for (const sig of claims.signals) for (const m of matches(phraseRegex(sig), s.text)) hits.push(m);
    if (claims.flagPercentages) {
      for (const m of matches(/(?<![\p{L}\p{N}_.])\d+(?:[.,]\d+)?\s?%/gu, s.text)) hits.push(m);
    }
    for (const m of hits) {
      if (overlaps(m, s.start)) continue; // this exact phrase is already judged against an approved fact
      out.push(
        mk({
          field: 'text',
          ruleId: claims.ruleId,
          ruleKind: 'claim-substantiation',
          status: 'unverified',
          severity: 'warning',
          title: `Unverified claim: “${m[0]}”`,
          explanation:
            'No matching approved fact was found by these checks in this guideline version. That does not make it false, and it does not prove that no source exists: it only means no approved evidence was matched. Claims like this need an approved source.',
          span: spanOf(m, s.start),
          quote: m[0],
          source: claims.source, // the policy that requires substantiation, not a source for the claim
          evidence: [],
          correction: { type: 'advice', text: 'Remove or soften the claim, or ask a manager to add an approved fact that supports it.' },
        }),
      );
    }
  }
}

const GENERIC_ALT = /^(image|photo|picture|img|graphic|banner|logo)(\.\w+)?$/i;

function checkAsset(asset, guidelines, out, notChecked) {
  const hasImage = Boolean(asset.name || asset.fileSha256);
  const { accessibility, altText, palette } = guidelines;

  if (!hasImage) {
    notChecked.push({ ruleId: altText.ruleId, reason: 'Alt text not checked: no campaign image is attached.' });
  } else {
    const alt = asset.alt.trim();
    const fail = (title, explanation, severity) =>
      out.push(
        mk({
          field: 'alt',
          ruleId: altText.ruleId,
          ruleKind: 'alt-text',
          status: 'violation',
          severity,
          title,
          explanation,
          key: 'alt',
          quote: alt || null,
          source: altText.source,
          correction: { type: 'advice', text: 'Describe what the image shows and why it matters in one or two sentences.' },
        }),
      );
    if (!alt) fail('Image has no alt text', 'Every campaign image needs alt text so people using screen readers get the same information.', 'error');
    else if (GENERIC_ALT.test(alt) || alt.toLowerCase() === asset.name.toLowerCase()) {
      fail('Alt text is generic', 'Alt text such as “image” or the file name does not describe the picture.', 'warning');
    } else if (alt.length < altText.minLength) {
      fail('Alt text is very short', `Alt text should describe the image in at least ${altText.minLength} characters (this one has ${alt.length}).`, 'warning');
    }
  }

  if (asset.fg && asset.bg) {
    const ratio = contrastRatio(asset.fg, asset.bg);
    const required = asset.textSize === 'large' ? accessibility.minLarge : accessibility.minNormal;
    const pass = ratio >= required;
    const measured = { ratio: displayRatio(ratio), required, textSize: asset.textSize, fg: asset.fg, bg: asset.bg };
    const scope = 'Measured between the two colours you selected, not across the whole image.';
    out.push(
      mk({
        field: 'asset',
        ruleId: accessibility.ruleId,
        ruleKind: 'contrast',
        status: pass ? 'supported' : 'violation',
        severity: pass ? 'info' : 'error',
        title: pass ? `Contrast ${measured.ratio}:1 meets ${required}:1` : `Contrast ${measured.ratio}:1 is below ${required}:1`,
        explanation: `${asset.fg} on ${asset.bg} has a contrast ratio of ${measured.ratio}:1; ${asset.textSize} text needs at least ${required}:1. ${scope}`,
        key: 'contrast',
        source: accessibility.source,
        measured,
        correction: pass ? null : { type: 'advice', text: 'Choose a darker text colour or a lighter background, then re-measure.' },
      }),
    );
  } else {
    notChecked.push({
      ruleId: accessibility.ruleId,
      reason: 'Contrast not checked: select both a text (foreground) and a background colour in the image.',
    });
  }

  if (asset.colors.length) {
    for (const hex of asset.colors) {
      const near = nearestColor(hex, palette.colors);
      const delta = Math.round(near.deltaE * 10) / 10;
      const measured = { color: hex, nearest: near.color, deltaE: delta, tolerance: palette.tolerance };
      const on = near.deltaE <= palette.tolerance;
      out.push(
        mk({
          field: 'asset',
          ruleId: palette.ruleId,
          ruleKind: 'palette',
          status: on ? 'supported' : 'violation',
          severity: on ? 'info' : 'warning',
          title: on ? `${hex} is on palette (${near.color.name})` : `${hex} is not in the brand palette`,
          explanation: on
            ? `${hex} is within colour distance ${delta} of ${near.color.name} ${near.color.hex} (tolerance ${palette.tolerance}).`
            : `${hex} is colour distance ${delta} from the closest approved colour, ${near.color.name} ${near.color.hex} (tolerance ${palette.tolerance}). Only the colours you listed are compared.`,
          key: `color-${hex}`,
          quote: hex,
          source: palette.source,
          evidence: [{ type: 'palette-color', id: near.color.id, label: near.color.name, quote: near.color.hex }],
          measured,
          correction: on ? null : { type: 'advice', text: `Closest approved colour: ${near.color.name} ${near.color.hex}.` },
        }),
      );
    }
  } else if (hasImage) {
    notChecked.push({ ruleId: palette.ruleId, reason: 'Palette not checked: no image colours were listed.' });
  }
}

export function summarize(findings) {
  const s = { error: 0, warning: 0, info: 0, violation: 0, contradicted: 0, unverified: 0, needs_review: 0, supported: 0 };
  for (const f of findings) {
    s[f.severity]++;
    s[f.status]++;
  }
  return s;
}

/**
 * A hand-maintained label for the rules in this file. It is bumped by the authors when the rules change in a way that can
 * change findings. It is NOT derived from the code, is not a build identity or a signature, and a forgotten bump is possible.
 */
export const CHECKER_REVISION = 'rules-2026.10.28-positive-scope';

export const IMAGE_TEXT_RULE = 'Match the words actually printed. Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.';

// Advice on a finding in the transcription. Editing the transcript cannot fix a claim that is printed in the artwork.
const IMAGE_TEXT_NOTE = 'This wording is printed inside the image, and editing the transcript does not change the image. To fix this claim in the artwork, replace the image, then transcribe and confirm again.';

/**
 * `imageText` is a person's CONFIRMED transcription of the text in the retained image (undefined: none confirmed; '': a person
 * confirmed there is nothing to transcribe). The same text rules run over it as a DISTINCT field, so offsets, quotes, sources
 * and explanations refer to the transcription. Corrections can never be applied automatically (the words live in the image).
 * Only what was transcribed is covered; nothing is inferred about text that was not.
 */
export function runChecks({ text, asset, imageText }, guidelines) {
  const findings = [];
  const notChecked = [];
  checkTerms('text', text, guidelines.terms, findings);
  if (asset.alt) checkTerms('alt', asset.alt, guidelines.terms, findings);
  checkExclamations(text, guidelines.style.exclamation, findings);
  checkFactsAndClaims(text, guidelines, findings);
  if (typeof imageText === 'string') {
    if (imageText.trim()) {
      const own = [];
      checkTerms('text', imageText, guidelines.terms, own);
      checkExclamations(imageText, guidelines.style.exclamation, own);
      checkFactsAndClaims(imageText, guidelines, own);
      for (const f of own) {
        f.field = 'imageText';
        f.id = f.id.replace('|text|', '|imageText|');
        if (f.correction) {
          f.correction = f.correction.type === 'replace' ? { type: 'advice', text: `${IMAGE_TEXT_NOTE} Wording the new artwork could print instead: “${f.correction.replacement}”.` } : { ...f.correction, text: `${f.correction.text ?? ''} ${IMAGE_TEXT_NOTE}`.trim() };
        }
        findings.push(f);
      }
    }
    notChecked.push({ ruleId: 'IMG-TXT', reason: 'Text in the image is checked only as far as a person transcribed and confirmed it, and BrandProof cannot compare that transcript with the pixels. Anything not transcribed is not covered, and nothing about colour, contrast or logos is read from the image.' });
  } else if (asset.retainedSha256) {
    notChecked.push({ ruleId: 'IMG-TXT', reason: 'Text in the image was not checked: no transcription of it has been confirmed for this image.' });
  }
  checkAsset(asset, guidelines, findings, notChecked);
  const order = { text: 0, imageText: 1, alt: 2, asset: 3 };
  findings.sort((a, b) => order[a.field] - order[b.field] || (a.span?.start ?? 0) - (b.span?.start ?? 0));
  return { findings, notChecked, summary: summarize(findings) };
}
