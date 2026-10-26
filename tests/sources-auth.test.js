import test from 'node:test';
import assert from 'node:assert/strict';
import { startAuthApp, newSubmission } from './auth-helpers.js';
import { FACT_SHEET, FACT_SHEET_V2, authAs, registerSource, approveVersion, link, publishWithLink, sha } from './sources-helpers.js';

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';

test('authenticated: every source route needs a session, and writes need the CSRF token and a matching Origin', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager'] });
  try {
    const anon = t.client();
    for (const p of ['/api/sources', '/api/sources/SRC-1', '/api/sources/SRC-1/versions/1']) assert.equal((await anon.call('GET', p)).status, 401, p);
    for (const p of ['/api/sources', '/api/sources/SRC-1/versions', '/api/sources/SRC-1/versions/1/approve', '/api/sources/SRC-1/versions/1/reject', '/api/sources/SRC-1/withdraw']) {
      assert.equal((await anon.call('POST', p, { body: {}, headers: { 'x-demo-role': 'manager' } })).status, 401, p);
    }
    const creator = await t.as('creator');
    const body = { title: 'Fact sheet', text: FACT_SHEET };
    assert.equal((await creator.call('POST', '/api/sources', { body, csrf: null })).status, 403);
    assert.equal((await creator.call('POST', '/api/sources', { body, origin: 'http://evil.example' })).status, 403);
    assert.equal((await creator.call('POST', '/api/sources', { body, origin: null })).status, 403);
    assert.equal((await creator.call('POST', '/api/sources', { body })).status, 201);
  } finally {
    await t.close();
  }
});

