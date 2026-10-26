// Reproduces the Phase A proof with the project's installed, pinned engine: recognise each synthetic fixture OFFLINE and score it
// against the expected transcription that was written BEFORE any recognition (tests/fixtures/ocr/*.json).
//
//   node --require ./scripts/ocr-proof/block-network.cjs scripts/ocr-proof/phase-a.mjs [clean|stress|review] [--out report.json]
//
// With NET_ATTEMPT_LOG=<file> the blocker records (and refuses) any network attempt, in this thread AND the worker threads.
// Confidence is the engine's own heuristic. Nothing is corrected: a wrong digit stays wrong in the output.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, LANG_DIR, LANG_FILE } from '../../src/ocr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const require = createRequire(import.meta.url);
const set = ['stress', 'review'].includes(process.argv[2]) ? process.argv[2] : 'clean';
const specFile = path.join(root, 'tests', 'fixtures', 'ocr', { stress: 'fixtures-stress.json', review: 'fixtures-review.json', clean: 'fixtures-spec.json' }[set]);
const dir = path.join(root, 'tests', 'fixtures', 'ocr', set === 'stress' ? 'stress' : '');
const spec = JSON.parse(readFileSync(specFile, 'utf8'));

if (!existsSync(LANG_FILE)) {
  console.log(JSON.stringify({ unavailable: true, reason: `language data missing: run npm run fetch-ocr` }));
  process.exit(3);
}
const sha = createHash('sha256').update(readFileSync(LANG_FILE)).digest('hex');
if (sha !== ENGINE.language.sha256) {
  console.log(JSON.stringify({ unavailable: true, reason: `language data hash mismatch: ${sha}` }));
  process.exit(3);
}
const Tesseract = require('tesseract.js');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
const t0 = performance.now();
const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, { langPath: LANG_DIR, gzip: false, cacheMethod: 'none', logger: () => {}, errorHandler: (e) => console.error('worker error:', String(e).slice(0, 120)) });
const report = { set, tesseractJs: require('tesseract.js/package.json').version, core: require('tesseract.js-core/package.json').version, langSha256: sha, node: process.version, workerStartMs: Math.round(performance.now() - t0), results: [] };
for (const f of spec.fixtures) {
  const buf = readFileSync(path.join(dir, `${f.id}.png`));
  const t1 = performance.now();
  const res = await worker.recognize(buf, {}, { text: true });
  const raw = res.data.text;
  const got = norm(raw);
  const want = norm(f.expected);
  const nums = (got.match(/\d+/g) ?? []).sort();
  report.results.push({ id: f.id, kind: f.kind, ms: Math.round(performance.now() - t1), confidence: res.data.confidence, raw, exact: got === want, charErrorRate: want.length ? +(lev(got, want) / want.length).toFixed(3) : got.length ? 1 : 0, numbersExact: JSON.stringify(nums) === JSON.stringify([...f.numbers].sort()), mustContain: Object.fromEntries(f.mustContain.map((p) => [p, got.includes(p)])) });
}
await worker.terminate();
clearInterval(sampler);
report.peakRssMb = Math.round(peak / 1048576);
report.totalMs = Math.round(performance.now() - t0);
const o = process.argv.indexOf('--out');
if (o > 0) writeFileSync(process.argv[o + 1], `${JSON.stringify(report, null, 2)}\n`);
for (const r of report.results) console.log(`${r.id.padEnd(26)} ${String(r.ms).padStart(4)} ms  conf ${String(r.confidence).padStart(3)}  exact ${String(r.exact).padEnd(5)}  CER ${String(r.charErrorRate).padEnd(5)}  numbers ${String(r.numbersExact).padEnd(5)} ${JSON.stringify(r.raw.trim())}`);
console.log(`\n${set}: ${report.results.filter((r) => r.exact).length}/${report.results.length} exact, ${report.results.filter((r) => r.numbersExact).length}/${report.results.length} with every number exact; worker start ${report.workerStartMs} ms, total ${report.totalMs} ms, peak RSS ${report.peakRssMb} MB`);
process.exit(0);
