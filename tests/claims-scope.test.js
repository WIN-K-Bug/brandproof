import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../src/checks.js';
import { validateGuidelines, assignIds } from '../src/validate.js';
import { seedGuidelines } from '../src/seed.js';
import { evaluateClaims, applyReplacements } from '../scripts/eval-claims.js';
import { guidelinesFixture, blankAsset, startApp } from './helpers.js';

const G = guidelinesFixture();
const run = (text, g = G) => runChecks({ text, asset: blankAsset() }, g);
const battery = (r) => r.findings.filter((f) => f.ruleId === 'FCT-001');
const only = (text, g = G) => {
  const f = battery(run(text, g));
  assert.equal(f.length, 1, `${text} -> ${f.map((x) => x.status).join(',')}`);
  return f[0];
};
const sliceOf = (text, f) => text.slice(f.span.start, f.span.end);

test('claims corpus: the synthetic corpus matches its labels (regression baseline over our own sentences, not accuracy)', () => {
  const r = evaluateClaims();
  assert.deepEqual(r.failures, []);
  assert.ok(r.total.cases >= 60, `cases ${r.total.cases}`);
  assert.equal(r.total.falseSupport, 0);
  assert.equal(r.total.badReplacement, 0);
  assert.equal(r.total.applyBreaks, 0);
  assert.ok(r.total.applied >= 6, 'enough rewrites were re-checked');
  for (const group of ['clean-control', 'upper-bound', 'guarantee', 'condition', 'competitor', 'attribution', 'negation', 'safe-correction', 'mixed']) {
    assert.ok(r.groups[group]?.cases >= 2, `group ${group}`);
  }
  // Known limits stay reported separately and are never scored.
  assert.ok(r.limits.length >= 5);
});

test('gap 1: "always exactly 12 hours at maximum brightness" is not supported by "up to 12 hours at medium brightness"', () => {
  const text = 'A full charge always lasts exactly 12 hours at maximum brightness.';
  const f = only(text);
  assert.equal(f.status, 'needs_review');
  assert.equal(sliceOf(text, f), '12 hours');
  assert.equal(f.quote, '12 hours');
  assert.equal(f.correction.type, 'advice');
  assert.match(f.correction.text, /at medium brightness/);
  assert.match(f.evidence[0].quote, /up to 12 hours/);
});

test('gap 2: "guaranteed to last 12 hours" is a caution, not a supported figure', () => {
  const text = 'A full charge is guaranteed to last 12 hours.';
  const r = run(text);
  const f = only(text);
  assert.equal(f.status, 'needs_review');
  assert.match(f.explanation, /only sets an upper limit/);
  assert.equal(f.correction.type, 'advice');
  // The "guaranteed" signal itself stays unverified: no approved fact supports it, which is a separate statement.
  assert.ok(r.findings.some((x) => x.ruleId === 'CLM-001' && x.status === 'unverified'));
  assert.ok(!r.findings.some((x) => x.status === 'supported'));
});

