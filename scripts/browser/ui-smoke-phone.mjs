// Phone regression (m22): the core path must stay usable on a phone at larger text sizes, and a lost deep link must offer a way back.
// The reported symptom was full-width bars (banner, header, role picker, guide) looking clipped on a phone: that is what a page wider than the screen looks
// like (the bars stop at the screen width while the content continues). m22 reproduced real horizontal overflow on the main workspace page when the text
// size was raised (a very common phone setting, equivalent to browser zoom): a long no-wrap chip, and a bottom tab bar whose labels outgrew their columns.
// On the isolated fictional judge demo (a clock the script can move, optional model and OCR off) this checks, at 390 and 320 CSS px:
//   - no sideways page scroll, and every tab-bar label inside its own column, at text sizes 100, 125, 150 and 200% (320 px: up to 150%)
//   - the banner, brand, role picker and guide each end inside the screen, on the workspace page and in the "session ended" and "earlier session ended" states
//   - normal role switching with real key presses (Arrow, End, Home, Enter) re-renders the right permissions without a reload
//   - a missing deep link (an old address after a lost session) offers an obvious way to the workspace, and it works
// Needs Edge or Chrome. An engineering check of our own layout, not an accessibility audit.
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
let offset = 0;
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-phoneui-'));
const demo = await createJudgeDemo({ root: path.join(tmp, 'root'), semantic: null, ocr: null, clock: () => Date.now() + offset, ephemeral: true });
const base = await demo.listen(0);
let b;

// What is wider than the screen? Boxes (outside deliberate scrollers), and tab-bar labels that do not fit their column.
const MEASURE = `(() => {
  const de = document.documentElement;
  const cw = de.clientWidth;
  const scroller = (el) => { for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll') return a; } return null; };
  const describe = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const offenders = [];
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (e.closest('.sr-only, .skip, [hidden], dialog:not([open]), svg')) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((r.right > cw + 1 || r.left < -1) && !scroller(e)) offenders.push({ node: e, el: describe(e), right: Math.round(r.right), text: (e.textContent || '').trim().slice(0, 36) });
  }
  const leaf = offenders.filter((o) => !offenders.some((p) => p !== o && o.node.contains(p.node))).map(({ node, ...rest }) => rest);
  const ends = {};
  for (const [name, sel] of [['banner', '#banner'], ['brand', '.logo'], ['role picker', '#role-picker'], ['guide', '#judge-guide'], ['main', 'main']]) {
    const e = document.querySelector(sel);
    if (!e || e.hidden || getComputedStyle(e).display === 'none') continue;
    ends[name] = Math.round(e.getBoundingClientRect().right);
  }
  const labels = [...document.querySelectorAll('#nav a')].filter((a) => a.getClientRects().length).map((a) => ({ t: a.textContent.trim().replace(/\\d+$/, ''), over: a.scrollWidth - a.clientWidth })).filter((x) => x.over > 1);
  return { cw, overflow: de.scrollWidth - cw, offenders: leaf.slice(0, 4), ends, tabLabelsOverflowing: labels };
})()`;
const clean = (m) => m.overflow <= 0 && Object.values(m.ends).every((r) => r <= m.cw + 1) && m.tabLabelsOverflowing.length === 0;
const why = (m) => JSON.stringify({ overflow: m.overflow, offenders: m.offenders, ends: m.ends, tabLabelsOverflowing: m.tabLabelsOverflowing });

