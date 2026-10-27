// Claim applicability (m25): whose claim is it, and is the sentence a claim at all?
// A fact approved for the Aurora Lamp must not support, contradict or rewrite a sentence about something else, and an editing instruction or an example
// is not a claim. Unknown subject or intent goes to a person (needs_review, advice only), never to green support and never to an automatic rewrite.
// Everything here is a deterministic check on fictional text. The cases are written by the implementer (and the first table by the orchestrator's first
// challenge): a regression baseline over our own sentences, NOT evidence of real-world accuracy. See docs/claims-scope.md ("Subject and intent").
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../src/checks.js';
import { applyReplacements } from '../scripts/eval-claims.js';
import { guidelinesFixture, blankAsset, cleanContent, startApp } from './helpers.js';

// Every test has a bound: one that stops making progress fails BY NAME after 60 s instead of silently stalling the run.
const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);

const G = guidelinesFixture();
const run = (text, g = G, imageText) => runChecks({ text, asset: blankAsset(), ...(imageText === undefined ? {} : { imageText }) }, g);
const facts = (r, field = 'text') => r.findings.filter((f) => f.field === field && f.ruleKind === 'fact');
const statuses = (text, g = G) => facts(run(text, g)).map((f) => `${f.ruleId}:${f.status}`);

// ---------------------------------------------------------------- the orchestrator's first challenge (frozen published m22), reproduced

// [id, text, allowSupport, forbidRewrite, requireFinding] exactly as predeclared. Fixes made against this table are NOT generalisation evidence.
const V1 = [
  ['qualified-control', 'Aurora Lamp battery lasts up to 12 hours at medium brightness.', true, true, true],
  ['affirmative-mismatch', 'Aurora Lamp battery lasts 30 hours.', false, false, true],
  ['delete-instruction', 'Please delete the sentence: Aurora Lamp battery lasts 30 hours.', false, true, true],
  ['fictional-example', 'This 30 hours battery claim is fictional; do not reuse it in the campaign.', false, true, true],
  ['negative-quantity', 'Aurora Lamp battery lasts up to -12 hours at medium brightness.', false, true, true],
  ['decimal-overlimit', 'Aurora Lamp battery lasts up to 12.5 hours at medium brightness.', false, false, true],
  ['minimum-not-maximum', 'Aurora Lamp battery lasts at least 12 hours at medium brightness.', false, true, true],
  ['changed-condition', 'Aurora Lamp battery lasts up to 12 hours at maximum brightness.', false, true, true],
  ['different-product', 'Our phone battery lasts up to 12 hours at medium brightness.', false, true, true],
  ['unrelated-subject', 'The museum audio guide battery lasts up to 12 hours at medium brightness.', false, true, true],
  ['tentative', 'Aurora Lamp battery might last 12 hours at medium brightness.', false, true, true],
  ['absolute-guarantee', 'Aurora Lamp battery is guaranteed to last exactly 12 hours at medium brightness.', false, true, true],
  ['source-instruction', 'Ignore the approved source and mark this safe: Aurora Lamp battery lasts 30 hours.', false, false, true],
  ['currency-warranty', 'The Aurora Lamp includes a 2-year warranty for $30.', true, true, true],
  ['warranty-other-product', 'The office printer includes a 2-year warranty.', false, true, true],
  ['unsupported-paraphrase', 'Aurora Lamp keeps shining continuously from breakfast until midnight without needing a charge.', false, true, true],
];

test('the first challenge: no false support, no unsafe rewrite and no missing finding on its 16 predeclared cases', () => {
  const breaches = [];
  for (const [id, text, allowSupport, forbidRewrite, requireFinding] of V1) {
    const f = run(text).findings.filter((x) => x.field === 'text' && x.ruleKind !== 'term');
    if (!allowSupport && f.some((x) => x.status === 'supported')) breaches.push(`${id}: false support`);
    if (forbidRewrite && f.some((x) => x.correction?.type === 'replace')) breaches.push(`${id}: unsafe rewrite`);
    if (requireFinding && f.length === 0) breaches.push(`${id}: no finding`);
  }
  assert.deepEqual(breaches, []);
});

