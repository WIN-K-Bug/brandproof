// Browser walkthrough of the human-confirmed IMAGE TEXT review in the AUTHENTICATED workspace, with the REAL local reader,
// synthetic accounts and synthetic PNGs, in a throwaway directory. Never touches data/ or a running server, never prints passwords.
//
//   npm run ui-smoke-ocr                  the full flow, run with a network blocker in the process and its worker threads
//   npm run ui-smoke-ocr -- --unavailable the reader switched off: the manual transcription still works and says why
//
// image -> read -> compare and correct -> explicit confirm -> save -> findings on the transcription -> reviewer ->
// image replacement drops the confirmation and stales the approval. Screenshots: docs/evidence/ocr-*.png.
import { mkdtemp, rm, mkdir, readFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ocrAvailability } from '../../src/ocr.js';
import { launch } from './cdp.mjs';

const unavailableMode = process.argv.includes('--unavailable');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
const fx = (n) => path.join(root, 'tests', 'fixtures', 'ocr', `${n}.png`);
const avail = ocrAvailability();
if (!unavailableMode && !avail.ok) {
  console.log(`SKIPPED: the optional reader is not installed (${avail.reason}).`);
  process.exit(0);
}
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-ocr-ui-'));
await mkdir(path.join(tmp, 'auth'));

