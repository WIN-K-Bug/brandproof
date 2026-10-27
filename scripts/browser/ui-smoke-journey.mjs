// Browser proof of the optional "Try an evidence change" journey in the isolated judge demo, at desktop width and at 390 and 320 px.
// Each context is a separate browser profile, so each is a separate visitor (own cookie, own session) against ONE demo server. In each one, through
// the real UI (clicks, the form fields, real key presses on the role picker):
//   find the optional action in the guide -> start it -> the sample campaign is Approved on version 1 -> the Manager previews the source change
//   (nothing is written) -> activates version 2 -> the approval is stale and approving is blocked -> the Manager repairs the facts -> the Creator
//   corrects the copy and requests review -> the Reviewer approves -> the dossier keeps the decisions -> a reload keeps all of it.
// Optional model and OCR are off (the deployed profile). A clock the script owns is not needed: nothing here waits for an expiry.
// The timings printed at the end are of an AUTOMATED script (fixed sleeps let the page settle). They are not a user study and not a measure of how
// long a person needs. Screenshots: docs/evidence/journey-*.png. Needs Edge or Chrome. An engineering check, not an accessibility audit.
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createJudgeDemo } from '../../src/judge.js';
import { BAT8, SHEET_V2 } from '../../src/scenario.js';
import { launch } from './cdp.mjs';

const shots = path.join(process.cwd(), 'docs', 'evidence');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  ${detail}` : ''}`);
};
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-journey-'));
const demo = await createJudgeDemo({ root: path.join(tmp, 'root'), semantic: null, ocr: null, ephemeral: true });
const base = await demo.listen(0);

/** One digest of every stored workspace file in the demo root: it moves if anything anywhere is written. */
async function storedDigest() {
  const dir = path.join(tmp, 'root', 'sessions');
  const h = createHash('sha256');
  for (const s of (await readdir(dir)).sort()) {
    try { h.update(s).update(await readFile(path.join(dir, s, 'workspace.json'))); } catch {}
  }
  return h.digest('hex');
}

const CONTEXTS = [
  { label: 'desktop', w: 1440, h: 900, mobile: false, port: 9391 },
  { label: '390', w: 390, h: 844, mobile: true, port: 9392 },
  { label: '320', w: 320, h: 760, mobile: true, port: 9393 },
];
const timings = [];

