// Layout regression: no page may scroll sideways at phone and tablet widths, and every navigation link and action must stay reachable.
//
//   npm run ui-smoke-layout                       asserts (exit 1 on failure), writes screenshots docs/evidence/layout-after-*.png
//   node scripts/browser/ui-smoke-layout.mjs --tag before --out docs/evidence/layout-before.json    measure only
//
// Synthetic, isolated data only: the showcase story is built in a temp directory (same bootstrap as the demo server), plus a campaign
// and a source with deliberately long names (one unbroken word each) and a campaign that has a retained image and a saved text-in-image
// transcription. The preserved demo data and the main data are never opened. It does NOT hide overflow: a page passes only if the DOCUMENT
// itself does not scroll sideways (scrollWidth <= clientWidth) and every element that sticks out sits inside a deliberate horizontal scroller
// (tabs, tables, the mobile navigation row). Needs Edge or Chrome.
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { bootstrapShowcase } from '../demo/bootstrap.mjs';
import { launch } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const tag = arg('--tag', 'after');
const outFile = arg('--out', null);
const measureOnly = argv.includes('--measure-only') || tag === 'before';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  ${detail}` : ''}`);
};

const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-layout-'));
const app = await createApp({ dataFile: path.join(tmp, 'layout.json'), semantic: null, ocr: null });
const base = await app.listen(0);
let b;
const report = { tag, viewports: [], notes: 'Synthetic isolated data; offenders are elements whose right edge is beyond the viewport and which are not inside a deliberate horizontal scroller.' };

const VIEWPORTS = [
  { w: 320, h: 760, mobile: true },
  { w: 390, h: 844, mobile: true },
  { w: 768, h: 1024, mobile: false },
  { w: 1360, h: 900, mobile: false },
];

const MEASURE = `(() => {
  const de = document.documentElement;
  const cw = de.clientWidth;
  const scroller = (el) => {
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      const o = getComputedStyle(a).overflowX;
      if (o === 'auto' || o === 'scroll') return a;
    }
    return null;
  };
  const describe = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const offenders = [];
  const clipped = [];
  for (const e of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (e.closest('.sr-only, .skip, [hidden], dialog:not([open]), svg')) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((r.right > cw + 1 || r.left < -1) && !scroller(e)) offenders.push({ node: e, el: describe(e), right: Math.round(r.right), left: Math.round(r.left), width: Math.round(r.width), text: (e.textContent || '').trim().slice(0, 50) });
    const ox = cs.overflowX;
    if ((ox === 'hidden' || ox === 'clip') && e.scrollWidth > e.clientWidth + 1 && !['CANVAS', 'IMG', 'INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)) clipped.push({ el: describe(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, text: (e.textContent || '').trim().slice(0, 50) });
  }
  // The DEEPEST offenders (no offending descendant) are the real causes; their ancestors only inherit the width.
  const leaf = offenders.filter((o) => !offenders.some((p) => p !== o && o.node.contains(p.node))).map(({ node, ...rest }) => rest);
  return { scrollWidth: de.scrollWidth, clientWidth: cw, bodyScrollWidth: document.body.scrollWidth, offenders: leaf.slice(0, 8), offenderCount: offenders.length, clipped: clipped.slice(0, 8) };
})()`;

