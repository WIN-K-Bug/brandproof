// The optional "Try an evidence change" scenario of the isolated judge demo (src/scenario.js, POST/GET /api/judge/scenario).
// Everything runs on fictional data inside a temp demo root. Visitors are separate cookie jars. The scenario is set up through the visitor's own app
// (the real routes and gates); these tests prove the journey is real (state, bindings and gates come from the stored data, not from labels), that
// setting it up is bounded, idempotent and never overwrites or leaks, and that a failed set-up keeps the visitor's work.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createJudgeDemo } from '../src/judge.js';
import { BAT8, BAT12, SHEET_V1, SHEET_V2, TITLES, IMAGE } from '../src/scenario.js';
import { startApp, tempDir } from './helpers.js';

// Every test has a bound: one that stops making progress fails BY NAME after 60 s instead of silently stalling the run.
const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const MIN = 60_000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const spanOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });

async function startDemo(t, opts = {}) {
  const tmp = await tempDir();
  const root = path.join(tmp.dir, 'demo-root');
  const time = { now: T0 };
  const demo = await createJudgeDemo({ root, semantic: null, ocr: null, clock: () => time.now, ...opts });
  const base = await demo.listen(0);
  const visitor = () => {
    const v = {
      cookie: null,
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
        const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        const setCookie = res.headers.getSetCookie?.()[0] ?? null;
        if (setCookie && cookie === v.cookie) v.cookie = setCookie.split(';')[0];
        return { status: res.status, json, text };
      },
      open: () => v.call('GET', '/'),
      as: (role) => (method, p, body) => v.call(method, p, { role, body }),
      /** A browser's own same-site POST (an Origin header is part of what the scenario route requires). */
      post: (p, body, role) => v.call('POST', p, { role, body, headers: { origin: base } }),
      start: () => v.post('/api/judge/scenario', {}),
      status: () => v.call('GET', '/api/judge/scenario'),
    };
    return v;
  };
  const ctx = {
    demo, base, root, time, visitor,
    workspace: (v) => path.join(root, 'sessions', sha(v.id), 'workspace.json'),
    bytes: (v) => readFileSync(path.join(root, 'sessions', sha(v.id), 'workspace.json')),
    close: async () => {
      await demo.close().catch(() => {});
      await tmp.cleanup();
    },
  };
  t.after(() => ctx.close());
  return ctx;
}

const fresh = async (ctx) => {
  const v = ctx.visitor();
  assert.equal((await v.open()).status, 200);
  return v;
};

/** The repair a person does with the real features: Manager relinks the three facts to version 2 (and corrects the battery fact), Creator corrects the copy. */
async function repair(v, ids) {
  const manager = v.as('manager');
  const g = (await manager('GET', '/api/guidelines')).json;
  const edited = structuredClone(g.guidelines);
  for (const [id, needle] of [['FCT-001', BAT8], ['FCT-002', 'Indoor use only; not waterproof or water resistant.'], ['FCT-004', 'Every Aurora Lamp carries a 2-year limited warranty.']]) {
    const f = edited.facts.find((x) => x.id === id);
    f.source = { sourceId: ids.sourceId, version: 2, ...spanOf(SHEET_V2, needle) };
    if (id === 'FCT-001') {
      f.value = 8;
      f.statement = BAT8;
    }
  }
  const pub = await manager('PUT', '/api/guidelines', { baseVersion: g.version, note: 'Relink to version 2; battery is now 8 hours', guidelines: edited });
  assert.equal(pub.status, 201, pub.text);
  const creator = v.as('creator');
  const d = (await creator('GET', `/api/submissions/${ids.campaignId}`)).json;
  const rev = await creator('POST', `/api/submissions/${ids.campaignId}/revisions`, { baseRevision: d.headRevision, text: BAT8, asset: d.revisions.at(-1).asset });
  assert.equal(rev.status, 201, rev.text);
}
const requestReview = async (v, id) => {
  const d = (await v.as('creator')('GET', `/api/submissions/${id}`)).json;
  return v.as('creator')('POST', `/api/submissions/${id}/request-review`, { revision: d.headRevision, expected: d.workflow.binding });
};
const approve = async (v, id, role = 'reviewer') => {
  const d = (await v.as(role)('GET', `/api/submissions/${id}`)).json;
  return v.as(role)('POST', `/api/submissions/${id}/approve`, { revision: d.headRevision, expected: d.workflow.binding });
};
/** The Manager reads the preview and activates version 2 with the preview's digest (the deliberate action). */
async function activate(v, sourceId) {
  const manager = v.as('manager');
  const pre = (await manager('GET', `/api/sources/${sourceId}/impact?action=activate&version=2`)).json;
  const detail = (await manager('GET', `/api/sources/${sourceId}`)).json.source;
  const done = await manager('POST', `/api/sources/${sourceId}/versions/2/approve`, { expectedSha256: detail.versions[1].textSha256, previewDigest: pre.digest, note: 'Activated by the visitor' });
  return { pre, done };
}