async function journey({ label, w, h, mobile, port }) {
  const at = `${label}`;
  let b;
  const t0 = Date.now();
  let actions = 0;
  try {
    b = await launch(`${base}/`, { width: w, height: h, port });
    if (mobile) {
      await b.viewport(w, h, true);
      await b.eval('location.reload()');
    }
    await b.wait(2400);
    const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
    const main = () => text('main');
    const sideways = () => b.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    const hash = () => b.eval('location.hash');
    const waitFor = async (re, sel = 'dialog') => {
      for (let i = 0; i < 48; i++) {
        if (re.test(await text(sel))) return true;
        await b.wait(250);
      }
      return false;
    };
    const clickIn = async (scope, label2) => {
      actions++;
      const ok = await b.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim() === ${JSON.stringify(label2)}); if (!el) return false; el.click(); return true; })()`);
      await b.wait(700);
      return ok;
    };
    const dialogOk = async () => { actions++; await b.click('dialog .dlg-f .btn.primary'); await b.wait(500); };
    const go = async (hh) => { actions++; await b.eval(`location.hash = ${JSON.stringify(hh)}`); await b.wait(1100); };
    const shot = (name) => b.shot(path.join(shots, `journey-${label}-${name}.png`));
    const roleKey = async (key, expect) => {
      actions++;
      await b.eval(`document.getElementById('role').focus()`);
      await b.key(key);
      await b.wait(900);
      const v = await b.eval(`document.getElementById('role').value`);
      check(`${at}: the real key ${key} on the role picker switches to ${expect} (a simulation, no sign-in)`, v === expect, v);
    };
    const row = () => text('#jg-scenario');
    const noSideways = async (what) => check(`${at}: ${what}: no sideways page scroll`, (await sideways()) <= 0, String(await sideways()));

    // ---- 1. discover it from the app entry, as a fresh visitor with nothing started ----
    const entry = await b.eval(`(() => { const e = document.getElementById('scenario-entry'); if (!e) return null; const r = e.getBoundingClientRect(); return { text: e.textContent.trim(), top: Math.round(r.top + scrollY), viewport: innerHeight, inGuide: !!e.closest('#judge-guide') }; })()`);
    check(`${at}: a fresh visitor finds the optional "Try an evidence change" action beside "New submission", and the guide shows no progress of anyone else's`, entry?.text === 'Try an evidence change' && (await b.eval(`document.getElementById('jg-scenario').hidden`)) === true, JSON.stringify(entry));
    check(`${at}: the action is within two screens of the top of the page (${entry?.top}px from the top, screen ${entry?.viewport}px)`, !!entry && entry.top < entry.viewport * 2, JSON.stringify(entry));
    check(`${at}: keyboard Tab reaches the action`, (await b.tabTo(`(e) => !!e && e.id === 'scenario-entry'`, { max: 60 })) >= 0);
    await noSideways('first screen');
    await b.eval(`document.getElementById('scenario-entry').scrollIntoView({ block: 'center' })`);
    await shot('1-initial');

    // ---- 2. start it (Enter on the focused button), read what it will do, confirm ----
    actions++;
    await b.key('Enter');
    check(`${at}: the dialog says what is added, that the approval is sample history, that your work is kept and that Re-review required will show`, await waitFor(/sample history/i) && /Your own campaigns, comments and images are kept/.test(await text('dialog')) && /Re-review required/.test(await text('dialog')) && /Reset my demo/.test(await text('dialog')));
    await clickIn('dialog[open] button', 'Start the scenario');
    check(`${at}: starting opens the scenario campaign, Approved against version 1`, await waitFor(/Aurora battery launch/, 'h1') && (await hash()) === '#/workspace/SUB-4' && /Approved/.test(await text('.ws-title')), `${await hash()} ${await text('.ws-title')}`);
    check(`${at}: the guide now shows one next step (preview what version 2 would change) instead of a list of instructions`, await waitFor(/waiting for a Manager/, '#jg-scenario') && (await b.eval(`[...document.querySelectorAll('#jg-scenario a')].map((a) => a.textContent.trim())`)).join() === 'Preview what version 2 would change', await row());
    actions++;
    await b.click('#tab-side-history');
    await b.wait(500);
    check(`${at}: the preloaded approval is labelled as sample history, not as something you did`, /Sample history in the fictional scenario, not a decision you made/.test(await main()) || (await b.eval(`document.body.innerText.includes('Sample history in the fictional scenario')`)));
    await noSideways('the scenario campaign');
    await shot('2-started');
    actions++;
    await b.click('#tab-side-findings'); // the side panel keeps the tab last chosen; the findings are needed again below
    await b.wait(400);

    // ---- 3. the Manager previews version 2 (nothing is written) ----
    await roleKey('ArrowDown', 'manager');
    await b.eval(`document.getElementById('jg-scenario').scrollIntoView({ block: 'center' })`);
    actions++;
    await b.click('#jg-scenario a');
    await b.wait(1300);
    check(`${at}: the guide's link opens version 2 of the fact sheet`, /#\/sources\/SRC-1\/2/.test(await hash()), await hash());
    const digestBefore = await storedDigest();
    actions++;
    await b.click('Preview impact…');
    check(`${at}: the preview names what changes: the old and new battery lines, the cited facts, and the approved campaign that will need re-review`, await waitFor(/replacing version 1/));
    const p = await text('dialog');
    check(`${at}: it shows up to 12 hours becoming up to 8 hours, FCT-001, one approved campaign needing re-review, and says nothing was saved`, /up to 12 hours/.test(p) && /up to 8 hours/.test(p) && /FCT-001/.test(p) && /1 approved campaign will show Re-review required/.test(p) && /Nothing has been saved, relinked, approved or rewritten/.test(p), p.slice(0, 300));
    check(`${at}: looking wrote nothing anywhere in the demo's stored data`, (await storedDigest()) === digestBefore);
    await shot('3-impact');
    await b.click('Close');

    // ---- 4. the deliberate action: activate version 2 ----
    actions++;
    await b.click('Approve version…');
    check(`${at}: the approve dialog loads the same preview`, await waitFor(/Rules and facts that cite this source \(3\)/));
    await b.eval(`document.getElementById('sa-read').click()`);
    await dialogOk();
    await b.wait(1000);
    check(`${at}: version 2 is now in force`, /v2 in force/.test(await main()), (await main()).slice(0, 200));

    // ---- 5. the approval is stale at once, and a fresh approval is blocked ----
    await go('#/workspace/SUB-4');
    check(`${at}: Re-review required, with the registered evidence named as the reason`, /Re-review required/.test(await text('.ws-title')) && /registered source evidence changed/.test(await main()), await text('.ws-title'));
    check(`${at}: the guide explains why, from the stored state, and offers the repair`, /no longer applies/.test(await row()) && (await b.eval(`[...document.querySelectorAll('#jg-scenario a')].map((a) => a.textContent.trim())`)).join() === 'Relink the facts to the new version', await row());
    await noSideways('the stale campaign');
    await shot('4-stale');
    await roleKey('Home', 'creator');
    await go('#/workspace/SUB-4');
    actions++;
    await b.click('Request review');
    await b.wait(900);
    await roleKey('End', 'reviewer');
    await go('#/workspace/SUB-4');
    check(`${at}: in review again, but Approve is disabled because the cited evidence is no longer in force`, (await b.eval(`[...document.querySelectorAll('.flow button')].find((x) => x.textContent.startsWith('Approve')).disabled`)) && /no longer in force/.test(await text('.flow')), await text('.flow'));

    // ---- 6. the repair: the Manager relinks the facts to version 2 and corrects the battery fact ----
    await roleKey('ArrowUp', 'manager');
    await go('#/library');
    check(`${at}: the library shows the repair panel for the three broken links`, /3 rules cite evidence that is no longer in force/.test(await main()), (await main()).slice(0, 200));
    await shot('5-repair');
    await b.eval(`[...document.querySelectorAll('.notice.warn li')].find((li) => li.textContent.includes('FCT-001')).querySelectorAll('button')[1].click()`);
    await b.wait(800);
    await b.type('#f-val', '8');
    await b.type('#f-stmt', BAT8);
    await b.select('#f-src', 'SRC-1');
    await b.wait(700);
    const start = SHEET_V2.indexOf(BAT8);
    await b.eval(`(() => { const pre = document.getElementById('f-pre'); const node = pre.firstChild; const r = document.createRange(); r.setStart(node, ${start}); r.setEnd(node, ${start + BAT8.length}); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); pre.dispatchEvent(new Event('mouseup', { bubbles: true })); })()`);
    await b.wait(400);
    await b.click('Use selected passage');
    check(`${at}: the exact new passage is previewed before saving`, (await text('dialog blockquote')).includes(BAT8));
    await dialogOk();
    await b.wait(700);
    for (const id of ['FCT-002', 'FCT-004']) {
      await b.eval(`[...document.querySelectorAll('.notice.warn li')].find((li) => li.textContent.includes(${JSON.stringify(id)})).querySelectorAll('button')[0].click()`);
      await b.wait(800);
    }
    actions++;
    await b.click('Publish new version');
    await b.wait(1200);
    check(`${at}: the guidelines are republished and the repair panel is gone`, /Guidelines v3/.test(await main()) && !/no longer in force/.test(await main()), (await main()).slice(0, 160));
    await noSideways('the library after the repair');

    // ---- 7. the Creator corrects the copy (the old copy now contradicts the fact) and requests review ----
    await roleKey('Home', 'creator');
    await go('#/workspace/SUB-4');
    check(`${at}: the previously approved wording is now a blocking contradiction`, /Contradicts approved fact: Battery life/.test(await main()), (await main()).replace(/\s+/g, ' ').slice(0, 500));
    actions++;
    await b.click('Apply in new draft');
    await b.wait(900);
    check(`${at}: the safe correction proposes the 8-hour wording`, (await b.eval(`document.querySelector('#draft-text').value`)) === BAT8);
    actions++;
    await b.click('Save as revision 2');
    await b.wait(1200);
    actions++;
    await b.click('Request review');
    await b.wait(1000);
    check(`${at}: the corrected revision is In review with the retained image carried over`, /In review/.test(await text('.ws-title')) && /Retained image/.test(await main()), `${await text('.ws-title')} | ${(await main()).replace(/\s+/g, ' ').slice(0, 260)}`);

    // ---- 8. the Reviewer decides ----
    await roleKey('End', 'reviewer');
    await go('#/workspace/SUB-4');
    actions++;
    await b.click('Approve…');
    await dialogOk();
    await b.wait(1100);
    check(`${at}: Approved again, no longer Re-review required`, /Approved/.test(await text('.ws-title')) && !/Re-review/.test(await text('.ws-title')), await text('.ws-title'));
    check(`${at}: the guide says it is done and points to the dossier`, (await waitFor(/Approved again on version 2/, '#jg-scenario')) && (await b.eval(`[...document.querySelectorAll('#jg-scenario a')].map((a) => a.textContent.trim())`)).join() === 'Open the review dossier', await row());

    // ---- 9. the dossier keeps both decisions; a reload keeps everything ----
    actions++;
    await b.click('#jg-scenario a');
    await b.wait(1400);
    const dz = await main();
    check(`${at}: the dossier shows Approved, the cited NEW passage, recorded decisions apart from findings recomputed today`, /Approved/.test(await text('section[aria-labelledby="dz-status"]')) && dz.includes(BAT8) && /Recorded/.test(dz) && /Recomputed/.test(dz), dz.slice(0, 200));
    const both = await b.eval(`(async () => { const r = await fetch('/api/submissions/SUB-4/dossier', { headers: { 'x-demo-role': 'reviewer' } }); const d = await r.json(); const a = d.recordedEvents.events.filter((e) => e.type === 'approved'); return { n: a.length, differ: a[0]?.binding?.evidenceHash !== a[1]?.binding?.evidenceHash, firstMatches: a[0]?.bindingComparedWithCurrentInputs?.matches, secondMatches: a[1]?.bindingComparedWithCurrentInputs?.matches, sample: /Sample history/.test(a[0]?.note ?? '') }; })()`);
    check(`${at}: the dossier's data holds both approvals with different evidence bindings (the first no longer matches, the second does) and the first is marked as sample history`, both.n === 2 && both.differ && both.firstMatches === false && both.secondMatches === true && both.sample, JSON.stringify(both));
    await noSideways('the dossier');
    await shot('6-dossier');
    await b.eval('location.reload()');
    await b.wait(2600);
    check(`${at}: after a reload the same session still has the finished scenario`, /Approved again on version 2/.test(await row()) && /Aurora Lamp|Aurora battery/.test(await text('h1') + ' ' + await main()), await row());
    check(`${at}: the browser console is clean (apart from the refused requests the story causes on purpose)`, b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, JSON.stringify(b.consoleMsgs.slice(0, 3)));
  } catch (e) {
    check(`${at}: the journey ran to the end`, false, e.stack ?? e.message);
  } finally {
    await b?.close();
    timings.push(`${label}: ${actions} automated actions in ${Math.round((Date.now() - t0) / 1000)} s (fixed sleeps let the page settle; not a measure of how long a person needs)`);
  }
}

try {
  for (const c of CONTEXTS) if (!process.env.JOURNEY_ONLY || process.env.JOURNEY_ONLY === c.label) await journey(c);
  // each context was its own visitor: three separate scenarios exist, none visible to another
  const dir = path.join(tmp, 'root', 'sessions');
  if (!process.env.JOURNEY_ONLY) check('three browser profiles made three separate sessions', (await readdir(dir)).length === 3, String((await readdir(dir)).length));
} catch (e) {
  check('journey walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await demo.close();
  await rm(tmp, { recursive: true, force: true });
}
console.log(`\nAutomated timings (an engineering measure of a script, NOT a user study):\n  ${timings.join('\n  ')}`);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (journey-*.png)`);
process.exit(failed ? 1 : 0);
