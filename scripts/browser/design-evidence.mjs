// Design evidence: the same synthetic, isolated workspace shown at 1440, 768, 390 and 320 px, before and after a visual change.
//
//   node scripts/browser/design-evidence.mjs --tag before|after        screenshots docs/evidence/design-<tag>-<width>-<view>.png and a measurement JSON
//   node scripts/browser/design-evidence.mjs --serve [--port 4301]    only builds the isolated workspace and serves it (for the Taste inspector), until stopped
//
// Data is built in a temp directory (the showcase story plus two synthetic campaigns that carry a retained image: one with a confirmed text-in-image
// transcription, one with an image and no transcription yet, which is where a reading draft appears). The preserved demo data and the main data are never opened.
// Needs Edge or Chrome. The OCR draft state needs the optional reader; without it that view is skipped and said so.
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ocrAvailability } from '../../src/ocr.js';
import { bootstrapShowcase } from '../demo/bootstrap.mjs';
import { launch } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const tag = arg('--tag', 'after');
const serveOnly = argv.includes('--serve');
const outFile = arg('--out', null);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-design-'));
const app = await createApp({ dataFile: path.join(tmp, 'design.json'), semantic: null });
const base = await app.listen(serveOnly ? Number(arg('--port', 4301)) : 0);
let b;
const report = { tag, base: 'isolated temp workspace', views: {}, ocrAvailable: ocrAvailability().ok };

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

try {
  await bootstrapShowcase(base);
  const png = await readFile(path.join(root, 'tests', 'fixtures', 'ocr', 'clear-30-hours.png'));
  const sha = must(await call('POST', '/api/assets', png, 'creator', true), 'upload').asset.sha256;
  const asset = { name: 'spring-banner.png', alt: 'A banner with two short lines of text on a plain background', retainedSha256: sha };
  const confirmed = must(await call('POST', '/api/submissions', { title: 'Spring launch banner (text in the image confirmed)', text: 'A reading lamp for your desk.', asset, imageText: { text: 'The battery lasts 30 hours\non a single charge.', confirmed: true } }), 'ocr confirmed campaign');
  const pending = must(await call('POST', '/api/submissions', { title: 'Autumn banner (text in the image not read yet)', text: 'A reading lamp for your desk.', asset }), 'ocr pending campaign');
  report.ids = { confirmed: confirmed.id, pending: pending.id };

  if (serveOnly) {
    console.log(`Isolated design workspace on ${base}  (confirmed ${confirmed.id}, pending ${pending.id}). Stop with Ctrl+C or by ending this process.`);
    await new Promise(() => {});
  }

  const VIEWPORTS = [
    { w: 1440, h: 900, mobile: false },
    { w: 768, h: 1024, mobile: false },
    { w: 390, h: 844, mobile: true },
    { w: 320, h: 760, mobile: true },
  ];
  const MEASURE = `(() => {
    const de = document.documentElement;
    const cs = (e) => getComputedStyle(e);
    const small = [];
    for (const e of document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')) {
      const st = cs(e);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (e.closest('.sr-only, .skip')) continue;
      if (r.height < 32 || r.width < 32) small.push({ el: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + String(e.className).split(' ')[0], w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent || e.value || '').trim().slice(0, 24) });
    }
    return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, targetsUnder32: small.length, targetSample: small.slice(0, 6), bodyFont: cs(document.body).fontFamily.slice(0, 40), bodySize: cs(document.body).fontSize };
  })()`;
  b = await launch(`${base}/#/workspace/SUB-6`, { width: 1440, height: 900, port: 9399 });
  await b.wait(1600);

  const out = (w, v) => path.join(shots, `design-${tag}-${w}-${v}.png`);
  const settle = async (ms = 900) => b.wait(ms);
  const openLinkText = async (re) => b.eval(`(() => { const a = [...document.querySelectorAll('a, button')].find((x) => ${re}.test(x.textContent)); a?.click(); return !!a; })()`);

  for (const vp of VIEWPORTS) {
    await b.viewport(vp.w, vp.h, vp.mobile);
    const views = [];
    const snap = async (name, prep, keepScroll = false) => {
      if (prep) await prep();
      if (!keepScroll) await b.eval('window.scrollTo(0, 0)');
      await settle(300);
      const m = await b.eval(MEASURE);
      report.views[`${vp.w}-${name}`] = m;
      await b.shot(out(vp.w, name));
      views.push(name);
    };
    await snap('campaign-findings', async () => {
      await b.eval(`location.hash = '#/workspace/SUB-6'`);
      await settle(1300);
    });
    await snap('source-exact', async () => {
      await b.eval(`location.hash = '#/workspace/SUB-6'`);
      await settle(1100);
      await openLinkText('/Open the exact passage in the source/');
      await settle(1200);
    });
    await snap('queue', async () => {
      await b.eval(`location.hash = '#/queue'`);
      await settle(1000);
    });
    await snap('dossier', async () => {
      await b.eval(`location.hash = '#/dossier/SUB-4'`);
      await settle(1200);
    });
    await snap('ocr-confirmed', async () => {
      await b.eval(`location.hash = '#/workspace/${confirmed.id}'`);
      await settle(1200);
      await b.eval(`document.getElementById('imagetext-card')?.scrollIntoView({ block: 'start' })`);
    }, true);
    if (report.ocrAvailable) {
      await snap('ocr-draft', async () => {
        await b.eval(`location.hash = '#/workspace/${pending.id}'`);
        await settle(1100);
        await openLinkText('/^Edit as new revision/');
        await settle(700);
        await b.eval(`document.getElementById('imagetext-read')?.click()`);
        for (let i = 0; i < 60; i++) {
          if (await b.eval(`(document.getElementById('imagetext')?.value ?? '').length > 0`)) break;
          await b.wait(300);
        }
        await b.eval(`document.getElementById('imagetext-h')?.scrollIntoView({ block: 'start' })`);
      }, true);
      // leave the editor: the cancel button returns to the saved view
      await b.eval(`location.hash = '#/workspace/SUB-6'`);
      await settle(600);
    }
    await snap('about', async () => {
      await b.eval(`location.hash = '#/workspace/SUB-6'`);
      await settle(1000);
      await b.eval(`[...document.querySelectorAll('button')].find((x) => /About/.test(x.textContent))?.click()`);
      await settle(500);
    });
    await b.eval(`[...document.querySelectorAll('dialog[open] button')].find((x) => /^Close$/.test(x.textContent.trim()))?.click()`);
    await snap('library', async () => {
      await b.eval(`location.hash = '#/library'`);
      await settle(1000);
    });
    await snap('sources', async () => {
      await b.eval(`location.hash = '#/sources'`);
      await settle(1000);
    });
    console.log(`${vp.w}px: ${views.join(', ')}`);
  }
  report.consoleMessages = b.consoleMsgs.filter((m) => !/40[1239]|Failed to load resource/.test(m));
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
if (outFile) await writeFile(path.join(root, outFile), `${JSON.stringify(report, null, 2)}\n`);
console.log(`design-${tag}: ${Object.keys(report.views).length} views captured. Screenshots: ${shots}`);
