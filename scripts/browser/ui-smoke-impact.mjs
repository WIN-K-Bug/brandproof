// Browser walkthrough of the source change-impact preview in the AUTHENTICATED workspace, using ONLY synthetic accounts
// and a FICTIONAL fact sheet, in a throwaway directory. Never touches data/, never prints passwords.
//
//   npm run ui-smoke-impact
//
// A fact sheet changes battery life from "up to 12 hours" to "up to 8 hours". A manager previews the activation
// (nothing is written), sees exact old/new passages and which campaigns are affected, approves while the state changes
// underneath (the stale preview is refused), approves again on the new preview, sees the real consequences, repairs the
// links and the fact through the normal publish path, and a different person reviews again.
// Screenshots go to docs/evidence/impact-*.png.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { cleanContent } from '../../tests/helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-impact-ui-'));
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

// The fictional fact sheet. Battery is LAST so changing it leaves the two other passages at the same offsets.
const ENV = 'Indoor use only; not waterproof or water resistant.';
const WARR = 'Every Aurora Lamp carries a 2-year limited warranty.';
const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional)', '', `Environment. ${ENV}`, '', `Warranty. ${WARR}`, '', `Battery. ${battery}`].join('\n');
const V1 = sheet(BAT12);
const V2 = sheet(BAT8);
const V3 = `${V2}\n\nCare. Wipe with a dry cloth.`;
const spanOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const sha = async (t) => (await import('node:crypto')).createHash('sha256').update(t, 'utf8').digest('hex');

// API clients for setup and for independent verification (real sessions, real CSRF)
async function client(name) {
  const c = {};
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: `syn-${name}`, password: pw[name] }) });
  c.cookie = r.headers.getSetCookie()[0].split(';')[0];
  c.csrf = (await r.json()).csrf;
  c.call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { origin: base, cookie: c.cookie, 'x-csrf-token': c.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return c;
}

