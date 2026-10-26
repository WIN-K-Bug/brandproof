import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, symlinkSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, emptyState } from '../src/store.js';
import { openAuth } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { markerPathFor, OwnershipError } from '../src/lock.js';
import { tempDir } from './helpers.js';
import { TEST_COST, synthPassword } from './auth-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const CHILD = path.join(here, 'fixtures', 'writer-child.mjs');
const fresh = () => ({ ...emptyState(), markers: [] });

// Every process a test spawns is reaped after the test, so a failing assertion can never leave a child that keeps the runner alive.
const spawned = new Set();
test.afterEach(() => {
  for (const p of spawned) p.kill('SIGKILL');
  spawned.clear();
});
const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

/** A real separate process with a line protocol (see fixtures/writer-child.mjs). */
function child(mode, file, env = {}) {
  const proc = spawn(process.execPath, [CHILD, mode, file], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  spawned.add(proc);
  const lines = [];
  let buf = '';
  const waiters = [];
  const pump = () => {
    for (const w of [...waiters]) {
      const hit = lines.findIndex((l) => w.re.test(l));
      if (hit >= 0) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(lines[hit]);
      }
    }
  };
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
    pump();
  });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  const api = {
    proc,
    lines,
    exited,
    waitLine: (re, ms = 20000) =>
      new Promise((resolve, reject) => {
        waiters.push({ re, resolve });
        pump();
        setTimeout(() => reject(new Error(`timed out waiting for ${re}; saw: ${lines.join(' | ')}`)), ms).unref();
      }),
    send: (line) => proc.stdin.write(`${line}\n`),
    /** READY or REFUSED, whichever comes first. */
    outcome: () => api.waitLine(/^(READY|REFUSED)/),
    kill: () => proc.kill('SIGKILL'),
  };
  return api;
}

async function sleeper() {
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  spawned.add(proc);
  await new Promise((r) => setTimeout(r, 150));
  return proc;
}
async function deadPid() {
  const proc = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => proc.on('exit', resolve));
  return proc.pid;
}
const plant = (markerPath, meta) => fs.writeFile(markerPath, typeof meta === 'string' ? meta : JSON.stringify({ v: 1, startedAt: new Date().toISOString(), purpose: 'workspace', ...meta }));

// ---------- the reproduced scenario ----------

test('two real processes on one workspace: the second is refused, nothing changes, and no acknowledged write is lost', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  const a = child('store', file);
  try {
    assert.match(await a.outcome(), /^READY/);
    const before = await fs.readFile(file);
    const entriesBefore = (await fs.readdir(tmp.dir)).sort();

    // writer B is refused, with an actionable message, before it reads, seeds, backs up or writes anything
    const b = child('store', file);
    const refused = await b.outcome();
    assert.match(refused, /^REFUSED/);
    assert.match(refused, /Another BrandProof process \(pid \d+/);
    assert.match(refused, /Use the server that is already running, or start this one with a different data file/);
    assert.match(refused, /delete only this runtime marker file, which holds no user data/);
    assert.deepEqual(await b.exited, { code: 3, signal: null });
    assert.ok(before.equals(await fs.readFile(file)), 'bytes unchanged');
    assert.deepEqual((await fs.readdir(tmp.dir)).sort(), entriesBefore, 'no new files (no seed, backup or temp)');

    // the in-process opener is refused too
    await assert.rejects(Store.open(file, fresh), (e) => e instanceof OwnershipError && e.code === 'workspace_in_use');

    // A's acknowledged write survives; B (after A lets go) sees it and adds its own
    a.send('write writer-A');
    await a.waitLine(/^WROTE writer-A/);
    assert.deepEqual((await read(file)).markers, ['writer-A']);
    a.send('quit');
    await a.waitLine(/^CLOSED/);
    assert.deepEqual(await a.exited, { code: 0, signal: null });
    assert.equal(existsSync(await markerPathFor(file)), false, 'the owner released its marker');

    const b2 = child('store', file);
    assert.match(await b2.outcome(), /^READY/);
    b2.send('write writer-B');
    await b2.waitLine(/^WROTE writer-B/);
    b2.send('quit');
    await b2.waitLine(/^CLOSED/);
    assert.deepEqual((await read(file)).markers, ['writer-A', 'writer-B'], 'both acknowledged writes persisted');
  } finally {
    a.kill();
    await tmp.cleanup();
  }
});