try {
  await bootstrapShowcase(base);
  const call = async (method, p, body, role = 'creator', raw = false) => {
    const h = { 'x-demo-role': role };
    let payload;
    if (raw) {
      h['content-type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const must = (r, what) => {
    if (r.status < 200 || r.status >= 300) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.json?.error ?? '')}`);
    return r.json;
  };
  const LONG = (s) => s.slice(0, 120);
  const longTitle = LONG('Fernlight Aurora Lamp spring launch banner AuroraLampSpringLaunchCampaignWithAnUnbrokenVeryLongNameThatMustWrap');
  const longSource = LONG('Fernlight-Aurora-Lamp-Product-Facts-and-Warranty-Terms-Handbook-Edition-2026-FINAL-v7-approved-by-brand-team');
  const png = await readFile(path.join(root, 'tests', 'fixtures', 'ocr', 'clear-30-hours.png'));
  const sha = must(await call('POST', '/api/assets', png, 'creator', true), 'upload').asset.sha256;
  const asset = { name: 'a-very-long-image-file-name-for-the-spring-launch-banner-final-FINAL-v2.png', alt: 'A banner with two short lines of text on a plain background', retainedSha256: sha };
  const made = must(await call('POST', '/api/submissions', { title: longTitle, text: 'A reading lamp for your desk. Averyveryverylongunbrokenwordtotestwrappinginsidethecopyareaofthecampaignpageforphones.', asset, imageText: { text: 'The battery lasts 30 hours\non a single charge.', confirmed: true } }), 'long campaign');
  const subId = made.id;
  const srcId = must(await call('POST', '/api/sources', { title: longSource, text: 'Battery. A full charge lasts up to 12 hours at medium brightness.', origin: 'paste', note: 'Layout test source.' }), 'long source').source.id;

  b = await launch(`${base}/#/workspace/${subId}`, { width: 1360, height: 900, port: 9397 });
  await b.wait(1500);

  const routes = [
    { id: 'workspace-long', hash: `#/workspace/${subId}`, shot: true },
    { id: 'workspace-approved', hash: '#/workspace/SUB-4' },
    { id: 'editor', hash: `#/workspace/${subId}`, click: 'Edit as new revision', shot: true },
    { id: 'library', hash: '#/library' },
    { id: 'sources', hash: '#/sources', shot: true },
    { id: 'source-long', hash: `#/sources/${srcId}` },
    { id: 'source-version', hash: '#/sources/SRC-1/1' },
    { id: 'queue', hash: '#/queue' },
    { id: 'insights', hash: '#/insights' },
    { id: 'dossier-long', hash: `#/dossier/${subId}`, shot: true },
    { id: 'about', hash: `#/workspace/${subId}`, about: true },
  ];

  for (const vp of VIEWPORTS) {
    await b.viewport(vp.w, vp.h, vp.mobile);
    const entry = { width: vp.w, mobile: vp.mobile, routes: {} };
    for (const r of routes) {
      await b.eval(`location.hash = ${JSON.stringify(r.hash)}`);
      await b.wait(1100);
      if (r.click) {
        await b.click(r.click);
        await b.wait(700);
      }
      if (r.about) {
        await b.eval(`[...document.querySelectorAll('button')].find((x) => /About/.test(x.textContent))?.click()`);
        await b.wait(500);
      }
      await b.eval('window.scrollTo(0, 0)');
      const m = await b.eval(MEASURE);
      entry.routes[r.id] = m;
      const fits = m.scrollWidth <= m.clientWidth + 1;
      check(`${vp.w}px ${r.id}: the document does not scroll sideways (scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth})`, fits && m.offenderCount === 0, `${m.offenderCount} element(s) stick out: ${JSON.stringify(m.offenders.slice(0, 3))}`);
      if (m.clipped.length) check(`${vp.w}px ${r.id}: no text is clipped by a hidden-overflow box`, false, JSON.stringify(m.clipped.slice(0, 3)));
      if (r.shot) await b.shot(path.join(shots, `layout-${tag}-${vp.w}-${r.id}.png`));
      if (r.about) await b.eval(`[...document.querySelectorAll('dialog[open] button')].find((x) => /^Close$/.test(x.textContent.trim()))?.click()`);
    }

    // keyboard and touch reach: every navigation link can be focused, ends up fully visible, and activates with Enter
    await b.eval(`location.hash = '#/workspace'`);
    await b.wait(900);
    const navLinks = await b.eval(`[...document.querySelectorAll('#nav a')].map((a) => a.textContent.trim())`);
    // Real Tab presses from the first link: each focused link must lie inside the visible part of the navigation row (the browser scrolls it there).
    await b.eval(`document.querySelectorAll('#nav a')[0].focus()`);
    const lost = [];
    let reachable = 0;
    for (let i = 0; i < navLinks.length; i++) {
      if (i > 0) await b.key('Tab');
      await b.wait(500);
      const vis = await b.eval(`(() => { const a = document.activeElement; const n = document.getElementById('nav'); const r = a.getBoundingClientRect(); const nr = n.getBoundingClientRect(); const vw = document.documentElement.clientWidth; const left = Math.max(nr.left, 0); const right = Math.min(nr.right, vw); return { inNav: !!a.closest('#nav'), label: a.textContent.trim(), link: [Math.round(r.left), Math.round(r.right)], visibleNav: [Math.round(left), Math.round(right)], inView: r.left >= left - 1 && r.right <= right + 1 && r.width > 0 }; })()`);
      if (vis.inNav && vis.inView && vis.label === navLinks[i]) reachable++;
      else lost.push(JSON.stringify(vis));
    }
    check(`${vp.w}px: pressing Tab through the ${navLinks.length} navigation links keeps each focused link fully visible`, reachable === navLinks.length, `not reachable: ${lost.join(', ')}`);
    // Enter on the last link opens that page
    await b.key('Enter');
    await b.wait(900);
    const lastHash = await b.eval('location.hash');
    check(`${vp.w}px: the last navigation link (${navLinks.at(-1)}) opens with the keyboard`, /insights|people|queue|sources|library/.test(lastHash), lastHash);
    // the header actions of a campaign stay inside the screen (no sideways scrolling needed to reach them)
    await b.eval(`location.hash = ${JSON.stringify(`#/workspace/${subId}`)}`);
    await b.wait(1100);
    const actions = await b.eval(`(() => { const want = ['About', 'Review dossier', 'New submission']; const out = {}; for (const w of want) { const el = [...document.querySelectorAll('button, a')].find((x) => x.textContent.includes(w)); if (!el) { out[w] = 'missing'; continue; } const r = el.getBoundingClientRect(); out[w] = r.left >= -1 && r.right <= document.documentElement.clientWidth + 1 ? 'ok' : 'outside ' + Math.round(r.right); } const sel = document.querySelector('select'); if (sel) { const r = sel.getBoundingClientRect(); out.select = r.right <= document.documentElement.clientWidth + 1 ? 'ok' : 'outside ' + Math.round(r.right); } return out; })()`);
    check(`${vp.w}px: the campaign header actions and selectors stay on screen`, Object.values(actions).every((v) => v === 'ok'), JSON.stringify(actions));
    report.viewports.push(entry);
  }
  await b.viewport(1360, 900, false);
  check('the browser console is clean', b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('layout walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
if (outFile) await writeFile(path.join(root, outFile), `${JSON.stringify(report, null, 2)}\n`);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (layout-${tag}-*.png)`);
process.exit(failed && !measureOnly ? 1 : 0);