// ---------------------------------------------------------------- the journey, with real gates

test('a fresh visitor starts the scenario; the registered quote is inspectable and the approval is bound to version 1', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  const before = (await v.status()).json;
  assert.deepEqual(before, { started: false });
  const r = await v.start();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.created, true);
  assert.equal(r.json.stage, 'pending_change');
  assert.equal(r.json.next.hash, `#/sources/${r.json.sourceId}/2`);
  assert.equal(r.json.next.role, 'manager');

  // the source is real: version 1 active, version 2 pending, and the quote is the registered passage (not a label)
  const src = (await v.as('manager')('GET', `/api/sources/${r.json.sourceId}`)).json.source;
  assert.deepEqual(src.versions.map((x) => x.state), ['active', 'pending']);
  const v1 = (await v.as('manager')('GET', `/api/sources/${r.json.sourceId}/versions/1`)).json;
  assert.ok(JSON.stringify(v1).includes(BAT12));
  const sheetV1 = JSON.stringify(v1).includes('Battery. ' + BAT12);
  assert.ok(sheetV1, 'the registered text of version 1 contains the battery sentence');

  // the campaign is approved against that exact evidence; its image bytes are retained
  const c = (await v.as('reviewer')('GET', `/api/submissions/${r.json.campaignId}`)).json;
  assert.equal(c.workflow.status, 'approved');
  assert.equal(c.current.image.status, 'retained');
  assert.equal(c.current.evidence.broken.length, 0);
  assert.equal(c.current.evidence.linked, 3);
  const approved = c.events.filter((e) => e.type === 'approved');
  assert.equal(approved.length, 1);
  assert.match(approved[0].note, /Sample history in the fictional scenario, not a decision you made/);
  assert.equal(approved[0].binding.evidenceHash, c.current.evidence.hash);
  // the story's own text is what the product says it is
  assert.ok(SHEET_V1.includes(BAT12) && SHEET_V2.includes(BAT8) && !SHEET_V2.includes('12 hours'));
  assert.ok(IMAGE.length > 200 && IMAGE.length < 20_000);
});

test('previewing the change writes nothing (the stored workspace is byte-for-byte the same)', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  const ids = (await v.start()).json;
  const before = ctx.bytes(v);
  const pre = (await v.as('manager')('GET', `/api/sources/${ids.sourceId}/impact?action=activate&version=2`)).json;
  assert.equal(pre.campaigns.counts.approvedNewlyStale, 1);
  assert.deepEqual(pre.dependencies.map((d) => [d.entryId, d.continuity.kind]), [['FCT-001', 'absent'], ['FCT-002', 'unchanged'], ['FCT-004', 'unchanged']]);
  assert.match(pre.textChange.removed[0].text, /up to 12 hours/);
  assert.match(pre.textChange.added[0].text, /up to 8 hours/);
  await v.status();
  await v.start(); // asking again is a read of what is already there
  assert.ok(before.equals(ctx.bytes(v)), 'preview, status and a repeated start changed nothing on disk');
  // and the campaign is still approved on version 1
  assert.equal((await v.as('reviewer')('GET', `/api/submissions/${ids.campaignId}`)).json.workflow.status, 'approved');
});

