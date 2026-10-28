// m29: a save whose response is slow, while the person goes to another campaign and edits it. Real UI, real server, SYNTHETIC data in a
// throwaway directory; never touches data/.
//
//   npm run ui-smoke-save-race
//
// The server handles every request normally. Only the DELIVERY of one save's response to the page is held (a fetch wrapper installed
// in the page, the way a slow network would behave), so the order is: A's save reaches the server -> the person picks B in the
// picker and starts editing B -> A's response arrives. Each scenario prints an OBS line with what the page shows (address, crumb,
// heading, picker, editor, B's draft) and what the server holds for A and B, and then the checks.
//
//   control        a normal save of A, nothing held: the reference behaviour
//   late success   A's save succeeds late, after the person moved to B and typed in B
//   late error     A's save is refused late (409, someone saved A first), after the same moves
//   duplicate      Save pressed twice while the first save is in flight
//   edit-in-flight text typed into A after pressing Save, before the response
//   no navigation  a held save the person simply waits for (the editor must still close and show the new revision)
// Screenshots go to docs/evidence/saverace-*.png (SAVERACE_SHOT_TAG overrides the prefix).
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { cleanContent } from '../../tests/helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const TAG = process.env.SAVERACE_SHOT_TAG || 'saverace';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-saverace-'));
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
const mk = async (title, text) => {
  const r = await call('POST', '/api/submissions', { title, ...cleanContent(), text });
  if (r.status !== 201) throw new Error('setup: ' + JSON.stringify(r));
  return r.json.id;
};
const server = async (id) => {
  const r = (await call('GET', `/api/submissions/${id}`)).json;
  return { id, head: r.headRevision, text: r.revisions.at(-1).text, revisions: r.revisions.length };
};

// installed once in the page: delivery of ONE matching save response can be held; every matching POST is counted
const HOOK = `(() => {
  if (window.__hold) return true;
  const original = window.fetch.bind(window);
  window.__hold = { id: null, armed: false, posts: 0, release: null, held: false, listArmed: false, listHeld: false, releaseList: null };
  window.fetch = async (url, init) => {
    const res = await original(url, init);
    const h = window.__hold;
    // one-shot: hold the delivery of the next campaign-list refresh (the one a save makes after it succeeded)
    if (h.listArmed && (!init || !init.method || init.method === 'GET') && String(url) === '/api/submissions') { h.listArmed = false; h.listHeld = true; await new Promise((r) => (h.releaseList = r)); h.listHeld = false; }
    if (init && init.method === 'POST' && h.id && String(url).endsWith('/api/submissions/' + h.id + '/revisions')) {
      h.posts++;
      if (h.armed) { h.armed = false; h.held = true; await new Promise((r) => (h.release = r)); h.held = false; }
    }
    return res;
  };
  return true;
})()`;

const only = process.env.SAVERACE_ONLY;
const want = (name) => !only || only === name;

