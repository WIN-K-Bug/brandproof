/**
 * Start-up configuration for server.js: where to listen, which host names to answer to, which files to use.
 *
 * Two start-up styles, chosen only by the environment:
 *
 *  - LOCAL (the default; nothing set): listen on 127.0.0.1, prefer PORT (else 4173) and try the next 19 ports if one is busy,
 *    so a stale server never blocks a demo. This is exactly how `npm start` has always behaved.
 *  - DEPLOYMENT (opt-in, BRANDPROOF_DEPLOY=1): listen on the configured host (default 0.0.0.0, every interface) on EXACTLY the
 *    assigned PORT. If that port is not available the start fails with a clear message; it never tries another port, because a
 *    hosting platform routes to the one port it assigned. It needs BRANDPROOF_DATA (the writable data file on a persistent
 *    volume) and never falls back to this project's own data folder. Authenticated mode is not offered in this style.
 *
 * resolveStartup() is pure (environment in, plain object or StartupError out) so every rule here can be tested without a process.
 */
import net from 'node:net';
import path from 'node:path';
import { JUDGE_LIMITS } from './judge.js';

export const LOCAL_HOST = '127.0.0.1';
export const DEPLOY_DEFAULT_HOST = '0.0.0.0';
export const LOCAL_DEFAULT_PORT = 4173;
export const LOCAL_PORT_TRIES = 20;

/** A configuration problem or a failed start. `message` is the complete line to show the person starting the server. */
export class StartupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StartupError';
  }
}

const fail = (problem) => new StartupError(`Could not start: ${problem}`);

/** True for an address that only this computer can reach. 0.0.0.0 and :: are NOT loopback (they mean every interface). */
export function isLoopbackAddress(host) {
  if (net.isIPv4(host)) return host.startsWith('127.');
  return host === '::1';
}

function parseBool(name, raw) {
  if (raw === undefined || raw === '') return false;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw fail(`${name} must be 1 or 0 (it is "${raw}").`);
}

function parseHost(raw) {
  const value = String(raw).trim().replace(/^\[(.*)\]$/, '$1');
  if (!net.isIP(value)) {
    throw fail(`BRANDPROOF_HOST must be an IP address such as 127.0.0.1 (this computer only), 0.0.0.0 (every IPv4 interface) or :: (every interface); "${raw}" is not one. Host names are not accepted here, because a name can resolve to different addresses.`);
  }
  return value;
}

function parsePort(raw) {
  if (raw === undefined || raw === '') {
    throw fail('deployment start-up needs the assigned PORT, and PORT is not set. It never picks a port by itself.');
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw fail(`PORT must be a whole number from 1 to 65535 (it is "${raw}").`);
  }
  return Number(raw);
}

const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function parseAllowedHosts(raw, deploy) {
  const items = String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.includes('*')) {
    if (items.length > 1) throw fail('BRANDPROOF_ALLOWED_HOSTS: "*" must stand alone (it already means every host name).');
    if (!deploy) throw fail('BRANDPROOF_ALLOWED_HOSTS=* is only accepted with BRANDPROOF_DEPLOY=1. Locally, list the host names you want to answer to, or leave it unset to answer to localhost only.');
    return '*';
  }
  for (const item of items) {
    if (!HOST_NAME.test(item)) {
      throw fail(`BRANDPROOF_ALLOWED_HOSTS: "${item}" is not a plain host name or IPv4 address. Give host names only, separated by commas, without a scheme, port or path (for example judge.example.com).`);
    }
  }
  return [...new Set(items)];
}

/** The judge demo's limit settings: one environment variable per limit, each a whole number inside the range judge.js defines. */
const JUDGE_ENV = {
  maxSessions: 'BRANDPROOF_JUDGE_MAX_SESSIONS',
  maxLive: 'BRANDPROOF_JUDGE_MAX_LIVE',
  idleMinutes: 'BRANDPROOF_JUDGE_IDLE_MINUTES',
  maxHours: 'BRANDPROOF_JUDGE_MAX_HOURS',
  newPerMinute: 'BRANDPROOF_JUDGE_NEW_PER_MINUTE',
  sessionKiB: 'BRANDPROOF_JUDGE_SESSION_KIB',
  imageKiB: 'BRANDPROOF_JUDGE_IMAGE_KIB',
  imageCount: 'BRANDPROOF_JUDGE_IMAGE_COUNT',
  maxConnections: 'BRANDPROOF_JUDGE_MAX_CONNECTIONS',
};

