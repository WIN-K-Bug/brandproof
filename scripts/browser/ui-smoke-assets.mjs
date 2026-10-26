// Browser walkthrough of persistent campaign images in the AUTHENTICATED workspace, with synthetic accounts and FICTIONAL
// generated PNGs in a throwaway directory. Never touches data/, never prints passwords.
//
//   npm run ui-smoke-assets
//
// upload -> save -> reload -> restart the server -> a different reviewer sees exactly the retained bytes -> approve ->
// replace the image -> approval stale -> history keeps each image -> failure recovery -> metadata-only legacy -> narrow screen.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';
import { makeStripedPng, broken, jpegLike } from '../../tests/png-helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-img-ui-'));
await mkdir(path.join(tmp, 'auth'));

const files = { dataFile: path.join(tmp, 'workspace.json'), authFile: path.join(tmp, 'auth', 'users.json') };
const open = (port = 0) => createApp({ ...files, mode: 'authenticated', semantic: null, authOptions: { cost: { N: 1024, r: 8, p: 1 } } }).then(async (app) => ({ app, base: await app.listen(port) }));
let { app, base } = await open();
const port = Number(new URL(base).port);

const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { creator: secret(), reviewer: secret() };
await app.auth.createUser({ username: 'syn-creator', displayName: 'Synthetic Creator', role: 'creator', password: pw.creator });
await app.auth.createUser({ username: 'syn-reviewer', displayName: 'Synthetic Reviewer', role: 'reviewer', password: pw.reviewer });

// fictional fixtures
const A = makeStripedPng({ width: 240, height: 120, colors: [[15, 42, 67], [27, 156, 143], [242, 169, 59]] });
const B = makeStripedPng({ width: 200, height: 100, colors: [[180, 30, 60], [250, 240, 230]] });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const [shaA, shaB] = [sha(A), sha(B)];
const fx = path.join(tmp, 'fixtures');
await mkdir(fx);
const f = { A: path.join(fx, 'aurora-banner.png'), B: path.join(fx, 'aurora-banner-v2.png'), notPng: path.join(fx, 'photo.png'), trunc: path.join(fx, 'broken.png') };
await writeFile(f.A, A);
await writeFile(f.B, B);
await writeFile(f.notPng, jpegLike);
await writeFile(f.trunc, broken.truncated(A));

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