test('two processes starting at the same instant on a NEW file: exactly one owns it and the file is seeded once', async () => {
  for (let round = 0; round < 3; round++) {
    const tmp = await tempDir();
    const file = path.join(tmp.dir, 'new.json');
    const kids = [child('store', file), child('store', file), child('store', file)];
    try {
      const outcomes = await Promise.all(kids.map((k) => k.outcome()));
      assert.equal(outcomes.filter((o) => /^READY/.test(o)).length, 1, outcomes.join(' | '));
      assert.equal(outcomes.filter((o) => /^REFUSED/.test(o)).length, 2);
      assert.deepEqual((await read(file)).markers, []);
    } finally {
      kids.forEach((k) => k.kill());
      await Promise.all(kids.map((k) => k.exited));
      await tmp.cleanup();
    }
  }
});

test('different files run in parallel, each with its own owner', async () => {
  const tmp = await tempDir();
  const f1 = path.join(tmp.dir, 'one.json');
  const f2 = path.join(tmp.dir, 'two.json');
  const a = child('store', f1);
  const b = child('store', f2);
  try {
    assert.match(await a.outcome(), /^READY/);
    assert.match(await b.outcome(), /^READY/);
    a.send('write only-one');
    b.send('write only-two');
    await a.waitLine(/^WROTE/);
    await b.waitLine(/^WROTE/);
    assert.deepEqual((await read(f1)).markers, ['only-one']);
    assert.deepEqual((await read(f2)).markers, ['only-two']);
    assert.notEqual(await markerPathFor(f1), await markerPathFor(f2));
  } finally {
    a.kill();
    b.kill();
    await Promise.all([a.exited, b.exited]);
    await tmp.cleanup();
  }
});

test('ownership persists across many concurrent writes by the owner while a second process keeps being refused', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  const store = await Store.open(file, fresh);
  try {
    const writes = Array.from({ length: 40 }, (_, i) => store.mutate((d) => d.markers.push(`m${i}`)));
    const refused = [child('store', file), child('store', file)];
    const outs = await Promise.all(refused.map((k) => k.outcome()));
    await Promise.all(writes);
    assert.ok(outs.every((o) => /^REFUSED/.test(o)));
    assert.equal((await read(file)).markers.length, 40);
    assert.ok(existsSync(await markerPathFor(file)), 'still owned');
  } finally {
    await store.close();
    await tmp.cleanup();
  }
});

// ---------- same process ----------

test('same process: a duplicate open is refused, concurrent opens yield one winner, close is idempotent and reopen works', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  try {
    const first = await Store.open(file, fresh);
    await assert.rejects(Store.open(file, fresh), /This process already has this workspace file open/);
    await first.close();
    await first.close();
    const results = await Promise.allSettled([Store.open(file, fresh), Store.open(file, fresh), Store.open(file, fresh)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof OwnershipError).length, 2);
    await results.find((r) => r.status === 'fulfilled').value.close();
    const again = await Store.open(file, () => assert.fail('must not reseed'));
    await again.close();
  } finally {
    await tmp.cleanup();
  }
});