test('gap 3: a 30-hour mismatch keeps "up to" and "at medium brightness" in the offered replacement', () => {
  const text = 'A full charge lasts 30 hours.';
  const f = only(text);
  assert.equal(f.status, 'contradicted');
  assert.deepEqual(f.correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
  const fixed = applyReplacements(text, battery(run(text)));
  assert.equal(fixed, 'A full charge lasts up to 12 hours at medium brightness.');
  assert.equal(only(fixed).status, 'supported');
  // the approved condition is not repeated when the copy already states it
  assert.deepEqual(only('A full charge lasts 30 hours at medium brightness.').correction, { type: 'replace', replacement: 'up to 12 hours' });
});

test('gap 4: a competitor figure is never confirmed or corrected with our fact', () => {
  const text = 'Our competitor battery lasts 30 hours; the Aurora Lamp lasts up to 12 hours.';
  const r = run(text);
  const f = battery(r);
  assert.equal(f.length, 2);
  const theirs = f.find((x) => x.quote === '30 hours');
  const ours = f.find((x) => x.quote === '12 hours');
  assert.equal(theirs.status, 'needs_review');
  assert.equal(theirs.correction.type, 'advice');
  assert.equal(sliceOf(text, theirs), '30 hours');
  assert.equal(ours.status, 'supported');
  assert.equal(applyReplacements(text, r.findings), text, 'nothing is rewritten');
});

test('automatic replacement is withheld whenever meaning or conditions might change', () => {
  for (const text of [
    'A full charge lasts 30 hours at maximum brightness.',
    'A full charge lasts 30 hours, at maximum brightness.',
    'A full charge always lasts 30 hours.',
    'A full charge lasts 30 hours, guaranteed.',
    'A full charge lasts over 12 hours.',
    'The battery lasts 30 hours when you read in bed every single night.',
    'Reviewers say a full charge lasts 30 hours.',
    'Rival lamps advertise 30 hours of battery.',
  ]) {
    const r = run(text);
    assert.ok(battery(r).length >= 1, text);
    assert.ok(!r.findings.some((f) => f.correction?.type === 'replace' && f.ruleId === 'FCT-001'), `no replacement for: ${text}`);
  }
});

test('a plain figure below the upper bound is a caution: "up to 12" does not establish a guaranteed 10', () => {
  for (const text of ['A full charge lasts 10 hours.', 'A full charge lasts exactly 10 hours.', 'A full charge lasts about 10 hours.', 'The battery lasts at least 10 hours.']) {
    assert.equal(only(text).status, 'needs_review', text);
  }
  assert.equal(only('A full charge lasts up to 10 hours.').status, 'supported');
});

test('facts recorded without conditions (older guidelines) never get an automatic rewrite of a battery figure', () => {
  const legacy = structuredClone(seedGuidelines());
  for (const f of legacy.facts) {
    delete f.conditions;
    delete f.conditionTerms;
  }
  const v = validateGuidelines(legacy);
  assert.equal(v.ok ?? true, true);
  const g = assignIds(v.value);
  const battery0 = g.facts.find((f) => f.label === 'Battery life');
  assert.ok(!('conditions' in battery0) && !('conditionTerms' in battery0), 'absent keys stay absent so earlier guideline hashes do not change');
  const f = only('A full charge lasts 30 hours.', g);
  assert.equal(f.status, 'contradicted');
  assert.equal(f.correction.type, 'advice');
  assert.match(f.correction.text, /up to 12 hours at medium brightness/);
  // without recorded conditions nothing can conflict with them, and the plain "up to" figure is still supported
  assert.equal(only('A full charge lasts up to 12 hours at maximum brightness.', g).status, 'supported');
});

test('exact facts keep working and honour subject and attribution', () => {
  const warranty = (text) => run(text).findings.filter((f) => f.ruleId === 'FCT-004');
  assert.deepEqual(warranty('The Aurora Lamp has a 5-year warranty.').map((f) => [f.status, f.correction.replacement]), [['contradicted', '2-year']]);
  assert.equal(warranty('Competitors give a 5-year warranty.')[0].status, 'needs_review');
  assert.equal(warranty('A reviewer wrote: "a 5-year warranty".')[0].status, 'needs_review');
  assert.equal(warranty('The Aurora Lamp has a 2-year warranty.')[0].status, 'supported');
});

test('conditions and condition terms validate, persist through the guideline API and drive the rewrite text', async () => {
  const t = await startApp();
  try {
    const g = (await t.call('GET', '/api/guidelines')).json;
    const edit = structuredClone(g.guidelines);
    const fact = edit.facts.find((f) => f.label === 'Battery life');
    assert.deepEqual(fact.conditions, ['at medium brightness']);

    fact.conditions = 'at medium brightness';
    let r = await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: g.version, guidelines: edit } });
    assert.equal(r.status, 422);
    assert.ok(r.json.error.details.fields.some((x) => x.path.endsWith('.conditions')));

    fact.conditions = ['with the display on its default setting'];
    fact.conditionTerms = ['brightness', 'display'];
    r = await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: g.version, guidelines: edit } });
    assert.equal(r.status, 201);
    const saved = (await t.call('GET', '/api/guidelines')).json.guidelines.facts.find((f) => f.label === 'Battery life');
    assert.deepEqual(saved.conditions, ['with the display on its default setting']);
    assert.deepEqual(saved.conditionTerms, ['brightness', 'display']);

    const checked = (await t.call('POST', '/api/check', { body: { text: 'A full charge lasts 30 hours.', asset: {} } })).json;
    const f = checked.findings.find((x) => x.ruleId === saved.id);
    assert.deepEqual(f.correction, { type: 'replace', replacement: 'up to 12 hours with the display on its default setting' });
    const cautious = (await t.call('POST', '/api/check', { body: { text: 'A full charge lasts up to 12 hours at medium brightness.', asset: {} } })).json;
    assert.equal(cautious.findings.find((x) => x.ruleId === saved.id).status, 'needs_review');
  } finally {
    await t.close();
  }
});

