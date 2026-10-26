import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AssetStore, createUploader, sha256Hex } from '../src/assets.js';
import { Store, emptyState } from '../src/store.js';
import { startApp, tempDir, cleanContent } from './helpers.js';
import { startAuthApp } from './auth-helpers.js';
import { makeStripedPng, makePng } from './png-helpers.js';

const OCTET = { 'content-type': 'application/octet-stream' };
const asset = (sha) => ({ ...cleanContent().asset, name: 'campaign.png', retainedSha256: sha });
const fileOf = (t, sha) => path.join(`${path.join(t.dir, 'data.json')}.assets`, `${sha}.png`);

/** Flip exactly one byte in place: same size, different content. */
async function corruptSameSize(file) {
  const b = await fs.readFile(file);
  b[Math.floor(b.length / 2)] ^= 0x01;
  await fs.writeFile(file, b);
  return b;
}

async function setup() {
  const t = await startApp();
  const png = makeStripedPng();
  const sha = sha256Hex(png);
  const up = (bytes = png) => t.call('POST', '/api/assets', { role: 'creator', raw: bytes, headers: OCTET });
  assert.equal((await up()).status, 201);
  const made = await t.call('POST', '/api/submissions', { role: 'creator', body: { title: 'Integrity', text: cleanContent().text, asset: asset(sha) } });
  assert.equal(made.status, 201, made.text);
  const requestReview = () => t.call('POST', `/api/submissions/${made.json.id}/request-review`, { role: 'creator', body: { revision: 1, expected: made.json.workflow.binding } });
  const view = async () => (await t.call('GET', `/api/submissions/${made.json.id}`, { role: 'reviewer' })).json;
  const approve = async () => t.call('POST', `/api/submissions/${made.json.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: (await view()).workflow.binding } });
  return { t, png, sha, up, made, requestReview, view, approve, file: fileOf(t, sha) };
}

test('REGRESSION: same-size corruption of a retained image blocks review request AND approval, with no state change', async () => {
  const { t, sha, made, requestReview, view, approve, file } = await setup();
  try {
    await corruptSameSize(file);
    assert.equal((await fs.stat(file)).size > 0, true);
    const served = await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' });
    assert.equal(served.status, 500);
    assert.equal(served.json.error.code, 'asset_corrupt');

    const rr = await requestReview();
    assert.equal(rr.status, 409, 'previously 201: only the file SIZE was checked');
    assert.equal(rr.json.error.code, 'asset_corrupt');
    assert.match(rr.json.error.message, /integrity check/);
    assert.match(rr.json.error.message, /Upload the same image again/);
    assert.equal((await view()).events.length, 0, 'nothing was recorded');
    assert.equal((await view()).workflow.status, 'draft');

    // restore, request review, then corrupt AGAIN before the decision
    assert.equal((await t.call('POST', '/api/assets', { role: 'creator', raw: await makeStripedPngBytes(), headers: OCTET })).status, 200);
    assert.equal((await requestReview()).status, 201);
    await corruptSameSize(file);
    const ap = await approve();
    assert.equal(ap.status, 409, 'previously 201 green Approved');
    assert.equal(ap.json.error.code, 'asset_corrupt');
    const after = await view();
    assert.equal(after.workflow.status, 'in_review');
    assert.equal(after.events.filter((e) => e.type === 'approved').length, 0);
    assert.equal(after.id, made.json.id);
  } finally {
    await t.close();
  }
});

const makeStripedPngBytes = async () => makeStripedPng(); // the identical, valid bytes

test('REGRESSION: re-uploading the identical valid bytes restores a CORRUPT, MISSING, truncated or empty retained file, then review and approval work', async () => {
  const { t, png, sha, requestReview, view, approve, file } = await setup();
  try {
    const reup = () => t.call('POST', '/api/assets', { role: 'creator', raw: png, headers: OCTET });
    const damage = {
      corrupt: () => corruptSameSize(file),
      missing: () => fs.rm(file),
      truncated: () => fs.writeFile(file, png.subarray(0, 10)),
      empty: () => fs.writeFile(file, Buffer.alloc(0)),
    };
    for (const [kind, hurt] of Object.entries(damage)) {
      await hurt();
      assert.notEqual((await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' })).status, 200, `${kind}: not served while damaged`);
      const r = await reup();
      assert.equal(r.status, 200, `${kind}: ${r.text}`);
      assert.equal(r.json.asset.deduplicated, true);
      assert.equal(r.json.asset.restored, kind === 'missing' ? 'missing' : 'corrupt', `${kind}: the response says what was repaired`);
      const got = await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' });
      assert.equal(got.status, 200, `${kind}: served again`);
      assert.ok(got.buffer.equals(png), `${kind}: exactly the original bytes`);
    }
    // an undamaged re-upload reports nothing restored
    assert.equal((await reup()).json.asset.restored, null);
    // the whole workflow works on the restored bytes
    assert.equal((await requestReview()).status, 201);
    const ap = await approve();
    assert.equal(ap.status, 201, ap.text);
    assert.equal(ap.json.workflow.status, 'approved');
    // and no stray temp files were left by the restorations
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp')), []);
    assert.equal((await t.call('GET', '/api/assets/usage', { role: 'creator' })).json.count, 1, 'restoring never registers a second copy');
    assert.equal((await view()).current.image.sha256, sha);
  } finally {
    await t.close();
  }
});

test('restoration refuses different bytes: only an upload that hashes to the registered digest can repair it', async () => {
  const { t, sha, file } = await setup();
  try {
    await corruptSameSize(file);
    const other = makePng({ pixel: [9, 9, 9] });
    const r = await t.call('POST', '/api/assets', { role: 'creator', raw: other, headers: OCTET });
    assert.equal(r.status, 201, 'different bytes are simply a different image');
    assert.notEqual(r.json.asset.sha256, sha);
    assert.equal((await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' })).status, 500, 'the damaged image is still damaged');
  } finally {
    await t.close();
  }
});

test('an unusable stored file (a directory in its place) is reported as unavailable; a failed restoration is atomic and leaves no residue', async () => {
  const { t, png, sha, requestReview, file } = await setup();
  try {
    await fs.rm(file);
    await fs.mkdir(file); // something that is not a readable file sits where the image should be
    const rr = await requestReview();
    assert.equal(rr.status, 409);
    assert.equal(rr.json.error.code, 'asset_missing');
    const bad = await t.call('POST', '/api/assets', { role: 'creator', raw: png, headers: OCTET });
    assert.equal(bad.status, 503, 'the rename cannot replace a directory: the restoration fails cleanly');
    assert.equal(bad.json.error.code, 'asset_storage_failed');
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp')), [], 'no temp residue after the failed restoration');
    await fs.rm(file, { recursive: true });
    assert.equal((await t.call('POST', '/api/assets', { role: 'creator', raw: png, headers: OCTET })).json.asset.restored, 'missing');
    assert.equal((await requestReview()).status, 201);
    assert.equal((await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' })).status, 200);
  } finally {
    await t.close();
  }
});

test('the decision binding and stale-view protection still apply on top of the integrity check', async () => {
  const { t, png, requestReview, view, file } = await setup();
  try {
    assert.equal((await requestReview()).status, 201);
    const seen = (await view()).workflow.binding;
    const g = (await t.call('GET', '/api/guidelines', { role: 'manager' })).json;
    const edited = structuredClone(g.guidelines);
    edited.claims.signals.push('unbeatable');
    assert.equal((await t.call('PUT', '/api/guidelines', { role: 'manager', body: { baseVersion: g.version, guidelines: edited } })).status, 201);
    const r = await t.call('POST', `/api/submissions/${(await view()).id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'stale_view', 'a stale view is still refused even with intact bytes');
    assert.ok((await fs.readFile(file)).equals(png));
  } finally {
    await t.close();
  }
});

