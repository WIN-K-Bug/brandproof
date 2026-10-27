// m28: the source approval dialog (impact preview embedded) at small heights, measured and photographed.
// AUTHENTICATED workspace, synthetic accounts, a FICTIONAL fact sheet, a throwaway directory. Never touches data/.
//
//   npm run ui-smoke-dialog-reflow
//
// At each viewport it opens Preview impact -> Continue to approve, and checks with exact geometry (not only the DOM)
// that the impact text, the acknowledgement, the note and the final action can all be reached by mouse wheel and
// by keyboard, that only ONE region of the dialog scrolls vertically, that nothing is clipped or blank, that an unchecked
// approval is refused with a message the person can SEE, that Cancel and Escape change nothing, and (desktop) that a stale
// preview is refused and a checked, fresh one activates. A long dialog that is not the source dialog is measured the same way.
// Screenshots (top / middle / bottom of the scroll) go to docs/evidence/dialog-*.png to be looked at, not only counted.
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { cleanContent } from '../../tests/helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const TAG = process.env.DIALOG_SHOT_TAG || 'dialog';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-dialog-ui-'));
await mkdir(path.join(tmp, 'auth'));

const app = await createApp({ dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json'), mode: 'authenticated', semantic: null, authOptions: { cost: { N: 1024, r: 8, p: 1 } } });
const base = await app.listen(0);
const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), manager: secret(), reviewer: secret() };
for (const [name, role] of [['creator', 'creator'], ['manager', 'manager'], ['reviewer', 'reviewer']]) await app.auth.createUser({ username: `syn-${name}`, displayName: `Synthetic ${name}`, role, password: pw[name] });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const ENV = 'Indoor use only; not waterproof or water resistant.';
const WARR = 'Every Aurora Lamp carries a 2-year limited warranty.';
const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional)', '', `Environment. ${ENV}`, '', `Warranty. ${WARR}`, '', `Battery. ${battery}`].join('\n');
const V1 = sheet(BAT12);
const V2 = sheet(BAT8);
const spanOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

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

// ---- in-page measuring helpers (source text, evaluated in the browser) ----
const PAGE = `(() => {
  const dlg = () => document.querySelector('dialog');
  // an element is "seen" only if it sits inside the viewport AND inside every clipping ancestor up to the dialog
  const clipRect = (e) => {
    let r = e.getBoundingClientRect();
    let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom), left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    for (let p = e.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowY !== 'visible' || s.overflowX !== 'visible') { const q = p.getBoundingClientRect(); top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom); left = Math.max(left, q.left); right = Math.min(right, q.right); }
      if (p === dlg()) break;
    }
    return { top, bottom, left, right, h: Math.max(0, bottom - top), w: Math.max(0, right - left), full: bottom - top >= r.height - 1 && right - left >= r.width - 1 };
  };
  const scrollers = () => { const d = dlg(); return [d, ...d.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1); };
  const label = (e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '');
  window.__m28 = {
    clipRect,
    scrollers: () => scrollers().map((e) => ({ el: label(e), top: Math.round(e.scrollTop), max: e.scrollHeight - e.clientHeight })),
    geo: () => {
      const d = dlg(), r = d.getBoundingClientRect(), fb = d.querySelector('.dlg-f'), body = d.querySelector('.dlg-b'), head = d.querySelector('.dlg-h');
      const rr = (e) => { if (!e) return null; const x = e.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), h: Math.round(x.height) }; };
      return { vw: innerWidth, vh: innerHeight, dialog: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), clientH: d.clientHeight, scrollH: d.scrollHeight }, head: rr(head), body: rr(body), bodyClientH: body.clientHeight, bodyScrollH: body.scrollHeight, foot: rr(fb), scrollers: scrollers().map(label), abs: [...d.querySelectorAll('*')].filter((e) => getComputedStyle(e).position === 'absolute').map((e) => label(e) + '@' + Math.round(e.getBoundingClientRect().top - r.top)), pageScrollX: document.documentElement.scrollWidth > innerWidth + 1 };
    },
    seen: (sel) => { const e = dlg().querySelector(sel); if (!e) return null; const c = clipRect(e); return { full: c.full, h: Math.round(c.h), top: Math.round(c.top), bottom: Math.round(c.bottom) }; },
    // text-bearing elements of the dialog BODY that a person can see right now (a blank dialog has none)
    visibleText: () => { const b = dlg().querySelector('.dlg-b'); let n = 0; for (const e of b.querySelectorAll('*')) { if ([...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) { const c = clipRect(e); if (c.h > 4 && c.w > 4) n++; } } return n; },
    setScroll: (which, v) => { const e = which === 'outer' ? dlg() : dlg().querySelector('.dlg-b'); e.scrollTop = v === 'end' ? e.scrollHeight : v; return Math.round(e.scrollTop); },
    toastSeen: () => { const t = document.querySelector('.toast'); if (!t) return { present: false, seen: false }; const r = t.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { present: true, text: t.textContent, seen: Boolean(hit && hit.closest('.toast')), inDialog: Boolean(t.closest('dialog')) }; },
    active: () => { const e = document.activeElement; return e ? { id: e.id, tag: e.tagName.toLowerCase(), text: (e.innerText || '').trim().slice(0, 30) } : null; },
  };
  return true;
})()`;

