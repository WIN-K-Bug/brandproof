// Builds dist/brandproof-source.zip from an allow-list of project files, then verifies the archive
// contains nothing it should not (model weights, node_modules, saved data, .git, environment files).
// Uses the `tar` that ships with Windows 10+, macOS and Linux (`tar -a` writes a .zip).
// It only writes a local file. It does not upload or submit anything.
import { readdirSync, statSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['src', 'public', 'scripts', 'tests', 'docs', 'server.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore'];
const FORBIDDEN = /(^|\/)(node_modules|\.cache|data|demo-data|dist|\.git)(\/|$)|(^|\/)\.env|\.tmp$|\.lock$|\.lock\.takeover$|\.onnx$|\.pem$|\.key$|credentials|(^|\/)users\.json$|auth-workspace|\.assets(\/|$)|\.bak-/i;
// A real scrypt hash (long base64 salt and key) or a session-cookie-looking value must never be in the package.
const SECRET_CONTENT = /scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{20,}\$[A-Za-z0-9_-]{40,}|bp_session=[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{40,}/;

const files = [];
const walk = (rel) => {
  const abs = path.join(root, rel);
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) walk(path.posix.join(rel.replace(/\\/g, '/'), name));
  } else if (!FORBIDDEN.test(rel)) files.push(rel);
};
for (const item of INCLUDE) {
  try {
    walk(item);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

const leaks = files.filter((f) => /\.(js|mjs|json|md|html|css|txt)$/.test(f) && SECRET_CONTENT.test(readFileSync(path.join(root, f), 'utf8')));
if (leaks.length) {
  console.error('Refusing to package: credential-looking content in', leaks);
  process.exit(1);
}

const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });
const list = path.join(dist, 'files.txt');
const zip = path.join(dist, 'brandproof-source.zip');
writeFileSync(list, files.join('\n') + '\n');
rmSync(zip, { force: true });
// bsdtar (-a picks the zip format from the extension). Relative paths with cwd=root avoid drive-letter parsing problems.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
const made = spawnSync(TAR, ['-a', '-c', '-f', 'dist/brandproof-source.zip', '-T', 'dist/files.txt'], { encoding: 'utf8', cwd: root });
rmSync(list, { force: true });
if (made.status !== 0) {
  console.error('tar failed:', made.stderr || made.error);
  process.exit(1);
}

const listing = spawnSync(TAR, ['-t', '-f', 'dist/brandproof-source.zip'], { encoding: 'utf8', cwd: root }).stdout.split(/\r?\n/).filter(Boolean);
const bad = listing.filter((f) => FORBIDDEN.test(f));
if (bad.length) {
  console.error('Archive contains forbidden paths:', bad);
  process.exit(1);
}
console.log(`${zip}\n${listing.length} entries, ${(statSync(zip).size / 1024).toFixed(0)} KB. Verified: no node_modules, .cache, data, credential files, backups, .git, .env, model weights or key files, and no credential-looking content.`);