test('the whole journey: activation stales the approval at once, approval is blocked, the repair re-approves, and the dossier and a reload keep both bindings', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  const ids = (await v.start()).json;
  const first = (await v.as('reviewer')('GET', `/api/submissions/${ids.campaignId}`)).json;
  const evidence1 = first.current.evidence.hash;

  // activation is a Manager action; a Creator cannot do it
  const creatorTry = await v.as('creator')('POST', `/api/sources/${ids.sourceId}/versions/2/approve`, { expectedSha256: 'x'.repeat(64) });
  assert.equal(creatorTry.status, 403);
  const { done } = await activate(v, ids.sourceId);
  assert.equal(done.status, 201, done.text);

  // the approval is stale immediately, from the stored evidence, and the guide says what to do next
  const stale = (await v.as('reviewer')('GET', `/api/submissions/${ids.campaignId}`)).json;
  assert.equal(stale.workflow.status, 'approval_stale');
  assert.deepEqual(stale.workflow.staleApproval.reasons, ['evidence']);
  assert.equal(stale.current.evidence.broken.length, 3);
  const s1 = (await v.status()).json;
  assert.equal(s1.stage, 'repair_evidence');
  assert.equal(s1.next.hash, '#/library');

  // a fresh approval is refused until the evidence is repaired: the review may be requested, the approval may not be given
  const rr = await requestReview(v, ids.campaignId);
  assert.equal(rr.status, 201, rr.text);
  const blocked = await approve(v, ids.campaignId);
  assert.ok(blocked.status >= 400, 'approving on broken evidence is refused');
  const gate = (await v.as('reviewer')('GET', `/api/submissions/${ids.campaignId}`)).json.workflow.eligibility.approve;
  assert.equal(gate.allowed, false);
  assert.ok(gate.reasons.some((x) => /no longer in force/.test(x)), 'the reason names the replaced evidence');

  // the repair: facts relinked to version 2 and corrected, then the copy corrected, review requested, a person decides
  await repair(v, ids);
  const s2 = (await v.status()).json;
  assert.equal(s2.stage, 'request_review', JSON.stringify(s2));
  assert.equal((await requestReview(v, ids.campaignId)).status, 201);
  assert.equal((await v.status()).json.stage, 'decide');
  const ok = await approve(v, ids.campaignId);
  assert.equal(ok.status, 201, ok.text);
  const done2 = (await v.status()).json;
  assert.equal(done2.stage, 'done');
  assert.equal(done2.approvals, 2);
  assert.equal(done2.next.hash, `#/dossier/${ids.campaignId}`);

  // the dossier keeps both approvals and what each covered; the two evidence bindings differ and entries now cite version 2
  const dossier = (await v.call('GET', `/api/submissions/${ids.campaignId}/dossier`)).json;
  const approvals = dossier.recordedEvents.events.filter((e) => e.type === 'approved');
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].binding.evidenceHash, evidence1);
  assert.notEqual(approvals[1].binding.evidenceHash, approvals[0].binding.evidenceHash);
  assert.equal(approvals[1].binding.evidenceHash, dossier.currentBinding.evidenceHash);
  assert.equal(approvals[0].bindingComparedWithCurrentInputs.matches, false);
  assert.equal(approvals[1].bindingComparedWithCurrentInputs.matches, true);
  assert.deepEqual(dossier.evidence.entries.map((e) => [e.sourceId, e.version, e.state]), [[ids.sourceId, 2, 'active'], [ids.sourceId, 2, 'active'], [ids.sourceId, 2, 'active']]);
  assert.match(approvals[0].note, /Sample history/);
  assert.doesNotMatch(approvals[1].note, /Sample history/);

  // a reload (the same cookie) and even a server restart keep every bit of it; asking to start again changes nothing
  const bytes = ctx.bytes(v);
  const again = await v.start();
  assert.equal(again.json.created, false);
  assert.equal(again.json.stage, 'done');
  assert.ok(bytes.equals(ctx.bytes(v)));
  assert.equal((await v.as('reviewer')('GET', `/api/submissions/${ids.campaignId}`)).json.workflow.status, 'approved');
});