let b;
try {
  const [creator, manager] = [await client('creator'), await client('manager')];
  const must = (r, code = 201) => {
    if (r.status !== code) throw new Error(`setup step failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const src = must(await creator.call('POST', '/api/sources', { title: 'Fernlight Aurora Lamp fact sheet (fictional)', text: V1, origin: 'paste' })).source;
  must(await manager.call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: sha(V1), note: 'checked' }));
  const g = must(await manager.call('GET', '/api/guidelines'), 200);
  const edited = structuredClone(g.guidelines);
  for (const [id, needle] of [['FCT-001', BAT12], ['FCT-002', ENV], ['FCT-004', WARR]]) edited.facts.find((f) => f.id === id).source = { sourceId: src.id, version: 1, ...spanOf(V1, needle) };
  must(await manager.call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'link three facts to the fact sheet', guidelines: edited }));
  for (const [title, text, approve] of [['Aurora battery launch', 'A full charge lasts up to 12 hours.', true], ['Care tips post', 'The Aurora Lamp is a reading light for your desk.', true], ['Warranty announcement', 'The Aurora Lamp has a 2-year warranty.', false], ['Indoor lamp draft', 'The Aurora Lamp is designed for indoor use.', null]]) {
    const id = must(await creator.call('POST', '/api/submissions', { title, ...cleanContent(), text })).id;
    if (approve === null) continue;
    const cur = must(await creator.call('GET', `/api/submissions/${id}`), 200);
    must(await creator.call('POST', `/api/submissions/${id}/request-review`, { revision: cur.headRevision, expected: cur.workflow.binding }));
    if (!approve) continue;
    const rv = await client('reviewer');
    const cur2 = must(await rv.call('GET', `/api/submissions/${id}`), 200);
    must(await rv.call('POST', `/api/submissions/${id}/approve`, { revision: cur2.headRevision, expected: cur2.workflow.binding }));
  }
  must(await creator.call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: V2, origin: 'paste', note: 'Battery life reduced to 8 hours' }));

  b = await launch(`${base}/#/workspace`, { port: Number(process.env.DIALOG_PORT || 9401) });
  const q = (expr) => b.eval(`(${PAGE}, window.__m28.${expr})`);
  const login = async (who) => {
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
  const waitText = async (re) => {
    for (let i = 0; i < 40; i++) {
      if (re.test(await dialogText())) return true;
      await b.wait(250);
    }
    return false;
  };
  const events = async () => must(await manager.call('GET', `/api/sources/${src.id}`), 200).source.events.length;
  const fileBytes = () => readFile(path.join(tmp, 'workspace.json'));
  const shot = (name) => b.shot(path.join(shots, `${TAG}-${name}.png`));
  const centre = async () => {
    const r = await q(`geo()`);
    return { x: Math.round((r.dialog.left + r.dialog.right) / 2), y: Math.round((Math.max(r.dialog.top, 0) + Math.min(r.dialog.bottom, r.vh)) / 2) };
  };
  const sum = async () => (await q(`scrollers()`)).reduce((a, s) => a + s.top, 0);
  /** Turn the wheel over the middle of the dialog until nothing moves any more. */
  const wheelTo = async (dir) => {
    const { x, y } = await centre();
    let last = -1;
    for (let i = 0; i < 60; i++) {
      await b.wheel(x, y, dir === 'down' ? 280 : -280);
      const now = await sum();
      if (now === last) break;
      last = now;
    }
  };

  await login('manager');
  await go(`#/sources/${src.id}/2`);
  await b.eval(PAGE);
  // Diagnostic only: DIALOG_INJECT_CSS applies extra CSS (a constructed stylesheet, allowed by the CSP) to test a cause without editing the product.
  if (process.env.DIALOG_INJECT_CSS) await b.eval(`(() => { const s = new CSSStyleSheet(); s.replaceSync(${JSON.stringify(process.env.DIALOG_INJECT_CSS)}); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; return true; })()`);

  /** One full pass over the open source approval dialog at the current viewport. */
  async function pass(vpName) {
    const n = (s) => `${vpName}: ${s}`;
    await q(`geo()`); // installs the helpers
    const g0 = await q(`geo()`);
    console.log(`GEOMETRY ${vpName} ${JSON.stringify(g0)}`);
    check(n('the dialog sits inside the viewport and the page does not scroll sideways'), g0.dialog.top >= 0 && g0.dialog.bottom <= g0.vh + 1 && g0.dialog.left >= 0 && g0.dialog.right <= g0.vw + 1 && !g0.pageScrollX, JSON.stringify(g0.dialog));
    check(n('only ONE region of the dialog scrolls vertically (no competing scroll containers)'), g0.scrollers.length <= 1, `scrollers: ${g0.scrollers.join(', ') || 'none'}`);
    check(n('the title and the final actions are visible without scrolling anything'), (await q(`seen('.dlg-h h2')`)).full && (await q(`seen('.dlg-f .btn.primary')`)).full && (await q(`seen('.dlg-f .btn:not(.primary)')`)).full);
    // mouse wheel: top, middle, bottom, each photographed and checked for blankness
    await wheelTo('up');
    await shot(`${vpName}-1-top`);
    check(n('top: the impact text is on screen (not blank)'), (await q(`visibleText()`)) > 2, `visible text elements ${await q(`visibleText()`)}`);
    const maxes = await q(`scrollers()`);
    const total = maxes.reduce((a, s) => a + s.max, 0);
    const midTarget = Math.round(total / 2);
    let guard = 0;
    const { x, y } = await centre();
    while ((await sum()) < midTarget && guard++ < 60) await b.wheel(x, y, 120);
    await shot(`${vpName}-2-middle`);
    check(n('middle: text is on screen (not blank)'), (await q(`visibleText()`)) > 2);
    await wheelTo('down');
    await shot(`${vpName}-3-bottom`);
    check(n('bottom: text is on screen (not blank)'), (await q(`visibleText()`)) > 2);
    const ack = await q(`seen('#sa-read')`);
    const noteSeen = await q(`seen('#sa-note')`);
    check(n('after wheeling to the end the acknowledgement, the note and the final action are all fully visible'), ack.full && noteSeen.full && (await q(`seen('.dlg-f .btn.primary')`)).full, `ack ${JSON.stringify(ack)} note ${JSON.stringify(noteSeen)}`);
    check(n('the last sentence of the preview can be read'), (await q(`seen('.impact-body > p:last-child')`))?.full === true);
    // what dragging the dialog's own scrollbar to the bottom shows (the reported blank dialog)
    await q(`setScroll('outer', 'end')`);
    await b.wait(200);
    await shot(`${vpName}-4-outer-scroll-end`);
    const afterOuter = await q(`visibleText()`);
    check(n('with the dialog itself scrolled to its end there is still readable text, not a blank area'), afterOuter > 2, `visible text elements ${afterOuter}`);
    await q(`setScroll('outer', 0)`);
    await q(`setScroll('body', 0)`);
    // keyboard: Tab from the top to the acknowledgement; focus must land where it can be seen
    await b.eval(`document.querySelector('dialog .dlg-x').focus()`);
    const presses = await b.tabTo(`(e) => e && e.id === 'sa-read'`, { max: 60 });
    check(n('Tab reaches the acknowledgement checkbox'), presses >= 0, `after ${presses} presses`);
    check(n('the focused acknowledgement is fully visible (focus scrolls it into view)'), (await q(`seen('#sa-read')`)).full);
    await b.key(' ');
    check(n('Space ticks it'), await b.eval(`document.getElementById('sa-read').checked === true`));
    await b.key('Tab');
    check(n('Tab goes on to the note and shows it'), (await q(`active()`)).id === 'sa-note' && (await q(`seen('#sa-note')`)).full);
    await b.key('Tab');
    await b.key('Tab');
    const act = await q(`active()`);
    check(n('two more Tabs land on Approve (the dialog traps focus in order)'), /Approve/.test(act.text), JSON.stringify(act));
    await b.eval(`document.getElementById('sa-read').click()`); // untick again for the refusal check
  }

  /** Unchecked approval is refused, visibly, and nothing changed. */
  async function refusal(vpName) {
    const n = (s) => `${vpName}: ${s}`;
    const bytes = await fileBytes();
    const ev = await events();
    await b.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
    await b.eval(`document.getElementById('sa-read').checked = false`);
    await b.click('dialog .dlg-f .btn.primary');
    await b.wait(400);
    await shot(`${vpName}-5-refusal`);
    const t = await q(`toastSeen()`);
    check(n('approving without ticking the box is refused and says why'), t.present && /Tick the box/.test(t.text || ''), JSON.stringify(t));
    check(n('that refusal is visible above the dialog (not hidden behind it) and sits inside the dialog, where a screen reader still reaches it'), t.seen === true && t.inDialog === true, JSON.stringify(t));
    check(n('nothing was saved by the refused approval'), (await fileBytes()).equals(bytes) && (await events()) === ev);
  }

  async function openApproveDialog() {
    await b.eval(`location.hash = '#/sources/${src.id}/1'`);
    await b.wait(300);
    await go(`#/sources/${src.id}/2`);
    await b.eval(PAGE);
    await b.click('Preview impact…');
    if (!(await waitText(/Not covered/))) throw new Error('preview did not load');
    await b.click('Continue to approve…');
    if (!(await waitText(/I have read this version/))) throw new Error('approve dialog did not load');
    await waitText(/Not covered/);
    await b.wait(300);
  }

  const VIEWPORTS = [
    ['683x598', 683, 598, false],
    ['320x568', 320, 568, true],
    ['390x700', 390, 700, true],
    ['desktop', 1360, 900, false],
  ];
  for (const [name, w, h, mobile] of VIEWPORTS.filter((v) => !process.env.DIALOG_ONLY || process.env.DIALOG_ONLY.split(',').includes(v[0]))) {
    await b.viewport(w, h, mobile);
    await openApproveDialog();
    await pass(name);
    await refusal(name);
    // Escape closes with no change, and so does Cancel
    const bytes = await fileBytes();
    await b.key('Escape');
    check(`${name}: Escape closes the dialog and changes nothing`, !(await b.eval(`!!document.querySelector('dialog')`)) && (await fileBytes()).equals(bytes));
    await openApproveDialog();
    await b.click('Cancel');
    check(`${name}: Cancel closes the dialog and changes nothing`, !(await b.eval(`!!document.querySelector('dialog')`)) && (await fileBytes()).equals(bytes));
  }

  // Preview alone (no approve dialog), Withdraw, and a long dialog that is not about sources
  for (const [name, w, h, mobile] of [['683x598', 683, 598, false], ['320x568', 320, 568, true]]) {
    await b.viewport(w, h, mobile);
    await go(`#/sources/${src.id}/2`);
    await b.eval(PAGE);
    await b.click('Preview impact…');
    await waitText(/Not covered/);
    await wheelTo('down');
    await shot(`${name}-preview-bottom`);
    const g1 = await q(`geo()`);
    check(`${name}: the preview dialog alone has one scroller and its Continue action in view`, g1.scrollers.length <= 1 && (await q(`seen('.dlg-f .btn.primary')`)).full, g1.scrollers.join(', '));
    await b.click('Close');

    await go(`#/sources/${src.id}/1`);
    await b.eval(PAGE);
    await b.click('Withdraw…');
    await waitText(/Not covered/);
    await b.wait(300);
    await wheelTo('down');
    await shot(`${name}-withdraw-bottom`);
    const g2 = await q(`geo()`);
    check(`${name}: the withdraw dialog has one scroller; its acknowledgement and action are reachable`, g2.scrollers.length <= 1 && (await q(`seen('#sw-read')`)).full && (await q(`seen('#sw-note')`)).full && (await q(`seen('.dlg-f .btn.danger')`)).full, `${g2.scrollers.join(', ')} ack ${JSON.stringify(await q(`seen('#sw-read')`))}`);
    await b.click('Cancel');

    await go('#/library');
    await b.eval(PAGE);
    await b.click('+ Add terminology rule');
    await b.wait(400);
    const g3 = await q(`geo()`);
    console.log(`GEOMETRY ${name} term-dialog ${JSON.stringify(g3)}`);
    await wheelTo('down');
    await shot(`${name}-term-bottom`);
    check(`${name}: a long dialog that is not about sources (add terminology rule) has one scroller and its actions in view`, g3.scrollers.length <= 1 && (await q(`seen('.dlg-f .btn.primary')`)).full, g3.scrollers.join(', '));
    await b.click('Cancel');
  }

  // Desktop: a stale preview is refused, then a fresh checked one activates
  await b.viewport(1360, 900, false);
  await openApproveDialog();
  const evBefore = await events();
  must(await creator.call('POST', '/api/submissions', { title: 'Late campaign', ...cleanContent(), text: 'A new campaign arrives after the preview was read.' }));
  await b.eval(`document.getElementById('sa-read').click()`);
  await b.click('dialog .dlg-f .btn.primary');
  await b.wait(1500);
  check('desktop: a preview that went stale is refused, reloaded and the box is cleared', /The preview was out of date and has been reloaded/.test(await dialogText()) && (await b.eval(`document.getElementById('sa-read').checked === false`)) && (await events()) === evBefore);
  await b.eval(`document.getElementById('sa-read').click()`);
  await b.click('dialog .dlg-f .btn.primary');
  await b.wait(1500);
  check('desktop: ticking the box on the fresh preview and approving activates version 2 (one new event)', !(await b.eval(`!!document.querySelector('dialog')`)) && (await events()) === evBefore + 1 && must(await manager.call('GET', `/api/sources/${src.id}`), 200).source.activeVersion === 2);
  check('no console errors', b.consoleMsgs.filter((m) => /EXCEPTION|error/i.test(m) && !/Failed to load resource/.test(m)).length === 0, b.consoleMsgs.slice(0, 3).join(' | '));
} finally {
  await b?.close();
  await app.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed. Screenshots: ${shots} (${TAG}-*.png)`);
process.exit(passed === results.length ? 0 : 1);