test('close drains accepted writes, releases ownership, and nothing can be written afterwards', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  try {
    const store = await Store.open(file, fresh);
    const pending = Array.from({ length: 25 }, (_, i) => store.mutate((d) => d.markers.push(`p${i}`)));
    const closing = store.close(); // called while every write is still queued
    await assert.rejects(store.mutate((d) => d.markers.push('late')), /store is closed/);
    await closing;
    await Promise.all(pending); // every accepted write completed
    assert.equal(existsSync(await markerPathFor(file)), false);
    const bytes = await fs.readFile(file);
    await assert.rejects(store.mutate((d) => d.markers.push('after')), /closed/);
    assert.ok(bytes.equals(await fs.readFile(file)), 'no write after close');
    const next = await Store.open(file, fresh);
    assert.equal(next.state.markers.length, 25);
    assert.ok(!next.state.markers.includes('late') && !next.state.markers.includes('after'));
    await next.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------- failed start-up ----------

test('every failed start-up releases what it took: bad file, failing seed, failing validator, wrong-mode workspace, wrong credential file', async () => {
  const tmp = await tempDir();
  const dir = tmp.dir;
  try {
    const bad = path.join(dir, 'bad.json');
    await fs.writeFile(bad, '{not json');
    await assert.rejects(Store.open(bad, fresh), /not valid JSON/);
    assert.equal(existsSync(await markerPathFor(bad)), false);
    assert.equal(await fs.readFile(bad, 'utf8'), '{not json', 'never overwritten');

    const seedFail = path.join(dir, 'seedfail.json');
    await assert.rejects(Store.open(seedFail, () => { throw new Error('seed exploded'); }), /seed exploded/);
    assert.equal(existsSync(await markerPathFor(seedFail)), false);

    const validated = path.join(dir, 'validated.json');
    await (await Store.open(validated, fresh)).close();
    await assert.rejects(Store.open(validated, fresh, { validate: () => { throw new Error('refused by validator'); } }), /refused by validator/);
    assert.equal(existsSync(await markerPathFor(validated)), false);
    await (await Store.open(validated, fresh)).close(); // and it can be opened normally afterwards

    // createApp: a demo workspace refused by authenticated mode, and a wrong credential file after the workspace was taken
    const demo = path.join(dir, 'demo.json');
    await (await createApp({ dataFile: demo, semantic: null })).close();
    await assert.rejects(createApp({ dataFile: demo, authFile: path.join(dir, 'auth', 'users.json'), mode: 'authenticated', semantic: null, authOptions: { cost: TEST_COST } }), /demo-mode workspace/);
    assert.equal(existsSync(await markerPathFor(demo)), false);

    const ws = path.join(dir, 'auth-ws.json');
    const notAuth = path.join(dir, 'not-auth.json');
    await (await Store.open(notAuth, fresh)).close();
    await assert.rejects(createApp({ dataFile: ws, authFile: notAuth, mode: 'authenticated', semantic: null, authOptions: { cost: TEST_COST } }), /not a BrandProof authentication file/);
    assert.equal(existsSync(await markerPathFor(ws)), false, 'the workspace taken before the credential file failed was released');
    assert.equal(existsSync(await markerPathFor(notAuth)), false);
    const ok = await createApp({ dataFile: ws, authFile: path.join(dir, 'real-auth.json'), mode: 'authenticated', semantic: null, authOptions: { cost: TEST_COST } });
    await ok.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------- crash, stale markers, conservative recovery ----------

test('crash: a killed owner leaves its marker; the next start recovers it only because that process is verifiably gone, and no data is lost', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  const a = child('store', file);
  try {
    assert.match(await a.outcome(), /^READY/);
    a.send('write before-crash');
    await a.waitLine(/^WROTE/);
    const marker = await markerPathFor(file);
    const oldToken = JSON.parse(await fs.readFile(marker, 'utf8')).token;
    a.kill();
    await a.exited;
    assert.ok(existsSync(marker), 'a hard kill cannot release its marker');
    const bytes = await fs.readFile(file);
    const store = await Store.open(file, () => assert.fail('must not reseed'));
    assert.deepEqual(store.state.markers, ['before-crash'], 'the acknowledged write is still there');
    assert.ok(bytes.equals(await fs.readFile(file)), 'recovery did not touch the data file');
    assert.notEqual(JSON.parse(await fs.readFile(marker, 'utf8')).token, oldToken, 'a new marker for the new owner');
    await store.close();
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(`${marker}.takeover`), false);
  } finally {
    a.kill();
    await tmp.cleanup();
  }
});

test('conservative: a live pid, another computer, an unreadable marker, a bad pid and a half-finished recovery are all refused and left alone', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  await (await Store.open(file, fresh)).close();
  const marker = await markerPathFor(file);
  const dataBytes = await fs.readFile(file);
  const live = await sleeper();
  const cases = [
    ['a live process', { pid: live.pid, host: os.hostname(), token: 'live-token' }],
    ['a live process, startedAt long ago (age alone proves nothing)', { pid: live.pid, host: os.hostname(), token: 'old', startedAt: '2001-01-01T00:00:00.000Z' }],
    ['another computer', { pid: await deadPid(), host: 'some-other-computer', token: 'other-host' }],
    ['garbage', 'this is not json'],
    ['empty', ''],
    ['a bad pid', { pid: 0, host: os.hostname(), token: 'zero' }],
    ['a negative pid', { pid: -5, host: os.hostname(), token: 'neg' }],
  ];
  try {
    for (const [name, meta] of cases) {
      await plant(marker, meta);
      const planted = await fs.readFile(marker);
      await assert.rejects(Store.open(file, () => assert.fail('must not reseed')), (e) => e instanceof OwnershipError && /runtime marker file/.test(e.message), name);
      assert.ok(planted.equals(await fs.readFile(marker)), `${name}: the marker was not touched`);
      assert.ok(dataBytes.equals(await fs.readFile(file)), `${name}: the data file was not touched`);
      assert.equal(live.exitCode, null, 'nothing was killed');
    }
    // a dead owner, but a recovery guard left behind (it stopped half-way): refuse and say which files to delete
    await plant(marker, { pid: await deadPid(), host: os.hostname(), token: 'dead' });
    await fs.writeFile(`${marker}.takeover`, '1');
    await assert.rejects(Store.open(file, fresh), /\.lock\.takeover/);
    assert.ok(existsSync(marker) && existsSync(`${marker}.takeover`));
    await fs.rm(`${marker}.takeover`);
    // with the guard gone, the verifiably dead owner is recovered
    const store = await Store.open(file, fresh);
    await store.close();
  } finally {
    live.kill();
    await tmp.cleanup();
  }
});

test('two processes recovering the same stale marker at once: exactly one wins, every time', async () => {
  for (let round = 0; round < 4; round++) {
    const tmp = await tempDir();
    const file = path.join(tmp.dir, 'ws.json');
    await (await Store.open(file, fresh)).close();
    await plant(await markerPathFor(file), { pid: await deadPid(), host: os.hostname(), token: `stale-${round}` });
    const kids = [child('store', file), child('store', file), child('store', file), child('store', file)];
    try {
      const outs = await Promise.all(kids.map((k) => k.outcome()));
      assert.equal(outs.filter((o) => /^READY/.test(o)).length, 1, `round ${round}: ${outs.join(' | ')}`);
      assert.equal(outs.filter((o) => /^REFUSED/.test(o)).length, 3);
    } finally {
      kids.forEach((k) => k.kill());
      await Promise.all(kids.map((k) => k.exited));
      await tmp.cleanup();
    }
  }
});

test('a marker belonging to someone else is never released by a store that does not own it', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  try {
    const store = await Store.open(file, fresh);
    const marker = await markerPathFor(file);
    await plant(marker, { pid: process.pid, host: os.hostname(), token: 'someone-elses-token' }); // replaced behind our back
    await store.close();
    assert.ok(existsSync(marker), 'a marker with a different token is left in place');
    assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).token, 'someone-elses-token');
  } finally {
    await tmp.cleanup();
  }
});

