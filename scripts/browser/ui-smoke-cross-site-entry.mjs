// m31: arriving at the judge demo from ANOTHER SITE (a link in a chat, mail, document or dashboard) must not lose or replace the visitor's session.
// Real HTTPS (the real server.js behind a local TLS proxy, Secure __Host- SameSite=Strict cookie), a real browser, synthetic data in throwaway folders.
//
//   npm run ui-smoke-cross-site-entry
//   M31_PROFILE=brave-private npm run ui-smoke-cross-site-entry     (edge-regular by default; edge-private, brave-regular, brave-private)
//   M31_TAG=name   keep the proxy log as handoffs/evidence/<name>-proxy.jsonl and put screenshots at docs/evidence/<name>-*.png
//
// The browser withholds a SameSite=Strict cookie on a navigation that starts on another site, and on every reload of that page. Before m31 the server
// then started a NEW session at that moment (the earlier one became unreachable and a saved revision seemed to vanish). Scenarios:
//   typed          the address typed in (no other site involved): the control; a save survives a reload
//   external       first visit by clicking a link on another site, with the deep link /#/workspace/SUB-3 (not the default campaign): one session, the deep link kept, no marker left
//                  in the address, and a save then a reload keep the same session and the revision
//   again          the same browser arrives from another site a second time: the SAME session is resumed (not replaced)
//   other visitor  a second browser (another cookie jar) arriving the same way gets its own session and cannot see or change the first one's
//   hostile write  a page on another site posting to the API: nothing is changed
//   no script      the same arrival with scripts switched off: still lands on a working page with one session
//   restart        the server loses its sessions (a free-tier sleep): the open page says so, and an arrival from another site starts one new session and says the earlier one ended
// Screenshots are never overwritten: a file that exists is kept and the new one is skipped.
import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';
import { COOKIE, browserOptions, sleep, startTlsDemo, tag, until } from './tls-harness.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
mkdirSync(shots, { recursive: true });
const PROFILE = process.env.M31_PROFILE || 'edge-regular';
const TAG = process.env.M31_TAG || `crosssite-${Date.now()}`;
const logFile = process.env.M31_TAG ? path.join(root, 'handoffs', 'evidence', `${TAG}-proxy.jsonl`) : null;
if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const rig = await startTlsDemo({ logFile });
const base = rig.base;
console.log(`profile ${PROFILE}; ${base}`);

// a plain page on another site (another origin: http on 127.0.0.1) with the links a person would click
const other = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end(`<!doctype html><title>another site</title><a id="deep" href="${base}/#/workspace/SUB-3" style="display:block;padding:40px">open the app (deep link to the third campaign)</a><a id="plain" href="${base}/" style="display:block;padding:40px">open the app</a>`);
});
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const otherUrl = `http://127.0.0.1:${other.address().port}/`;

const STATE = `(() => { const m = document.getElementById('main'); const text = (m?.innerText || '').replace(/\\s+/g, ' '); return { hash: location.hash, search: location.search, pathname: location.pathname, banner: (document.getElementById('banner')?.innerText || '').replace(/\\s+/g, ' '), ended: /demo session has ended/i.test(text), heading: document.querySelector('main h1')?.textContent || '', body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) }; })()`;
const HEAD = `fetch('/api/submissions/SUB-1', { headers: { 'x-demo-role': 'creator' } }).then(async (r) => { const j = await r.json().catch(() => null); return { status: r.status, head: j?.headRevision ?? null, text: j?.revisions?.at(-1)?.text ?? null }; })`;

