import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { seedGuidelines } from '../src/seed.js';
import { validateGuidelines, assignIds } from '../src/validate.js';

export async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brandproof-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function startApp({ semantic = null, appOptions = {} } = {}) {
  const tmp = await tempDir();
  const app = await createApp({ dataFile: path.join(tmp.dir, 'data.json'), semantic, ...appOptions });
  const url = await app.listen(0);
  const call = async (method, p, { role, body, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (role) h['x-demo-role'] = role;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url + p, { method, headers: h, body: payload });
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, buffer, headers: res.headers };
  };
  return {
    url,
    app,
    dir: tmp.dir,
    call,
    close: async () => {
      await app.close();
      await tmp.cleanup();
    },
  };
}

/**
 * Turn a bare "TypeError: fetch failed" into an error that says WHAT failed: the underlying cause (code, errno, syscall, address, port,
 * message), the request, and where in the test it happened. It only adds information to a failure that is already happening: it changes no
 * result, retries nothing and swallows nothing (the original error is kept as `cause`).
 */
export function describeFetchFailure(e, { method, url, phase, server }) {
  const c = e?.cause ?? {};
  const cause = [c.code && `code=${c.code}`, c.errno !== undefined && `errno=${c.errno}`, c.syscall && `syscall=${c.syscall}`, c.address && `address=${c.address}`, c.port && `port=${c.port}`, c.message && `message="${c.message}"`].filter(Boolean).join(' ') || '(no cause was reported)';
  const where = server ? ` server.listening=${server.listening} server.address=${JSON.stringify(server.address())}` : '';
  return new Error(`${e?.message ?? e}: ${cause} | request ${method} ${url} | phase: ${phase}${where}`, { cause: e });
}

/** Normalised fictional guidelines, ready for runChecks. */
export function guidelinesFixture() {
  const { errors, value } = validateGuidelines(seedGuidelines());
  if (errors.length) throw new Error(JSON.stringify(errors));
  return assignIds(value);
}

export const blankAsset = () => ({ name: '', alt: '', fileSha256: null, fg: null, bg: null, textSize: 'normal', colors: [] });

export const cleanContent = () => ({
  text: 'Meet the Aurora Lamp, a reading lamp made to be easy on the eyes. A full charge runs up to 12 hours.',
  asset: {
    name: 'hero.png',
    alt: 'The Aurora Lamp glowing beside an open book on a wooden shelf',
    fg: '#0F2A43',
    bg: '#FFFFFF',
    textSize: 'normal',
    colors: ['#0F2A43'],
  },
});
