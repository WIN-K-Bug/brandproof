// m30 DIAGNOSTIC (not a test suite, nothing here asserts a fix): does "save, then reload at once" end a judge-demo session?
//
//   node scripts/browser/diag-private-reload.mjs            (all profiles, then the lifecycle and expiry experiments)
//   M30_ONLY=edge-private node scripts/browser/diag-private-reload.mjs
//   M30_SKIP_LIFECYCLE=1 ...   skip the restart and expiry experiments
//
// What it builds, all on this computer with fictional data in throwaway folders:
//   * the REAL server.js, started with the same environment settings as render.yaml (deployment start-up, judge demo, ephemeral root, Secure
//     __Host- cookie, the render limits), listening on 127.0.0.1 only;
//   * a small TLS reverse proxy in front of it (a throwaway self-signed certificate for brandproof-diag.test, trusted by the browser through its
//     SPKI hash, the name mapped to 127.0.0.1 by the browser's own host-resolver rule), which is what Render's edge is to the app: https outside,
//     http inside, the Host header kept. The proxy logs method, path, status, cookie NAMES and a 6-hex tag of the cookie's hash, the
//     attributes of any Set-Cookie (never its value), cache headers and Sec-Fetch-* headers. It never logs a raw cookie, a token, an address or a body.
//   * real headless browsers with their own empty profiles: Edge regular, Edge private (--inprivate), and, when installed, Brave regular and Brave private
//     (--incognito), each in its own process and temporary profile (the person's own browser windows are not touched).
// The browser's own network log (Network domain, including which cookies it blocked and why) is written beside the proxy's log, so one request can be
// followed from the page to the server and back. Output goes to M30_OUT (default handoffs/evidence/m30-data/).
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch } from './cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.M30_OUT || path.join(repo, 'handoffs', 'evidence', 'm30-data');
mkdirSync(OUT, { recursive: true });
const HOST = 'brandproof-diag.test';
const COOKIE = '__Host-bp_judge';
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(2);
const say = (...a) => console.log(`[${ts()}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 6);
const logTo = (name) => (o) => appendFileSync(path.join(OUT, name), JSON.stringify({ t: ts(), ...o }) + '\n');
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(250);
  }
  return null;
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

// ---------- redaction helpers: names and tags only ----------
function cookieSummary(header) {
  const names = [];
  const mine = [];
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const n = part.slice(0, eq).trim();
    names.push(n);
    if (n === COOKIE) mine.push(tag(part.slice(eq + 1).trim()));
  }
  return { names, mine };
}
function setCookieSummary(h) {
  const list = Array.isArray(h) ? h : h ? String(h).split('\n') : [];
  return list.map((s) => {
    const [nv, ...attrs] = s.split(';');
    const eq = nv.indexOf('=');
    return { name: nv.slice(0, eq).trim(), tag: tag(nv.slice(eq + 1).trim()), attrs: attrs.map((a) => a.trim()) };
  });
}

// ---------- throwaway certificate ----------
const OPENSSL = ['C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || existsSync(p));
const certDir = mkdtempSync(path.join(os.tmpdir(), 'bp-m30-cert-'));
const keyFile = path.join(certDir, 'k.pem');
const crtFile = path.join(certDir, 'c.pem');
execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', crtFile, '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'pipe' });
const pubkey = execFileSync(OPENSSL, ['x509', '-in', crtFile, '-pubkey', '-noout']);
const der = execFileSync(OPENSSL, ['pkey', '-pubin', '-outform', 'der'], { input: pubkey });
const SPKI = crypto.createHash('sha256').update(der).digest('base64');

// ---------- the real server.js, configured like render.yaml ----------
function startServer({ root, port, idle = 60, label }) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('BRANDPROOF_')) delete env[k];
  Object.assign(env, {
    PORT: String(port),
    BRANDPROOF_DEPLOY: '1',
    BRANDPROOF_HOST: '127.0.0.1', // render uses 0.0.0.0; this experiment stays on this computer
    BRANDPROOF_JUDGE_DEMO: '1',
    BRANDPROOF_JUDGE_ROOT: root,
    BRANDPROOF_JUDGE_EPHEMERAL: '1',
    BRANDPROOF_JUDGE_SECURE_COOKIE: '1',
    BRANDPROOF_ALLOWED_HOSTS: HOST,
    BRANDPROOF_SEMANTIC: 'off',
    BRANDPROOF_JUDGE_MAX_SESSIONS: '30',
    BRANDPROOF_JUDGE_MAX_LIVE: '5',
    BRANDPROOF_JUDGE_IDLE_MINUTES: String(idle),
    BRANDPROOF_JUDGE_MAX_HOURS: '6',
    BRANDPROOF_JUDGE_NEW_PER_MINUTE: '10',
    BRANDPROOF_JUDGE_SESSION_KIB: '2048',
    BRANDPROOF_JUDGE_IMAGE_KIB: '1024',
    BRANDPROOF_JUDGE_IMAGE_COUNT: '3',
    BRANDPROOF_JUDGE_MAX_CONNECTIONS: '100',
  });
  const proc = spawn(process.execPath, ['server.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = logTo(`server-process-${label}.jsonl`);
  let exited = null;
  proc.on('exit', (code, signal) => {
    exited = { code, signal };
    log({ stream: 'exit', code, signal });
  });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    for (const line of String(d).split(/\r?\n/).filter(Boolean)) log({ stream: 'stdout', line });
  });
  proc.stderr.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/).filter(Boolean)) log({ stream: 'stderr', line });
  });
  return {
    proc,
    pid: proc.pid,
    ready: async () => {
      const ok = await until(() => /listening on/.test(buf) || exited, 15000);
      if (!ok || exited) throw new Error(`server ${label} did not start: ${JSON.stringify(exited)} ${buf.slice(0, 300)}`);
    },
    stop: async () => {
      if (!exited) proc.kill();
      await until(() => exited, 5000);
    },
    exited: () => exited,
  };
}

// ---------- the TLS proxy (what Render's edge is to the app) ----------
function startProxy(getTarget) {
  const log = logTo('proxy-requests.jsonl');
  let n = 0;
  const srv = https.createServer({ key: readFileSync(keyFile), cert: readFileSync(crtFile) }, (req, res) => {
    const id = ++n;
    const t = Date.now();
    const cs = cookieSummary(req.headers.cookie);
    const base = {
      id,
      method: req.method,
      path: (req.url || '').split('?')[0],
      cookieNames: cs.names,
      cookieTags: cs.mine,
      ifNoneMatch: Boolean(req.headers['if-none-match']),
      reqCache: req.headers['cache-control'] || null,
      fetchSite: req.headers['sec-fetch-site'] || null,
      fetchMode: req.headers['sec-fetch-mode'] || null,
      fetchDest: req.headers['sec-fetch-dest'] || null,
      fetchUser: req.headers['sec-fetch-user'] || null,
      referer: req.headers.referer ? new URL(req.headers.referer).origin : null,
    };
    const up = http.request({ host: '127.0.0.1', port: getTarget(), method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
      ur.on('end', () => log({ ...base, status: ur.statusCode, resCache: ur.headers['cache-control'] || null, setCookie: setCookieSummary(ur.headers['set-cookie']), ms: Date.now() - t }));
    });
    up.on('error', (e) => {
      log({ ...base, status: 502, error: e.code || e.message });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

// ---------- browsers ----------
const BRAVE = [path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'), 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'].find((p) => existsSync(p));
const PROFILES = {
  'edge-regular': { exe: findBrowser(), args: [] },
  'edge-private': { exe: findBrowser(), args: ['--inprivate'] },
  'brave-regular': { exe: BRAVE, args: [] },
  'brave-private': { exe: BRAVE, args: ['--incognito'] },
};
let portSeed = 9470;

const stateExpr = `(async () => {
  const m = document.getElementById('main');
  let quota = null;
  try { quota = (await navigator.storage.estimate()).quota; } catch {}
  const text = (m?.innerText || '').replace(/\\s+/g, ' ');
  return { href: location.href, ready: document.readyState, banner: (document.getElementById('banner')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 170), ended: /demo session has ended/i.test(text), main: text.slice(0, 90), heading: document.querySelector('main h1')?.textContent || '', quota };
})()`;
const headExpr = `fetch('/api/submissions/SUB-1', { headers: { 'x-demo-role': 'creator' } }).then(async (r) => { const j = await r.json().catch(() => null); return { status: r.status, head: j?.headRevision ?? null, code: j?.error?.code ?? null }; })`;

/** One browser session against `base`; returns helpers that record everything the browser sees. */
async function openBrowser(name, base, startUrl) {
  const p = PROFILES[name];
  if (!p.exe) throw new Error(`${name}: browser not installed`);
  const log = logTo(`client-${name}.jsonl`);
  const b = await launch(startUrl, { port: portSeed++, exe: p.exe, args: [...p.args, `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${SPKI}`, '--no-first-run', '--no-default-browser-check'] });
  await b.send('Network.enable');
  const reqs = new Map();
  b.on((m, q) => {
    try {
      if (m === 'Network.requestWillBeSent') {
        const u = new URL(q.request.url);
        reqs.set(q.requestId, u.pathname);
        if (u.host.startsWith(HOST) || q.type === 'Document') log({ ev: 'request', rid: q.requestId, method: q.request.method, path: u.pathname, host: u.host === `${HOST}:${new URL(base).port}` ? 'app' : u.host, type: q.type, redirect: Boolean(q.redirectResponse) });
      } else if (m === 'Network.requestWillBeSentExtraInfo') {
        const cs = cookieSummary(q.headers?.Cookie ?? q.headers?.cookie);
        log({ ev: 'request-extra', rid: q.requestId, path: reqs.get(q.requestId), cookieNames: cs.names, cookieTags: cs.mine, blockedOnSend: (q.associatedCookies || []).filter((c) => c.blockedReasons?.length).map((c) => ({ name: c.cookie?.name, reasons: c.blockedReasons })), cacheControl: q.headers?.['Cache-Control'] ?? q.headers?.['cache-control'] ?? null });
      } else if (m === 'Network.responseReceived') {
        log({ ev: 'response', rid: q.requestId, path: reqs.get(q.requestId), status: q.response.status, type: q.type, fromDiskCache: q.response.fromDiskCache, fromServiceWorker: q.response.fromServiceWorker, protocol: q.response.protocol });
      } else if (m === 'Network.responseReceivedExtraInfo') {
        log({ ev: 'response-extra', rid: q.requestId, path: reqs.get(q.requestId), status: q.statusCode, setCookie: setCookieSummary(q.headers?.['set-cookie'] ?? q.headers?.['Set-Cookie']), blockedOnReceive: (q.blockedCookies || []).map((c) => ({ reasons: c.blockedReasons })) });
      } else if (m === 'Network.loadingFailed') {
        log({ ev: 'failed', rid: q.requestId, path: reqs.get(q.requestId), error: q.errorText, canceled: q.canceled });
      }
    } catch (e) {
      log({ ev: 'logger-error', message: e.message });
    }
  });
  const version = (await b.send('Browser.getVersion')).result?.product;
  const api = {
    b,
    version,
    mark: (label) => log({ ev: 'MARK', label }),
    async cookies(label) {
      const r = await b.send('Network.getCookies', { urls: [base] });
      const c = (r.result?.cookies || []).map((x) => ({ name: x.name, tag: tag(x.value), secure: x.secure, httpOnly: x.httpOnly, sameSite: x.sameSite, path: x.path, domain: x.domain, session: x.session, expiresInSec: x.session ? null : Math.round(x.expires - Date.now() / 1000) }));
      log({ ev: 'cookies', label, cookies: c });
      return c;
    },
    async state(label) {
      const s = await until(() => b.eval(stateExpr), 5000);
      log({ ev: 'state', label, ...s });
      return s;
    },
    async head() {
      return b.eval(headExpr).catch((e) => ({ error: e.message }));
    },
    async reload(ignoreCache = false) {
      await b.send('Page.reload', { ignoreCache });
    },
    async navigate(url) {
      await b.send('Page.navigate', { url });
    },
    /** Wait until the app has drawn something (banner text or the ended card) or `ms` passed. */
    async settled(ms = 9000) {
      await until(() => b.eval(`document.readyState === 'complete' && ((document.getElementById('banner')?.innerText || '').length > 0 || /demo session has ended/i.test(document.getElementById('main')?.innerText || ''))`), ms);
      await sleep(400);
    },
  };
  return api;
}

const summary = [];
const row = (profile, step, s, c, h) => {
  const cookie = c?.find((x) => x.name === COOKIE);
  const line = { profile, step, ended: s?.ended ?? null, replaced: /earlier session had ended/.test(s?.banner ?? ''), banner: (s?.banner ?? '').slice(0, 70), heading: s?.heading ?? '', cookie: cookie ? { tag: cookie.tag, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, expiresInSec: cookie.expiresInSec } : null, head: h ?? null, quota: s?.quota ?? null };
  summary.push(line);
  say(`STEP ${profile} | ${step} | ended=${line.ended} replaced=${line.replaced} cookie=${cookie?.tag ?? 'none'} head=${h ? `${h.status}/${h.head ?? h.code}` : '-'} heading="${line.heading}"`);
  return line;
};

let editN = 0;
/** Open SUB-1 (the seeded sample), add a marker to its copy, save, and return how long the save took and whether the page said it was saved. */
async function editAndSave(br, { immediateReload = false } = {}) {
  const { b } = br;
  await b.eval(`location.hash = '#/workspace/SUB-1'`);
  await sleep(1000);
  await b.click('Edit as new revision');
  const cur = await b.eval(`document.getElementById('draft-text').value`);
  editN++;
  await b.type('#draft-text', cur.replace(/\s*\(m30 edit \d+\)$/, '') + ` (m30 edit ${editN})`);
  await b.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
  const t = Date.now();
  if (immediateReload) {
    // press Save and reload in the same tick: the save is still in flight when the page goes away
    await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Save as revision'))?.click()`);
    await br.reload();
    return { ms: Date.now() - t, saved: null };
  }
  await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Save as revision'))?.click()`);
  const saved = await until(() => b.eval(`[...document.querySelectorAll('.toast')].some((x) => /Saved revision/.test(x.textContent))`), 8000);
  return { ms: Date.now() - t, saved: Boolean(saved) };
}