let b;
try {
  const [creator, manager, reviewer] = [await client('creator'), await client('manager'), await client('reviewer')];
  const must = (r, code = 201) => {
    if (r.status !== code) throw new Error(`setup step failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };

  // --- setup (the registration, approval and linking screens are walked through in ui-smoke-sources) ---
  const src = must(await creator.call('POST', '/api/sources', { title: 'Fernlight Aurora Lamp fact sheet (fictional)', text: V1, origin: 'paste' })).source;
  must(await manager.call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: await sha(V1), note: 'checked' }));
  const g = must(await manager.call('GET', '/api/guidelines'), 200);
  const edited = structuredClone(g.guidelines);
  const entry = (id) => edited.facts.find((f) => f.id === id);
  for (const [id, needle] of [['FCT-001', BAT12], ['FCT-002', ENV], ['FCT-004', WARR]]) entry(id).source = { sourceId: src.id, version: 1, ...spanOf(V1, needle) };
  must(await manager.call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'link three facts to the fact sheet', guidelines: edited }));

  const content = () => ({ ...cleanContent() });
  const create = async (title, text) => must(await creator.call('POST', '/api/submissions', { title, ...content(), text })).id;
  const review = async (id) => {
    const cur = must(await creator.call('GET', `/api/submissions/${id}`), 200);
    must(await creator.call('POST', `/api/submissions/${id}/request-review`, { revision: cur.headRevision, expected: cur.workflow.binding }));
  };
  const approveCampaign = async (id) => {
    await review(id);
    const cur = must(await reviewer.call('GET', `/api/submissions/${id}`), 200);
    must(await reviewer.call('POST', `/api/submissions/${id}/approve`, { revision: cur.headRevision, expected: cur.workflow.binding }));
  };
  const status = async (id) => must(await reviewer.call('GET', `/api/submissions/${id}`), 200).workflow.status;

  const A = await create('Aurora battery launch', 'A full charge lasts up to 12 hours.');
  await approveCampaign(A);
  const B = await create('Care tips post', 'The Aurora Lamp is a reading light for your desk.');
  await approveCampaign(B);
  const C = await create('Warranty announcement', 'The Aurora Lamp has a 2-year warranty.');
  await review(C);
  const D = await create('Indoor lamp draft', 'The Aurora Lamp is designed for indoor use.');
  must(await creator.call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: V2, origin: 'paste', note: 'Battery life reduced to 8 hours' }));

  b = await launch(`${base}/#/workspace`, { port: 9361 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const shot = (name) => b.shot(path.join(shots, `impact-${name}.png`));
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
  const dialogText = () => b.eval(`document.querySelector('dialog')?.innerText ?? ''`);
  const waitForDialogText = async (re) => {
    for (let i = 0; i < 40; i++) {
      if (re.test(await dialogText())) return true;
      await b.wait(250);
    }
    return false;
  };
  const events = async () => must(await manager.call('GET', `/api/sources/${src.id}`), 200).source.events.length;
  const fileBytes = async () => (await import('node:fs/promises')).readFile(path.join(tmp, 'workspace.json'));

  // 0. only a manager can preview
  await login('creator');
  await go(`#/sources/${src.id}/2`);
  check('a creator sees Preview impact disabled (Managers only)', await b.eval(`[...document.querySelectorAll('button')].some((x) => x.textContent.startsWith('Preview impact') && x.disabled)`));
  check('the server also refuses the preview to a creator and a reviewer', (await creator.call('GET', `/api/sources/${src.id}/impact?action=activate&version=2`)).status === 403 && (await reviewer.call('GET', `/api/sources/${src.id}/impact?action=activate&version=2`)).status === 403);

  // 1. the manager previews the activation
  await login('manager');
  await go(`#/sources/${src.id}/2`);
  const bytesBefore = await fileBytes();
  const eventsBefore = await events();
  await b.click('Preview impact…');
  check('the preview loads and says what approving does', await waitForDialogText(/replacing version 1/));
  const body1 = await dialogText();
  check('it states that nothing is saved and shows the baseline digests', /Nothing has been saved, relinked, approved or rewritten/.test(body1) && /evidence digest/.test(body1));
  check('whole-binding consequences are counted separately: 2 approved campaigns, 1 in review (blocked), 1 draft', /2 approved campaigns will show Re-review required/.test(body1) && /1 campaign in review/.test(body1) && /1 draft cites a rule that depends on this source/.test(body1), body1.replace(/\s+/g, ' ').slice(0, 400));
  check('it explains that approvals bind the whole evidence set (even campaigns with no citing finding)', /every approved campaign is affected, including ones with no finding from the rules below/.test(body1));
  check('the three governing citations are listed with exact continuity: two unchanged, one gone', (body1.match(/Same words, same place/g) ?? []).length === 2 && (body1.match(/These words are gone/g) ?? []).length === 1);
  check('the old battery passage and the removed/added lines are shown verbatim', body1.includes(BAT12) && body1.includes(`Battery. ${BAT12}`) && body1.includes(`Battery. ${BAT8}`));
  check('the campaign list names Care tips as affected although no finding cites the source', /Care tips post/.test(body1) && /no finding cites this source/.test(body1));
  check('uncovered coverage is stated (legacy rules, other sources) and no verdict about meaning is made', /Not covered/.test(body1) && /typed \(legacy\) source/.test(body1) && /not proof that a claim is wrong/.test(body1));
  await b.eval(`document.querySelector('dialog .dlg-b').scrollTop = 0`);
  await shot('1-preview-top');
  await b.eval(`document.querySelector('dialog .dlg-b').scrollTop = 520`);
  await b.wait(300);
  await shot('2-preview-dependencies');
  check('the preview wrote nothing: file bytes and source events unchanged', (await fileBytes()).equals(bytesBefore) && (await events()) === eventsBefore);
  const predicted = must(await manager.call('GET', `/api/sources/${src.id}/impact?action=activate&version=2`), 200);
  await b.click('Close');

  // 2. approve while the world changes underneath: the stale preview is refused
  await b.click('Approve version…');
  check('the approve dialog loads the preview itself', await waitForDialogText(/Rules and facts that cite this source \(3\)/));
  must(await creator.call('POST', '/api/submissions', { title: 'Late campaign', ...content(), text: 'A new campaign arrives after the preview was read.' }));
  await b.eval(`document.getElementById('sa-read').click()`);
  await primary();
  await b.wait(1500);
  const afterStale = await dialogText();
  check('the approval is refused as out of date and the preview reloads with a warning', /The preview was out of date and has been reloaded/.test(afterStale), afterStale.slice(0, 120));
  check('nothing was approved: no source event was recorded and version 1 is still in force', (await events()) === eventsBefore && must(await manager.call('GET', `/api/sources/${src.id}`), 200).source.activeVersion === 1);
  await b.eval(`document.querySelector('dialog .dlg-b').scrollTop = 0`);
  await shot('3-stale-refused');
  check('the confirmation box was cleared so the new preview must be read again', await b.eval(`document.getElementById('sa-read').checked === false`));

  // 3. read the new preview and approve
  await b.eval(`document.getElementById('sa-read').click()`);
  await primary();
  await b.wait(1200);
  check('approving on the fresh preview succeeds: version 2 is in force', /v2 in force/.test(await text('main')));

  // 4. the real consequences match the prediction
  const now = { A: await status(A), B: await status(B), C: await status(C), D: await status(D) };
  check('the approved campaigns now need re-review, exactly as predicted', now.A === 'approval_stale' && now.B === 'approval_stale' && predicted.campaigns.counts.approvedNewlyStale === 2);
  check('the campaign in review is blocked from approval until repair, the draft is unchanged', now.C === 'in_review' && now.D === 'draft' && (await reviewer.call('GET', `/api/submissions/${C}`)).json.workflow.eligibility.approve.allowed === false);
  await go(`#/workspace/${A}`);
  check('the workspace shows Re-review required with the evidence as the reason', /Re-review required/.test(await text('.ws-title')) && /evidence/i.test(await text('main')));
  await shot('4-after-activation');

  // 5. repair through the normal publish path, then a distinct person reviews
  const cur = must(await manager.call('GET', '/api/guidelines'), 200);
  const fixed = structuredClone(cur.guidelines);
  const fx = (id) => fixed.facts.find((f) => f.id === id);
  fx('FCT-001').value = 8;
  fx('FCT-001').statement = 'A full charge lasts up to 8 hours at medium brightness.';
  for (const [id, needle] of [['FCT-001', BAT8], ['FCT-002', ENV], ['FCT-004', WARR]]) fx(id).source = { sourceId: src.id, version: 2, ...spanOf(V2, needle) };
  must(await manager.call('PUT', '/api/guidelines', { baseVersion: cur.version, note: 'battery is now 8 hours; relink to version 2', guidelines: fixed }));
  const blocked = (await reviewer.call('GET', `/api/submissions/${A}`)).json;
  check('after the repair the old copy shows a real blocking contradiction (12 hours vs 8)', blocked.current.summary.contradicted === 1);
  must(await creator.call('POST', `/api/submissions/${A}/revisions`, { baseRevision: 1, text: 'A full charge lasts up to 8 hours.', asset: content().asset }));
  await approveCampaign(A);
  await go('#/queue'); // setting the same hash again would not re-render the page
  await go(`#/workspace/${A}`);
  const finalTitle = await text('.ws-title');
  check('after the revision a different person approves and the campaign is Approved again', /Approved/.test(finalTitle) && !/Re-review/.test(finalTitle) && (await status(A)) === 'approved', finalTitle.replace(/s+/g, ' '));
  await shot('5-repaired-approved');

  // 6. a second pending version previewed on a narrow screen
  must(await creator.call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 2, text: V3, origin: 'paste', note: 'care note' }));
  await go(`#/sources/${src.id}/3`);
  await b.viewport(420, 820, true);
  await b.click('Preview impact…');
  check('the narrow preview loads', await waitForDialogText(/replacing version 2/));
  check('no horizontal scrolling at 420 px, in the dialog or on the page', await b.eval(`(() => { const d = document.querySelector('dialog'); const body = d.querySelector('.dlg-b'); return d.scrollWidth <= d.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; })()`));
  check('keyboard: the dialog traps focus inside and Escape closes it', await (async () => {
    await b.key('Tab');
    const inDialog = (await b.active())?.inDialog === true;
    await b.key('Escape');
    return inDialog && !(await b.eval(`!!document.querySelector('dialog')`));
  })());
  await b.click('Preview impact…');
  await waitForDialogText(/replacing version 2/);
  await shot('6-narrow');
  await b.click('Close');
  await b.viewport(1280, 800, false);

  check('browser console is clean', b.consoleMsgs.filter((m) => !/40[139]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (impact-*.png)`);
process.exit(failed ? 1 : 0);
