// Arriving at the judge demo from another site (m31). The browser withholds the SameSite=Strict cookie on a navigation that starts on another
// site, and on reloads of that page, so the server used to start a NEW session at that moment and the visitor's earlier one became unreachable.
// Now such an arrival (no valid cookie, a cross-site top-level navigation, no entry marker) is answered with a tiny same-origin landing page that
// moves on to this same address from the demo's own origin, where the cookie is sent. The cookie keeps SameSite=Strict, Secure, HttpOnly and
// the __Host- prefix; nothing here touches the Origin, role, CSRF, isolation or quota rules. The real-browser proof is
// scripts/browser/ui-smoke-cross-site-entry.mjs.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createJudgeDemo } from '../src/judge.js';
import { tempDir } from './helpers.js';

const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);
const CROSS = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' };
const publicFile = (name) => readFileSync(path.join(import.meta.dirname, '..', 'public', name), 'utf8');

async function start(t, opts = {}) {
  const tmp = await tempDir();
  const root = path.join(tmp.dir, 'demo-root');
  const demo = await createJudgeDemo({ root, semantic: null, ocr: null, ...opts });
  const base = await demo.listen(0);
  const port = Number(new URL(base).port);
  t.after(async () => {
    await demo.close().catch(() => {});
    await tmp.cleanup();
  });
  const get = (p, headers = {}, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), setCookie: res.headers['set-cookie']?.[0] ?? null }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const folders = () => (existsSync(path.join(root, 'sessions')) ? readdirSync(path.join(root, 'sessions')) : []);
  return { demo, get, folders };
}
const cookieOf = (r) => r.setCookie.split(';')[0];

test('a cross-site arrival with no valid cookie gets a same-origin landing page: no session, no cookie, nothing stored', async (t) => {
  const d = await start(t);
  const r = await d.get('/', CROSS);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.equal(r.setCookie, null, 'no cookie is issued on the cross-site hop');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(d.folders().length, 0, 'no session folder');
  assert.equal(d.demo.stats().sessions, 0, 'no session in memory');
  assert.match(r.headers['content-security-policy'], /script-src 'self'/, 'the same security headers as every page');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  // the page: one external script (same origin), a scripts-off fallback, and a plain link; nothing inline, nothing external
  assert.equal((r.text.match(/<script/g) ?? []).length, 1);
  assert.match(r.text, /<script src="\/enter\.js"><\/script>/);
  assert.match(r.text, /<noscript><meta http-equiv="refresh" content="0;url=\/\?entry=1"><\/noscript>/);
  assert.match(r.text, /<a [^>]*href="\/\?entry=1"/);
  assert.doesNotMatch(r.text, /https?:\/\/|\son[a-z]+=|style=|<iframe|<form/i, 'no external address, handler, inline style, frame or form');
  assert.doesNotMatch(r.text, /id="main"/, 'it is not the application page');
});

test('the landing page is the same fixed text whatever the request carries: nothing is reflected, and the way on is a constant', async (t) => {
  const d = await start(t);
  const plain = (await d.get('/', CROSS)).text;
  for (const p of ['/?x=%3Cscript%3Ealert(1)%3C/script%3E', '/?next=https://evil.example/', '/?redirect=//evil.example', '/?entry=2', '/?entry=1%00', '/?entry', '/?ENTRY=1']) {
    const r = await d.get(p, { ...CROSS, referer: 'https://evil.example/page?next=https://evil2.example', origin: 'https://evil.example' });
    if (r.text === plain) continue;
    // a request that is not the exact marker is not bounced twice: it is an ordinary arrival (a session), never an echo of the query
    assert.ok(!r.text.includes('evil'), `${p}: nothing from the request is reflected`);
  }
  const js = publicFile('enter.js');
  assert.match(js, /location\.replace\(\s*'\/\?entry=1'\s*\+\s*location\.hash\s*\)/, 'the target is one literal plus the fragment (which never leaves this origin)');
  assert.doesNotMatch(js.replace(/\/\/.*$/gm, ''), /location\.(search|href|host|origin)|document\.(referrer|URL|cookie)|URLSearchParams|https?:|localStorage|sessionStorage|fetch|eval|innerHTML/, 'it reads nothing else and sends nothing');
  const served = await d.get('/enter.js');
  assert.equal(served.status, 200);
  assert.match(served.headers['content-type'], /javascript/);
  assert.equal(served.text, js);
  assert.equal(served.setCookie, null, 'a static file never starts a session');
});

