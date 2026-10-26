import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { classifyPassage, lineChanges } from '../src/impact.js';
import { startApp, cleanContent } from './helpers.js';
import { startAuthApp } from './auth-helpers.js';
import { FACT_SHEET, FACT_SHEET_V2, FACT_SHEET_CHANGED, demoAs, authAs, registerSource, approveVersion, link, publishWithLink, sha } from './sources-helpers.js';

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';
const batteryCopy = (title = 'Battery claim') => ({ title, text: 'A full charge lasts up to 12 hours.', asset: cleanContent().asset });
const plainCopy = (title = 'Plain copy') => ({ title, text: 'The Aurora Lamp is a reading light for your desk.', asset: cleanContent().asset });

async function world() {
  const t = await startApp();
  return { t, creator: demoAs(t, 'creator'), manager: demoAs(t, 'manager'), reviewer: demoAs(t, 'reviewer') };
}

/** SRC-1 version 1 approved and linked from FCT-001 (battery); guidelines published (v2). */
async function linkedBattery(w) {
  const src = await registerSource(w.creator);
  assert.equal((await approveVersion(w.manager, src.id, 1, FACT_SHEET)).status, 201);
  const l = link(src.id, 1, FACT_SHEET, BATTERY);
  const { res } = await publishWithLink(w.manager, 'FCT-001', l);
  assert.equal(res.status, 201, res.text);
  return { src, l };
}

async function addVersion(w, id, baseVersion, text) {
  const r = await w.creator('POST', `/api/sources/${id}/versions`, { baseVersion, text, origin: 'paste' });
  assert.equal(r.status, 201, r.text);
  return r.json.source.latestVersion;
}

const impact = (w, id, n) => w.manager('GET', `/api/sources/${id}/impact?action=activate&version=${n}`);
const withdrawImpact = (w, id) => w.manager('GET', `/api/sources/${id}/impact?action=withdraw`);
const status = async (w, id) => (await w.reviewer('GET', `/api/submissions/${id}`)).json.workflow.status;

async function submit(w, body) {
  const made = await w.creator('POST', '/api/submissions', body);
  assert.equal(made.status, 201, made.text);
  return made.json;
}

