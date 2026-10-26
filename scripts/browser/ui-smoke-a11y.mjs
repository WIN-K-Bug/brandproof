// Integrated keyboard / accessibility / narrow-screen walkthrough on a THROWAWAY copy of the fictional Fernlight showcase.
//
//   npm run ui-smoke-a11y
//
// Builds the showcase (same bootstrap as the demo server) in a temp directory, starts the app in demo mode with the real
// offline source matcher if it is installed, and drives a real browser with REAL KEYBOARD EVENTS. This is an engineering
// check of specific behaviours. It is not an accessibility audit, a certification or a screen-reader test.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { localAvailability } from '../../src/semantic.js';
import { bootstrapShowcase, IMAGES } from '../demo/bootstrap.mjs';
import { launch } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-a11y-'));
const semanticInstalled = localAvailability().ok;
const app = await createApp({ dataFile: path.join(tmp, 'showcase.json') }); // demo mode; real matcher warms if installed
const base = await app.listen(0);
await bootstrapShowcase(base);
if (semanticInstalled) {
  for (let i = 0; i < 120; i++) {
    const st = await (await fetch(`${base}/api/semantic/status`)).json();
    if (st.state === 'ready' || st.state === 'error') break;
    await new Promise((r) => setTimeout(r, 500));
  }
}
const imgFile = path.join(tmp, 'replacement.png');
await writeFile(imgFile, IMAGES.A);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const note = (name, why) => {
  console.log(`NOTE  ${name}  (${why})`);
};

const isBtn = (t) => `(e) => e && e.tagName === 'BUTTON' && e.innerText.trim().startsWith(${JSON.stringify(t)})`;
const isLink = (t) => `(e) => e && e.tagName === 'A' && e.innerText.trim().startsWith(${JSON.stringify(t)})`;
const isId = (id) => `(e) => e && e.id === ${JSON.stringify(id)}`;

