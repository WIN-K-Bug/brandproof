// Start-up configuration: the local default is unchanged, the deployment style is opt-in and strict, and every unusable setting
// is refused with a message that says what to change. resolveStartup() is pure; the listen policy is checked against real sockets.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { resolveStartup, listenWithPolicy, StartupError, isLoopbackAddress } from '../src/startup.js';
import { tempDir } from './helpers.js';

// Every test here has a bound: one that stops making progress fails BY NAME after 30 s instead of silently stalling the whole run.
const test = (name, fn) => baseTest(name, { timeout: 30_000 }, fn);

const root = path.resolve('/brandproof-root');
const resolve = (env) => resolveStartup(env, { root });
const refused = (env, pattern) => assert.throws(() => resolve(env), (e) => e instanceof StartupError && pattern.test(e.message) && /^Could not start: /.test(e.message), JSON.stringify(env));
const DEPLOY = { BRANDPROOF_DEPLOY: '1', PORT: '8080', BRANDPROOF_DATA: path.join(path.resolve('/vol'), 'bp.json') };

test('local default: loopback, port 4173 with 19 retries, the project data file, no extra host names', () => {
  const c = resolve({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.preferredPort, 4173);
  assert.equal(c.strictPort, false);
  assert.equal(c.portTries, 20);
  assert.deepEqual(c.allowedHosts, []);
  assert.equal(c.deploy, false);
  assert.equal(c.mode, 'demo');
  assert.equal(c.dataFile, path.join(root, 'data', 'brandproof.json'));
  assert.equal(c.authFile, undefined);
});

test('local PORT behaves as before: a number is the preferred port, anything unusable means 4173', () => {
  assert.equal(resolve({ PORT: '5055' }).preferredPort, 5055);
  for (const odd of ['abc', '', '0']) assert.equal(resolve({ PORT: odd }).preferredPort, 4173, odd);
  assert.equal(resolve({ PORT: '5055' }).strictPort, false);
});

test('local authenticated mode keeps its own files and stays on loopback', () => {
  const c = resolve({ BRANDPROOF_MODE: 'authenticated' });
  assert.equal(c.authed, true);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.dataFile, path.join(root, 'data', 'auth-workspace.json'));
  assert.equal(c.authFile, path.join(root, 'data', 'auth', 'users.json'));
  assert.equal(resolve({ BRANDPROOF_MODE: 'authenticated', BRANDPROOF_DATA: 'x.json', BRANDPROOF_AUTH_FILE: 'u.json' }).dataFile, 'x.json');
});

test('BRANDPROOF_HOST is honoured, but only as an IP address; loopback stays the default without it', () => {
  assert.equal(resolve({ BRANDPROOF_HOST: '127.0.0.2' }).host, '127.0.0.2');
  assert.equal(resolve({ BRANDPROOF_HOST: '::1' }).host, '::1');
  assert.equal(resolve({ BRANDPROOF_HOST: '[::]' }).host, '::');
  assert.equal(resolve({ BRANDPROOF_HOST: ' 0.0.0.0 ' }).host, '0.0.0.0');
  assert.equal(resolve({ BRANDPROOF_HOST: '' }).host, '127.0.0.1');
  for (const bad of ['localhost', 'example.com', '0.0.0.0/0', '127.0.0', '999.1.1.1', 'http://127.0.0.1']) refused({ BRANDPROOF_HOST: bad }, /BRANDPROOF_HOST must be an IP address/);
  // setting a host does not by itself turn on the strict deployment rules
  const c = resolve({ BRANDPROOF_HOST: '0.0.0.0', PORT: '5055' });
  assert.equal(c.deploy, false);
  assert.equal(c.strictPort, false);
});

