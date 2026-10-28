// m33: the answer to "Compare with revision N" that arrives after the person is no longer looking at that comparison. Real UI, real server, SYNTHETIC
// data in a throwaway directory; never touches data/.
//
//   npm run ui-smoke-compare-order
//
// The server handles every request normally. Only the DELIVERY of a comparison response to the page is held (a fetch wrapper installed in the page, the
// way a slow network would behave); for a refusal the page's own request is made for a revision that does not exist, so the refusal is the server's.
//
//   control           a comparison of A (revision 1 -> 2) is shown and closes; a comparison the server refuses is reported on the page
//   late success      A's comparison held, the person goes to B (or the library, or B's dossier), the answer is released
//   late refusal      the same with a refused comparison
//   B's draft         B is being edited when A's late comparison arrives
//   overlap           two comparison choices in flight: the LATEST choice wins whatever order the answers arrive in
//   close / edit      a comparison pending while the person closes the open comparison, or starts a new edit
//   back and reload   going back to A shows A normally; reloading too
// Screenshots go to docs/evidence/compareorder-*.png (COMPAREORDER_SHOT_TAG overrides the prefix; an existing file is never overwritten).
import { mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { cleanContent } from '../../tests/helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const TAG = process.env.COMPAREORDER_SHOT_TAG || 'compareorder';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-compareorder-'));
const app = await createApp({ dataFile: path.join(tmp, 'data.json'), semantic: null });
const base = await app.listen(0);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const call = async (method, p, body, role = 'creator') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-demo-role': role }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
/** A campaign with the given copy per revision (revision 1 first). */
const mk = async (title, ...texts) => {
  const r = await call('POST', '/api/submissions', { title, ...cleanContent(), text: texts[0] });
  if (r.status !== 201) throw new Error('setup: ' + JSON.stringify(r));
  for (let n = 1; n < texts.length; n++) {
    const s = await call('POST', `/api/submissions/${r.json.id}/revisions`, { baseRevision: n, ...cleanContent(), text: texts[n] });
    if (s.status !== 201) throw new Error('setup revision: ' + JSON.stringify(s));
  }
  return r.json.id;
};
const server = async (id) => {
  const r = (await call('GET', `/api/submissions/${id}`)).json;
  return { id, head: r.headRevision, texts: r.revisions.map((x) => x.text) };
};

// installed once in the page: the next `hold` comparison responses are held (each can be released on its own); `bad` makes the next comparison request ask for
// a revision that does not exist, so the server refuses it
const HOOK = `(() => {
  if (window.__cmp) return true;
  const original = window.fetch.bind(window);
  window.__cmp = { hold: 0, bad: false, held: [], requests: 0 };
  window.fetch = async (url, init) => {
    const c = window.__cmp;
    const get = !init || !init.method || init.method === 'GET';
    let u = String(url);
    if (get && u.includes('/compare?')) {
      c.requests++;
      if (c.bad) { c.bad = false; u = u.replace(/to=\\d+/, 'to=99'); }
      const res = await original(u, init);
      if (c.hold > 0) { c.hold--; await new Promise((r) => c.held.push({ url: String(url), release: r })); }
      return res;
    }
    return original(url, init);
  };
  return true;
})()`;

