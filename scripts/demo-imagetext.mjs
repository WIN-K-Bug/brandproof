// A fourth, separate localhost demo: reading and confirming the text in a campaign image (fictional data).
//
//   npm run demo:imagetext        start (and, on first run, build) it on port 4185 (next free port if busy)
//
// Own data only: demo-data/image-text-scenario.json (+ its .assets folder). It never touches data/, the showcase or the 12-to-8-hours
// scenario, never kills a process, never resets anything, and runs in DEMO mode (the role picker is a demo switch, not sign-in).
// The optional reader is used if it is installed; without it the manual transcription still works and the page says why.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { bootstrapImageText } from './demo/imagetext.mjs';
import { protectedReason } from './demo/consequence.mjs';
import { ocrAvailability } from '../src/ocr.js';
import { onTermination } from '../src/lock.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.resolve(process.env.BRANDPROOF_IMAGETEXT_DATA || path.join(root, 'demo-data', 'image-text-scenario.json'));
const FIRST_PORT = Number(process.env.DEMO_PORT) || 4185;

const otherDemo = /fernlight-showcase|aurora-8h-scenario/.test(path.basename(dataFile));
const refused = protectedReason(dataFile, root) ?? (otherDemo ? `${dataFile} belongs to another demo.` : null);
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

console.log('Preparing the fictional image text scenario (idempotent; nothing is deleted or reset)…');
try {
  const r = await bootstrapImageText(url, console.log);
  console.log(r.alreadyDone ? '  scenario data was already complete.' : `  done: ${r.did.length} step(s).`);
} catch (e) {
  console.error('Scenario bootstrap failed:', e.message);
  await app.close();
  process.exit(1);
}
const a = ocrAvailability();
console.log(`\nBrandProof image text scenario (DEMO mode, fictional data) listening on ${url}`);
console.log(`Data file: ${dataFile}`);
console.log(a.ok ? 'Reading text from images: AVAILABLE (local, offline; a draft for a person to check).' : `Reading text from images: UNAVAILABLE (${a.reason}). Typing the transcription still works.`);
console.log('Start here: open the campaign "Banner with text in the image" (acting as Creator) > Edit as new revision > Read text from image. Roles are a demo switch, not sign-in.');
console.log('Press Ctrl+C to stop.');