// ---------------------------------------------------------------- per-visitor idempotency, preserved work

test('simultaneous starts (a double click, two tabs) set it up exactly once', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  const results = await Promise.all(Array.from({ length: 6 }, () => v.start()));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.json.created).length, 1, 'exactly one request did the work');
  assert.equal(new Set(results.map((r) => r.json.campaignId)).size, 1);
  const manager = v.as('manager');
  assert.equal((await manager('GET', '/api/sources')).json.sources.length, 1);
  assert.equal((await manager('GET', '/api/submissions')).json.submissions.filter((s) => s.title === TITLES.campaign).length, 1);
  assert.equal((await manager('GET', '/api/guidelines/versions')).json.versions.length, 2, 'one guideline version was added (links), once');
});

test('starting keeps the visitor\'s own work: their campaign, comment and the sample campaigns keep their text and history', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  const mine = (await v.as('creator')('POST', '/api/submissions', { title: 'My own campaign', text: 'Meet the Aurora Lamp. It lasts up to 12 hours.', asset: {} })).json;
  assert.equal((await v.as('creator')('POST', `/api/submissions/${mine.id}/comments`, { revision: 1, text: 'my note' })).status, 201);
  const sample = (await v.as('reviewer')('GET', '/api/submissions/SUB-2')).json;
  const mineBefore = (await v.as('reviewer')('GET', `/api/submissions/${mine.id}`)).json;
  const ids = (await v.start()).json;
  assert.notEqual(ids.campaignId, mine.id, 'an id number is not an identity: the scenario campaign is a different record');
  const mineAfter = (await v.as('reviewer')('GET', `/api/submissions/${mine.id}`)).json;
  assert.deepEqual(mineAfter.revisions, mineBefore.revisions);
  assert.deepEqual(mineAfter.comments, mineBefore.comments);
  assert.deepEqual(mineAfter.events, mineBefore.events);
  const sampleAfter = (await v.as('reviewer')('GET', '/api/submissions/SUB-2')).json;
  assert.deepEqual(sampleAfter.revisions, sample.revisions);
  // m27: a decision's receipt is stored data and must not change; its comparison with TODAY is computed on read and moves with the guidelines, by design.
  const stored = (events) => events.map(({ receiptComparison, ...rest }) => rest);
  assert.deepEqual(stored(sampleAfter.events), stored(sample.events), 'no event was added to or removed from the sample history');
  const approvedNow = sampleAfter.events.find((e) => e.type === 'approved');
  assert.equal(approvedNow.receiptStatus, 'recorded');
  assert.equal(approvedNow.receiptComparison.appliesNow, false, 'the comparison with today reflects the new guidelines');
  assert.deepEqual(approvedNow.receipt, sample.events.find((e) => e.type === 'approved').receipt, 'the recorded receipt is exactly what it was');
  // the guidelines changed (a new version links the facts), so an already approved sample says re-review: that is the product rule, and it is the only change
  assert.equal(sampleAfter.workflow.status, 'approval_stale');
  assert.ok(!sampleAfter.workflow.staleApproval.reasons.includes('content'));
  // the ordinary New submission path is unchanged
  const another = await v.as('creator')('POST', '/api/submissions', { title: 'After the scenario', text: 'Meet the Aurora Lamp.', asset: {} });
  assert.equal(another.status, 201);
});

