import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/store.js';
import { seedState } from '../src/seed.js';
import * as svc from '../src/service.js';
import { tempDir, cleanContent } from './helpers.js';

const NOW = '2026-10-24T10:00:00.000Z';

async function openStore() {
  const tmp = await tempDir();
  const store = await Store.open(path.join(tmp.dir, 'd.json'), () => seedState(NOW));
  return {
    store,
    cleanup: async () => {
      await store.close(); // release ownership of the file before its directory is removed
      await tmp.cleanup();
    },
  };
}

const detail = (store, id, role = 'reviewer') => svc.describeSubmission(store.state, id, role);
const binding = (store, id) => detail(store, id).workflow.binding;
const listed = (store, id) => svc.listSubmissions(store.state).find((s) => s.id === id);

async function newClean(store, content = cleanContent()) {
  const sub = await store.mutate((d) => svc.createSubmission(d, { title: 'T', ...content, role: 'creator', now: NOW }));
  return sub.id;
}
const request = (store, id, role = 'creator') =>
  store.mutate((d) => svc.requestReview(d, { id, revision: svc.describeSubmission(d, id, role).headRevision, expected: binding(store, id), role, now: NOW }));
const approve = (store, id, extra = {}) =>
  store.mutate((d) =>
    svc.decide(d, { id, decision: 'approved', revision: detail(store, id).headRevision, expected: binding(store, id), note: '', acknowledgeWarnings: false, role: 'reviewer', now: NOW, ...extra }),
  );
const revise = (store, id, patch, role = 'creator') =>
  store.mutate((d) => {
    const h = d.submissions.find((s) => s.id === id).revisions.at(-1);
    return svc.addRevision(d, { id, baseRevision: h.n, text: patch.text ?? h.text, asset: { ...h.asset, ...(patch.asset ?? {}) }, role, now: NOW });
  });

async function approvedSubmission(store) {
  const id = await newClean(store);
  await request(store, id);
  await approve(store, id);
  assert.equal(detail(store, id).workflow.status, 'approved');
  return id;
}

const rejectsWith = async (promise, status, code) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status, e.message);
    if (code) assert.equal(e.code, code);
    return true;
  });
};

test('seed data is consistent: SUB-1 draft with blockers, SUB-2 approved, SUB-3 in review', async () => {
  const { store, cleanup } = await openStore();
  try {
    const list = Object.fromEntries(svc.listSubmissions(store.state).map((s) => [s.id, s]));
    assert.equal(list['SUB-1'].status, 'draft');
    assert.ok(list['SUB-1'].summary.error >= 3);
    assert.equal(list['SUB-2'].status, 'approved');
    assert.equal(list['SUB-3'].status, 'in_review');
  } finally {
    await cleanup();
  }
});

test('stale approval: TEXT change shows re-review required in detail AND list, with the reason', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await approvedSubmission(store);
    await revise(store, id, { text: cleanContent().text + ' Quiet by design.' });
    const wf = detail(store, id).workflow;
    assert.equal(wf.status, 'approval_stale');
    assert.equal(wf.statusLabel, 'Re-review required');
    assert.deepEqual(wf.staleApproval.reasons, ['content']);
    assert.equal(wf.staleApproval.fromRevision, 1);
    assert.equal(listed(store, id).status, 'approval_stale');
    assert.deepEqual(listed(store, id).staleApproval.reasons, ['content']);
    assert.equal(wf.eligibility.requestReview.allowed, false); // role = reviewer
    assert.equal(svc.describeSubmission(store.state, id, 'creator').workflow.eligibility.requestReview.allowed, true);
  } finally {
    await cleanup();
  }
});

test('stale approval: ASSET-only change (alt text) invalidates, reason is exactly asset', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await approvedSubmission(store);
    await revise(store, id, { asset: { alt: 'A lamp glowing beside an open book on a wooden shelf' } });
    const wf = detail(store, id).workflow;
    assert.equal(wf.status, 'approval_stale');
    assert.deepEqual(wf.staleApproval.reasons, ['asset']);
    assert.equal(listed(store, id).status, 'approval_stale');
  } finally {
    await cleanup();
  }
});

