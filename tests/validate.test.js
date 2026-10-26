import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContent, validateNewSubmission, validateNewRevision, validateComment, validateDecision, validateGuidelines, assignIds, LIMITS } from '../src/validate.js';
import { seedGuidelines } from '../src/seed.js';

const paths = (r) => r.errors.map((e) => e.path);

test('content: normalises line endings, hex colours and defaults the asset', () => {
  const r = validateContent({ text: 'a\r\nb', asset: { name: ' hero.png ', alt: 'x', fg: '#abc', bg: '0f2a43', colors: ['#abc', '#AABBCC', '#112233'] } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.text, 'a\nb');
  assert.equal(r.value.asset.name, 'hero.png');
  assert.equal(r.value.asset.fg, '#AABBCC');
  assert.equal(r.value.asset.bg, '#0F2A43');
  assert.deepEqual(r.value.asset.colors, ['#AABBCC', '#112233']); // de-duplicated
  assert.equal(validateContent({ text: 'ok' }).value.asset.textSize, 'normal');
});

test('content: rejects empty, oversized, control characters and wrong types', () => {
  assert.deepEqual(paths(validateContent({ text: '   ' })), ['text']);
  assert.deepEqual(paths(validateContent({})), ['text']);
  assert.deepEqual(paths(validateContent({ text: 'x'.repeat(LIMITS.text + 1) })), ['text']);
  assert.deepEqual(paths(validateContent({ text: 'bad\u0000char' })), ['text']);
  assert.deepEqual(paths(validateContent({ text: 5 })), ['text']);
  assert.ok(paths(validateContent('nope')).includes('body'));
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: 'str' })), ['asset']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { alt: 'a'.repeat(LIMITS.alt + 1) } })), ['asset.alt']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { name: 'a\nb' } })), ['asset.name']);
});

test('asset: colours, digest, text size and list size are validated', () => {
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { fg: 'red' } })), ['asset.fg']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { colors: ['#12'] } })), ['asset.colors[0]']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { colors: Array(LIMITS.colors + 1).fill('#000000') } })), ['asset.colors']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { textSize: 'huge' } })), ['asset.textSize']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { name: 'a.png', fileSha256: 'ABC' } })), ['asset.fileSha256']);
  assert.deepEqual(paths(validateContent({ text: 'ok', asset: { fileSha256: 'a'.repeat(64) } })), ['asset.name']);
  assert.deepEqual(validateContent({ text: 'ok', asset: { name: 'a.png', fileSha256: 'a'.repeat(64) } }).errors, []);
});

test('submission, revision, comment and decision inputs', () => {
  assert.deepEqual(paths(validateNewSubmission({ text: 'ok' })), ['title']);
  assert.deepEqual(paths(validateNewSubmission({ title: 'x'.repeat(LIMITS.title + 1), text: 'ok' })), ['title']);
  assert.deepEqual(paths(validateNewRevision({ text: 'ok' })), ['baseRevision']);
  assert.deepEqual(paths(validateNewRevision({ text: 'ok', baseRevision: 1.5 })), ['baseRevision']);
  assert.deepEqual(paths(validateComment({ revision: 1, text: '' })), ['text']);
  assert.deepEqual(paths(validateComment({ revision: 1, text: 'x', ruleId: 'bad id' })), ['ruleId']);
  assert.deepEqual(validateComment({ revision: 1, text: 'x', ruleId: 'TRM-001' }).errors, []);

  const hash = 'a'.repeat(64);
  const expected = { guidelineVersion: 1, guidelineHash: hash, contentHash: hash, assetHash: hash };
  assert.deepEqual(validateDecision({ revision: 1, expected }).errors, []);
  assert.deepEqual(paths(validateDecision({ revision: 1 })), ['expected']);
  assert.deepEqual(paths(validateDecision({ revision: 1, expected: { ...expected, guidelineHash: 'zz' } })), ['expected.guidelineHash']);
  assert.deepEqual(paths(validateDecision({ revision: 1, expected }, { noteRequired: true })), ['note']);
  assert.deepEqual(paths(validateDecision({ revision: 1, expected, note: 'x', acknowledgeWarnings: 'yes' })), ['acknowledgeWarnings']);
});

test('guidelines: the seed validates, ids are assigned, and unknown extra fields are dropped', () => {
  const seed = { ...seedGuidelines(), injected: '<script>' };
  seed.terms[0].extra = 1;
  const r = validateGuidelines(seed);
  assert.deepEqual(r.errors, []);
  assert.equal('injected' in r.value, false);
  assert.equal('extra' in r.value.terms[0], false);
  assignIds(r.value);
  assert.deepEqual(r.value.terms.map((t) => t.id), ['TRM-001', 'TRM-002', 'TRM-003', 'TRM-004']);
  assert.deepEqual(r.value.facts.map((f) => f.id), ['FCT-001', 'FCT-002', 'FCT-003', 'FCT-004']);
  assert.deepEqual(r.value.palette.colors.map((f) => f.id), ['COL-001', 'COL-002', 'COL-003', 'COL-004']);
});

test('guidelines: every rule and fact must carry a source; shapes are enforced', () => {
  const g = seedGuidelines();
  delete g.terms[0].source.quote;
  g.facts[0].topicTerms = [];
  g.facts[0].value = 'twelve';
  g.palette.colors[0].hex = 'navy';
  g.terms[1].avoid = [];
  g.terms[1].enforceCase = false;
  g.terms[2].kind = 'weird';
  g.accessibility.minNormal = 99;
  g.style.exclamation.max = 1.5;
  const p = paths(validateGuidelines(g));
  for (const want of ['terms[0].source.quote', 'facts[0].topicTerms', 'facts[0].value', 'palette.colors[0].hex', 'terms[1].avoid', 'terms[2].kind', 'accessibility.minNormal', 'style.exclamation.max']) {
    assert.ok(p.includes(want), `${want} missing from ${p}`);
  }
});

test('guidelines: duplicate ids and bad id formats are rejected; palette needs a colour', () => {
  const g = validateGuidelines(seedGuidelines()).value;
  g.terms[0].id = 'TRM-005';
  g.terms[1].id = 'TRM-005';
  assert.throws(() => assignIds(g), (e) => e.duplicateId === 'TRM-005');
  const bad = seedGuidelines();
  bad.terms[0].id = 'X1';
  bad.palette.colors = [];
  assert.deepEqual(paths(validateGuidelines(bad)).sort(), ['palette.colors', 'terms[0].id'].sort());
  assert.deepEqual(paths(validateGuidelines(null))[0], 'guidelines');
});
