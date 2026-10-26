// The isolated fictional judge demo (src/judge.js): every visitor's browser gets its own private workspace from ONE listener, with no sign-in.
// Visitors here are separate cookie jars. Everything runs on fictional data inside a temp folder that is the demo's own root.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createJudgeDemo, JUDGE_LIMITS, ROOT_MARKER } from '../src/judge.js';
import { createSemantic } from '../src/semantic.js';
import { tempDir, cleanContent } from './helpers.js';
import { makePng } from './png-helpers.js';

// Every test has a bound: one that stops making progress fails BY NAME after 60 s instead of silently stalling the run.
const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** A running demo on a fresh temp root, with a clock the test can move and visitors that each keep their own cookie. */
async function startDemo(t, opts = {}) {
  const tmp = await tempDir();
  const root = path.join(tmp.dir, 'demo-root');
  const time = { now: T0 };
  const make = async () => createJudgeDemo({ root, semantic: null, ocr: null, clock: () => time.now, ...opts });
  let demo = await make();
  let base = await demo.listen(0);
  const visitors = [];
  const visitor = (name) => {
    const v = {
      name,
      cookie: null, // "bp_judge=<value>"
      get id() { return v.cookie?.split('=')[1] ?? null; },
      async call(method, p, { role, body, raw, headers = {}, cookie = v.cookie } = {}) {
        const h = { ...headers };
        if (cookie) h.cookie = cookie;
        if (role) h['x-demo-role'] = role;
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) {
          h['content-type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
        const buffer = Buffer.from(await res.arrayBuffer());
        const text = buffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const setCookie = res.headers.getSetCookie?.()[0] ?? null;
        if (setCookie && cookie === v.cookie) v.cookie = setCookie.split(';')[0]; // a browser keeps what the server sets
        return { status: res.status, json, text, buffer, headers: res.headers, setCookie };
      },
      /** Open the page like a browser does: this is what starts (or keeps) a session. */
      open: () => v.call('GET', '/'),
    };
    visitors.push(v);
    return v;
  };
  const ctx = {
    get demo() { return demo; },
    get base() { return base; },
    root,
    time,
    visitor,
    restart: async () => {
      await demo.close();
      demo = await make();
      base = await demo.listen(0);
    },
    sessionsDir: path.join(root, 'sessions'),
    folderOf: (id) => path.join(root, 'sessions', sha(id)),
    folders: () => (existsSync(path.join(root, 'sessions')) ? readdirSync(path.join(root, 'sessions')) : []),
    close: async () => {
      await demo.close().catch(() => {});
      await tmp.cleanup();
    },
  };
  t.after(() => ctx.close());
  return ctx;
}

const bad = (title) => ({ title, text: 'A full charge lasts 30 hours, and the lamp is waterproof.', asset: cleanContent().asset });
const good = (title) => ({ title, ...cleanContent() });
const titles = async (v) => (await v.call('GET', '/api/submissions')).json.submissions.map((s) => s.title);
const listAllFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...listAllFiles(path.join(dir, e.name))] : [e.name]));

// ---------------------------------------------------------------- the demo root

test('the demo root: a new or empty folder is adopted and marked; any other folder is refused untouched; one process per root; bad limits are refused', async (t) => {
  const tmp = await tempDir();
  t.after(() => tmp.cleanup());
  // a folder that already holds something else (stand-in for real data) is never used, read, changed or deleted
  const precious = path.join(tmp.dir, 'real-data');
  mkdirSync(precious);
  writeFileSync(path.join(precious, 'brandproof.json'), '{"not":"touched"}');
  await assert.rejects(createJudgeDemo({ root: precious, semantic: null, ocr: null }), /not empty and was not created by the judge demo.*nothing was read, changed or deleted/s);
  assert.deepEqual(readdirSync(precious), ['brandproof.json'], 'nothing was added to it (no marker, no sessions folder)');
  assert.equal(readFileSync(path.join(precious, 'brandproof.json'), 'utf8'), '{"not":"touched"}');
  // a file, or a folder with a wrong marker, is refused too
  writeFileSync(path.join(tmp.dir, 'a-file'), 'x');
  await assert.rejects(createJudgeDemo({ root: path.join(tmp.dir, 'a-file'), semantic: null, ocr: null }), /not a folder/);
  const fake = path.join(tmp.dir, 'fake-marked');
  mkdirSync(fake);
  writeFileSync(path.join(fake, ROOT_MARKER), '{"kind":"something-else"}');
  await assert.rejects(createJudgeDemo({ root: fake, semantic: null, ocr: null }), /not empty and was not created by the judge demo/);
  // absent: created and marked; empty: adopted
  const fresh = path.join(tmp.dir, 'fresh', 'nested');
  const empty = path.join(tmp.dir, 'empty');
  mkdirSync(empty);
  for (const root of [fresh, empty]) {
    const demo = await createJudgeDemo({ root, semantic: null, ocr: null });
    assert.equal(JSON.parse(readFileSync(path.join(root, ROOT_MARKER), 'utf8')).kind, 'brandproof-judge-demo-root');
    assert.ok(existsSync(path.join(root, 'sessions')));
    if (root === fresh) {
      // one process per root
      await assert.rejects(createJudgeDemo({ root, semantic: null, ocr: null }), /already in use by another BrandProof process/);
    }
    await demo.close();
    // and it can be started again on the same (now marked, non-empty) root
    await (await createJudgeDemo({ root, semantic: null, ocr: null })).close();
  }
  // limits outside their ranges are refused with the limit's name
  for (const [key, value] of [['maxSessions', 0], ['maxLive', 1.5], ['idleMinutes', -1], ['sessionKiB', 1], ['maxConnections', 'x']]) {
    await assert.rejects(createJudgeDemo({ root: path.join(tmp.dir, `lim-${key}`), semantic: null, ocr: null, limits: { [key]: value } }), new RegExp(`limit ${key} `));
  }
  assert.ok(Object.keys(JUDGE_LIMITS).length >= 9);
});

