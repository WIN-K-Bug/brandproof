// Browser walkthrough of the approved-source workflow in the AUTHENTICATED workspace, using ONLY synthetic accounts
// and a FICTIONAL source document, in a throwaway directory. Never touches data/, never prints passwords.
//
//   npm run ui-smoke-sources
//
// register source (creator) -> manager approves exact version -> manager links an exact passage into a fact and
// publishes -> creator submits copy -> reviewer approves -> reviewer opens the exact cited passage -> a replacement
// version is approved -> approval is stale and approving is blocked -> manager relinks and publishes -> re-review.
// Screenshots go to docs/evidence/sources-*.png. (Native file-chooser upload is covered by API tests, not here.)
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { FACT_SHEET, FACT_SHEET_V2 } from '../../tests/sources-helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-src-ui-'));
await mkdir(path.join(tmp, 'auth'));

const app = await createApp({ dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json'), mode: 'authenticated', semantic: null, authOptions: { cost: { N: 1024, r: 8, p: 1 } } });
const base = await app.listen(0);
const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), manager: secret(), reviewer: secret() };
await app.auth.createUser({ username: 'syn-creator', displayName: 'Synthetic Creator', role: 'creator', password: pw.creator });
await app.auth.createUser({ username: 'syn-manager', displayName: 'Synthetic Manager', role: 'manager', password: pw.manager });
await app.auth.createUser({ username: 'syn-reviewer', displayName: 'Synthetic Reviewer', role: 'reviewer', password: pw.reviewer });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const BATTERY = 'A full charge lasts up to 12 hours at medium brightness.';
const start = FACT_SHEET.indexOf(BATTERY);
const end = start + BATTERY.length;

