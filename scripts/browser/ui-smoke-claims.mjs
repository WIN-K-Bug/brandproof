// Browser walkthrough of the factual qualifier / scope checks on a throwaway server with synthetic data:
// a caution (needs review, advice only, no Apply button), a safe correction that keeps the approved
// qualifiers, and a human rewrite that clears the caution. Saves screenshots to docs/evidence/claims-*.png.
//
//   npm run ui-smoke-claims
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });

const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-claims-'));
const app = await createApp({ dataFile: path.join(tmp, 'data.json'), semantic: null });
const base = await app.listen(0);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const api = (method, p, body, role = 'creator') =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-demo-role': role }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

const CAUTION = 'A full charge always lasts exactly 12 hours at maximum brightness.';
const WRONG = 'The battery lasts 30 hours on a single charge.';
const COMPETITOR = 'Our competitor battery lasts 30 hours; the Aurora Lamp lasts up to 12 hours.';
const FIXED = 'A full charge lasts up to 12 hours at medium brightness. The battery lasts up to 12 hours at medium brightness on a single charge.';

let b;
try {
  const sub = await api('POST', '/api/submissions', { title: 'Battery claims', text: `${CAUTION} ${WRONG}`, asset: {} });
  const competitor = await api('POST', '/api/submissions', { title: 'Competitor comparison', text: COMPETITOR, asset: {} });

  const findings = () =>
    b.eval(`[...document.querySelectorAll('.finding')].map(e => ({ text: e.textContent.replace(/\\s+/g, ' '), apply: [...e.querySelectorAll('button')].some(x => /Apply/.test(x.textContent)) }))`);
  const status = (list, re) => list.filter((f) => re.test(f.text));

  b = await launch(`${base}/#/workspace/${sub.id}`);
  let list = await findings();
  const caution = status(list, /Needs review/).find((f) => /12 hours/.test(f.text));
  check('the "always exactly 12 hours at maximum brightness" sentence is a caution, not a match', Boolean(caution) && !list.some((f) => /Matches approved fact/.test(f.text) && /maximum/.test(f.text)), list.map((f) => f.text.slice(0, 60)).join(' | '));
  check('the caution gives advice quoting the approved wording and offers no Apply button', /at medium brightness/.test(caution?.text ?? '') && caution?.apply === false);
  const wrong = status(list, /Contradicts/).find((f) => /30 hours/.test(f.text));
  check('the 30-hour mismatch offers a replacement that keeps "up to" and "at medium brightness"', /up to 12 hours at medium brightness/.test(wrong?.text ?? '') && wrong?.apply === true);
  await b.shot(path.join(shots, 'claims-1-caution-and-safe-fix.png'));
  await b.eval(`[...document.querySelectorAll('.finding')].find(e => /Needs review/.test(e.textContent))?.scrollIntoView({ block: 'center' })`);
  await b.wait(400);
  await b.shot(path.join(shots, 'claims-1b-caution-advice-only.png'));

  // competitor sentence: nothing is rewritten or corrected
  await b.goto(`${base}/#/workspace/${competitor.id}`);
  list = await findings();
  const theirs = status(list, /Needs review/).find((f) => /30 hours/.test(f.text));
  check('a competitor figure is a caution that explains whose figure it is, with no Apply button', Boolean(theirs) && /other than the approved product|competitor/.test(theirs.text) && theirs.apply === false && !list.some((f) => /Contradicts/.test(f.text)));
  check('our own "up to 12 hours" in the same sentence is still shown as consistent', list.some((f) => /Matches approved fact/.test(f.text)));
  await b.eval(`[...document.querySelectorAll('.finding')].find(e => /Needs review/.test(e.textContent))?.scrollIntoView({ block: 'center' })`);
  await b.wait(400);
  await b.shot(path.join(shots, 'claims-2-competitor.png'));

  // safe correction + human rewrite
  await b.goto(`${base}/#/workspace/${sub.id}`);
  await b.click('Edit as new revision');
  await b.wait(900);
  await b.click('Apply to draft');
  await b.wait(1200);
  const applied = await b.eval(`document.querySelector('#draft-text').value`);
  check('Apply to draft inserts the full approved wording for the safe case only', applied === `${CAUTION} The battery lasts up to 12 hours at medium brightness on a single charge.`, applied);
  list = await findings();
  check('after the safe fix the caution remains (a person has to rewrite it)', status(list, /Needs review/).length === 1 && status(list, /Contradicts/).length === 0);

  await b.type('#draft-text', FIXED);
  await b.wait(1500);
  list = await findings();
  const fixed = list.filter((f) => /approved fact|Battery life/.test(f.text));
  check('the human rewrite clears the caution: only "Matches approved fact" remains', status(list, /Needs review|Contradicts/).length === 0 && status(list, /Matches approved fact/).length >= 1, list.map((f) => f.text.slice(0, 50)).join(' | '));
  await b.shot(path.join(shots, 'claims-3-human-rewrite.png'));

  await b.click('Save as revision 2');
  await b.wait(1000);
  const saved = await api('GET', `/api/submissions/${sub.id}`);
  check('the corrected wording is saved as revision 2 with no battery cautions', saved.headRevision === 2 && saved.current.findings.filter((f) => f.ruleId === 'FCT-001').every((f) => f.status === 'supported'), JSON.stringify(saved.current?.summary));

  // a denied claim and a retired figure: caution + advice only, and Apply never reverses them
  const DENIED = 'Do not advertise that the battery lasts 30 hours.';
  const RETIRED = 'The old battery specification of 30 hours was incorrect.';
  const AFFIRM = 'A full charge lasts 30 hours.';
  const guidance = await api('POST', '/api/submissions', { title: 'Guidance and a claim', text: `${DENIED} ${RETIRED} ${AFFIRM}`, asset: {} });
  await b.goto(`${base}/#/workspace/${guidance.id}`);
  list = await findings();
  const cautions = status(list, /Needs review/).filter((x) => /30 hours/.test(x.text));
  check('the denied claim and the retired figure are two cautions that explain why, with no Apply button', cautions.length === 2 && cautions.every((x) => x.apply === false && /Nothing is rewritten automatically/.test(x.text) && /NOT to make this claim|old, retired or wrong/.test(x.text)), cautions.map((x) => x.text.slice(0, 80)).join(' | '));
  const affirm = status(list, /Contradicts/).filter((x) => /30 hours/.test(x.text));
  check('only the affirmative 30-hour sentence is a contradiction with a safe replacement', affirm.length === 1 && affirm[0].apply === true && /up to 12 hours at medium brightness/.test(affirm[0].text));
  await b.eval(`[...document.querySelectorAll('.finding')].find(e => /Needs review/.test(e.textContent))?.scrollIntoView({ block: 'center' })`);
  await b.wait(400);
  await b.shot(path.join(shots, 'claims-5-denied-and-retired.png'));
  await b.click('Edit as new revision');
  await b.wait(900);
  await b.click('Apply to draft');
  await b.wait(1200);
  const applied2 = await b.eval(`document.querySelector('#draft-text').value`);
  check('Apply to draft changes only the affirmative sentence: the denial and the history keep their words', applied2 === `${DENIED} ${RETIRED} A full charge lasts up to 12 hours at medium brightness.`, applied2);
  list = await findings();
  check('after applying, both statements about 30 hours are still cautions (nothing was inverted) and the claim is consistent', status(list, /Needs review/).filter((x) => /30 hours/.test(x.text)).length === 2 && status(list, /Contradicts/).length === 0 && status(list, /Matches approved fact/).length >= 1);
  await b.click('Cancel');
  await b.wait(500);

  // the library records the approved condition
  await b.goto(`${base}/#/library`);
  await b.select('#role', 'manager');
  await b.click('Approved facts');
  await b.wait(500);
  const lib = await b.eval(`document.body.innerText`);
  check('the library shows the approved condition and what happens to other wording', /Approved condition: at medium brightness/.test(lib) && /sent to review/.test(lib));
  await b.shot(path.join(shots, 'claims-4-library-condition.png'));

  check('browser console is clean', b.consoleMsgs.length === 0, b.consoleMsgs.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.stack ?? e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
