import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, splitSentences } from '../src/checks.js';
import { contrastRatio, deltaE, displayRatio, normalizeHex } from '../src/color.js';
import { guidelinesFixture, blankAsset } from './helpers.js';

const G = guidelinesFixture();
const run = (text, asset = blankAsset()) => runChecks({ text, asset }, G);
const byRule = (r, id) => r.findings.filter((f) => f.ruleId === id);
const idOf = (label) => G.facts.find((f) => f.label === label).id;
const termId = (preferred, kind) => G.terms.find((t) => (kind ? t.kind === kind : t.preferred === preferred) && (!preferred || t.preferred === preferred)).id;

test('every text finding has a span whose slice equals its quote', () => {
  const text = "Meet the aurora lamp!!! The cheapest, best reading light ever. A full charge lasts 30 hours, and it's totally waterproof.";
  const r = run(text);
  const textFindings = r.findings.filter((f) => f.field === 'text');
  assert.ok(textFindings.length >= 5);
  for (const f of textFindings) assert.equal(text.slice(f.span.start, f.span.end), f.quote, f.id);
});

test('terminology: wrong-case product name is flagged with source and a safe replacement', () => {
  const text = 'We love the aurora lamp.';
  const f = byRule(run(text), termId('Aurora Lamp'))[0];
  assert.equal(f.status, 'violation');
  assert.equal(f.quote, 'aurora lamp');
  assert.equal(f.source.doc, 'Fernlight Naming Guide (fictional)');
  assert.match(f.source.quote, /Aurora Lamp/);
  assert.deepEqual(f.correction, { type: 'replace', replacement: 'Aurora Lamp' });
});

test('terminology: correct casing is not flagged', () => {
  assert.equal(byRule(run('The Aurora Lamp is here.'), termId('Aurora Lamp')).length, 0);
});

test('terminology: whole words only ("cheap" does not match inside other words) and case follows the sentence', () => {
  const r = run('Cheap is not our word. Neither is cheapest, but cheaply is a different word.');
  const t = G.terms.find((x) => x.avoid.some((a) => a.text === 'cheap'));
  const hits = byRule(r, t.id);
  assert.deepEqual(hits.map((h) => h.quote), ['Cheap', 'cheapest']);
  assert.equal(hits[0].correction.replacement, 'Affordable');
  assert.equal(hits[1].correction.replacement, 'most affordable');
});

test('terminology without a safe replacement gives advice, never a guessed rewrite', () => {
  const f = run('A revolutionary lamp.').findings.find((x) => x.quote === 'revolutionary');
  assert.equal(f.correction.type, 'advice');
});

test('exclamation marks: repeated and excess marks flagged, a single one allowed', () => {
  assert.equal(byRule(run('Hello there!'), G.style.exclamation.ruleId).length, 0);
  const r = run('Wow!!! Really! Yes!');
  const hits = byRule(r, G.style.exclamation.ruleId);
  assert.deepEqual(hits.map((h) => [h.quote, h.correction.replacement]), [['!!!', '!'], ['!', '.'], ['!', '.']]);
});

test('fact: wrong battery hours is CONTRADICTED and cites the approved fact', () => {
  const text = 'A full charge lasts 30 hours.';
  const f = byRule(run(text), idOf('Battery life'))[0];
  assert.equal(f.status, 'contradicted');
  assert.equal(f.severity, 'error');
  assert.equal(f.quote, '30 hours');
  assert.equal(f.evidence[0].id, idOf('Battery life'));
  assert.match(f.evidence[0].quote, /up to 12 hours/);
  // The approved fact is "up to 12 hours at medium brightness": the safe rewrite keeps both qualifiers.
  assert.deepEqual(f.correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
});

test('fact: "up to 12 hours" and "up to" fewer hours are supported; a plain "8 hours" is NOT entailed by "up to 12" (needs review)', () => {
  for (const t of ['A full charge runs up to 12 hours.', 'A full charge runs up to 8 hours.']) {
    const r = run(t);
    const f = byRule(r, idOf('Battery life'));
    assert.equal(f.length, 1, t);
    assert.equal(f[0].status, 'supported', t);
    assert.equal(r.summary.contradicted, 0);
  }
  // Stricter than the first baseline, on purpose: "up to 12" does not establish that the lamp lasts 8.
  const plain = run('Battery lasts 8 hours on a charge.');
  const p = byRule(plain, idOf('Battery life'));
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'needs_review');
  assert.equal(plain.summary.contradicted, 0);
});