function parseJudge(env) {
  const on = parseBool('BRANDPROOF_JUDGE_DEMO', env.BRANDPROOF_JUDGE_DEMO);
  const others = ['BRANDPROOF_JUDGE_ROOT', 'BRANDPROOF_JUDGE_SECURE_COOKIE', 'BRANDPROOF_JUDGE_EPHEMERAL', ...Object.values(JUDGE_ENV)].filter((k) => env[k] !== undefined && env[k] !== '');
  if (!on) {
    if (others.length) throw fail(`${others[0]} is set but the judge demo is not switched on. Set BRANDPROOF_JUDGE_DEMO=1 to use it, or remove the setting.`);
    return null;
  }
  if (!env.BRANDPROOF_JUDGE_ROOT) {
    throw fail('the judge demo needs BRANDPROOF_JUDGE_ROOT, a dedicated folder it may create and fill with disposable fictional sessions. It will not use any folder that already holds anything else.');
  }
  if (env.BRANDPROOF_DATA) {
    throw fail('BRANDPROOF_DATA is not used by the judge demo (every visitor gets a separate workspace inside BRANDPROOF_JUDGE_ROOT). Remove BRANDPROOF_DATA so no real workspace file is in play.');
  }
  const limits = {};
  for (const [key, name] of Object.entries(JUDGE_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const spec = JUDGE_LIMITS[key];
    if (!/^\d+$/.test(raw) || Number(raw) < spec.min || Number(raw) > spec.max) {
      throw fail(`${name} must be a whole number from ${spec.min} to ${spec.max} (${spec.what}); it is "${raw}".`);
    }
    limits[key] = Number(raw);
  }
  return { root: path.resolve(env.BRANDPROOF_JUDGE_ROOT), limits, secureCookie: parseBool('BRANDPROOF_JUDGE_SECURE_COOKIE', env.BRANDPROOF_JUDGE_SECURE_COOKIE), ephemeral: parseBool('BRANDPROOF_JUDGE_EPHEMERAL', env.BRANDPROOF_JUDGE_EPHEMERAL) };
}

/**
 * Environment -> start-up settings. Throws StartupError (its message is the whole line to print) for anything unusable.
 * Local style keeps the long-standing behaviour, including treating an unusable PORT as "use 4173".
 */
export function resolveStartup(env, { root }) {
  const authed = env.BRANDPROOF_MODE === 'authenticated';
  const mode = authed ? 'authenticated' : 'demo';
  const deploy = parseBool('BRANDPROOF_DEPLOY', env.BRANDPROOF_DEPLOY);
  const judge = parseJudge(env);
  if (judge?.secureCookie && !String(env.BRANDPROOF_ALLOWED_HOSTS ?? '').trim()) {
    throw fail('BRANDPROOF_JUDGE_SECURE_COOKIE=1 is for a public https address, which must be listed in BRANDPROOF_ALLOWED_HOSTS (a Secure cookie with a localhost-only server would look healthy but refuse every visitor). Set BRANDPROOF_ALLOWED_HOSTS to the exact public host name.');
  }
  if (judge && authed) throw fail('the judge demo is demo mode with isolated fictional sessions; it cannot be combined with authenticated mode (BRANDPROOF_MODE=authenticated).');
  const hostSet = env.BRANDPROOF_HOST !== undefined && env.BRANDPROOF_HOST !== '';
  const host = hostSet ? parseHost(env.BRANDPROOF_HOST) : deploy ? DEPLOY_DEFAULT_HOST : LOCAL_HOST;
  const allowedHosts = parseAllowedHosts(env.BRANDPROOF_ALLOWED_HOSTS, deploy);
  const exposed = deploy || !isLoopbackAddress(host) || allowedHosts === '*' || allowedHosts.length > 0;

  if (authed && exposed) {
    throw fail('authenticated mode is local sign-in over plain HTTP with sessions kept in memory, and is not offered for a deployment, another host or extra host names (BRANDPROOF_DEPLOY, BRANDPROOF_HOST, BRANDPROOF_ALLOWED_HOSTS). Use demo mode for those, or run authenticated mode locally on 127.0.0.1.');
  }

  let dataFile;
  if (judge) {
    dataFile = null; // each visitor's workspace lives inside the judge root; there is no single workspace file
  } else if (deploy) {
    if (!env.BRANDPROOF_DATA) {
      throw fail('deployment start-up needs BRANDPROOF_DATA, the full path of the workspace file on a writable (ideally persistent) volume. It never falls back to the project\'s own data folder, so real data cannot be opened by accident.');
    }
    dataFile = path.resolve(env.BRANDPROOF_DATA);
  } else {
    dataFile = env.BRANDPROOF_DATA || path.join(root, 'data', authed ? 'auth-workspace.json' : 'brandproof.json');
  }
  const authFile = authed ? env.BRANDPROOF_AUTH_FILE || path.join(root, 'data', 'auth', 'users.json') : undefined;

  const preferredPort = deploy ? parsePort(env.PORT) : Number(env.PORT) || LOCAL_DEFAULT_PORT;
  return { mode, authed, deploy, judge, host, preferredPort, strictPort: deploy, portTries: deploy ? 1 : LOCAL_PORT_TRIES, allowedHosts, dataFile, authFile };
}

/**
 * Listen according to the policy: strict (exactly this port, or fail) or local (this port, then the next ones while it is busy).
 * Resolves to the URL. Rejects with a StartupError; the caller releases the workspace.
 */
export async function listenWithPolicy(app, { host, preferredPort, strictPort, portTries }) {
  const last = preferredPort + portTries - 1;
  for (let p = preferredPort; p <= last; p++) {
    try {
      return await app.listen(p, host);
    } catch (e) {
      if (e.code === 'EADDRINUSE' && !strictPort && p < last) continue;
      if (strictPort) {
        const hint =
          e.code === 'EADDRINUSE'
            ? 'it is already in use. Deployment start-up uses exactly the assigned PORT and never tries another one; stop whatever holds it, or give this process the port the platform assigned.'
            : e.code === 'EADDRNOTAVAIL'
              ? 'that address does not belong to this computer. Check BRANDPROOF_HOST.'
              : e.code === 'EACCES'
                ? 'this account may not listen on that port.'
                : e.message;
        throw new StartupError(`Could not start server: port ${p} on ${host} cannot be used: ${hint}`);
      }
      throw new StartupError(`Could not start server: ${e.message}`);
    }
  }
  throw new StartupError('Could not start server: no port to try.');
}

/**
 * The whole start-up: settings, workspace, then listening. Returns { app, config, url }.
 * Any failure after the workspace was opened releases it before throwing. `log` receives the start-up lines.
 */
export async function startServer({ env, root, createApp, createJudgeDemo, log = () => {} }) {
  let config;
  try {
    config = resolveStartup(env, { root });
  } catch (e) {
    if (e instanceof StartupError) throw e;
    throw fail(e.message);
  }
  const { authed, deploy, judge, dataFile, authFile, allowedHosts } = config;
  let app;
  try {
    app = judge ? await createJudgeDemo({ root: judge.root, allowedHosts, limits: judge.limits, secureCookie: judge.secureCookie, ephemeral: judge.ephemeral }) : await createApp({ dataFile, mode: config.mode, authFile, allowedHosts });
  } catch (e) {
    throw fail(e.message);
  }
  let url;
  try {
    url = await listenWithPolicy(app, config);
  } catch (e) {
    await app.close(); // release the workspace before reporting the failure
    throw e;
  }
  if (judge) {
    const l = app.limits;
    log(`BrandProof judge demo (isolated fictional sessions) listening on ${url}`);
    log(`Judge root: ${judge.root}`);
    log(`Each visitor gets a private fictional workspace chosen by a server-issued cookie, with no sign-in (roles are a simulation). Up to ${l.maxSessions} sessions (${l.maxLive} open at once), ${l.idleMinutes} min idle or ${l.maxHours} h absolute expiry, ${Math.round(l.sessionKiB / 1024 * 10) / 10} MB per session.${judge.ephemeral ? ' Temporary storage: sessions are lost when the service restarts or sleeps.' : ''}`);
  } else {
    log(`BrandProof (${authed ? 'authenticated workspace' : 'demo mode'}) listening on ${url}`);
    log(`Workspace file: ${dataFile}`);
  }
  if (authed) {
    log(`Credential file: ${authFile}`);
    if (!app.auth.userCount()) log('No users yet. Stop the server and run `npm run auth:setup` to create the owner account.');
    log('Local sign-in only: plain HTTP on 127.0.0.1, sessions are kept in memory (a restart signs everyone out).');
  }
  if (deploy) {
    const names = allowedHosts === '*' ? 'any host name (BRANDPROOF_ALLOWED_HOSTS=*)' : allowedHosts.length ? allowedHosts.join(', ') + ' (and localhost)' : 'localhost only (set BRANDPROOF_ALLOWED_HOSTS to the public host name)';
    log(`Deployment start-up: host ${config.host}, assigned port ${config.preferredPort} (strict, no fallback). Answers to Host names: ${names}.`);
    log(judge ? 'One process per judge root; roles are a demo switch, not sign-in; all data is fictional.' : `Image files are kept beside the workspace file in ${dataFile}.assets. One process per workspace file; roles are a demo switch, not sign-in; all data is fictional.`);
  }
  return { app, config, url };
}
