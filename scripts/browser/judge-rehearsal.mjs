// Judge-style rehearsal of the whole evidence story, SCRIPTED and AUTOMATED in a real headless browser against a
// throwaway AUTHENTICATED workspace (synthetic accounts, a fictional fact sheet, a generated PNG). It never touches data/,
// demo-data/ or any running server, and never prints passwords.
//
//   npm run judge-rehearsal
//
// The story: a fictional fact sheet changes battery life from "up to 12 hours" to "up to 8 hours".
//   claim + exact cited passage -> corrected campaign with a retained image -> distinct reviewer approves ->
//   source v2 registered -> manager previews the impact -> activates -> approval is stale and review is blocked ->
//   manager edits the fact, relinks and publishes -> creator corrects the copy -> a DISTINCT signed-in reviewer approves
//   -> dossier (with a real JSON download).
//
// IMPORTANT about the numbers it prints: they are counts and timings of an AUTOMATED script (each fill, click, select,
// key press, file choice and address change is one "action"; the waits are fixed sleeps that let the page settle). They
// are NOT a human study, NOT a measure of how long a person needs, and NOT the length of any spoken demo.
// Screenshots: docs/evidence/judge/NN-*.png. A machine-readable report: docs/evidence/judge/rehearsal-report.json.
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { canonical, sha256 } from '../../src/util.js';
import { launch } from './cdp.mjs';
import { makeStripedPng } from '../../tests/png-helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(root, 'docs', 'evidence', 'judge');
await mkdir(outDir, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-judge-'));
const dl = path.join(tmp, 'downloads');
await mkdir(path.join(tmp, 'auth'));
await mkdir(dl);

const app = await createApp({ dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json'), mode: 'authenticated', semantic: null, authOptions: { cost: { N: 1024, r: 8, p: 1 } } });
const base = await app.listen(0);
const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), manager: secret(), reviewer: secret() };
for (const who of ['creator', 'manager', 'reviewer']) await app.auth.createUser({ username: `syn-${who}`, displayName: `Synthetic ${who[0].toUpperCase()}${who.slice(1)}`, role: who, password: pw[who] });

// ---------- the fictional documents ----------
const ENV = 'Indoor use only; not waterproof or water resistant.';
const WARR = 'Every Aurora Lamp carries a 2-year limited warranty.';
const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional)', '', `Environment. ${ENV}`, '', `Warranty. ${WARR}`, '', `Battery. ${battery}`].join('\n');
const V1 = sheet(BAT12);
const V2 = sheet(BAT8);
const spanOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

// ---------- bookkeeping: every automated action is counted ----------
const log = { steps: [], current: null, actions: 0, signIns: 0, signInActions: 0, byActor: {}, byKind: {} };
let actor = 'setup';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  log.current?.checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const count = (kind) => {
  log.actions++;
  log.byKind[kind] = (log.byKind[kind] ?? 0) + 1;
  log.byActor[actor] = (log.byActor[actor] ?? 0) + 1;
  if (log.current) log.current.actions++;
};
const step = async (title, who, fn) => {
  actor = who ?? actor;
  log.current = { title, actor, actions: 0, ms: 0, checks: [] };
  log.steps.push(log.current);
  console.log(`\n## ${title}`);
  const t0 = performance.now();
  try {
    await fn();
  } finally {
    log.current.ms = Math.round(performance.now() - t0);
  }
};

