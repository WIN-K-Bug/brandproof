// Downloads the pinned public embedding model into .cache/models (this project only; nothing system-wide).
// Only public model files are downloaded. No campaign content is ever sent anywhere.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_DIR, MODEL } from '../src/semantic-paths.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpinned = [];

await mkdir(MODEL_DIR, { recursive: true });
for (const [name, meta] of Object.entries(MODEL.files)) {
  const url = `${MODEL.source}/resolve/${MODEL.revision}/${name}`;
  process.stdout.write(`${name} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== meta.size) throw new Error(`${name}: expected ${meta.size} bytes, got ${buf.length}`);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (meta.sha256 && meta.sha256 !== sha) throw new Error(`${name}: SHA-256 mismatch (${sha})`);
  if (!meta.sha256) unpinned.push([name, sha]);
  const dest = path.join(MODEL_DIR, name);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`${buf.length} bytes, sha256 ${sha.slice(0, 12)}…${meta.sha256 ? ' (verified against pin)' : ' (UNPINNED)'}`);
}
if (unpinned.length) {
  console.log('\nFiles with no pinned hash yet. Add these to src/semantic-model.json:');
  for (const [n, s] of unpinned) console.log(`  "${n}": ${s}`);
  process.exitCode = 2;
} else {
  console.log('\nModel ready:', MODEL_DIR, '(root', root + ')');
}