test('authenticated: roles, forged fields and actor provenance on sources', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'manager2', 'reviewer'] });
  try {
    const [creator, manager, manager2, reviewer] = [await t.as('creator'), await t.as('manager'), await t.as('manager2'), await t.as('reviewer')];
    const [c, m, m2, r] = [authAs(creator), authAs(manager), authAs(manager2), authAs(reviewer)];
    assert.equal((await r('POST', '/api/sources', { title: 'x', text: 'some wording here' })).status, 403, 'reviewers do not register sources');
    // forged actor / status / activation fields in the body are ignored
    const reg = await c('POST', '/api/sources', {
      title: 'Fact sheet (fictional)',
      text: FACT_SHEET,
      createdBy: { id: 'U-1', name: 'Owner', role: 'manager' },
      activeVersion: 1,
      status: 'approved',
      versions: [{ status: 'approved' }],
    });
    assert.equal(reg.status, 201);
    const s = reg.json.source;
    assert.deepEqual(s.createdBy, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' });
    assert.equal(s.activeVersion, null);
    assert.equal(s.versions[0].status, 'pending');
    // role gates on decisions
    assert.equal((await approveVersion(c, s.id, 1, FACT_SHEET)).status, 403);
    assert.equal((await approveVersion(r, s.id, 1, FACT_SHEET)).status, 403);
    assert.equal((await c('POST', `/api/sources/${s.id}/versions/1/reject`, { note: 'x' })).status, 403);
    assert.equal((await r('POST', `/api/sources/${s.id}/withdraw`, { expectedActiveVersion: 1, note: 'x' })).status, 403);
    // a manager approves; the approval carries that manager's real identity
    const ok = await approveVersion(m, s.id, 1, FACT_SHEET, 'reviewed');
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.json.source.versions[0].reviewedBy, { id: t.ids.manager, name: 'Synthetic manager', role: 'manager' });
    assert.deepEqual(ok.json.source.events.at(-1).actor, { id: t.ids.manager, name: 'Synthetic manager', role: 'manager' });

    // separation: a manager cannot approve the version THEY registered; another manager can
    const own = await m('POST', '/api/sources', { title: 'Managers own', text: 'text the manager wrote themselves' });
    const self = await approveVersion(m, own.json.source.id, 1, 'text the manager wrote themselves');
    assert.equal(self.status, 403);
    assert.match(self.json.error.message, /different person/);
    assert.equal(own.json.source.activeVersion, null);
    assert.equal((await approveVersion(m2, own.json.source.id, 1, 'text the manager wrote themselves')).status, 201);
    // and the same applies to a later version a manager added to someone else's source
    const v2 = await m('POST', `/api/sources/${s.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    assert.equal(v2.status, 201);
    assert.equal((await approveVersion(m, s.id, 2, FACT_SHEET_V2)).status, 403);
    assert.equal((await approveVersion(m2, s.id, 2, FACT_SHEET_V2)).status, 201);
  } finally {
    await t.close();
  }
});

test('authenticated: source -> approval -> linked rule -> campaign -> distinct reviewer; replacing the source makes it stale', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'manager2', 'reviewer'] });
  try {
    const [creator, manager, manager2, reviewer] = [await t.as('creator'), await t.as('manager'), await t.as('manager2'), await t.as('reviewer')];
    const [c, m, m2, r] = [authAs(creator), authAs(manager), authAs(manager2), authAs(reviewer)];
    const src = await registerSource(c);
    assert.equal((await approveVersion(m, src.id, 1, FACT_SHEET)).status, 201);
    const l = link(src.id, 1, FACT_SHEET, BATTERY);
    const { res } = await publishWithLink(m2, 'FCT-001', l);
    assert.equal(res.status, 201, res.text);
    assert.equal((await m2('GET', '/api/guidelines')).json.createdBy, `Synthetic manager2 (${t.ids.manager2})`);

    const made = await c('POST', '/api/submissions', newSubmission({ text: 'A full charge lasts up to 12 hours.' }));
    assert.equal(made.json.current.findings.find((f) => f.ruleId === 'FCT-001').sourceEvidence.provenance, 'registered');
    await c('POST', `/api/submissions/${made.json.id}/request-review`, { revision: 1, expected: made.json.workflow.binding });
    const seen = (await r('GET', `/api/submissions/${made.json.id}`)).json;
    const ok = await r('POST', `/api/submissions/${made.json.id}/approve`, { revision: 1, expected: seen.workflow.binding });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.events.at(-1).actor.id, t.ids.reviewer);
    assert.equal(ok.json.events.at(-1).binding.evidenceHash, seen.workflow.binding.evidenceHash);

    // replace the governing source: the approval is stale and the reason names the evidence
    await c('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2 });
    assert.equal((await approveVersion(m, src.id, 2, FACT_SHEET_V2)).status, 201);
    const after = (await r('GET', `/api/submissions/${made.json.id}`)).json;
    assert.equal(after.workflow.status, 'approval_stale');
    assert.deepEqual(after.workflow.staleApproval.reasons, ['evidence']);

    // reviewer separation is unchanged: the person who requested review cannot approve their own submission
    const mine = await m('POST', '/api/submissions', newSubmission({ text: 'A full charge lasts up to 12 hours.' }));
    await m('POST', `/api/submissions/${mine.json.id}/request-review`, { revision: 1, expected: mine.json.workflow.binding });
    const own = (await m('GET', `/api/submissions/${mine.json.id}`)).json;
    assert.equal(own.workflow.eligibility.approve.selfReview, true);
  } finally {
    await t.close();
  }
});

test('authenticated: source data survives a restart with actor ids, and the credential file never holds source text', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager'] });
  try {
    const [creator, manager] = [await t.as('creator'), await t.as('manager')];
    const src = await registerSource(authAs(creator));
    await approveVersion(authAs(manager), src.id, 1, FACT_SHEET);
    await t.restart();
    const again = await t.as('manager');
    const d = (await again.call('GET', `/api/sources/${src.id}`)).json.source;
    assert.equal(d.activeVersion, 1);
    assert.equal(d.createdBy.id, t.ids.creator);
    assert.equal(d.versions[0].reviewedBy.id, t.ids.manager);
    assert.equal(d.versions[0].textSha256, sha(FACT_SHEET));
    assert.equal((await t.readAuthFile()).includes('Aurora'), false);
    assert.ok((await t.listDir()).some((n) => n.startsWith('workspace.json.bak-')), 'a backup of the workspace was taken on reopen');
  } finally {
    await t.close();
  }
});