// ---------- release on exit paths ----------

test('process exit without close() and an uncaught error both release the owner\'s marker', async () => {
  for (const how of ['exit', 'throw']) {
    const tmp = await tempDir();
    const file = path.join(tmp.dir, 'ws.json');
    const a = child('store', file);
    try {
      assert.match(await a.outcome(), /^READY/);
      const marker = await markerPathFor(file);
      assert.ok(existsSync(marker));
      a.send(how);
      await a.exited;
      assert.equal(existsSync(marker), false, `${how}: marker released by the exit hook`);
      const store = await Store.open(file, () => assert.fail('must not reseed'));
      await store.close();
    } finally {
      a.kill();
      await tmp.cleanup();
    }
  }
});

test('graceful termination of a real server releases its files (POSIX signals; on Windows only Ctrl+C in a console can do this, which cannot be sent here)', { skip: process.platform === 'win32' }, async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, BRANDPROOF_DATA: file, PORT: '4590' }, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(proc);
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !/listening on/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /listening on/);
    const marker = await markerPathFor(file);
    assert.ok(existsSync(marker));
    proc.kill('SIGTERM');
    await new Promise((r) => proc.on('exit', r));
    assert.equal(existsSync(marker), false);
  } finally {
    proc.kill('SIGKILL');
    await tmp.cleanup();
  }
});