let b;
try {
  b = await launch(`${base}/#/workspace`, { port: Number(process.env.SAVERACE_PORT || 9461) });
  await b.viewport(1360, 900, false);
  const shot = (name) => b.shot(path.join(shots, `${TAG}-${name}.png`));
  const go = async (hash) => {
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(900);
  };
  const page = () => b.eval(`(() => ({ hash: location.hash, crumb: document.getElementById('crumb')?.textContent ?? '', heading: document.querySelector('.ws-title h1')?.textContent ?? '', picker: document.querySelector('select[aria-label="Choose submission"]')?.value ?? '', editorOpen: Boolean(document.getElementById('draft-text')), draft: document.getElementById('draft-text')?.value ?? null, saveButton: [...document.querySelectorAll('button')].filter((x) => /^(Save as revision|Saving)/.test(x.textContent.trim())).map((x) => x.textContent.trim() + (x.disabled ? ' [disabled]' : '')), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }))()`);
  const arm = (id) => b.eval(`(() => { ${HOOK}; Object.assign(window.__hold, { id: ${JSON.stringify(id)}, armed: true, posts: 0 }); return true; })()`);
  const disarm = () => b.eval(`(() => { ${HOOK}; Object.assign(window.__hold, { armed: false, id: null }); return true; })()`);
  const counts = () => b.eval(`({ posts: window.__hold.posts, held: window.__hold.held })`);
  const release = async () => {
    await b.eval(`window.__hold.release && window.__hold.release()`);
    await b.wait(1200);
  };
  const openEditor = async (id) => {
    await b.eval("document.querySelectorAll('.toast').forEach((t) => t.remove())"); // each scenario reads only its own messages
    await go(`#/workspace/${id}`);
    await b.click('Edit as new revision');
  };
  const type = async (text) => b.type('#draft-text', text);
  const obs = async (label, ids) => {
    const o = { label, page: await page(), server: {} };
    for (const id of ids) o.server[id] = await server(id);
    console.log('OBS ' + JSON.stringify(o));
    return o;
  };

  await b.eval(HOOK);

  // ---- control: a normal save ----
  if (want('control')) {
    const A = await mk('Control A', 'Control A original copy for the lamp.');
    await openEditor(A);
    await type('Control A saved copy for the lamp.');
    await disarm();
    await b.eval(`window.__hold.id = ${JSON.stringify(A)}; window.__hold.posts = 0`);
    await b.click('Save as revision');
    await b.wait(800);
    const o = await obs('control-after-save', [A]);
    await shot('control-after-save');
    check('control: a normal save closes the editor on the same campaign and shows the new revision', !o.page.editorOpen && o.page.hash.endsWith(A) && o.page.heading === 'Control A' && o.server[A].head === 2 && o.server[A].text === 'Control A saved copy for the lamp.');
    check('control: the save is announced', o.page.toasts.some((t) => /Saved revision 2/.test(t)));
  }

  // ---- no navigation: a held save that is simply waited for ----
  if (want('wait')) {
    const A = await mk('Wait A', 'Wait A original copy for the lamp.');
    await openEditor(A);
    await type('Wait A saved copy for the lamp.');
    await arm(A);
    await b.click('Save as revision');
    const during = await obs('wait-during-save', [A]);
    check('no navigation: while the save is in flight the Save button cannot be pressed again', during.page.saveButton.length > 0 && during.page.saveButton.every((s) => /disabled|Saving/.test(s)), JSON.stringify(during.page.saveButton));
    await release();
    const o = await obs('wait-after-release', [A]);
    check('no navigation: when the response arrives the editor closes and the campaign shows its new revision', !o.page.editorOpen && o.page.hash.endsWith(A) && o.server[A].head === 2);
  }

  // ---- late success: A's save held, go to B, edit B, release A ----
  if (want('late-success')) {
    const A = await mk('Race A', 'Race A original copy for the lamp.');
    const B = await mk('Race B', 'Race B original copy for the lamp.');
    await openEditor(A);
    await type('Race A edited copy for the lamp.');
    await arm(A);
    await b.click('Save as revision');
    const mid = await obs('late-success-A-save-held', [A, B]);
    check('late success: the server already has A revision 2 while its response is held', mid.server[A].head === 2);
    await b.select('select[aria-label="Choose submission"]', B);
    await b.click('Edit as new revision');
    await type('Race B unsaved edit that must survive.');
    const before = await obs('late-success-B-editing-before-release', [A, B]);
    await shot('late-success-1-B-editing');
    check('late success (setup): the person is on B, in B\'s editor, with B\'s edit typed', before.page.hash.endsWith(B) && before.page.heading === 'Race B' && before.page.draft === 'Race B unsaved edit that must survive.');
    await release();
    const after = await obs('late-success-after-release', [A, B]);
    await shot('late-success-2-after-release');
    check('late success: the address is still B and the page still shows B (not A)', after.page.hash.endsWith(B) && after.page.heading === 'Race B' && after.page.crumb.includes(B) && after.page.picker === B, `${after.page.hash} | ${after.page.crumb} | ${after.page.heading} | picker ${after.page.picker}`);
    check('late success: B\'s editor is still open with B\'s unsaved text', after.page.editorOpen && after.page.draft === 'Race B unsaved edit that must survive.', JSON.stringify({ editorOpen: after.page.editorOpen, draft: after.page.draft }));
    check('late success: the person is told A was saved (naming A, since they are elsewhere)', after.page.toasts.some((t) => t.includes(A) && /Saved revision 2/.test(t)), JSON.stringify(after.page.toasts));
    check('late success: the server holds A revision 2 and B untouched', after.server[A].head === 2 && after.server[B].head === 1);
  }

  // ---- late error: A's save is refused late, after the person moved on ----
  if (want('late-error')) {
    const A = await mk('Err A', 'Err A original copy for the lamp.');
    const B = await mk('Err B', 'Err B original copy for the lamp.');
    await openEditor(A);
    await type('Err A my edit for the lamp.');
    const other = await call('POST', `/api/submissions/${A}/revisions`, { baseRevision: 1, text: 'Err A saved by someone else for the lamp.', asset: {} });
    if (other.status !== 201) throw new Error('setup: ' + JSON.stringify(other));
    await arm(A);
    await b.click('Save as revision');
    await b.select('select[aria-label="Choose submission"]', B);
    await b.click('Edit as new revision');
    await type('Err B unsaved edit that must survive.');
    await release();
    const after = await obs('late-error-after-release', [A, B]);
    await shot('late-error-after-release');
    check('late error: the page still shows B in B\'s editor with B\'s unsaved text', after.page.hash.endsWith(B) && after.page.heading === 'Err B' && after.page.editorOpen && after.page.draft === 'Err B unsaved edit that must survive.', JSON.stringify({ hash: after.page.hash, heading: after.page.heading, editorOpen: after.page.editorOpen, draft: after.page.draft }));
    check('late error: the person is told that A\'s save was refused (naming A)', after.page.toasts.some((t) => t.includes(A)), JSON.stringify(after.page.toasts));
    check('late error: the server keeps the other person\'s A revision 2 and nothing was overwritten', after.server[A].head === 2 && /someone else/.test(after.server[A].text) && after.server[B].head === 1);
  }

  // ---- duplicate: Save pressed twice during one in-flight save ----
  if (want('duplicate')) {
    const A = await mk('Dup A', 'Dup A original copy for the lamp.');
    await openEditor(A);
    await type('Dup A edited copy for the lamp.');
    await arm(A);
    await b.click('Save as revision');
    await b.eval(`[...document.querySelectorAll('button')].find((x) => /^(Save as revision|Saving)/.test(x.textContent.trim()))?.click()`);
    // and a press that gets past the disabled button (another code path, a stale handler): the save itself must still refuse to send twice
    await b.eval(`(() => { const x = [...document.querySelectorAll('button')].find((y) => /^(Save as revision|Saving)/.test(y.textContent.trim())); if (x) { x.disabled = false; x.click(); } return true; })()`);
    await b.wait(500);
    const n = await counts();
    await release();
    const after = await obs('duplicate-after-release', [A]);
    check('duplicate: pressing Save twice sends exactly one save', n.posts === 1, `posts ${n.posts}`);
    check('duplicate: exactly one "Saved" message and no conflict message after a successful save', after.page.toasts.length === 1 && /^Saved revision 2.$/.test(after.page.toasts[0]) && after.server[A].head === 2, JSON.stringify(after.page.toasts));
  }

  // ---- edit in flight: words typed with the keyboard after pressing Save, before the response ----
  if (want('edit-in-flight')) {
    const A = await mk('Typing A', 'Typing A original copy for the lamp.');
    await openEditor(A);
    await type('Typing A first saved copy for the lamp.');
    await arm(A);
    await b.click('Save as revision');
    // a real keyboard attempt: focus the field (not possible if it is locked) and type
    const locked = await b.eval(`(() => { const t = document.getElementById('draft-text'); if (!t) return 'gone'; const inert = Boolean(t.closest('[inert]')); t.focus(); return inert ? 'locked' : 'open'; })()`);
    await b.insertText(' EXTRA-WORDS typed while the save was in flight.');
    const during = await page();
    await release();
    const after = await obs('edit-in-flight-after-release', [A]);
    await shot('edit-in-flight-after-release');
    const typed = /EXTRA-WORDS/.test(during.draft ?? '');
    const keptOnScreen = after.page.editorOpen && /EXTRA-WORDS/.test(after.page.draft ?? '');
    const savedOnServer = /EXTRA-WORDS/.test((await server(A)).text);
    console.log('OBS ' + JSON.stringify({ label: 'edit-in-flight-summary', field: locked, typedIntoField: typed, keptOnScreen, savedOnServer }));
    check('edit in flight: words typed during a save are never silently lost (the field is locked so they cannot be typed, or they are kept on screen, or they are saved)', locked === 'locked' ? !typed : typed ? keptOnScreen || savedOnServer : true, JSON.stringify({ field: locked, typed, keptOnScreen, savedOnServer }));
    check('edit in flight: while saving, the form says so and cannot be edited (locked)', locked === 'locked');
  }

  // ---- return: the person leaves A and comes back to it before the response arrives ----
  if (want('return')) {
    const A = await mk('Return A', 'Return A original copy for the lamp.');
    const B = await mk('Return B', 'Return B original copy for the lamp.');
    await openEditor(A);
    await type('Return A edited copy for the lamp.');
    await arm(A);
    await b.click('Save as revision');
    await b.select('select[aria-label="Choose submission"]', B);
    await b.select('select[aria-label="Choose submission"]', A);
    await release();
    const after = await obs('return-after-release', [A, B]);
    await shot('return-after-release');
    check('return: back on A, the page shows A at its new revision 2 (not a stale page, not an open editor)', after.page.hash.endsWith(A) && after.page.heading === 'Return A' && !after.page.editorOpen && after.server[A].head === 2 && (await b.eval(`document.querySelector('.ws-title')?.innerText.includes('Revision 2')`)), JSON.stringify(after.page));
    check('return: the person is told A was saved, by name', after.page.toasts.some((t) => t.includes(A) && /Saved revision 2/.test(t)), JSON.stringify(after.page.toasts));
  }

  // ---- reload race: the person moves to B while the refresh that follows a successful save is still out ----
  if (want('reload-race')) {
    const A = await mk('Reload A', 'Reload A original copy for the lamp.');
    const B = await mk('Reload B', 'Reload B original copy for the lamp.');
    await openEditor(A);
    await type('Reload A edited copy for the lamp.');
    await b.eval("(() => { window.__hold.id = null; window.__hold.listArmed = true; return true; })()");
    await b.click('Save as revision');
    const held = await b.eval('window.__hold.listHeld');
    await b.select('select[aria-label="Choose submission"]', B);
    await b.eval('window.__hold.releaseList && window.__hold.releaseList()');
    await b.wait(1200);
    const after = await obs('reload-race-after-release', [A, B]);
    await shot('reload-race-after-release');
    check('reload race (setup): the refresh after the save of A was in flight when the person chose B', held === true);
    check('reload race: the refreshed page of A is not painted over B (address, page and picker all say B)', after.page.hash.endsWith(B) && after.page.heading === 'Reload B' && after.page.crumb.includes(B) && after.page.picker === B, JSON.stringify(after.page));
    check('reload race: A is saved on the server and B untouched', after.server[A].head === 2 && after.server[B].head === 1);
  }

  // ---- consequence: what the page that is left behind lets the person do (A's detail under B's address) ----
  if (want('consequence')) {
    const A = await mk('Cons A', 'Cons A original copy for the lamp.');
    const B = await mk('Cons B', 'Cons B original copy for the lamp.');
    const b2 = await call('POST', `/api/submissions/${B}/revisions`, { baseRevision: 1, text: 'Cons B second revision, its own words.', asset: {} });
    if (b2.status !== 201) throw new Error('setup: ' + JSON.stringify(b2));
    await openEditor(A);
    await type('Cons A edited copy: words that belong to campaign A only.');
    await arm(A);
    await b.click('Save as revision');
    await b.select('select[aria-label="Choose submission"]', B);
    await release();
    const left = await obs('consequence-page-left-behind', [A, B]);
    await shot('consequence-1-left-behind');
    const stillB = left.page.hash.endsWith(B) && left.page.heading === 'Cons B';
    if (stillB) {
      // the correct state: B's page. Edit and save B, as a normal person would.
      await b.click('Edit as new revision');
      await type('Cons B edited copy by its own owner.');
    } else {
      // the left-behind state: the page says A, the address says B. The person does the natural thing, edits what they see and saves.
      await b.click('Edit as new revision');
      await b.eval("document.getElementById('draft-text') && (document.getElementById('draft-text').value += ' (one more word)', document.getElementById('draft-text').dispatchEvent(new Event('input', { bubbles: true })))");
    }
    await b.click('Save as revision');
    await b.wait(800);
    const end = await obs('consequence-after-second-save', [A, B]);
    await shot('consequence-2-after-second-save');
    const bText = (await call('GET', `/api/submissions/${B}`)).json.revisions.map((r) => r.text);
    check('consequence: no revision of B ever contains words that belong to A', !bText.some((t) => /belong to campaign A only/.test(t)), JSON.stringify(bText));
    check('consequence: editing what the page shows and saving changes only the campaign the page shows', end.page.heading === (stillB ? 'Cons B' : 'Cons A') && end.server[A].head === 2, JSON.stringify({ heading: end.page.heading, aHead: end.server[A].head, bHead: end.server[B].head }));
  }
  check('no console exceptions', b.consoleMsgs.filter((m) => /EXCEPTION/.test(m)).length === 0, b.consoleMsgs.filter((m) => /EXCEPTION/.test(m)).slice(0, 2).join(' | '));
} finally {
  await b?.close();
  await app.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed. Screenshots: ${shots} (${TAG}-*.png)`);
process.exit(passed === results.length ? 0 : 1);