test('fact: a number with no matching topic is never called false', () => {
  const r = run('Join 10,000 happy readers. Free shipping on orders over 50 dollars. Ships in 3 days. Open 24 hours.');
  assert.equal(r.summary.contradicted, 0);
  assert.equal(r.summary.unverified, 0);
  assert.equal(r.findings.length, 0);
});

test('fact: same unit but unrelated topic is not compared ("open 24 hours" is not battery life)', () => {
  assert.equal(byRule(run('The shop is open 24 hours.'), idOf('Battery life')).length, 0);
});

test('fact: warranty and recycled-content numbers compare against their own facts', () => {
  const bad = run('Comes with a 5-year warranty and a body that is 60% recycled aluminium.');
  assert.equal(byRule(bad, idOf('Warranty length'))[0].status, 'contradicted');
  assert.equal(byRule(bad, idOf('Recycled content'))[0].status, 'contradicted');
  const good = run('Comes with a 2-year warranty and a 100% recycled aluminium body.');
  assert.equal(byRule(good, idOf('Warranty length'))[0].status, 'supported');
  assert.equal(byRule(good, idOf('Recycled content'))[0].status, 'supported');
});

test('fact: "waterproof" contradicts, "not waterproof" agrees, indoor use is supported', () => {
  const id = idOf('Indoor use only');
  assert.equal(byRule(run("It's totally waterproof."), id)[0].status, 'contradicted');
  assert.equal(byRule(run('It is not waterproof.'), id).length, 0);
  assert.equal(byRule(run("It isn't waterproof."), id).length, 0);
  assert.equal(byRule(run('Designed for indoor use.'), id)[0].status, 'supported');
});

test('claims: an unsupported superlative is UNVERIFIED, cites only the policy, and carries no fact evidence', () => {
  const r = run('The best lamp for reading.');
  const f = r.findings.find((x) => x.status === 'unverified');
  assert.equal(f.quote, 'best');
  assert.equal(f.ruleId, G.claims.ruleId);
  assert.equal(f.severity, 'warning');
  assert.deepEqual(f.evidence, []);
  assert.equal(f.source.quote, G.claims.source.quote); // the policy that demands evidence, not a source for the claim
  assert.match(f.explanation, /does not make it false/i);
  assert.equal(r.summary.contradicted, 0);
});

test('claims: a percentage with no approved fact is unverified, not false', () => {
  const r = run('99% of readers sleep better.');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].status, 'unverified');
  assert.deepEqual(r.findings[0].evidence, []);
});

test('claims: only a signal INSIDE a judged fact phrase is absorbed; "100% recycled" is not also an unverified percentage', () => {
  const r = run('Its body is 100% recycled aluminium.');
  assert.equal(r.summary.unverified, 0);
  assert.equal(r.summary.supported, 1);
});

test('regression (review #1): a matched numeric fact must not hide an unrelated unsupported claim in the same sentence', () => {
  const r = run('Battery lasts 24 hours and is clinically proven to cure headaches');
  const battery = byRule(r, idOf('Battery life'))[0];
  assert.equal(battery.status, 'contradicted');
  const unverified = r.findings.filter((f) => f.status === 'unverified').map((f) => f.quote);
  assert.deepEqual(unverified, ['clinically proven', 'proven to']);

  // same clause, no conjunction: a superlative next to a supported figure is still unverified
  const r2 = run('The best battery runs up to 12 hours.');
  assert.deepEqual(r2.findings.filter((f) => f.status === 'unverified').map((f) => f.quote), ['best']);
  assert.equal(byRule(r2, idOf('Battery life'))[0].status, 'supported');

  // a statistic in another clause is not absorbed by a fact in this one
  const r3 = run('A charge lasts 12 hours, and 99% of readers love it.');
  assert.deepEqual(r3.findings.filter((f) => f.status === 'unverified').map((f) => f.quote), ['99%']);
});

