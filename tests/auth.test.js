import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword, parseHash, passwordProblems, createLimiter, DEFAULT_COST } from '../src/auth.js';
import { startApp, tempDir, cleanContent } from './helpers.js';
import { startAuthApp, newSubmission, makeClock, synthPassword, TEST_COST } from './auth-helpers.js';

const MIN = 60_000;

/** Creator creates a submission and requests review. Returns the detail the reviewer would see. */
async function inReview(creator, reviewer, extra) {
  const made = await creator.call('POST', '/api/submissions', { body: newSubmission(extra) });
  assert.equal(made.status, 201, made.text);
  const rr = await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } });
  assert.equal(rr.status, 201, rr.text);
  return (await reviewer.call('GET', `/api/submissions/${made.json.id}`)).json;
}
const approveBody = (d, extra = {}) => ({ revision: d.headRevision, expected: d.workflow.binding, ...extra });

// ---------- unauthenticated access ----------

test('unauthenticated: every workspace route is 401, a forged demo-role header buys nothing, only the shell and sign-in info are public', async () => {
  const t = await startAuthApp();
  try {
    const anon = t.client();
    const forged = { 'x-demo-role': 'manager' };
    const gets = ['/api/submissions', '/api/submissions/SUB-1', '/api/guidelines', '/api/guidelines/versions', '/api/insights', '/api/semantic/status', '/api/auth/me', '/api/admin/users', '/api/admin/audit', '/api/submissions/SUB-1/compare?from=1&to=1'];
    for (const p of gets) assert.equal((await anon.call('GET', p, { headers: forged })).status, 401, p);
    const posts = ['/api/submissions', '/api/check', '/api/semantic/match', '/api/auth/logout', '/api/auth/password', '/api/admin/users'];
    for (const p of posts) assert.equal((await anon.call('POST', p, { body: {}, headers: forged })).status, 401, p);
    assert.equal((await anon.call('PUT', '/api/guidelines', { body: {}, headers: forged })).status, 401);

    const meta = (await anon.call('GET', '/api/meta')).json;
    assert.equal(meta.mode, 'authenticated');
    assert.equal(meta.demo, false);
    assert.equal(meta.setupRequired, false);
    for (const leaked of ['guidelineVersion', 'semantic', 'aiContract']) assert.equal(leaked in meta, false, leaked);
    assert.equal((await anon.call('GET', '/')).status, 200); // the app shell contains no workspace data
  } finally {
    await t.close();
  }
});

test('with no accounts the workspace is closed and the setup state says so; there are no default credentials', async () => {
  const t = await startAuthApp({ users: [] });
  try {
    const c = t.client();
    assert.equal((await c.call('GET', '/api/meta')).json.setupRequired, true);
    assert.equal(t.app.auth.userCount(), 0);
    for (const guess of [['admin', 'admin'], ['owner', 'password'], ['syn-owner', 'x']]) {
      assert.equal((await c.call('POST', '/api/auth/login', { body: { username: guess[0], password: guess[1] } })).status, 401);
    }
    assert.equal((await c.call('GET', '/api/submissions')).status, 401);
  } finally {
    await t.close();
  }
});

// ---------- sign-in ----------

test('sign-in: cookie is HttpOnly + SameSite=Strict, opaque, no secrets in bodies; failures are generic and identical', async () => {
  const t = await startAuthApp();
  try {
    const c = t.client();
    const ok = await c.login('creator');
    assert.equal(ok.status, 200);
    const cookie = ok.setCookie[0];
    assert.match(cookie, /^bp_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{40,}/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Max-Age|Expires/); // browser-session cookie; the server enforces expiry
    assert.equal(ok.json.user.role, 'creator');
    assert.equal(ok.json.user.name, 'Synthetic creator');
    assert.doesNotMatch(ok.text, /passwordHash|scrypt\$/);
    assert.ok(ok.json.csrf.length >= 40);

    const wrongPw = await t.client().login('creator', 'definitely-not-the-password');
    const noUser = await t.client().login('syn-nobody', 'definitely-not-the-password');
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(wrongPw.json, noUser.json); // no account enumeration
    assert.equal(wrongPw.json.error.message, 'Invalid username or password.');
    assert.equal(wrongPw.setCookie.length, 0);

    for (const bad of [{}, { username: 'x' }, { username: 'syn-creator', password: 5 }, { username: ['a'], password: 'b' }]) {
      const r = await t.client().call('POST', '/api/auth/login', { body: bad });
      assert.ok([401, 422].includes(r.status), JSON.stringify(bad));
    }
  } finally {
    await t.close();
  }
});