// ---------- aliases ----------

test('path aliases name the same marker: relative, dot-dot, slashes, a junction, and (Windows) letter case', async () => {
  const tmp = await tempDir();
  const dir = tmp.dir;
  const file = path.join(dir, 'Space Dir', 'ws.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const store = await Store.open(file, fresh);
  try {
    const aliases = [
      path.relative(process.cwd(), file),
      path.join(dir, 'Space Dir', '..', 'Space Dir', 'ws.json'),
      file.replaceAll('\\', '/'),
      path.join(dir, 'Space Dir', '.', 'ws.json'),
    ];
    const junction = path.join(dir, 'link-to-dir');
    symlinkSync(path.dirname(file), junction, process.platform === 'win32' ? 'junction' : 'dir');
    aliases.push(path.join(junction, 'ws.json'));
    if (process.platform === 'win32') {
      aliases.push(file.toUpperCase(), file.toLowerCase(), path.join(path.dirname(file), 'WS.JSON'));
      aliases.push(file[0].toLowerCase() + file.slice(1));
    }
    const marker = await markerPathFor(file);
    for (const alias of aliases) {
      assert.equal(await markerPathFor(alias), marker, `same marker for ${alias}`);
      await assert.rejects(Store.open(alias, fresh), (e) => e instanceof OwnershipError, `refused via ${alias}`);
    }
  } finally {
    await store.close();
    await tmp.cleanup();
  }
});

test('DOCUMENTED LIMIT: a hard link to the same file under another name is NOT detected', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  const store = await Store.open(file, fresh);
  const link = path.join(tmp.dir, 'hardlink.json');
  try {
    linkSync(file, link);
    const second = await Store.open(link, () => assert.fail('already exists'));
    assert.notEqual(await markerPathFor(link), await markerPathFor(file), 'different names, different markers: outside the guarantee');
    await second.close();
  } finally {
    await store.close();
    await tmp.cleanup();
  }
});

// ---------- credentials ----------

test('credential file: duplicate and cross-process opens are refused, so account setup cannot race a running credential writer', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'auth', 'users.json');
  const holder = child('auth', file);
  try {
    assert.match(await holder.outcome(), /^READY/);
    holder.send('user alice');
    await holder.waitLine(/^USER alice/);
    const before = await fs.readFile(file);
    // what `npm run auth:setup` does first is openAuth(file): it is refused while another process owns the file
    await assert.rejects(openAuth(file, { cost: TEST_COST }), (e) => e instanceof OwnershipError && /credential file/.test(e.message) && /Stop that server before running account setup/.test(e.message));
    const second = child('auth', file);
    assert.match(await second.outcome(), /^REFUSED.*credential file/);
    assert.ok(before.equals(await fs.readFile(file)), 'not changed');
    holder.send('quit');
    await holder.waitLine(/^CLOSED/);
    // now setup can run, sees alice, and adds bob: nothing lost
    const setup = await openAuth(file, { cost: TEST_COST });
    assert.equal(setup.userCount(), 1);
    await setup.createUser({ username: 'bob', displayName: 'Bob', role: 'creator', password: synthPassword() });
    await assert.rejects(openAuth(file, { cost: TEST_COST }), /already has this credential file open/);
    await setup.close();
    const check = await openAuth(file, { cost: TEST_COST });
    assert.deepEqual(check.listUsers().map((u) => u.username).sort(), ['alice', 'bob']);
    await check.close();
  } finally {
    holder.kill();
    await tmp.cleanup();
  }
});