test('stale approval: image file digest and colour changes also invalidate', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await approvedSubmission(store);
    await revise(store, id, { asset: { fileSha256: 'a'.repeat(64) } });
    assert.deepEqual(detail(store, id).workflow.staleApproval.reasons, ['asset']);
    const id2 = await approvedSubmission(store);
    await revise(store, id2, { asset: { colors: ['#1B9C8F'] } });
    assert.deepEqual(detail(store, id2).workflow.staleApproval.reasons, ['asset']);
  } finally {
    await cleanup();
  }
});

test('stale approval: GUIDELINE publication invalidates an otherwise unchanged approved revision', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await approvedSubmission(store);
    const g = structuredClone(svc.currentVersion(store.state).guidelines);
    g.claims.signals.push('unbeatable');
    await store.mutate((d) => svc.publishGuidelines(d, { baseVersion: 1, guidelines: g, note: 'add signal', role: 'manager', now: NOW }));
    const wf = detail(store, id).workflow;
    assert.equal(wf.status, 'approval_stale');
    assert.deepEqual(wf.staleApproval.reasons, ['guideline']);
    assert.equal(listed(store, id).status, 'approval_stale');
    assert.equal(svc.describeSubmission(store.state, id, 'reviewer').current.guidelineVersion, 2);
  } finally {
    await cleanup();
  }
});

test('re-review after a stale approval restores approved and clears the stale marker', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await approvedSubmission(store);
    await revise(store, id, { text: cleanContent().text + ' Quiet by design.' });
    await request(store, id);
    const mid = detail(store, id).workflow;
    assert.equal(mid.status, 'in_review');
    assert.deepEqual(mid.staleApproval.reasons, ['content']); // still shown as history while review is open
    await approve(store, id);
    const wf = detail(store, id).workflow;
    assert.equal(wf.status, 'approved');
    assert.equal(wf.staleApproval, null);
  } finally {
    await cleanup();
  }
});

test('a never-approved edit stays a plain draft', async () => {
  const { store, cleanup } = await openStore();
  try {
    await revise(store, 'SUB-1', { text: 'Hello.' });
    const wf = detail(store, 'SUB-1').workflow;
    assert.equal(wf.status, 'draft');
    assert.equal(wf.staleApproval, null);
  } finally {
    await cleanup();
  }
});

test('eligibility is derived on the server: blocking findings stop approval, with reasons', async () => {
  const { store, cleanup } = await openStore();
  try {
    await request(store, 'SUB-1');
    const wf = detail(store, 'SUB-1').workflow;
    assert.equal(wf.status, 'in_review');
    assert.equal(wf.eligibility.approve.allowed, false);
    assert.match(wf.eligibility.approve.reasons.join(' '), /blocking finding/);
    await rejectsWith(approve(store, 'SUB-1', { acknowledgeWarnings: true }), 403, 'not_allowed');
    assert.equal(wf.eligibility.reject.allowed, true); // rejecting is always possible in review
  } finally {
    await cleanup();
  }
});

test('role gates: creator cannot approve or reject, reviewer cannot request review or save revisions', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await newClean(store);
    await request(store, id);
    await rejectsWith(approve(store, id, { role: 'creator' }), 403, 'not_allowed');
    await rejectsWith(store.mutate((d) => svc.decide(d, { id, decision: 'rejected', revision: 1, expected: binding(store, id), note: 'no', role: 'creator', now: NOW })), 403);
    const id2 = await newClean(store);
    await rejectsWith(store.mutate((d) => svc.requestReview(d, { id: id2, revision: 1, expected: binding(store, id2), role: 'reviewer', now: NOW })), 403);
    await rejectsWith(revise(store, id2, { text: 'x y z.' }, 'reviewer'), 403, 'forbidden');
    await rejectsWith(store.mutate((d) => svc.createSubmission(d, { title: 'x', ...cleanContent(), role: 'reviewer', now: NOW })), 403);
    const noRole = svc.describeSubmission(store.state, id2, null).workflow.eligibility;
    assert.ok(Object.values(noRole).every((g) => g.allowed === false));
  } finally {
    await cleanup();
  }
});

