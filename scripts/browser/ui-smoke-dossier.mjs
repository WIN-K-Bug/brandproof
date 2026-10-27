// Browser walkthrough of the review dossier in the AUTHENTICATED workspace, using ONLY synthetic accounts, a FICTIONAL fact
// sheet and generated PNGs, in a throwaway directory. Never touches data/, never prints passwords.
//
//   npm run ui-smoke-dossier
//
// An approved campaign (retained image, registered evidence, hostile-looking text) -> the readable report -> a real
// browser download whose contents are compared with what the page shows -> the source changes (stale approval) -> the
// stored image is damaged (not ready today) -> print and 420 px layouts. Screenshots: docs/evidence/dossier-*.png.
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { canonical, sha256 } from '../../src/util.js';
import { launch } from './cdp.mjs';
import { cleanContent } from '../../tests/helpers.js';
import { makeStripedPng } from '../../tests/png-helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-dossier-ui-'));
const dl = path.join(tmp, 'downloads');
await mkdir(path.join(tmp, 'auth'));
await mkdir(dl);

const app = await createApp({ dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json'), mode: 'authenticated', semantic: null, authOptions: { cost: { N: 1024, r: 8, p: 1 } } });
const base = await app.listen(0);
const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), manager: secret(), reviewer: secret() };
for (const [name, role] of [['creator', 'creator'], ['manager', 'manager'], ['reviewer', 'reviewer']]) await app.auth.createUser({ username: `syn-${name}`, displayName: `Synthetic ${name[0].toUpperCase()}${name.slice(1)}`, role, password: pw[name] });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const ENV = 'Indoor use only; not waterproof or water resistant.';
const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
const BAT8 = 'A full charge lasts up to 8 hours at medium brightness.';
const sheet = (battery) => ['Fernlight Aurora Lamp: Product Facts (fictional)', '', `Environment. ${ENV}`, '', `Battery. ${battery}`, '', 'Private note. This sentence is in the source but is never cited.'].join('\n');
const V1 = sheet(BAT12);
const V2 = sheet(BAT8);
const spanOf = (text, needle) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length });
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const EVIL_TITLE = 'Aurora <i>launch</i> & "friends" <img src=x onerror=alert(1)>';