let b;
try {
  b = await launch(`${base}/#/workspace`, { port: 9353 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const body = () => b.eval('document.body.innerText');
  const shot = (name) => b.shot(path.join(shots, `sources-${name}.png`));
  const primary = () => b.click('dialog .dlg-f .btn.primary');
  const login = async (who) => {
    if (!(await b.eval(`!!document.getElementById('si-user')`))) {
      await b.click('Sign out');
      await b.wait(500);
    }
    await b.type('#si-user', `syn-${who}`);
    await b.type('#si-pass', pw[who]);
    await b.click('form.signin button[type=submit]');
    await b.wait(900);
  };
  const go = async (hash) => {
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(900);
  };

  // 1. creator registers a draft source (pasted text)
  await login('creator');
  await go('#/sources');
  await b.click('+ Register source');
  await b.type('#rs-title', 'Fernlight Aurora Lamp fact sheet (fictional)');
  await b.type('#rs-text', FACT_SHEET);
  await primary();
  await b.wait(900);
  check('a registered source is a DRAFT: pending review, not in force', /Pending review/.test(await text('main')) && !/in force/.test(await text('.card-h')));
  check('the exact text and digest are shown for review', (await text('#source-text')).includes(BATTERY) && /digest/.test(await text('main')));
  await shot('1-draft');

  // 2. a manager reads and approves that exact version
  await login('manager');
  await go('#/sources/SRC-1');
  check('the manager sees the review bar with the approve action', await b.eval(`[...document.querySelectorAll('button')].some(x=>x.textContent.startsWith('Approve version'))`));
  await b.click('Approve version…');
  await primary();
  await b.wait(500);
  check('approving without confirming that the text was read is refused', /confirm you read the text/.test(await b.eval(`[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ')`)));
  await b.eval(`document.getElementById('sa-read').click()`);
  await primary();
  await b.wait(900);
  check('the version is now in force', /v1 in force/.test(await text('main')));
  await shot('2-approved');

  // 3. the manager links an exact passage into the battery fact and publishes
  await go('#/library');
  await b.click('Approved facts');
  await b.eval(`[...document.querySelectorAll('.lib-item')].find((x) => x.textContent.includes('FCT-001')).querySelector('button').click()`);
  await b.wait(500);
  check('the existing rule is explicitly LEGACY before linking', /Legacy: typed, not linked/.test(await text('main')));
  await b.eval(`document.querySelector('input[name="f-mode"][value="registered"]').click()`);
  await b.select('#f-src', 'SRC-1');
  await b.wait(700);
  await b.eval(`(() => { const pre = document.getElementById('f-pre'); const node = pre.firstChild; const r = document.createRange(); r.setStart(node, ${start}); r.setEnd(node, ${end}); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await b.click('Use selected passage');
  check('the selected passage is previewed exactly', (await text('dialog blockquote')).includes(BATTERY));
  await b.eval(`document.getElementById('f-pre').scrollIntoView({ block: 'center' })`);
  await b.wait(300);
  await shot('3-pick-passage');
  await primary();
  await b.wait(500);
  check('the draft rule now shows as REGISTERED with its source and offsets', /Registered/.test(await text('main')) && new RegExp(`SRC-1 v1 · ${start}.${end}`).test(await text('main')));
  await b.click('Publish new version');
  await b.wait(900);
  check('guidelines v2 published with the linked rule', /Guidelines v2/.test(await text('main')));

  // 4. creator submits copy; reviewer approves it
  await login('creator');
  await go('#/workspace');
  await b.click('+ New submission');
  await b.type('#nt', 'Battery claim (fictional)');
  await b.type('#nx', 'A full charge lasts up to 12 hours.');
  await primary();
  await b.wait(1000);
  await b.click('Request review');
  await b.wait(800);
  await login('reviewer');
  await go('#/workspace/SUB-1');
  await b.click('Approve…');
  await primary();
  await b.wait(900);
  check('the reviewer approves (bound to the registered evidence)', /Approved/.test(await text('.ws-title')));

  // 5. the reviewer opens the exact cited passage from the finding
  await b.click('Consistent with guidelines');
  check('the finding shows its evidence as REGISTERED', /Registered source/.test(await text('main')) && /SRC-1 v1/.test(await text('main')));
  await shot('4-finding-registered');
  await b.click('Open the exact passage in the source');
  await b.wait(900);
  check('the source opens with the cited passage highlighted', (await text('mark.cited')) === BATTERY);
  await shot('5-exact-passage');

  // 6. a replacement version is approved: the approval goes stale and approving is blocked
  await login('creator');
  await go('#/sources/SRC-1');
  await b.click('Add new version');
  await b.type('#rs-text', FACT_SHEET_V2);
  await b.type('#rs-note', 'Adds care advice.');
  await primary();
  await b.wait(900);
  await login('manager');
  await go('#/sources/SRC-1/2');
  check('a pending replacement does not change what is in force', /v1 in force/.test(await text('main')));
  await b.click('Approve version…');
  await b.eval(`document.getElementById('sa-read').click()`);
  await primary();
  await b.wait(900);
  check('approving version 2 puts it in force', /v2 in force/.test(await text('main')));
  await login('reviewer');
  await go('#/workspace/SUB-1');
  check('the approved submission now says Re-review required', /Re-review required/.test(await text('.ws-title')));
  check('and names the evidence as the reason', /registered source evidence changed/.test(await text('main')));
  const bannerH = await b.eval(`document.getElementById('banner').offsetHeight`);
  check('the banner is a compact one-line notice', bannerH <= 56, `height ${bannerH}px`);
  const tops = await b.eval(`[...document.querySelectorAll('.flow .actions button')].map((x) => Math.round(x.getBoundingClientRect().top))`);
  check('decision buttons stay on one row with a long status message', tops.length === 3 && new Set(tops).size === 1, tops.join(','));
  await shot('6-stale-evidence');

  // a new review can be requested, but approving is blocked while the cited evidence is not in force
  await login('creator');
  await go('#/workspace/SUB-1');
  await b.click('Request review');
  await b.wait(800);
  await login('reviewer');
  await go('#/workspace/SUB-1');
  check('in review again, but Approve is disabled because cited evidence is not in force', (await b.eval(`[...document.querySelectorAll('.flow button')].find((x) => x.textContent.startsWith('Approve')).disabled`)) && /no longer in force/.test(await text('.flow')));
  await shot('6b-approve-blocked');

  // 7. repair: relink to the same quote in the version in force, publish, re-review, approve
  await login('manager');
  await go('#/library');
  check('the library shows the repair panel for the broken link', /cite.* evidence that is no longer in force/.test(await text('main')));
  await shot('7-repair');
  await b.click('Relink to same quote in version in force');
  await b.wait(900);
  await b.click('Publish new version');
  await b.wait(1000);
  check('after relinking and publishing the repair panel is gone', !/no longer in force/.test(await text('main')));
  await login('reviewer');
  await go('#/workspace/SUB-1');
  await b.click('Approve…');
  await primary();
  await b.wait(900);
  check('review on the repaired evidence ends Approved again', /Approved/.test(await text('.ws-title')));
  await shot('8-reapproved');

  const noise = b.consoleMsgs.filter((m) => !/401|403|409|422|Failed to load resource/.test(m));
  check('browser console has no errors (expected 4xx network lines excluded)', noise.length === 0, noise.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (sources-*.png)`);
process.exit(failed ? 1 : 0);
