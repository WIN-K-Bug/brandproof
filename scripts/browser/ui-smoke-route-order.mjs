// m32: a page's response that arrives AFTER the person has already moved on. Real UI, real server, SYNTHETIC data in a throwaway directory;
// never touches data/.
//
//   npm run ui-smoke-route-order
//
// The server handles every request normally. Only the DELIVERY of one response to the page is held (a fetch wrapper installed in the
// page, the way a slow network would behave), so the order is: the request for page X reaches the server and is answered -> the person
// goes somewhere else and that page finishes -> X's answer is delivered. The page must keep showing where the person is.
//
//   control            a normal move from campaign A to campaign B, nothing held
//   late success       A's detail held, B completes, A released (campaign picker / address / crumb / heading must stay B)
//   late refusal       a campaign the server refuses (404) held, B completes, the refusal released
//   away to library    A's detail held, the person opens the Brand library, A released
//   away to dossier    A's detail held, the person opens B's dossier, A released
//   list pending       the workspace's own campaign-list request held, the person opens the library, released
//   dossier pending    A's dossier held, the person opens B in the workspace, released
//   library/queue/insights/sources pending   the same, one page at a time
//   consequence        after the late A answer, edit and save what the page shows: no revision of B may contain A's words
//   action then navigate (m32b)   a save whose POST response is held, then the library / a dossier / another campaign; a refused save; a save whose
//                                 follow-up list request is held. The late result must be named, must not repaint, must not lose B's draft, and
//                                 going back or reloading must show the committed revision
//   back / reload      normal navigation still works after all of the above
// Screenshots go to docs/evidence/routeorder-*.png (ROUTEORDER_SHOT_TAG overrides the prefix; an existing file is never overwritten).
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
const TAG = process.env.ROUTEORDER_SHOT_TAG || 'routeorder';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-routeorder-'));
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
  return { id, head: r.headRevision, texts: r.revisions.map((x) => x.text) };
};

// installed once in the page: delivery of ONE matching GET response can be held (the n-th match, counting from 0)
const HOOK = `(() => {
  if (window.__hold) return true;
  const original = window.fetch.bind(window);
  window.__hold = { url: null, skip: 0, held: false, release: null, seen: [], post: null, postHeld: false, postRelease: null };
  window.fetch = async (url, init) => {
    const res = await original(url, init);
    const h = window.__hold;
    const get = !init || !init.method || init.method === 'GET';
    if (init && init.method === 'POST' && h.post && String(url).endsWith(h.post)) { h.post = null; h.postHeld = true; await new Promise((r) => (h.postRelease = r)); h.postHeld = false; }
    if (get) h.seen.push(String(url));
    if (get && h.url && String(url) === h.url) {
      if (h.skip > 0) h.skip--;
      else { h.url = null; h.held = true; await new Promise((r) => (h.release = r)); h.held = false; }
    }
    return res;
  };
  return true;
})()`;

