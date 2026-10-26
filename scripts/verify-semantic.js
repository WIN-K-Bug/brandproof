// Runs the REAL local embedding model (no mocks) over the seed guideline sources and prints
// what it retrieves for a few queries. Use this to check the optional AI source matching feature.
import { createSemantic, createWorkerEmbedder, localAvailability, semanticSources, bandOf } from '../src/semantic.js';
import { seedGuidelines } from '../src/seed.js';
import { validateGuidelines, assignIds } from '../src/validate.js';
import { guidelineHash } from '../src/service.js';

const avail = localAvailability();
if (!avail.ok) {
  console.log('UNAVAILABLE:', avail.reason);
  process.exit(2);
}
const g = assignIds(validateGuidelines(seedGuidelines()).value);
const embedder = createWorkerEmbedder();
const sem = createSemantic({ embedder });
const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'How long can the lamp stay lit before recharging?',
      'Can I use the lamp on the balcony when it rains?',
      'What is the body of the lamp made of?',
      'How long does the manufacturer cover repairs?',
      'The weather in Paris is rainy in autumn.',
      'Our quarterly revenue grew faster than analysts expected.',
    ];
const t0 = Date.now();
const out = await sem.match({
  passages: queries.map((q) => ({ start: 0, end: q.length, text: q })),
  guidelines: g,
  guidelineHash: guidelineHash(g),
});
console.log(`sources: ${out.sourceCount}  total ms (incl. model load + source embedding): ${Date.now() - t0}  runtime: ${embedder.runtime}`);
for (const r of out.results) {
  console.log(`\nQ: ${r.text}`);
  for (const m of r.matches) console.log(`   ${m.similarity.toFixed(3)} [${m.band.padEnd(8)}] ${m.sourceId} ${m.label}  — “${m.quote}”`);
}
const again = await sem.match({ passages: [{ start: 0, end: 5, text: 'lamp?' }], guidelines: g, guidelineHash: guidelineHash(g) });
console.log(`\nsecond call: sourceCacheHit=${again.sourceCacheHit} ms=${again.ms}`);
embedder.stop();