// ---------- temp files on ordinary I/O failures ----------

function faulty(kind) {
  return {
    ...fs,
    async open(p, flags, mode) {
      if (kind === 'open') throw new Error('open failed (injected)');
      const fh = await fs.open(p, flags, mode);
      return {
        async writeFile(buf) {
          if (kind === 'write') {
            await fh.writeFile(buf.subarray(0, Math.max(1, Math.floor(buf.length / 2)))); // a partial write, then failure
            throw new Error('disk full (injected)');
          }
          return fh.writeFile(buf);
        },
        async sync() {
          if (kind === 'sync') throw new Error('fsync failed (injected)');
          return fh.sync();
        },
        async close() {
          await fh.close();
          if (kind === 'close') throw new Error('close failed (injected)');
        },
      };
    },
    async rename(a, b) {
      if (kind === 'rename') throw new Error('rename failed (injected)');
      return fs.rename(a, b);
    },
  };
}

test('REGRESSION: an ordinary I/O failure while writing an image (open, partial write, fsync, close, rename) leaves no temp file and no final file', async () => {
  const png = makeStripedPng();
  const sha = sha256Hex(png);
  for (const kind of ['open', 'write', 'sync', 'close', 'rename']) {
    const tmp = await tempDir();
    try {
      const dir = path.join(tmp.dir, 'assets');
      const store = new AssetStore(dir, { fsApi: faulty(kind) });
      await assert.rejects(store.write(sha, png), /injected/, kind);
      const left = await fs.readdir(dir).catch(() => []);
      assert.deepEqual(left, [], `${kind}: nothing left behind (${left.join(',')})`);
      // the same store works once the fault is gone
      const healthy = new AssetStore(dir);
      await healthy.write(sha, png);
      assert.equal(await healthy.verify(sha, png.length), 'ok');
    } finally {
      await tmp.cleanup();
    }
  }
});

