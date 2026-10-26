import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startApp } from './helpers.js';
import { demoAs, sha } from './sources-helpers.js';
import { bootstrapConsequence, protectedReason, SHEET_V1, SHEET_V2, BAT12, BAT8 } from '../scripts/demo/consequence.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');

test('consequence scenario: idempotent, ends exactly before the manager looks at the pending 8-hour version', async () => {
  const t = await startApp();
  try {
    const first = await bootstrapConsequence(t.url);
    assert.equal(first.alreadyDone, false);
    const file = path.join(t.dir, 'data.json');
    const bytes = await readFile(file);
    const second = await bootstrapConsequence(t.url);
    assert.equal(second.alreadyDone, true, 'a second run finds everything done');
    assert.ok(bytes.equals(await readFile(file)), 'and changes nothing on disk');

    const manager = demoAs(t, 'manager');
    const src = (await manager('GET', '/api/sources/SRC-1')).json.source;
    assert.equal(src.activeVersion, 1);
    assert.deepEqual(src.versions.map((v) => v.state), ['active', 'pending']);
    const subs = (await manager('GET', '/api/submissions')).json.submissions;
    const campaign = subs.find((s) => /12 to 8 hours scenario/.test(s.title));
    assert.equal(campaign.status, 'approved');
    const detail = (await manager('GET', `/api/submissions/${campaign.id}`)).json;
    assert.equal(detail.current.image.status, 'retained');
    assert.equal(detail.events.filter((e) => e.type === 'approved').length, 1);

    // the narration is literally true: the governing passage disappears, the other two stay, the approval goes stale
    const pre = (await manager('GET', '/api/sources/SRC-1/impact?action=activate&version=2')).json;
    assert.deepEqual(pre.dependencies.map((d) => [d.entryId, d.continuity.kind]), [['FCT-001', 'absent'], ['FCT-002', 'unchanged'], ['FCT-004', 'unchanged']]);
    assert.equal(pre.dependencies[0].quote, BAT12);
    assert.match(pre.textChange.removed[0].text, /up to 12 hours/);
    assert.match(pre.textChange.added[0].text, /up to 8 hours/);
    assert.equal(pre.campaigns.counts.approvedNewlyStale, 1);
    const done = await manager('POST', '/api/sources/SRC-1/versions/2/approve', { expectedSha256: sha(SHEET_V2), previewDigest: pre.digest });
    assert.equal(done.status, 201, done.text);
    const after = (await manager('GET', `/api/submissions/${campaign.id}`)).json;
    assert.equal(after.workflow.status, 'approval_stale');
    assert.deepEqual(after.workflow.staleApproval.reasons, ['evidence']);
    assert.ok(SHEET_V1.includes(BAT12) && SHEET_V2.includes(BAT8) && !SHEET_V2.includes('12 hours'));
  } finally {
    await t.close();
  }
});

test('consequence launcher refuses real data and the showcase file', () => {
  assert.match(protectedReason(path.join(ROOT, 'data', 'brandproof.json'), ROOT), /inside data\//);
  assert.match(protectedReason(path.join(ROOT, 'data', 'anything-else.json'), ROOT), /inside data\//);
  assert.match(protectedReason(path.join(ROOT, 'demo-data', 'fernlight-showcase.json'), ROOT), /showcase/);
  assert.equal(protectedReason(path.join(ROOT, 'demo-data', 'aurora-8h-scenario.json'), ROOT), null);
});

test('image text scenario: idempotent, ends with a retained banner and NO transcription, so the presenter does the reading', async () => {
  const { bootstrapImageText, TITLES, IMAGES } = await import('../scripts/demo/imagetext.mjs');
  const t = await startApp();
  try {
    const first = await bootstrapImageText(t.url);
    assert.equal(first.alreadyDone, false);
    const file = path.join(t.dir, 'data.json');
    const bytes = await readFile(file);
    assert.equal((await bootstrapImageText(t.url)).alreadyDone, true);
    assert.ok(bytes.equals(await readFile(file)), 'a second run changes nothing on disk');
    const manager = demoAs(t, 'manager');
    const subs = (await manager('GET', '/api/submissions')).json.submissions;
    const made = subs.find((s) => s.title === TITLES.campaign);
    const d = (await manager('GET', `/api/submissions/${made.id}`)).json;
    assert.equal(d.current.image.status, 'retained');
    assert.equal(d.revisions[0].imageText, undefined, 'nothing is transcribed in advance');
    assert.ok(d.current.notChecked.some((n) => n.ruleId === 'IMG-TXT' && /no transcription/.test(n.reason)));
    assert.ok(IMAGES.wrong.length > 1000 && IMAGES.right.length > 1000);
  } finally {
    await t.close();
  }
});