test('a conflicting session is refused BEFORE anything is changed: a different source with the scenario\'s title, a fact linked elsewhere', async (t) => {
  const ctx = await startDemo(t);
  const a = await fresh(ctx);
  assert.equal((await a.as('creator')('POST', '/api/sources', { title: TITLES.source, text: 'Some other fictional document.', origin: 'paste' })).status, 201);
  const before = ctx.bytes(a);
  const r = await a.start();
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'scenario_conflict');
  assert.ok(before.equals(ctx.bytes(a)), 'nothing was written');

  const b = await fresh(ctx);
  const own = (await b.as('creator')('POST', '/api/sources', { title: 'My own source', text: 'Battery. A full charge lasts up to 12 hours at medium brightness.', origin: 'paste' })).json.source;
  assert.equal((await b.as('manager')('POST', `/api/sources/${own.id}/versions/1/approve`, { expectedSha256: own.versions[0].textSha256 })).status, 201);
  const g = (await b.as('manager')('GET', '/api/guidelines')).json;
  const ed = structuredClone(g.guidelines);
  ed.facts.find((f) => f.id === 'FCT-001').source = { sourceId: own.id, version: 1, start: 9, end: 40 };
  assert.equal((await b.as('manager')('PUT', '/api/guidelines', { baseVersion: g.version, note: 'mine', guidelines: ed })).status, 201);
  const beforeB = ctx.bytes(b);
  const rb = await b.start();
  assert.equal(rb.status, 409);
  assert.equal(rb.json.error.code, 'scenario_conflict');
  assert.ok(beforeB.equals(ctx.bytes(b)));
});

// ---------------------------------------------------------------- isolation

test('a second visitor never sees or changes the first one\'s scenario; the same id number is not the same record', async (t) => {
  const ctx = await startDemo(t);
  const a = await fresh(ctx);
  const b = await fresh(ctx);
  const ia = (await a.start()).json;
  assert.equal((await b.status()).json.started, false, 'B has nothing until B starts it');
  assert.equal((await b.as('manager')('GET', '/api/sources')).json.sources.length, 0);
  const ib = (await b.start()).json;
  assert.equal(ib.sourceId, ia.sourceId, 'both sessions number their first source the same');
  assert.equal(ib.campaignId, ia.campaignId);
  // A activates version 2 and repairs; B's identically numbered records are untouched
  const bBefore = ctx.bytes(b);
  await activate(a, ia.sourceId);
  assert.equal((await a.status()).json.stage, 'repair_evidence');
  assert.equal((await b.status()).json.stage, 'pending_change');
  assert.deepEqual((await b.as('manager')('GET', `/api/sources/${ib.sourceId}`)).json.source.versions.map((x) => x.state), ['active', 'pending']);
  assert.ok(bBefore.equals(ctx.bytes(b)), 'B\'s stored data did not change');
  // no cookie, a tampered cookie and a stolen-shape cookie reach nothing
  for (const cookie of [null, 'bp_judge=' + 'A'.repeat(43), a.cookie.slice(0, -2) + 'zz']) {
    assert.equal((await a.call('GET', '/api/judge/scenario', { cookie })).status, 401);
    assert.equal((await a.call('POST', '/api/judge/scenario', { cookie, headers: { origin: ctx.base }, body: {} })).status, 401);
  }
});

test('the route is for the judge demo only and for same-site browsers: a cross-origin or origin-less POST is refused, and the ordinary app has no such route', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  await v.call('GET', '/api/submissions');
  const before = ctx.bytes(v);
  assert.equal((await v.call('POST', '/api/judge/scenario', { body: {} })).status, 403, 'no Origin header');
  assert.equal((await v.call('POST', '/api/judge/scenario', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await v.call('DELETE', '/api/judge/scenario')).status, 405);
  assert.ok(before.equals(ctx.bytes(v)));
  const plain = await startApp();
  t.after(() => plain.close());
  assert.equal((await plain.call('GET', '/api/judge/scenario')).status, 404);
  assert.equal((await plain.call('POST', '/api/judge/scenario', { role: 'manager', body: {} })).status, 404);
});

// ---------------------------------------------------------------- bounds, failure, reset, expiry

