// A third, separate localhost demo: the fictional "12 to 8 hours" consequence scenario.
//
//   npm run demo:consequence      start (and, on first run, build) it on port 4180 (next free port if busy)
//
// Own data only: demo-data/aurora-8h-scenario.json (+ its .assets folder). It never touches data/ or the showcase data, never
// kills a process, never resets anything, and runs in DEMO mode (the role picker is a demo switch, not sign-in).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { bootstrapConsequence, protectedReason } from './demo/consequence.mjs';
import { onTermination } from '../src/lock.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.resolve(process.env.BRANDPROOF_CONSEQUENCE_DATA || path.join(root, 'demo-data', 'aurora-8h-scenario.json'));
const FIRST_PORT = Number(process.env.DEMO_PORT) || 4180;

const refused = protectedReason(dataFile, root);
if (refused) {
  console.error(`Refusing: ${refused}`);
  process.exit(1);
}
if (FIRST_PORT === 4173) {
  console.error('Port 4173 belongs to the existing demo. Choose another DEMO_PORT.');
  process.exit(1);
}

let app;
try {
  app = await createApp({ dataFile });
} catch (e) {
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
}
onTermination(() => app.close());
let url = null;
for (let p = FIRST_PORT; p < FIRST_PORT + 16; p++) {
  try {
    url = await app.listen(p);
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
}
if (!url) {
  console.error(`No free port from ${FIRST_PORT} to ${FIRST_PORT + 15}.`);
  await app.close();
  process.exit(1);
}

console.log('Preparing the fictional 12 to 8 hours scenario (idempotent; nothing is deleted or reset)…');
try {
  const r = await bootstrapConsequence(url, console.log);
  console.log(r.alreadyDone ? '  scenario data was already complete.' : `  done: ${r.did.length} step(s).`);
} catch (e) {
  console.error('Scenario bootstrap failed:', e.message);
  await app.close();
  process.exit(1);
}
console.log(`\nBrandProof consequence scenario (DEMO mode, fictional data) listening on ${url}`);
console.log(`Data file: ${dataFile}`);
console.log('Start here: Sources > the fact sheet > Version 2 > Preview impact… (acting as Manager). Roles are a demo switch, not sign-in.');
console.log('Press Ctrl+C to stop.');