// ---------- denied and retired claims are never rewritten into something else ----------

const factFindings = (text, g = G) => run(text, g).findings.filter((f) => f.ruleKind === 'fact');

test('holdout: a denied claim and a retired figure are cautions with advice only, never a rewrite that reverses them', () => {
  for (const [text, quote] of [
    ['Do not advertise that the battery lasts 30 hours.', '30 hours'],
    ['The old battery specification of 30 hours was incorrect.', '30 hours'],
  ]) {
    const f = only(text);
    assert.equal(f.status, 'needs_review', text);
    assert.equal(f.quote, quote);
    assert.equal(sliceOf(text, f), quote);
    assert.equal(f.correction.type, 'advice', text);
    assert.match(f.correction.text, /Nothing is rewritten automatically/);
    assert.match(f.explanation, /tell people NOT to make this claim, or to say the figure is old, retired or wrong/);
    assert.equal(applyReplacements(text, run(text).findings), text, 'applying every offered correction changes nothing');
    assert.ok(!run(text).findings.some((x) => x.severity === 'error'), 'not a blocking error: a person reads it');
  }
});

test('denied wording in many shapes: capitalisation, curly apostrophes, spacing, other verbs and other facts all stay unrewritten', () => {
  const sentences = [
    'DO NOT ADVERTISE THAT THE BATTERY LASTS 30 HOURS.',
    'do not advertise that the battery lasts 30 hours.',
    'Don’t claim the battery lasts 30 hours.',
    'Do   not   say   that  a full charge lasts 30 hours.',
    'You must not promise that the battery runs 30 hours.',
    'Please never put 30 hours of battery on a banner.',
    'We should not tell customers the battery lasts 30 hours.',
    'Staff may not boast that a full charge lasts 30 hours.',
    'It is forbidden to claim that the battery lasts 30 hours.',
    'The battery figure of 30 hours is obsolete.',
    'The 30 hours charge claim was misleading.',
    'The battery number was overstated; it said 30 hours.',
    'Scrap the 30 hours battery claim.',
    'Drop the 30 hours battery claim.',
    'Our previous 30 hours battery claim has been superseded.',
  ];
  for (const t of sentences) {
    const r = factFindings(t).filter((f) => f.ruleId === 'FCT-001');
    assert.ok(r.length >= 1, t);
    assert.ok(r.every((f) => f.status === 'needs_review' && f.correction.type === 'advice'), `${t} -> ${r.map((f) => f.status).join(',')}`);
    assert.equal(applyReplacements(t, run(t).findings), t, t);
  }
  for (const t of ['Never claim the body is 60% recycled aluminium.', 'Do not say the warranty is 5 years.', 'The old 5-year warranty claim was incorrect.']) {
    assert.ok(factFindings(t).every((f) => f.status === 'needs_review' && f.correction.type === 'advice'), t);
    assert.equal(applyReplacements(t, run(t).findings), t, t);
  }
});