test('closing the credential store drains accepted writes; an account write racing the close is either saved or refused, never silently lost', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'users.json');
  try {
    const auth = await openAuth(file, { cost: TEST_COST });
    // accepted into the queue before close(): must be on disk when close() returns
    const accepted = Array.from({ length: 5 }, (_, i) => auth.store.mutate((d) => d.audit.push({ at: 'x', event: `accepted-${i}`, actor: null, subject: null, ip: null })));
    // a full createUser hashes the password first, so it reaches the queue later: it races the close
    const racing = auth.createUser({ username: 'carol', displayName: 'Carol', role: 'creator', password: synthPassword() }).then(() => 'saved', (e) => `refused: ${e.message}`);
    await auth.close();
    await Promise.all(accepted);
    const outcome = await racing;
    const again = await openAuth(file, { cost: TEST_COST });
    assert.equal(again.store.state.audit.filter((e) => e.event.startsWith('accepted-')).length, 5, 'every accepted write is on disk');
    const saved = again.listUsers().some((u) => u.username === 'carol');
    assert.equal(saved, outcome === 'saved', `outcome "${outcome}" must match what is on disk`);
    if (!saved) assert.match(outcome, /closed/);
    await again.close();
  } finally {
    await tmp.cleanup();
  }
});

// ---------- real servers ----------

test('two real servers on one workspace: the second refuses to start, the first keeps serving; a different file starts on the next free port', async () => {
  const tmp = await tempDir();
  const fileA = path.join(tmp.dir, 'a.json');
  const fileB = path.join(tmp.dir, 'b.json');
  const start = (file, port) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, BRANDPROOF_DATA: file, PORT: String(port), BRANDPROOF_SEMANTIC: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.add(proc);
    const r = { proc, out: '', err: '' };
    proc.stdout.on('data', (d) => (r.out += d));
    proc.stderr.on('data', (d) => (r.err += d));
    r.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
    r.listening = async () => {
      for (let i = 0; i < 100 && !/listening on/.test(r.out) && r.exitCode === undefined; i++) await new Promise((x) => setTimeout(x, 100));
      return r.out.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? null;
    };
    return r;
  };
  const first = start(fileA, 4520);
  let second;
  let third;
  try {
    const port1 = await first.listening();
    assert.equal(port1, '4520');
    const bytes = await fs.readFile(fileA);

    // the free-port fallback must NOT turn into a second writer on the same file
    second = start(fileA, 4520);
    assert.equal(await second.exited, 1);
    assert.match(second.err, /Could not start: Another BrandProof process \(pid \d+/);
    assert.match(second.err, /different data file/);
    assert.equal(second.out.includes('listening on'), false, 'it never listened on any port');
    assert.ok(bytes.equals(await fs.readFile(fileA)), 'the workspace file was not touched');
    const res = await fetch(`http://127.0.0.1:${port1}/api/meta`);
    assert.equal(res.status, 200, 'the first server is unaffected');

    // a DIFFERENT file still starts, and port fallback still works for it
    third = start(fileB, 4520);
    const port3 = await third.listening();
    assert.equal(port3, '4521', 'next free port');
    assert.equal((await fetch(`http://127.0.0.1:${port3}/api/meta`)).status, 200);

    // no marker token or marker path appears in ordinary API output
    const token = JSON.parse(await fs.readFile(await markerPathFor(fileA), 'utf8')).token;
    for (const p of ['/api/meta', '/api/submissions', '/api/submissions/SUB-1', '/api/submissions/SUB-1/dossier', '/api/semantic/status', '/api/sources']) {
      const body = await (await fetch(`http://127.0.0.1:${port1}${p}`, { headers: { 'x-demo-role': 'manager' } })).text();
      assert.ok(!body.includes(token) && !/\.lock\b/.test(body), p);
    }
  } finally {
    first.proc.kill();
    second?.proc.kill();
    third?.proc.kill();
    await Promise.all([first.exited, third?.exited]);
    await tmp.cleanup();
  }
});