async function approved(w, body) {
  const made = await submit(w, body);
  const rr = await w.creator('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding });
  assert.equal(rr.status, 201, rr.text);
  const seen = (await w.reviewer('GET', `/api/submissions/${made.id}`)).json;
  const ok = await w.reviewer('POST', `/api/submissions/${made.id}/approve`, { revision: 1, expected: seen.workflow.binding });
  assert.equal(ok.status, 201, ok.text);
  return made.id;
}

async function inReview(w, body) {
  const made = await submit(w, body);
  const rr = await w.creator('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding });
  assert.equal(rr.status, 201, rr.text);
  return made.id;
}

// ---------- exact continuity ----------

test('classifyPassage: unchanged, moved, ambiguous, absent and not comparable are decided on exact text only', () => {
  const q = 'up to 12 hours at medium brightness';
  const text = `Intro.\n\nBattery. A full charge lasts ${q}.`;
  const start = text.indexOf(q);
  assert.deepEqual(classifyPassage(q, start, start + q.length, text), { kind: 'unchanged', occurrences: 1, newStart: start, newEnd: start + q.length, repeated: false });
  const moved = classifyPassage(q, start, start + q.length, `A new heading line.\n${text}`);
  assert.equal(moved.kind, 'moved');
  assert.equal(moved.newStart, start + 'A new heading line.\n'.length);
  const twice = `${q} and again ${q}`;
  const amb = classifyPassage(q, 500, 500 + q.length, twice);
  assert.equal(amb.kind, 'ambiguous');
  assert.equal(amb.occurrences, 2);
  const same = classifyPassage(q, 0, q.length, twice);
  assert.equal(same.kind, 'unchanged');
  assert.equal(same.repeated, true, 'same offsets, but the words also occur elsewhere: flagged, not hidden');
  assert.equal(classifyPassage(q, 0, q.length, text.replace('12', '8')).kind, 'absent');
  assert.equal(classifyPassage('  ', 0, 2, 'any text   here').kind, 'not_comparable');
  assert.equal(classifyPassage('ab', 0, 2, 'ab ab ab').kind, 'not_comparable');
  assert.equal(classifyPassage('', 0, 0, 'text').kind, 'not_comparable');
  assert.equal(classifyPassage(undefined, 0, 0, 'text').kind, 'not_comparable');
  // overlapping repeats are still counted
  assert.equal(classifyPassage('aaa', 100, 103, 'aaaa').kind, 'ambiguous');
});

test('lineChanges lists removed and added lines with offsets that cut exactly those lines', () => {
  const a = 'Same line.\nBattery: up to 12 hours.\nTail line.';
  const b = 'Same line.\nBattery: up to 8 hours.\nTail line.\nNew care line.';
  const c = lineChanges(a, b);
  assert.equal(c.removedCount, 1);
  assert.equal(c.addedCount, 2);
  assert.equal(a.slice(c.removed[0].start, c.removed[0].end), 'Battery: up to 12 hours.');
  assert.deepEqual(c.added.map((l) => b.slice(l.start, l.end)), ['Battery: up to 8 hours.', 'New care line.']);
  assert.deepEqual(lineChanges(a, a), { removedCount: 0, addedCount: 0, removed: [], added: [], truncated: false });
});

test('preview of a pending version: dependencies with exact old and proposed passages for each continuity class', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const moved = `A new first line.\n\n${FACT_SHEET}`;
    const repeated = `${FACT_SHEET}\n\nBattery repeat. ${BATTERY}`;
    const ambiguous = `Battery one. ${BATTERY}\n\nBattery two. ${BATTERY}\n\nEnvironment. Indoor use only.`;
    const versions = [FACT_SHEET_V2, moved, repeated, ambiguous, FACT_SHEET_CHANGED];
    let base = 1;
    const numbers = [];
    for (const text of versions) numbers.push((base = await addVersion(w, src.id, base, text)));
    const kinds = [];
    for (const n of numbers) {
      const r = await impact(w, src.id, n);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.dependencies.length, 1);
      const d = r.json.dependencies[0];
      assert.equal(d.entryId, 'FCT-001');
      assert.equal(d.quote, BATTERY);
      assert.equal(d.stateNow, 'active');
      assert.equal(d.stateAfter, 'superseded', 'an unchanged quote still needs a new link under current policy');
      assert.ok(d.nextStep.length > 40);
      kinds.push(d.continuity.kind);
      if (d.proposedPassage) assert.equal(d.proposedPassage.text, BATTERY);
      assert.equal(r.json.proposed.brokenLinks, 1, 'every replacement leaves the old link needing a relink');
    }
    assert.deepEqual(kinds, ['unchanged', 'moved', 'unchanged', 'ambiguous', 'absent']);
    const rep = (await impact(w, src.id, numbers[2])).json.dependencies[0].continuity;
    assert.equal(rep.repeated, true);
    assert.equal(rep.occurrences, 2);
    const amb = (await impact(w, src.id, numbers[3])).json.dependencies[0];
    assert.equal(amb.continuity.occurrences, 2);
    assert.equal(amb.proposedPassage, null, 'no position is chosen when the words occur more than once');
    const absent = (await impact(w, src.id, numbers[4])).json;
    const change = absent.textChange;
    assert.equal(change.removedCount, 1);
    assert.match(change.removed[0].text, /up to 12 hours/);
    assert.match(change.added[0].text, /up to 14 hours/);
    assert.equal(FACT_SHEET.slice(change.removed[0].start, change.removed[0].end), change.removed[0].text);
    assert.equal(FACT_SHEET_CHANGED.slice(change.added[0].start, change.added[0].end), change.added[0].text);
  } finally {
    await w.t.close();
  }
});