test('the marked second request is never bounced again, so there is no loop: it starts the one session, as an ordinary arrival does', async (t) => {
  const d = await start(t);
  const hop = await d.get('/', CROSS);
  assert.equal(hop.setCookie, null);
  // the browser follows the landing page with a request from our own origin (same-origin), carrying the marker
  const landed = await d.get('/?entry=1', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.equal(landed.status, 200);
  assert.match(landed.text, /id="main"/, 'the application page');
  assert.match(landed.setCookie, /^bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=/);
  assert.equal(d.folders().length, 1, 'exactly one session for the whole arrival');
  // even if a browser still reports the marked request as cross-site, it is served (a session), never bounced again
  const d2 = await start(t);
  const again = await d2.get('/?entry=1', CROSS);
  assert.match(again.text, /id="main"/);
  assert.ok(again.setCookie, 'the fallback is the long-standing behaviour: a session');
  assert.equal(d2.folders().length, 1);
});

test('a visitor with a live session is protected: the cross-site hop changes nothing, and the landing request resumes the same session', async (t) => {
  const d = await start(t);
  const first = await d.get('/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  const cookie = cookieOf(first);
  const seen = d.folders();
  assert.equal(seen.length, 1);
  // the browser withholds the Strict cookie on the cross-site navigation: the server sees no cookie
  const hop = await d.get('/', CROSS);
  assert.equal(hop.setCookie, null, 'the visitor\'s cookie in the browser is not overwritten');
  assert.deepEqual(d.folders(), seen, 'no second session');
  // the landing page's same-origin request sends the cookie: the same session is resumed and renewed
  const landed = await d.get('/?entry=1', { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.equal(cookieOf(landed), cookie, 'the same session id');
  assert.deepEqual(d.folders(), seen);
  const info = JSON.parse((await d.get('/api/judge/session', { cookie })).text);
  assert.equal(info.replacedPrevious, false);
  // a request that DOES carry a valid cookie is never bounced, whatever its headers claim
  const claimed = await d.get('/', { ...CROSS, cookie });
  assert.match(claimed.text, /id="main"/);
  assert.equal(cookieOf(claimed), cookie);
});

test('only a cross-site top-level navigation is bounced: typed, same-origin, same-site, missing, malformed and non-navigation requests behave as before', async (t) => {
  const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const cases = [
    ['typed or bookmarked (none)', { 'sec-fetch-site': 'none', ...nav }],
    ['same-origin', { 'sec-fetch-site': 'same-origin', ...nav }],
    ['same-site', { 'sec-fetch-site': 'same-site', ...nav }],
    ['no Sec-Fetch headers at all (an older browser or a tool)', {}],
    ['a malformed value', { 'sec-fetch-site': 'banana', ...nav }],
    ['an empty value', { 'sec-fetch-site': '', ...nav }],
    ['cross-site but not a navigation (mode cors)', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
    ['cross-site image (not a document)', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
    ['cross-site frame (not a top-level document)', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }],
    ['cross-site with the mode missing', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' }],
  ];
  for (const [name, headers] of cases) {
    const d = await start(t);
    const r = await d.get('/', headers);
    assert.equal(r.status, 200, name);
    assert.match(r.text, /id="main"/, `${name}: the application page, not the landing page`);
    assert.match(r.setCookie ?? '', /^bp_judge=/, `${name}: a session, exactly as before`);
    assert.equal(d.folders().length, 1, name);
  }
});

test('the landing hop uses no session, slot or start rate, however many arrive; the rules that bound sessions still bound the marked request', async (t) => {
  const d = await start(t, { limits: { newPerMinute: 1, maxSessions: 1 } });
  for (let i = 0; i < 25; i++) {
    const r = await d.get('/', CROSS);
    assert.equal(r.status, 200);
    assert.equal(r.setCookie, null);
  }
  assert.equal(d.folders().length, 0);
  const one = await d.get('/?entry=1', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.match(one.setCookie ?? '', /^bp_judge=/);
  const two = await d.get('/?entry=1', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.equal(two.status, 429, 'the start rate still applies to real session starts');
  assert.match(two.text, /busy/i);
});

test('nothing else changed: other methods, a foreign Host, the API and cross-origin writes keep their answers', async (t) => {
  const d = await start(t);
  assert.equal((await d.get('/', CROSS, 'POST')).status, 405, 'POST / is still refused');
  const head = await d.get('/', CROSS, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.setCookie, null, 'HEAD never started a session');
  assert.equal(d.folders().length, 0);
  const foreign = await d.get('/', { ...CROSS, host: 'evil.example' });
  assert.equal(foreign.status, 403, 'a foreign Host is refused before anything else');
  assert.equal(foreign.setCookie, null);
  assert.equal((await d.get('/api/submissions', CROSS)).status, 401, 'the API still needs a live session');
  // a live session, and a write from another origin: refused, nothing changes
  const first = await d.get('/', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  const cookie = cookieOf(first);
  const list = JSON.parse((await d.get('/api/submissions', { cookie })).text).submissions.length;
  const hostile = await d.get('/api/judge/reset', { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, 'POST', '{}');
  assert.equal(hostile.status, 403);
  assert.equal(JSON.parse(hostile.text).error.code, 'bad_origin');
  const noOrigin = await d.get('/api/judge/reset', { cookie }, 'POST', '{}');
  assert.equal(noOrigin.status, 403, 'a write with no Origin is still refused');
  assert.equal(JSON.parse((await d.get('/api/submissions', { cookie })).text).submissions.length, list, 'the visitor\'s workspace is untouched');
});

test('the cookie is exactly as before: Secure, __Host-, HttpOnly, SameSite=Strict, Path=/ and no Domain', async (t) => {
  const d = await start(t, { secureCookie: true, allowedHosts: ['demo.example'] });
  const hop = await d.get('/', { ...CROSS, host: 'demo.example' });
  assert.equal(hop.setCookie, null);
  const landed = await d.get('/?entry=1', { host: 'demo.example', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  assert.match(landed.setCookie, /^__Host-bp_judge=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(landed.setCookie, /Domain=|SameSite=Lax|SameSite=None/);
});
