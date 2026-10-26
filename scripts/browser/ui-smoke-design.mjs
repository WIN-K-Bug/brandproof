// Design regression: what the contrast numbers cannot show. On the isolated synthetic showcase (never the preserved demo data) it checks
//   - touch targets: every button, field, tab and navigation link is at least 44 px tall on a phone
//   - the focus ring: real Tab presses; each focused control shows a solid outline of at least 3 px, walnut (amber on the walnut surfaces)
//   - reflow: no sideways page scroll at a 200% text-size setting and at the equivalent of 200% and 400% browser zoom
//   - reduced motion and increased contrast: the emulated preferences are honoured (no transitions; darker secondary text and hairlines)
//   - the single primary action: a campaign with blocking findings shows exactly one filled primary button in its decision bar
//   - the brutalist shadows are solid offsets: nothing carries a blurred shadow; the decorative verdict stamp is hidden from screen readers
//   - the self-hosted fonts load from this server; the phone navigation is a tab bar fixed at the bottom edge
// Needs Edge or Chrome. An engineering check of our own CSS, not an accessibility audit.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { bootstrapShowcase } from '../demo/bootstrap.mjs';
import { launch } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  ${detail}` : ''}`);
};
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-designsmoke-'));
const app = await createApp({ dataFile: path.join(tmp, 'd.json'), semantic: null, ocr: null });
const base = await app.listen(0);
let b;
try {
  await bootstrapShowcase(base);
  b = await launch(`${base}/#/workspace/SUB-6`, { width: 1440, height: 900, port: 9396 });
  await b.wait(1500);
  const go = async (hash) => {
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(1100);
  };

  // ---- the single primary action ----
  await go('#/workspace/SUB-6');
  const prim = await b.eval(`[...document.querySelectorAll('.flow .btn.primary')].map((x) => x.textContent.trim())`);
  check('a campaign with blocking findings shows ONE primary action in its decision bar (the useful next step, a new revision)', prim.length === 1 && /Edit as new revision/.test(prim[0]), JSON.stringify(prim));
  const lead = await b.eval(`document.querySelector('.flow .lead')?.textContent ?? ''`);
  check('the decision bar states what stops approval, in words', /blocking findings? stops? approval/.test(lead), lead);
  await go('#/workspace/SUB-4');
  const primApproved = await b.eval(`document.querySelectorAll('.flow .btn.primary').length`);
  check('an approved campaign has no primary action to push', primApproved === 0, String(primApproved));

  // ---- solid offset shadows only: every box-shadow has a zero blur radius ----
  await go('#/workspace/SUB-6');
  const blurred = await b.eval(`[...document.querySelectorAll('body *')].map((e) => [e, getComputedStyle(e).boxShadow]).filter(([, s]) => s !== 'none' && s.split(/,(?![^(]*\\))/).some((one) => { const px = one.replace(/rgba?\\([^)]*\\)/, '').match(/-?[\\d.]+px/g) || []; return parseFloat(px[2] || '0') > 0; })).map(([e, s]) => String(e.className).split(' ')[0] + ' ' + s).slice(0, 5)`);
  check('every shadow is a solid offset block (no blur anywhere on the campaign page)', blurred.length === 0, JSON.stringify(blurred));
  const hard = await b.eval(`['main .card', '.flow', 'main .btn:not(:disabled)'].map((s) => getComputedStyle(document.querySelector(s)).boxShadow)`);
  check('cards, the verdict band and buttons sit on a hard offset shadow', hard.every((s) => /\d+px \d+px 0px/.test(s)), JSON.stringify(hard));

  // ---- the verdict band and its stamp ----
  const stamp = await b.eval(`(() => { const f = document.querySelector('.flow'); const a = getComputedStyle(f, '::after'); return { state: f.dataset.state, content: a.content, bg: getComputedStyle(f).backgroundColor }; })()`);
  check('a campaign with blocking findings gets the walnut verdict band and a NOT READY stamp with empty alternative text', stamp.state === 'blocked' && /NOT READY/.test(stamp.content) && /\/\s*""/.test(stamp.content) && stamp.bg === 'rgb(43, 29, 21)', JSON.stringify(stamp));
  const exhibits = await b.eval(`[...document.querySelectorAll('.findings .evidence')].slice(0, 2).map((e) => getComputedStyle(e, '::before').content)`);
  check('evidence blocks are lettered as exhibits (A, B, ...)', exhibits.length >= 1 && /"EXHIBIT "\s*counter\(exhibit, upper-alpha\)/.test(exhibits[0]), JSON.stringify(exhibits));

  // ---- self-hosted fonts ----
  const fonts = await b.eval(`(async () => { await document.fonts.ready; const loaded = [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')))]; const files = performance.getEntriesByType('resource').filter((r) => /\\.woff2/.test(r.name)).map((r) => r.name); return { loaded, local: files.filter((n) => n.startsWith(location.origin)).length, remote: files.filter((n) => !n.startsWith(location.origin)).length }; })()`);
  check('Archivo, Archivo Black and Space Mono load from this server (no remote font request)', ['Archivo', 'Archivo Black', 'Space Mono'].every((f) => fonts.loaded.includes(f)) && fonts.local >= 3 && fonts.remote === 0, JSON.stringify(fonts));

  // ---- touch targets on a phone ----
  await b.viewport(390, 844, true);
  const targetReport = async (hash) => {
    await go(hash);
    return b.eval(`(() => {
      const bad = [];
      const sel = 'button, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [role=tab], #nav a, a.btn, .filter';
      for (const e of document.querySelectorAll(sel)) {
        const st = getComputedStyle(e);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        if (e.closest('.sr-only, .skip, dialog:not([open])')) continue;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 43.5) bad.push({ el: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + String(e.className).split(' ')[0], h: Math.round(r.height), text: (e.textContent || e.value || '').trim().slice(0, 24) });
      }
      return bad;
    })()`);
  };
  await go('#/workspace/SUB-6');
  const tabbar = await b.eval(`(() => { const n = document.getElementById('nav'); const r = n.getBoundingClientRect(); const links = [...n.querySelectorAll('a')].map((a) => a.getBoundingClientRect()); return { position: getComputedStyle(n).position, bottomGap: Math.round(innerHeight - r.bottom), width: Math.round(r.width), vw: document.documentElement.clientWidth, oneRow: links.every((l) => Math.abs(l.top - links[0].top) < 1), allInside: links.every((l) => l.left >= -0.5 && l.right <= document.documentElement.clientWidth + 0.5) }; })()`);
  check('phone: the navigation is a tab bar fixed to the bottom edge, all sections in one row on screen', tabbar.position === 'fixed' && tabbar.bottomGap <= 1 && tabbar.oneRow && tabbar.allInside && tabbar.width >= tabbar.vw - 1, JSON.stringify(tabbar));
  await b.eval('window.scrollTo(0, document.documentElement.scrollHeight)');
  await b.wait(300);
  const covered = await b.eval(`(() => { const n = document.getElementById('nav').getBoundingClientRect(); const last = [...document.querySelectorAll('main button, main a')].filter((e) => e.getClientRects().length).at(-1); const r = last.getBoundingClientRect(); return { lastBottom: Math.round(r.bottom), barTop: Math.round(n.top), text: last.textContent.trim().slice(0, 30) }; })()`);
  check('phone: scrolled to the end, the last control on the page sits above the tab bar (not hidden under it)', covered.lastBottom <= covered.barTop, JSON.stringify(covered));
  await b.eval('window.scrollTo(0, 0)');
  for (const [name, hash] of [['campaign', '#/workspace/SUB-6'], ['queue', '#/queue'], ['source', '#/sources/SRC-1'], ['library', '#/library']]) {
    const bad = await targetReport(hash);
    check(`phone ${name}: every button, field, tab and navigation link is at least 44 px tall`, bad.length === 0, JSON.stringify(bad.slice(0, 4)));
  }
  await go('#/workspace/SUB-6');
  await b.click('Edit as new revision');
  await b.wait(800);
  const editBad = await b.eval(`[...document.querySelectorAll('main button, main select, main input:not([type=checkbox]):not([type=radio]), main textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 43.5 && getComputedStyle(e).display !== 'none'; }).map((e) => e.tagName + '#' + e.id + ' ' + Math.round(e.getBoundingClientRect().height)).slice(0, 5)`);
  check('phone editor: fields and buttons at least 44 px tall', editBad.length === 0, JSON.stringify(editBad));
  await go('#/workspace/SUB-6');
  await b.viewport(1440, 900, false);

  // ---- the focus ring, with real Tab presses ----
  await go('#/workspace/SUB-6');
  await b.eval(`document.getElementById('main').focus(); window.scrollTo(0, 0)`);
  const rings = [];
  for (let i = 0; i < 14; i++) {
    await b.key('Tab');
    await b.wait(120);
    rings.push(await b.eval(`(() => { const e = document.activeElement; const s = getComputedStyle(e); const dark = Boolean(e.closest('.demo-banner, .flow[data-state=blocked]')) || s.backgroundColor === 'rgb(43, 29, 21)'; return { el: e.tagName.toLowerCase() + (e.id ? '#' + e.id : ''), style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, dark }; })()`));
  }
  // walnut rgb(43, 29, 21) everywhere; amber rgb(255, 181, 46) only where the control sits on a walnut surface
  const noRing = rings.filter((r) => r.style !== 'solid' || r.width < 3 || r.color !== (r.dark ? 'rgb(255, 181, 46)' : 'rgb(43, 29, 21)'));
  check('14 Tab presses through the campaign page: every focused control shows a solid 3 px ring (walnut, amber on walnut surfaces)', noRing.length === 0, JSON.stringify(noRing.slice(0, 3)));
  check('the Tab walk passed through the dark verdict band (the amber ring was exercised)', rings.some((r) => r.dark), JSON.stringify(rings.map((r) => r.el)));
  await b.shot(path.join(process.cwd(), 'docs', 'evidence', 'design-m17-focus-ring.png'));

  // ---- reflow at a larger text size and at zoom equivalents ----
  const overflow = () => b.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  await go('#/workspace/SUB-6');
  await b.eval(`document.documentElement.style.fontSize = '200%'`);
  await b.wait(500);
  check('200% text size at 1440 px: the page does not scroll sideways', (await overflow()) <= 0, String(await overflow()));
  await b.eval(`document.documentElement.style.fontSize = ''`);
  for (const w of [720, 360, 320]) {
    await b.viewport(w, 800, false);
    for (const hash of ['#/workspace/SUB-6', '#/queue', '#/dossier/SUB-4']) {
      await go(hash);
      const o = await overflow();
      const who = o > 0 ? await b.eval(`[...document.querySelectorAll('body *')].filter((e) => !e.closest('.sr-only, .skip') && e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 && !(e.parentElement && e.parentElement.scrollWidth > e.parentElement.clientWidth && getComputedStyle(e.parentElement).overflowX !== 'visible')).slice(0, 4).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0] + ' right=' + Math.round(e.getBoundingClientRect().right) + ' ' + (e.textContent || '').trim().slice(0, 24))`) : [];
      check(`${w} px wide (zoom equivalent) ${hash}: no sideways page scroll`, o <= 0, String(o) + ' ' + JSON.stringify(who));
    }
  }
  await b.viewport(1440, 900, false);

  // ---- reduced motion ----
  await b.features([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await go('#/workspace/SUB-6');
  const motion = await b.eval(`[...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (parseFloat(s.transitionDuration) > 0.001) || (s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.001); }).length`);
  check('prefers-reduced-motion: no element transitions or animates', motion === 0, String(motion));
  await b.features([]);

  // ---- increased contrast ----
  await b.features([{ name: 'prefers-contrast', value: 'more' }]);
  await go('#/workspace/SUB-6');
  const inc = await b.eval(`(() => { const r = getComputedStyle(document.documentElement); return { muted: r.getPropertyValue('--muted').trim().toLowerCase(), rule: r.getPropertyValue('--rule').trim().toLowerCase(), ground: getComputedStyle(document.body).backgroundImage }; })()`);
  check('prefers-contrast: more darkens secondary text and hairlines and drops the dotted ground', inc.muted === '#3f2e23' && inc.rule === '#7a6a58' && inc.ground === 'none', JSON.stringify(inc));
  await b.features([]);
  await go('#/workspace/SUB-6');
  const norm = await b.eval(`getComputedStyle(document.documentElement).getPropertyValue('--muted').trim().toLowerCase()`);
  check('and the normal appearance returns when the preference is off', norm === '#5f4a3c', norm);
  check('the browser console is clean', b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('design walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