// ---------- read-only ----------

test('previews write nothing: file bytes, committed state, versions, events and the source are unchanged', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    await approved(w, batteryCopy());
    const n = await addVersion(w, src.id, 1, FACT_SHEET_CHANGED);
    const file = path.join(w.t.dir, 'data.json');
    const bytes = await readFile(file);
    const mtime = (await stat(file)).mtimeMs;
    const snapshot = JSON.stringify(w.t.app.store.state);
    const versions = w.t.app.store.state.guidelineVersions.length;
    for (let i = 0; i < 4; i++) {
      assert.equal((await impact(w, src.id, n)).status, 200);
      assert.equal((await withdrawImpact(w, src.id)).status, 200);
    }
    assert.equal(JSON.stringify(w.t.app.store.state), snapshot);
    assert.equal(w.t.app.store.state.guidelineVersions.length, versions, 'no proposed guideline version is created');
    assert.ok(bytes.equals(await readFile(file)));
    assert.equal((await stat(file)).mtimeMs, mtime);
    const detail = (await w.manager('GET', `/api/sources/${src.id}`)).json.source;
    assert.equal(detail.activeVersion, 1);
    assert.equal(detail.events.length, 3, 'registered, version added, approved: nothing from the previews');
  } finally {
    await w.t.close();
  }
});

// ---------- campaign categories, and the prediction equals what really happens ----------