test('warnings require explicit acknowledgement to approve', async () => {
  const { store, cleanup } = await openStore();
  try {
    const wf = detail(store, 'SUB-3').workflow;
    assert.equal(wf.eligibility.approve.allowed, true);
    assert.equal(wf.eligibility.approve.requiresAcknowledgement, true);
    await rejectsWith(approve(store, 'SUB-3'), 422, 'acknowledgement_required');
    await approve(store, 'SUB-3', { acknowledgeWarnings: true });
    assert.equal(detail(store, 'SUB-3').workflow.status, 'approved');
  } finally {
    await cleanup();
  }
});

test('decisions need a requested review; approved items cannot be re-requested', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await newClean(store);
    await rejectsWith(approve(store, id), 403, 'not_allowed');
    await request(store, id);
    await approve(store, id);
    await rejectsWith(request(store, id), 403, 'not_allowed');
  } finally {
    await cleanup();
  }
});

test('regression (review #3): guideline published between rendering and approving -> 409 stale_view, nothing recorded', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await newClean(store);
    await request(store, id);
    const seen = binding(store, id); // what the reviewer's screen showed
    const before = detail(store, id).events.length;

    const g = structuredClone(svc.currentVersion(store.state).guidelines);
    g.terms[0].reason = 'The product name is always two capitalised words.';
    await store.mutate((d) => svc.publishGuidelines(d, { baseVersion: 1, guidelines: g, note: 'reword', role: 'manager', now: NOW }));

    await assert.rejects(
      store.mutate((d) => svc.decide(d, { id, decision: 'approved', revision: 1, expected: seen, note: '', acknowledgeWarnings: false, role: 'reviewer', now: NOW })),
      (e) => {
        assert.equal(e.status, 409);
        assert.equal(e.code, 'stale_view');
        assert.deepEqual(e.details.changed, ['guideline']);
        assert.equal(e.details.currentGuidelineVersion, 2);
        return true;
      },
    );
    await rejectsWith(
      store.mutate((d) => svc.decide(d, { id, decision: 'rejected', revision: 1, expected: seen, note: 'x', role: 'reviewer', now: NOW })),
      409,
      'stale_view',
    );
    assert.equal(detail(store, id).events.length, before);

    // after reloading (new binding) the approval goes through and is bound to guideline version 2
    await approve(store, id);
    assert.equal(detail(store, id).events.at(-1).binding.guidelineVersion, 2);
  } finally {
    await cleanup();
  }
});