test('regression (review #2): negated confirming phrase is NOT supported', () => {
  const g = structuredClone(G);
  const f = g.facts.find((x) => x.label === 'Indoor use only');
  f.confirmedBy.push('splash resistant');
  const r = runChecks({ text: 'The lamp is not splash resistant.', asset: blankAsset() }, g);
  assert.equal(r.findings.filter((x) => x.status === 'supported').length, 0);
  const nr = r.findings.find((x) => x.status === 'needs_review');
  assert.equal(nr.quote, 'splash resistant');
  assert.equal(nr.severity, 'warning');
  assert.equal(nr.evidence[0].type, 'possibly-related-fact');

  const plain = runChecks({ text: 'The lamp is splash resistant.', asset: blankAsset() }, g);
  assert.ok(plain.findings.some((x) => x.status === 'supported' && x.quote === 'splash resistant'));
});

test('regression (review #2): "not only waterproof" is not treated as agreeing with the fact', () => {
  const f = byRule(run('It is not only waterproof but rugged.'), idOf('Indoor use only'));
  assert.equal(f[0].status, 'contradicted');
});

test('regression (review #2): negated figures are needs-review, never supported or contradicted', () => {
  for (const t of ['The battery does not last 12 hours.', 'Battery never lasts 30 hours.', 'The charge is not 12 hours.']) {
    const f = byRule(run(t), idOf('Battery life'));
    assert.equal(f.length, 1, t);
    assert.equal(f[0].status, 'needs_review', t);
  }
});

test('regression (review #2): topic and figure in different clauses are needs-review, not support/contradiction', () => {
  for (const t of ['Battery life, 30 hours.', 'The battery is great and open 24 hours a day shop-wide, 30 hours of fun.']) {
    const r = run(t);
    assert.equal(r.summary.supported, 0, t);
    assert.equal(r.summary.contradicted, 0, t);
    assert.ok(r.findings.some((x) => x.status === 'needs_review'), t);
  }
});

test('qualifiers: "over 12 hours" contradicts an at-most fact, "at least" and "over 8 hours" need review, "up to 30" contradicts', () => {
  const st = (t) => byRule(run(t), idOf('Battery life'))[0];
  assert.equal(st('A charge lasts over 12 hours.').status, 'contradicted');
  assert.equal(st('A charge lasts over 8 hours.').status, 'needs_review');
  assert.equal(st('A charge lasts at least 12 hours.').status, 'needs_review');
  assert.equal(st('A charge lasts up to 30 hours.').status, 'contradicted');
  assert.equal(st('A charge lasts up to 12 hours.').status, 'supported');
  assert.equal(st('A charge lasts about 12 hours.').status, 'needs_review'); // "about 12" is not "up to 12"
  assert.equal(st('A charge lasts nearly 30 hours.').status, 'needs_review');
  assert.equal(st('A charge lasts over 12 hours.').correction.type, 'advice');
  assert.equal(st('A charge lasts 30 hours.').correction.type, 'replace');
  assert.equal(st('A charge lasts 30 hours.').correction.replacement, 'up to 12 hours at medium brightness');
});

test('needs_review findings are counted separately and are warnings (acknowledge, not block)', () => {
  const r = run('Battery life, 30 hours.');
  assert.equal(r.summary.needs_review, 1);
  assert.equal(r.summary.error, 0);
  assert.equal(r.summary.warning, 1);
});

test('contrast: known WCAG values', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF') * 100) / 100, 21);
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  const grey = contrastRatio('#777777', '#FFFFFF');
  assert.ok(grey > 4.4 && grey < 4.5, String(grey)); // famous near-miss: fails AA for normal text
  assert.equal(normalizeHex('abc'), '#AABBCC');
  assert.equal(normalizeHex('#12345'), null);
});

