// Reproducible browser walkthrough of BrandProof. Starts its OWN server on a free localhost port with a
// throwaway data directory (so it never touches data/), drives a real headless browser, asserts what it
// sees, and saves screenshots to docs/evidence/.
//
//   npm run ui-smoke
//
// Needs Edge or Chrome installed. AI source matching is exercised only if the optional package and model
// are present (npm install, npm run fetch-model); otherwise that step reports SKIPPED, not passed.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { localAvailability } from '../../src/semantic.js';
import { launch } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });

const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-ui-'));
const app = await createApp({ dataFile: path.join(tmp, 'data.json') }); // real local embeddings if installed
const base = await app.listen(0);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}  (${why})`);
};

const api = (method, p, body, role = 'creator') =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-demo-role': role }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const semantic = localAvailability();
let b;
try {
  if (semantic.ok) {
    for (let i = 0; i < 120; i++) {
      const st = await (await fetch(base + '/api/semantic/status')).json();
      if (st.state === 'ready') break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const demo = await api('POST', '/api/submissions', {
    title: 'Semantic matching demo',
    text: 'How long can the lamp stay lit before recharging? The weather in Paris is rainy in autumn.',
    asset: {},
  });

  b = await launch(`${base}/#/workspace/SUB-1`);
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);

  // shell
  check('navigation has the five areas', (await b.eval(`[...document.querySelectorAll('#nav a')].map(a=>a.textContent.trim().replace(/\\d+$/,'')).join('|')`)) === 'Workspace|Brand library|Sources|Review queue|Insights');
  check('demo banner is a short notice: demo mode, roles are not sign-in, data stays local; rules-only AI status is in the findings panel', /Demo mode/.test(await text('#banner')) && /not sign-in/.test(await text('#banner')) && (await b.eval('document.getElementById("banner").offsetHeight')) <= 56 && /Contextual AI review is unavailable/.test(await text('.side, #main')));
  check('role picker lists the three demo roles', (await b.eval(`[...document.querySelectorAll('#role option')].map(o=>o.textContent).join(',')`)) === 'Creator,Manager,Reviewer');
  check('seed draft shows 4 blocking findings', (await b.eval(`document.querySelectorAll('.finding.sev-error').length`)) === 4);
  await b.shot(path.join(shots, 'workspace.png'));

  // draft check: a stale answer must never replace the answer for newer text
  await b.click('Edit as new revision');
  await b.type('#draft-text', 'A cheap lamp.');
  await b.type('#draft-text', 'The Aurora Lamp is calm.');
  await b.wait(1500);
  const draftRules = await b.eval(`[...document.querySelectorAll('.finding .mono')].map(e=>e.textContent)`);
  check('draft findings follow the latest text (no stale TRM-003 from the earlier text)', !draftRules.includes('TRM-003'), draftRules.join(','));
  check('AI source matching refuses unsaved drafts', /saved revisions only/.test(await text('.semantic, .card-b .notice.info')) || /saved revisions only/.test(await b.eval(`document.body.innerText`)));
  await b.shot(path.join(shots, 'edit.png'));
  await b.click('Cancel');

  // AI source matching
  await b.goto(`${base}/#/workspace/${demo.id}`);
  const panel = await b.eval(`document.querySelector('.semantic')?.innerText ?? ''`);
  if (!semantic.ok) {
    check('unavailable state is shown honestly', /Unavailable/.test(panel) && /works without it/.test(panel), semantic.reason);
    skip('paraphrase retrieves the battery source', 'optional package/model not installed');
  } else {
    check('status shows local embeddings, not generative review', /Ready/.test(panel) && /not generative/i.test(panel) && /Contextual AI review remains unavailable/.test(panel));
    await b.click('#sem-0');
    await b.click('#sem-1');
    await b.click('Find relevant sources');
    for (let i = 0; i < 60 && !(await b.eval(`!!document.querySelector('.semantic .quote')`)); i++) await b.wait(500);
    const out = await b.eval(`[...document.querySelectorAll('.semantic .sem-passage')].map(p=>p.innerText)`);
    const first = out[0] ?? '';
    const second = out[1] ?? '';
    check('paraphrase retrieves FCT-001 (battery) first', /FCT-001/.test(first) && first.indexOf('FCT-001') < (first.indexOf('FCT-004') === -1 ? 1e9 : first.indexOf('FCT-004')), first.replace(/\s+/g, ' ').slice(0, 160));
    check('unrelated passage gets no confident match', /No approved source looks clearly relevant/.test(second), second.replace(/\s+/g, ' ').slice(0, 160));
    const footer = await b.eval(`document.querySelector('.semantic')?.innerText ?? ''`);
    check('result is labelled with revision, guideline version and "not probabilities"', /Revision 1/.test(footer) && /guidelines v1/.test(footer) && /not probabilities/.test(footer));
    check('no percentages shown as confidence', !/\d\s?%/.test(footer.replace(/100% recycled aluminium/g, '')));
    await b.eval(`document.querySelector('.semantic h3').scrollIntoView()`);
    await b.wait(300);
    await b.shot(path.join(shots, 'ai-source-matching.png'));
  }

  // approval + stale
  await b.goto(`${base}/#/workspace/SUB-3`);
  await b.select('#role', 'reviewer');
  await b.click('Approve…');
  await b.eval(`document.getElementById('ack').click()`);
  await b.click('dialog .dlg-f .btn.primary');
  await b.wait(800);
  check('reviewer can approve with acknowledgement', /Approved/.test(await text('.ws-title')));
  await b.select('#role', 'manager');
  await b.goto(`${base}/#/library`);
  await b.click('Rules & thresholds');
  await b.type('#s-signals', 'best\nguaranteed\nunbeatable');
  await b.click('Publish new version');
  await b.wait(800);
  await b.goto(`${base}/#/workspace/SUB-3`);
  check('guideline change shows Re-review required', /Re-review required/.test(await text('.ws-title')));
  await b.shot(path.join(shots, 'stale-approval.png'));
  await b.goto(`${base}/#/queue`);
  await b.shot(path.join(shots, 'queue.png'));
  await b.goto(`${base}/#/library`);
  await b.shot(path.join(shots, 'library.png'));
  await b.goto(`${base}/#/insights`);
  await b.shot(path.join(shots, 'insights.png'));

  check('browser console is clean', b.consoleMsgs.length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (${results.filter((r) => r.skipped).length} skipped). Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