test('a denied claim of the APPROVED figure is not shown as supported either', () => {
  for (const t of ['Do not advertise that the battery lasts up to 12 hours.', 'Never say a full charge lasts up to 12 hours at medium brightness.']) {
    assert.equal(only(t).status, 'needs_review', t);
  }
});

test('controls stay as before: an affirmative mismatch is still rewritten, the qualified approved claim is still supported, near-miss wording is not caught', () => {
  assert.deepEqual(only('A full charge lasts 30 hours.').correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
  assert.deepEqual(only('The battery lasts 30 hours on a single charge.').correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
  assert.deepEqual(only('Use the lamp all evening: a full charge lasts 30 hours.').correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
  for (const t of [
    'A full charge lasts up to 12 hours at medium brightness.',
    'Never worry: a full charge lasts up to 12 hours at medium brightness.',
    "Don't miss out: a full charge lasts up to 12 hours at medium brightness.",
    'We do not compromise on quality: a full charge lasts up to 12 hours at medium brightness.',
    'We never stop improving: a full charge lasts up to 12 hours at medium brightness.',
    'New: a full charge lasts up to 12 hours at medium brightness.',
    // a negative lead and a claim verb far apart are two separate thoughts, not one denial (the window is 60 characters)
    'We never stop improving the design of every lamp we make for readers all over the world, and we tell readers a full charge lasts up to 12 hours at medium brightness.',
  ]) assert.equal(only(t).status, 'supported', t);
});

test('applying corrections in a text that holds both a denial and an affirmative mismatch rewrites only the affirmative sentence', () => {
  const text = 'Do not advertise that the battery lasts 30 hours. A full charge lasts 30 hours. The old battery figure of 30 hours was incorrect.';
  const r = run(text);
  const facts = r.findings.filter((f) => f.ruleId === 'FCT-001');
  assert.deepEqual(facts.map((f) => f.status), ['needs_review', 'contradicted', 'needs_review']);
  const fixed = applyReplacements(text, r.findings);
  assert.equal(fixed, 'Do not advertise that the battery lasts 30 hours. A full charge lasts up to 12 hours at medium brightness. The old battery figure of 30 hours was incorrect.');
  // the result is stable: nothing inverts on a second pass, and the denials are still cautions
  const again = run(fixed).findings.filter((f) => f.ruleId === 'FCT-001');
  assert.deepEqual(again.map((f) => f.status), ['needs_review', 'supported', 'needs_review']);
  assert.equal(applyReplacements(fixed, run(fixed).findings), fixed);
});

test('through the API: a denied claim is a caution with no replacement, and the corpus keeps every denied or retired case unrewritten', async () => {
  const t = await startApp();
  try {
    const out = (await t.call('POST', '/api/check', { body: { text: 'Do not advertise that the battery lasts 30 hours.', asset: {} } })).json;
    const f = out.findings.find((x) => x.ruleId === 'FCT-001');
    assert.equal(f.status, 'needs_review');
    assert.equal(f.correction.type, 'advice');
    assert.equal(out.summary.contradicted, 0);
  } finally {
    await t.close();
  }
  const r = evaluateClaims();
  assert.deepEqual(r.failures, []);
  for (const group of ['denied-directive', 'retired-figure', 'denied-controls']) assert.ok(r.groups[group]?.cases >= 10, group);
  assert.ok(r.limits.filter((l) => /over-cautious/.test(l.id)).length >= 2, 'over-caution is reported as a known limit, not hidden');
});

test('gate is bounded: wording outside the lists is still judged as an ordinary claim (documented limit, not a general-NLP claim)', () => {
  // (m25b: "We have moved on from the 30 hours battery number." used to be the example here; its unfamiliar verb now sends it to a person, so another
  // documented limit from the same corpus shows the lists are still bounded.)
  const t = 'A battery that lasts 30 hours was never true.';
  assert.equal(only(t).status, 'contradicted', 'not detected as retired: the limit is real');
  assert.equal(only(t).correction.type, 'replace');
});