test('the server\'s credential file is owned too: account setup against a running authenticated server is refused', async () => {
  const tmp = await tempDir();
  const ws = path.join(tmp.dir, 'ws.json');
  const auth = path.join(tmp.dir, 'users.json');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, BRANDPROOF_MODE: 'authenticated', BRANDPROOF_DATA: ws, BRANDPROOF_AUTH_FILE: auth, PORT: '4540', BRANDPROOF_SEMANTIC: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(proc);
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  const exited = new Promise((r) => proc.on('exit', r));
  try {
    for (let i = 0; i < 100 && !/listening on/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /listening on/);
    await assert.rejects(openAuth(auth, { cost: TEST_COST }), /Stop that server before running account setup/);
    await assert.rejects(Store.open(ws, fresh), /Another BrandProof process/);
    assert.ok(existsSync(await markerPathFor(ws)) && existsSync(await markerPathFor(auth)));
  } finally {
    proc.kill();
    await exited;
    await tmp.cleanup();
  }
});

// ---------- file symlinks: refused, never replaced ----------

/** Expect a refusal; if the open wrongly succeeds, close it so a regression fails fast instead of leaving a store open. */
const refused = (open, check) =>
  assert.rejects(async () => {
    const h = await open();
    await h.close();
  }, check);

async function fileSymlink(target, alias) {
  try {
    await fs.symlink(target, alias, 'file');
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) return false; // this machine may not allow creating file symlinks
    throw e;
  }
}

test('a data file that is a symbolic link is refused before anything is read or written; the link and its target stay exactly as they were', async (t) => {
  const tmp = await tempDir();
  const target = path.join(tmp.dir, 'target.json');
  const alias = path.join(tmp.dir, 'alias.json');
  try {
    await (await Store.open(target, fresh)).close();
    if (!(await fileSymlink(target, alias))) return t.skip('file symlinks cannot be created on this machine');
    const before = await fs.readFile(target);
    const entries = (await fs.readdir(tmp.dir)).sort();
    await refused(() => Store.open(alias, () => assert.fail('must not seed')), (e) => e.code === 'data_path_unsupported' && /symbolic link/.test(e.message) && /real file/.test(e.message));
    assert.deepEqual((await fs.readdir(tmp.dir)).sort(), entries, 'no marker, temp, backup or other file was created');
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true, 'the link is still a link');
    assert.ok(before.equals(await fs.readFile(target)));

    // a dangling link is refused too, and nothing is created behind it
    const dangling = path.join(tmp.dir, 'dangling.json');
    await fs.symlink(path.join(tmp.dir, 'nowhere.json'), dangling, 'file');
    await refused(() => Store.open(dangling, fresh), (e) => e.code === 'data_path_unsupported');
    assert.equal(existsSync(path.join(tmp.dir, 'nowhere.json')), false);

    // credentials and the whole app are refused the same way
    const authAlias = path.join(tmp.dir, 'users-alias.json');
    const authTarget = path.join(tmp.dir, 'users.json');
    await (await openAuth(authTarget, { cost: TEST_COST })).close();
    await fs.symlink(authTarget, authAlias, 'file');
    const authBefore = await fs.readFile(authTarget);
    await refused(() => openAuth(authAlias, { cost: TEST_COST }), (e) => e.code === 'data_path_unsupported');
    assert.ok(authBefore.equals(await fs.readFile(authTarget)));
    await refused(() => createApp({ dataFile: alias, semantic: null }), (e) => e.code === 'data_path_unsupported');
    assert.equal(existsSync(`${alias}.assets`), false, 'no image folder was created for the alias');
  } finally {
    await tmp.cleanup();
  }
});