test('REGRESSION: a failed restoration through the uploader leaves the damaged file exactly as it was and no temp file', async () => {
  const png = makeStripedPng();
  const sha = sha256Hex(png);
  const tmp = await tempDir();
  try {
    const dir = path.join(tmp.dir, 'assets');
    const store = await Store.open(path.join(tmp.dir, 'ws.json'), () => emptyState());
    const good = new AssetStore(dir);
    const up = createUploader({ store, blobs: good });
    const who = { role: 'creator', name: 'Demo Creator' };
    await up.upload(png, { who, now: 'now' });
    const file = path.join(dir, `${sha}.png`);
    const damaged = await corruptSameSize(file);

    for (const kind of ['write', 'sync', 'close', 'rename']) {
      const failing = createUploader({ store, blobs: new AssetStore(dir, { fsApi: faulty(kind) }) });
      await assert.rejects(failing.upload(png, { who, now: 'now' }), (e) => e.status === 503 && e.code === 'asset_storage_failed', kind);
      assert.ok((await fs.readFile(file)).equals(damaged), `${kind}: the damaged file was not half-overwritten`);
      assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), [], `${kind}: no temp residue`);
    }
    const r = await up.upload(png, { who, now: 'now' });
    assert.equal(r.restored, 'corrupt');
    assert.equal(await good.verify(sha, png.length), 'ok');
    await store.close();
  } finally {
    await tmp.cleanup();
  }
});

test('verify reports ok / missing / corrupt / unavailable from the real bytes, not from file size', async () => {
  const tmp = await tempDir();
  try {
    const png = makeStripedPng();
    const sha = sha256Hex(png);
    const s = new AssetStore(path.join(tmp.dir, 'a'));
    assert.equal(await s.verify(sha, png.length), 'missing');
    await s.write(sha, png);
    assert.equal(await s.verify(sha, png.length), 'ok');
    assert.equal(await s.verify(sha, png.length + 1), 'corrupt', 'wrong recorded size');
    await corruptSameSize(s.path(sha));
    assert.equal((await fs.stat(s.path(sha))).size, png.length, 'size is unchanged by the corruption');
    assert.equal(await s.verify(sha, png.length), 'corrupt');
    await fs.rm(s.path(sha));
    await fs.mkdir(s.path(sha));
    assert.equal(await s.verify(sha, png.length), 'unavailable');
  } finally {
    await tmp.cleanup();
  }
});

// ---------- authenticated mode ----------

test('authenticated: corruption blocks the creator\'s review request and a distinct reviewer\'s approval; a re-upload by the creator repairs it', async () => {
  const t = await startAuthApp({ users: ['creator', 'reviewer'] });
  try {
    const png = makeStripedPng();
    const sha = sha256Hex(png);
    const creator = await t.as('creator');
    const reviewer = await t.as('reviewer');
    assert.equal((await creator.call('POST', '/api/assets', { raw: png, headers: OCTET })).status, 201);
    const made = await creator.call('POST', '/api/submissions', { body: { title: 'Auth integrity', text: cleanContent().text, asset: asset(sha) } });
    const file = path.join(`${t.files.dataFile}.assets`, `${sha}.png`);

    await corruptSameSize(file);
    const rr = await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } });
    assert.equal(rr.status, 409);
    assert.equal(rr.json.error.code, 'asset_corrupt');
    assert.equal((await reviewer.call('GET', `/api/assets/${sha}`)).status, 500);

    const fix = await creator.call('POST', '/api/assets', { raw: png, headers: OCTET });
    assert.equal(fix.status, 200);
    assert.equal(fix.json.asset.restored, 'corrupt');
    assert.equal((await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } })).status, 201);
    const seen = (await reviewer.call('GET', `/api/submissions/${made.json.id}`)).json;
    await corruptSameSize(file);
    const bad = await reviewer.call('POST', `/api/submissions/${made.json.id}/approve`, { body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error.code, 'asset_corrupt');
    // a reviewer cannot repair it (uploading is a creator/manager action); the creator re-uploads
    assert.equal((await reviewer.call('POST', '/api/assets', { raw: png, headers: OCTET })).status, 403);
    assert.equal((await creator.call('POST', '/api/assets', { raw: png, headers: OCTET })).json.asset.restored, 'corrupt');
    const ok = await reviewer.call('POST', `/api/submissions/${made.json.id}/approve`, { body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.events.at(-1).actor.id, t.ids.reviewer);
  } finally {
    await t.close();
  }
});