async function client(name) {
  const c = {};
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: `syn-${name}`, password: pw[name] }) });
  c.cookie = r.headers.getSetCookie()[0].split(';')[0];
  c.csrf = (await r.json()).csrf;
  c.call = async (method, p, body, raw) => {
    const res = await fetch(base + p, { method, headers: { origin: base, cookie: c.cookie, 'x-csrf-token': c.csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
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
  const g = must(await manager.call('GET', '/api/guidelines'), 200);
  const edited = structuredClone(g.guidelines);
  for (const [id, needle] of [['FCT-001', BAT12], ['FCT-002', ENV]]) edited.facts.find((f) => f.id === id).source = { sourceId: src.id, version: 1, ...spanOf(V1, needle) };
  must(await manager.call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'link two facts', guidelines: edited }));

  const png = makeStripedPng();
  const up = must(await creator.call('POST', '/api/assets', null, png), 201).asset;
  const asset = { ...cleanContent().asset, name: 'campaign.png', retainedSha256: up.sha256 };
  const approve = async (title, text, theAsset) => {
    const made = must(await creator.call('POST', '/api/submissions', { title, text, asset: theAsset }));
    must(await creator.call('POST', `/api/submissions/${made.id}/request-review`, { revision: 1, expected: made.workflow.binding }));
    const seen = must(await reviewer.call('GET', `/api/submissions/${made.id}`), 200);
    must(await reviewer.call('POST', `/api/submissions/${made.id}/approve`, { revision: 1, expected: seen.workflow.binding }));
    return made.id;
  };
  const A = await approve(EVIL_TITLE, 'A full charge lasts up to 12 hours. Indoor use only. <script>alert(2)</script>', asset);
  must(await creator.call('POST', `/api/submissions/${A}/comments`, { revision: 1, text: 'PRIVATE-COMMENT-BODY' }));

  b = await launch(`${base}/#/workspace`, { port: 9371 });
  await b.downloads(dl);
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const sect = (id) => `section[aria-labelledby="${id}"]`;
  const shot = (name) => b.shot(path.join(shots, `dossier-${name}.png`));
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

  // 0. signed out: no data, just the sign-in form
  await go(`#/dossier/${A}`);
  check('signed out, the dossier address shows only the sign-in form', (await b.eval(`!!document.getElementById('si-user')`)) && !/Aurora/.test(await b.eval('document.body.innerText')));

  // 1. a reviewer opens the dossier from the campaign
  await login('reviewer');
  await go(`#/workspace/${A}`);
  await b.click('Review dossier');
  await b.wait(1200);
  const page = () => b.eval('document.querySelector("main").innerText');
  const body1 = await page();
  check('the report has a title, a prominent snapshot warning and the "not a certificate" statement', /Review dossier: Aurora/.test(body1) && /Snapshot taken/.test(body1) && /out of date as soon as anything changes/.test(body1) && /not a compliance certificate, a signature, a tamper-proof ledger or permission to publish/.test(body1));
  const outline = await b.eval(`[...document.querySelectorAll('main h1, main h2')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim().replace(/[0-9]+/g, 'N'))`);
  check('headings give a usable outline (one h1, then the sections in reading order)', outline[0].startsWith('Review dossier: Aurora') && outline.slice(1).filter((x) => !['Recorded', 'Recomputed'].includes(x)).join('|') === ['Status today', 'Copy as saved', 'Image', 'Text in the image', 'Guidelines and evidence in force', 'Recorded decisions', 'Findings recomputed today (N)', 'Cited source passages (N)', 'What each digest is a digest of', 'Limits of this record'].join('|'), outline.join('|'));
  check('status says Approved and that the saved inputs still match the approval; image integrity verified', /Approved/.test(await text(sect('dz-status'))) && /still match the binding recorded with that approval/.test(body1) && /Integrity verified now/.test(body1));
  check('hostile-looking title and copy are shown as text, never as markup', body1.includes('<i>launch</i>') && body1.includes('<script>alert(2)</script>') && (await b.eval(`document.querySelectorAll('.dossier img, .dossier script, .dossier i, main script').length`)) === 0);
  check('the exact cited passage and its local-link warning are shown; source text that was never cited is not', body1.includes(BAT12) && /not public or shareable/.test(body1) && !body1.includes('Private note. This sentence'));
  check('comment bodies are not shown', !body1.includes('PRIVATE-COMMENT-BODY') && /1 comment \(bodies not included\)/.test(body1));
  check('the retained, verified image is not described as unretained; its fingerprint is said to equal the server digest', /Integrity verified now/.test(body1) && /equals the retained image digest the server computed/.test(body1) && !/image itself was not held/.test(body1));
  check('the page explains what each digest is a digest of (content digest is canonical JSON of the text, not raw bytes) and states the checker revision with its honest note', /What each digest is a digest of/.test(body1) && /NOT a hash of the raw text bytes/.test(body1) && /actual bytes of the retained PNG/.test(body1) && /Checker revision rules-[0-9.]+-[a-z-]+/.test(body1) && /not a build identity or signature/.test(body1));
  check('recorded decisions are labelled Recorded and findings Recomputed, with the "not what a reviewer saw" statement', /Recorded/.test(await text(sect('dz-events'))) && /Recomputed/.test(body1) && /not what any reviewer saw/.test(body1));
  await shot('1-report-top');
  await b.eval(`document.getElementById('dz-events').scrollIntoView()`);
  await b.wait(300);
  await shot('2-decisions-and-findings');

  // 2. a real download, compared with the page
  const resourcesBefore = await b.eval(`performance.getEntriesByType('resource').length`);
  const filesBefore = (await readdir(dl)).length;
  await b.click('#dossier-download');
  let file;
  for (let i = 0; i < 30; i++) {
    const names = (await readdir(dl)).filter((n) => !n.endsWith('.crdownload'));
    if (names.length > filesBefore) {
      file = names.find((n) => n.endsWith('.json'));
      break;
    }
    await b.wait(200);
  }
  check('the explicit button saved a file with the fixed safe name', file === `brandproof-dossier-${A}-rev1.json`, String(file));
  const raw = file ? await readFile(path.join(dl, file), 'utf8') : '{}';
  const json = JSON.parse(raw);
  const { checksum, ...rest } = json;
  check('the download is valid JSON whose checksum matches its content, and it states format and snapshot time', json.format === 'brandproof-review-dossier' && json.formatVersion === 3 && checksum?.value === sha256(canonical(rest)) && Boolean(json.snapshot?.generatedAt));
  check('nothing was uploaded or fetched by the download (no new network resource)', (await b.eval(`performance.getEntriesByType('resource').length`)) === resourcesBefore);
  const shown = await page();
  const findings = json.recomputedFindings.findings;
  check('the visible report and the file agree: title, copy, digests, checksum', shown.includes(json.campaign.title) && shown.includes(json.currentRevision.text) && shown.includes(json.currentRevision.contentSha256) && shown.includes(json.guidelines.hash) && shown.includes(json.evidence.hash) && shown.includes(json.checksum.value) && shown.includes(json.image.sha256));
  check('the visible report and the file agree: every finding, its quote and rule id; the finding count', (await b.eval(`document.querySelectorAll('.dossier-finding').length`)) === findings.length && findings.every((f) => shown.includes(f.ruleId) && (!f.quote || shown.includes(f.quote))));
  check('the visible report and the file agree: every recorded event and every cited passage', (await b.eval(`document.querySelectorAll('section[aria-labelledby="dz-events"] tbody tr').length`)) === json.recordedEvents.events.length && json.sourceExcerpts.every((x) => shown.includes(x.excerpt)));
  const flat = JSON.stringify(json);
  check('the file contains no filesystem path, credentials, session or CSRF data, usernames, source full text or image bytes', !flat.includes(tmp) && !flat.includes(tmp.replaceAll('\\', '\\\\')) && !/syn-(creator|manager|reviewer)/.test(flat) && !flat.includes(pw.creator) && !flat.includes(pw.reviewer) && !flat.includes(creator.csrf) && !flat.includes('Private note') && !flat.includes(png.toString('base64').slice(0, 40)) && !flat.includes('PRIVATE-COMMENT-BODY'));

  // 3. the source changes: the recorded approval stays, the current state says Re-review required
  const v2 = must(await creator.call('POST', `/api/sources/${src.id}/versions`, { baseVersion: 1, text: V2, origin: 'paste' }));
  must(await manager.call('POST', `/api/sources/${src.id}/versions/2/approve`, { expectedSha256: sha(V2), note: 'battery now 8 hours' }));
  await go('#/queue');
  await go(`#/dossier/${A}`);
  const body2 = await page();
  check('after the source changed: Re-review required, the old approval is shown as no longer applying, and why', /Re-review required/.test(await text(sect('dz-status'))) && /no longer applies: Re-review required/.test(body2) && /evidence changed/.test(body2) && /no longer in force/.test(body2));
  check('the recorded approval row says it differs from the saved inputs now; the cited passage belongs to a replaced version', /Differs: evidence changed/.test(body2) && /replaced/i.test(await text(sect('dz-excerpts'))));
  await shot('3-stale-approval');

  // 4. damaged image: honest, and not "ready today"
  const imgFile = path.join(`${path.join(tmp, 'workspace.json')}.assets`, `${up.sha256}.png`);
  const bytes = await readFile(imgFile);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await writeFile(imgFile, bytes);
  await go('#/queue');
  await go(`#/dossier/${A}`);
  const body3 = await page();
  check('with a damaged stored image the report says so and that it is not ready today', /Integrity: corrupt/.test(body3) && /retained image is corrupt/.test(body3) && /It is not ready today/.test(body3) && !/Integrity verified now/.test(body3));
  await b.eval(`document.getElementById('dz-image').scrollIntoView()`);
  await b.wait(300);
  await shot('4-image-corrupt');
  await writeFile(imgFile, Buffer.from(bytes.map((x, i) => (i === Math.floor(bytes.length / 2) ? x ^ 1 : x))));

  // 5. keyboard, print and narrow layouts
  check('the download button is reachable with the keyboard', (await b.tabTo(`(e) => e && e.id === 'dossier-download'`, { max: 40 })) >= 0);
  await b.media('print');
  const printState = await b.eval(`(() => { const vis = (sel) => { const e = document.querySelector(sel); return e ? e.getClientRects().length > 0 : false; }; return { sidebar: vis('.sidebar'), buttons: vis('#dossier-download'), banner: vis('.dossier-banner'), report: vis('.dossier'), width: document.documentElement.scrollWidth <= window.innerWidth + 1 }; })()`);
  check('print layout hides navigation and buttons, keeps the report and the snapshot warning', !printState.sidebar && !printState.buttons && printState.banner && printState.report && printState.width);
  await shot('5-print');
  await b.media('screen');
  await b.viewport(420, 820, true);
  await go('#/queue');
  await go(`#/dossier/${A}`);
  check('at 420 px nothing scrolls horizontally', await b.eval(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await shot('6-narrow');
  await b.viewport(1280, 800, false);

  // 6. other roles may read it; unknown campaigns say so
  await go('#/queue');
  await go('#/dossier/SUB-999');
  check('an unknown campaign gives a clear error, not a blank page', /No submission SUB-999/.test(await page()));
  check('browser console is clean', b.consoleMsgs.filter((m) => !/40[149]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (dossier-*.png)`);
process.exit(failed ? 1 : 0);