test('caps hold: a session with no storage room or no image room is refused before the first write, and starting uses no session slot', async (t) => {
  const small = await startDemo(t, { limits: { sessionKiB: 64 } });
  const a = await fresh(small);
  await a.call('GET', '/api/submissions'); // opens the session's workspace file
  const beforeA = small.bytes(a);
  const ra = await a.start();
  assert.equal(ra.status, 413);
  assert.equal(ra.json.error.code, 'session_full');
  assert.ok(beforeA.equals(small.bytes(a)));
  assert.equal((await a.status()).json.started, false);

  const noImages = await startDemo(t, { limits: { imageCount: 0 } });
  const b = await fresh(noImages);
  await b.call('GET', '/api/submissions');
  const beforeB = noImages.bytes(b);
  const rb = await b.start();
  assert.equal(rb.status, 409);
  assert.equal(rb.json.error.code, 'scenario_no_room');
  assert.ok(beforeB.equals(noImages.bytes(b)), 'refused before any write');

  const ok = await startDemo(t);
  const c = await fresh(ok);
  const sessions = ok.demo.stats().sessions;
  assert.equal((await c.start()).status, 200);
  assert.equal(ok.demo.stats().sessions, sessions, 'the scenario does not create or bypass a session');
  const used = (await c.call('GET', '/api/judge/session')).json.storage.usedBytes;
  assert.ok(used < 96 * 1024 + 40 * 1024, `the scenario's footprint is small (${used} bytes in all)`);
});

test('a set-up that fails part-way keeps the visitor\'s work, is reported as unfinished, and finishing it adds nothing twice', async (t) => {
  for (const failAt of ['PUT /api/guidelines', 'POST /api/submissions', 'POST /api/sources/SRC-1/versions/1/approve']) {
    let armed = true;
    const ctx = await startDemo(t, {
      hooks: {
        scenarioCall: (n, method, pth) => {
          if (armed && `${method} ${pth}` === failAt) throw new Error('injected failure');
        },
      },
    });
    const v = await fresh(ctx);
    const mine = (await v.as('creator')('POST', '/api/submissions', { title: 'Mine', text: 'Meet the Aurora Lamp.', asset: {} })).json;
    const mineBefore = (await v.as('reviewer')('GET', `/api/submissions/${mine.id}`)).json;
    const failed = await v.start();
    assert.equal(failed.status, 500, failAt);
    assert.equal((await v.as('reviewer')('GET', `/api/submissions/${mine.id}`)).status, 200, 'the visitor can still use the session');
    assert.deepEqual((await v.as('reviewer')('GET', `/api/submissions/${mine.id}`)).json.revisions, mineBefore.revisions);
    const part = (await v.status()).json;
    assert.equal(part.started, true, failAt);
    assert.equal(part.ready, false);
    assert.equal(part.stage, 'incomplete');
    assert.equal(part.next.action, 'start');
    armed = false;
    const done = await v.start();
    assert.equal(done.status, 200, `${failAt}: ${done.text}`);
    assert.equal(done.json.stage, 'pending_change');
    const manager = v.as('manager');
    assert.equal((await manager('GET', '/api/sources')).json.sources.length, 1, 'no second source');
    assert.equal((await manager('GET', '/api/submissions')).json.submissions.filter((s) => s.title === TITLES.campaign).length, 1, 'no second campaign');
    assert.equal((await manager('GET', '/api/guidelines/versions')).json.versions.length, 2, 'the links were published once');
    assert.equal((await v.as('reviewer')('GET', `/api/submissions/${mine.id}`)).json.revisions.length, 1);
    await ctx.close();
  }
});

test('Reset my demo removes the scenario (and only that session\'s), and it can be started again; an expired session reaches nothing', async (t) => {
  const ctx = await startDemo(t);
  const a = await fresh(ctx);
  const b = await fresh(ctx);
  const ia = (await a.start()).json;
  await b.start();
  assert.equal((await a.post('/api/judge/reset', {})).status, 200);
  assert.deepEqual((await a.status()).json, { started: false });
  assert.equal((await b.status()).json.started, true, 'the other visitor is untouched');
  const again = await a.start();
  assert.equal(again.json.created, true);
  assert.equal(again.json.campaignId, ia.campaignId);
  ctx.time.now += 200 * MIN; // past the idle limit
  assert.equal((await a.status()).status, 401);
  assert.equal((await a.start()).status, 401);
});