async function runProfile(name) {
  say(`=== profile ${name} ===`);
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'bp-m30-root-')), 'judge');
  const port = await freePort();
  const srv = startServer({ root, port, label: name });
  const proxy = await startProxy(() => port);
  let br;
  try {
    await srv.ready();
    const base = `https://${HOST}:${proxy.port}`;
    br = await openBrowser(name, base, `${base}/`);
    say(`browser ${br.version}`);
    await br.settled();
    let s = await br.state('A load');
    let c = await br.cookies('A load');
    row(name, 'A first load', s, c, await br.head());

    br.mark('B save then reload');
    const sv = await editAndSave(br);
    say(`save: page said saved=${sv.saved} after ${sv.ms} ms`);
    let h0 = await br.head();
    br.mark('B reload immediately after the saved toast');
    await br.reload();
    await br.settled();
    s = await br.state('B after reload');
    c = await br.cookies('B after reload');
    row(name, 'B save -> reload at once', s, c, await br.head());

    br.mark('C second reload');
    await br.reload();
    await br.settled();
    row(name, 'C reload again', await br.state('C'), await br.cookies('C'), await br.head());

    br.mark('D hard reload');
    await br.reload(true);
    await br.settled();
    row(name, 'D hard reload (cache ignored)', await br.state('D'), await br.cookies('D'), await br.head());

    // E: save, then press Enter in the address bar on the same address (a new navigation, not a reload)
    br.mark('E save then navigate to the same address');
    await editAndSave(br);
    await br.navigate(`${base}/`);
    await br.settled();
    row(name, 'E save -> address-bar load of /', await br.state('E'), await br.cookies('E'), await br.head());

    // F: deep link (the hash route), then save, then reload
    br.mark('F deep link');
    await br.navigate('about:blank');
    await sleep(300);
    await br.navigate(`${base}/#/workspace/SUB-1`);
    await br.settled();
    row(name, 'F deep link /#/workspace/SUB-1', await br.state('F1'), await br.cookies('F1'), await br.head());
    await editAndSave(br);
    await br.reload();
    await br.settled();
    row(name, 'F deep link: save -> reload', await br.state('F2'), await br.cookies('F2'), await br.head());

    // G: a deep link as a PATH (what a person might paste); not a route this server has
    br.mark('G path deep link');
    await br.navigate(`${base}/workspace/SUB-1`);
    await sleep(900);
    const g = await br.b.eval(`document.body.innerText.slice(0, 120).replace(/\\s+/g, ' ')`);
    say(`G /workspace/SUB-1 shows: ${g}`);
    summary.push({ profile: name, step: 'G path deep link /workspace/SUB-1', shows: g });

    // H: arrive from ANOTHER site by a real click (the first navigation is cross-site), then save, then reload
    br.mark('H cross-site arrival');
    const other = http.createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(`<!doctype html><title>other site</title><a id="go" href="${base}/#/workspace/SUB-1" style="display:block;padding:40px">open the app</a>`);
    });
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    await br.navigate(`http://127.0.0.1:${other.address().port}/`);
    await sleep(900);
    const pos = await br.b.eval(`(() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + 12, y: r.y + 12 }; })()`);
    await br.b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
    await br.b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await br.b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(1200);
    await br.settled();
    other.close();
    row(name, 'H arrived by clicking a link on another site', await br.state('H1'), await br.cookies('H1'), await br.head());
    await editAndSave(br);
    await br.reload();
    await br.settled();
    row(name, 'H cross-site arrival: save -> reload', await br.state('H2'), await br.cookies('H2'), await br.head());

    // I: press Save and reload in the same tick (save in flight when the page leaves)
    br.mark('I reload with the save in flight');
    await br.navigate(`${base}/`);
    await br.settled();
    const before = await br.head();
    await editAndSave(br, { immediateReload: true });
    await br.settled();
    await sleep(800);
    const after = await br.head();
    row(name, `I save in flight, reload (head ${before?.head} -> ${after?.head})`, await br.state('I'), await br.cookies('I'), after);

    // Lifecycle experiments run once, in the regular Edge profile only (they do not depend on the browser).
    if (name === 'edge-regular' && !process.env.M30_SKIP_LIFECYCLE) {
      br.mark('F1 server restarted with the same folder');
      await br.navigate(`${base}/`);
      await br.settled();
      await srv.stop();
      say('server stopped (hard); starting a new process on the SAME root and port');
      const again = startServer({ root, port, label: `${name}-restart-same-root` });
      try {
        await again.ready();
        await br.reload();
        await br.settled();
        row(name, 'L1 restart, same root: reload', await br.state('L1'), await br.cookies('L1'), await br.head());
      } catch (e) {
        say(`L1 restart with the same root did not start: ${e.message}`);
        summary.push({ profile: name, step: 'L1 restart, same root', error: e.message });
      }
      await again.stop();
      const root2 = path.join(mkdtempSync(path.join(os.tmpdir(), 'bp-m30-root-')), 'judge');
      br.mark('L2 server restarted with an EMPTY folder (what a free-tier sleep does)');
      const fresh = startServer({ root: root2, port, label: `${name}-restart-empty-root` });
      await fresh.ready();
      // a page that is already open, with its old cookie: its next request
      await br.b.eval(`location.hash = '#/workspace'`);
      await sleep(300);
      await br.b.eval(`location.hash = '#/workspace/SUB-1'`);
      await sleep(1200);
      row(name, 'L2 empty-root restart: the open page makes a request', await br.state('L2a'), await br.cookies('L2a'), null);
      await br.reload();
      await br.settled();
      row(name, 'L2 empty-root restart: then reload', await br.state('L2b'), await br.cookies('L2b'), await br.head());
      await fresh.stop();
    }
  } finally {
    try {
      await br?.b.close();
    } catch {}
    proxy.srv.close();
    proxy.srv.closeAllConnections?.();
    await srv.stop().catch(() => {});
  }
}