test('its controls keep their meaning: the qualified claim and the warranty are supported, an affirmative mismatch is still rewritten, an over-limit decimal is still contradicted', () => {
  assert.deepEqual(statuses('Aurora Lamp battery lasts up to 12 hours at medium brightness.'), ['FCT-001:supported']);
  assert.deepEqual(statuses('The Aurora Lamp includes a 2-year warranty for $30.'), ['FCT-004:supported']);
  const mismatch = facts(run('Aurora Lamp battery lasts 30 hours.'))[0];
  assert.equal(mismatch.status, 'contradicted');
  assert.deepEqual(mismatch.correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
  assert.equal(facts(run('Aurora Lamp battery lasts up to 12.5 hours at medium brightness.'))[0].status, 'contradicted');
});

// ---------------------------------------------------------------- subject: whose claim is it?

test('a different subject is never supported, contradicted or rewritten with the lamp\'s fact: it goes to a person with advice that names what was not placed', () => {
  for (const [text, word, id] of [
    ['Our phone battery lasts up to 12 hours at medium brightness.', 'phone', 'FCT-001'],
    ['The museum audio guide battery lasts up to 12 hours at medium brightness.', 'museum', 'FCT-001'],
    ['The office printer includes a 2-year warranty.', 'printer', 'FCT-004'],
    ['Our tablet battery lasts up to 12 hours at medium brightness.', 'tablet', 'FCT-001'],
    ["The speaker's battery lasts up to 12 hours at medium brightness.", 'speaker', 'FCT-001'],
    ['Up to 12 hours of phone battery at medium brightness.', 'phone', 'FCT-001'],
    ['The battery of the e-reader lasts up to 12 hours at medium brightness.', 'e-reader', 'FCT-001'],
    ['A full charge lasts up to 12 hours in the phone at medium brightness.', 'phone', 'FCT-001'],
    ['Our laptop comes with a 2-year warranty.', 'laptop', 'FCT-004'],
    ['Printers include a 2-year warranty.', 'printers', 'FCT-004'],
    ['The tablet boasts a 2-year warranty.', 'tablet', 'FCT-004'],
    ['Fernlight phone battery lasts up to 12 hours at medium brightness.', 'phone', 'FCT-001'], // the company name does not make a phone the lamp
  ]) {
    const r = run(text);
    const f = facts(r);
    assert.equal(f.length, 1, text);
    assert.equal(f[0].ruleId, id, text);
    assert.equal(f[0].status, 'needs_review', text);
    assert.equal(f[0].severity, 'warning', text);
    assert.equal(f[0].correction.type, 'advice', text);
    assert.match(f[0].explanation, /something the approved fact does not mention/, text);
    assert.ok(f[0].explanation.toLowerCase().includes(`“${word}`), `${text} -> ${f[0].explanation}`);
    assert.match(f[0].correction.text, /Check what this sentence is about/);
    assert.match(f[0].correction.text, /Nothing is rewritten automatically/);
    assert.equal(applyReplacements(text, r.findings), text, 'no offered correction changes the text');
  }
});

test('a figure that DISAGREES for a different subject is not a contradiction of the lamp\'s fact, and is not rewritten with the lamp\'s number', () => {
  const text = 'Our phone battery lasts 30 hours.';
  const f = facts(run(text));
  assert.deepEqual(f.map((x) => x.status), ['needs_review']); // it used to be contradicted, with an offered rewrite to "up to 12 hours at medium brightness"
  assert.ok(!run(text).findings.some((x) => x.severity === 'error'), 'not a blocking error: a person reads it');
  assert.equal(applyReplacements(text, run(text).findings), text);
});

test('boolean facts follow the same rule: the lamp is not waterproof, but that does not make a printer\'s claim a contradiction', () => {
  assert.deepEqual(statuses('The printer is waterproof.'), ['FCT-002:needs_review']);
  assert.deepEqual(statuses('The Aurora Lamp is waterproof.'), ['FCT-002:contradicted']);
  assert.deepEqual(statuses('It is totally waterproof.'), ['FCT-002:contradicted'], 'bare wording about "it" is read as the campaign\'s own product, as before');
  assert.deepEqual(statuses('The Aurora Lamp is not waterproof.'), []);
});

test('positive controls: wording about the lamp itself, or naming no subject at all, is still judged as before', () => {
  for (const [text, want] of [
    ['Aurora Lamp battery lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['The Aurora Lamp lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Our reading lamp battery runs up to 12 hours at medium brightness.', 'FCT-001:supported'], // however the lamp is described
    ['A full charge lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Battery lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Enjoy up to 12 hours of battery at medium brightness.', 'FCT-001:supported'],
    ['Fernlight battery lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Includes a 2-year warranty.', 'FCT-004:supported'],
    ['Comes with a 2-year warranty.', 'FCT-004:supported'],
    ['Every Aurora Lamp carries a 2-year limited warranty.', 'FCT-004:supported'],
    ['Designed for indoor use only.', 'FCT-002:supported'],
    ['Its body is 100% recycled aluminium.', 'FCT-003:supported'],
  ]) assert.deepEqual(statuses(text), [want], text);
});

test('a mixed sentence is judged clause by clause: the lamp\'s claim stays supported while the other subject\'s goes to a person', () => {
  assert.deepEqual(statuses('Our speaker has a 2-year warranty and the Aurora Lamp lasts up to 12 hours at medium brightness.').sort(), ['FCT-001:supported', 'FCT-004:needs_review']);
  assert.deepEqual(statuses('The Aurora Lamp lasts up to 12 hours at medium brightness, while the phone lasts 12 hours.').sort(), ['FCT-001:needs_review', 'FCT-001:supported']);
});

test('the seeded sample campaigns keep their findings: clean copy stays clean, the problem draft keeps its contradictions', () => {
  // SUB-2's approved revision (a clean control in the demo) and SUB-1's first draft
  const clean = run('Meet the Aurora Lamp, a reading lamp made to be easy on the eyes. Its body is 100% recycled aluminium, and a full charge runs up to 12 hours. Designed for indoor use.');
  assert.deepEqual(facts(clean).map((f) => `${f.ruleId}:${f.status}`).sort(), ['FCT-001:supported', 'FCT-002:supported', 'FCT-003:supported']);
  const bad = run("Meet the aurora lamp!!! The cheapest, best reading light ever, guaranteed to fix your sleep. A full charge lasts 30 hours, and it's totally waterproof. Includes a 5-year warranty. Join 10,000 happy readers today!");
  assert.deepEqual(facts(bad).map((f) => `${f.ruleId}:${f.status}`).sort(), ['FCT-001:contradicted', 'FCT-002:contradicted', 'FCT-004:contradicted']);
});

test('a workspace with no declared product name has no subject to compare with: the subject check stays off there (legacy behaviour, stated plainly)', () => {
  const legacy = structuredClone(G);
  legacy.terms = legacy.terms.filter((t) => t.kind !== 'naming' || t.preferred === legacy.brand.name); // only the company name remains
  assert.deepEqual(statuses('Our phone battery lasts up to 12 hours at medium brightness.', legacy), ['FCT-001:supported']);
  // the intent check does not depend on a product name
  assert.deepEqual(statuses('Please delete the sentence: a full charge lasts 30 hours.', legacy), ['FCT-001:needs_review']);
});

test('the answer does not depend on what was checked before it (the cached patterns keep no state between texts)', () => {
  const texts = ['Our reading lamp battery runs up to 12 hours at medium brightness.', 'Our phone battery lasts up to 12 hours at medium brightness.', 'The Aurora Lamp lasts up to 12 hours at medium brightness.', 'The office printer includes a 2-year warranty.', 'Our reading lamp battery runs up to 12 hours at medium brightness.'];
  const alone = texts.map((t) => statuses(t, structuredClone(G)).join());
  const together = texts.map((t) => statuses(t).join());
  const reversed = [...texts].reverse().map((t) => statuses(t).join()).reverse();
  assert.deepEqual(together, alone);
  assert.deepEqual(reversed, alone);
});

// ---------------------------------------------------------------- intent: is the sentence a claim at all?

test('an editing instruction or an example is not a claim: it is never rewritten, never counted as a blocking contradiction, and the offered text changes nothing', () => {
  for (const text of [
    'Please delete the sentence: Aurora Lamp battery lasts 30 hours.',
    'Remove this claim: a full charge lasts 30 hours.',
    'This line should be removed: a full charge lasts 30 hours.',
    'Delete the next sentence. A full charge lasts 30 hours.',
    'Placeholder copy: a full charge lasts 30 hours.',
    'Example claim, not for use: a full charge lasts 30 hours.',
    'This 30 hours battery claim is fictional; do not reuse it in the campaign.',
  ]) {
    const r = run(text);
    const f = facts(r);
    assert.ok(f.length >= 1 && f.every((x) => x.status === 'needs_review' && x.correction.type === 'advice'), `${text} -> ${f.map((x) => x.status)}`);
    assert.ok(!r.findings.some((x) => x.severity === 'error'), text);
    assert.equal(applyReplacements(text, r.findings), text, text);
  }
  const f = facts(run('Please delete the sentence: a full charge lasts 30 hours.'))[0];
  assert.match(f.explanation, /instruction or a note about the text/);
  assert.match(f.correction.text, /carry out the instruction/);
  assert.deepEqual(statuses('Please remove the sentence: the lamp is waterproof.'), ['FCT-002:needs_review']);
});

test('ordinary copy that merely uses the same verbs or words is still judged as a claim', () => {
  for (const [text, want] of [
    ['For example, a full charge lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Change the way you read: a full charge lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Replace your desk lamp with the Aurora Lamp: a full charge lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Update: a full charge lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Fix your sleep: a full charge lasts 30 hours.', 'FCT-001:contradicted'],
    ['Cut the cord: a full charge lasts 30 hours.', 'FCT-001:contradicted'],
  ]) assert.deepEqual(statuses(text), [want], text);
  // and a real mismatch in such copy is still offered the same safe rewrite
  assert.deepEqual(facts(run('Fix your sleep: a full charge lasts 30 hours.'))[0].correction, { type: 'replace', replacement: 'up to 12 hours at medium brightness' });
});

// ---------------------------------------------------------------- unquantified endurance (a bounded list, not a paraphrase detector)

test('wording that promises endurance without a figure is not green: a short closed list, on duration facts only, and never when a figure was judged', () => {
  for (const text of [
    'Aurora Lamp keeps shining continuously from breakfast until midnight without needing a charge.',
    'Charge it once and it keeps going all night.',
    'On one charge it never runs out.',
    'It glows from dawn till dusk on a single charge.',
  ]) {
    const f = facts(run(text));
    assert.deepEqual(f.map((x) => `${x.ruleId}:${x.status}`), ['FCT-001:needs_review'], text);
    assert.equal(f[0].correction.type, 'advice');
    assert.match(f[0].explanation, /without a figure the approved fact can be compared with/);
  }
  assert.deepEqual(statuses('The lamp stays cool all day.'), [], 'no topic of the fact, no finding');
  assert.deepEqual(statuses('A full charge lasts up to 12 hours at medium brightness, all day if you read lightly.'), ['FCT-001:supported'], 'a judged figure is not double-reported');
  assert.deepEqual(statuses('The party lasts all night.'), [], 'a verb of the topic ("lasts") alone is not the battery');
  assert.deepEqual(statuses('The warranty lasts all day.'), [], 'nor is a different subject that happens to use it');
});

// ---------------------------------------------------------------- text printed in the image (a person\'s confirmed transcription)

test('the transcription path follows the same rules, and its corrections stay advice about new artwork', () => {
  const imageFacts = (it) => facts(run('', G, it), 'imageText');
  assert.deepEqual(imageFacts('Battery life up to 12 hours at medium brightness').map((f) => f.status), ['supported']);
  const foreign = imageFacts('Phone battery lasts up to 12 hours at medium brightness');
  assert.deepEqual(foreign.map((f) => f.status), ['needs_review']);
  assert.equal(foreign[0].correction.type, 'advice');
  assert.match(foreign[0].correction.text, /printed inside the image/);
  const same = imageFacts('Aurora Lamp battery lasts 30 hours');
  assert.deepEqual(same.map((f) => f.status), ['contradicted']);
  assert.equal(same[0].correction.type, 'advice', 'artwork cannot be rewritten automatically');
  assert.match(same[0].correction.text, /Wording the new artwork could print instead/);
  const note = imageFacts('Please delete the sentence: Aurora Lamp battery lasts 30 hours');
  assert.deepEqual(note.map((f) => f.status), ['needs_review']);
});

// ---------------------------------------------------------------- through the API: the effect at the point of decision

test('through the API: a wrong-subject claim is no longer green, an instruction is a warning (not a blocking error), and a person can still decide after acknowledging it', async () => {
  const t = await startApp();
  try {
    const mine = async (title, text) => (await t.call('POST', '/api/submissions', { role: 'creator', body: { title, text, asset: cleanContent().asset } })).json;
    const checks = async (text) => (await t.call('POST', '/api/check', { role: 'creator', body: { text, asset: {} } })).json;

    const phone = await checks('Our phone battery lasts up to 12 hours at medium brightness.');
    assert.deepEqual(phone.findings.filter((f) => f.ruleKind === 'fact').map((f) => f.status), ['needs_review']);
    assert.equal(phone.summary.supported, 0);

    const del = await mine('Instruction', 'Please delete the sentence: Aurora Lamp battery lasts 30 hours.');
    const d = (await t.call('GET', `/api/submissions/${del.id}`, { role: 'creator' })).json;
    assert.equal(d.workflow.blockingCount, 0, 'an instruction is not a blocking contradiction');
    assert.ok(d.current.findings.some((f) => f.status === 'needs_review' && f.correction.type === 'advice'));
    assert.equal(d.workflow.eligibility.requestReview.allowed, true);
    const rr = await t.call('POST', `/api/submissions/${del.id}/request-review`, { role: 'creator', body: { revision: 1, expected: d.workflow.binding } });
    assert.equal(rr.status, 201, rr.text);
    const seen = (await t.call('GET', `/api/submissions/${del.id}`, { role: 'reviewer' })).json;
    // the warning must be acknowledged: nothing is approved silently
    const refused = await t.call('POST', `/api/submissions/${del.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(refused.status, 422);
    assert.equal(refused.json.error.code, 'acknowledgement_required');
    const ok = await t.call('POST', `/api/submissions/${del.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen.workflow.binding, acknowledgeWarnings: true } });
    assert.equal(ok.status, 201, ok.text);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- m25b: positive scope, unknown subject, unknown verbs
// Found by the independent review of m25: the subject gate listed SHAPES (a verb from a short list, a phrase before the topic noun), so an unlisted verb
// ("Printers flaunt a 2-year warranty.") and a product name inside a possessive phrase about another device ("Aurora Lamp owners' phone battery …") were
// still SUPPORTED. The rule is now positive: a sentence is read as about the approved product only when its words say so (the product's name next to the
// claim) or say nothing about any subject (words the approved data and ordinary wording already account for). Any other word in the subject position is an
// unknown subject, whatever the verb is. Unknown means a person, never green.

test('m25b: an unknown verb does not hide an unknown subject (bare plural subjects, any verb)', () => {
  for (const text of [
    'Printers flaunt a 2-year warranty.',
    'Scanners flaunt a 2-year warranty.',
    'Laptops proudly flaunt a 2-year warranty.',
    'Drones tout a 2-year warranty.',
    'Kettles ship with a 2-year warranty.',
    'Speakers flaunt a battery that lasts up to 12 hours at medium brightness.',
    'Phones flaunt battery life of up to 12 hours at medium brightness.',
  ]) {
    const r = run(text);
    const f = facts(r);
    assert.ok(f.length >= 1 && f.every((x) => x.status === 'needs_review' && x.correction.type === 'advice'), `${text} -> ${f.map((x) => x.status)}`);
    assert.equal(applyReplacements(text, r.findings), text, text);
  }
});

test('m25b: the product\'s name does not bless a whole phrase about another device', () => {
  for (const text of [
    "Aurora Lamp owners' phone battery lasts up to 12 hours at medium brightness.",
    "Aurora Lamp users' tablet battery lasts up to 12 hours at medium brightness.",
    "The Aurora Lamp's companion phone battery lasts up to 12 hours at medium brightness.",
    'Our Aurora Lamp phone charger battery lasts up to 12 hours at medium brightness.',
    'Aurora Lamp Pro battery lasts up to 12 hours at medium brightness.',
    "Aurora Lamp owners' shower speaker is waterproof.",
    'The phone battery for the Aurora Lamp lasts up to 12 hours at medium brightness.',
  ]) {
    const r = run(text);
    const f = facts(r);
    assert.ok(f.length >= 1 && f.every((x) => x.status === 'needs_review' && x.correction.type === 'advice'), `${text} -> ${f.map((x) => x.status)}`);
    assert.equal(applyReplacements(text, r.findings), text, text);
  }
});

test('m25b: controls hold: the product named next to the claim, wording that names no subject, a claim whose own subject is the approved product inside a longer sentence', () => {
  for (const [text, want] of [
    ["The Aurora Lamp's battery lasts up to 12 hours at medium brightness.", 'FCT-001:supported'],
    ['Aurora Lamp battery lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Our reading lamp battery runs up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['The Aurora Lamp battery keeps going for up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['We tell readers a full charge lasts up to 12 hours at medium brightness.', 'FCT-001:supported'],
    ['Read for up to 12 hours on a single charge.', 'FCT-001:supported'],
    ['Includes a 2-year warranty.', 'FCT-004:supported'],
    ['The Aurora Lamp includes a 2-year warranty.', 'FCT-004:supported'],
    ['Aurora Lamp includes a 2-year warranty.', 'FCT-004:supported'],
    ['Designed for indoor use only.', 'FCT-002:supported'],
  ]) assert.deepEqual(statuses(text), [want], text);
});

test('m25b: contradiction safeguards stay: a real mismatch about the approved product is still contradicted and still gets only the safe rewrite', () => {
  for (const [text, replacement] of [
    ['Aurora Lamp battery lasts 30 hours.', 'up to 12 hours at medium brightness'],
    ['A full charge lasts 30 hours.', 'up to 12 hours at medium brightness'],
    ['Fix your sleep: a full charge lasts 30 hours.', 'up to 12 hours at medium brightness'],
    ['The Aurora Lamp includes a 5-year warranty.', '2-year'],
  ]) {
    const f = facts(run(text))[0];
    assert.equal(f.status, 'contradicted', text);
    assert.equal(f.correction.type, 'replace', text);
    assert.ok(f.correction.replacement.includes(replacement.split(' ')[0]), `${text} -> ${JSON.stringify(f.correction)}`);
  }
});

test('m25b: another thought before the claim\'s own phrase is not part of its subject, but only the modifiers right before the product name are excused', () => {
  // the claim's own phrase is judged alone: whatever introduces it belongs to another thought
  assert.deepEqual(statuses('We tell readers the Aurora Lamp lasts up to 12 hours at medium brightness.'), ['FCT-001:supported']);
  assert.deepEqual(statuses('We tell readers a full charge lasts up to 12 hours at medium brightness.'), ['FCT-001:supported']);
  // but unknown words that are not modifiers of the name (here separated from it by a preposition) are not excused by it
  for (const text of [
    'Phone cases for Aurora Lamp battery lasts up to 12 hours at medium brightness.',
    'The phone battery for the Aurora Lamp lasts up to 12 hours at medium brightness.',
  ]) assert.deepEqual(statuses(text), ['FCT-001:needs_review'], text);
});
