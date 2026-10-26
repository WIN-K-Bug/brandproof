// Scores the factual qualifier / scope checks on tests/fixtures/claims-scope.json.
// The corpus is synthetic and written by the team: this is a regression baseline over our own sentences, not real-world accuracy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runChecks } from '../src/checks.js';
import { seedGuidelines } from '../src/seed.js';
import { validateGuidelines, assignIds } from '../src/validate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const blank = { name: '', alt: '', fileSha256: null, fg: null, bg: null, textSize: 'normal', colors: [] };

const isFact = (f) => f.ruleKind === 'fact' && f.ruleId.startsWith('FCT-');

/** Applies every offered text replacement, right to left, the way "Apply to draft" does. */
export function applyReplacements(text, findings) {
  let out = text;
  const reps = findings.filter((f) => f.field === 'text' && f.correction?.type === 'replace').sort((a, b) => b.span.start - a.span.start);
  for (const f of reps) out = out.slice(0, f.span.start) + f.correction.replacement + out.slice(f.span.end);
  return out;
}

export function evaluateClaims(file = path.join(root, 'tests/fixtures/claims-scope.json')) {
  const { cases } = JSON.parse(readFileSync(file, 'utf8'));
  const g = assignIds(validateGuidelines(seedGuidelines()).value);
  const run = (text) => runChecks({ text, asset: blank }, g);
  const groups = {};
  const total = { cases: 0, expected: 0, tp: 0, fp: 0, fn: 0, falseSupport: 0, badReplacement: 0, applyBreaks: 0, applied: 0 };
  const failures = [];
  const limits = [];
  for (const c of cases) {
    const r = run(c.text);
    const found = new Set(r.findings.filter((f) => f.status !== 'supported').map((f) => `${f.ruleId}:${f.status}`));
    const supported = new Set(r.findings.filter((f) => f.status === 'supported').map((f) => f.ruleId));
    const want = new Set(c.expect);
    const wantSupported = new Set(c.supported ?? []);
    const hit = [...want].filter((x) => found.has(x));
    const miss = [...want].filter((x) => !found.has(x));
    const extra = [...found].filter((x) => !want.has(x));
    const falseSupport = [...supported].filter((x) => !wantSupported.has(x));
    const missingSupport = [...wantSupported].filter((x) => !supported.has(x));
    const replacements = r.findings.filter((f) => isFact(f) && f.correction?.type === 'replace').map((f) => f.correction.replacement).sort();
    const wantReplacements = [...(c.replacements ?? [])].sort();
    const badReplacement = JSON.stringify(replacements) !== JSON.stringify(wantReplacements);

    let applyBreak = false;
    if (replacements.length) {
      const after = run(applyReplacements(c.text, r.findings.filter(isFact)));
      // The rewrite must remove every contradiction and add no finding that was not there before.
      const before = new Set(r.findings.map((f) => `${f.ruleId}:${f.status}`));
      const rewritten = new Set(r.findings.filter((f) => isFact(f) && f.correction?.type === 'replace').map((f) => f.ruleId));
      applyBreak = after.findings.some((f) => f.status === 'contradicted' && rewritten.has(f.ruleId)) || after.findings.some((f) => f.status !== 'supported' && !before.has(`${f.ruleId}:${f.status}`));
    }

    const bad = miss.length || extra.length || falseSupport.length || missingSupport.length || badReplacement || applyBreak;
    if (c.knownLimit) {
      limits.push({ id: c.id, text: c.text, wanted: c.expect, got: [...found], failsAsDocumented: Boolean(bad) });
      continue;
    }
    const gr = (groups[c.group] ??= { cases: 0, expected: 0, tp: 0, fp: 0, fn: 0 });
    gr.cases += 1;
    gr.expected += want.size;
    gr.tp += hit.length;
    gr.fp += extra.length;
    gr.fn += miss.length;
    total.cases += 1;
    total.expected += want.size;
    total.tp += hit.length;
    total.fp += extra.length;
    total.fn += miss.length;
    total.falseSupport += falseSupport.length + missingSupport.length;
    total.badReplacement += badReplacement ? 1 : 0;
    total.applied += replacements.length ? 1 : 0;
    total.applyBreaks += applyBreak ? 1 : 0;
    if (bad) failures.push({ id: c.id, miss, extra, falseSupport, missingSupport, replacements: badReplacement ? { got: replacements, want: wantReplacements } : undefined, applyBreak });
  }
  return { total, groups, failures, limits, precision: total.tp + total.fp ? total.tp / (total.tp + total.fp) : 1, recall: total.tp + total.fn ? total.tp / (total.tp + total.fn) : 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = evaluateClaims();
  const t = r.total;
  console.log(`Scored cases: ${t.cases}  expected non-supported findings: ${t.expected}`);
  console.log(`TP ${t.tp}  FP ${t.fp}  FN ${t.fn}  precision ${r.precision.toFixed(3)}  recall ${r.recall.toFixed(3)}`);
  console.log(`Support mismatches (false green or missing green): ${t.falseSupport}  Replacement mismatches: ${t.badReplacement}  Rewrites re-checked: ${t.applied}  Rewrites that broke on re-check: ${t.applyBreaks}`);
  for (const [name, gr] of Object.entries(r.groups)) console.log(`  ${name.padEnd(16)} cases ${String(gr.cases).padStart(2)}  expected ${String(gr.expected).padStart(2)}  TP ${gr.tp}  FP ${gr.fp}  FN ${gr.fn}`);
  for (const f of r.failures) console.log(' FAIL', JSON.stringify(f));
  console.log(`Known limits (not scored): ${r.limits.length}, of which ${r.limits.filter((l) => l.failsAsDocumented).length} still behave as documented`);
  for (const l of r.limits) console.log(`  limit ${l.id}: ${l.failsAsDocumented ? 'not handled' : 'now handled'}  got [${l.got.join(', ')}]`);
  console.log('(synthetic corpus; regression baseline over our own sentences, not real-world accuracy)');
}
