// Builds the PUBLICATION CANDIDATE: a clean folder (dist/public-candidate-m27/brandproof) and archive (dist/brandproof-public-candidate-m27.zip) of
// exactly the files that would become public, from an explicit allow-list, then scans every file and fails if it finds anything that must not be
// public: runtime data, locks, credentials, caches, installed packages, development evidence and handoffs, e-mail addresses, this computer's
// paths or user name. It writes an inventory with a SHA-256 per file beside the folder. It only writes local files under dist/: it does not
// initialise a repository, touch any remote, upload or submit anything.
//   node scripts/package-public.mjs
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(dist, 'public-candidate-m27', 'brandproof');
const zipPath = path.join(dist, 'brandproof-public-candidate-m27.zip');
const inventoryPath = path.join(dist, 'public-candidate-m27', 'INVENTORY.json');
const inventoryTxt = path.join(dist, 'public-candidate-m27', 'INVENTORY.sha256.txt');

// What may become public. Anything not listed here is not packaged.
const INCLUDE = ['src', 'public', 'scripts', 'tests', 'docs', 'server.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore', '.node-version', 'render.yaml'];
// Never packaged, wherever it appears. docs/evidence is development screenshots and run logs (replaced by a note); the rest is runtime or tooling state.
const FORBIDDEN = /(^|\/)(node_modules|\.cache|data|demo-data|dist|\.git|\.claude|\.taste-skill|handoffs|evidence)(\/|$)|(^|\/)\.env|\.tmp$|\.lock$|\.lock\.takeover$|\.onnx$|\.pem$|\.key$|credentials|(^|\/)users\.json$|auth-workspace|\.assets(\/|$)|\.bak-|(^|\/)skills-lock\.json$|(^|\/)\.brandproof-judge-root$|(^|\/)root-owner/i;
const EVIDENCE_NOTE = `# Development evidence is not part of this package

Screenshots, inspector reports and run logs produced during development are not included in the public source. They were made on fictional,
synthetic data and can be regenerated here: the browser scripts in \`scripts/browser/\` write their screenshots into this folder, and
\`npm run ui-smoke-judge\`, \`npm run ui-smoke-layout\` and the others are described in \`docs/verification.md\`. Where a document refers to a file in this
folder, that file is a development artefact, not something the code needs.
`;

// Content that must never be public.
const TEXT = /\.(js|mjs|cjs|json|md|html|css|txt|yaml|yml|svg)$/i;
const RULES = [
  ['an e-mail address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(com|org|net|io|in|edu|gov|co|me|dev|app)\b/i, (f) => f === 'package-lock.json'],
  ['a path or name from the machine that built it', /E:[\\/]+web[ %]?proj|gpt_codex_proj|\bMary\b|kevin75108102|AppData[\\/]+Local[\\/]+Temp[\\/]+claude/, (f) => f === 'scripts/package-public.mjs'], // the scanner's own rule text is exempt
  ['a private key or token', /BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{10}/, () => false],
  ['a real password hash or session cookie', /scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{40,}|bp_session=[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{40,}/, () => false],
];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const rel = (abs) => path.relative(outDir, abs).split(path.sep).join('/');
const sha256 = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

// ---- collect ----
const picked = [];
const skipped = [];
const walk = (r) => {
  const abs = path.join(root, r);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error(`refusing a symbolic link: ${r}`);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) walk(path.posix.join(r.replace(/\\/g, '/'), name));
  } else if (FORBIDDEN.test(r)) skipped.push(r);
  else picked.push(r);
};
for (const item of INCLUDE) {
  if (!existsSync(path.join(root, item))) throw new Error(`the allow-list names ${item}, which does not exist`);
  walk(item);
}
for (const required of ['server.js', 'package.json', 'package-lock.json', 'README.md', 'render.yaml', '.node-version', 'src/judge.js', 'public/index.html', 'public/archivo.woff2', 'docs/render-deploy.md', 'docs/licenses/OFL-Archivo.txt']) {
  if (!picked.includes(required)) throw new Error(`a required file is missing from the package: ${required}`);
}

// ---- scan before anything is written ----
const problems = [];
for (const f of picked) {
  const abs = path.join(root, f);
  if (statSync(abs).size > MAX_FILE_BYTES) problems.push(`${f}: larger than ${MAX_FILE_BYTES} bytes`);
  if (!TEXT.test(f)) continue;
  const text = readFileSync(abs, 'utf8');
  for (const [what, re, exempt] of RULES) if (!exempt(f) && re.test(text)) problems.push(`${f}: contains ${what}`);
}
if (problems.length) {
  console.error('Refusing to build the public candidate:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// ---- build the folder (only our own output folder is ever removed) ----
if (path.resolve(outDir) !== path.resolve(root, 'dist', 'public-candidate-m27', 'brandproof')) throw new Error('unexpected output folder');
rmSync(path.join(dist, 'public-candidate-m27'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const f of picked) {
  const dest = path.join(outDir, f);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(root, f), dest);
}
mkdirSync(path.join(outDir, 'docs', 'evidence'), { recursive: true });
writeFileSync(path.join(outDir, 'docs', 'evidence', 'README.md'), EVIDENCE_NOTE);

// ---- inventory (per-file hashes) ----
const walkOut = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkOut(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walkOut(outDir).map((abs) => ({ path: rel(abs), bytes: statSync(abs).size, sha256: sha256(abs) })).sort((a, b) => a.path.localeCompare(b.path));
const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
writeFileSync(inventoryPath, JSON.stringify({ files: files.length, totalBytes, entries: files }, null, 1));
writeFileSync(inventoryTxt, files.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n');

// ---- archive (the folder's contents at the top level, so it can be the root of a repository) ----
rmSync(zipPath, { force: true });
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const made = spawnSync(TAR, ['-a', '-c', '-f', zipPath, '-C', outDir, '.'], { encoding: 'utf8' });
if (made.status !== 0) throw new Error(`could not create the archive: ${made.stderr}`);
const listing = spawnSync(TAR, ['-t', '-f', zipPath], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter((l) => l && !l.endsWith('/')).map((l) => l.replace(/^\.\//, ''));
const missing = files.filter((f) => !listing.includes(f.path)).map((f) => f.path);
const extra = listing.filter((l) => !files.some((f) => f.path === l));
if (missing.length || extra.length) throw new Error(`the archive does not match the folder: missing ${missing.join(', ')} extra ${extra.join(', ')}`);

const zipHash = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(zipPath).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
console.log(JSON.stringify({ folder: outDir, archive: zipPath, archiveSha256: zipHash, archiveBytes: statSync(zipPath).size, files: files.length, totalBytes, excludedCount: skipped.length, inventory: inventoryPath }, null, 1));
