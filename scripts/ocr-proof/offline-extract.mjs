// Used by tests/ocr-real.test.js and by hand: read the text of one image through the app's own service, under the network blocker.
//   node --require ./scripts/ocr-proof/block-network.cjs scripts/ocr-proof/offline-extract.mjs <image.png> [control]
// Prints one JSON line. With `control` it first makes a deliberate network request to prove the blocker is live.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOcr } from '../../src/ocr.js';

const file = process.argv[2];
const out = { controlBlocked: null };
if (process.argv[3] === 'control') {
  out.controlBlocked = await fetch('https://example.com/').then(() => false, (e) => e.code === 'ENETBLOCKED');
}
const bytes = readFileSync(file);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const ocr = createOcr();
try {
  const r = await ocr.extract({ sha256, bytes });
  out.ok = true;
  out.text = r.text;
  out.confidence = r.confidence;
  out.imageSha256 = r.imageSha256;
} catch (e) {
  out.ok = false;
  out.status = e.status;
  out.code = e.code;
  out.message = e.message;
}
out.attempts = process.env.NET_ATTEMPT_LOG && existsSync(process.env.NET_ATTEMPT_LOG) ? readFileSync(process.env.NET_ATTEMPT_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;
ocr.stop();
console.log(JSON.stringify(out));
setTimeout(() => process.exit(0), 200);