// ---------- API client for SETUP ONLY (not counted as story actions) ----------
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
const must = (r, code = 201) => {
  if (r.status !== code) throw new Error(`step failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

let b;
let shotNo = 0;
try {
  // ===== setup: accounts exist; the fact sheet version 1 is registered, approved and linked to three facts =====
  const creatorApi = await client('creator');
  const managerApi = await client('manager');
  const reviewerApi = await client('reviewer');
  const src = must(await creatorApi.call('POST', '/api/sources', { title: 'Fernlight Aurora Lamp fact sheet (fictional)', text: V1, origin: 'paste' })).source;
  must(await managerApi.call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: sha(V1), note: 'checked' }));
  const g = must(await managerApi.call('GET', '/api/guidelines'), 200);
  const edited = structuredClone(g.guidelines);
  for (const [id, needle] of [['FCT-001', BAT12], ['FCT-002', ENV], ['FCT-004', WARR]]) edited.facts.find((f) => f.id === id).source = { sourceId: src.id, version: 1, ...spanOf(V1, needle) };
  must(await managerApi.call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'link three facts to the fact sheet', guidelines: edited }));
  const png = makeStripedPng();
  const pngFile = path.join(tmp, 'aurora-banner.png');
  await writeFile(pngFile, png);

  b = await launch(`${base}/#/workspace`, { port: 9381 });
  await b.downloads(dl);
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const main = () => b.eval('document.querySelector("main").innerText');
  const shot = async (name) => b.shot(path.join(outDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`));
  // counted wrappers around the browser driver
  const click = async (t) => (count('click'), b.click(t));
  const fill = async (sel, v) => (count('fill'), b.type(sel, v));
  const choose = async (sel, v) => (count('select'), b.select(sel, v));
  const dialogOk = async () => (count('click'), b.click('dialog .dlg-f .btn.primary'));
  const evalAction = async (kind, expr) => (count(kind), b.eval(expr));
  const go = async (hash) => {
    count('navigate');
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(1000);
  };
  const login = async (who) => {
    actor = who;
    log.signIns++;
    const before = log.actions;
    if (!(await b.eval(`!!document.getElementById('si-user')`))) {
      await click('Sign out');
      await b.wait(500);
    }
    await fill('#si-user', `syn-${who}`);
    await fill('#si-pass', pw[who]);
    await click('form.signin button[type=submit]');
    await b.wait(900);
    log.signInActions += log.actions - before;
  };
  const waitFor = async (re, sel = 'dialog') => {
    for (let i = 0; i < 40; i++) {
      if (re.test(await text(sel))) return true;
      await b.wait(250);
    }
    return false;
  };
  const status = async (id, api = reviewerApi) => must(await api.call('GET', `/api/submissions/${id}`), 200).workflow.status;

  const T0 = performance.now();

  // ===== 1. creator: a claim, and the exact passage that governs it =====
  await step('1. A claim is checked against the registered fact sheet, and its exact passage opens', 'creator', async () => {
    await login('creator');
    await click('+ New submission');
    await fill('#nt', 'Aurora battery launch');
    await fill('#nx', 'A full charge lasts 30 hours.');
    await dialogOk();
    await b.wait(1000);
    const body = await main();
    check('the claim is flagged as contradicting the approved fact and cites a REGISTERED source', /Contradicts approved fact: Battery life/.test(body) && /Registered source/.test(body) && /SRC-1 v1/.test(body));
    await shot('claim-finding');
    await click('Open the exact passage in the source');
    await b.wait(900);
    check('the source opens with the cited sentence highlighted: "up to 12 hours at medium brightness"', (await text('mark.cited')) === BAT12);
    await shot('exact-passage');
  });

  // ===== 2. creator: fix with the safe correction, attach a PNG, request review =====
  await step('2. The creator applies the safe correction, attaches a retained image and requests review', 'creator', async () => {
    await go('#/workspace/SUB-1');
    await click('Apply in new draft');
    await b.wait(700);
    check('the safe correction keeps "up to" and the approved condition', (await b.eval(`document.querySelector('#draft-text').value`)) === 'A full charge lasts up to 12 hours at medium brightness.');
    await b.wait(1000);
    count('file');
    await b.setFiles('#asset-file', [pngFile]);
    check('the PNG is retained by the server (true size shown)', /Retained image/.test(await text('.image-box')) && /240 × 120 px/.test(await text('.image-box')));
    await fill('#alt', 'Three vertical stripes in navy, teal and amber, the Fernlight colours');
    await click('Save as revision 2');
    await b.wait(1100);
    await click('Request review');
    await b.wait(900);
    check('the copy now matches the approved fact (no blocking findings) and is In review', /In review/.test(await text('.ws-title')) && (await b.eval(`document.querySelectorAll('.finding.sev-error').length`)) === 0);
    await shot('corrected-with-image');
  });

  // ===== 3. a DISTINCT reviewer approves =====
  await step('3. A different signed-in person, the reviewer, approves it', 'reviewer', async () => {
    await login('reviewer');
    await go('#/workspace/SUB-1');
    await click('Approve…');
    await dialogOk();
    await b.wait(1000);
    check('the campaign is Approved', /Approved/.test(await text('.ws-title')));
    const ev = must(await reviewerApi.call('GET', '/api/submissions/SUB-1'), 200);
    const approved = ev.events.find((e) => e.type === 'approved');
    check('the approval is attributed to the reviewer account, who is not an author of the campaign', approved.actor.role === 'reviewer' && approved.actor.id !== ev.createdBy.id && ev.revisions.every((r) => r.author.id !== approved.actor.id));
    await shot('approved');
  });

  // ===== 4. the source changes: version 2 says 8 hours =====
  await step('4. The fact sheet changes: version 2 (battery 12 hours -> 8 hours) is registered as a draft', 'creator', async () => {
    await login('creator');
    await go(`#/sources/${src.id}`);
    await click('Add new version');
    await fill('#rs-text', V2);
    await fill('#rs-note', 'Battery life reduced to 8 hours');
    await dialogOk();
    await b.wait(900);
    check('a registered replacement is only a draft: version 1 is still in force', (await status('SUB-1')) === 'approved');
  });

  // ===== 5. manager: preview, then activate =====
  await step('5. The manager previews the impact (nothing is saved), then activates version 2', 'manager', async () => {
    await login('manager');
    await go(`#/sources/${src.id}/2`);
    const bytesBefore = await readFile(path.join(tmp, 'workspace.json'));
    await click('Preview impact…');
    check('the preview loads', await waitFor(/replacing version 1/));
    const p = await text('dialog');
    check('it names what is affected: 1 approved campaign, three citations (two unchanged, one gone), exact old and new battery lines', /1 approved campaign will show Re-review required/.test(p) && (p.match(/Same words, same place/g) ?? []).length === 2 && (p.match(/These words are gone/g) ?? []).length === 1 && p.includes(`Battery. ${BAT12}`) && p.includes(`Battery. ${BAT8}`));
    check('it says it changed nothing, and warns that equal words are not equal meaning and legacy rules are not covered', /Nothing has been saved, relinked, approved or rewritten/.test(p) && /Not covered/.test(p) && /not proof that a claim is wrong/.test(p));
    check('looking wrote nothing to disk', (await readFile(path.join(tmp, 'workspace.json'))).equals(bytesBefore));
    await shot('impact-preview-top');
    await b.eval(`document.querySelector('dialog .dlg-b').scrollTop = 520`);
    await b.wait(300);
    await shot('impact-preview-dependencies');
    await click('Close');
    await click('Approve version…');
    check('the approve dialog loads the same preview', await waitFor(/Rules and facts that cite this source \(3\)/));
    await evalAction('click', `document.getElementById('sa-read').click()`);
    await dialogOk();
    await b.wait(1200);
    check('version 2 is now in force', /v2 in force/.test(await text('main')));
  });

  // ===== 6. consequences: stale and blocked =====
  await step('6. The approval is stale, and a new review cannot be approved until the evidence is repaired', 'reviewer', async () => {
    await login('reviewer');
    await go('#/workspace/SUB-1');
    const body = await main();
    check('Re-review required, with the registered evidence named as the reason', /Re-review required/.test(await text('.ws-title')) && /registered source evidence changed/.test(body));
    await shot('stale-approval');
    actor = 'creator';
    await login('creator');
    await go('#/workspace/SUB-1');
    await click('Request review');
    await b.wait(900);
    actor = 'reviewer';
    await login('reviewer');
    await go('#/workspace/SUB-1');
    check('in review again, but Approve is disabled: cited evidence is no longer in force', (await b.eval(`[...document.querySelectorAll('.flow button')].find((x) => x.textContent.startsWith('Approve')).disabled`)) && /no longer in force/.test(await text('.flow')));
    await shot('approve-blocked');
  });

  // ===== 7. manager: edit the fact, relink, publish =====
  await step('7. The manager edits the battery fact to 8 hours, relinks all three rules to version 2 and publishes', 'manager', async () => {
    await login('manager');
    await go('#/library');
    check('the library shows the repair panel for three broken links', /3 rules cite evidence that is no longer in force/.test(await text('main')));
    await shot('repair-panel');
    await evalAction('click', `[...document.querySelectorAll('.notice.warn li')].find((li) => li.textContent.includes('FCT-001')).querySelectorAll('button')[1].click()`);
    await b.wait(700);
    await fill('#f-val', '8');
    await fill('#f-stmt', 'A full charge lasts up to 8 hours at medium brightness.');
    await choose('#f-src', src.id);
    await b.wait(700);
    const sp = spanOf(V2, BAT8);
    await evalAction('select-text', `(() => { const pre = document.getElementById('f-pre'); const node = pre.firstChild; const r = document.createRange(); r.setStart(node, ${sp.start}); r.setEnd(node, ${sp.end}); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
    await click('Use selected passage');
    check('the exact new passage is previewed before saving', (await text('dialog blockquote')).includes(BAT8));
    await shot('fact-edit');
    await dialogOk();
    await b.wait(600);
    for (const id of ['FCT-002', 'FCT-004']) {
      await evalAction('click', `[...document.querySelectorAll('.notice.warn li')].find((li) => li.textContent.includes(${JSON.stringify(id)})).querySelectorAll('button')[0].click()`);
      await b.wait(700);
    }
    await click('Publish new version');
    await b.wait(1100);
    check('guidelines v3 are published and the repair panel is gone', /Guidelines v3/.test(await text('main')) && !/no longer in force/.test(await text('main')));
  });

  // ===== 8. creator: the old copy now contradicts the fact; correct it =====
  await step('8. The old copy now contradicts the 8-hour fact; the creator applies the safe correction and requests review', 'creator', async () => {
    await login('creator');
    await go('#/workspace/SUB-1');
    check('the previously approved wording is now a blocking contradiction (up to 12 hours vs 8)', /Contradicts approved fact: Battery life/.test(await main()));
    await click('Apply in new draft');
    await b.wait(900);
    const fixed = await b.eval(`document.querySelector('#draft-text').value`);
    check('the safe correction proposes "up to 8 hours at medium brightness"', fixed === 'A full charge lasts up to 8 hours at medium brightness.', fixed);
    await click('Save as revision 3');
    await b.wait(1100);
    await click('Request review');
    await b.wait(900);
    check('the corrected revision is In review with the retained image carried over', /In review/.test(await text('.ws-title')) && /Retained image/.test(await main()));
  });

  // ===== 9. a distinct reviewer approves again =====
  await step('9. The reviewer approves the corrected revision on the repaired evidence', 'reviewer', async () => {
    await login('reviewer');
    await go('#/workspace/SUB-1');
    await click('Approve…');
    await dialogOk();
    await b.wait(1000);
    check('Approved again', /Approved/.test(await text('.ws-title')) && !/Re-review/.test(await text('.ws-title')));
    const ev = must(await reviewerApi.call('GET', '/api/submissions/SUB-1'), 200);
    const approvals = ev.events.filter((e) => e.type === 'approved');
    check('history keeps BOTH approvals; the second names revision 3 and the repaired evidence', approvals.length === 2 && approvals[0].revision === 2 && approvals[1].revision === 3 && approvals[0].binding.evidenceHash !== approvals[1].binding.evidenceHash);
    check('nobody approved their own work', approvals.every((a) => a.actor.role === 'reviewer' && ev.revisions.every((r) => r.author.id !== a.actor.id)));
    await shot('approved-again');
  });

  // ===== 10. the dossier =====
  await step('10. The review dossier: one page of what was reviewed, with the evidence and the decisions, and a JSON download', 'reviewer', async () => {
    await click('Review dossier');
    await b.wait(1300);
    const d = await main();
    check('the dossier shows Approved, the image integrity verified now, and the exact cited NEW passage', /Approved/.test(await text('section[aria-labelledby="dz-status"]')) && /Integrity verified now/.test(d) && d.includes(BAT8));
    check('it keeps recorded decisions apart from findings recomputed today, and says it is a snapshot, not a certificate', /Recorded/.test(d) && /Recomputed/.test(d) && /not a compliance certificate/.test(d));
    await shot('dossier');
    const before = (await readdir(dl)).length;
    await click('#dossier-download');
    let file;
    for (let i = 0; i < 30; i++) {
      const names = (await readdir(dl)).filter((n) => n.endsWith('.json'));
      if (names.length > before) {
        file = names[0];
        break;
      }
      await b.wait(200);
    }
    const json = JSON.parse(await readFile(path.join(dl, file ?? 'none'), 'utf8').catch(() => '{}'));
    const { checksum, ...rest } = json;
    check('the downloaded file parses, matches its checksum and agrees with the page (copy, image digest, approvals)', Boolean(file) && checksum?.value === sha256(canonical(rest)) && d.includes(json.currentRevision.text) && d.includes(json.image.sha256) && json.recordedEvents.events.filter((e) => e.type === 'approved').length === 2);
  });

  const totalMs = Math.round(performance.now() - T0);
  check('browser console is clean (expected 401/403/409 network lines excluded)', b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));

  // ===== the honest numbers =====
  const report = {
    kind: 'SCRIPTED, AUTOMATED rehearsal. Not a human study. Not a measure of human time. Not a spoken-demo length.',
    ranAt: new Date().toISOString(),
    steps: log.steps.map((s) => ({ title: s.title, actor: s.actor, actions: s.actions, automatedMs: s.ms, checks: s.checks.length, allPassed: s.checks.every((c) => c.ok) })),
    totalActions: log.actions,
    signIns: log.signIns,
    actionsSpentOnSigningIn: log.signInActions,
    actionsExcludingSigningIn: log.actions - log.signInActions,
    actionsByKind: log.byKind,
    actionsByActor: log.byActor,
    automatedWallClockMs: totalMs,
    note: 'An action is one fill, click, select, key press, file choice or address change. Wall-clock includes fixed sleeps (600 to 1300 ms per action) that let the page settle, and four sign-ins. Setup (accounts, source version 1, links) is not counted.',
    screenshots: (await readdir(outDir)).filter((n) => n.endsWith('.png')).sort(),
    checksPassed: results.filter(Boolean).length,
    checksTotal: results.length,
  };
  await writeFile(path.join(outDir, 'rehearsal-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nSCRIPTED run: ${report.totalActions} automated actions (${report.actionsExcludingSigningIn} excluding ${report.signIns} sign-ins) in ${(totalMs / 1000).toFixed(1)} s of wall-clock (includes fixed waits), by actor ${JSON.stringify(report.actionsByActor)}. Not a human or spoken-demo measurement.`);
  for (const s of report.steps) console.log(`  ${String(s.actions).padStart(3)} actions  ${(s.automatedMs / 1000).toFixed(1).padStart(5)} s  ${s.title}`);
} catch (e) {
  check('rehearsal ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