/** Idle expiry, with the minimum idle limit (1 minute): reload while valid, then after the idle limit. Once, regular Edge. */
async function runExpiry() {
  const name = 'edge-regular';
  say('=== expiry experiment (idle limit 1 minute) ===');
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'bp-m30-root-')), 'judge');
  const port = await freePort();
  const srv = startServer({ root, port, idle: 1, label: 'expiry' });
  const proxy = await startProxy(() => port);
  let br;
  try {
    await srv.ready();
    const base = `https://${HOST}:${proxy.port}`;
    br = await openBrowser(name, base, `${base}/`);
    await br.settled();
    row('expiry', 'first load', await br.state('x1'), await br.cookies('x1'), await br.head());
    await sleep(30000);
    br.mark('reload after 30 s idle (still valid)');
    await br.reload();
    await br.settled();
    row('expiry', 'reload after 30 s idle', await br.state('x2'), await br.cookies('x2'), await br.head());
    await sleep(75000);
    br.mark('reload after 75 s idle (expired)');
    await br.reload();
    await br.settled();
    row('expiry', 'reload after 75 s idle', await br.state('x3'), await br.cookies('x3'), await br.head());
  } finally {
    try {
      await br?.b.close();
    } catch {}
    proxy.srv.close();
    proxy.srv.closeAllConnections?.();
    await srv.stop().catch(() => {});
  }
}

const wanted = process.env.M30_ONLY ? [process.env.M30_ONLY] : Object.keys(PROFILES);
say(`node ${process.version}; openssl ${OPENSSL}; out ${OUT}; brave ${BRAVE ? 'found' : 'not found'}`);
for (const name of wanted) {
  try {
    await runProfile(name);
  } catch (e) {
    say(`PROFILE ${name} FAILED: ${e.stack || e.message}`);
    summary.push({ profile: name, step: 'profile failed', error: e.message });
  }
}
if (!process.env.M30_ONLY && !process.env.M30_SKIP_LIFECYCLE) {
  try {
    await runExpiry();
  } catch (e) {
    say(`EXPIRY FAILED: ${e.stack || e.message}`);
    summary.push({ profile: 'expiry', step: 'failed', error: e.message });
  }
}
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
say(`done; ${summary.length} rows in summary.json`);
process.exit(0);
