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

/**
 * Decide what one figure in one clause can honestly be called, against one numeric fact.
 * Returns { verdict: 'supported' | 'contradicted' | 'review', why?, fix?: 'replace' | 'advice', note? }.
 */
function judgeFigure({ f, c, m, s, clauses, ci, n, kind, rest }) {
  const clause = c.text;
  const figureAt = c.start - s.start + m.index;
  if (isNegated(rest)) return { verdict: 'review', why: 'negated' };
  if (OTHER_SUBJECT.test(clause)) return { verdict: 'review', why: 'subject' };
  // Attribution is looked for in the three clauses before the figure, its own clause and the next one, and inside quotation marks.
  const nearby = clauses.slice(Math.max(0, ci - 3), ci + 2).map((x) => x.text).join(' ');
  if (ATTRIBUTION.test(nearby) || insideQuote(s.text, figureAt)) return { verdict: 'review', why: 'attributed' };
  // A denied or retired claim is judged by a person, whatever the figure is: never supported, never rewritten.
  const lead = `${clauses[ci - 1]?.text ?? ''} ${clause.slice(0, m.index)}`;
  if (DENIED_DIRECTIVE.test(lead) || RETIRED_FIGURE.test(s.text)) return { verdict: 'review', why: 'denied' };

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
};

function reviewAdvice(f, why) {
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
    case 'attributed':
      return 'Check who said it. A quoted or attributed figure is not a claim about our product unless the copy adopts it, so nothing is rewritten automatically.';
    default:
      return 'Check the wording against the approved fact and make the claim explicit.';
  }
}

function reviewFinding(f, span, quote, why) {
  return mk({
    field: 'text',
    ruleId: f.id,
    ruleKind: 'fact',
    status: 'needs_review',
    severity: 'warning',
    title: `Needs review: ${f.label}`,
    explanation: `“${quote}” may relate to the approved fact “${f.statement}”, but ${REVIEW_WHY[why]}, so BrandProof cannot tell whether it matches. This is not a finding that the copy is wrong.`,
    span,
    quote,
    source: f.source,
    evidence: factEvidence(f, 'possibly-related-fact'),
    correction: { type: 'advice', text: reviewAdvice(f, why) },
  });
}

function checkFactsAndClaims(text, guidelines, out) {
  const { facts, claims } = guidelines;
  const covered = []; // spans already accounted for by a fact; only signals inside them are suppressed
  const overlaps = (m, off) => covered.some((c) => m.index + off < c.end && m.index + off + m[0].length > c.start);

  for (const s of splitSentences(text)) {
    const clauses = splitClauses(s);

    for (const f of facts) {
      if (f.type === 'numeric') {
        const topicIn = (t) => f.topicTerms.some((term) => phraseRegex(term).test(t));
        const sentenceHasTopic = topicIn(s.text);
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
            const j = judgeFigure({ f, c, m, s, clauses, ci, n, kind, rest });
            if (j.verdict === 'review') {
              out.push(reviewFinding(f, span, quote, j.why));
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
      } else {
        for (const c of clauses) {
          for (const phrase of f.contradictedBy) {
            for (const m of matches(phraseRegex(phrase), c.text)) {
              const span = spanOf(m, c.start);
              covered.push(span);
              if (isNegated(c.text.slice(0, m.index))) continue; // "not waterproof" agrees with the fact
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
export const CHECKER_REVISION = 'rules-2026.10.25-image-text';

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
