// A real-HTTPS judge server for browser tests (m31). Everything is local and disposable:
//   * the REAL server.js, started with render.yaml's environment (deployment start-up, judge demo, ephemeral root, Secure __Host- cookie,
//     the free-tier limits, a listed host name), on 127.0.0.1 only;
//   * a small TLS reverse proxy in front of it, which is what Render's edge is to the app (https outside, http inside, Host kept);
//   * a throwaway self-signed certificate made at run time in the OS temp folder (never in the repository, never packaged), trusted by the
//     browser through its SPKI hash; the host name is mapped to 127.0.0.1 by the browser's own resolver rule, so there is no DNS.
// The proxy keeps a log of what crossed it (method, path, status, the Sec-Fetch-* headers, cookie NAMES and a 6-hex tag of each cookie's hash,
// Set-Cookie attributes): never a cookie value, token, address or request body.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOST = 'brandproof-diag.test';
export const COOKIE = '__Host-bp_judge';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tag = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 6);
export const until = async (fn, ms = 8000) => {
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
export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });

export function cookieSummary(header) {
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
export function setCookieSummary(h) {
  const list = Array.isArray(h) ? h : h ? String(h).split('\n') : [];
  return list.map((s) => {
    const [nv, ...attrs] = s.split(';');
    const eq = nv.indexOf('=');
    return { name: nv.slice(0, eq).trim(), tag: tag(nv.slice(eq + 1).trim()), attrs: attrs.map((a) => a.trim()) };
  });
}

const OPENSSL = ['C:/Program Files/Git/mingw64/bin/openssl.exe', 'C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'].find((p) => p === 'openssl' || existsSync(p));

/** A throwaway certificate for HOST. Returns the PEM text and the SPKI hash a browser can be told to trust. The files live in a temp folder that `dispose` removes. */
export function makeCert() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bp-tls-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST}`], { stdio: 'pipe' });
  const pub = execFileSync(OPENSSL, ['x509', '-in', crt, '-pubkey', '-noout']);
  const der = execFileSync(OPENSSL, ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const out = { key: readFileSync(key), cert: readFileSync(crt), spki: crypto.createHash('sha256').update(der).digest('base64'), dispose: () => rmSync(dir, { recursive: true, force: true }) };
  out.dispose(); // the PEM text is held in memory; nothing stays on disk
  return out;
}

export function startServerProcess({ root, port, idle = 60 }) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('BRANDPROOF_')) delete env[k];
  Object.assign(env, {
    PORT: String(port),
    BRANDPROOF_DEPLOY: '1',
    BRANDPROOF_HOST: '127.0.0.1',
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
  let exited = null;
  let out = '';
  let err = '';
  proc.on('exit', (code, signal) => (exited = { code, signal }));
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  return {
    proc,
    out: () => out,
    err: () => err,
    ready: async () => {
      const ok = await until(() => /listening on/.test(out) || exited, 15000);
      if (!ok || exited) throw new Error(`server did not start: ${JSON.stringify(exited)} ${out.slice(0, 300)} ${err.slice(0, 300)}`);
    },
    stop: async () => {
      if (!exited) proc.kill();
      await until(() => exited, 5000);
    },
  };
}

/** The whole rig: certificate, proxy, server. `restartEmpty()` replaces the server process with one on an EMPTY folder (what a free-tier sleep does). */
export async function startTlsDemo({ idle = 60, logFile = null } = {}) {
  const cert = makeCert();
  const mkRoot = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'bp-tls-root-')), 'judge');
  const port = await freePort();
  let server = startServerProcess({ root: mkRoot(), port, idle });
  const log = [];
  let n = 0;
  const t0 = Date.now();
  const proxy = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const id = ++n;
    const cs = cookieSummary(req.headers.cookie);
    const entry = {
      id,
      t: Date.now() - t0,
      method: req.method,
      path: (req.url || '').split('?')[0],
      query: (req.url || '').includes('?') ? (req.url || '').split('?').slice(1).join('?') : '',
      cookieNames: cs.names,
      cookieTags: cs.mine,
      fetchSite: req.headers['sec-fetch-site'] || null,
      fetchMode: req.headers['sec-fetch-mode'] || null,
      fetchDest: req.headers['sec-fetch-dest'] || null,
      origin: req.headers.origin || null,
    };
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
      ur.on('end', () => {
        Object.assign(entry, { status: ur.statusCode, setCookie: setCookieSummary(ur.headers['set-cookie']), cache: ur.headers['cache-control'] || null });
        log.push(entry);
        if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n');
      });
    });
    up.on('error', (e) => {
      Object.assign(entry, { status: 502, error: e.code || e.message, setCookie: [] });
      log.push(entry);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  await server.ready();
  const base = `https://${HOST}:${proxy.address().port}`;
  return {
    base,
    log,
    spki: cert.spki,
    serverOutput: () => ({ stdout: server.out(), stderr: server.err() }),
    restartEmpty: async () => {
      await server.stop();
      server = startServerProcess({ root: mkRoot(), port, idle });
      await server.ready();
    },
    stop: async () => {
      proxy.close();
      proxy.closeAllConnections?.();
      await server.stop();
    },
  };
}

const BRAVE = [path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'), 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'].find((p) => existsSync(p));
export const PROFILES = {
  'edge-regular': { exe: findBrowser(), args: [] },
  'edge-private': { exe: findBrowser(), args: ['--inprivate'] },
  'brave-regular': { exe: BRAVE, args: [] },
  'brave-private': { exe: BRAVE, args: ['--incognito'] },
};
/** launch() options for a browser that trusts the rig's certificate and resolves its host name locally. */
export const browserOptions = (profileName, spki, port) => {
  const p = PROFILES[profileName];
  if (!p?.exe) throw new Error(`browser profile ${profileName} is not available on this computer`);
  return { port, exe: p.exe, args: [...p.args, `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${spki}`, '--no-first-run', '--no-default-browser-check'] };
};