let b;
try {
  b = await launch(`${base}/#/workspace`, { port: Number(process.env.COMPAREORDER_PORT || 9491) });
  await b.viewport(1360, 900, false);
  const shot = (name) => {
    const file = path.join(shots, `${TAG}-${name}.png`);
    if (existsSync(file)) throw new Error(`refusing to overwrite an existing screenshot: ${file}`);
    return b.shot(file);
  };
  const go = async (hash, ms = 900) => {
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(ms);
  };
  const page = () =>
    b.eval(`(() => ({ hash: location.hash, crumb: document.getElementById('crumb')?.textContent ?? '', heading: document.querySelector('#main h1')?.textContent ?? '', wsHeading: document.querySelector('.ws-title h1')?.textContent ?? '', picker: document.querySelector('select[aria-label="Choose submission"]')?.value ?? '', cmp: document.querySelector('section[aria-label="Revision comparison"]')?.textContent ?? null, mainText: document.getElementById('main')?.textContent ?? '', editorOpen: Boolean(document.getElementById('draft-text')), draft: document.getElementById('draft-text')?.value ?? null, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }))()`);
  const arm = (hold, bad = false) => b.eval(`(() => { ${HOOK}; Object.assign(window.__cmp, { hold: ${hold}, bad: ${bad}, held: [], requests: 0 }); return true; })()`);
  const heldCount = () => b.eval('window.__cmp ? window.__cmp.held.length : 0'); // a reload drops the page's wrapper
  const releaseHeld = async (i) => {
    await b.eval(`window.__cmp.held[${i}].release()`);
    await b.wait(900);
  };
  const clickNth = async (text, n = 0) => {
    // the comparison buttons are in the History tab of the side panel (a new campaign opens on Findings)
    if (/^Compare/.test(text) && !(await b.eval(`[...document.querySelectorAll('button')].some((e) => e.textContent.trim() === ${JSON.stringify(text)})`))) {
      await b.click('History');
      await b.wait(200);
    }
    const ok = await b.eval(`(() => { const els = [...document.querySelectorAll('button')].filter((e) => e.textContent.trim() === ${JSON.stringify(text)}); const el = els[${n}]; if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`no button "${text}" #${n}`);
    await b.wait(300);
  };
  const typeDraft = (text) => b.eval(`(() => { const el = document.getElementById('draft-text'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const clearToasts = () => b.eval("document.querySelectorAll('.toast').forEach((t) => t.remove())");
  const obs = async (label, ids = []) => {
    const o = { label, page: await page(), held: await heldCount(), server: {} };
    for (const id of ids) o.server[id] = await server(id);
    const { mainText, ...slim } = o.page; // the log keeps what matters; the full text is checked by the tests
    console.log('OBS ' + JSON.stringify({ ...o, page: { ...slim, mainHasA: /UNIQUE [A-Z]+ (ORIGINAL|REVISED|THIRD)/.test(mainText) ? mainText.match(/UNIQUE [A-Z]+ (ORIGINAL|REVISED|THIRD)/)[0] : null } }));
    return o;
  };
  const stays = (o, id, title) => o.page.hash.endsWith(`/${id}`) && o.page.wsHeading === title && o.page.picker === id && o.page.crumb === `Workspace / ${id}` && o.page.cmp === null;
  const libraryIntact = (o) => o.page.hash === '#/library' && o.page.heading === 'Brand library' && o.page.crumb === 'Brand library' && o.page.wsHeading === '' && o.page.cmp === null;

  await b.eval(HOOK);

  // ---- control: a comparison is shown and closes; a refused one is reported on the page ----
  {
    const A = await mk('Cmp control', 'UNIQUE CC ORIGINAL copy.', 'UNIQUE CC REVISED copy.');
    await go(`#/workspace/${A}`);
    await arm(0);
    await clickNth('Compare with revision 1');
    await b.wait(700);
    const o = await obs('control-comparison-shown', [A]);
    await shot('control-comparison-shown');
    check('control: the comparison of revision 1 and 2 is shown on A', stays({ page: { ...o.page, cmp: null } }, A, 'Cmp control') && o.page.cmp !== null && /Revision 1 → revision 2/.test(o.page.cmp) && /UNIQUE CC (ORIGINAL|REVISED)/.test(o.page.cmp), JSON.stringify(o.page.cmp));
    await clickNth('Close comparison');
    const closed = await page();
    check('control: Close comparison closes it', closed.cmp === null && closed.wsHeading === 'Cmp control', JSON.stringify(closed.cmp));
    await clearToasts();
    await arm(0, true);
    await clickNth('Compare with revision 1');
    await b.wait(700);
    const err = await obs('control-refused-comparison', [A]);
    check('control: a comparison the server refuses (current page) is reported with the server\'s words and shows no comparison', err.page.cmp === null && err.page.toasts.some((t) => /Revision not found\./.test(t)) && err.page.wsHeading === 'Cmp control', JSON.stringify(err.page.toasts));
  }

  // ---- late success / late refusal after A -> B ----
  for (const refused of [false, true]) {
    const kind = refused ? 'refusal' : 'success';
    const A = await mk(`Cmp A ${kind}`, `UNIQUE A${kind[0].toUpperCase()} ORIGINAL copy.`, `UNIQUE A${kind[0].toUpperCase()} REVISED copy.`);
    const B = await mk(`Cmp B ${kind}`, `UNIQUE B${kind[0].toUpperCase()} ONLY copy.`);
    await go(`#/workspace/${A}`);
    await clearToasts();
    await arm(1, refused);
    await clickNth('Compare with revision 1');
    await b.wait(500);
    await go(`#/workspace/${B}`);
    const before = await obs(`late-${kind}-A-to-B-before-release`, [A, B]);
    check(`late ${kind} A -> B: the comparison answer is held in the browser and B is on screen`, before.held === 1 && stays(before, B, `Cmp B ${kind}`), JSON.stringify(before.page));
    await releaseHeld(0);
    const after = await obs(`late-${kind}-A-to-B-after-release`, [A, B]);
    await shot(`late-${kind}-A-to-B-after-release`);
    check(`late ${kind} A -> B: B stays B (address, picker, crumb, heading) with NO comparison card`, stays(after, B, `Cmp B ${kind}`), JSON.stringify(after.page));
    check(`late ${kind} A -> B: nothing of A appears anywhere under B, and no message is raised over B`, !/UNIQUE A/.test(after.page.mainText) && after.page.toasts.length === 0, JSON.stringify(after.page.toasts));
    await go(`#/workspace/${A}`);
    const back = await obs(`late-${kind}-back-to-A`, [A]);
    check(`late ${kind} A -> B: going back to A shows A normally, not a comparison nobody asked for`, stays(back, A, `Cmp A ${kind}`), JSON.stringify(back.page));
    await b.eval('location.reload()');
    await b.wait(1500);
    const rel = await obs(`late-${kind}-reload`, [A]);
    check(`late ${kind} A -> B: reloading A shows A normally`, stays(rel, A, `Cmp A ${kind}`), JSON.stringify(rel.page));
  }

  // ---- late success / refusal after A -> library, and A -> B's dossier ----
  for (const [label, refused] of [['library', false], ['library', true], ['dossier', false], ['dossier', true]]) {
    const kind = refused ? 'refusal' : 'success';
    const tag = `${label}-${kind}`;
    const A = await mk(`Cmp A ${tag}`, `UNIQUE A${label[0].toUpperCase()}${kind[0].toUpperCase()} ORIGINAL copy.`, `UNIQUE A${label[0].toUpperCase()}${kind[0].toUpperCase()} REVISED copy.`);
    const B = await mk(`Cmp B ${tag}`, `UNIQUE B${label[0].toUpperCase()}${kind[0].toUpperCase()} ONLY copy.`);
    await go(`#/workspace/${A}`);
    await clearToasts();
    await arm(1, refused);
    await clickNth('Compare with revision 1');
    await b.wait(500);
    const awayHash = label === 'library' ? '#/library' : `#/dossier/${B}`;
    await go(awayHash);
    const awayOk = (o) => (label === 'library' ? libraryIntact(o) : o.page.hash === awayHash && o.page.heading === `Review dossier: Cmp B ${tag}` && o.page.crumb === `Review dossier / ${B}` && o.page.wsHeading === '' && o.page.cmp === null);
    const before = await obs(`late-${tag}-before-release`, [A]);
    check(`late ${kind} -> ${label}: the answer is held and the ${label} is on screen`, before.held === 1 && awayOk(before), JSON.stringify(before.page));
    await releaseHeld(0);
    const after = await obs(`late-${tag}-after-release`, [A]);
    await shot(`late-${tag}-after-release`);
    check(`late ${kind} -> ${label}: the ${label} keeps the screen (address, heading, crumb), no comparison, no message`, awayOk(after) && !/UNIQUE A/.test(after.page.mainText) && after.page.toasts.length === 0, JSON.stringify(after.page));
    await go(`#/workspace/${A}`);
    const back = await obs(`late-${tag}-back-to-A`, [A]);
    check(`late ${kind} -> ${label}: going back to A shows A normally`, stays(back, A, `Cmp A ${tag}`), JSON.stringify(back.page));
  }

  // ---- back to A before the answer arrives: the answer must not appear unasked ----
  {
    const A = await mk('Cmp A return', 'UNIQUE AR ORIGINAL copy.', 'UNIQUE AR REVISED copy.');
    await go(`#/workspace/${A}`);
    await arm(1);
    await clickNth('Compare with revision 1');
    await b.wait(500);
    await go('#/library');
    await go(`#/workspace/${A}`);
    await releaseHeld(0);
    const o = await obs('return-to-A-before-release-then-released', [A]);
    check('away and back to A before the answer arrives: the late comparison does not appear unasked', stays(o, A, 'Cmp A return'), JSON.stringify(o.page.cmp));
  }

  // ---- B's unsaved draft survives A's late comparison ----
  {
    const A = await mk('Cmp A draft', 'UNIQUE AD ORIGINAL copy.', 'UNIQUE AD REVISED copy.');
    const B = await mk('Cmp B draft', 'UNIQUE BD ONLY copy.');
    await go(`#/workspace/${A}`);
    await arm(1);
    await clickNth('Compare with revision 1');
    await b.wait(500);
    await go(`#/workspace/${B}`);
    await clickNth('Edit as new revision');
    await typeDraft('B unsaved words that must survive.');
    await b.wait(300);
    await releaseHeld(0);
    const o = await obs('B-draft-after-late-comparison', [A, B]);
    await shot('B-draft-after-late-comparison');
    check('B\'s draft: B stays in its editor with the unsaved words, and no comparison replaces it', o.page.wsHeading === 'Cmp B draft' && o.page.picker === B && o.page.editorOpen && o.page.draft === 'B unsaved words that must survive.' && o.page.cmp === null && o.server[B].head === 1, JSON.stringify({ editor: o.page.editorOpen, draft: o.page.draft, cmp: o.page.cmp }));
  }

  // ---- two overlapping comparison choices: the latest choice wins, whatever order the answers arrive in ----
  for (const order of ['latest answer first', 'oldest answer first']) {
    const A = await mk(`Cmp A overlap ${order[0]}`, 'UNIQUE OV ONE copy.', 'UNIQUE OV TWO copy.', 'UNIQUE OV THREE copy.');
    await go(`#/workspace/${A}`);
    await arm(2);
    await clickNth('Compare with revision 1'); // revision 2 against 1: the OLDER choice
    await clickNth('Compare with revision 2'); // revision 3 against 2: the LATEST choice
    await b.wait(500);
    const mid = await obs(`overlap-${order}-both-held`, [A]);
    check(`overlap (${order}): both comparison requests are in flight`, mid.held === 2 && mid.page.cmp === null, JSON.stringify(mid.held));
    const first = order === 'latest answer first' ? 1 : 0;
    await releaseHeld(first);
    const one = await obs(`overlap-${order}-first-released`, [A]);
    await releaseHeld(first === 1 ? 0 : 1);
    const two = await obs(`overlap-${order}-both-released`, [A]);
    await shot(`overlap-${order.replace(/ /g, '-')}`);
    if (first === 1) check('overlap (latest answer first): the latest choice (revision 2 -> 3) is shown, and the older answer arriving afterwards does not replace it', /Revision 2 → revision 3/.test(one.page.cmp ?? '') && /Revision 2 → revision 3/.test(two.page.cmp ?? '') && !/ONE copy/.test(two.page.cmp ?? '') , JSON.stringify({ after1: (one.page.cmp ?? '').slice(0, 40), after2: (two.page.cmp ?? '').slice(0, 40) }));
    else check('overlap (oldest answer first): the older answer is not shown, the latest choice (revision 2 -> 3) ends up shown', one.page.cmp === null && /Revision 2 → revision 3/.test(two.page.cmp ?? ''), JSON.stringify({ after1: (one.page.cmp ?? '').slice(0, 40), after2: (two.page.cmp ?? '').slice(0, 40) }));
  }

  // ---- close / new edit while a comparison is pending cannot resurrect it ----
  {
    const A = await mk('Cmp A close', 'UNIQUE CL ONE copy.', 'UNIQUE CL TWO copy.', 'UNIQUE CL THREE copy.');
    await go(`#/workspace/${A}`);
    await arm(0);
    await clickNth('Compare with revision 1'); // shown: revision 1 -> 2
    await b.wait(600);
    await arm(1);
    await clickNth('Compare with revision 2'); // pending: revision 2 -> 3, while 1 -> 2 is shown
    await b.wait(400);
    await clickNth('Close comparison');
    await releaseHeld(0);
    const o = await obs('close-while-pending', [A]);
    await shot('close-while-pending');
    check('close while pending: the comparison the person closed is not resurrected by the late answer', stays(o, A, 'Cmp A close'), JSON.stringify((o.page.cmp ?? '').slice(0, 60)));
  }
  {
    const A = await mk('Cmp A edit', 'UNIQUE ED ONE copy.', 'UNIQUE ED TWO copy.');
    await go(`#/workspace/${A}`);
    await arm(1);
    await clickNth('Compare with revision 1');
    await b.wait(400);
    await clickNth('Edit as new revision');
    await typeDraft('UNIQUE ED my own new words.');
    await b.wait(300);
    await releaseHeld(0);
    const o = await obs('new-edit-while-pending', [A]);
    await shot('new-edit-while-pending');
    check('new edit while pending: the late comparison does not replace the editor or lose the draft', o.page.editorOpen && o.page.draft === 'UNIQUE ED my own new words.' && o.page.cmp === null, JSON.stringify({ editor: o.page.editorOpen, draft: o.page.draft, cmp: (o.page.cmp ?? '').slice(0, 40) }));
  }

  check('no console exceptions', b.consoleMsgs.filter((m) => /EXCEPTION/.test(m)).length === 0, b.consoleMsgs.filter((m) => /EXCEPTION/.test(m)).slice(0, 2).join(' | '));
} finally {
  await b?.close();
  await app.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed. Screenshots: ${shots} (${TAG}-*.png)`);
process.exit(passed === results.length ? 0 : 1);