test('sign-in: every sign-in gets a NEW session id (no fixation) and a pre-set cookie is not adopted', async () => {
  const t = await startAuthApp();
  try {
    const a = t.client();
    const b = t.client();
    await a.login('creator');
    await b.login('creator', undefined, { cookie: a.cookie }); // attacker-planted cookie sent along with the login
    assert.notEqual(a.cookie, b.cookie);
    assert.equal((await a.call('GET', '/api/auth/me')).status, 200);
    const planted = await t.client().call('GET', '/api/auth/me', { cookie: 'bp_session=AAAA.BBBB' });
    assert.equal(planted.status, 401);
  } finally {
    await t.close();
  }
});

test('login bodies are size-limited and the server survives hostile input', async () => {
  const t = await startAuthApp();
  try {
    const c = t.client();
    const big = await c.call('POST', '/api/auth/login', { raw: JSON.stringify({ username: 'x', password: 'y'.repeat(20_000) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413);
    assert.equal((await c.call('POST', '/api/auth/login', { raw: '{nope', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await c.call('POST', '/api/auth/login', { raw: 'a=b', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await c.login('creator')).status, 200);
  } finally {
    await t.close();
  }
});

// ---------- forged role / role boundaries ----------

test('server-derived role: a creator session with forged X-Demo-Role headers is still just a creator', async () => {
  const t = await startAuthApp();
  try {
    const creator = await t.as('creator');
    for (const role of ['manager', 'reviewer', 'admin', '']) {
      const r = await creator.call('PUT', '/api/guidelines', { body: { baseVersion: 1, guidelines: {} }, headers: { 'x-demo-role': role } });
      assert.equal(r.status, 403, `role header "${role}"`); // 403 (not 400): the header is not even read
    }
    const made = await creator.call('POST', '/api/submissions', { body: newSubmission(), headers: { 'x-demo-role': 'reviewer' } });
    assert.equal(made.status, 201);
    assert.equal(made.json.createdBy.role, 'creator');
    await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } });
    const d = (await creator.call('GET', `/api/submissions/${made.json.id}`, { headers: { 'x-demo-role': 'manager' } })).json;
    assert.equal(d.workflow.eligibility.approve.allowed, false);
    const approve = await creator.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(d), headers: { 'x-demo-role': 'manager' } });
    assert.equal(approve.status, 403);
    assert.match(approve.json.error.message, /cannot do this/);
    const admin = await creator.call('GET', '/api/admin/users', { headers: { 'x-demo-role': 'manager' } });
    assert.equal(admin.status, 403);
  } finally {
    await t.close();
  }
});

test('role boundaries: creator, reviewer and manager can each do exactly their part', async () => {
  const t = await startAuthApp();
  try {
    const [creator, reviewer, manager] = [await t.as('creator'), await t.as('reviewer'), await t.as('manager')];
    // reviewers cannot author
    assert.equal((await reviewer.call('POST', '/api/submissions', { body: newSubmission() })).status, 403);
    const made = await creator.call('POST', '/api/submissions', { body: newSubmission() });
    const id = made.json.id;
    assert.equal((await reviewer.call('POST', `/api/submissions/${id}/revisions`, { body: { baseRevision: 1, text: 'Other copy here.', asset: {} } })).status, 403);
    assert.equal((await reviewer.call('POST', `/api/submissions/${id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } })).status, 403);
    // everyone can comment
    for (const c of [creator, reviewer, manager]) assert.equal((await c.call('POST', `/api/submissions/${id}/comments`, { body: { revision: 1, text: 'hello' } })).status, 201);
    // only managers publish guidelines
    const g = (await creator.call('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    edited.claims.signals.push('unbeatable');
    for (const c of [creator, reviewer]) assert.equal((await c.call('PUT', '/api/guidelines', { body: { baseVersion: 1, guidelines: edited } })).status, 403);
    const pub = await manager.call('PUT', '/api/guidelines', { body: { baseVersion: 1, note: 'add', guidelines: edited } });
    assert.equal(pub.status, 201);
    assert.equal((await manager.call('GET', '/api/guidelines')).json.createdBy, `Synthetic manager (${t.ids.manager})`);
    // creator cannot decide
    const d = (await creator.call('GET', `/api/submissions/${id}`)).json;
    const rr = await creator.call('POST', `/api/submissions/${id}/request-review`, { body: { revision: 1, expected: d.workflow.binding } });
    assert.equal(rr.status, 201);
    const d2 = (await creator.call('GET', `/api/submissions/${id}`)).json;
    assert.equal((await creator.call('POST', `/api/submissions/${id}/approve`, { body: approveBody(d2) })).status, 403);
    assert.equal((await creator.call('POST', `/api/submissions/${id}/reject`, { body: approveBody(d2, { note: 'no' }) })).status, 403);
  } finally {
    await t.close();
  }
});

test('owner-only administration: a manager who is not an owner cannot list, create or disable users or read the audit log', async () => {
  const t = await startAuthApp();
  try {
    const manager = await t.as('manager');
    const owner = await t.as('owner');
    for (const [m, p] of [['GET', '/api/admin/users'], ['GET', '/api/admin/audit'], ['POST', '/api/admin/users'], ['POST', `/api/admin/users/${t.ids.creator}/disable`], ['POST', `/api/admin/users/${t.ids.creator}/reset-password`]]) {
      assert.equal((await manager.call(m, p, m === 'GET' ? {} : { body: {} })).status, 403, p);
    }
    const users = (await owner.call('GET', '/api/admin/users')).json.users;
    assert.equal(users.length, 5);
    assert.ok(users.every((u) => !('passwordHash' in u)));
    assert.equal((await owner.call('GET', '/api/admin/users')).text.includes('scrypt$'), false);
  } finally {
    await t.close();
  }
});

// ---------- accountable review ----------

test('self-approval is impossible: a manager who created the submission cannot approve it, and says why', async () => {
  const t = await startAuthApp({ users: ['manager', 'manager2', 'reviewer'] });
  try {
    const [m1, m2, reviewer] = [await t.as('manager'), await t.as('manager2'), await t.as('reviewer')];
    const d = await inReview(m1, m1);
    assert.equal(d.workflow.status, 'in_review');
    assert.equal(d.workflow.eligibility.approve.allowed, false);
    assert.equal(d.workflow.eligibility.approve.selfReview, true);
    assert.match(d.workflow.eligibility.approve.reasons.join(' '), /different person must approve/);

    const self = await m1.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(d) });
    assert.equal(self.status, 403);
    assert.match(self.json.error.message, /different person/);
    const still = (await m1.call('GET', `/api/submissions/${d.id}`)).json;
    assert.equal(still.workflow.status, 'in_review');
    assert.equal(still.events.filter((e) => e.type === 'approved').length, 0);

    // a distinct manager and a distinct reviewer are both fine
    const other = (await m2.call('GET', `/api/submissions/${d.id}`)).json;
    assert.equal(other.workflow.eligibility.approve.allowed, true);
    assert.equal(other.workflow.eligibility.approve.selfReview, false);
    const ok = await reviewer.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(d, { note: 'independent check' }) });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.workflow.status, 'approved');
    const ev = ok.json.events.at(-1);
    assert.deepEqual(ev.actor, { id: t.ids.reviewer, name: 'Synthetic reviewer', role: 'reviewer' });
    assert.notEqual(ev.actor.id, ok.json.createdBy.id);
  } finally {
    await t.close();
  }
});

test('self-approval: editing someone else\'s submission also makes you a contributor who cannot approve it', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'manager2'] });
  try {
    const [creator, m1, m2] = [await t.as('creator'), await t.as('manager'), await t.as('manager2')];
    const made = await creator.call('POST', '/api/submissions', { body: newSubmission() });
    const rev = await m1.call('POST', `/api/submissions/${made.json.id}/revisions`, { body: { baseRevision: 1, text: cleanContent().text + ' Quiet by design.', asset: cleanContent().asset } });
    assert.equal(rev.status, 201);
    assert.equal(rev.json.revisions[1].author.id, t.ids.manager);
    const rr = await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 2, expected: rev.json.workflow.binding } });
    assert.equal(rr.status, 201);
    const d = (await m1.call('GET', `/api/submissions/${made.json.id}`)).json;
    assert.equal((await m1.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(d) })).status, 403);
    assert.equal((await m2.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(d) })).status, 201);
  } finally {
    await t.close();
  }
});

test('self-approval rule does not weaken the other gates: blocking findings still stop a distinct reviewer', async () => {
  const t = await startAuthApp();
  try {
    const [creator, reviewer] = [await t.as('creator'), await t.as('reviewer')];
    const d = await inReview(creator, reviewer, { text: 'A full charge lasts 30 hours.' });
    assert.equal(d.workflow.eligibility.approve.allowed, false);
    assert.equal(d.workflow.eligibility.approve.selfReview, false);
    assert.match(d.workflow.eligibility.approve.reasons.join(' '), /blocking finding/);
    assert.equal((await reviewer.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(d) })).status, 403);
  } finally {
    await t.close();
  }
});

test('actor provenance: stored records carry stable ids and names from the session, never from the request body', async () => {
  const t = await startAuthApp();
  try {
    const [creator, reviewer] = [await t.as('creator'), await t.as('reviewer')];
    const made = await creator.call('POST', '/api/submissions', { body: { ...newSubmission(), author: { id: 'U-999', name: 'Mallory', role: 'manager' }, createdBy: { id: 'U-999' } } });
    assert.deepEqual(made.json.createdBy, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' });
    assert.deepEqual(made.json.revisions[0].author, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' });
    const c = await reviewer.call('POST', `/api/submissions/${made.json.id}/comments`, { body: { revision: 1, text: 'looks fine', author: { id: 'U-1', name: 'Owner' } } });
    assert.deepEqual(c.json.author, { id: t.ids.reviewer, name: 'Synthetic reviewer', role: 'reviewer' });
    const rr = await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding, actor: { id: 'U-1' } } });
    assert.equal(rr.json.events[0].actor.id, t.ids.creator);
    const d = (await reviewer.call('GET', `/api/submissions/${made.json.id}`)).json;
    const rej = await reviewer.call('POST', `/api/submissions/${d.id}/reject`, { body: approveBody(d, { note: 'Please add alt detail.' }) });
    assert.equal(rej.status, 201);
    assert.equal(rej.json.events.at(-1).actor.id, t.ids.reviewer);
    assert.equal(rej.json.events.at(-1).note, 'Please add alt detail.');
  } finally {
    await t.close();
  }
});

test('version bindings and stale-view prevention work exactly as in demo mode', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'reviewer'] });
  try {
    const [creator, manager, reviewer] = [await t.as('creator'), await t.as('manager'), await t.as('reviewer')];
    const d = await inReview(creator, reviewer);
    const seen = d.workflow.binding;
    const g = (await manager.call('GET', '/api/guidelines')).json;
    const edited = structuredClone(g.guidelines);
    edited.claims.signals.push('unbeatable');
    assert.equal((await manager.call('PUT', '/api/guidelines', { body: { baseVersion: 1, guidelines: edited } })).status, 201);

    const stale = await reviewer.call('POST', `/api/submissions/${d.id}/approve`, { body: { revision: 1, expected: seen } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'stale_view');
    assert.deepEqual(stale.json.error.details.changed, ['guideline']);

    const fresh = (await reviewer.call('GET', `/api/submissions/${d.id}`)).json;
    const ok = await reviewer.call('POST', `/api/submissions/${d.id}/approve`, { body: approveBody(fresh) });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.events.at(-1).binding.guidelineVersion, 2);

    // an edit after approval -> Re-review required (new revision, content changed)
    const rev = await creator.call('POST', `/api/submissions/${d.id}/revisions`, { body: { baseRevision: 1, text: cleanContent().text + ' Quiet by design.', asset: cleanContent().asset } });
    assert.equal(rev.json.workflow.status, 'approval_stale');
    assert.deepEqual(rev.json.workflow.staleApproval.reasons, ['content']);
    // and a guideline change again
    const g2 = (await manager.call('GET', '/api/guidelines')).json;
    const e2 = structuredClone(g2.guidelines);
    e2.claims.signals.push('peerless');
    await manager.call('PUT', '/api/guidelines', { body: { baseVersion: 2, guidelines: e2 } });
    const after = (await creator.call('GET', `/api/submissions/${d.id}`)).json;
    assert.deepEqual(after.workflow.staleApproval.reasons.sort(), ['content', 'guideline']);
    assert.equal((await creator.call('GET', '/api/submissions')).json.submissions.find((s) => s.id === d.id).status, 'approval_stale');
  } finally {
    await t.close();
  }
});

// ---------- sessions ----------

test('sessions: idle expiry, absolute expiry, and activity keeps a session alive', async () => {
  const t = await startAuthApp();
  try {
    const idle = await t.as('creator');
    t.clock.advance(29 * MIN);
    assert.equal((await idle.call('GET', '/api/auth/me')).status, 200); // activity resets the idle timer
    t.clock.advance(29 * MIN);
    assert.equal((await idle.call('GET', '/api/auth/me')).status, 200);
    t.clock.advance(31 * MIN);
    const gone = await idle.call('GET', '/api/auth/me');
    assert.equal(gone.status, 401);
    assert.equal((await idle.call('GET', '/api/submissions')).status, 401); // and it stays dead

    const long = await t.as('creator');
    for (let i = 0; i < 18; i++) {
      t.clock.advance(28 * MIN); // always active, never idle
      const r = await long.call('GET', '/api/auth/me');
      if (r.status === 401) break;
    }
    assert.equal((await long.call('GET', '/api/auth/me')).status, 401, 'absolute 8 hour limit applies even to an active session');
  } finally {
    await t.close();
  }
});

test('logout revokes the session on the server: a copied cookie stops working', async () => {
  const t = await startAuthApp();
  try {
    const c = await t.as('creator');
    const copied = c.cookie;
    const out = await c.call('POST', '/api/auth/logout', { body: {} });
    assert.equal(out.status, 200);
    assert.match(out.setCookie[0], /bp_session=;/);
    assert.match(out.setCookie[0], /Max-Age=0/);
    assert.equal((await t.client().call('GET', '/api/submissions', { cookie: copied })).status, 401);
    assert.equal(t.app.auth.sessionCount(), 0);
  } finally {
    await t.close();
  }
});

test('logout needs a valid CSRF token (cannot be forced cross-site)', async () => {
  const t = await startAuthApp();
  try {
    const c = await t.as('creator');
    assert.equal((await c.call('POST', '/api/auth/logout', { body: {}, csrf: null })).status, 403);
    assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
  } finally {
    await t.close();
  }
});

test('a server restart signs everyone out (sessions are memory-only) but accounts and workspace data persist', async () => {
  const t = await startAuthApp();
  try {
    const c = await t.as('creator');
    const made = await c.call('POST', '/api/submissions', { body: newSubmission({ title: 'Survives restart' }) });
    const oldCookie = c.cookie;
    await t.restart();
    assert.equal((await t.client().call('GET', '/api/submissions', { cookie: oldCookie })).status, 401);
    const again = await t.as('creator');
    const list = (await again.call('GET', '/api/submissions')).json.submissions;
    assert.equal(list.find((s) => s.id === made.json.id).title, 'Survives restart');
    const d = (await again.call('GET', `/api/submissions/${made.json.id}`)).json;
    assert.deepEqual(d.createdBy, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' }); // actor id is stable across restarts
    assert.ok((await t.listDir()).some((n) => n.startsWith('workspace.json.bak-')), 'a recoverable backup was taken on reopen');
    assert.ok((await t.listDir('auth')).some((n) => n.startsWith('users.json.bak-')));
  } finally {
    await t.close();
  }
});

test('disabling an account revokes its live sessions immediately; the last owner cannot be disabled', async () => {
  const t = await startAuthApp();
  try {
    const owner = await t.as('owner');
    const victim = await t.as('creator');
    assert.equal((await victim.call('GET', '/api/submissions')).status, 200);
    assert.equal((await owner.call('POST', `/api/admin/users/${t.ids.creator}/disable`, { body: {} })).status, 200);
    assert.equal((await victim.call('GET', '/api/submissions')).status, 401);
    assert.equal((await t.client().login('creator')).status, 401); // cannot sign in while disabled
    assert.equal((await owner.call('POST', `/api/admin/users/${t.ids.creator}/enable`, { body: {} })).status, 200);
    assert.equal((await t.client().login('creator')).status, 200);
    const last = await owner.call('POST', `/api/admin/users/${t.ids.owner}/disable`, { body: {} });
    assert.equal(last.status, 409);
    assert.equal(last.json.error.code, 'last_owner');
  } finally {
    await t.close();
  }
});

test('owner can add accounts and reset passwords (never owners over HTTP); resets revoke sessions', async () => {
  const t = await startAuthApp();
  try {
    const owner = await t.as('owner');
    const pw = synthPassword();
    const r = await owner.call('POST', '/api/admin/users', { body: { username: 'Syn-Extra', displayName: 'Synthetic extra', role: 'reviewer', password: pw, owner: true } });
    assert.equal(r.status, 201);
    assert.equal(r.json.owner, false); // an owner flag in the request is ignored
    assert.equal(r.json.username, 'syn-extra');
    assert.equal((await owner.call('POST', '/api/admin/users', { body: { username: 'syn-extra', displayName: 'Dup', role: 'reviewer', password: synthPassword() } })).status, 409);
    const weak = await owner.call('POST', '/api/admin/users', { body: { username: 'syn-weak', displayName: 'Weak', role: 'creator', password: 'short' } });
    assert.equal(weak.status, 422);
    assert.ok(weak.json.error.details.fields.some((f) => f.path === 'password'));
    assert.equal((await owner.call('POST', '/api/admin/users', { body: { username: 'x', displayName: '', role: 'wizard', password: pw } })).status, 422);

    const extra = t.client();
    assert.equal((await extra.login('syn-extra', pw)).status, 200);
    const fresh = synthPassword();
    assert.equal((await owner.call('POST', `/api/admin/users/${r.json.id}/reset-password`, { body: { password: fresh } })).status, 200);
    assert.equal((await extra.call('GET', '/api/submissions')).status, 401);
    assert.equal((await t.client().login('syn-extra', pw)).status, 401);
    assert.equal((await t.client().login('syn-extra', fresh)).status, 200);
    assert.equal((await owner.call('POST', '/api/admin/users/U-404/disable', { body: {} })).status, 404);
  } finally {
    await t.close();
  }
});

test('changing your own password: needs the current one, revokes other sessions, rotates your session id', async () => {
  const t = await startAuthApp();
  try {
    const a = await t.as('creator');
    const b = await t.as('creator'); // a second device
    const next = synthPassword();
    const wrong = await a.call('POST', '/api/auth/password', { body: { current: 'not-it', next } });
    assert.equal(wrong.status, 401);
    const weak = await a.call('POST', '/api/auth/password', { body: { current: t.passwords.creator, next: 'short' } });
    assert.equal(weak.status, 422);
    const ok = await a.call('POST', '/api/auth/password', { body: { current: t.passwords.creator, next } });
    assert.equal(ok.status, 200);
    assert.equal((await b.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await a.call('GET', '/api/auth/me')).status, 401, 'the old session id is dead');
    const newCookie = ok.setCookie[0].split(';')[0];
    assert.equal((await t.client().call('GET', '/api/auth/me', { cookie: newCookie })).status, 200);
    assert.equal((await t.client().login('creator', t.passwords.creator)).status, 401);
    assert.equal((await t.client().login('creator', next)).status, 200);
  } finally {
    await t.close();
  }
});

// ---------- CSRF / origin ----------

test('CSRF and origin: unsafe requests need a matching Origin AND the session token; reads are unaffected', async () => {
  const t = await startAuthApp();
  try {
    const c = await t.as('creator');
    const body = newSubmission();
    assert.equal((await c.call('POST', '/api/submissions', { body, origin: null })).status, 403, 'missing Origin');
    assert.equal((await c.call('POST', '/api/submissions', { body, origin: 'http://evil.example' })).status, 403, 'foreign Origin');
    assert.equal((await c.call('POST', '/api/submissions', { body, origin: 'null' })).status, 403, 'Origin: null');
    const noToken = await c.call('POST', '/api/submissions', { body, csrf: null });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.json.error.code, 'bad_csrf');
    assert.equal((await c.call('POST', '/api/submissions', { body, csrf: 'A'.repeat(c.csrf.length) })).status, 403, 'wrong token');
    assert.equal((await c.call('POST', '/api/submissions', { body, csrf: c.csrf.slice(0, 10) })).status, 403, 'short token');
    // another user's token does not work for this session
    const other = await t.as('manager');
    assert.equal((await c.call('POST', '/api/submissions', { body, csrf: other.csrf })).status, 403);
    assert.equal((await c.call('POST', '/api/submissions', { body })).status, 201);
    assert.equal((await t.client().call('GET', '/api/auth/me', { cookie: c.cookie, origin: 'http://evil.example' })).status, 200); // reads carry no state change
    assert.equal((await c.call('PUT', '/api/guidelines', { body: {}, origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.client().login('creator', undefined, { origin: 'http://evil.example' })).status, 403, 'login CSRF: foreign origin refused');
    assert.equal((await t.client().login('creator', undefined, { origin: null })).status, 403, 'login without Origin refused');
  } finally {
    await t.close();
  }
});

test('Host header guard still applies in authenticated mode', async () => {
  const t = await startAuthApp();
  try {
    const http = await import('node:http');
    const port = new URL(t.url).port;
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/meta', headers: { host: 'evil.example' } }, (res) => (res.resume(), resolve(res.statusCode))).on('error', reject);
    });
    assert.equal(status, 403);
  } finally {
    await t.close();
  }
});

// ---------- rate limiting ----------

test('credential checks are rate limited per account: lockout even for the right password, doubling, then recovery', async () => {
  const t = await startAuthApp();
  try {
    const c = t.client();
    for (let i = 0; i < 5; i++) assert.equal((await c.login('creator', `wrong-${i}`)).status, 401);
    const locked = await c.login('creator'); // correct password, but locked out
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.code, 'too_many_attempts');
    assert.ok(locked.json.error.details.retryAfterSeconds > 0);
    assert.equal(locked.setCookie.length, 0);
    assert.equal((await t.client().login('creator', t.passwords.creator)).status, 429, 'a different client cannot bypass an account lockout');
    // other accounts are not affected
    assert.equal((await t.client().login('reviewer')).status, 200);

    t.clock.advance(16 * MIN);
    // first lockout (15 min) has expired; five more failures lock again, now for twice as long
    for (let i = 0; i < 5; i++) assert.equal((await c.login('creator', `again-${i}`)).status, 401);
    assert.equal((await c.login('creator')).status, 429);
    t.clock.advance(16 * MIN);
    assert.equal((await c.login('creator')).status, 429, 'repeat offenders wait longer than the first lockout');
    t.clock.advance(15 * MIN);
    assert.equal((await c.login('creator')).status, 200); // 31 minutes in: second lockout over
  } finally {
    await t.close();
  }
});

test('lockout also applies to names that do not exist (so it reveals nothing), and failures are audited without secrets', async () => {
  const t = await startAuthApp();
  try {
    const c = t.client();
    for (let i = 0; i < 5; i++) await c.login('syn-ghost', `guess-secret-${i}`);
    assert.equal((await c.login('syn-ghost', 'anything')).status, 429);
    const owner = await t.as('owner');
    const audit = (await owner.call('GET', '/api/admin/audit')).json.events;
    assert.ok(audit.some((e) => e.event === 'login_failure' && e.subject === 'syn-ghost'));
    assert.ok(audit.some((e) => e.event === 'login_blocked'));
    assert.ok(audit.some((e) => e.event === 'login_success' && e.actor === t.ids.owner));
    assert.equal(JSON.stringify(audit).includes('guess-secret'), false);
  } finally {
    await t.close();
  }
});

test('limiter unit: per-address cap, window expiry, success clears the account bucket', () => {
  const clock = makeClock();
  const lim = createLimiter({ nowMs: clock.now, accountMax: 3, ipMax: 4 });
  for (let i = 0; i < 2; i++) lim.fail('a', '1.1.1.1');
  assert.equal(lim.retryAfter('a', '1.1.1.1'), 0);
  lim.succeed('a');
  for (let i = 0; i < 2; i++) lim.fail('a', '1.1.1.1');
  assert.equal(lim.retryAfter('a', '9.9.9.9'), 0); // success reset the account bucket
  lim.fail('b', '1.1.1.1'); // 4th failure from the address
  assert.ok(lim.retryAfter('zzz', '1.1.1.1') > 0, 'address bucket locks other account names too');
  assert.equal(lim.retryAfter('zzz', '2.2.2.2'), 0);
  clock.advance(60 * MIN);
  assert.equal(lim.retryAfter('zzz', '1.1.1.1'), 0);
});

// ---------- secrets handling ----------

test('no sensitive payloads are logged, stored in the clear, or echoed back', async () => {
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  let t;
  try {
    t = await startAuthApp();
    const secret = synthPassword();
    const owner = await t.as('owner');
    await owner.call('POST', '/api/admin/users', { body: { username: 'syn-logcheck', displayName: 'Log check', role: 'creator', password: secret } });
    await t.client().login('syn-logcheck', 'wrong-password-for-log-check');
    const c = t.client();
    const ok = await c.login('syn-logcheck', secret);
    await c.call('POST', '/api/auth/login', { raw: '{bad', headers: { 'content-type': 'application/json' } });
    const file = await t.readAuthFile();
    const cookieSecret = c.cookie.split('=')[1].split('.')[1];

    const everything = logs.join('\n');
    for (const needle of [secret, 'wrong-password-for-log-check', t.passwords.owner, cookieSecret, c.csrf]) {
      assert.equal(everything.includes(needle), false, 'logs');
      assert.equal(file.includes(needle), false, 'credential file');
      assert.equal(ok.text.includes(needle) && needle === secret, false, 'response');
    }
    assert.match(file, /"passwordHash": "scrypt\$1024\$8\$1\$/);
    const wsFile = await readFile(t.files.dataFile, 'utf8');
    assert.equal(wsFile.includes('scrypt$'), false, 'credentials are not in the workspace file');
    assert.equal(wsFile.includes('passwordHash'), false);
  } finally {
    Object.assign(console, orig);
    await t?.close();
  }
});

test('password hashing: scrypt with per-password salts, OWASP-minimum default cost, tamper-safe parsing', async () => {
  assert.deepEqual(DEFAULT_COST, { N: 131072, r: 8, p: 1 }); // OWASP Password Storage: scrypt minimum N=2^17, r=8, p=1
  const pw = synthPassword();
  const a = await hashPassword(pw, TEST_COST);
  const b = await hashPassword(pw, TEST_COST);
  assert.notEqual(a, b, 'unique salt per hash');
  assert.equal(await verifyPassword(pw, a), true);
  assert.equal(await verifyPassword(pw + 'x', a), false);
  assert.equal(await verifyPassword(pw, 'plaintext'), false);
  assert.equal(parseHash('scrypt$3$8$1$AAAA$AAAA'), null, 'N must be a power of two');
  assert.equal(parseHash('scrypt$1073741824$8$1$AAAA$AAAA'), null, 'absurd cost from a tampered file is refused');
  assert.equal(parseHash('md5$1$2$3$a$b'), null);
  assert.equal(await verifyPassword('é'.repeat(16), await hashPassword('é'.repeat(16), TEST_COST)), true);
  // NFKC normalisation: the composed and decomposed forms of the same text are the same password
  assert.equal(await verifyPassword('café-passphrase-ok', await hashPassword('café-passphrase-ok', TEST_COST)), true);
});

test('password policy follows OWASP/NIST: length not composition, no truncation, common and self-referential values refused', () => {
  assert.ok(passwordProblems('short').length);
  assert.ok(passwordProblems('a'.repeat(14)).length);
  assert.deepEqual(passwordProblems('correct horse battery staple'), []); // spaces and no symbols are fine
  assert.deepEqual(passwordProblems('p'.repeat(15) + 'q'), []);
  assert.ok(passwordProblems('x'.repeat(129)).length, 'max 128');
  assert.ok(passwordProblems('a'.repeat(15)).some((m) => /common/.test(m)));
  assert.ok(passwordProblems('Passwordpassword'.toLowerCase()).length);
  assert.ok(passwordProblems('my-name-is-syn-creator-ok', { username: 'syn-creator' }).some((m) => /username/.test(m)));
  assert.ok(passwordProblems(undefined).length);
});

// ---------- file safety, compatibility, mode separation ----------

test('mode separation: each mode refuses the other\'s workspace file, and the credential file cannot be the workspace file', async () => {
  const tmp = await tempDir();
  const authFile = path.join(tmp.dir, 'users.json');
  try {
    const demoFile = path.join(tmp.dir, 'demo.json');
    const demo = await createApp({ dataFile: demoFile, semantic: null }); // seeds a demo workspace
    await demo.close();
    await assert.rejects(createApp({ dataFile: demoFile, mode: 'authenticated', authFile, semantic: null }), /demo-mode workspace/);

    const authWs = path.join(tmp.dir, 'auth-ws.json');
    const a = await createApp({ dataFile: authWs, mode: 'authenticated', authFile, semantic: null, authOptions: { cost: TEST_COST } });
    await a.close();
    await assert.rejects(createApp({ dataFile: authWs, semantic: null }), /authenticated-mode workspace/);

    await assert.rejects(createApp({ dataFile: authFile, mode: 'authenticated', authFile, semantic: null }), /must be different files/);
    await assert.rejects(createApp({ dataFile: path.join(tmp.dir, 'x.json'), mode: 'authenticated', semantic: null }), /needs an authFile/);
    await assert.rejects(createApp({ dataFile: path.join(tmp.dir, 'y.json'), mode: 'nonsense', semantic: null }), /Unknown mode/);
    // the demo file was never modified by the refused attempt
    const after = JSON.parse(await readFile(demoFile, 'utf8'));
    assert.equal(after.meta, undefined);
    assert.equal(after.submissions.length, 3);
  } finally {
    await tmp.cleanup();
  }
});

test('a wrong-kind or corrupt credential file is refused and left byte-for-byte untouched', async () => {
  const tmp = await tempDir();
  try {
    const authFile = path.join(tmp.dir, 'users.json');
    const ws = path.join(tmp.dir, 'ws.json');
    const open = () => createApp({ dataFile: ws, mode: 'authenticated', authFile, semantic: null, authOptions: { cost: TEST_COST } });

    const notAuth = JSON.stringify({ schemaVersion: 1, submissions: [] });
    await writeFile(authFile, notAuth);
    await assert.rejects(open(), /not a BrandProof authentication file/);
    assert.equal(await readFile(authFile, 'utf8'), notAuth);

    await writeFile(authFile, '{ this is not json');
    await assert.rejects(open(), /not valid JSON/);
    assert.equal(await readFile(authFile, 'utf8'), '{ this is not json');

    await writeFile(authFile, JSON.stringify({ schemaVersion: 7, kind: 'brandproof-auth' }));
    await assert.rejects(open(), /schema version 7/);
  } finally {
    await tmp.cleanup();
  }
});

test('backups: reopening keeps at most the 3 newest timestamped copies of each file', async () => {
  const t = await startAuthApp();
  try {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1100)); // backup names have 1-second resolution
      await t.restart();
    }
    const ws = (await t.listDir()).filter((n) => n.startsWith('workspace.json.bak-'));
    const us = (await t.listDir('auth')).filter((n) => n.startsWith('users.json.bak-'));
    assert.equal(ws.length, 3);
    assert.equal(us.length, 3);
    const restored = JSON.parse(await readFile(path.join(t.dir, 'auth', us.at(-1)), 'utf8'));
    assert.equal(restored.users.length, 5); // a backup is a full, usable copy
  } finally {
    await t.close();
  }
});

test('secure cookies option (for HTTPS deployments): __Host- prefix, Secure, still HttpOnly and SameSite=Strict', async () => {
  const t = await startAuthApp({ secureCookies: true });
  try {
    const r = await t.client().login('creator');
    assert.match(r.setCookie[0], /^__Host-bp_session=/);
    assert.match(r.setCookie[0], /; Secure/);
    assert.match(r.setCookie[0], /HttpOnly/);
    assert.match(r.setCookie[0], /SameSite=Strict/);
  } finally {
    await t.close();
  }
});

test('demo mode is unchanged: no auth routes, header roles still work, meta says demo', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'a', password: 'b' } })).status, 404);
    assert.equal((await t.call('GET', '/api/admin/users')).status, 404);
    const meta = (await t.call('GET', '/api/meta')).json;
    assert.equal(meta.mode, 'demo');
    assert.equal(meta.demo, true);
    const r = await t.call('POST', '/api/submissions', { role: 'creator', body: newSubmission() });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.createdBy, { role: 'creator', name: 'Demo Creator' }); // demo actors keep their original shape
    assert.equal(r.json.workflow.eligibility.approve.selfReview, false);
  } finally {
    await t.close();
  }
});

test('semantic matching is also behind sign-in in authenticated mode', async () => {
  const t = await startAuthApp();
  try {
    const anon = t.client();
    assert.equal((await anon.call('GET', '/api/semantic/status')).status, 401);
    const c = await t.as('creator');
    const st = await c.call('GET', '/api/semantic/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.state, 'unavailable'); // switched off in this test
  } finally {
    await t.close();
  }
});