try {
  b = await launch(`${base}/`, { width: 1440, height: 900, port: 9371 });
  await b.wait(1800);
  const view = async (w) => { await b.viewport(w, w <= 320 ? 760 : 844, true); await b.wait(400); };
  const scale = async (pct) => { await b.eval(`document.documentElement.style.fontSize = ${pct === 100 ? "''" : `'${pct}%'`}`); await b.wait(500); };
  const go = async (hash) => { await b.eval(`location.hash = ${JSON.stringify(hash)}`); await b.wait(1000); };
  const reload = async () => { await b.eval('location.reload()'); await b.wait(2300); };

  // ---- 1. text sizes on the workspace page (the seeded campaign that opens first carries the long "Metadata only" chip) ----
  for (const [w, scales] of [[390, [100, 125, 150, 200]], [320, [100, 125, 150]]]) {
    await view(w);
    await go('#/workspace');
    await reload();
    for (const pct of scales) {
      await scale(pct);
      const m = await b.eval(MEASURE);
      check(`${w} px, text ${pct}%: workspace page has no sideways scroll, every bar ends inside the screen, every tab-bar label fits its column`, clean(m), why(m));
      if (pct === 150 || (w === 320 && pct === 100)) await b.shot(path.join(shots, `phone-m22-workspace-${w}-text${pct}.png`));
    }
    await scale(100);
    for (const hash of ['#/queue', '#/sources', '#/library']) {
      await go(hash);
      await scale(150);
      const m = await b.eval(MEASURE);
      check(`${w} px, text 150%: ${hash} has no sideways scroll`, clean(m), why(m));
      await scale(100);
    }
  }

  // ---- 2. normal role interaction with real key presses (390 px) ----
  await view(390);
  await go('#/workspace');
  await reload();
  await b.eval(`document.getElementById('role').focus()`);
  const read = () => b.eval(`(() => { const btn = (t) => [...document.querySelectorAll('.flow button')].find((x) => x.textContent.trim().startsWith(t)); return { role: document.getElementById('role').value, requestReviewDisabled: btn('Request review')?.disabled, editVisible: !!btn('Edit as new revision') }; })()`);
  const seen = [];
  for (const key of ['ArrowDown', 'End', 'Home']) { await b.key(key); await b.wait(500); seen.push(await read()); }
  check('real keys on the role picker (ArrowDown, End, Home) switch Manager, Reviewer, Creator and the page re-renders their permissions without a reload',
    seen[0].role === 'manager' && seen[1].role === 'reviewer' && seen[1].requestReviewDisabled === true && seen[1].editVisible === false && seen[2].role === 'creator' && seen[2].requestReviewDisabled === false && seen[2].editVisible === true, JSON.stringify(seen));
  check('after the role changes the page is still inside the screen', clean(await b.eval(MEASURE)), why(await b.eval(MEASURE)));

  // ---- 3. the session is lost: a tab left open, then a reload, then an old deep link ----
  for (const w of [390, 320]) {
    await view(w);
    await go('#/workspace');
    await reload();
    offset += 130 * MIN; // idle past the limit: the service "slept"
    await b.eval(`[...document.querySelectorAll('#nav a')].find((a) => /Review queue/.test(a.textContent))?.click()`);
    await b.wait(1500);
    const ended = await b.eval(`document.getElementById('main').innerText`);
    const mEnded = await b.eval(MEASURE);
    check(`${w} px: a tab left open when the session is lost says "session ended" and stays inside the screen`, /This demo session has ended/.test(ended) && /Start a new demo session/.test(ended) && clean(mEnded), why(mEnded));
    await b.shot(path.join(shots, `phone-m22-ended-${w}.png`));
    await go('#/workspace/SUB-99'); // an address from the lost session: it does not exist in the new one
    await reload();
    const banner = await b.eval(`document.getElementById('banner').innerText`);
    const mNew = await b.eval(MEASURE);
    check(`${w} px: after a reload the banner says the earlier session ended (the long form) and still fits the screen`, /earlier session had ended, so this is a new one/.test(banner) && clean(mNew), why(mNew));
    const missing = await b.eval(`({ text: document.getElementById('main').innerText, actions: [...document.querySelectorAll('#main a, #main button')].map((x) => x.textContent.trim()).filter(Boolean) })`);
    check(`${w} px: a deep link that no longer exists says so AND offers an obvious way to the workspace`, /No submission SUB-99/.test(missing.text) && missing.actions.some((a) => /Open the workspace/i.test(a)), JSON.stringify(missing));
    const seen = await b.eval(`(() => { const btn = [...document.querySelectorAll('#main a')].find((x) => /Open the workspace/i.test(x.textContent)); if (!btn) return null; const r = btn.getBoundingClientRect(); const nav = document.getElementById('nav'); const bar = getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().top : innerHeight; return { top: Math.round(r.top), bottom: Math.round(r.bottom), visibleUntil: Math.round(bar), alert: !!document.querySelector('#main [role=alert]') }; })()`);
    check(`${w} px: the recovery button is visible without scrolling (above the tab bar) and the message is announced as an alert`, !!seen && seen.top >= 0 && seen.bottom <= seen.visibleUntil && seen.alert, JSON.stringify(seen));
    await b.shot(path.join(shots, `phone-m22-missing-deeplink-${w}.png`));
    await b.eval(`[...document.querySelectorAll('#main a, #main button')].find((x) => /Open the workspace/i.test(x.textContent))?.click()`);
    await b.wait(1200);
    check(`${w} px: that action recovers the seeded workspace`, /Aurora Lamp/.test(await b.eval(`document.querySelector('h1')?.textContent ?? ''`)));
    offset += 0;
  }
  check('the browser console is clean (apart from the expected refused requests)', b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, JSON.stringify(b.consoleMsgs.slice(0, 4)));
} catch (e) {
  check('phone walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await demo.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (phone-m22-*.png)`);
process.exit(failed ? 1 : 0);