test('campaign categories: references, whole-binding workflow counts, and the predicted statuses are what actually happens', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const citing = await approved(w, batteryCopy('Cites battery fact'));
    const notCiting = await approved(w, plainCopy('Cites nothing from the source'));
    const reviewing = await inReview(w, batteryCopy('In review, cites battery fact'));
    const draftCiting = (await submit(w, batteryCopy('Draft cites battery fact'))).id;
    const draftPlain = (await submit(w, plainCopy('Draft with no reference'))).id;
    const revised = await approved(w, batteryCopy('Approved then revised'));
    const rv = await w.creator('POST', `/api/submissions/${revised}/revisions`, { baseRevision: 1, text: 'A full charge lasts up to 12 hours, always on.', asset: cleanContent().asset });
    assert.equal(rv.status, 201, rv.text);
    assert.equal(await status(w, revised), 'approval_stale');

    const n = await addVersion(w, src.id, 1, FACT_SHEET_V2);
    const pre = (await impact(w, src.id, n)).json;
    const c = pre.campaigns.counts;
    assert.equal(pre.proposed.evidenceChanges, true);
    assert.equal(c.total, 3 + 6, 'three seeded campaigns plus six created here');
    const listBefore = Object.fromEntries((await w.reviewer('GET', '/api/submissions')).json.submissions.map((x) => [x.id, x.status]));
    const byId = Object.fromEntries(pre.campaigns.workflow.map((x) => [x.submissionId, x]));
    assert.equal(byId[citing].effect, 'approved_becomes_stale');
    assert.equal(byId[notCiting].effect, 'approved_becomes_stale', 'whole-binding: an approved campaign with no citing finding is still affected');
    assert.equal(byId[notCiting].referencesBySource, 0);
    assert.ok(byId[citing].referencesBySource >= 1);
    assert.deepEqual(byId[citing].reasonsAfter, ['evidence']);
    assert.equal(byId[revised].effect, 'already_stale');
    assert.equal(byId[reviewing].effect, 'review_view_changes');
    assert.equal(byId[draftCiting].effect, 'draft_with_references');
    assert.equal(byId[draftPlain], undefined, 'a draft with no reference is only counted as unaffected');
    const refIds = pre.campaigns.references.map((r) => r.submissionId).sort();
    assert.ok(refIds.includes(citing) && refIds.includes(reviewing) && refIds.includes(draftCiting));
    assert.ok(!refIds.includes(notCiting) && !refIds.includes(draftPlain));
    const ref = pre.campaigns.references.find((r) => r.submissionId === citing);
    assert.equal(ref.findings[0].ruleId, 'FCT-001');
    assert.equal(ref.findings[0].status, 'supported');

    // now do it for real, with the preview's digest
    const before = Object.fromEntries(await Promise.all(pre.campaigns.workflow.map(async (x) => [x.submissionId, await status(w, x.submissionId)])));
    const countOf = (list, pred) => Object.entries(list).filter(([id, st]) => pred(id, st)).length;
    for (const x of pre.campaigns.workflow) assert.equal(before[x.submissionId], x.before, x.submissionId);
    const done = await w.manager('POST', `/api/sources/${src.id}/versions/${n}/approve`, { expectedSha256: sha(FACT_SHEET_V2), previewDigest: pre.digest });
    assert.equal(done.status, 201, done.text);
    for (const x of pre.campaigns.workflow) assert.equal(await status(w, x.submissionId), x.after, `${x.submissionId} ${x.effect}`);
    assert.equal(await status(w, draftPlain), 'draft');
    // the preview's counts are what really happened, read independently from the submission list
    const listAfter = Object.fromEntries((await w.reviewer('GET', '/api/submissions')).json.submissions.map((x) => [x.id, x.status]));
    assert.equal(c.approvedNewlyStale, countOf(listBefore, (id, st) => st === 'approved' && listAfter[id] === 'approval_stale'));
    assert.equal(c.alreadyStale, countOf(listBefore, (id, st) => st === 'approval_stale'));
    assert.equal(c.inReviewViewChanges, countOf(listBefore, (id, st) => st === 'in_review'));
    assert.equal(c.approvedNewlyStale + c.alreadyStale + c.inReviewViewChanges + c.draftsWithReferences + c.unaffected, c.total, 'every campaign is in exactly one bucket');
    assert.ok(c.approvedNewlyStale >= 2 && c.alreadyStale >= 1 && c.inReviewViewChanges >= 1 && c.draftsWithReferences >= 1);
    assert.equal(countOf(listBefore, (id, st) => st === 'approved'), c.approvedNewlyStale, 'every approved campaign is affected, cited or not');
    // the preview said reviews would be blocked until a repair: confirm the server really blocks
    const seen = (await w.reviewer('GET', `/api/submissions/${reviewing}`)).json;
    assert.equal(seen.workflow.eligibility.approve.allowed, false);
    assert.ok(seen.workflow.eligibility.approve.evidenceBroken >= 1);
  } finally {
    await w.t.close();
  }
});