// ---------------------------------------------------------------- cancellation (m24b)
// A visitor's writes take turns. A request that is waiting for its turn when its client disconnects must hand the turn on when it gets it;
// otherwise every later write in that session would wait forever. Both kinds of waiting request are tested: an ordinary write and the scenario start.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JSON_POST = (ctx, v, body, extra = {}) => ({ method: 'POST', headers: { cookie: v.cookie, 'x-demo-role': 'creator', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });

/** Hold this visitor's write queue deterministically: a write whose body is only half sent keeps its turn until the rest arrives. */
async function holdWriteQueue(ctx, v) {
  const port = Number(new URL(ctx.base).port);
  const body = JSON.stringify({ title: 'Blocker campaign', text: 'Meet the Aurora Lamp.', asset: {} });
  const half = Math.floor(body.length / 2);
  const sock = net.connect(port, '127.0.0.1');
  let reply = '';
  sock.on('data', (d) => (reply += d.toString('latin1')));
  sock.on('error', () => {});
  await new Promise((r) => sock.once('connect', r));
  sock.write(`POST /api/submissions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${v.cookie}\r\nx-demo-role: creator\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, half)}`);
  await sleep(300);
  // proof the queue is held: an ordinary write now waits (it is ended by its own short bound, not answered)
  const probe = await fetch(ctx.base + '/api/submissions', { ...JSON_POST(ctx, v, { title: 'Probe', text: 'Meet the Aurora Lamp.', asset: {} }), signal: AbortSignal.timeout(500) }).then(() => 'answered', () => 'waiting');
  assert.equal(probe, 'waiting', 'the blocker holds the session\'s write turn');
  return {
    /** Let the blocker finish: its turn passes to whatever is queued behind it. */
    async release() {
      sock.write(body.slice(half));
      for (let i = 0; i < 40 && !/HTTP\/1\.1 201/.test(reply); i++) await sleep(100);
      assert.match(reply, /HTTP\/1\.1 201/, 'the blocker\'s write completed');
      sock.destroy();
    },
  };
}

/** Queue a request behind the blocker, wait until it is surely queued, then disconnect its client. */
async function queueThenDisconnect(url, init) {
  const abort = new AbortController();
  const queued = fetch(url, { ...init, signal: abort.signal }).then(() => 'answered', () => 'disconnected');
  await sleep(300);
  abort.abort();
  assert.equal(await queued, 'disconnected');
  await sleep(300);
}

/** An ordinary write must not wait forever behind a turn nobody will release. */
const writeAfter = (ctx, v, title) => fetch(ctx.base + '/api/submissions', { ...JSON_POST(ctx, v, { title, text: 'Meet the Aurora Lamp.', asset: {} }), signal: AbortSignal.timeout(5000) }).then((r) => r.status, (e) => `no answer within 5 s (${e.name}): the write turn was never released`);

test('control: an ordinary queued write whose client disconnects gives its turn back', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  assert.equal((await v.call('GET', '/api/submissions')).status, 200);
  const hold = await holdWriteQueue(ctx, v);
  await queueThenDisconnect(ctx.base + '/api/submissions', JSON_POST(ctx, v, { title: 'Abandoned', text: 'Meet the Aurora Lamp.', asset: {} }));
  await hold.release();
  assert.equal(await writeAfter(ctx, v, 'After the abandoned write'), 201);
});

test('a queued scenario start whose client disconnects gives its turn back: the next ordinary write is bounded and succeeds, and the start did nothing', async (t) => {
  const ctx = await startDemo(t);
  const v = await fresh(ctx);
  assert.equal((await v.call('GET', '/api/submissions')).status, 200);
  const hold = await holdWriteQueue(ctx, v);
  await queueThenDisconnect(ctx.base + '/api/judge/scenario', { method: 'POST', headers: { cookie: v.cookie, origin: ctx.base, 'content-type': 'application/json' }, body: '{}' });
  await hold.release();
  assert.equal(await writeAfter(ctx, v, 'After the cancelled start'), 201);
  // the cancelled start changed nothing, and the same visitor can still start the scenario
  assert.deepEqual((await v.status()).json, { started: false });
  const ok = await v.start();
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.created, true);
  assert.equal(ok.json.stage, 'pending_change');
});