test('which addresses count as loopback: only the local ones, never 0.0.0.0 or ::', () => {
  for (const ok of ['127.0.0.1', '127.9.9.9', '::1']) assert.equal(isLoopbackAddress(ok), true, ok);
  for (const no of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', '8.8.8.8']) assert.equal(isLoopbackAddress(no), false, no);
});

test('deployment start-up is opt-in: strict port, every-interface default, an explicit data file', () => {
  const c = resolve(DEPLOY);
  assert.equal(c.deploy, true);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.preferredPort, 8080);
  assert.equal(c.strictPort, true);
  assert.equal(c.portTries, 1);
  assert.equal(c.dataFile, DEPLOY.BRANDPROOF_DATA);
  assert.equal(resolve({ ...DEPLOY, BRANDPROOF_HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(resolve({ ...DEPLOY, BRANDPROOF_DEPLOY: 'true' }).deploy, true);
  assert.equal(resolve({ ...DEPLOY, BRANDPROOF_DEPLOY: '0' }).deploy, false);
});

test('deployment start-up refuses to guess: no PORT, a bad PORT, no data file, or a vague switch all fail clearly', () => {
  const { PORT, ...noPort } = DEPLOY;
  refused(noPort, /needs the assigned PORT, and PORT is not set/);
  refused({ ...DEPLOY, PORT: '' }, /needs the assigned PORT/);
  for (const bad of ['0', '65536', '-1', '80a', '8080.5', ' 8080', 'abc']) refused({ ...DEPLOY, PORT: bad }, /PORT must be a whole number from 1 to 65535/);
  const { BRANDPROOF_DATA, ...noData } = DEPLOY;
  refused(noData, /needs BRANDPROOF_DATA.*never falls back to the project's own data folder/);
  refused({ ...DEPLOY, BRANDPROOF_DEPLOY: 'yes' }, /BRANDPROOF_DEPLOY must be 1 or 0/);
});

test('extra host names: a plain list is normalised; "*" is for deployments only; anything else is refused', () => {
  assert.deepEqual(resolve({ BRANDPROOF_ALLOWED_HOSTS: ' Judge.Example.com ,judge.example.com, 203.0.113.7 ,' }).allowedHosts, ['judge.example.com', '203.0.113.7']);
  assert.equal(resolve({ ...DEPLOY, BRANDPROOF_ALLOWED_HOSTS: '*' }).allowedHosts, '*');
  refused({ BRANDPROOF_ALLOWED_HOSTS: '*' }, /only accepted with BRANDPROOF_DEPLOY=1/);
  refused({ ...DEPLOY, BRANDPROOF_ALLOWED_HOSTS: '*,judge.example.com' }, /"\*" must stand alone/);
  for (const bad of ['https://judge.example.com', 'judge.example.com:8080', 'judge.example.com/path', 'bad host', '-bad.example.com', '[::1]']) refused({ ...DEPLOY, BRANDPROOF_ALLOWED_HOSTS: bad }, /plain host name or IPv4 address/);
});

test('authenticated mode is never exposed: not deployed, not on another address, not with extra host names', () => {
  const auth = { BRANDPROOF_MODE: 'authenticated' };
  for (const extra of [{ BRANDPROOF_DEPLOY: '1', PORT: '8080', BRANDPROOF_DATA: 'x.json' }, { BRANDPROOF_HOST: '0.0.0.0' }, { BRANDPROOF_HOST: '192.168.1.5' }, { BRANDPROOF_ALLOWED_HOSTS: 'judge.example.com' }]) {
    refused({ ...auth, ...extra }, /authenticated mode is local sign-in over plain HTTP.*not offered/);
  }
  // loopback in any spelling is still fine
  assert.equal(resolve({ ...auth, BRANDPROOF_HOST: '127.0.0.2' }).host, '127.0.0.2');
});

async function freePorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const p = probe.address().port;
    await new Promise((r) => probe.close(r));
    const next = net.createServer();
    const ok = await new Promise((r) => next.once('error', () => r(false)).listen(p + 1, '127.0.0.1', () => r(true)));
    if (ok) {
      await new Promise((r) => next.close(r));
      return p;
    }
  }
  throw new Error('no two consecutive free ports');
}
const hold = (port, host = '127.0.0.1') => {
  const s = net.createServer();
  return new Promise((r, j) => s.once('error', j).listen(port, host, () => r(s)));
};
const release = (s) => new Promise((r) => s.close(r));

async function withApp(fn) {
  const tmp = await tempDir();
  const app = await createApp({ dataFile: path.join(tmp.dir, 'd.json'), semantic: null, ocr: null });
  try {
    await fn(app);
  } finally {
    await app.close();
    await tmp.cleanup();
  }
}

test('local retry is preserved: a busy preferred port moves on to the next free one', async () => {
  const p = await freePorts();
  const blocker = await hold(p);
  try {
    await withApp(async (app) => {
      const url = await listenWithPolicy(app, { host: '127.0.0.1', preferredPort: p, strictPort: false, portTries: 20 });
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(Number(new URL(url).port) > p, `${url} should be above the busy port ${p}`);
    });
  } finally {
    await release(blocker);
  }
});

test('local retry gives up with the system message once every port it may try is busy', async () => {
  const p = await freePorts();
  const [a, b] = [await hold(p), await hold(p + 1)];
  try {
    await withApp(async (app) => {
      await assert.rejects(listenWithPolicy(app, { host: '127.0.0.1', preferredPort: p, strictPort: false, portTries: 2 }), (e) => e instanceof StartupError && /^Could not start server: listen EADDRINUSE/.test(e.message));
    });
  } finally {
    await release(a);
    await release(b);
  }
});

test('assigned-port conflict: strict start-up fails clearly, never moves to another port, and the workspace is not left locked', async () => {
  const p = await freePorts();
  const blocker = await hold(p);
  try {
    const tmp = await tempDir();
    const file = path.join(tmp.dir, 'd.json');
    const app = await createApp({ dataFile: file, semantic: null, ocr: null });
    try {
      await assert.rejects(listenWithPolicy(app, { host: '127.0.0.1', preferredPort: p, strictPort: true, portTries: 1 }), (e) => {
        assert.ok(e instanceof StartupError);
        assert.match(e.message, new RegExp(`^Could not start server: port ${p} on 127\\.0\\.0\\.1 cannot be used: it is already in use\\.`));
        assert.match(e.message, /never tries another one/);
        return true;
      });
      // Not "the next port looks closed": unrelated programs may hold any neighbouring port. The point is that this server is not listening anywhere.
      assert.equal(app.server.listening, false, 'strict start-up must not fall back to another port');
      assert.equal(app.server.address(), null);
    } finally {
      await app.close();
      await tmp.cleanup();
    }
  } finally {
    await release(blocker);
  }
});

test('strict start-up on an address that is not this computer\'s names BRANDPROOF_HOST instead of a bare system error', async () => {
  await withApp(async (app) => {
    await assert.rejects(listenWithPolicy(app, { host: '203.0.113.9', preferredPort: 18999, strictPort: true, portTries: 1 }), (e) => e instanceof StartupError && /port 18999 on 203\.0\.113\.9 cannot be used: that address does not belong to this computer\. Check BRANDPROOF_HOST\./.test(e.message));
  });
});