test('a source that no rule cites changes no approval; zero dependencies is reported as such, with legacy coverage separate', async () => {
  const w = await world();
  try {
    const src = await registerSource(w.creator, { title: 'Unlinked note (fictional)', text: 'Care. Wipe with a dry cloth.' });
    assert.equal((await approveVersion(w.manager, src.id, 1, 'Care. Wipe with a dry cloth.')).status, 201);
    const id = await approved(w, batteryCopy());
    const n = await addVersion(w, src.id, 1, 'Care. Wipe with a dry cloth. Do not soak.');
    const r = (await impact(w, src.id, n)).json;
    assert.equal(r.dependencies.length, 0);
    assert.equal(r.proposed.evidenceChanges, false);
    assert.equal(r.campaigns.counts.approvedNewlyStale, 0);
    assert.equal(r.coverage.citingThisSource, 0);
    assert.ok(r.coverage.legacy > 0, 'typed (legacy) rules are counted separately');
    assert.ok(r.notes.some((x) => /Legacy rules/.test(x)));
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/${n}/approve`, { expectedSha256: sha('Care. Wipe with a dry cloth. Do not soak.'), previewDigest: r.digest })).status, 201);
    assert.equal(await status(w, id), 'approved', 'as predicted: nothing changed for the approved campaign');
  } finally {
    await w.t.close();
  }
});

test('withdrawal preview: dependencies leave force, campaigns are counted, and the real withdrawal matches', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const id = await approved(w, batteryCopy());
    const r = (await withdrawImpact(w, src.id)).json;
    assert.equal(r.action, 'withdraw');
    assert.equal(r.direction, 'withdraw');
    assert.equal(r.dependencies[0].continuity.kind, 'withdrawn');
    assert.equal(r.dependencies[0].stateAfter, 'withdrawn');
    assert.equal(r.textChange, null);
    assert.equal(r.proposed.activeVersion, null);
    assert.equal(r.campaigns.counts.approvedNewlyStale >= 1, true);
    const done = await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: 1, note: 'obsolete', previewDigest: r.digest });
    assert.equal(done.status, 201, done.text);
    assert.equal(await status(w, id), 'approval_stale');
    assert.equal((await withdrawImpact(w, src.id)).status, 409, 'nothing left to withdraw');
  } finally {
    await w.t.close();
  }
});

test('preview validates the request: action, candidate state, existing source, non-monotonic activation', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const v2 = await addVersion(w, src.id, 1, FACT_SHEET_V2);
    const v3 = await addVersion(w, src.id, v2, `${FACT_SHEET_V2}\n\nWarranty note.`);
    const get = (q, id = src.id) => w.manager('GET', `/api/sources/${id}/impact${q}`);
    assert.equal((await get('?action=delete')).status, 422);
    assert.equal((await get('')).status, 422);
    assert.equal((await get('?action=activate')).status, 422);
    assert.equal((await get('?action=activate&version=abc')).status, 422);
    assert.equal((await get('?action=activate&version=2.5')).status, 422);
    assert.equal((await get('?action=activate&version=99')).status, 404);
    assert.equal((await get('?action=activate&version=1')).status, 409, 'version 1 is already in force, not pending');
    assert.equal((await get('?action=activate&version=2', 'SRC-99')).status, 404);
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/${v3}/reject`, { note: 'no' })).status, 201);
    assert.equal((await get(`?action=activate&version=${v3}`)).status, 409, 'a rejected version cannot be activated');
    // approve v2 for real, add v4, and preview v1-style rollbacks: activating an OLDER pending version is described as such
    const v4 = await addVersion(w, src.id, v3, `${FACT_SHEET_V2}\n\nAnother note.`);
    assert.equal((await impact(w, src.id, v4)).json.direction, 'replaces_older');
    const old = await registerSource(w.creator, { title: 'Order test', text: 'Order one text here.' });
    assert.equal((await approveVersion(w.manager, old.id, 1, 'Order one text here.')).status, 201);
    const o2 = await addVersion(w, old.id, 1, 'Order two text here.');
    const o3 = await addVersion(w, old.id, o2, 'Order three text here.');
    assert.equal((await w.manager('POST', `/api/sources/${old.id}/versions/${o3}/approve`, { expectedSha256: sha('Order three text here.') })).status, 201);
    assert.equal((await impact(w, old.id, o2)).json.direction, 'replaces_newer', 'versions need not activate in order');
  } finally {
    await w.t.close();
  }
});

// ---------- stale previews and races ----------

