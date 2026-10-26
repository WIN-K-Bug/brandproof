// Second, separate localhost demo: the fictional "Fernlight showcase".
//
//   npm run demo:start          start (and, on first run, build) the showcase on port 4174 (next free port if busy)
//   npm run demo:bootstrap      only build/refresh the showcase data (stop the demo server first)
//
// Own data only: demo-data/fernlight-showcase.json (+ its .assets folder). It never touches data/, never kills a process,
// never resets anything. It runs the app in DEMO mode: the role picker is a demo switch, not sign-in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { bootstrapShowcase } from './demo/bootstrap.mjs';
import { onTermination } from '../src/lock.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.resolve(process.env.BRANDPROOF_DEMO_DATA || path.join(root, 'demo-data', 'fernlight-showcase.json'));
const FIRST_PORT = Number(process.env.DEMO_PORT) || 4174;
const bootstrapOnly = process.argv.includes('--bootstrap-only');

// Refuse anything that could point at real data.
const protectedFiles = [path.join(root, 'data', 'brandproof.json'), path.join(root, 'data', 'auth-workspace.json')].map((p) => path.resolve(p).toLowerCase());
if (protectedFiles.includes(dataFile.toLowerCase()) || dataFile.toLowerCase().startsWith(path.join(root, 'data').toLowerCase())) {
  console.error(`Refusing to use ${dataFile}: the showcase must have its own data file outside data/.`);
  process.exit(1);
}
if (FIRST_PORT === 4173) {
  console.error('Port 4173 belongs to the existing demo. Choose another DEMO_PORT.');
  process.exit(1);
}

// With --bootstrap-only the matcher is switched off (nothing to warm); otherwise the real offline matcher starts if installed.
let app;
try {
  app = await createApp({ dataFile, ...(bootstrapOnly ? { semantic: null } : {}) });
} catch (e) {
  console.error(`Could not start: ${e.message}`);
  process.exit(1);
}
onTermination(() => app.close());
let url = null;
for (let p = FIRST_PORT; p < FIRST_PORT + 16; p++) {
  try {
    url = await app.listen(bootstrapOnly ? 0 : p);
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

console.log('Preparing the fictional Fernlight showcase (idempotent; nothing is deleted or reset)…');
try {
  const r = await bootstrapShowcase(url, console.log);
  console.log(r.alreadyDone ? '  showcase data was already complete.' : `  done: ${r.did.length} step(s).`);
} catch (e) {
  console.error('Showcase bootstrap failed:', e.message);
  await app.close();
  process.exit(1);
}

if (bootstrapOnly) {
  await app.close();
  console.log(`Data file: ${dataFile}`);
  process.exit(0);
}

console.log(`\nBrandProof showcase (DEMO mode, fictional data) listening on ${url}`);
console.log(`Data file: ${dataFile}`);
console.log(`Images:    ${dataFile}.assets`);
console.log('Roles are a demo switch, not sign-in. Back up the JSON file AND its .assets folder together.');

// Report honestly whether the real offline source matcher came up.
const deadline = Date.now() + 90_000;
let status = null;
while (Date.now() < deadline) {
  status = await (await fetch(`${url}/api/semantic/status`)).json();
  if (status.state === 'ready' || status.state === 'unavailable' || status.state === 'error') break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(status?.state === 'ready' ? `AI source matching: READY (local embeddings, ${status.model.id}, offline, relevance only).` : `AI source matching: ${String(status?.state ?? 'unknown').toUpperCase()}${status?.reason ? ` (${status.reason})` : ''}. The rest of the demo works without it.`);
console.log('Press Ctrl+C to stop.');
