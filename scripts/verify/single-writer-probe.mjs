// Reproduces the "two writers on one workspace file" scenario with TWO REAL PROCESSES on a synthetic temporary file and prints
// what happened. It never touches data/ or any running server, and writes nothing outside its own temp directory.
//
//   node scripts/verify/single-writer-probe.mjs                      probe THIS source tree
//   node scripts/verify/single-writer-probe.mjs --root <other tree>  probe another extracted copy (for example an older build)
//
// Scenario: writer A opens the file, writer B opens the SAME file, A saves marker "writer-A" and is told it was saved,
// then B saves "writer-B" and is told it was saved. If both saves are acknowledged, both markers must be on disk.
// Output: JSON with opened/refused/acknowledged/persisted and `lostAcknowledgedWrite`.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.indexOf('--root');
const root = path.resolve(rootArg > 0 ? process.argv[rootArg + 1] : path.join(here, '..', '..'));
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-writer-probe-'));
const file = path.join(tmp, 'workspace.json');

// The child uses the tree under test, through its public Store API only. Older trees have no close(); then it just exits.
const childSource = `
import readline from 'node:readline';
const { Store, emptyState } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'store.js')).href)});
const [file, name] = process.argv.slice(2);
let store;
try { store = await Store.open(file, () => ({ ...emptyState(), markers: [] })); console.log('OPENED'); }
catch (e) { console.log('REFUSED ' + String(e.message).replace(/\\s+/g, ' ').slice(0, 160)); process.exit(3); }
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (line === 'write') { await store.mutate((d) => { d.markers.push(name); }); console.log('ACK ' + name); }
  if (line === 'quit') { if (store.close) await store.close(); process.exit(0); }
}
`;
const childFile = path.join(tmp, 'child.mjs');
await writeFile(childFile, childSource);

function start(name) {
  const proc = spawn(process.execPath, [childFile, file, name], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  const waiting = [];
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
    for (const w of [...waiting]) if (lines.some((l) => w.re.test(l))) (waiting.splice(waiting.indexOf(w), 1), w.done());
  });
  const exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  const waitFor = (re, ms = 15000) => new Promise((resolve, reject) => {
    if (lines.some((l) => re.test(l))) return resolve();
    waiting.push({ re, done: resolve });
    setTimeout(() => reject(new Error(`timed out waiting for ${re}; saw ${lines.join(' | ')}`)), ms).unref();
  });
  proc.stdin.on('error', () => {}); // a refused writer has already exited; writing to it is harmless
  return { proc, lines, exited, waitFor, send: (s) => proc.stdin.writable && proc.stdin.write(`${s}\n`) };
}

const report = { root, platform: process.platform };
const a = start('writer-A');
const b = start('writer-B');
try {
  await a.waitFor(/^OPENED/);
  await Promise.race([b.waitFor(/^(OPENED|REFUSED)/)]);
  report.bothOpened = a.lines.some((l) => /^OPENED/.test(l)) && b.lines.some((l) => /^OPENED/.test(l));
  report.secondWriter = b.lines.find((l) => /^(OPENED|REFUSED)/.test(l)) ?? null;
  const acknowledged = [];
  a.send('write');
  await a.waitFor(/^ACK/);
  acknowledged.push('writer-A');
  if (report.bothOpened) {
    b.send('write');
    await b.waitFor(/^ACK/);
    acknowledged.push('writer-B');
  }
  report.acknowledgedWrites = acknowledged;
  report.persistedMarkers = JSON.parse(await readFile(file, 'utf8')).markers;
  report.lostAcknowledgedWrite = acknowledged.some((m) => !report.persistedMarkers.includes(m));
  report.verdict = report.lostAcknowledgedWrite ? 'DATA LOSS: an acknowledged write is missing from disk' : report.bothOpened ? 'both opened, nothing lost (unexpected for two writers)' : 'second writer refused; no acknowledged write lost';
} catch (e) {
  report.error = e.message;
} finally {
  a.send('quit');
  b.send('quit');
  await Promise.race([Promise.all([a.exited, b.exited]), new Promise((r) => setTimeout(r, 4000))]);
  a.proc.kill('SIGKILL');
  b.proc.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.lostAcknowledgedWrite || report.error ? 1 : 0);