const app = await createApp({ dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json'), mode: 'authenticated', semantic: null, ...(unavailableMode ? { ocr: null } : {}), authOptions: { cost: { N: 1024, r: 8, p: 1 } } });
const base = await app.listen(0);
const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), manager: secret(), reviewer: secret() };
for (const who of ['creator', 'manager', 'reviewer']) await app.auth.createUser({ username: `syn-${who}`, displayName: `Synthetic ${who[0].toUpperCase()}${who.slice(1)}`, role: who, password: pw[who] });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const ENV = 'Indoor use only; not waterproof or water resistant.';
const BAT12 = 'A full charge lasts up to 12 hours at medium brightness.';
// The words each fixture PRINTS, declared before any reading (tests/fixtures/ocr/*.json). A confirmed transcription must equal them.
const PRINTED = Object.fromEntries(['fixtures-spec.json', 'fixtures-review.json'].flatMap((f) => JSON.parse(readFileSync(path.join(root, 'tests', 'fixtures', 'ocr', f), 'utf8')).fixtures).map((x) => [x.id, x.expected]));
const squash = (t) => t.replace(/\s+/g, ' ').trim();
const RULE = 'Match the words actually printed. Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.';
const SHEET = ['Fernlight Aurora Lamp: Product Facts (fictional)', '', `Environment. ${ENV}`, '', `Battery. ${BAT12}`].join('\n');
const spanOf = (needle) => ({ start: SHEET.indexOf(needle), end: SHEET.indexOf(needle) + needle.length });

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
const must = (r, code = 201) => {
  if (r.status !== code) throw new Error(`setup step failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const attemptsFile = process.env.NET_ATTEMPT_LOG;
const attempts = () => (attemptsFile && existsSync(attemptsFile) ? readFileSync(attemptsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

let b;
try {
  // The blocker (when preloaded) must be live: one deliberate request is refused and recorded.
  let controlOk = null;
  if (attemptsFile) {
    controlOk = await fetch('https://example.com/').then(() => false, (e) => e.code === 'ENETBLOCKED');
    check('the network blocker is live (a deliberate outside request was refused and recorded)', controlOk === true && attempts().length === 1);
  }

  const creatorApi = await client('creator');
  const managerApi = await client('manager');
  const src = must(await creatorApi.call('POST', '/api/sources', { title: 'Fernlight Aurora Lamp fact sheet (fictional)', text: SHEET, origin: 'paste' })).source;
  must(await managerApi.call('POST', `/api/sources/${src.id}/versions/1/approve`, { expectedSha256: sha(SHEET), note: 'checked' }));
  const g = must(await managerApi.call('GET', '/api/guidelines'), 200);
  const edited = structuredClone(g.guidelines);
  for (const [id, needle] of [['FCT-001', BAT12], ['FCT-002', ENV]]) edited.facts.find((f) => f.id === id).source = { sourceId: src.id, version: 1, ...spanOf(needle) };
  must(await managerApi.call('PUT', '/api/guidelines', { baseVersion: g.version, note: 'link two facts', guidelines: edited }));

  b = await launch(`${base}/#/workspace`, { port: 9391 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const main = () => b.eval('document.querySelector("main").innerText');
  const shot = (n) => b.shot(path.join(shots, `ocr${unavailableMode ? '-off' : ''}-${n}.png`));
  // Evidence shot with the retained image, the rule, the whole transcript and the confirmation in ONE frame (taller window, stale toasts cleared).
  const compareShot = async (n) => {
    await b.eval(`document.getElementById('toasts')?.replaceChildren()`);
    await b.viewport(1360, 1200, false);
    await b.eval(`(() => { document.getElementById('imagetext-h')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -330); })()`);
    await b.wait(300);
    await shot(n);
    await b.viewport(1360, 900, false);
  };
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
    await b.wait(1000);
  };
  const waitFor = async (fn, ms = 40000) => {
    for (let t = 0; t < ms; t += 250) {
      if (await b.eval(fn)) return true;
      await b.wait(250);
    }
    return false;
  };
  const areaValue = () => b.eval(`document.getElementById('imagetext')?.value ?? null`);
  const status = async (id) => must(await creatorApi.call('GET', `/api/submissions/${id}`), 200);

  await login('creator');

  if (unavailableMode) {
    // ===== the reader is switched off: honest, and the manual workflow works =====
    await b.click('+ New submission');
    await b.type('#nt', 'Banner (reader off)');
    await b.type('#nx', 'A reading lamp for your desk.');
    await b.click('dialog .dlg-f .btn.primary');
    await b.wait(1000);
    await b.click('Edit as new revision');
    await b.setFiles('#asset-file', [fx('clear-30-hours')]);
    await b.type('#alt', 'A banner with one short line of text on a plain background');
    check('with the reader off the button is disabled and says why, and typing is offered instead', (await b.eval(`document.getElementById('imagetext-read').disabled`)) && /not available here/.test(await b.eval(`document.getElementById('imagetext-read').title`)) && /Type the text yourself/.test(await main()));
    await b.type('#imagetext', 'The battery lasts 30 hours on a single charge.');
    await b.eval(`document.getElementById('imagetext-confirm').click()`);
    await shot('1-unavailable-typed');
    await b.click('Save as revision 2');
    await b.wait(1200);
    const detail = (await status('SUB-1')).revisions.at(-1);
    check('the typed transcription is saved as TYPED (no reading was involved), confirmed by the signed-in account', detail.imageText?.provenance.kind === 'typed' && detail.imageText.confirmedBy.role === 'creator');
    check('and it is checked like any other text: the 30-hour claim is a finding on the image text', /Contradicts approved fact: Battery life/.test(await main()) && /Text in the image/.test(await main()));
    check('browser console is clean', b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
  } else {
    // ===== 1. creator reads the text from a retained image =====
    await b.click('+ New submission');
    await b.type('#nt', 'Banner with text in the image');
    await b.type('#nx', 'A reading lamp for your desk.');
    await b.click('dialog .dlg-f .btn.primary');
    await b.wait(1000);
    await b.click('Edit as new revision');
    await b.setFiles('#asset-file', [fx('clear-30-hours')]);
    await b.type('#alt', 'A banner with two short lines of text on a plain background');
    check('before reading, the box says nothing has been transcribed and nothing is saved', /Text in the image/.test(await main()) && (await areaValue()) === '');
    await b.click('#imagetext-read');
    check('the reading finishes and fills the box with a DRAFT (not confirmed)', await waitFor(`(document.getElementById('imagetext')?.value ?? '').length > 0`));
    const draft1 = await areaValue();
    check('the draft is exactly what the reader returned for the image, numbers untouched', /The battery lasts 30 hours/.test(draft1), JSON.stringify(draft1));
    check('it is labelled a draft that may contain mistakes, with the reader confidence marked as a heuristic', /Automatic draft read from the image/.test(await main()) && /may contain mistakes, including in numbers/.test(await main()) && /not correctness/.test(await main()));
    check('next to the editor and the confirmation it says: match the words actually printed; editing the transcript does not change the image; to fix a claim replace the image', squash(await text('#imagetext-match-printed')) === RULE, await text('#imagetext-match-printed'));
    check('the draft equals the words the 30-hours image prints (declared in advance)', squash(draft1) === squash(PRINTED['clear-30-hours']), JSON.stringify(draft1));
    check('the confirmation box is unchecked and saving without it is refused', (await b.eval(`document.getElementById('imagetext-confirm').checked`)) === false);
    await b.click('Save as revision 2');
    await b.wait(700);
    check('saving without confirmation is refused with a message and nothing is saved', /Confirm the transcription/.test(await b.eval(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ')`)) && (await status('SUB-1')).headRevision === 1);
    await shot('1-draft-read');
    await b.eval(`document.getElementById('imagetext-confirm').click()`);
    check('once confirmed, the live preview already shows the finding on the TRANSCRIPTION', await waitFor(`/Text in the image/.test(document.querySelector('.findings')?.innerText ?? '') && /Contradicts approved fact/.test(document.querySelector('.findings')?.innerText ?? '')`, 8000));
    await b.click('Save as revision 2');
    await b.wait(1300);
    let body = await main();
    const rev2 = (await status('SUB-1')).revisions.at(-1);
    check('the saved revision holds the confirmed text with server-set provenance: ocr-draft, unchanged, bound to the image digest', rev2.imageText?.provenance.kind === 'ocr-draft' && rev2.imageText.provenance.edited === false && rev2.imageText.imageSha256 === rev2.asset.retainedSha256 && rev2.imageText.confirmedBy.name === 'Synthetic Creator');
    check('the page shows the transcription card: who confirmed it, that it is a person\'s record and not verification', /Confirmed by Synthetic Creator/.test(await text('#imagetext-card')) && /confirmed without changes/.test(await text('#imagetext-card')) && /not verification/.test(await text('#imagetext-card')) && /THIS image/.test(await text('#imagetext-card')));
    check('the finding is on the transcription, links to its exact source passage, and offers no automatic rewrite', /Text in the image/.test(await text('.findings')) && /Open the exact passage in the source/.test(await text('.findings')) && /inside the image/.test(await text('.findings')) && (await b.eval(`![...document.querySelectorAll('.finding')].some((e) => /Apply/.test(e.textContent))`)));
    check('the advice on that finding does not offer to fix it in the transcript: it says to replace the image, then transcribe and confirm again', /editing the transcript does not change the image/.test(await text('.findings')) && /replace the image, then transcribe and confirm again/.test(await text('.findings')), await text('.findings'));
    check('the saved card repeats the rule and states that a transcript cannot be compared with the pixels', squash(await text('#imagetext-rule')) === RULE && /cannot compare the transcript with the pixels/.test(await text('#imagetext-card')));
    check('Approve is blocked (a blocking finding), with the reason', await b.eval(`[...document.querySelectorAll('.flow button')].some((x) => x.textContent.startsWith('Approve') && x.disabled)`));
    await b.eval(`document.querySelector('.finding .link-btn')?.scrollIntoView({ block: 'center' })`);
    await b.eval(`[...document.querySelectorAll('.finding .link-btn')].find((x) => /Show in the text in the image/.test(x.textContent))?.click()`);
    await b.wait(500);
    check('"Show in the text in the image" takes you to the highlighted words', (await b.eval(`document.activeElement?.id`)) === 'imagetext-text' && (await b.eval(`!!document.querySelector('#imagetext-text mark.hl')`)));
    await shot('2-finding-on-image-text');

    // ===== 2. the claim is wrong IN THE ARTWORK, so the creator replaces the image (the transcript is never the place to fix it) =====
    // 2a. an image the reader gets partly wrong (measured in Phase A: the capital "Up"): the person corrects ONLY what the reader
    //     misread so that it matches the printed words. If the reader happens to be right, the draft is confirmed unchanged.
    await b.click('Edit as new revision');
    await b.setFiles('#asset-file', [fx('rotated-7deg')]);
    check('replacing the image removes the old transcription and says so', await waitFor(`/belonged to the previous image/.test(document.querySelector('main')?.innerText ?? '')`, 8000) && (await areaValue()) === '');
    await b.click('#imagetext-read');
    check('the rotated image is read', await waitFor(`(document.getElementById('imagetext')?.value ?? '').length > 0`));
    const draftRot = await areaValue();
    const rotMisread = squash(draftRot) !== squash(PRINTED['rotated-7deg']);
    console.log(rotMisread ? '  (the reader misread the rotated image, as measured in Phase A: ' + JSON.stringify(draftRot) + ')' : '  (the reader read the rotated image exactly this time)');
    if (rotMisread) await b.type('#imagetext', PRINTED['rotated-7deg']);
    check('the transcript the person confirms equals the words the image prints, not a different claim', squash(await areaValue()) === squash(PRINTED['rotated-7deg']), JSON.stringify(await areaValue()));
    await b.eval(`document.getElementById('imagetext-confirm').click()`);
    await compareShot('3-corrected-and-confirmed');
    await b.click('Save as revision 3');
    await b.wait(1300);
    const rev3 = (await status('SUB-1')).revisions.at(-1);
    check(rotMisread ? 'the person\'s correction of the reader\'s mistake is recorded as such: from a reading, edited, bound to the NEW image' : 'confirmed unchanged: recorded as from a reading, not edited, bound to the NEW image', rev3.imageText.provenance.kind === 'ocr-draft' && rev3.imageText.provenance.edited === rotMisread && rev3.imageText.imageSha256 === rev3.asset.retainedSha256 && rev3.imageText.imageSha256 !== rev2.asset.retainedSha256);

    // 2b. the corrected ARTWORK: a new image that really prints every approved qualifier
    await b.click('Edit as new revision');
    await b.setFiles('#asset-file', [fx('qualified-banner')]);
    check('replacing the image again removes that transcription too', await waitFor(`/belonged to the previous image/.test(document.querySelector('main')?.innerText ?? '')`, 8000) && (await areaValue()) === '');
    await b.click('#imagetext-read');
    check('the corrected artwork is read', await waitFor(`(document.getElementById('imagetext')?.value ?? '').length > 0`));
    const draft2 = await areaValue();
    check('the draft equals the words the corrected artwork prints, including "at medium brightness" (declared in advance), with no edit by the person', squash(draft2) === squash(PRINTED['qualified-banner']) && /at medium brightness/.test(draft2), JSON.stringify(draft2));
    await b.eval(`document.getElementById('imagetext-confirm').click()`);
    await compareShot('3b-corrected-artwork-confirmed');
    await b.click('Save as revision 4');
    await b.wait(1300);
    const rev4 = (await status('SUB-1')).revisions.at(-1);
    check('the confirmed transcript is the printed text of the NEW image, untouched: from a reading, not edited, bound to that image', rev4.imageText.provenance.kind === 'ocr-draft' && rev4.imageText.provenance.edited === false && squash(rev4.imageText.text) === squash(PRINTED['qualified-banner']) && rev4.imageText.imageSha256 === rev4.asset.retainedSha256 && rev4.imageText.imageSha256 !== rev3.asset.retainedSha256);
    check('the findings on the confirmed text are now consistent with the approved fact (the claim was fixed in the artwork)', /Consistent with guidelines/.test(await main()) && !/Contradicts approved fact/.test(await main()));
    await b.click('Request review');
    await b.wait(900);

    // ===== 3. a different signed-in person reviews and approves =====
    await login('reviewer');
    await go('#/workspace/SUB-1');
    body = await main();
    check('the reviewer sees the image, the transcription, who confirmed it, that it came from a reading unchanged, and the rule about printed words', /Confirmed by Synthetic Creator/.test(body) && /confirmed without changes/.test(body) && /Match the words actually printed/.test(body) && (await b.eval(`!!document.querySelector('img.retained-img')`)));
    await b.click('Approve…');
    await b.click('dialog .dlg-f .btn.primary');
    await b.wait(1000);
    check('the reviewer approves', /Approved/.test(await text('.ws-title')));
    const approvedEvent = (await status('SUB-1')).events.find((e) => e.type === 'approved');
    check('the approval is bound to the transcription and the exact image', /^[0-9a-f]{64}$/.test(approvedEvent.binding.imageTextHash) && approvedEvent.binding.assetHash.length === 64);
    await shot('4-reviewer-approved');
    await go('#/dossier/SUB-1');
    const dz = await main();
    check('the dossier states the confirmed text, provenance and that confirmation is not verification', /Text in the image/.test(dz) && /Confirmed by a person/.test(dz) && /confidence/.test(dz) && /confirmed without changes/.test(dz) && /not verification/.test(dz));
    check('the dossier states the printed-words rule and the limit that the transcript cannot be compared with the pixels', squash(await text('#dz-imagetext-rule')) === RULE && /cannot compare the transcript with the pixels/.test(dz));

    // ===== 4. replacing the image again stales the approval =====
    await login('creator');
    await go('#/workspace/SUB-1');
    await b.click('Edit as new revision');
    await b.setFiles('#asset-file', [fx('inverted-banner')]);
    await waitFor(`/belonged to the previous image/.test(document.querySelector('main')?.innerText ?? '')`, 8000);
    await b.click('Save as revision 5');
    await b.wait(1300);
    const rev5 = (await status('SUB-1')).revisions.at(-1);
    check('the new revision holds NO transcription: the confirmation did not follow the image', rev5.imageText === undefined);
    await go('#/queue');
    await go('#/workspace/SUB-1');
    body = await main();
    check('the earlier approval no longer applies, and the reasons name the image and the text in it', /Re-review required/.test(await text('.ws-title')) && /the image details changed/.test(body) && /the confirmed text in the image changed/.test(body));
    check('the findings panel says the text in the image has NOT been checked', /no transcription of it has been confirmed/.test(await b.eval(`document.querySelector('.findings')?.textContent ?? ''`).then((t) => t) || (await b.eval('document.body.textContent'))));
    await shot('5-stale-after-image-replaced');
    check('browser console is clean (expected 4xx network lines excluded)', b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m)).length === 0, b.consoleMsgs.join(' | '));
  }

  if (attemptsFile) {
    const a = attempts();
    check('the whole flow (server, reader, worker threads, browser driver) made no network request: only the one deliberate control was recorded', a.length === 1 && a[0].detail.startsWith('https://example.com'), `${a.length} recorded`);
  }
} catch (e) {
  check('walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (ocr*-*.png)`);
void readFile;
void copyFile;
process.exit(failed ? 1 : 0);
