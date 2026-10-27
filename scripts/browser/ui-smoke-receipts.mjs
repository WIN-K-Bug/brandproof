// Browser walkthrough of decision-time review receipts (m27) in the AUTHENTICATED workspace, using ONLY synthetic accounts, a FICTIONAL fact sheet and generated
// data, in a throwaway directory. Never touches data/, never prints passwords.
//
//   npm run ui-smoke-receipts
//
// Approve with hostile-looking text -> History tab: the receipt opens with the KEYBOARD alone and shows "then" beside "now" -> the source changes ("no longer
// applies" and why) -> repair and a second approval (two different receipts) -> the dossier shows both -> an older workspace whose decision has no receipt says
// "not recorded" -> 390 px phone layout with the receipt open. Screenshots: docs/evidence/receipts-*.png.
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { cleanContent } from '../../tests/helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-receipts-ui-'));
await mkdir(path.join(tmp, 'auth'));
const files = { dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json') };
const open = () => createApp({ ...files, mode: 'authenticated', semantic: null, authOptions: { cost: { N: 1024, r: 8, p: 1 } } });
let app = await open();
let base = await app.listen(0);
const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), manager: secret(), reviewer: secret() };
for (const name of ['creator', 'manager', 'reviewer']) await app.auth.createUser({ username: `syn-${name}`, displayName: `Synthetic ${name[0].toUpperCase()}${name.slice(1)}`, role: name, password: pw[name] });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const ENV = 'Indoor use only; not waterproof or water resistant.';
const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional)', '', `Environment. ${ENV}`, '', `Battery. ${battery}`].join('\n');
const V1 = sheet(BAT12);
const V2 = sheet(BAT8);
const spanOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const EVIL = '<img src=x onerror=alert(1)> A full charge lasts up to 12 hours. <script>alert(2)</script>';
const EVIL_NOTE = '<svg onload=alert(3)> reviewed against the sheet';

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