test('expected binding: request-review also rejects a stale view; wrong content/asset hashes are caught', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await newClean(store);
    const seen = binding(store, id);
    const g = structuredClone(svc.currentVersion(store.state).guidelines);
    g.claims.signals.push('unbeatable');
    await store.mutate((d) => svc.publishGuidelines(d, { baseVersion: 1, guidelines: g, note: '', role: 'manager', now: NOW }));
    await rejectsWith(store.mutate((d) => svc.requestReview(d, { id, revision: 1, expected: seen, role: 'creator', now: NOW })), 409, 'stale_view');

    const fresh = binding(store, id);
    await assert.rejects(
      store.mutate((d) => svc.requestReview(d, { id, revision: 1, expected: { ...fresh, contentHash: 'f'.repeat(64), assetHash: '0'.repeat(64) }, role: 'creator', now: NOW })),
      (e) => {
        assert.deepEqual(e.details.changed, ['content', 'asset']);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test('revision conflicts: stale baseRevision and stale decision revision are rejected with 409; identical save is a 422', async () => {
  const { store, cleanup } = await openStore();
  try {
    const id = await newClean(store);
    await revise(store, id, { text: 'First change here.' });
    await rejectsWith(
      store.mutate((d) => svc.addRevision(d, { id, baseRevision: 1, text: 'Other change.', asset: cleanContent().asset, role: 'creator', now: NOW })),
      409,
      'revision_conflict',
    );
    await rejectsWith(
      store.mutate((d) => svc.requestReview(d, { id, revision: 1, expected: binding(store, id), role: 'creator', now: NOW })),
      409,
      'revision_conflict',
    );
    await rejectsWith(revise(store, id, {}), 422, 'no_change');
  } finally {
    await cleanup();
  }
});

test('guidelines: only managers publish, base version conflicts and no-op publishes are rejected, ids are never reused', async () => {
  const { store, cleanup } = await openStore();
  try {
    const cur = () => structuredClone(svc.currentVersion(store.state).guidelines);
    const publish = (g, over = {}) =>
      store.mutate((d) => svc.publishGuidelines(d, { baseVersion: svc.currentVersion(d).version, guidelines: g, note: '', role: 'manager', now: NOW, ...over }));

    await rejectsWith(publish(cur(), { role: 'creator' }), 403, 'forbidden');
    await rejectsWith(publish(cur()), 422, 'no_change');
    const g = cur();
    g.claims.signals.push('x-claim');
    await rejectsWith(publish(g, { baseVersion: 7 }), 409, 'version_conflict');

    const last = g.terms.at(-1).id;
    g.terms.pop();
    const v2 = await publish(g);
    assert.equal(v2.version, 2);
    const g3 = cur();
    const t = structuredClone(g3.terms[0]);
    t.id = null;
    t.avoid = [{ text: 'fresh phrase', replacement: null }];
    g3.terms.push(t);
    const v3 = await publish(g3);
    const newId = v3.guidelines.terms.at(-1).id;
    assert.notEqual(newId, last, 'a deleted id must not be reused');
    assert.equal(svc.currentVersion(store.state).version, 3);
    const summary = svc.versionSummary(v3, store.state.guidelineVersions[1]);
    assert.deepEqual(summary.changes.terms.added, [newId]);
  } finally {
    await cleanup();
  }
});

test('comments attach to existing revisions only and keep demo role labels', async () => {
  const { store, cleanup } = await openStore();
  try {
    const c = await store.mutate((d) => svc.addComment(d, { id: 'SUB-1', revision: 1, text: 'Looks off.', ruleId: 'TRM-001', role: 'reviewer', now: NOW }));
    assert.deepEqual(c.author, { role: 'reviewer', name: 'Demo Reviewer' });
    await rejectsWith(store.mutate((d) => svc.addComment(d, { id: 'SUB-1', revision: 9, text: 'x', ruleId: null, role: 'reviewer', now: NOW })), 422);
    await rejectsWith(store.mutate((d) => svc.addComment(d, { id: 'SUB-99', revision: 1, text: 'x', ruleId: null, role: 'reviewer', now: NOW })), 404);
  } finally {
    await cleanup();
  }
});

test('compare: word diff, asset field changes and finding resolution between revisions', async () => {
  const { store, cleanup } = await openStore();
  try {
    const cmp = svc.compareRevisions(store.state, 'SUB-2', 1, 2);
    assert.ok(cmp.text.some((o) => o.type === 'add'));
    assert.ok(cmp.text.some((o) => o.type === 'del'));
    assert.ok(cmp.assetFields.includes('alt'));
    assert.ok(cmp.findings.resolved.length >= 3);
    assert.equal(cmp.findings.introduced.length, 0);
    const same = svc.compareRevisions(store.state, 'SUB-2', 2, 2);
    assert.deepEqual(same.text.map((o) => o.type), ['equal']);
    assert.throws(() => svc.compareRevisions(store.state, 'SUB-2', 1, 9), (e) => e.status === 404);
  } finally {
    await cleanup();
  }
});

test('insights count recurring rules and resolved ones from saved revisions', async () => {
  const { store, cleanup } = await openStore();
  try {
    const i = svc.insights(store.state);
    assert.equal(i.submissions, 3);
    assert.equal(i.revisions, 4);
    assert.ok(i.recurring.length > 0);
    const naming = i.recurring.find((r) => r.ruleKind === 'terminology');
    assert.ok(naming.occurrences >= 1);
    assert.equal(i.statuses.approved, 1);
    assert.ok(i.recurring.every((r) => r.status !== 'supported'));
  } finally {
    await cleanup();
  }
});