let port = Number(process.env.M31_PORT || 9520);
const browsers = [];
const open = async (startUrl) => {
  const b = await launch(startUrl, browserOptions(PROFILE, rig.spki, port++));
  await b.send('Network.enable');
  browsers.push(b);
  return b;
};
const cookieTag = async (b) => {
  const c = (await b.send('Network.getCookies', { urls: [base] })).result?.cookies?.find((x) => x.name === COOKIE);
  return c ? tag(c.value) : null;
};
const state = (b) => until(() => b.eval(STATE), 5000);
const head = (b) => b.eval(HEAD).catch((e) => ({ error: e.message }));
const settled = async (b, ms = 9000) => {
  await until(() => b.eval(`document.readyState === 'complete' && ((document.getElementById('banner')?.innerText || '').length > 0 || /demo session has ended/i.test(document.getElementById('main')?.innerText || ''))`), ms);
  await sleep(500);
};
const shot = async (b, name) => {
  const file = path.join(shots, `${TAG}-${name}.png`);
  if (!existsSync(file)) await b.shot(file);
};
const mark = () => rig.log.length;
const since = (i) => rig.log.slice(i);
const rootGets = (w) => w.filter((e) => e.path === '/' && e.method === 'GET');
/** Sessions STARTED since log position i: cookies the server set that no earlier request or response carried (renewing a known session's cookie does not count). */
const startedSessions = (i) => {
  const known = new Set(rig.log.slice(0, i).flatMap((e) => [...e.cookieTags, ...(e.setCookie || []).map((s) => s.tag)]));
  return [...new Set(rig.log.slice(i).flatMap((e) => (e.setCookie || []).map((s) => s.tag)))].filter((x) => !known.has(x));
};
/** A real mouse click on a link of the other site's page: a genuine top-level navigation that starts on another site. */
const clickFrom = async (b, id) => {
  await b.send('Page.navigate', { url: otherUrl });
  await sleep(900);
  const pos = await b.eval(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x + 12, y: r.y + 12 }; })()`);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await sleep(1500);
};
let edits = 0;
/** Open SUB-1, put a marker in its copy and save; resolves with whether the page said it was saved. */
const editAndSave = async (b, marker) => {
  await b.eval(`location.hash = '#/workspace/SUB-1'`);
  await sleep(1000);
  await b.click('Edit as new revision');
  const cur = await b.eval(`document.getElementById('draft-text').value`);
  edits++;
  await b.type('#draft-text', cur.replace(/\s*\(m31 [^)]*\)$/, '') + ` (m31 ${marker} ${edits})`);
  await b.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
  await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Save as revision'))?.click()`);
  return Boolean(await until(() => b.eval(`[...document.querySelectorAll('.toast')].some((x) => /Saved revision/.test(x.textContent))`), 8000));
};
const reload = async (b) => {
  await b.send('Page.reload', {});
  await settled(b);
};