let b;
try {
  const [creator, manager, reviewer] = [await client('creator'), await client('manager'), await client('reviewer')];
  const must = (r, code = 201) => {
    if (r.status !== code) throw new Error(`setup step failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const src = must(await creator.call('POST', '/api/sources', { title: 'Fernlight Aurora Lamp fact sheet (fictional)', text: V1, origin: 'paste' })).source;
  must(await manager.call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: sha(V1), note: 'checked' }));
  const relink = async (version, text, battery, note) => {
    const g = must(await manager.call('GET', '/api/guidelines'), 200);
    const edited = structuredClone(g.guidelines);
    for (const [id, needle] of [['FCT-001', battery], ['FCT-002', ENV]]) {
      const f = edited.facts.find((x) => x.id === id);
      f.source = { sourceId: src.id, version, ...spanOf(text, needle) };
      if (id === 'FCT-001') {
        f.statement = battery;
        f.value = battery === BAT8 ? 8 : 12;
      }
    }
    must(await manager.call('PUT', '/api/guidelines', { baseVersion: g.version, note, guidelines: edited }));
  };
  await relink(1, V1, BAT12, 'link two facts');

  const asset = cleanContent().asset;
  const made = must(await creator.call('POST', '/api/submissions', { title: 'Battery claim', text: EVIL, asset }));
  const A = made.id;
  must(await creator.call('POST', `/api/submissions/${A}/request-review`, { revision: 1, expected: made.workflow.binding }));
  const seen = must(await reviewer.call('GET', `/api/submissions/${A}`), 200);
  must(await reviewer.call('POST', `/api/submissions/${A}/approve`, { revision: 1, expected: seen.workflow.binding, note: EVIL_NOTE, acknowledgeWarnings: true }));

  b = await launch(`${base}/#/workspace`, { port: 9391 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const shot = (name) => b.shot(path.join(shots, `receipts-${name}.png`));
  const login = async (who) => {
    if (!(await b.eval(`!!document.getElementById('si-user')`))) {
      await b.click('Sign out');
      await b.wait(500);
    }
    await b.type('#si-user', `syn-${who}`);
    await b.type('#si-pass', pw[who]);
    await b.click('form.signin button[type=submit]');
    await b.wait(900);
  };
  const go = async (hash) => {
    await b.eval(`location.hash = ${JSON.stringify(hash)}`);
    await b.wait(1100);
  };
  const isReceiptSummary = `(e) => Boolean(e) && e.tagName === 'SUMMARY' && Boolean(e.closest('details.receipt'))`;
  const overflow = () => b.eval(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
  const openHistory = async (id) => {
    await go('#/queue');
    await go(`#/workspace/${id}`);
    await b.click('History');
    await b.wait(600);
  };

  await login('reviewer');
  await openHistory(A);

  // 1. the History tab: a closed disclosure reachable with the keyboard, opened with Enter
  check('the approval in History has a receipt disclosure, closed until asked for', (await b.eval(`document.querySelectorAll('details.receipt').length`)) === 1 && (await b.eval(`document.querySelector('details.receipt').open`)) === false);
  const presses = await b.tabTo(isReceiptSummary, { max: 120 });
  check('the receipt disclosure is reachable with the Tab key', presses >= 0, `presses=${presses}`);
  await b.key('Enter');
  check('Enter opens it (a native disclosure: no script needed to operate it)', (await b.eval(`document.querySelector('details.receipt').open`)) === true);
  const r1 = await text('details.receipt');
  check('it shows what was recorded then (counts, rules revision, the rule, the quote) and what today says', /Then/.test(r1) && /Recorded/.test(r1) && /Rules rules-[0-9.]+-[a-z-]+/.test(r1) && /FCT-001/.test(r1) && /Today/.test(r1) && /Recomputed now/.test(r1) && /Still applies/.test(r1));
  check('hostile copy and a hostile note are text only: no element was created from them', (await b.eval(`document.querySelectorAll('details.receipt img, details.receipt script, details.receipt svg, main img[src="x"]').length`)) === 0 && (await b.eval('document.querySelector("main").innerText')).includes('<svg onload=alert(3)>'));
  check('the receipt states what it is not', /not a compliance certificate/.test(r1));
  check('focus is still on the summary after opening (keyboard users do not lose their place)', (await b.eval(`(${isReceiptSummary})(document.activeElement)`)) === true);
  await b.key('Enter');
  check('Enter closes it again', (await b.eval(`document.querySelector('details.receipt').open`)) === false);
  await b.key('Enter');
  await shot('1-history-open');

  // 2. the source moves to 8 hours: the old approval no longer applies, and the receipt says why beside what it recorded
  must(await creator.call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: V2, origin: 'paste' }));
  must(await manager.call('POST', `/api/sources/${src.id}/versions/2/approve`, { expectedSha256: sha(V2), note: 'battery now 8 hours' }));
  await openHistory(A);
  const sum2 = await text('details.receipt > summary');
  check('the disclosure\'s own label says the approval no longer applies', /no longer applies/.test(sum2), sum2);
  await b.tabTo(isReceiptSummary, { max: 120 });
  await b.key(' ');
  const r2 = await text('details.receipt');
  check('it says why (evidence changed) and shows the evidence then and now; the recorded side still says it was supported', /No longer applies: evidence changed/.test(r2) && /evidence: then SRC-[0-9]+ v1 In force/.test(r2) && /supported/.test(r2));
  await shot('2-source-changed');

  // 3. repair, then a second approval: two different receipts
  await relink(2, V2, BAT8, 'relink to version 2; battery is 8 hours');
  const d1 = must(await creator.call('GET', `/api/submissions/${A}`), 200);
  must(await creator.call('POST', `/api/submissions/${A}/revisions`, { baseRevision: d1.headRevision, text: 'A full charge lasts up to 8 hours.', asset: d1.revisions.at(-1).asset }));
  const d2 = must(await creator.call('GET', `/api/submissions/${A}`), 200);
  must(await creator.call('POST', `/api/submissions/${A}/request-review`, { revision: d2.headRevision, expected: d2.workflow.binding }));
  const d3 = must(await reviewer.call('GET', `/api/submissions/${A}`), 200);
  must(await reviewer.call('POST', `/api/submissions/${A}/approve`, { revision: d3.headRevision, expected: d3.workflow.binding, note: 'Approved against version 2.' }));
  await openHistory(A);
  check('History now holds two receipts, one per approval', (await b.eval(`document.querySelectorAll('details.receipt').length`)) === 2);
  await b.eval(`document.querySelectorAll('details.receipt').forEach((x) => (x.open = true))`);
  const both = await b.eval(`[...document.querySelectorAll('details.receipt')].map((x) => x.innerText)`);
  check('the first says it no longer applies and the second says it still does, and their recorded sources differ (v1 then, v2 now)', /no longer|No longer|latest/.test(both.join('|')) && /Still applies/.test(both.join('|')) && /SRC-[0-9]+ v1/.test(both[0]) && /SRC-[0-9]+ v2/.test(both[1]));
  await shot('3-two-receipts');

  // 4. the dossier carries the same, inside "Recorded decisions"
  await go('#/queue');
  await go(`#/dossier/${A}`);
  const dz = await b.eval('document.querySelector("main").innerText');
  const outline = await b.eval(`[...document.querySelectorAll('main h1, main h2')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim().replace(/[0-9]+/g, 'N'))`);
  check('the dossier\'s section outline is unchanged: the receipts live inside "Recorded decisions" (no extra dashboard)', !outline.some((x) => /receipt/i.test(x)) && outline.includes('Recorded decisions'), outline.join('|'));
  check('the dossier shows both receipts with their then-and-now, and the section says what they are', (await b.eval(`document.querySelectorAll('.receipt-item').length`)) === 2 && /Decision receipts: recorded then, recomputed now/.test(dz) && /2 recorded, 0 not recorded/.test(dz) && /Still applies/.test(dz));
  const eventCount = must(await reviewer.call('GET', `/api/submissions/${A}/dossier`), 200).recordedEvents.events.length;
  check('and the recorded-decisions table still has exactly one row per event', (await b.eval(`document.querySelectorAll('section[aria-labelledby="dz-events"] tbody tr').length`)) === eventCount && eventCount === 4, String(eventCount));
  await b.eval(`document.getElementById('dz-receipts').scrollIntoView()`);
  await b.wait(300);
  await shot('4-dossier');

  // 5. an older workspace: the same decision with no receipt says so, and nothing is invented
  await b.close();
  b = null;
  await app.close();
  const data = JSON.parse(await readFile(files.dataFile, 'utf8'));
  for (const s of data.submissions) for (const e of s.events) delete e.receipt;
  await writeFile(files.dataFile, JSON.stringify(data, null, 2));
  app = await open();
  base = await app.listen(0);
  b = await launch(`${base}/#/workspace`, { port: 9392 });
  await login('reviewer');
  await openHistory(A);
  const hist = await b.eval('document.querySelector("main").innerText');
  check('an older decision without a receipt says "Not recorded" and why, and offers no disclosure to open', /Not recorded/.test(hist) && /before decision-time receipts existed/.test(hist) && (await b.eval(`document.querySelectorAll('details.receipt').length`)) === 0);
  await go('#/queue');
  await go(`#/dossier/${A}`);
  const dz2 = await b.eval('document.querySelector("main").innerText');
  check('the dossier says 0 recorded and 2 not recorded, and still states the findings are not reconstructed', /0 recorded, 2 not recorded/.test(dz2) && /NOT stored and are not reconstructed/.test(dz2));

  // 6. a phone: 390 px, receipt open, no sideways scrolling, a tap target of at least 44 px
  await b.close();
  b = null;
  await app.close();
  app = await open();
  base = await app.listen(0);
  const c2 = await client('creator');
  const r2c = await client('reviewer');
  const m2 = must(await c2.call('POST', '/api/submissions', { title: 'Phone check', text: EVIL.replace('12 hours', '8 hours'), asset }));
  must(await c2.call('POST', `/api/submissions/${m2.id}/request-review`, { revision: 1, expected: m2.workflow.binding }));
  const s2 = must(await r2c.call('GET', `/api/submissions/${m2.id}`), 200);
  must(await r2c.call('POST', `/api/submissions/${m2.id}/approve`, { revision: 1, expected: s2.workflow.binding, note: EVIL_NOTE, acknowledgeWarnings: true }));
  b = await launch(`${base}/#/workspace`, { port: 9393, width: 390, height: 820 });
  await b.viewport(390, 820, true);
  await login('reviewer');
  await openHistory(m2.id);
  await b.tabTo(isReceiptSummary, { max: 160 });
  await b.key('Enter');
  const tap = await b.eval(`document.querySelector('details.receipt > summary').getBoundingClientRect().height`);
  check('at 390 px the receipt is open, nothing scrolls sideways, and its summary is a tap target of at least 44 px', (await b.eval(`document.querySelector('details.receipt').open`)) && (await overflow()) && tap >= 44, `height=${Math.round(tap)}`);
  await shot('5-phone-history');
  await go('#/queue');
  await go(`#/dossier/${m2.id}`);
  check('at 390 px the dossier with its receipts does not scroll sideways', await overflow());
  await b.eval(`document.getElementById('dz-receipts').scrollIntoView()`);
  await b.wait(300);
  await shot('6-phone-dossier');
  check('browser console is clean', b.consoleMsgs.filter((m) => !/40[149]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (receipts-*.png)`);
process.exit(failed ? 1 : 0);
