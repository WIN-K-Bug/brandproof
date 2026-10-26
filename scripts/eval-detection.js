// Runs the rule checks over tests/fixtures/detection.json and reports precision/recall.
// The fixtures are synthetic and authored by the team: this is a regression baseline, not real-world accuracy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runChecks } from '../src/checks.js';
import { seedGuidelines } from '../src/seed.js';
import { validateGuidelines, assignIds } from '../src/validate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const blank = { name: '', alt: '', fileSha256: null, fg: null, bg: null, textSize: 'normal', colors: [] };

export function evaluateFixtures(file = path.join(root, 'tests/fixtures/detection.json')) {
  const { cases } = JSON.parse(readFileSync(file, 'utf8'));
  const g = assignIds(validateGuidelines(seedGuidelines()).value);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const failures = [];
  for (const c of cases) {
    const found = new Set(
      runChecks({ text: c.text, asset: { ...blank, ...(c.asset ?? {}) } }, g)
        .findings.filter((f) => f.status !== 'supported')
        .map((f) => `${f.ruleId}:${f.status}`),
    );
    const want = new Set(c.expect);
    const hit = [...want].filter((x) => found.has(x));
    const miss = [...want].filter((x) => !found.has(x));
    const extra = [...found].filter((x) => !want.has(x));
    tp += hit.length;
    fn += miss.length;
    fp += extra.length;
    if (miss.length || extra.length) failures.push({ id: c.id, miss, extra });
  }
  return {
    cases: cases.length,
    expectedFindings: tp + fn,
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    failures,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = evaluateFixtures();
  console.log(`Fixture cases: ${r.cases}  expected findings: ${r.expectedFindings}`);
  console.log(`TP ${r.tp}  FP ${r.fp}  FN ${r.fn}  precision ${r.precision.toFixed(3)}  recall ${r.recall.toFixed(3)}`);
  for (const f of r.failures) console.log(' FAIL', f.id, 'missing:', f.miss.join(',') || '-', 'unexpected:', f.extra.join(',') || '-');
  console.log('(synthetic fixtures; regression baseline, not real-world accuracy)');
}
