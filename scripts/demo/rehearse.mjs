// Replays the presenter path of docs/demo.md (source activation -> stale approvals -> repair) through the API on a
// THROWAWAY copy of the showcase, and asserts what the presenter will say. Never touches demo-data/ or data/.
//
//   npm run demo:rehearse
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { bootstrapShowcase, FACT_SHEET_V2 } from './bootstrap.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-rehearse-'));
const app = await createApp({ dataFile: path.join(tmp, 'rehearsal.json'), semantic: null });
const base = await app.listen(0);
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const call = async (method, p, body, role = 'manager') => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-demo-role': role }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
try {
  await bootstrapShowcase(base);
  const st = async (id) => (await call('GET', `/api/submissions/${id}`, undefined, 'reviewer')).json;
  check('before: SUB-4 approved, SUB-5 re-review required (image replaced)', (await st('SUB-4')).workflow.status === 'approved' && (await st('SUB-5')).workflow.status === 'approval_stale' && (await st('SUB-5')).workflow.staleApproval.reasons.join() === 'asset');
  check('SUB-6 findings cite registered passages', (await st('SUB-6')).current.findings.some((f) => f.sourceEvidence?.provenance === 'registered' && f.status === 'contradicted'));

  const src = (await call('GET', '/api/sources/SRC-1')).json.source;
  check('SRC-1: version 1 in force, version 2 pending', src.activeVersion === 1 && src.versions[1].status === 'pending');
  check('approving version 2 as Creator is refused', (await call('POST', '/api/sources/SRC-1/versions/2/approve', { expectedSha256: src.versions[1].textSha256 }, 'creator')).status === 403);

  const act = await call('POST', '/api/sources/SRC-1/versions/2/approve', { expectedSha256: src.versions[1].textSha256, note: 'Rehearsal' });
  check('Manager approves version 2: it is now in force', act.status === 201 && act.json.source.activeVersion === 2);
  const stale = await st('SUB-4');
  check('SUB-4 now says Re-review required, reason: evidence', stale.workflow.status === 'approval_stale' && stale.workflow.staleApproval.reasons.includes('evidence'));
  check('the library has 3 facts that need relinking', stale.current.evidence.broken.length === 3);

  // the repair the presenter clicks: same quote, version in force, then publish
  const g = (await call('GET', '/api/guidelines')).json;
  const edited = structuredClone(g.guidelines);
  for (const b of stale.current.evidence.broken) {
    const f = edited.facts.find((x) => x.id === b.entryId);
    const at = FACT_SHEET_V2.indexOf(f.source.quote);
    check(`${b.entryId}: its quote occurs exactly once in version 2`, at >= 0 && FACT_SHEET_V2.indexOf(f.source.quote, at + 1) < 0);
    f.source = { sourceId: 'SRC-1', version: 2, start: at, end: at + f.source.quote.length, quote: f.source.quote };
  }
  const pub = await call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'Relink to version 2', guidelines: edited });
  check('publishing the relinked guidelines succeeds', pub.status === 201, JSON.stringify(pub.json?.error ?? ''));
  const repaired = await st('SUB-4');
  check('after repair no link is broken; SUB-4 still needs a fresh review (guidelines and evidence changed)', repaired.current.evidence.broken.length === 0 && repaired.workflow.status === 'approval_stale');
  const rr = await call('POST', '/api/submissions/SUB-4/request-review', { revision: 2, expected: repaired.workflow.binding }, 'creator');
  const seen = await st('SUB-4');
  const ap = await call('POST', '/api/submissions/SUB-4/approve', { revision: 2, expected: seen.workflow.binding, acknowledgeWarnings: true }, 'reviewer');
  check('a new review on the repaired evidence ends Approved', rr.status === 201 && ap.status === 201 && ap.json.workflow.status === 'approved');
} finally {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nRehearsal passed.');
process.exit(failed ? 1 : 0);