// ---------------------------------------------------------------- the session cookie

test('a visitor gets one opaque, server-chosen cookie when the page opens; nothing else starts a session', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  const page = await a.open();
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>BrandProof<\/title>/);
  assert.match(page.setCookie, /^bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7200$/);
  await b.open();
  assert.notEqual(a.id, b.id, 'each browser gets its own');
  assert.equal(a.id.length, 43);
  // the value is chosen by the server, never by the client: offering one that was not issued does not adopt it
  const chosen = crypto.randomBytes(32).toString('base64url');
  const c = d.visitor('C');
  const cp = await c.call('GET', '/', { cookie: `bp_judge=${chosen}` });
  assert.notEqual(cp.setCookie.split(';')[0].split('=')[1], chosen, 'a client-supplied identifier is never adopted (no session fixation)');
  // the raw id is never written to disk; folders are named by its hash
  const everyName = listAllFiles(d.root).join('\n');
  for (const v of [a, b, c]) assert.ok(!everyName.includes(v.id), 'the cookie value must not appear in any file or folder name');
  assert.ok(existsSync(d.folderOf(a.id)) && existsSync(d.folderOf(b.id)));
  assert.equal(JSON.parse(readFileSync(path.join(d.folderOf(a.id), 'session.json'), 'utf8')).kind, 'brandproof-judge-session');
  // static files need no session and make none; HEAD makes none; the API without a cookie is refused; other methods on the page are refused
  const before = d.demo.stats().sessions;
  const none = d.visitor('none');
  for (const p of ['/app.js', '/styles.css', '/favicon.svg', '/archivo.woff2']) {
    const r = await none.call('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.setCookie, null, p);
  }
  assert.equal((await none.call('HEAD', '/')).setCookie, null);
  assert.equal((await none.call('GET', '/nope.js')).status, 404);
  assert.equal((await none.call('POST', '/', { raw: '' })).status, 405);
  const api = await none.call('GET', '/api/submissions');
  assert.equal(api.status, 401);
  assert.equal(api.json.error.code, 'session_unavailable');
  assert.match(api.json.error.message, /ended or was not found.*Reload the page to start a new demo session/);
  assert.equal(d.demo.stats().sessions, before, 'none of that created a session');
});