let b;
try {
  b = await launch(`${base}/#/workspace`, { port: Number(process.env.ROUTEORDER_PORT || 9471) });
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
    b.eval(`(() => ({ hash: location.hash, crumb: document.getElementById('crumb')?.textContent ?? '', heading: document.querySelector('#main h1')?.textContent ?? '', wsHeading: document.querySelector('.ws-title h1')?.textContent ?? '', rev: [...document.querySelectorAll('.ws-title .chip')].map((c) => c.textContent).find((t) => /^Revision/.test(t)) ?? '', picker: document.querySelector('select[aria-label="Choose submission"]')?.value ?? '', notice: document.querySelector('#main .notice.err')?.textContent ?? '', editorOpen: Boolean(document.getElementById('draft-text')), draft: document.getElementById('draft-text')?.value ?? null, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }))()`);
  const arm = (url, skip = 0) => b.eval(`(() => { ${HOOK}; Object.assign(window.__hold, { url: ${JSON.stringify(url)}, skip: ${skip}, held: false }); return true; })()`);
  const held = () => b.eval('Boolean(window.__hold && (window.__hold.held || window.__hold.postHeld))');
  const armPost = (suffix) => b.eval(`(() => { ${HOOK}; window.__hold.post = ${JSON.stringify(suffix)}; return true; })()`);
  const releasePost = async () => {
    await b.eval('window.__hold.postRelease && window.__hold.postRelease()');
    await b.wait(1200);
  };
  const typeDraft = (text) => b.eval(`(() => { const el = document.getElementById('draft-text'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const release = async () => {
    await b.eval('window.__hold.release && window.__hold.release()');
    await b.wait(1200);
  };
  const obs = async (label, ids = []) => {
    const o = { label, page: await page(), held: await held(), server: {} };
    for (const id of ids) o.server[id] = await server(id);
    console.log('OBS ' + JSON.stringify(o));
    return o;
  };
  const stays = (o, id, title) => o.page.hash.endsWith(`/${id}`) && o.page.wsHeading === title && o.page.picker === id && o.page.crumb === `Workspace / ${id}` && !o.page.notice;

  await b.eval(HOOK);

  // ---- control: a normal move A -> B ----
  const cA = await mk('Control A', 'Control A copy belongs to campaign CA only.');
  const cB = await mk('Control B', 'Control B copy belongs to campaign CB only.');
  await go(`#/workspace/${cA}`);
  await go(`#/workspace/${cB}`);
  {
    const o = await obs('control-A-to-B', [cA, cB]);
    await shot('control-A-to-B');
    check('control: moving from A to B shows B (address, picker, crumb, heading)', stays(o, cB, 'Control B'), JSON.stringify(o.page));
  }

  // ---- late success: A held, B completes, A released ----
  {
    const A = await mk('Race A', 'Race A copy belongs to campaign A only.');
    const B = await mk('Race B', 'Race B copy belongs to campaign B only.');
    await go(`#/workspace/${B}`);
    await arm(`/api/submissions/${A}`);
    await go(`#/workspace/${A}`, 600);
    const mid = await obs('late-success-A-held', [A, B]);
    check('late success: A\'s detail answer is held in the browser while the server has already answered', mid.held === true);
    await go(`#/workspace/${B}`);
    const before = await obs('late-success-B-completed-before-release', [A, B]);
    await shot('late-success-1-B-completed');
    check('late success: B is on screen before the held answer arrives', stays(before, B, 'Race B'), JSON.stringify(before.page));
    await release();
    const after = await obs('late-success-after-release', [A, B]);
    await shot('late-success-2-after-release');
    check('late success: after A\'s answer arrives the page still shows B (address, picker, crumb, heading all agree)', stays(after, B, 'Race B'), JSON.stringify(after.page));

    // consequence: the person edits what the page shows and saves
    await b.click('Edit as new revision');
    await b.eval(`(() => { const el = document.getElementById('draft-text'); el.value += ' Added by the person.'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await b.wait(500);
    const draftOpen = await page();
    check('late success: the editor opened on B\'s own copy, not A\'s', draftOpen.draft !== null && /campaign B only/.test(draftOpen.draft) && !/campaign A only/.test(draftOpen.draft), JSON.stringify(draftOpen.draft));
    await b.click('Save as revision');
    await b.wait(900);
    const end = await obs('late-success-consequence-after-save', [A, B]);
    await shot('late-success-3-after-save');
    check('late success: no revision of B contains A\'s words, and A is untouched', !end.server[B].texts.some((t) => /campaign A only/.test(t)) && end.server[A].head === 1, JSON.stringify({ B: end.server[B].texts, aHead: end.server[A].head }));
  }

  // ---- late refusal: a refused request (404, real) held, B completes, refusal released ----
  {
    const B = await mk('Refusal B', 'Refusal B copy belongs to campaign RB only.');
    await go(`#/workspace/${B}`);
    await arm('/api/submissions/SUB-9999');
    await go('#/workspace/SUB-9999', 600);
    const mid = await obs('late-refusal-held', [B]);
    check('late refusal: the 404 answer is held in the browser', mid.held === true);
    await go(`#/workspace/${B}`);
    await release();
    const after = await obs('late-refusal-after-release', [B]);
    await shot('late-refusal-after-release');
    check('late refusal: a refusal for an address the person has left does not replace B', stays(after, B, 'Refusal B'), JSON.stringify(after.page));
  }

  // ---- edit while the next campaign is still loading: the page still shows A, the address already says B ----
  {
    const A = await mk('Load A', 'Load A copy belongs to campaign LA only.');
    const B = await mk('Load B', 'Load B copy belongs to campaign LB only.');
    await go(`#/workspace/${A}`);
    await arm(`/api/submissions/${B}`);
    await go(`#/workspace/${B}`, 600);
    const mid = await obs('edit-while-loading-held', [A, B]);
    check('edit while loading: B\'s answer is held and the page still shows A', mid.held === true && mid.page.wsHeading === 'Load A', JSON.stringify(mid.page));
    await b.click('Edit as new revision');
    await b.eval(`(() => { const el = document.getElementById('draft-text'); el.value += ' Typed while B was loading.'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await b.wait(400);
    await release();
    const after = await obs('edit-while-loading-after-release', [A, B]);
    await shot('edit-while-loading-after-release');
    check('edit while loading: when B arrives the page shows B', stays(after, B, 'Load B'), JSON.stringify(after.page));
    check('edit while loading: no editor holding A\'s copy is open on B\'s page', !(after.page.editorOpen && /campaign LA only/.test(after.page.draft ?? '')), JSON.stringify(after.page.draft));
    if (after.page.editorOpen) {
      await b.click('Save as revision');
      await b.wait(900);
    }
    const end = await obs('edit-while-loading-after-save', [A, B]);
    check('edit while loading: no revision of B contains A\'s words, and A is untouched', !end.server[B].texts.some((t) => /campaign LA only/.test(t)) && end.server[A].head === 1, JSON.stringify({ B: end.server[B].texts, aHead: end.server[A].head }));
  }

  // ---- away to library / dossier while the detail is pending ----
  {
    const A = await mk('Away A', 'Away A copy belongs to campaign AA only.');
    const B = await mk('Away B', 'Away B copy belongs to campaign AB only.');
    await go(`#/workspace/${B}`);
    await arm(`/api/submissions/${A}`);
    await go(`#/workspace/${A}`, 600);
    await go('#/library');
    const before = await obs('away-library-before-release', [A]);
    check('away to library: the library is on screen before the held answer arrives', before.page.hash === '#/library' && before.page.heading === 'Brand library', JSON.stringify(before.page));
    await release();
    const after = await obs('away-library-after-release', [A]);
    await shot('away-library-after-release');
    check('away to library: A\'s late detail does not paint over the library (address, crumb, heading)', after.page.hash === '#/library' && after.page.heading === 'Brand library' && after.page.crumb === 'Brand library' && after.page.wsHeading === '', JSON.stringify(after.page));
    // normal navigation still works afterwards
    await go(`#/workspace/${A}`);
    const again = await page();
    check('away to library: opening A afterwards works normally', stays({ page: again }, A, 'Away A'), JSON.stringify(again));

    await go(`#/workspace/${B}`);
    await arm(`/api/submissions/${A}`);
    await go(`#/workspace/${A}`, 600);
    await go(`#/dossier/${B}`);
    const beforeD = await obs('away-dossier-before-release', [A]);
    check('away to dossier: B\'s dossier is on screen before the held answer arrives', beforeD.page.hash === `#/dossier/${B}` && /^Review dossier: Away B/.test(beforeD.page.heading), JSON.stringify(beforeD.page));
    await release();
    const afterD = await obs('away-dossier-after-release', [A]);
    await shot('away-dossier-after-release');
    check('away to dossier: A\'s late detail does not paint over the dossier', afterD.page.hash === `#/dossier/${B}` && /^Review dossier: Away B/.test(afterD.page.heading) && afterD.page.wsHeading === '' && afterD.page.crumb === `Review dossier / ${B}`, JSON.stringify(afterD.page));
  }

  // ---- the workspace's own campaign-list request pending (no campaign in the address) ----
  {
    await go('#/library');
    await arm('/api/submissions', 1); // the route's own list is the first GET, the workspace's own is the second
    await go('#/workspace', 600);
    const mid = await obs('list-pending-held');
    check('list pending: the workspace\'s own list answer is held', mid.held === true, JSON.stringify(mid.page));
    await go('#/library');
    await release();
    const after = await obs('list-pending-after-release');
    await shot('list-pending-after-release');
    check('list pending: the late list does not send the person back to the workspace or paint over the library', after.page.hash === '#/library' && after.page.heading === 'Brand library' && after.page.wsHeading === '', JSON.stringify(after.page));
  }

  // ---- other pages pending, then the person goes to a campaign ----
  const pendingThenCampaign = async (label, hash, url, skip, expectNotHeading) => {
    const B = await mk(`${label} B`, `${label} B copy belongs to campaign PB only.`);
    await go(`#/workspace/${B}`);
    await arm(url, skip);
    await go(hash, 600);
    const mid = await obs(`${label}-held`, [B]);
    await go(`#/workspace/${B}`);
    await release();
    const after = await obs(`${label}-after-release`, [B]);
    await shot(`${label}-after-release`);
    check(`${label}: held answer received (the test is meaningful)`, mid.held === true, JSON.stringify(mid.page));
    check(`${label}: its late answer does not paint over campaign B`, stays(after, B, `${label} B`) && after.page.heading !== expectNotHeading, JSON.stringify(after.page));
  };
  {
    const A = await mk('Dossier A', 'Dossier A copy belongs to campaign DA only.');
    await pendingThenCampaign('dossier-pending', `#/dossier/${A}`, `/api/submissions/${A}/dossier`, 0, 'Review dossier: Dossier A');
  }
  await pendingThenCampaign('library-pending', '#/library', '/api/guidelines', 0, 'Brand library');
  await pendingThenCampaign('insights-pending', '#/insights', '/api/insights', 0, 'Insights');
  await pendingThenCampaign('sources-pending', '#/sources', '/api/sources', 0, 'Sources');
  await pendingThenCampaign('queue-pending', '#/queue', '/api/submissions', 1, 'Review queue');

  // ---- m32b: an ACTION (save) whose answer arrives after the person has moved on ----
  const libraryIntact = (o) => o.page.hash === '#/library' && o.page.heading === 'Brand library' && o.page.crumb === 'Brand library' && o.page.wsHeading === '';
  const beginSave = async (A, text) => {
    await b.eval("document.querySelectorAll('.toast').forEach((t) => t.remove())");
    await go(`#/workspace/${A}`);
    await b.click('Edit as new revision');
    await typeDraft(text);
    await b.wait(300);
  };
  {
    // control: a completed save with nothing held
    const A = await mk('Act control', 'Act control original copy belongs to campaign XC only.');
    await beginSave(A, 'Act control saved copy belongs to campaign XC only.');
    await b.click('Save as revision');
    await b.wait(900);
    const o = await obs('action-control-after-save', [A]);
    await shot('action-control-after-save');
    check('action control: a normal save closes the editor on the same campaign and shows revision 2', stays(o, A, 'Act control') && !o.page.editorOpen && o.page.rev === 'Revision 2' && o.server[A].head === 2 && o.page.toasts.some((t) => /^Saved revision 2\.$/.test(t)), JSON.stringify(o.page));
  }
  for (const label of ['library', 'dossier']) {
    // held success, then another page: A's save reaches the server, the answer is held, the person goes away, the answer arrives
    const title = `Act success ${label}`;
    const A = await mk(title, `${title} original copy belongs to campaign XS only.`);
    const awayHash = label === 'library' ? '#/library' : `#/dossier/${A}`;
    const awayHeading = label === 'library' ? 'Brand library' : `Review dossier: ${title}`;
    const awayCrumb = label === 'library' ? 'Brand library' : `Review dossier / ${A}`;
    const awayOk = (o) => o.page.hash === awayHash && o.page.heading === awayHeading && o.page.crumb === awayCrumb && o.page.wsHeading === '' && !o.page.editorOpen;
    await beginSave(A, `${title} saved copy belongs to campaign XS only.`);
    await armPost('/revisions');
    await b.click('Save as revision');
    await b.wait(600);
    await go(awayHash);
    const before = await obs(`action-success-${label}-before-release`, [A]);
    check(`action success -> ${label}: the save is held (the server already has revision 2) and the ${label} is on screen`, before.held === true && awayOk(before) && before.server[A].head === 2, JSON.stringify(before.page));
    await releasePost();
    const after = await obs(`action-success-${label}-after-release`, [A]);
    await shot(`action-success-${label}-after-release`);
    check(`action success -> ${label}: the late save result does not repaint over the ${label} (address, heading, crumb)`, awayOk(after), JSON.stringify(after.page));
    check(`action success -> ${label}: the late result is announced by name (not as if it were this page)`, after.page.toasts.some((t) => t === `Saved revision 2 of ${A}.`), JSON.stringify(after.page.toasts));
    await go(`#/workspace/${A}`);
    const back = await obs(`action-success-${label}-back-to-A`, [A]);
    check(`action success -> ${label}: going back to A shows the committed revision 2 with the editor closed`, stays(back, A, title) && back.page.rev === 'Revision 2' && !back.page.editorOpen, JSON.stringify(back.page));
    await b.eval('location.reload()');
    await b.wait(1500);
    const rel = await obs(`action-success-${label}-reload`, [A]);
    check(`action success -> ${label}: reloading A shows revision 2 and the saved copy`, stays(rel, A, title) && rel.page.rev === 'Revision 2' && rel.server[A].texts.at(-1) === `${title} saved copy belongs to campaign XS only.`, JSON.stringify(rel.page));
  }
  {
    // held refusal (409: someone saved A first), then the library
    const A = await mk('Act refusal', 'Act refusal original copy belongs to campaign XR only.');
    await beginSave(A, 'Act refusal MY unsaved copy belongs to campaign XR only.');
    const other = await call('POST', `/api/submissions/${A}/revisions`, { baseRevision: 1, text: 'Act refusal copy saved by someone else.', asset: {} });
    check('action refusal: the other person\'s save of A succeeded (setup)', other.status === 201, JSON.stringify(other.status));
    await armPost('/revisions');
    await b.click('Save as revision');
    await b.wait(600);
    await go('#/library');
    const before = await obs('action-refusal-before-release', [A]);
    await releasePost();
    const after = await obs('action-refusal-after-release', [A]);
    await shot('action-refusal-after-release');
    check('action refusal: the late refusal does not repaint over the library', before.held === true && libraryIntact(before) && libraryIntact(after), JSON.stringify(after.page));
    check('action refusal: the late refusal names the campaign and says the save was not made', after.page.toasts.some((t) => t.startsWith(`The save of ${A} was not made.`)), JSON.stringify(after.page.toasts));
    await go(`#/workspace/${A}`);
    const back = await obs('action-refusal-back-to-A', [A]);
    check('action refusal: going back to A keeps the person\'s draft, and the server keeps the other person\'s revision 2', back.page.editorOpen && back.page.draft === 'Act refusal MY unsaved copy belongs to campaign XR only.' && back.server[A].head === 2 && /saved by someone else/.test(back.server[A].texts.at(-1)), JSON.stringify({ editor: back.page.editorOpen, draft: back.page.draft, head: back.server[A].head }));
  }
  {
    // the follow-up request after a successful save is held, the person goes to the library meanwhile
    const A = await mk('Act follow-up', 'Act follow-up original copy belongs to campaign XF only.');
    await beginSave(A, 'Act follow-up saved copy belongs to campaign XF only.');
    await arm('/api/submissions', 0);
    await b.click('Save as revision');
    await b.wait(700);
    const mid = await obs('action-followup-held', [A]);
    check('action follow-up: the save is committed on the server and the follow-up list answer is held', mid.held === true && mid.server[A].head === 2, JSON.stringify(mid.page));
    await go('#/library');
    await release();
    const after = await obs('action-followup-after-release', [A]);
    await shot('action-followup-after-release');
    check('action follow-up: the late follow-up does not repaint over the library', libraryIntact(after), JSON.stringify(after.page));
    await go(`#/workspace/${A}`);
    const back = await obs('action-followup-back-to-A', [A]);
    check('action follow-up: going back to A shows the committed revision 2, editor closed', stays(back, A, 'Act follow-up') && back.page.rev === 'Revision 2' && !back.page.editorOpen, JSON.stringify(back.page));
  }
  {
    // a draft of another campaign must survive: A's save held, the person opens B and starts a draft, A's answer arrives
    const A = await mk('Act draft A', 'Act draft A original copy belongs to campaign XA2 only.');
    const B = await mk('Act draft B', 'Act draft B original copy belongs to campaign XB2 only.');
    await beginSave(A, 'Act draft A saved copy belongs to campaign XA2 only.');
    await armPost('/revisions');
    await b.click('Save as revision');
    await b.wait(600);
    await go(`#/workspace/${B}`);
    await b.click('Edit as new revision');
    await typeDraft('Act draft B unsaved words that must survive.');
    await b.wait(300);
    await releasePost();
    const after = await obs('action-B-draft-after-release', [A, B]);
    await shot('action-B-draft-after-release');
    check('action B draft: B\'s page and its unsaved draft survive A\'s late save', stays(after, B, 'Act draft B') && after.page.editorOpen && after.page.draft === 'Act draft B unsaved words that must survive.' && after.server[A].head === 2 && after.server[B].head === 1, JSON.stringify(after.page));
    check('action B draft: A\'s late save is announced by name', after.page.toasts.some((t) => t === `Saved revision 2 of ${A}.`), JSON.stringify(after.page.toasts));
  }

  // ---- normal navigation still works: back, reload ----
  {
    const A = await mk('Nav A', 'Nav A copy belongs to campaign NA only.');
    const B = await mk('Nav B', 'Nav B copy belongs to campaign NB only.');
    await go(`#/workspace/${A}`);
    await go(`#/workspace/${B}`);
    await b.eval('history.back()');
    await b.wait(900);
    const back = await page();
    check('back: the browser Back button returns to A', stays({ page: back }, A, 'Nav A'), JSON.stringify(back));
    await b.eval('location.reload()');
    await b.wait(1500);
    const reloaded = await page();
    check('reload: reloading shows the same campaign', stays({ page: reloaded }, A, 'Nav A'), JSON.stringify(reloaded));
    await go(`#/workspace/${B}`);
    await b.select('select[aria-label="Choose submission"]', A);
    const pick = await page();
    check('picker: choosing a campaign in the picker shows it', stays({ page: pick }, A, 'Nav A'), JSON.stringify(pick));
  }

  check('no console exceptions', b.consoleMsgs.filter((m) => /EXCEPTION/.test(m)).length === 0, b.consoleMsgs.filter((m) => /EXCEPTION/.test(m)).slice(0, 2).join(' | '));
} finally {
  await b?.close();
  await app.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed. Screenshots: ${shots} (${TAG}-*.png)`);
process.exit(passed === results.length ? 0 : 1);
