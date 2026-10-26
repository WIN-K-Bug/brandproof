import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixtures } from '../scripts/eval-detection.js';

test('detection fixtures: every labelled case is reproduced (regression baseline on synthetic fixtures)', () => {
  const r = evaluateFixtures();
  assert.ok(r.cases >= 30);
  assert.deepEqual(r.failures, []);
  assert.equal(r.precision, 1);
  assert.equal(r.recall, 1);
});