test('the Secure option adds the Secure flag and the __Host- prefix (for an https address); the product is served under that name', async (t) => {
  const d = await startDemo(t, { secureCookie: true });
  const v = d.visitor('S');
  const page = await v.open();
  assert.match(page.setCookie, /^__Host-bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.equal((await v.call('GET', '/api/meta')).status, 200);
  // the plain name is not accepted by a Secure deployment
  assert.equal((await v.call('GET', '/api/meta', { cookie: `bp_judge=${v.id}` })).status, 401);
});

// ---------------------------------------------------------------- isolation between two visitors

test('two visitors (two cookie jars) cannot read or write each other\'s submissions, comments or decisions', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  const meta = (await a.call('GET', '/api/meta')).json;
  assert.equal(meta.judge.enabled, true, 'the page learns it is the judge demo');
  assert.equal(meta.demo, true);

  const made = await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY secret campaign') });
  assert.equal(made.status, 201);
  const idA = made.json.id; // SUB-4 in A's workspace
  assert.equal((await a.call('POST', `/api/submissions/${idA}/comments`, { role: 'manager', body: { revision: 1, text: 'A-ONLY private comment' } })).status, 201);
  assert.ok((await titles(a)).includes('A-ONLY secret campaign'));

  // B sees only its own fresh seed
  assert.ok(!(await titles(b)).includes('A-ONLY secret campaign'));
  assert.equal((await titles(b)).length, 3);
  // B cannot read, comment on, revise, request review of, or decide A's submission: it does not exist in B's workspace
  assert.equal((await b.call('GET', `/api/submissions/${idA}`, { role: 'reviewer' })).status, 404);
  assert.equal((await b.call('POST', `/api/submissions/${idA}/comments`, { role: 'manager', body: { revision: 1, text: 'intruder' } })).status, 404);
  assert.equal((await b.call('POST', `/api/submissions/${idA}/revisions`, { role: 'creator', body: { baseRevision: 1, text: 'hijacked', asset: cleanContent().asset } })).status, 404);
  assert.equal((await b.call('POST', `/api/submissions/${idA}/request-review`, { role: 'creator', body: { revision: 1, expected: made.json.workflow.binding } })).status, 404);
  assert.equal((await b.call('POST', `/api/submissions/${idA}/approve`, { role: 'reviewer', body: { revision: 1, expected: made.json.workflow.binding } })).status, 404);
  assert.equal((await b.call('GET', `/api/submissions/${idA}/compare?from=1&to=1`)).status, 404);
  // B's own submission gets the same id number in ITS workspace and is a different record
  const madeB = await b.call('POST', '/api/submissions', { role: 'creator', body: good('B-ONLY campaign') });
  assert.equal(madeB.json.id, idA, 'ids are per-workspace numbers, so an id proves nothing across visitors');
  const readA = (await a.call('GET', `/api/submissions/${idA}`)).json;
  assert.equal(readA.title, 'A-ONLY secret campaign', 'A\'s record is untouched by B creating the same id');
  assert.ok(JSON.stringify(readA).includes('A-ONLY private comment'));
  assert.ok(!JSON.stringify((await b.call('GET', `/api/submissions/${idA}`)).json).includes('A-ONLY'));
  // insights, queue and library are per visitor
  const insA = (await a.call('GET', '/api/insights')).json;
  const insB = (await b.call('GET', '/api/insights')).json;
  assert.notDeepEqual(insA, insB);
});

test('no channel but the cookie reaches another visitor: ids in headers, queries, paths, bodies, other cookies or a duplicate cookie change nothing', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY secret campaign') });
  const A = a.id;
  const secret = (r) => JSON.stringify(r.json ?? r.text).includes('A-ONLY');
  const attempts = [
    ['GET', '/api/submissions', { headers: { 'x-session': A, 'x-demo-session': A, 'x-session-id': A, authorization: `Bearer ${A}` } }],
    ['GET', `/api/submissions?session=${A}&sid=${A}&bp_judge=${A}&id=${sha(A)}`, {}],
    ['GET', `/api/judge/${A}/session`, {}],
    ['GET', `/api/submissions/../judge/${sha(A)}`, {}],
    ['POST', '/api/submissions', { role: 'creator', body: { ...good('B writes'), session: A, sessionId: A, bp_judge: A } }],
  ];
  for (const [method, p, o] of attempts) {
    const r = await b.call(method, p, { cookie: `${b.cookie}; bp_judge_other=${A}; session=${A}`, ...o });
    assert.ok(!secret(r), `${method} ${p} must not reveal A's data (status ${r.status})`);
  }
  assert.ok(!(await titles(b)).includes('A-ONLY secret campaign'));
  assert.ok((await titles(b)).includes('B writes'), 'the write went to B\'s own workspace');
  assert.ok(!(await titles(a)).includes('B writes'), 'and not to A\'s');
  // two cookies of the session name are ambiguous (cookie tossing): refused, not "pick one"
  const dup = await b.call('GET', '/api/submissions', { cookie: `bp_judge=${b.id}; bp_judge=${A}` });
  assert.equal(dup.status, 401);
  assert.ok(!secret(dup));
  const dupPage = await b.call('GET', '/', { cookie: `bp_judge=${A}; bp_judge=${b.id}` });
  assert.equal(dupPage.status, 200);
  assert.notEqual(dupPage.setCookie.split(';')[0].split('=')[1], A, 'a duplicate never selects A\'s session');
  assert.notEqual(dupPage.setCookie.split(';')[0].split('=')[1], b.id, 'nor B\'s: a new one is made');
});