let A, B;
let typedTag = null;
try {
  // ---------------------------------------------------------------- typed (the control)
  {
    A = await open(`${base}/`);
    await settled(A);
    const i = mark();
    const first = await cookieTag(A);
    const saved = await editAndSave(A, 'typed');
    check('typed: a typed address starts a session and a save works', Boolean(first) && saved, `cookie ${first}`);
    await reload(A);
    const s = await state(A);
    const h = await head(A);
    check('typed: a reload keeps the same session and the saved revision', (await cookieTag(A)) === first && h.head === 2 && !s.ended, `head ${h.head}`);
    check('typed: nothing was bounced (no landing page was fetched)', since(i).every((e) => e.path !== '/enter.js'));
    await shot(A, 'typed-after-reload');
    typedTag = first;
    A = await open(otherUrl); // a NEW browser with an empty cookie jar: the first visit of someone who arrives from another site
    await sleep(500);
  }

  // ---------------------------------------------------------------- external, first visit, with a deep link
  let tagA = null;
  {
    const i = mark();
    await clickFrom(A, 'deep');
    await settled(A);
    const s = await state(A);
    const w = since(i).filter((e) => e.t >= 0);
    tagA = await cookieTag(A);
    const roots = rootGets(w).filter((e) => e.fetchSite === 'cross-site' || e.query === 'entry=1');
    check('external: the page opens (no ended screen) on the deep link, a campaign that is not the default one', !s.ended && s.hash === '#/workspace/SUB-3' && /social post/.test(s.heading), `hash ${s.hash} heading "${s.heading}"`);
    check('external: the address is clean (no marker left, root path)', s.pathname === '/' && s.search === '', `${s.pathname}${s.search}`);
    check('external: exactly one session was started for this arrival', startedSessions(i).length === 1 && tagA !== typedTag, `started ${startedSessions(i).join(',')}`);
    check('external: the first (cross-site) request started nothing; the same-origin landing did', roots.length === 2 && !(roots[0].setCookie || []).length && (roots[1].setCookie || []).length === 1, roots.map((e) => `${e.fetchSite}:${e.status}:set=${(e.setCookie || []).length}`).join(' | '));
    check('external: no more than two page requests (no loop)', rootGets(w).length <= 2, `${rootGets(w).length}`);
    await shot(A, 'external-arrival');
    const saved = await editAndSave(A, 'external');
    const afterSave = mark();
    await reload(A);
    const s2 = await state(A);
    const h = await head(A);
    check('external: save, then reload: the same session and the saved revision', saved && (await cookieTag(A)) === tagA && h.head === 2 && !s2.ended, `cookie ${await cookieTag(A)} head ${h.head}`);
    check('external: the reload started no new session', startedSessions(afterSave).length === 0 && rootGets(since(afterSave)).every((e) => e.cookieTags.includes(tagA)), `started ${startedSessions(afterSave).join(',') || 'none'}`);
    await shot(A, 'external-after-reload');
  }

  // ---------------------------------------------------------------- external again: the existing session is resumed, never replaced
  {
    const i = mark();
    const before = await head(A);
    await clickFrom(A, 'deep');
    await settled(A);
    const s = await state(A);
    const h = await head(A);
    const w = since(i);
    check('again: arriving from another site again resumes the SAME session', (await cookieTag(A)) === tagA && !s.ended && s.hash === '#/workspace/SUB-3' && /social post/.test(s.heading), `cookie ${await cookieTag(A)} hash ${s.hash}`);
    check('again: the work is still there (same revision and text)', h.head === before.head && h.text === before.text, `head ${h.head}`);
    check('again: no session was started and no cookie was replaced', startedSessions(i).length === 0, `started ${startedSessions(i).join(',') || 'none'}`);
  }

  // ---------------------------------------------------------------- another visitor stays isolated
  {
    B = await open(otherUrl);
    await sleep(500);
    await clickFrom(B, 'plain');
    await settled(B);
    const tagB = await cookieTag(B);
    const sB = await state(B);
    const hB = await head(B);
    const hA = await head(A);
    check('other visitor: arriving from another site gives a different session', Boolean(tagB) && tagB !== tagA && !sB.ended, `${tagB} vs ${tagA}`);
    check('other visitor: cannot see the first visitor\'s saved revision', hB.head === 1 && !String(hB.text).includes('(m31 external'), `head ${hB.head}`);
    await editAndSave(B, 'other');
    await reload(B);
    const hB2 = await head(B);
    const hA2 = await head(A);
    check('other visitor: their own save and reload work, and the first visitor is unchanged', (await cookieTag(B)) === tagB && hB2.head === 2 && hA2.head === hA.head && hA2.text === hA.text, `B head ${hB2.head}, A head ${hA2.head}`);
    await shot(B, 'other-visitor');
  }

  // ---------------------------------------------------------------- a hostile page on another site posting to the API
  {
    const i = mark();
    const before = await head(A);
    await A.send('Page.navigate', { url: otherUrl });
    await sleep(900);
    const r = await A.eval(`(async () => { const out = {}; try { const res = await fetch(${JSON.stringify(base + '/api/submissions/SUB-1/revisions')}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-demo-role': 'creator' }, body: JSON.stringify({ text: 'HOSTILE' }) }); out.status = res.status; } catch (e) { out.error = String(e).slice(0, 60); } try { const res = await fetch(${JSON.stringify(base + '/api/submissions/SUB-1/revisions')}, { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'text/plain' }, body: 'HOSTILE' }); out.simple = res.type; } catch (e) { out.simpleError = String(e).slice(0, 60); } return out; })()`);
    await sleep(500);
    const w = since(i).filter((e) => e.path.startsWith('/api/') && e.method === 'POST');
    await A.send('Page.navigate', { url: `${base}/` });
    await settled(A);
    const after = await head(A);
    check('hostile write: nothing from another site changed the campaign', after.head === before.head && after.text === before.text && w.every((e) => e.status >= 400), `${JSON.stringify(r)} posts ${w.map((e) => e.status).join(',') || 'none reached the server'}`);
  }

  // ---------------------------------------------------------------- scripts switched off
  {
    const C = await open(otherUrl);
    await sleep(500);
    const i = mark();
    await C.send('Emulation.setScriptExecutionDisabled', { value: true });
    await clickFrom(C, 'deep');
    await sleep(2500);
    const hist = (await C.send('Page.getNavigationHistory')).result;
    const url = hist.entries[hist.currentIndex].url;
    const doc = (await C.send('DOM.getDocument', { depth: -1 })).result.root;
    const html = (await C.send('DOM.getOuterHTML', { nodeId: doc.nodeId })).result?.outerHTML ?? '';
    const t = await cookieTag(C);
    check('no script: the arrival still ends on a working page with one session', Boolean(t) && startedSessions(i).length === 1 && /needs JavaScript/.test(html), `url ${url.replace(base, '')} cookie ${t}`);
    await C.send('Emulation.setScriptExecutionDisabled', { value: false });
    const j = mark();
    await reload(C);
    const s = await state(C);
    check('no script: with scripts back on, a reload keeps that session', (await cookieTag(C)) === t && !s.ended && startedSessions(j).length === 0, `cookie ${await cookieTag(C)}`);
  }

  // ---------------------------------------------------------------- the server loses its sessions (a restart on an empty folder)
  {
    await A.send('Page.navigate', { url: `${base}/` });
    await settled(A);
    await rig.restartEmpty();
    await A.eval(`location.hash = '#/workspace'`);
    await sleep(300);
    await A.eval(`location.hash = '#/workspace/SUB-1'`);
    await sleep(1500);
    const s = await state(A);
    check('restart: the open page honestly says its session ended', s.ended, `"${s.heading}"`);
    await shot(A, 'restart-ended');
    const i = mark();
    await clickFrom(A, 'deep');
    await settled(A);
    const s2 = await state(A);
    const t = await cookieTag(A);
    const h = await head(A);
    check('restart: arriving from another site starts exactly one NEW session and says the earlier one ended', Boolean(t) && t !== tagA && startedSessions(i).length === 1 && /earlier session had ended/.test(s2.banner) && !s2.ended && h.head === 1, `banner "${s2.banner.slice(0, 60)}" head ${h.head}`);
    await editAndSave(A, 'after-restart');
    await reload(A);
    const h2 = await head(A);
    check('restart: and that new session survives a save and a reload', (await cookieTag(A)) === t && h2.head === 2, `head ${h2.head}`);
  }

  const exc = browsers.flatMap((b) => b.consoleMsgs).filter((m) => /^EXCEPTION/.test(m));
  check('no console exceptions', exc.length === 0, exc.join(' | ').slice(0, 200));
} catch (e) {
  results.push(false);
  console.log('FAIL  script error: ' + (e.stack || e.message));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  other.close();
  const out = rig.serverOutput();
  console.log(`server stderr bytes: ${out.stderr.length}`);
  await rig.stop();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed. Screenshots: ${shots} (${TAG}-*.png)`);
process.exit(passed === results.length ? 0 : 1);