test('contrast: failing and passing selections, large text threshold, and scope statement', () => {
  const fail = run('Hi.', { ...blankAsset(), name: 'a.png', alt: 'A long enough description of the image', fg: '#777777', bg: '#FFFFFF' });
  const c = byRule(fail, G.accessibility.ruleId)[0];
  assert.equal(c.status, 'violation');
  assert.equal(c.severity, 'error');
  assert.equal(c.measured.ratio, 4.47);
  assert.match(c.explanation, /not across the whole image/);

  const large = run('Hi.', { ...blankAsset(), name: 'a.png', alt: 'A long enough description of the image', fg: '#777777', bg: '#FFFFFF', textSize: 'large' });
  assert.equal(byRule(large, G.accessibility.ruleId)[0].status, 'supported');
});

test('contrast: displayed ratio never rounds a failure up to the threshold', () => {
  assert.equal(displayRatio(4.4999), 4.49);
  assert.equal(displayRatio(4.5), 4.5);
  assert.equal(displayRatio(21), 21);
});

test('contrast and palette are reported as not checked when nothing was selected', () => {
  const r = run('Hi.', { ...blankAsset(), name: 'a.png', alt: 'A long enough description of the image' });
  const ids = r.notChecked.map((n) => n.ruleId);
  assert.ok(ids.includes(G.accessibility.ruleId));
  assert.ok(ids.includes(G.palette.ruleId));
});

test('palette: off-palette colours are flagged with nearest approved colour; on-palette ones are supported', () => {
  const r = run('Hi.', { ...blankAsset(), name: 'a.png', alt: 'A long enough description of the image', colors: ['#FF00AA', '#0F2A43', '#102B44'] });
  const pal = byRule(r, G.palette.ruleId);
  assert.deepEqual(pal.map((p) => p.status), ['violation', 'supported', 'supported']);
  assert.equal(pal[0].measured.nearest.name.length > 0, true);
  assert.ok(pal[0].measured.deltaE > G.palette.tolerance);
  assert.ok(deltaE('#0F2A43', '#0F2A43') === 0);
});

test('alt text: missing is an error, generic or short is a warning, none needed without an image', () => {
  const a = (alt) => run('Hi.', { ...blankAsset(), name: 'hero.png', alt });
  assert.equal(byRule(a(''), G.altText.ruleId)[0].severity, 'error');
  assert.equal(byRule(a('image'), G.altText.ruleId)[0].severity, 'warning');
  assert.equal(byRule(a('hero.png'), G.altText.ruleId)[0].severity, 'warning');
  assert.equal(byRule(a('A lamp'), G.altText.ruleId)[0].severity, 'warning');
  assert.equal(byRule(a('The lamp glowing next to an open book'), G.altText.ruleId).length, 0);
  const none = run('Hi.');
  assert.equal(byRule(none, G.altText.ruleId).length, 0);
  assert.ok(none.notChecked.some((n) => n.ruleId === G.altText.ruleId));
});

test('alt text is also checked against terminology and keeps its own field', () => {
  const r = run('Hi.', { ...blankAsset(), name: 'hero.png', alt: 'The aurora lamp beside a cup of tea' });
  const f = r.findings.find((x) => x.field === 'alt' && x.quote === 'aurora lamp');
  assert.ok(f);
});

test('sentence splitting keeps decimals together and reports correct offsets', () => {
  const t = 'Runs 4.5 hours. Next one! Third\nFourth';
  const s = splitSentences(t);
  assert.deepEqual(s.map((x) => x.text), ['Runs 4.5 hours.', 'Next one!', 'Third', 'Fourth']);
  for (const x of s) assert.equal(t.slice(x.start, x.end), x.text);
});

test('user text containing regex metacharacters cannot break matching', () => {
  const r = run('(a+)+$ [x] \\ .* ?? best');
  assert.equal(r.findings.filter((f) => f.status === 'unverified').length, 1);
});