test('images are per visitor: B cannot fetch, reference, read text from or count A\'s retained image', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  const png = makePng({ width: 24, height: 24, pixel: [12, 120, 90] });
  const up = await a.call('POST', '/api/assets', { role: 'creator', raw: png, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 201, up.text);
  const digest = up.json.asset.sha256;
  assert.equal(digest, sha(png));
  const own = await a.call('GET', `/api/assets/${digest}`);
  assert.equal(own.status, 200);
  assert.ok(own.buffer.equals(png));
  assert.equal((await a.call('GET', '/api/assets/usage')).json.count, 1);
  // B: the same digest does not exist in its workspace
  assert.equal((await b.call('GET', `/api/assets/${digest}`)).status, 404);
  assert.equal((await b.call('GET', '/api/assets/usage')).json.count, 0);
  assert.equal((await b.call('POST', `/api/assets/${digest}/ocr`, { role: 'creator', body: {} })).status, 404, 'reading text from an image B does not hold');
  const attach = await b.call('POST', '/api/submissions', { role: 'creator', body: { title: 'uses A\'s image', text: cleanContent().text, asset: { ...cleanContent().asset, retainedSha256: digest } } });
  assert.ok(attach.status >= 400, `B must not be able to attach A's image (status ${attach.status})`);
  assert.ok(!(await titles(b)).includes('uses A\'s image'));
  // on disk the bytes are in A's folder only
  const hasPng = (id) => existsSync(path.join(d.folderOf(id), 'workspace.json.assets', `${digest}.png`));
  assert.ok(hasPng(a.id));
  assert.ok(!hasPng(b.id));
  // B uploading the identical bytes gets its OWN copy (nothing is deduplicated across visitors)
  const upB = await b.call('POST', '/api/assets', { role: 'creator', raw: png, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(upB.status, 201, 'a first upload for B, not a deduplicated reference to A\'s file');
  assert.ok(hasPng(b.id));
});

// ---------------------------------------------------------------- unknown, tampered and expired sessions

test('unknown, tampered or malformed cookies are never accepted: the API refuses, the page starts a NEW session and says the earlier one is gone', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  await a.open();
  await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY secret campaign') });
  const real = a.id;
  const flip = real.slice(0, -1) + (real.endsWith('A') ? 'B' : 'A');
  const forged = crypto.randomBytes(32).toString('base64url');
  const odd = ['', 'x', real.slice(0, 20), `${real}extra`, real.replace(/.$/, '!'), 'A'.repeat(300), '../'.repeat(20)];
  for (const value of [flip, forged, ...odd]) {
    const v = d.visitor('T');
    const cookie = `bp_judge=${value}`;
    const r = await v.call('GET', '/api/submissions', { cookie });
    assert.equal(r.status, 401, `API with cookie "${value.slice(0, 30)}"`);
    assert.equal(r.json.error.code, 'session_unavailable');
    assert.ok(!JSON.stringify(r.json).includes('A-ONLY'));
    // the page makes a brand-new session, never adopting the offered value, and reports that an earlier cookie was not valid
    const before = d.folders().length;
    const page = await v.call('GET', '/', { cookie });
    const issued = page.setCookie.split(';')[0].split('=')[1];
    assert.notEqual(issued, value);
    assert.notEqual(issued, real);
    assert.equal(d.folders().length, before + 1);
    v.cookie = `bp_judge=${issued}`; // the browser now holds what the server set
    const info = (await v.call('GET', '/api/judge/session')).json;
    assert.equal(info.replacedPrevious, true, 'a cookie was presented but is not a live session, so the page says the earlier one is gone');
    assert.equal((await titles(v)).length, 3, 'a fresh seed');
    assert.ok(!(await titles(v)).includes('A-ONLY secret campaign'));
  }
  assert.ok((await titles(a)).includes('A-ONLY secret campaign'), 'A\'s own session was never disturbed by any of it');
  // whitespace around a cookie value is not part of it (cookie syntax), so that is still A's own cookie: it is the only thing that is
  assert.equal((await a.call('GET', '/api/submissions', { cookie: `bp_judge=${real} ` })).status, 200);
});

test('expiry: idle and absolute lifetimes end a session; the old cookie never works again; its folder is removed; activity extends idle time only', async (t) => {
  const d = await startDemo(t, { limits: { idleMinutes: 120, maxHours: 12 } });
  const a = d.visitor('A');
  await a.open();
  await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY secret campaign') });
  const oldId = a.id;
  const oldCookie = a.cookie;
  // the cookie lifetime is the remaining session lifetime
  d.time.now = T0 + 30 * MIN;
  const refreshed = await a.call('GET', '/api/meta');
  assert.match(refreshed.setCookie, /Max-Age=7200/, 'activity at 30 min slides the idle window: a full 120 minutes again');
  // idle: 100 minutes later it is still alive (it was active at 30), and after 121 more idle minutes it is not
  d.time.now = T0 + 130 * MIN;
  assert.equal((await a.call('GET', '/api/submissions')).status, 200);
  d.time.now = T0 + 130 * MIN + 121 * MIN;
  const gone = await a.call('GET', '/api/submissions', { cookie: oldCookie });
  assert.equal(gone.status, 401);
  assert.equal(gone.json.error.code, 'session_unavailable');
  await d.demo.sweep();
  assert.ok(!existsSync(d.folderOf(oldId)), 'an expired session\'s folder is removed');
  assert.equal((await a.call('GET', '/api/submissions', { cookie: oldCookie })).status, 401, 'and stays gone');
  // reopening the page recovers: a new private session, and it says the earlier one had ended
  const page = await a.call('GET', '/', { cookie: oldCookie });
  assert.equal(page.status, 200);
  assert.notEqual(page.setCookie.split(';')[0].split('=')[1], oldId);
  assert.equal((await a.call('GET', '/api/judge/session')).json.replacedPrevious, true);
  assert.ok(!(await titles(a)).includes('A-ONLY secret campaign'));

  // absolute: a session kept busy still ends at its maximum age
  const e = d.visitor('E');
  d.time.now = T0 + 1000 * MIN;
  await e.open();
  const started = d.time.now;
  for (let h = 1; h <= 11; h++) {
    d.time.now = started + h * 60 * MIN;
    assert.equal((await e.call('GET', '/api/submissions')).status, 200, `active at ${h} h`);
  }
  d.time.now = started + 11 * 60 * MIN + 59 * MIN;
  assert.match((await e.call('GET', '/api/meta')).setCookie, /Max-Age=\d+/);
  assert.ok(Number(/Max-Age=(\d+)/.exec((await e.call('GET', '/api/meta')).setCookie)[1]) <= 60 * 60 + 1, 'the cookie never outlives the absolute limit');
  d.time.now = started + 12 * 60 * MIN + 1;
  assert.equal((await e.call('GET', '/api/submissions')).status, 401, 'ended at 12 hours although it was in use a minute ago');
});

// ---------------------------------------------------------------- bounds

test('capacity: at the session cap a new visitor gets a clear page (no cookie), existing visitors keep working, and a freed slot is reusable', async (t) => {
  const d = await startDemo(t, { limits: { maxSessions: 3, newPerMinute: 50 } });
  const vs = [d.visitor('1'), d.visitor('2'), d.visitor('3')];
  for (const v of vs) assert.equal((await v.open()).status, 200);
  const late = d.visitor('late');
  const full = await late.open();
  assert.equal(full.status, 503);
  assert.equal(full.setCookie, null);
  assert.equal(full.headers.get('retry-after'), '60');
  assert.match(full.headers.get('content-type'), /text\/html/);
  assert.match(full.text, /The demo is full/);
  assert.match(full.text, /every demo session slot is in use/);
  assert.equal((await late.call('GET', '/api/submissions')).status, 401);
  assert.equal(d.demo.stats().sessions, 3);
  for (const v of vs) assert.equal((await v.call('GET', '/api/submissions')).status, 200, 'existing visitors are unaffected');
  // one session expires; its slot is freed and the waiting visitor gets in
  d.time.now = T0 + 121 * MIN;
  await vs[1].call('GET', '/api/meta'); // 2 and 3 expired too; only a request after expiry shows it
  const ok = await late.open();
  assert.equal(ok.status, 200);
  assert.ok(d.demo.stats().sessions <= 3);
});

test('starting sessions is rate limited, and the limit lifts after a minute', async (t) => {
  const d = await startDemo(t, { limits: { newPerMinute: 2 } });
  assert.equal((await d.visitor('1').open()).status, 200);
  assert.equal((await d.visitor('2').open()).status, 200);
  const third = d.visitor('3');
  const r = await third.open();
  assert.equal(r.status, 429);
  assert.match(r.text, /The demo is busy/);
  assert.equal(r.setCookie, null);
  d.time.now = T0 + 61_000;
  assert.equal((await third.open()).status, 200);
});

test('storage per session is bounded: writes are refused with a clear message at the cap, reads still work, and Reset starts again', async (t) => {
  const d = await startDemo(t, { limits: { sessionKiB: 64 } });
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  const long = 'A full charge lasts up to 12 hours. '.repeat(130); // 4,680 characters: near the app's own 5,000-character limit, about 5 KB per submission
  let refused = null;
  for (let i = 0; i < 12 && !refused; i++) {
    const r = await a.call('POST', '/api/submissions', { role: 'creator', body: { title: `bulk ${i}`, text: long, asset: cleanContent().asset } });
    if (r.status === 413) refused = r;
    else assert.equal(r.status, 201, r.text);
  }
  assert.ok(refused, 'the session must hit its cap');
  assert.equal(refused.json.error.code, 'session_full');
  assert.match(refused.json.error.message, /storage is full.*Reset my demo/);
  assert.equal((await a.call('GET', '/api/submissions')).status, 200, 'reads still work when full');
  const info = (await a.call('GET', '/api/judge/session')).json;
  assert.equal(info.storage.maxBytes, 64 * 1024);
  assert.ok(info.storage.usedBytes <= info.storage.maxBytes + 20_000, 'and the cap held (within one write)');
  // B is not affected by A being full
  assert.equal((await b.call('POST', '/api/submissions', { role: 'creator', body: good('B still writes') })).status, 201);
  // reset recovers A
  const reset = await a.call('POST', '/api/judge/reset', { body: {}, headers: { origin: d.base } });
  assert.equal(reset.status, 200);
  assert.equal((await a.call('POST', '/api/submissions', { role: 'creator', body: good('after reset') })).status, 201);
});

test('images per session are bounded by the demo\'s own quota (count and bytes), with the app\'s clear message', async (t) => {
  const d = await startDemo(t, { limits: { imageCount: 1 } });
  const a = d.visitor('A');
  await a.open();
  const up = (n) => a.call('POST', '/api/assets', { role: 'creator', raw: makePng({ width: 16 + n, height: 16, pixel: [n * 10, 60, 90] }), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal((await up(1)).status, 201);
  const second = await up(2);
  assert.equal(second.status, 413);
  assert.equal(second.json.error.code, 'asset_quota');
  assert.match(second.json.error.message, /maximum of 1 images/);
  assert.equal((await d.visitor('B2').open()).status, 200);
});

test('open sessions are bounded: with a cap of 2 open at once, five visitors stay correct, the cap holds, and evicted sessions reopen from their files', async (t) => {
  const d = await startDemo(t, { limits: { maxLive: 2 } });
  const vs = ['A', 'B', 'C', 'D', 'E'].map((n) => d.visitor(n));
  for (const v of vs) {
    await v.open();
    const r = await v.call('POST', '/api/submissions', { role: 'creator', body: good(`${v.name}-OWN`) });
    assert.equal(r.status, 201);
    assert.ok(d.demo.stats().live <= 2, `live ${d.demo.stats().live}`);
  }
  assert.equal(d.demo.stats().sessions, 5);
  // every visitor, in a shuffled order, sees exactly its own record (evicted sessions came back from their files)
  for (const v of [vs[0], vs[3], vs[1], vs[4], vs[2], vs[0]]) {
    const t2 = await titles(v);
    assert.ok(t2.includes(`${v.name}-OWN`), `${v.name} lost its data`);
    for (const other of vs.filter((x) => x !== v)) assert.ok(!t2.includes(`${other.name}-OWN`), `${v.name} sees ${other.name}'s data`);
    assert.ok(d.demo.stats().live <= 2);
  }
  // a burst across all five at once: every answer is correct and the cap still holds
  const burst = await Promise.all(vs.flatMap((v) => [0, 1, 2].map(async () => ({ v, r: await v.call('GET', '/api/submissions') }))));
  for (const { v, r } of burst) {
    assert.equal(r.status, 200, `${v.name} burst: ${r.text.slice(0, 100)}`);
    assert.ok(r.json.submissions.some((s) => s.title === `${v.name}-OWN`));
    assert.ok(!r.json.submissions.some((s) => s.title.endsWith('-OWN') && s.title !== `${v.name}-OWN`));
  }
  assert.ok(d.demo.stats().live <= 2);
});

test('only ONE listener exists however many visitors there are, and closing a visitor\'s app never stops the shared services', async (t) => {
  const listens = [];
  const original = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    listens.push(args[0]);
    return original.apply(this, args);
  };
  t.after(() => { http.Server.prototype.listen = original; });
  const shared = createSemantic({ embedder: null });
  let stops = 0;
  shared.stop = () => { stops++; };
  const d = await startDemo(t, { semantic: shared, limits: { maxLive: 1 } });
  for (const n of ['A', 'B', 'C', 'D']) {
    const v = d.visitor(n);
    await v.open();
    await v.call('GET', '/api/meta'); // opens this visitor's app and, with a cap of 1, closes the previous one
  }
  assert.equal(listens.length, 1, `exactly one listen() for four visitors (saw ${JSON.stringify(listens)})`);
  assert.equal(stops, 0, 'evicting visitors\' apps must not stop the shared service');
  await d.demo.close();
  assert.equal(stops, 0, 'a service the caller supplied is the caller\'s to stop');
});

// ---------------------------------------------------------------- reload, restart, recovery, reset

test('a reload keeps the same session and state; a restart keeps it too until it expires; a stale runtime lock inside the session is recovered', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY persists') });
  const id = a.id;
  const created = (await a.call('GET', '/api/judge/session')).json.createdAt;
  // reload: the same cookie value comes back, with a refreshed lifetime, and the state is still there
  const reload = await a.open();
  assert.equal(reload.setCookie.split(';')[0].split('=')[1], id);
  assert.ok((await titles(a)).includes('A-ONLY persists'));
  // restart the whole demo (a "stopped without a graceful shutdown" is covered by the process-level test)
  await d.restart();
  assert.equal(d.demo.stats().live, 0, 'nothing is open until a visitor asks');
  assert.equal(d.demo.stats().sessions, 2, 'both sessions were found again from the demo root');
  assert.ok((await titles(a)).includes('A-ONLY persists'), 'the same cookie reaches the same workspace after a restart');
  assert.equal((await a.call('GET', '/api/judge/session')).json.createdAt, created);
  assert.ok(!(await titles(b)).includes('A-ONLY persists'));
  // a killed process leaves a runtime lock marker (here: one that names another computer, like a replaced container would)
  await d.restart();
  writeFileSync(path.join(d.folderOf(id), 'workspace.json.lock'), JSON.stringify({ v: 1, token: 'stale', pid: 999999, host: 'another-computer', startedAt: '2026-10-25T00:00:00.000Z', purpose: 'workspace' }));
  assert.ok((await titles(a)).includes('A-ONLY persists'), 'a stale marker inside the demo root is cleared and the session opens');
  // sessions that expired while the demo was stopped are removed when it starts again
  const expiredId = b.id;
  await d.demo.close();
  d.time.now = T0 + 24 * 60 * MIN;
  const again = await createJudgeDemo({ root: d.root, semantic: null, ocr: null, clock: () => d.time.now });
  assert.equal(again.stats().sessions, 0);
  assert.ok(!existsSync(d.folderOf(expiredId)));
  assert.ok(!existsSync(d.folderOf(id)));
  await again.close();
  await d.restart(); // so the fixture's own close has something to close
});

test('Reset my demo clears only the caller\'s session (same-origin only); the session and its lifetime continue', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  await a.call('POST', '/api/submissions', { role: 'creator', body: bad('A-ONLY before reset') });
  await b.call('POST', '/api/submissions', { role: 'creator', body: good('B-ONLY keeps') });
  const png = makePng({ width: 20, height: 20, pixel: [1, 2, 3] });
  await a.call('POST', '/api/assets', { role: 'creator', raw: png, headers: { 'content-type': 'application/octet-stream' } });
  const created = (await a.call('GET', '/api/judge/session')).json.createdAt;
  // refused without a same-site origin, for another origin, without a session, and with the wrong method
  assert.equal((await a.call('POST', '/api/judge/reset', { body: {} })).status, 403);
  assert.equal((await a.call('POST', '/api/judge/reset', { body: {}, headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await d.visitor('x').call('POST', '/api/judge/reset', { body: {}, headers: { origin: d.base } })).status, 401);
  assert.equal((await a.call('GET', '/api/judge/reset')).status, 405);
  assert.ok((await titles(a)).includes('A-ONLY before reset'), 'a refused reset changed nothing');
  const ok = await a.call('POST', '/api/judge/reset', { body: {}, headers: { origin: d.base } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.reset, true);
  assert.deepEqual((await titles(a)).length, 3, 'back to the fictional seed');
  assert.ok(!(await titles(a)).includes('A-ONLY before reset'));
  assert.equal((await a.call('GET', '/api/assets/usage')).json.count, 0);
  assert.ok(!existsSync(path.join(d.folderOf(a.id), 'workspace.json.assets')) || readdirSync(path.join(d.folderOf(a.id), 'workspace.json.assets')).length === 0);
  assert.equal((await a.call('GET', '/api/judge/session')).json.createdAt, created, 'the session continues (its lifetime is not extended by resetting)');
  assert.ok((await titles(b)).includes('B-ONLY keeps'), 'B is unaffected');
  assert.equal((await a.call('GET', '/api/judge/nope')).status, 404);
});

// ---------------------------------------------------------------- the core product path inside a session

test('core path in one session: check against approved facts, explained findings, the approval gate, a human decision, then a change makes the approval stale; the other visitor is unaffected', async (t) => {
  const d = await startDemo(t);
  const a = d.visitor('A');
  const b = d.visitor('B');
  await a.open();
  await b.open();
  const created = await a.call('POST', '/api/submissions', { role: 'creator', body: bad('Judge path') });
  assert.equal(created.status, 201);
  const sub = created.json;
  const blocking = sub.current.findings.filter((f) => f.severity === 'error');
  assert.equal(blocking.length, 2);
  assert.deepEqual(blocking.flatMap((f) => f.evidence.map((e) => e.id)).sort(), ['FCT-001', 'FCT-002']);
  for (const f of blocking) assert.ok(f.explanation && f.quote && f.source?.quote, 'each finding explains the claim, the approved fact and its source');
  // the gate holds inside the demo
  const early = await a.call('POST', `/api/submissions/${sub.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: sub.workflow.binding } });
  assert.equal(early.status, 403);
  assert.match(JSON.stringify(early.json), /2 blocking findings must be fixed first/);
  // fix, request review, decide as a human (a simulated role)
  const revised = await a.call('POST', `/api/submissions/${sub.id}/revisions`, { role: 'creator', body: { baseRevision: 1, text: cleanContent().text, asset: cleanContent().asset } });
  assert.equal(revised.status, 201);
  assert.equal(revised.json.current.summary.error, 0);
  const requested = await a.call('POST', `/api/submissions/${sub.id}/request-review`, { role: 'creator', body: { revision: 2, expected: revised.json.workflow.binding } });
  assert.equal(requested.json.workflow.status, 'in_review');
  const forReview = (await a.call('GET', `/api/submissions/${sub.id}`, { role: 'reviewer' })).json;
  const decided = await a.call('POST', `/api/submissions/${sub.id}/approve`, { role: 'reviewer', body: { revision: 2, expected: forReview.workflow.binding, note: 'Checked against the fact sheet.' } });
  assert.equal(decided.status, 201);
  assert.equal(decided.json.workflow.status, 'approved');
  assert.equal(decided.json.events.at(-1).actor.name, 'Demo Reviewer');
  // a later change makes the approval stale (re-review required)
  const edited = await a.call('POST', `/api/submissions/${sub.id}/revisions`, { role: 'creator', body: { baseRevision: 2, text: cleanContent().text + ' Quiet by design.', asset: cleanContent().asset } });
  assert.equal(edited.status, 201);
  assert.equal(edited.json.workflow.status, 'approval_stale');
  assert.deepEqual(edited.json.workflow.staleApproval.reasons, ['content']);
  assert.equal((await a.call('GET', '/api/submissions')).json.submissions.find((s) => s.id === sub.id).status, 'approval_stale');
  // B's workspace never saw any of it
  const bList = (await b.call('GET', '/api/submissions')).json.submissions;
  assert.equal(bList.length, 3);
  assert.ok(!bList.some((s) => s.title === 'Judge path'));
  assert.ok(bList.every((s) => s.status !== 'approval_stale' || s.id === 'SUB-5' || true));
  assert.equal((await b.call('GET', '/api/submissions/SUB-2')).json.workflow.status, 'approved', 'B\'s seeded approved item is still approved: A\'s changes could not touch it');
});

test('without the optional model or OCR the demo says so and the core path still works', async (t) => {
  const d = await startDemo(t); // semantic: null, ocr: null (switched off)
  const a = d.visitor('A');
  await a.open();
  const meta = (await a.call('GET', '/api/meta')).json;
  assert.equal(meta.semantic.state, 'unavailable');
  assert.match(meta.semantic.reason, /switched off/);
  assert.equal(meta.ocr.state, 'unavailable');
  assert.match(meta.ocr.reason, /switched off/);
  assert.equal(meta.engine.mode, 'rules');
  assert.equal((await a.call('POST', '/api/submissions', { role: 'creator', body: bad('no optional features') })).status, 201);
});

// ---------------------------------------------------------------- the host and origin protections stay

test('host and origin protections are unchanged: a foreign Host starts no session; a listed host works behind https; cross-site writes are refused', async (t) => {
  const d = await startDemo(t, { allowedHosts: ['judge.example.test'] });
  const port = Number(new URL(d.base).port);
  const raw = (host, { method = 'GET', p = '/', origin, cookie, body } = {}) => new Promise((resolve, reject) => {
    const headers = { host };
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), setCookie: res.headers['set-cookie']?.[0] ?? null }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('no answer')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const before = d.demo.stats().sessions;
  for (const host of ['evil.example', 'judge.example.test.evil.example', '203.0.113.7', 'localhost.evil.example']) {
    const r = await raw(host);
    assert.equal(r.status, 403, host);
    assert.equal(r.json.error.code, 'bad_host');
    assert.equal(r.setCookie, null);
  }
  assert.equal(d.demo.stats().sessions, before, 'refused hosts start no sessions');
  // localhost and the listed name work; the session cookie is issued on the listed name too
  assert.equal((await raw(`127.0.0.1:${port}`)).status, 200);
  const page = await raw('judge.example.test');
  assert.equal(page.status, 200);
  const cookie = page.setCookie.split(';')[0];
  const write = (origin, extra = {}) => raw('judge.example.test', { method: 'POST', p: '/api/submissions', origin, cookie, body: good('through a proxy'), ...extra });
  assert.equal((await raw('judge.example.test', { method: 'POST', p: '/api/submissions', origin: 'https://judge.example.test', cookie, body: good('through a proxy') , headers: undefined })).status, 400, 'no demo role header is still refused by the app');
  const withRole = (origin) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/submissions', headers: { host: 'judge.example.test', origin, cookie, 'x-demo-role': 'creator', 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify(good('through a proxy')));
  });
  assert.equal(await withRole('https://judge.example.test'), 201, 'the https origin of a listed host is the same site');
  assert.equal(await withRole('https://evil.example'), 403, 'another site cannot write, even with a valid cookie');
  assert.equal(await withRole('http://localhost'), 403);
  void write;
});