test('the reviewer\'s sequence: after the owner has really written, a symlink alias cannot get in, and neither the link nor the target is replaced', async (t) => {
  const tmp = await tempDir();
  const target = path.join(tmp.dir, 'target.json');
  const alias = path.join(tmp.dir, 'alias.json');
  const a = child('store', target);
  try {
    assert.match(await a.outcome(), /^READY/);
    if (!(await fileSymlink(target, alias))) return t.skip('file symlinks cannot be created on this machine');
    a.send('write from-A-1');
    await a.waitLine(/^WROTE from-A-1/);
    // second writer by the alias, before and after more writes by the owner, in this process and in another
    for (let i = 0; i < 2; i++) {
      await refused(() => Store.open(alias, fresh), (e) => e.code === 'data_path_unsupported');
      const b = child('store', alias);
      assert.match(await b.outcome(), /^REFUSED.*symbolic link/);
      assert.deepEqual(await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('still running'), 5000))]), { code: 3, signal: null });
      a.send(`write from-A-${i + 2}`);
      await a.waitLine(new RegExp(`^WROTE from-A-${i + 2}`));
    }
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true, 'the symlink was not replaced by a normal file');
    assert.equal(await fs.readlink(alias), target);
    assert.deepEqual((await read(target)).markers, ['from-A-1', 'from-A-2', 'from-A-3'], 'every acknowledged write is in the target');
    assert.deepEqual((await read(alias)).markers, (await read(target)).markers, 'the alias still reads the target');
  } finally {
    a.kill();
    await tmp.cleanup();
  }
});

test('a link that appears while the store is open is never replaced by a save', async (t) => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'ws.json');
  const elsewhere = path.join(tmp.dir, 'elsewhere.json');
  try {
    const store = await Store.open(file, fresh);
    await store.mutate((d) => d.markers.push('before'));
    await fs.rename(file, elsewhere);
    if (!(await fileSymlink(elsewhere, file))) {
      await fs.rename(elsewhere, file);
      await store.close();
      return t.skip('file symlinks cannot be created on this machine');
    }
    const targetBefore = await fs.readFile(elsewhere);
    await assert.rejects(store.mutate((d) => d.markers.push('after')), /symbolic link/);
    assert.equal((await fs.lstat(file)).isSymbolicLink(), true, 'the link was not replaced');
    assert.ok(targetBefore.equals(await fs.readFile(elsewhere)), 'the target was not changed');
    assert.deepEqual((await fs.readdir(tmp.dir)).filter((n) => n.endsWith('.tmp')), [], 'no temp residue');
    assert.deepEqual(store.state.markers, ['before'], 'memory was not advanced past what is on disk');
    await store.close();
  } finally {
    await tmp.cleanup();
  }
});

test('a real server pointed at a symlinked data file refuses to start and leaves everything alone', async (t) => {
  const tmp = await tempDir();
  const target = path.join(tmp.dir, 'target.json');
  const alias = path.join(tmp.dir, 'alias.json');
  try {
    await (await Store.open(target, fresh)).close();
    if (!(await fileSymlink(target, alias))) return t.skip('file symlinks cannot be created on this machine');
    const before = await fs.readFile(target);
    const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, BRANDPROOF_DATA: alias, PORT: '4580', BRANDPROOF_SEMANTIC: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.add(proc);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    // a server that wrongly STARTED would never exit: bound the wait so a regression fails instead of hanging
    const code = await Promise.race([new Promise((r) => proc.on('exit', r)), new Promise((r) => setTimeout(() => r('did not exit (it started)'), 8000))]);
    assert.equal(code, 1);
    assert.match(err, /Could not start: .*symbolic link/);
    assert.equal(out.includes('listening on'), false);
    assert.ok(before.equals(await fs.readFile(target)));
    assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
    assert.equal(existsSync(`${alias}.assets`), false);
  } finally {
    await tmp.cleanup();
  }
});
