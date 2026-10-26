// Judge-demo browser proof: TWO independent browser instances (separate profiles, so separate cookie jars) against ONE demo server, at desktop
// and narrow widths, driven through the real UI. The demo runs with the optional model and OCR switched off (the fallback), on a temp root,
// with a clock the script can move to show expiry. Everything is fictional; nothing outside the temp root is read or written.
// Needs Edge or Chrome. An engineering check, not an accessibility audit.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJudgeDemo } from '../../src/judge.js';
import { launch } from './cdp.mjs';

const shots = path.join(process.cwd(), 'docs', 'evidence');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  ${detail}` : ''}`);
};
const MIN = 60_000;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-judgeui-'));
let offset = 0;
const clock = () => Date.now() + offset;
const demo = await createJudgeDemo({ root: path.join(tmp, 'root'), semantic: null, ocr: null, clock, ephemeral: true }); // the free-hosting profile: storage is temporary
const base = await demo.listen(0);
let full;
let A;
let B;
try {
  A = await launch(`${base}/`, { width: 1440, height: 900, port: 9361 });
  B = await launch(`${base}/`, { width: 1440, height: 900, port: 9362 });
  await B.viewport(390, 844, true); // B starts narrow, A starts wide
  await B.eval('location.reload()'); // a phone loads the page at its own width (the guide's first state depends on it)
  await Promise.all([A.wait(1800), B.wait(2600)]);
  const text = (b, sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const overflow = (b) => b.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  const titles = (b) => b.eval(`[...document.querySelectorAll('.ws-head select option')].map((o) => o.textContent)`);
  const clickIn = (b, scope, label) => b.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!el) return false; el.click(); return true; })()`);
  const hash = async (b, h) => { await b.eval(`location.hash = ${JSON.stringify(h)}`); await b.wait(1000); };
  const createSubmission = async (b, name, copy) => {
    await b.click('+ New submission');
    await b.type('#nt', name);
    await b.type('#nx', copy);
    check(`"${name}": the Create button is in the dialog`, await clickIn(b, 'dialog[open] button', 'Create'));
    await b.wait(1500);
  };

  // ---- 1. what a visitor sees first: fictional data, a separate session, simulated roles, how to start (honest wording, compact guide) ----
  // Claims that would be false for a hosted demo (what is typed IS sent to, and stored on, the server that runs it) must not appear anywhere.
  const FALSE_CLAIMS = [/nothing is sent anywhere/i, /nobody else could see/i, /only this browser can see/i, /private to this browser/i, /private to one browser/i, /cannot see it/i];
  const honest = async (b, label) => {
    const where = (await text(b, '#banner')) + ' ' + (await text(b, '#judge-guide')) + ' ' + (await b.eval(`document.querySelector('.jg-more')?.textContent ?? ''`));
    check(`${label}: no claim that is false for a hosted demo (nothing "sent anywhere", "nobody else could see", "only this browser can see", "private to this browser")`, !FALSE_CLAIMS.some((re) => re.test(where)), where.slice(0, 160));
  };
  for (const [label, b] of [['desktop context A', A], ['narrow context B (390 px)', B]]) {
    const banner = await text(b, '#banner');
    check(`${label}: the top strip says it is your own demo session, fictional data only and nothing confidential, roles a simulation not sign-in, and when it ends`, /Demo session/.test(banner) && /Your own demo session: fictional data only, nothing confidential/.test(banner) && /Roles are a simulation, not sign-in/.test(banner) && /Ends about/.test(banner), banner);
    const visible = await text(b, '#judge-guide .jg-steps');
    check(`${label}: the three steps are visible at once: add content, read the findings, record a decision`, (await b.eval(`document.querySelectorAll('#judge-guide .jg-steps li').length`)) === 3 && /Add content/.test(visible) && /Read the findings/.test(visible) && /Record a decision/.test(visible), visible);
    check(`${label}: the fictional-data and no-confidential-information line is visible without opening anything`, /Fictional data only: do not enter confidential information/.test(await text(b, '#judge-guide .jg-fiction')));
    await honest(b, label);
    check(`${label}: the role picker is labelled as a simulation (the "demo role" tag and the strip), and there is no sign-in form`, (await b.eval(`!!document.getElementById('role') && /demo role/.test(document.getElementById('role-picker').innerText) && !document.getElementById('si-user')`)));
    check(`${label}: the seeded fictional campaign is open (a workspace the visitor can act on at once)`, /Aurora Lamp/.test(await text(b, 'h1')));
  }
  // progressive disclosure: open on a wide screen, closed on a phone, and the full instructions are all still there when opened
  check('desktop: "More detail" starts open, with the fuller instructions and the storage and simulation notes', (await A.eval(`document.querySelector('.jg-more').open`)) === true && /Edit as new revision/.test(await text(A, '.jg-more')) && /stored on the demo server in a session separate from other visitors/.test(await text(A, '.jg-more')) && /This is a temporary demo: everything is also lost if the demo server restarts or sleeps/.test(await text(A, '.jg-more')) && /not sign-in/.test(await text(A, '.jg-more')));
  check('390 px: "More detail" starts closed (compact), and nothing was removed: opening it shows every instruction', (await B.eval(`document.querySelector('.jg-more').open`)) === false && (await B.eval(`(() => { const d = document.querySelector('.jg-more'); d.open = true; const t = d.innerText; d.open = false; return /New submission/.test(t) && /exact source passage/.test(t) && /Request review/.test(t) && /Reviewer/.test(t) && /re-review required/.test(t) && /stored on the demo server in a session separate from other visitors/.test(t) && /not sign-in/.test(t); })()`)));
  const footprint = async (b) => b.eval(`(() => { const g = document.getElementById('judge-guide').getBoundingClientRect(); const steps = document.querySelectorAll('#judge-guide .jg-steps li'); const last = steps[steps.length - 1].getBoundingClientRect(); const nav = document.getElementById('nav'); const tab = getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().height : 0; return { vh: innerHeight, guide: Math.round(g.height), pct: Math.round(g.height / innerHeight * 100), lastStepBottom: Math.round(last.bottom), usable: Math.round(innerHeight - tab) }; })()`);
  const fp390 = await footprint(B);
  check('390 px: the guide uses under two thirds of the screen (it was 120%) and all three steps are inside the first screen above the tab bar', fp390.pct <= 65 && fp390.lastStepBottom <= fp390.usable, JSON.stringify(fp390));
  await A.shot(path.join(shots, 'judge-A-desktop-start.png'));
  await B.shot(path.join(shots, 'judge-B-390-start.png'));

  // ---- 2. A adds content and reads the explanation; B (a different browser) never sees it ----
  await createSubmission(A, 'A-ONLY campaign from context A', 'A full charge lasts 30 hours, and the lamp is waterproof.');
  check('A: the new campaign opens with blocking findings that explain themselves (claim, approved fact, source)', /A-ONLY campaign/.test(await text(A, 'h1')) && (await A.eval(`document.querySelectorAll('.finding.sev-error').length`)) >= 2 && (await A.eval(`document.querySelectorAll('.finding .evidence').length`)) >= 2);
  check('A: the decision panel is the walnut "not ready" band and Approve is unavailable while findings block it', (await A.eval(`document.querySelector('.flow')?.dataset.state`)) === 'blocked' && (await A.eval(`[...document.querySelectorAll('.flow button')].find((x) => /^Approve/.test(x.textContent))?.disabled`)) === true);
  await A.shot(path.join(shots, 'judge-A-desktop-findings.png'));
  await hash(B, '#/workspace');
  const bTitles = await titles(B);
  check('B: its campaign list holds only its own fictional campaigns, never A\'s', bTitles.length === 3 && !bTitles.some((t) => /A-ONLY/.test(t)), JSON.stringify(bTitles));
  await hash(B, '#/queue');
  check('B: the review queue does not list A\'s campaign either', !/A-ONLY/.test(await text(B, 'main')));
  await B.shot(path.join(shots, 'judge-B-390-own-queue.png'));

  // ---- 3. reload keeps the same session; the core path to a human decision and a stale approval ----
  await A.eval('location.reload()');
  await A.wait(2200);
  check('A: after a reload the same private session and its campaign are still there', /A-ONLY campaign/.test(await text(A, 'h1')) && (await titles(A)).some((t) => /A-ONLY/.test(t)));
  await A.click('Edit as new revision');
  await A.type('#draft-text', 'Meet the Aurora Lamp, a reading lamp made to be easy on the eyes. A full charge runs up to 12 hours.');
  await A.wait(1500);
  await A.click('Save as revision 2');
  await A.wait(1500);
  check('A: the corrected revision has no blocking findings, so a review can be requested', (await A.eval(`document.querySelectorAll('.finding.sev-error').length`)) === 0 && (await A.eval(`document.querySelector('.flow')?.dataset.state`)) === 'ready');
  await A.click('Request review');
  await A.wait(1500);
  await A.select('#role', 'reviewer');
  await A.wait(1200);
  await A.click('Approve…');
  await A.wait(900);
  await clickIn(A, 'dialog[open] button', 'Approve');
  await A.wait(1800);
  check('A: a human decision (a simulated Reviewer) records the approval, shown as an APPROVED verdict', (await A.eval(`document.querySelector('.flow')?.dataset.state`)) === 'approved', await text(A, '.flow'));
  await A.select('#role', 'creator');
  await A.wait(900);
  await A.click('Edit as new revision');
  await A.type('#draft-text', 'Meet the Aurora Lamp, a reading lamp made to be easy on the eyes. A full charge runs up to 12 hours. Quiet by design.');
  await A.wait(1500);
  await A.click('Save as revision 3');
  await A.wait(1800);
  check('A: changing the copy after approval turns it into "re-review required" (the approval no longer applies)', (await A.eval(`document.querySelector('.flow')?.dataset.state`)) === 'approval_stale' && /re-review|no longer applies/i.test(await text(A, '.flow')), await text(A, '.flow'));
  await A.shot(path.join(shots, 'judge-A-desktop-stale.png'));

  // ---- 4. B resets its own demo; A is untouched ----
  await hash(B, '#/workspace');
  await createSubmission(B, 'B-ONLY campaign from context B', 'Our lamp is the best reading light.');
  check('B: its own new campaign opens', /B-ONLY campaign/.test(await text(B, 'h1')));
  await B.click('Reset my demo');
  await B.wait(700);
  check('B: Reset my demo asks first and says it only clears this session', /clears everything in your demo session/.test(await text(B, 'dialog[open]')) && /Other visitors’ sessions are not affected/.test(await text(B, 'dialog[open]')));
  await B.shot(path.join(shots, 'judge-B-390-reset-dialog.png'));
  await clickIn(B, 'dialog[open] button', 'Reset my demo');
  await B.wait(2500);
  check('B: after the reset it is back to the original fictional campaigns', (await titles(B)).length === 3 && !(await titles(B)).some((t) => /B-ONLY/.test(t)));
  check('A: unaffected by B\'s reset (its campaign and its stale approval are still there)', (await titles(A)).some((t) => /A-ONLY/.test(t)) && (await A.eval(`document.querySelector('.flow')?.dataset.state`)) === 'approval_stale');

  // ---- 5. widths are swapped: each context also proves the other layout ----
  await A.viewport(390, 844, true);
  await B.viewport(1440, 900, false);
  await Promise.all([A.wait(900), B.wait(900)]);
  await A.eval(`location.hash = '#/workspace'`);
  await A.wait(1000);
  check('A at 390 px: no sideways scroll, the banner, guide and tab bar are all present', (await overflow(A)) <= 0 && /Demo session/.test(await text(A, '#banner')) && (await A.eval(`getComputedStyle(document.getElementById('nav')).position`)) === 'fixed', String(await overflow(A)));
  check('B at 1440 px: no sideways scroll, banner and guide present', (await overflow(B)) <= 0 && /Demo session/.test(await text(B, '#banner')) && (await B.eval(`!document.getElementById('judge-guide').hidden`)), String(await overflow(B)));
  await A.shot(path.join(shots, 'judge-A-390-after-swap.png'));
  await B.shot(path.join(shots, 'judge-B-desktop-after-swap.png'));
  await A.viewport(320, 760, true);
  await A.wait(900);
  check('A at 320 px: no sideways scroll', (await overflow(A)) <= 0, String(await overflow(A)));
  await A.eval(`location.reload()`);
  await A.wait(2200);
  const fp320 = await footprint(A);
  check('320 px: the guide uses under two thirds of the screen (it was 178%) and all three steps are inside the first screen above the tab bar', fp320.pct <= 65 && fp320.lastStepBottom <= fp320.usable, JSON.stringify(fp320));
  await honest(A, 'A at 320 px');
  await A.shot(path.join(shots, 'judge-A-320.png'));
  await A.viewport(1440, 900, false);
  await B.viewport(390, 844, true);
  await Promise.all([A.wait(700), B.wait(700)]);

  // ---- 5b. keyboard: the guide and the About text can be reached and used with real key presses (context B, 390 px) ----
  await hash(B, '#/workspace');
  await B.eval('window.scrollTo(0, 0); document.activeElement?.blur()');
  const toSummary = await B.tabTo(`(e) => !!e && e.tagName === 'SUMMARY' && !!e.closest('#judge-guide')`, { max: 40 });
  check('keyboard: Tab reaches "More detail" in the guide', toSummary >= 0, String(toSummary));
  const ring = await B.eval(`(() => { const st = getComputedStyle(document.activeElement); return { style: st.outlineStyle, width: parseFloat(st.outlineWidth) }; })()`);
  check('keyboard: it shows a visible focus ring (solid, at least 2 px)', ring.style === 'solid' && ring.width >= 2, JSON.stringify(ring));
  await B.key('Enter');
  await B.wait(300);
  check('keyboard: Enter opens "More detail" and the fuller instructions are then readable', (await B.eval(`document.querySelector('.jg-more').open`)) === true && /Edit as new revision/.test(await text(B, '.jg-more')));
  await B.key('Enter');
  await B.wait(300);
  check('keyboard: Enter closes it again', (await B.eval(`document.querySelector('.jg-more').open`)) === false);
  const toHide = await B.tabTo(`(e) => !!e && e.tagName === 'BUTTON' && e.textContent.trim() === 'Hide' && !!e.closest('#judge-guide')`, { max: 12, shift: true });
  await B.key('Enter');
  await B.wait(400);
  check('keyboard: the Hide button is reachable and hides the guide', toHide >= 0 && (await B.eval(`document.getElementById('judge-guide').hidden`)) === true, String(toHide));
  const toHow = await B.tabTo(`(e) => !!e && e.tagName === 'BUTTON' && e.textContent.trim() === 'How to try it'`, { max: 12, shift: true });
  await B.key('Enter');
  await B.wait(400);
  check('keyboard: "How to try it" in the top strip brings the guide back (nothing is lost by hiding it)', toHow >= 0 && (await B.eval(`document.getElementById('judge-guide').hidden`)) === false, String(toHow));
  const toAbout = await B.tabTo(`(e) => !!e && e.tagName === 'BUTTON' && /About/.test(e.textContent)`, { max: 6 });
  await B.key('Enter');
  await B.wait(600);
  const aboutText = await B.eval(`document.querySelector('dialog[open]')?.innerText ?? ''`);
  check('keyboard: About & limits opens, and its judge-demo lines are honest: fictional data only, sent to and stored on the server, separate from other visitors but readable by whoever operates it, a stolen cookie acts as the session, "this computer" means the server', toAbout >= 0 && /do not enter confidential or personal information/.test(aboutText) && /sent to the server that runs this demo and stored there, as plain files/.test(aboutText) && /kept separate from yours, but the people who operate the server can read them/.test(aboutText) && /anyone who obtains this browser’s cookie can act as this session/.test(aboutText) && /“this computer” means the server that runs this demo/.test(aboutText) && /simulation of different people/.test(aboutText) && /temporary demo on temporary storage: a session, and everything in it, is lost when the demo server restarts, sleeps or is redeployed/.test(aboutText) && !FALSE_CLAIMS.some((re) => re.test(aboutText)) && !/nothing is sent anywhere/i.test(aboutText), aboutText.slice(0, 240));
  await B.shot(path.join(shots, 'judge-B-390-about-honest.png'));
  await B.key('Escape');
  await B.wait(400);

  // ---- 6. a session that ends says so and offers the way back (B stays alive; only the idle one ends) ----
  offset += 100 * MIN;
  await hash(B, '#/queue'); // B is active at +100 min, so its idle window restarts
  offset += 30 * MIN; // A has now been idle 130 minutes, B 30
  await A.click('Review queue'); // any request: the session is gone
  await A.wait(1500);
  const ended = await text(A, '#main');
  check('A: its idle session ended, and the page says so plainly (no silent empty workspace) with a way back', /This demo session has ended/.test(ended) && /belongs to one browser/.test(ended) && !/nobody else could see/i.test(ended) && /removes expired sessions’ data/.test(ended) && /this temporary demo loses its sessions when the service restarts or sleeps/.test(ended) && /Start a new demo session/.test(ended), ended.slice(0, 160));
  check('A: the top strip also says the session ended (and shows no stray "null" from a missing button)', /Session ended/.test(await text(A, '#banner')) && !/null/i.test(await text(A, '#banner')), await text(A, '#banner'));
  await A.shot(path.join(shots, 'judge-A-desktop-session-ended.png'));
  await hash(B, '#/workspace');
  check('B: still alive (it was active, A\'s idleness did not end it)', !/This demo session has ended/.test(await text(B, '#main')) && /Demo session/.test(await text(B, '#banner')));
  await A.click('Start a new demo session');
  await A.wait(2500);
  await hash(A, '#/workspace'); // the reload kept the Review queue page; the campaign list is on the workspace page
  const restarted = { banner: await text(A, '#banner'), titles: await titles(A), main: (await text(A, '#main')).slice(0, 80) };
  check('A: starting again gives a brand-new private session, says the earlier one had ended, and has only fresh fictional data', /earlier session had ended/.test(restarted.banner) && restarted.titles.length === 3 && !restarted.titles.some((t) => /A-ONLY/.test(t)), JSON.stringify(restarted));
  await A.shot(path.join(shots, 'judge-A-desktop-new-session.png'));

  // ---- 7. the demo is at capacity: a clear page, not a hang ----
  full = await createJudgeDemo({ root: path.join(tmp, 'root-full'), semantic: null, ocr: null, clock, limits: { maxSessions: 1 } });
  const fullBase = await full.listen(0);
  await A.goto(`${fullBase}/`);
  await A.wait(1200);
  check('capacity: the first visitor gets a session', /Demo session/.test(await text(A, '#banner')));
  await B.goto(`${fullBase}/`);
  await B.wait(1200);
  const fullPage = await text(B, 'body');
  check('capacity: the next visitor (a different browser) sees a clear "demo is full" page with when to retry, and no session', /The demo is full/.test(fullPage) && /try again later/i.test(fullPage) && /each visitor's session is kept separate/.test(fullPage) && !/private to one browser/i.test(fullPage));
  check('capacity: that page fits the narrow screen without sideways scroll', (await overflow(B)) <= 0);
  await B.shot(path.join(shots, 'judge-B-390-demo-full.png'));

  // ---- 8. nothing went wrong in either browser ----
  const noise = /40[1239]|50[03]|Failed to load resource/;
  check('both consoles are clean (apart from the expected refused requests)', A.consoleMsgs.filter((m) => !noise.test(m)).length === 0 && B.consoleMsgs.filter((m) => !noise.test(m)).length === 0, JSON.stringify([...A.consoleMsgs, ...B.consoleMsgs].filter((m) => !noise.test(m)).slice(0, 4)));
} catch (e) {
  check('judge browser proof ran to the end', false, e.stack ?? e.message);
} finally {
  await A?.close();
  await B?.close();
  await full?.close();
  await demo.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (judge-*.png)`);
process.exit(failed ? 1 : 0);