test('stale preview: an approve or withdraw carrying an old digest is refused with 409 and records nothing', async () => {
  const changes = {
    'another version activated first': async (w, { src }) => {
      const n = await addVersion(w, src.id, 2, `${FACT_SHEET_V2}\n\nAn unrelated care note.`);
      assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/${n}/approve`, { expectedSha256: sha(`${FACT_SHEET_V2}\n\nAn unrelated care note.`) })).status, 201);
    },
    'guidelines published': async (w) => {
      const g = (await w.manager('GET', '/api/guidelines')).json;
      const edited = structuredClone(g.guidelines);
      edited.claims.signals.push('unbeatable');
      assert.equal((await w.manager('PUT', '/api/guidelines', { baseVersion: g.version, note: 'x', guidelines: edited })).status, 201);
    },
    'a campaign was revised': async (w) => {
      const id = await approved(w, batteryCopy('Another campaign'));
      assert.equal((await w.creator('POST', `/api/submissions/${id}/revisions`, { baseRevision: 1, text: 'A full charge lasts up to 12 hours, honestly.', asset: cleanContent().asset })).status, 201);
    },
    'a campaign was sent for review': async (w) => {
      await inReview(w, plainCopy('Late review request'));
    },
    'a new campaign was created': async (w) => {
      await submit(w, plainCopy('Late campaign'));
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    for (const action of ['activate', 'withdraw']) {
      const w = await world();
      try {
        const ctx = await linkedBattery(w);
        const { src } = ctx;
        const v2 = await addVersion(w, src.id, 1, FACT_SHEET_V2);
        const pre = (action === 'activate' ? await impact(w, src.id, v2) : await withdrawImpact(w, src.id)).json;
        await change(w, ctx);
        const eventsBefore = (await w.manager('GET', `/api/sources/${src.id}`)).json.source.events.length;
        const activeBefore = (await w.manager('GET', `/api/sources/${src.id}`)).json.source.activeVersion;
        const write = action === 'activate' ? w.manager('POST', `/api/sources/${src.id}/versions/${v2}/approve`, { expectedSha256: sha(FACT_SHEET_V2), previewDigest: pre.digest }) : w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: activeBefore, note: 'x', previewDigest: pre.digest });
        const r = await write;
        assert.equal(r.status, 409, `${name} / ${action}: ${r.text}`);
        assert.equal(r.json.error.code, 'stale_preview', `${name} / ${action}`);
        const after = (await w.manager('GET', `/api/sources/${src.id}`)).json.source;
        assert.equal(after.events.length, eventsBefore, 'nothing recorded');
        assert.equal(after.activeVersion, activeBefore);
        // a fresh preview works, and acting on it succeeds
        const fresh = (action === 'activate' ? await impact(w, src.id, v2) : await withdrawImpact(w, src.id)).json;
        assert.notEqual(fresh.digest, pre.digest);
        const again = action === 'activate' ? await w.manager('POST', `/api/sources/${src.id}/versions/${v2}/approve`, { expectedSha256: sha(FACT_SHEET_V2), previewDigest: fresh.digest }) : await w.manager('POST', `/api/sources/${src.id}/withdraw`, { expectedActiveVersion: activeBefore, note: 'x', previewDigest: fresh.digest });
        assert.equal(again.status, 201, `${name} / ${action}: ${again.text}`);
      } finally {
        await w.t.close();
      }
    }
  }
});

test('previewDigest is optional and validated; a digest for a different change is refused', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const v2 = await addVersion(w, src.id, 1, FACT_SHEET_V2);
    const approve = (body) => w.manager('POST', `/api/sources/${src.id}/versions/${v2}/approve`, { expectedSha256: sha(FACT_SHEET_V2), ...body });
    assert.equal((await approve({ previewDigest: 'not-a-digest' })).status, 422);
    assert.equal((await approve({ previewDigest: 'a'.repeat(64) })).status, 409);
    const wd = (await withdrawImpact(w, src.id)).json.digest;
    assert.equal((await approve({ previewDigest: wd })).status, 409, 'a withdrawal preview cannot authorise an activation');
    assert.equal((await w.manager('GET', `/api/sources/${src.id}`)).json.source.activeVersion, 1);
    assert.equal((await approve({})).status, 201, 'the field is optional: existing callers are unchanged');
  } finally {
    await w.t.close();
  }
});

test('race: two managers approve different pending versions from the same preview baseline; exactly one wins and the loser is told it is stale', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const t2 = `${FACT_SHEET_V2}\n\nNote two.`;
    const t3 = `${FACT_SHEET_V2}\n\nNote three.`;
    const v2 = await addVersion(w, src.id, 1, t2);
    const v3 = await addVersion(w, src.id, v2, t3);
    const p2 = (await impact(w, src.id, v2)).json;
    const p3 = (await impact(w, src.id, v3)).json;
    const results = await Promise.all([
      w.manager('POST', `/api/sources/${src.id}/versions/${v2}/approve`, { expectedSha256: sha(t2), previewDigest: p2.digest }),
      w.manager('POST', `/api/sources/${src.id}/versions/${v3}/approve`, { expectedSha256: sha(t3), previewDigest: p3.digest }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const loser = results.find((r) => r.status === 409);
    assert.equal(loser.json.error.code, 'stale_preview');
    const s = (await w.manager('GET', `/api/sources/${src.id}`)).json.source;
    assert.equal(s.events.filter((e) => e.type === 'approved').length, 2, 'v1 earlier, plus exactly one of v2/v3');
  } finally {
    await w.t.close();
  }
});

test('race: previews taken while a write is in flight each describe one consistent state', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    await approved(w, batteryCopy());
    const text = `${FACT_SHEET_V2}\n\nConcurrent note.`;
    const v2 = await addVersion(w, src.id, 1, text);
    const pre = (await impact(w, src.id, v2)).json;
    const calls = [w.manager('POST', `/api/sources/${src.id}/versions/${v2}/approve`, { expectedSha256: sha(text), previewDigest: pre.digest })];
    for (let i = 0; i < 12; i++) calls.push(withdrawImpact(w, src.id));
    const out = await Promise.all(calls);
    assert.equal(out[0].status, 201);
    for (const r of out.slice(1)) {
      assert.equal(r.status, 200);
      const p = r.json;
      // either wholly before (v1 active) or wholly after (v2 active): never a mixture
      assert.ok([1, 2].includes(p.baseline.activeVersion));
      assert.equal(p.dependencies[0].stateNow, p.baseline.activeVersion === 1 ? 'active' : 'superseded');
      assert.equal(p.campaigns.counts.approvedNewlyStale >= 0, true);
    }
  } finally {
    await w.t.close();
  }
});

// ---------- permissions ----------

test('demo mode: only the Manager role can read an impact preview', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const v2 = await addVersion(w, src.id, 1, FACT_SHEET_V2);
    const path = `/api/sources/${src.id}/impact?action=activate&version=${v2}`;
    assert.equal((await w.creator('GET', path)).status, 403);
    assert.equal((await w.reviewer('GET', path)).status, 403);
    assert.equal((await w.t.call('GET', path)).status, 403, 'no role header');
    assert.equal((await w.manager('GET', path)).status, 200);
  } finally {
    await w.t.close();
  }
});

test('authenticated mode: sessions are required, only a manager reads the preview, and the approval gate names the real person', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'manager2', 'reviewer'] });
  try {
    const [creator, manager, manager2, reviewer] = [await t.as('creator'), await t.as('manager'), await t.as('manager2'), await t.as('reviewer')];
    const [c, m, m2] = [authAs(creator), authAs(manager), authAs(manager2)];
    const src = await registerSource(c);
    assert.equal((await approveVersion(m2, src.id, 1, FACT_SHEET)).status, 201);
    const added = await m('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: FACT_SHEET_V2, origin: 'paste' });
    assert.equal(added.status, 201);
    const url = `/api/sources/${src.id}/impact?action=activate&version=2`;
    assert.equal((await t.client().call('GET', url)).status, 401);
    assert.equal((await t.client().call('GET', url, { headers: { 'x-demo-role': 'manager' } })).status, 401, 'the demo header means nothing here');
    assert.equal((await creator.call('GET', url)).status, 403);
    assert.equal((await reviewer.call('GET', url)).status, 403);
    assert.equal((await creator.call('GET', url, { headers: { 'x-demo-role': 'manager' } })).status, 403, 'a forged role header is ignored');
    // the registrant (a manager) sees that they cannot approve their own version; another manager can
    const own = await m('GET', url);
    assert.equal(own.status, 200);
    assert.equal(own.json.approvalGate.allowed, false);
    assert.match(own.json.approvalGate.reasons[0], /different person/);
    const other = await m2('GET', url);
    assert.equal(other.json.approvalGate.allowed, true);
    assert.equal(other.json.digest, own.json.digest, 'the digest describes the change, not the viewer');
    // the gate is real, not just displayed
    const refused = await m('POST', `/api/sources/${src.id}/versions/2/approve`, { expectedSha256: sha(FACT_SHEET_V2), previewDigest: own.json.digest });
    assert.equal(refused.status, 403);
    const ok = await m2('POST', `/api/sources/${src.id}/versions/2/approve`, { expectedSha256: sha(FACT_SHEET_V2), previewDigest: own.json.digest });
    assert.equal(ok.status, 201, ok.text);
    // CSRF and Origin still guard the write that carries a digest
    const v3 = await m('POST', `/api/sources/${src.id}/versions`, { baseVersion: 2, text: `${FACT_SHEET_V2}\n\nMore.`, origin: 'paste' });
    assert.equal(v3.status, 201);
    const p3 = (await m2('GET', `/api/sources/${src.id}/impact?action=activate&version=3`)).json;
    const body = { expectedSha256: sha(`${FACT_SHEET_V2}\n\nMore.`), previewDigest: p3.digest };
    assert.equal((await manager2.call('POST', `/api/sources/${src.id}/versions/3/approve`, { body, csrf: null })).status, 403);
    assert.equal((await manager2.call('POST', `/api/sources/${src.id}/versions/3/approve`, { body, origin: 'http://evil.example' })).status, 403);
    assert.equal((await manager2.call('POST', `/api/sources/${src.id}/versions/3/approve`, { body })).status, 201);
  } finally {
    await t.close();
  }
});

test('the whole flow: preview, activate, accurate stale consequences, repair, a fresh review by someone else', async () => {
  const w = await world();
  try {
    const { src } = await linkedBattery(w);
    const id = await approved(w, batteryCopy());
    const changed = FACT_SHEET.replace('up to 12 hours', 'up to 8 hours');
    const v2 = await addVersion(w, src.id, 1, changed);
    const pre = (await impact(w, src.id, v2)).json;
    assert.equal(pre.dependencies[0].continuity.kind, 'absent');
    assert.equal((await w.manager('POST', `/api/sources/${src.id}/versions/${v2}/approve`, { expectedSha256: sha(changed), previewDigest: pre.digest })).status, 201);
    assert.equal(await status(w, id), 'approval_stale');
    // approval is blocked until a manager repairs; the repair is a normal publish, never automatic
    const blocked = (await w.reviewer('GET', `/api/submissions/${id}`)).json;
    assert.equal(blocked.workflow.eligibility.approve.allowed, false);
    const newQuote = 'A full charge lasts up to 8 hours at medium brightness.';
    const { res } = await publishWithLink(w.manager, 'FCT-001', link(src.id, v2, changed, newQuote), 'relink after source change');
    assert.equal(res.status, 201, res.text);
    const rr = await w.creator('POST', `/api/submissions/${id}/request-review`, { revision: 1, expected: (await w.reviewer('GET', `/api/submissions/${id}`)).json.workflow.binding });
    assert.equal(rr.status, 201, rr.text);
    const seen = (await w.reviewer('GET', `/api/submissions/${id}`)).json;
    const ok = await w.reviewer('POST', `/api/submissions/${id}/approve`, { revision: 1, expected: seen.workflow.binding });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(await status(w, id), 'approved');
  } finally {
    await w.t.close();
  }
});
