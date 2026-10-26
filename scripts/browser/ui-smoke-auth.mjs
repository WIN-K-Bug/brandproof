// Browser walkthrough of the AUTHENTICATED workspace using ONLY synthetic accounts in a throwaway directory.
//
//   npm run ui-smoke-auth
//
// It never touches data/, never uses real accounts, and never prints the synthetic passwords (they are random,
// created in memory for this run, and discarded). Screenshots go to docs/evidence/auth-*.png.
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { launch } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'docs', 'evidence');
await mkdir(shots, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), 'brandproof-auth-ui-'));
await mkdir(path.join(tmp, 'auth'));

const COST = { N: 1024, r: 8, p: 1 }; // fast hashing for a throwaway run only; the real default is N=2^17
const app = await createApp({
  dataFile: path.join(tmp, 'workspace.json'),
  authFile: path.join(tmp, 'auth', 'users.json'),
  mode: 'authenticated',
  semantic: null,
  authOptions: { cost: COST },
});
const base = await app.listen(0);

const secret = () => `synthetic-${randomBytes(12).toString('hex')}-pw`;
const pw = { owner: secret(), manager: secret(), reviewer: secret() };
await app.auth.createUser({ username: 'syn-owner', displayName: 'Synthetic Owner', role: 'manager', password: pw.owner, owner: true });
await app.auth.createUser({ username: 'syn-manager', displayName: 'Synthetic Manager', role: 'manager', password: pw.manager });
await app.auth.createUser({ username: 'syn-reviewer', displayName: 'Synthetic Reviewer', role: 'reviewer', password: pw.reviewer });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// Node-side: the manager creates a submission and sends it for review (as a script, with the manager's own synthetic login).
async function apiAs(username, password) {
  const post = async (p, body, extra = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...extra }, body: JSON.stringify(body) });
  const r = await post('/api/auth/login', { username, password });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const { csrf } = await r.json();
  return (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf }, body: body ? JSON.stringify(body) : undefined }).then((x) => x.json());
}
const mgr = await apiAs('syn-manager', pw.manager);
const sub = await mgr('POST', '/api/submissions', {
  title: 'Synthetic review item',
  text: 'Meet the Aurora Lamp, a reading lamp made to be easy on the eyes. A full charge runs up to 12 hours.',
  asset: { name: 'hero.png', alt: 'The Aurora Lamp glowing beside an open book on a wooden shelf', fg: '#0F2A43', bg: '#FFFFFF', colors: ['#0F2A43'] },
});
await mgr('POST', `/api/submissions/${sub.id}/request-review`, { revision: 1, expected: sub.workflow.binding });

let b;
try {
  b = await launch(`${base}/#/workspace/${sub.id}`, { port: 9352 });
  const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const signIn = async (user, password) => {
    await b.type('#si-user', user);
    await b.type('#si-pass', password);
    await b.click('form.signin button[type=submit]');
    await b.wait(900);
  };

  check('signed-out visitors see only the sign-in form (no navigation, no data)', (await b.eval(`!!document.getElementById('si-user') && getComputedStyle(document.getElementById('nav')).display === 'none'`)) && !/Synthetic review item/.test(await b.eval(`document.body.innerText`)));
  check('banner is a short local-prototype data-use notice (technical limits live under About)', /Local prototype/.test(await text('#banner')) && /unencrypted/.test(await text('#banner')) && (await b.eval('document.getElementById("banner").offsetHeight')) <= 56);
  await b.shot(path.join(shots, 'auth-sign-in.png'));

  await signIn('syn-manager', 'wrong-password-for-demo-run');
  check('wrong password shows a generic error and stays signed out', /Invalid username or password/.test(await text('#si-err')));

  await signIn('syn-manager', pw.manager);
  check('signed in: the real actor and server-given role are shown', /Synthetic Manager/.test(await text('#who')) && /Manager/.test(await text('#who')));
  check('there is no role switcher to impersonate another role', await b.eval(`document.getElementById('role-picker').offsetParent === null && document.getElementById('role').offsetParent === null`));
  check('the session cookie is not readable from page scripts (HttpOnly)', (await b.eval(`document.cookie`)) === '');
  check('the submission is visible and in review', /In review/.test(await text('.ws-title')));
  check('the author cannot approve their own submission, and the reason is shown', (await b.eval(`[...document.querySelectorAll('.flow button')].find(x=>x.textContent.startsWith('Approve')).disabled`)) && /different person must approve/.test(await text('.flow')));
  await b.shot(path.join(shots, 'auth-self-approval-blocked.png'));

  await b.click('Sign out');
  await b.wait(500);
  check('sign-out returns to the sign-in form', await b.eval(`!!document.getElementById('si-user')`));
  await b.goto(`${base}/#/workspace/${sub.id}`);
  check('after sign-out the workspace is closed even on reload', await b.eval(`!!document.getElementById('si-user')`) && !/Synthetic review item/.test(await b.eval(`document.body.innerText`)));

  await signIn('syn-reviewer', pw.reviewer);
  check('a different person with the reviewer role signs in', /Synthetic Reviewer/.test(await text('#who')));
  check('the reviewer may approve', await b.eval(`![...document.querySelectorAll('.flow button')].find(x=>x.textContent.startsWith('Approve')).disabled`));
  await b.click('Approve…');
  await b.click('dialog .dlg-f .btn.primary');
  await b.wait(900);
  check('approval is recorded', /Approved/.test(await text('.ws-title')));
  await b.click('History');
  check('history names the reviewer as the actor (not a demo label)', /Approved by Synthetic Reviewer/.test((await text('.timeline')).replace(/\s+/g, ' ')) && !/demo role/.test(await text('.timeline')));
  await b.shot(path.join(shots, 'auth-approved-by-reviewer.png'));
  check('the reviewer has no People page and the server refuses admin routes', !(await b.eval(`[...document.querySelectorAll('#nav a')].some(a=>a.textContent.includes('People'))`)) && (await b.eval(`fetch('/api/admin/users').then(r=>r.status)`)) === 403);

  await b.click('Sign out');
  await b.wait(500);
  await signIn('syn-owner', pw.owner);
  await b.goto(`${base}/#/people`);
  check('the owner sees the People page with the audit trail', /Sign-in and account activity/.test(await text('#main')) && /login success/.test(await text('#main')));
  await b.shot(path.join(shots, 'auth-people.png'));

  const noise = b.consoleMsgs.filter((m) => !/401|403|Failed to load resource/.test(m));
  check('browser console has no errors (expected 401/403 network lines excluded)', noise.length === 0, noise.join(' | '));
} catch (e) {
  check('walkthrough ran to the end', false, e.message);
} finally {
  await b?.close();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots} (auth-*.png)`);
process.exit(failed ? 1 : 0);
