// Downloads the pinned public English language data for the optional OCR into .cache/ocr (this project only).
// Only a public model file is downloaded; no campaign content is ever sent anywhere. The file is verified against its pinned
// size and SHA-256 BEFORE it is written, and the app refuses to start the reader on anything that does not match.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ENGINE, LANG_DIR, LANG_FILE, OCR_ROOT } from '../src/ocr.js';

const L = ENGINE.language;
await mkdir(LANG_DIR, { recursive: true });
process.stdout.write(`${L.file} from ${L.repository} @ ${L.commit.slice(0, 10)} ... `);
const res = await fetch(L.url);
if (!res.ok) throw new Error(`${L.url} -> HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length !== L.bytes) throw new Error(`expected ${L.bytes} bytes, got ${buf.length}`);
const sha = createHash('sha256').update(buf).digest('hex');
if (sha !== L.sha256) throw new Error(`SHA-256 mismatch (${sha}); nothing was written`);
await writeFile(LANG_FILE, buf);
console.log(`${buf.length} bytes, sha256 ${sha.slice(0, 12)}… (verified against the pin)`);
console.log(`\nOCR language data ready: ${path.relative(process.cwd(), LANG_FILE) || LANG_FILE} (root ${OCR_ROOT}).`);
console.log('Packages: tesseract.js', ENGINE.package.version, '(npm install). Licences: Apache-2.0 for the engine, WASM core and this data.');