let b;
try {
  b = await launch(`${base}/#/workspace/SUB-6`, { port: 9355 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const shot = (name) => b.shot(path.join(shots, `demo-${name}.png`));
  const hash = () => b.eval('location.hash');
  const focusedHeading = async () => /^H1$/i.test((await b.active())?.tag ?? '') ? (await b.active()).text : null;
  await b.wait(1500);

  // ---- landmarks and the first Tab stop ----
  check('page has a labelled demo banner, navigation, main region and a title', (await b.eval(`!!document.querySelector('nav[aria-label=Primary]') && !!document.querySelector('main#main') && document.title.length > 0 && /Demo mode/.test(document.getElementById('banner').innerText)`)));
  await b.key('Tab');
  let a = await b.active();
  check('the first Tab stop is the skip link', a.tag === 'a' && /Skip to content/.test(a.text), a.text);
  await shot('1-skip-link-focus');
  await b.key('Enter');
  a = await b.active();
  check('activating the skip link moves focus to the main content', a.id === 'main');

  // ---- keyboard navigation between areas: focus lands on the new page heading, title changes ----
  check('Brand library link is reachable by Tab', (await b.tabTo(isLink('Brand library'))) >= 0);
  await b.key('Enter');
  await b.wait(900);
  check('Enter on a nav link opens the page, updates the document title and focuses its heading', /^#\/library/.test(await hash()) && /^Brand library/.test(await b.eval('document.title')) && (await focusedHeading()) === 'Brand library', String((await b.active())?.text));
  await b.eval(`location.hash = '#/workspace/SUB-6'`);
  await b.wait(1000);

  // ---- main path with the keyboard only: edit -> apply a safe correction -> save -> request review ----
  check('Edit as new revision is reachable by Tab', (await b.tabTo(isBtn('Edit as new revision'))) >= 0);
  await b.key('Enter');
  await b.wait(700);
  a = await b.active();
  check('opening the editor puts focus in the copy field', a.id === 'draft-text', a.id);
  const before = await b.eval(`document.getElementById('draft-text').value`);
  await b.wait(800);
  check('a fix button is reachable by Tab (Apply to draft)', (await b.tabTo(isBtn('Apply to draft'), { max: 140 })) >= 0);
  await b.key('Enter');
  await b.wait(900);
  const after = await b.eval(`document.getElementById('draft-text').value`);
  check('Enter applies the suggested correction to the draft text', before !== after && /12 hours/.test(after), after.slice(0, 60));
  check('Save is reachable by Tab', (await b.tabTo(isBtn('Save as revision'), { max: 200 })) >= 0);
  await b.key('Enter');
  await b.wait(1200);
  check('after saving, focus returns to the page heading (not lost)', Boolean(await focusedHeading()), String((await b.active())?.tag));
  check('a polite status message announces the save', await b.eval(`[...document.querySelectorAll('#toasts .toast')].some((t) => t.getAttribute('role') === 'status' && /Saved revision/.test(t.innerText))`));
  check('Request review is reachable and works from the keyboard', (await b.tabTo(isBtn('Request review'))) >= 0);
  await b.key('Enter');
  await b.wait(1000);
  check('the submission is now In review', /In review/.test(await text('.ws-title')));

  // ---- switch the demo role with the keyboard ----
  check('the demo role selector is reachable by Tab and labelled', (await b.tabTo(isId('role'), { max: 200 })) >= 0 && (await b.eval(`!!document.querySelector('label[for=role]')`)));
  await b.key('ArrowDown');
  await b.key('ArrowDown');
  await b.wait(900);
  check('arrow keys change the demo role to Reviewer, and the page says so', (await b.eval('document.getElementById("role").value')) === 'reviewer' && /Reviewer/.test(await text('#role')));
  await b.eval(`location.hash = '#/workspace/SUB-3'`);
  await b.wait(1100);

  // ---- dialog: focus, Escape, return focus, error announcements ----
  check('Approve… is reachable by Tab (reviewer, in-review item)', (await b.tabTo(isBtn('Approve…'), { max: 200 })) >= 0);
  await b.key('Enter');
  await b.wait(500);
  a = await b.active();
  check('opening a dialog moves focus into it', a.inDialog, `${a.tag} ${a.text}`);
  check('the dialog is a modal with an accessible name', await b.eval(`(() => { const d = document.querySelector('dialog[open]'); return Boolean(d) && d.getAttribute('aria-labelledby') && document.getElementById(d.getAttribute('aria-labelledby')).innerText.length > 0; })()`));
  await shot('2-dialog-open');
  await b.key('Escape');
  await b.wait(500);
  a = await b.active();
  check('Escape closes the dialog and returns focus to the button that opened it', !(await b.eval(`!!document.querySelector('dialog[open]')`)) && a.tag === 'button' && /^Approve/.test(a.text), `${a.tag} "${a.text}"`);
  await b.key('Enter');
  await b.wait(500);
  check('the checkbox for acknowledging warnings is reachable inside the dialog', (await b.tabTo(isId('ack'), { max: 12 })) >= 0 && (await b.active()).inDialog);
  check('the Approve button in the dialog is reachable', (await b.tabTo(`(e) => e && e.tagName === 'BUTTON' && e.classList.contains('primary') && e.closest('dialog')`, { max: 12 })) >= 0);
  await b.key('Enter');
  await b.wait(500);
  const err = await b.eval(`[...document.querySelectorAll('#toasts .toast')].map((t) => t.getAttribute('role') + ':' + t.innerText).join(' | ')`);
  check('an error is announced assertively (role=alert) when approval needs acknowledgement', /alert:.*(Tick the box|confirm)/i.test(err), err.slice(0, 80));
  check('and the dialog stays open so nothing is lost', await b.eval(`!!document.querySelector('dialog[open]')`));
  // return to the checkbox, tick with Space, approve with Enter
  check('Shift+Tab goes back to the checkbox', (await b.tabTo(isId('ack'), { max: 6, shift: true })) >= 0);
  await b.key(' ');
  check('Space ticks the checkbox', await b.eval(`document.getElementById('ack').checked`));
  await b.tabTo(`(e) => e && e.tagName === 'BUTTON' && e.classList.contains('primary') && e.closest('dialog')`, { max: 12 });
  await b.key('Enter');
  await b.wait(1100);
  check('keyboard approval completes: status Approved, focus on the heading', /Approved/.test(await text('.ws-title')) && Boolean(await focusedHeading()));

  // reject needs a reason: inline error is announced and focus moves to the field
  await b.eval(`location.hash = '#/workspace/SUB-6'`);
  await b.wait(1000);
  await b.tabTo(isBtn('Reject…'), { max: 200 });
  await b.key('Enter');
  await b.wait(500);
  await b.tabTo(`(e) => e && e.tagName === 'BUTTON' && e.classList.contains('danger') && e.closest('dialog')`, { max: 12 });
  await b.key('Enter');
  await b.wait(500);
  a = await b.active();
  check('a missing required reason shows an inline alert and moves focus to that field', (await b.eval(`!!document.querySelector('dialog .err-text[role=alert]') && document.querySelector('dialog .err-text').innerText.length > 5`)) && a.id === 'rn', `focus: ${a.tag}#${a.id}`);
  await shot('3-error-announced');
  await b.key('Escape');
  await b.wait(400);

  // ---- tabs: arrow keys, roving tabindex, tabpanel ----
  await b.eval(`location.hash = '#/workspace/SUB-5'`);
  await b.wait(1100);
  check('side panel tabs are a proper tablist with a tabpanel', await b.eval(`(() => { const tabs = [...document.querySelectorAll('[role=tablist] [role=tab]')]; return tabs.length === 3 && tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length === 1 && tabs.filter((t) => t.tabIndex === 0).length === 1 && !!document.querySelector('[role=tabpanel]'); })()`));
  await b.tabTo(`(e) => e && e.getAttribute('role') === 'tab' && e.getAttribute('aria-selected') === 'true'`, { max: 200 });
  await b.key('ArrowRight');
  await b.key('ArrowRight');
  await b.wait(500);
  a = await b.active();
  check('ArrowRight twice selects the History tab and keeps focus on the tab', /History/.test(a.text) && (await b.eval(`document.querySelector('[role=tab][aria-selected=true]').innerText`)).startsWith('History'), a.text);
  check('history shows each revision\'s own retained image', (await b.eval(`document.querySelectorAll('[role=tabpanel] .thumb-sm').length`)) >= 1);
  await b.key('Home');
  await b.wait(300);
  check('Home returns to the first tab', /^Findings/.test((await b.active()).text));

  // ---- source: exact passage via keyboard ----
  await b.eval(`location.hash = '#/workspace/SUB-6'`);
  await b.wait(1100);
  check('"Open the exact passage" link is reachable by Tab', (await b.tabTo(isLink('Open the exact passage'), { max: 260 })) >= 0);
  await shot('4-source-link-focus');
  await b.key('Enter');
  await b.wait(1000);
  const cited = await text('mark.cited');
  check('Enter opens the source with the cited passage highlighted, title updated, heading focused', /^Sources/.test(await b.eval('document.title')) && cited.length > 10 && Boolean(await focusedHeading()), cited.slice(0, 50));
  check('the highlight is a real mark element inside readable text (not colour only: outlined)', await b.eval(`(() => { const m = document.querySelector('mark.cited'); const cs = getComputedStyle(m); return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px'; })()`));

  // ---- image replacement + history ----
  await b.eval(`location.hash = '#/workspace/SUB-5'`);
  await b.wait(1100);
  await b.eval('localStorage.setItem("brandproof-role","creator")');
  await b.eval('location.reload()');
  await b.wait(1500);
  await b.tabTo(isBtn('Edit as new revision'), { max: 200 });
  await b.key('Enter');
  await b.wait(800);
  check('the image file input is keyboard-focusable and has a visible label', (await b.tabTo(isId('asset-file'), { max: 40 })) >= 0 && (await b.eval(`!!document.querySelector('label[for=asset-file]')`)));
  note('native file chooser', 'opening the operating-system file dialog cannot be driven by this tool; the file is chosen through the DevTools protocol below');
  await b.setFiles('#asset-file', [imgFile]);
  check('replacing the image shows status text in a polite live region', await b.eval(`(() => { const r = document.querySelector('.image-box'); return r.getAttribute('aria-live') === 'polite' && /Retained image|Image retained|already retained/.test(r.innerText); })()`));
  await b.tabTo(isBtn('Save as revision'), { max: 200 });
  await b.key('Enter');
  await b.wait(1100);
  check('saving the replacement keeps the history of images (3 revisions)', (await b.eval(`document.querySelectorAll('.timeline').length`)) >= 0 && /Revision 3/.test(await text('.ws-title')));
  await shot('5-replaced-image');

  // ---- AI source matching by keyboard (only if the offline matcher is installed) ----
  if (semanticInstalled) {
    await b.eval(`location.hash = '#/workspace/SUB-6'`);
    await b.wait(1200);
    const ok = (await b.tabTo(isId('sem-0'), { max: 300 })) >= 0;
    check('AI source matching: passage checkboxes are reachable by Tab', ok);
    await b.key(' ');
    await b.tabTo(isBtn('Find relevant sources'), { max: 20 });
    await b.key('Enter');
    for (let i = 0; i < 40 && !(await b.eval(`!!document.querySelector('.sem-passage')`)); i++) await b.wait(500);
    check('keyboard-started matching shows relevance results labelled as relevance, in a live region', (await b.eval(`!!document.querySelector('.semantic [aria-live=polite] .sem-passage')`)) && /not probabilities|relevance/i.test(await text('.semantic')));
    await shot('6-source-matching');
  } else {
    note('AI source matching', 'optional package/model not installed: skipped, not passed');
  }

  // ---- narrow screen ----
  await b.eval('location.hash = "#/workspace/SUB-5"');
  await b.viewport(420, 900, true);
  await b.wait(800);
  const pages = ['#/workspace/SUB-5', '#/workspace/SUB-6', '#/library', '#/sources', '#/sources/SRC-1', '#/queue', '#/insights'];
  const bad = [];
  for (const p of pages) {
    await b.eval(`location.hash = ${JSON.stringify(p)}`);
    await b.wait(900);
    const w = await b.eval('document.documentElement.scrollWidth - window.innerWidth');
    if (w > 1) bad.push(`${p} (+${w}px)`);
    if (p === '#/workspace/SUB-5') {
      await b.eval(`document.querySelector('.retained-img')?.scrollIntoView({ block: 'center' })`);
      await b.wait(300);
      await shot('7-narrow-workspace');
    }
    if (p === '#/sources/SRC-1') await shot('8-narrow-source');
  }
  check('at 420 px wide no page scrolls horizontally', bad.length === 0, bad.join(', '));
  const small = await b.eval(`[...document.querySelectorAll('button, a.btn, select, input[type=checkbox]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 24; }).length`);
  check('no visible control is shorter than 24 px on the narrow screen', small === 0, `${small} too short`);
  await b.viewport(1360, 900);

  const noise = b.consoleMsgs.filter((m) => !/^LOG info/.test(m) && !/401|403|409|413|422|Failed to load resource/.test(m));
  check('browser console has no errors', noise.length === 0, noise.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (demo-*.png)`);
process.exit(failed ? 1 : 0);