let b;
try {
  b = await launch(`${base}/#/workspace`, { port: 9354 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const shot = (name) => b.shot(path.join(shots, `assets-${name}.png`));
  const primary = () => b.click('dialog .dlg-f .btn.primary');
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
    await b.wait(900);
  };
  /** Fetch an image URL INSIDE the page (with the page's own session) and return its SHA-256, size and decoded size. */
  const pageImage = (sel) =>
    b.eval(`(async () => {
      const img = document.querySelector(${JSON.stringify(sel)});
      if (!img) return null;
      const buf = await (await fetch(img.src)).arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      return { sha: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''), bytes: buf.byteLength, w: img.naturalWidth, h: img.naturalHeight, complete: img.complete, alt: img.alt };
    })()`);

  // 1. creator: new submission, attach a PNG, save
  await login('creator');
  await b.click('+ New submission');
  await b.type('#nt', 'Aurora launch banner (fictional)');
  await b.type('#nx', 'Meet the Aurora Lamp, a reading lamp made to be easy on the eyes.');
  await primary();
  await b.wait(1000);
  check('before attaching, the revision says no image', /No image attached/.test(await text('main')));
  await b.click('Edit as new revision');
  await b.setFiles('#asset-file', [f.A]);
  check('the PNG is uploaded and shown as a RETAINED image with its true dimensions', /Retained image/.test(await text('.image-box')) && /240 × 120 px/.test(await text('.image-box')));
  await b.type('#alt', 'Three vertical stripes in navy, teal and amber, the Fernlight colours');
  await b.eval(`document.querySelector('.image-box').scrollIntoView({ block: 'start' })`);
  await b.wait(300);
  await shot('1-draft-retained');
  await b.click('Save as revision 2');
  await b.wait(1000);
  const saved = await pageImage('.retained-img');
  check('after saving, the page shows the retained image (exact bytes, decodes at 240 x 120)', saved && saved.sha === shaA && saved.bytes === A.length && saved.w === 240 && saved.h === 120, saved ? `${saved.sha.slice(0, 10)}…` : 'no image');
  check('the image has meaningful alt text and a Retained chip', saved?.alt.startsWith('Three vertical stripes') && /Retained image/.test(await text('main')));
  await b.eval('location.reload()');
  await b.wait(1500);
  const reloaded = await pageImage('.retained-img');
  check('after a page reload the same retained image is there', reloaded?.sha === shaA);
  await b.click('Request review');
  await b.wait(900);
  await shot('2-creator-view');

  // 2. restart the server: sessions are gone, bytes and records are not
  await app.close();
  ({ app, base } = await open(port));
  await b.goto(`${base}/#/workspace/SUB-1`);
  await login('reviewer');
  await b.eval('location.reload()');
  await b.wait(1200);
  const afterRestart = await pageImage('.retained-img');
  check('after a SERVER RESTART a different reviewer sees exactly the retained bytes', afterRestart?.sha === shaA && afterRestart.bytes === A.length, afterRestart ? `${afterRestart.sha.slice(0, 10)}…` : 'no image');
  await shot('3-reviewer-after-restart');
  await b.click('Approve…');
  await primary();
  await b.wait(900);
  check('the reviewer approves the revision with the retained image', /Approved/.test(await text('.ws-title')));

  // 3. creator replaces the image: approval goes stale, history keeps both
  await login('creator');
  await go('#/workspace/SUB-1');
  await b.click('Edit as new revision');
  check('the editor starts from the image already retained', /Retained image/.test(await text('.image-box')));
  await b.setFiles('#asset-file', [f.B]);
  check('replacing shows the new image (200 x 100) in the draft', /200 × 100 px/.test(await text('.image-box')));
  check('replacing warns that the old alt text was kept and must be re-checked', /alt text was kept from the previous image/.test(await text('.image-box')));
  await b.click('Save as revision 3');
  await b.wait(1000);
  check('the approval is now Re-review required', /Re-review required/.test(await text('.ws-title')));
  check('and the reason names the image details', /image details changed/.test(await text('main')));
  const nowImg = await pageImage('.retained-img');
  check('the workspace now shows the replacement', nowImg?.sha === shaB && nowImg.w === 200);
  await b.click('History');
  const thumbs = await b.eval(`[...document.querySelectorAll('.thumb-sm')].map((i) => i.src.split('/').pop())`);
  check('history keeps each revision\'s own image (revision 2 = original, revision 3 = replacement)', thumbs.length === 2 && thumbs[0] === shaA && thumbs[1] === shaB, thumbs.map((t) => t.slice(0, 8)).join(','));
  await shot('4-history-two-images');
  await b.click('Compare with revision 2');
  await b.wait(700);
  check('comparison names the image file as changed', /image file/.test(await text('main')));
  await b.click('Close comparison');

  // 4. failure recovery
  await b.click('Edit as new revision');
  await b.setFiles('#asset-file', [f.notPng]);
  const notPng = await text('.image-box');
  check('a non-PNG is refused with a clear message, and the draft says it still has the previous image', /not a PNG/i.test(notPng) && /still has the previous image/.test(notPng));
  await b.setFiles('#asset-file', [f.trunc]);
  const trunc = await text('.image-box');
  check('a truncated PNG is refused by the SERVER, and the previous image is explicitly kept', /truncated|corrupt/i.test(trunc) && /still has the previous image/.test(trunc));
  check('the Save button works again and still points at the previous image', (await b.eval(`document.querySelector('.card-h .btn.primary').disabled`)) === false && /Retained image/.test(await text('.image-box')));
  await b.eval(`document.querySelector('.image-box').scrollIntoView({ block: 'start' })`);
  await b.wait(300);
  await shot('5-upload-refused');
  await b.click('Remove image from this revision');
  check('removing is explicit and says earlier revisions keep theirs', /earlier revisions keep theirs/.test(await text('.image-box')) && !(await b.eval(`!!document.querySelector('.image-box .retained-img')`)));
  await b.click('Cancel');

  // 5. a legacy metadata-only revision is shown honestly
  const login0 = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'syn-creator', password: pw.creator }) });
  const cookie = login0.headers.getSetCookie()[0].split(';')[0];
  const { csrf } = await login0.json();
  const legacy = await fetch(`${base}/api/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ title: 'Older banner (fictional, metadata only)', text: 'An older banner revision.', asset: { name: 'old-banner.png', alt: 'An older banner', fileSha256: 'b'.repeat(64) } }),
  }).then((r) => r.json());
  await go(`#/workspace/${legacy.id}`);
  const meta = await text('main');
  check('a metadata-only revision says its image was NOT retained and cannot be shown', /Metadata only: image not retained/.test(meta) && /Reviewers cannot see this image/.test(meta) && !(await b.eval(`!!document.querySelector('.retained-img')`)));
  await shot('6-metadata-only');

  // 6. narrow screen, reviewer layout
  await login('reviewer');
  await go('#/workspace/SUB-1');
  await b.viewport(420, 900, true);
  const overflow = await b.eval('document.documentElement.scrollWidth - window.innerWidth');
  const fits = await b.eval(`(() => { const i = document.querySelector('.retained-img'); const r = i.getBoundingClientRect(); return r.width > 0 && r.right <= window.innerWidth; })()`);
  check('at 420 px wide there is no horizontal scrolling and the image fits', overflow <= 1 && fits, `overflow ${overflow}px`);
  await b.eval(`document.querySelector('.retained-img').scrollIntoView({ block: 'center' })`);
  await b.wait(300);
  await shot('7-narrow');
  await b.viewport(1360, 900);

  const noise = b.consoleMsgs.filter((m) => !/^LOG info/.test(m) && !/401|403|409|413|422|Failed to load resource/.test(m));
  check('browser console has no errors (expected 4xx network lines excluded)', noise.length === 0, noise.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (assets-*.png)`);
process.exit(failed ? 1 : 0);
