import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { validatePng, sha256Hex, ASSET_LIMITS } from '../src/assets.js';
import { assetHash } from '../src/service.js';
import { canonical, sha256 } from '../src/util.js';
import { startApp, tempDir, cleanContent } from './helpers.js';
import { startAuthApp } from './auth-helpers.js';
import { makePng, makeStripedPng, makeNoisePng, broken, jpegLike, svgText, htmlText, sigOnly, chunk } from './png-helpers.js';

const OCTET = { 'content-type': 'application/octet-stream' };
const demo = (t, role) => ({
  upload: (bytes, headers = OCTET) => t.call('POST', '/api/assets', { role, raw: bytes, headers }),
  get: (p, body) => t.call(body ? 'POST' : 'GET', p, { role, body }),
});
const asset = (sha, extra = {}) => ({ ...cleanContent().asset, name: 'campaign.png', retainedSha256: sha, ...extra });
const submission = (sha, extra = {}) => ({ title: 'With image', text: cleanContent().text, asset: asset(sha), ...extra });

// ---------- the PNG validator (server-side, ignores everything the client says) ----------

test('validator: accepts real PNGs of every colour type, bit depth, interlacing and chunk splitting, and reports their true dimensions', () => {
  const cases = [
    { colorType: 0, bitDepth: 1, width: 9, height: 5 },
    { colorType: 0, bitDepth: 16, width: 7, height: 7 },
    { colorType: 2, bitDepth: 8, width: 33, height: 17 },
    { colorType: 2, bitDepth: 16, width: 5, height: 3 },
    { colorType: 3, bitDepth: 2, width: 11, height: 6, pixel: [0, 1, 2, 3] },
    { colorType: 4, bitDepth: 8, width: 10, height: 10 },
    { colorType: 6, bitDepth: 8, width: 13, height: 9, interlace: 1 },
    { colorType: 2, bitDepth: 8, width: 20, height: 20, interlace: 1, idatSplit: 4 },
    { colorType: 2, bitDepth: 8, width: 1, height: 1, interlace: 1 },
    { colorType: 6, bitDepth: 16, width: 17, height: 11, interlace: 1 },
  ];
  for (const c of cases) {
    const info = validatePng(makePng(c));
    assert.equal(info.width, c.width);
    assert.equal(info.height, c.height);
    assert.equal(info.mime, 'image/png');
  }
  assert.equal(validatePng(makePng({ extra: [chunk('tEXt', Buffer.from('Comment\0fictional'))] })).width, 16, 'ancillary chunks are tolerated');
  assert.equal(validatePng(makeStripedPng()).width, 240);
});

test('validator: refuses everything that is not a sound PNG, with a specific reason (a magic prefix is not enough)', () => {
  const ok = makePng();
  const refused = {
    'JPEG bytes': [jpegLike, /not a PNG/],
    'SVG': [svgText, /not a PNG/],
    'HTML': [htmlText, /not a PNG/],
    'PNG signature and nothing else': [sigOnly, /./],
    'empty': [Buffer.alloc(0), /No image data/],
    'truncated': [broken.truncated(ok), /truncated|corrupted/],
    'no end marker': [broken.noEnd(ok), /truncated|end marker/],
    'bad checksum': [broken.badCrc(ok), /corrupt|checksum|truncated/],
    'only a stored checksum is wrong': [broken.crcOnly(ok), /bad checksum in IHDR/],
    'data after IEND': [broken.trailing(ok), /after its end|truncated|chunk/],
    'decompression bomb': [broken.bomb(), /expands to more/],
    'invalid scanline filter': [broken.badFilter(), /scanline filter/],
    'image data shorter than the header says': [broken.shortData(), /shorter|truncated/],
    'unknown critical chunk': [broken.criticalUnknown(), /needs a feature/],
    'animated PNG': [broken.animated(), /Animated/],
    'palette image without a palette': [broken.missingPalette(), /missing its palette/],
  };
  for (const [name, [bytes, why]] of Object.entries(refused)) {
    assert.throws(() => validatePng(bytes), (e) => e.status >= 400 && why.test(e.message), name);
  }
});

test('validator: dimension, pixel and byte limits', () => {
  assert.throws(() => validatePng(broken.dims(5000, 10)), (e) => e.status === 413 && /4096/.test(e.message));
  assert.throws(() => validatePng(broken.dims(3000, 2000)), (e) => e.status === 413 && /pixels/.test(e.message));
  assert.throws(() => validatePng(broken.dims(0, 10)), (e) => e.status === 422);
  assert.throws(() => validatePng(makePng(), { ...ASSET_LIMITS, imageBytes: 50 }), (e) => e.status === 413);
  assert.equal(validatePng(makePng({ width: 2000, height: 2000, colorType: 0 })).width, 2000, '4,000,000 pixels is allowed');
  assert.throws(() => validatePng(makePng({ width: 2001, height: 2000, colorType: 0 })), (e) => e.status === 413);
});

// ---------- upload, serving, references ----------

test('upload: the server computes the digest, size and dimensions; names, types and claimed digests are ignored; serving is exact and safe', async () => {
  const t = await startApp();
  try {
    const png = makeStripedPng();
    const sha = sha256Hex(png);
    const c = demo(t, 'creator');
    const r = await c.upload(png, { ...OCTET, 'x-sha256': '0'.repeat(64), 'x-filename': '../../etc/passwd', 'x-width': '9999' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.asset.sha256, sha);
    assert.equal(r.json.asset.bytes, png.length);
    assert.deepEqual([r.json.asset.width, r.json.asset.height, r.json.asset.mime], [240, 120, 'image/png']);
    assert.deepEqual(r.json.asset.createdBy, { role: 'creator', name: 'Demo Creator' });
    assert.equal(r.json.asset.url, `/api/assets/${sha}`);
    assert.equal((await c.upload(png)).status, 200, 'identical bytes are deduplicated');
    assert.equal((await c.upload(png)).json.asset.deduplicated, true);
    assert.equal((await t.call('GET', '/api/assets/usage', { role: 'creator' })).json.count, 1);

    const g = await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' });
    assert.equal(g.status, 200);
    assert.ok(g.buffer.equals(png), 'exactly the retained bytes');
    assert.equal(g.headers.get('content-type'), 'image/png');
    assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
    assert.match(g.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
    assert.match(g.headers.get('content-disposition'), /^inline; filename="image.png"$/);
    assert.equal(g.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(g.headers.get('cache-control'), /no-store/);
    assert.equal(sha256Hex(g.buffer), sha);
  } finally {
    await t.close();
  }
});

test('upload: wrong types, malformed and oversized input are refused and nothing is kept', async () => {
  const t = await startApp({ appOptions: { assetLimits: { ...ASSET_LIMITS, imageBytes: 4000 } } });
  try {
    const c = demo(t, 'creator');
    const st = async (bytes, headers) => (await c.upload(bytes, headers)).status;
    assert.equal(await st(makePng(), { 'content-type': 'image/jpeg' }), 415);
    assert.equal(await st(makePng(), { 'content-type': 'application/json' }), 415);
    assert.equal(await st(jpegLike), 422);
    assert.equal(await st(svgText), 422);
    assert.equal(await st(htmlText), 422);
    assert.equal(await st(sigOnly), 422);
    assert.equal(await st(broken.truncated(makePng())), 422);
    assert.equal(await st(broken.badCrc(makePng())), 422);
    assert.equal(await st(Buffer.alloc(0)), 422);
    assert.equal(await st(makeNoisePng({ width: 40, height: 40 })), 413, 'over the byte limit');
    assert.equal(await st(broken.dims(5000, 10)), 413);
    assert.equal((await t.call('GET', '/api/assets/usage', { role: 'creator' })).json.count, 0);
    assert.deepEqual(await readdir(`${path.join(t.dir, 'data.json')}.assets`).catch(() => []), []);
    const err = (await c.upload(jpegLike)).json.error;
    assert.equal(err.code, 'asset_invalid');
    assert.doesNotMatch(JSON.stringify(err), /ffd8|stack|\/Users|E:\\/i, 'no internals in the error');
  } finally {
    await t.close();
  }
});

test('upload: reviewers cannot upload; no role is refused; the body limit applies while streaming', async () => {
  const t = await startApp({ appOptions: { assetLimits: { ...ASSET_LIMITS, imageBytes: 3000 } } });
  try {
    assert.equal((await demo(t, 'reviewer').upload(makePng())).status, 403);
    assert.equal((await t.call('POST', '/api/assets', { raw: makePng(), headers: OCTET })).status, 400);
    assert.equal((await demo(t, 'manager').upload(makePng())).status, 201);
    const huge = Buffer.concat([makePng(), Buffer.alloc(20000)]);
    assert.equal((await demo(t, 'creator').upload(huge)).status, 413);
  } finally {
    await t.close();
  }
});

test('serving: only registered 64-hex references become files; traversal, case tricks and unknown hashes are 404', async () => {
  const t = await startApp();
  try {
    const png = makePng();
    await demo(t, 'creator').upload(png);
    for (const p of ['/api/assets/..%2f..%2fpackage.json', '/api/assets/%2e%2e%2fdata.json', `/api/assets/${sha256Hex(png).toUpperCase()}`, `/api/assets/${'0'.repeat(64)}`, '/api/assets/not-a-hash', `/api/assets/${sha256Hex(png)}.png`, `/api/assets/${sha256Hex(png)}/x`]) {
      assert.ok([404, 405].includes((await t.call('GET', p, { role: 'creator' })).status), p);
    }
    // an UNREGISTERED file placed in the directory by hand is never served
    const stray = makePng({ pixel: [1, 2, 3] });
    await writeFile(path.join(`${path.join(t.dir, 'data.json')}.assets`, `${sha256Hex(stray)}.png`), stray);
    assert.equal((await t.call('GET', `/api/assets/${sha256Hex(stray)}`, { role: 'creator' })).status, 404);
  } finally {
    await t.close();
  }
});

test('serving: a missing or tampered file is reported, never served; review and approval are blocked on missing bytes', async () => {
  const t = await startApp();
  try {
    const png = makePng();
    const sha = sha256Hex(png);
    await demo(t, 'creator').upload(png);
    const made = await t.call('POST', '/api/submissions', { role: 'creator', body: submission(sha) });
    assert.equal(made.status, 201, made.text);
    const file = path.join(`${path.join(t.dir, 'data.json')}.assets`, `${sha}.png`);

    const tampered = Buffer.from(png);
    tampered[tampered.length - 20] ^= 0x01; // same length, different bytes
    await writeFile(file, tampered);
    const bad = await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' });
    assert.equal(bad.status, 500);
    assert.equal(bad.json.error.code, 'asset_corrupt');
    assert.equal(bad.headers.get('content-type').includes('image/png'), false, 'the corrupted bytes were not sent as an image');

    await rm(file);
    assert.equal((await t.call('GET', `/api/assets/${sha}`, { role: 'reviewer' })).json.error.code, 'asset_missing');
    const rr = await t.call('POST', `/api/submissions/${made.json.id}/request-review`, { role: 'creator', body: { revision: 1, expected: made.json.workflow.binding } });
    assert.equal(rr.status, 409);
    assert.equal(rr.json.error.code, 'asset_missing');
    await writeFile(file, png); // restored
    assert.equal((await t.call('POST', `/api/submissions/${made.json.id}/request-review`, { role: 'creator', body: { revision: 1, expected: made.json.workflow.binding } })).status, 201);
    await rm(file);
    const seen = (await t.call('GET', `/api/submissions/${made.json.id}`, { role: 'reviewer' })).json;
    assert.equal((await t.call('POST', `/api/submissions/${made.json.id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen.workflow.binding } })).status, 409, 'no approval on bytes that are no longer retained');
  } finally {
    await t.close();
  }
});

test('references: a revision may only point at retained bytes; forged, unknown, malformed and mismatched references are refused', async () => {
  const t = await startApp();
  try {
    const png = makePng();
    const sha = sha256Hex(png);
    const post = (asset) => t.call('POST', '/api/submissions', { role: 'creator', body: { title: 'x', text: cleanContent().text, asset } });
    const before = (await t.call('GET', '/api/submissions', { role: 'creator' })).json.submissions.length;
    assert.equal((await post(asset(sha))).status, 422, 'never uploaded');
    assert.equal((await post(asset(sha))).json.error.code, 'asset_unretained');
    await demo(t, 'creator').upload(png);
    assert.equal((await post(asset('f'.repeat(64)))).status, 422, 'a well-formed hash that was never retained');
    assert.equal((await post(asset('xyz'))).status, 422, 'malformed');
    assert.equal((await post(asset(sha.toUpperCase()))).status, 422, 'upper-case is not the stored form');
    assert.equal((await post(asset(sha, { fileSha256: 'a'.repeat(64) }))).status, 422, 'a supplied fingerprint that disagrees with the retained bytes');
    assert.equal((await post({ ...asset(sha), name: '' })).status, 422, 'an attached image needs a name');
    assert.equal((await t.call('GET', '/api/submissions', { role: 'creator' })).json.submissions.length, before, 'nothing was created by refused requests');
    const ok = await post(asset(sha, { fileSha256: sha }));
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.revisions[0].asset.retainedSha256, sha);
    assert.equal(ok.json.revisions[0].asset.fileSha256, sha, 'the legacy fingerprint is set from the server-computed digest');
    // the same checks guard new revisions
    const rev = (a) => t.call('POST', `/api/submissions/${ok.json.id}/revisions`, { role: 'creator', body: { baseRevision: 1, text: cleanContent().text + ' More.', asset: a } });
    assert.equal((await rev(asset('e'.repeat(64)))).status, 422);
    assert.equal((await rev(asset(sha))).status, 201);
  } finally {
    await t.close();
  }
});

test('legacy metadata-only records stay usable and are labelled honestly; their hash is unchanged', async () => {
  const t = await startApp();
  try {
    const legacy = { name: 'old-banner.png', alt: 'An older banner', fileSha256: 'b'.repeat(64), fg: null, bg: null, textSize: 'normal', colors: [] };
    const made = await t.call('POST', '/api/submissions', { role: 'creator', body: { title: 'Old style', text: cleanContent().text, asset: legacy } });
    assert.equal(made.status, 201);
    assert.equal(made.json.revisions[0].image.status, 'metadata_only');
    assert.match(made.json.revisions[0].image.note, /not retained/);
    assert.equal(made.json.current.image.status, 'metadata_only');
    const none = await t.call('POST', '/api/submissions', { role: 'creator', body: { title: 'No image', text: cleanContent().text, asset: {} } });
    assert.equal(none.json.revisions[0].image.status, 'none');
    // the binding of an asset WITHOUT a retained image is exactly what it was before this feature existed
    const oldFormula = sha256(canonical({ name: legacy.name, alt: legacy.alt, fileSha256: legacy.fileSha256, fg: null, bg: null, textSize: 'normal', colors: [] }));
    assert.equal(assetHash({ ...legacy, retainedSha256: null }), oldFormula);
    assert.equal(assetHash(legacy), oldFormula);
    // a seeded, previously approved submission is untouched
    assert.equal((await t.call('GET', '/api/submissions/SUB-2', { role: 'reviewer' })).json.workflow.status, 'approved');
  } finally {
    await t.close();
  }
});

// ---------- approval identity, replacement, history ----------

test('approval is bound to the retained image: replacing it makes the approval stale, and history keeps each revision\'s own bytes', async () => {
  const t = await startApp();
  try {
    const [a, b] = [makeStripedPng(), makeStripedPng({ colors: [[200, 30, 30], [30, 200, 30]] })];
    const [sa, sb] = [sha256Hex(a), sha256Hex(b)];
    await demo(t, 'creator').upload(a);
    await demo(t, 'creator').upload(b);
    const made = await t.call('POST', '/api/submissions', { role: 'creator', body: submission(sa) });
    const id = made.json.id;
    await t.call('POST', `/api/submissions/${id}/request-review`, { role: 'creator', body: { revision: 1, expected: made.json.workflow.binding } });
    const seen = (await t.call('GET', `/api/submissions/${id}`, { role: 'reviewer' })).json;
    assert.equal(seen.current.image.status, 'retained');
    assert.equal(seen.current.image.sha256, sa);
    const ok = await t.call('POST', `/api/submissions/${id}/approve`, { role: 'reviewer', body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(ok.status, 201);
    const approval = ok.json.events.at(-1);
    assert.equal(approval.binding.assetHash, assetHash(asset(sa, { fileSha256: sa })), 'the approval identity includes the retained digest');

    // replace the image in a new revision (same text, same alt)
    const rev = await t.call('POST', `/api/submissions/${id}/revisions`, { role: 'creator', body: { baseRevision: 1, text: cleanContent().text, asset: asset(sb) } });
    assert.equal(rev.status, 201, rev.text);
    assert.equal(rev.json.workflow.status, 'approval_stale');
    assert.deepEqual(rev.json.workflow.staleApproval.reasons, ['asset']);
    assert.notEqual(rev.json.workflow.binding.assetHash, approval.binding.assetHash);
    assert.equal((await t.call('GET', '/api/submissions', { role: 'reviewer' })).json.submissions.find((s) => s.id === id).status, 'approval_stale');

    // history keeps each revision's own image
    const d = (await t.call('GET', `/api/submissions/${id}`, { role: 'reviewer' })).json;
    assert.deepEqual(d.revisions.map((r) => r.image.sha256), [sa, sb]);
    assert.ok((await t.call('GET', d.revisions[0].image.url, { role: 'reviewer' })).buffer.equals(a), 'revision 1 still shows its original image');
    assert.ok((await t.call('GET', d.revisions[1].image.url, { role: 'reviewer' })).buffer.equals(b));
    const cmp = (await t.call('GET', `/api/submissions/${id}/compare?from=1&to=2`, { role: 'reviewer' })).json;
    assert.ok(cmp.assetFields.includes('retainedSha256'));
    // removing the image is explicit too, and is a change
    const removed = await t.call('POST', `/api/submissions/${id}/revisions`, { role: 'creator', body: { baseRevision: 2, text: cleanContent().text, asset: { name: '', alt: '' } } });
    assert.equal(removed.json.current.image.status, 'none');
    assert.equal(removed.json.revisions[1].image.sha256, sb, 'earlier revisions are not rewritten');
  } finally {
    await t.close();
  }
});

test('identity: a retained image and a metadata-only claim with the same fingerprint are NOT the same approval identity', () => {
  const sha = 'c'.repeat(64);
  const claimed = { name: 'a.png', alt: 'x', fileSha256: sha, fg: null, bg: null, textSize: 'normal', colors: [] };
  const retained = { ...claimed, retainedSha256: sha };
  assert.notEqual(assetHash(claimed), assetHash(retained), 'an approval of unretained metadata cannot be mistaken for an approval of retained bytes');
  assert.equal(assetHash({ ...retained, retainedSha256: null }), assetHash(claimed));
});

test('the manual colour checks stay manual: an attached image does not change any colour finding', async () => {
  const t = await startApp();
  try {
    const png = makeStripedPng({ colors: [[255, 0, 170]] }); // a colour that is not in the palette
    await demo(t, 'creator').upload(png);
    const withImage = await t.call('POST', '/api/check', { body: { text: 'Hello there.', asset: { name: 'campaign.png', alt: 'A striped campaign banner in three colours', retainedSha256: sha256Hex(png) } } });
    // /api/check does not resolve references (nothing is saved), and no colours are inferred from the pixels
    assert.equal(withImage.status, 200);
    assert.equal(withImage.json.findings.some((f) => f.ruleKind === 'palette'), false);
    assert.ok(withImage.json.notChecked.some((n) => /Contrast not checked/.test(n.reason)));
    assert.ok(withImage.json.notChecked.some((n) => /Palette not checked/.test(n.reason)));
  } finally {
    await t.close();
  }
});

// ---------- quota, concurrency, failure ----------

test('quota: concurrent uploads can never exceed the count or byte limits, and no orphan files remain', async () => {
  const imgs = Array.from({ length: 10 }, (_, i) => makePng({ pixel: [i * 20, 10, 10], width: 24, height: 24 }));
  const one = imgs[0].length;
  const t = await startApp({ appOptions: { assetLimits: { ...ASSET_LIMITS, count: 4, totalBytes: one * 100 } } });
  try {
    const c = demo(t, 'creator');
    const rs = await Promise.all(imgs.map((b) => c.upload(b)));
    assert.equal(rs.filter((r) => r.status === 201).length, 4);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 413 && r.json.error.code === 'asset_quota'));
    assert.match(rs.find((r) => r.status === 413).json.error.message, /cannot be deleted/);
    const u = (await t.call('GET', '/api/assets/usage', { role: 'creator' })).json;
    assert.equal(u.count, 4);
    const files = (await readdir(`${path.join(t.dir, 'data.json')}.assets`)).filter((n) => n.endsWith('.png'));
    assert.equal(files.length, 4, 'every file on disk is registered; refused uploads left nothing behind');
    // an already-retained image is not refused by a full quota
    assert.equal((await c.upload(imgs.find((_, i) => rs[i].status === 201))).status, 200);
  } finally {
    await t.close();
  }

  const t2 = await startApp({ appOptions: { assetLimits: { ...ASSET_LIMITS, totalBytes: one * 2 + 10 } } });
  try {
    const rs = await Promise.all(imgs.slice(0, 5).map((b) => demo(t2, 'creator').upload(b)));
    assert.equal(rs.filter((r) => r.status === 201).length, 2, 'the byte quota admits exactly what fits');
    assert.ok((await t2.call('GET', '/api/assets/usage', { role: 'creator' })).json.bytes <= one * 2 + 10);
  } finally {
    await t2.close();
  }
});

test('concurrency: the same bytes uploaded many times at once are stored once and counted once', async () => {
  const t = await startApp();
  try {
    const png = makeStripedPng();
    const rs = await Promise.all(Array.from({ length: 10 }, () => demo(t, 'creator').upload(png)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal(rs.filter((r) => r.status === 200).length, 9);
    const u = (await t.call('GET', '/api/assets/usage', { role: 'creator' })).json;
    assert.deepEqual([u.count, u.bytes], [1, png.length]);
  } finally {
    await t.close();
  }
});

test('storage failure: a blob that cannot be written, or a registry that cannot be saved, leaves nothing half-done and recovers', async () => {
  const t = await startApp();
  try {
    const dataFile = path.join(t.dir, 'data.json');
    const assetsDir = `${dataFile}.assets`;
    const png = makeStripedPng();
    const c = demo(t, 'creator');

    // 1. the image directory is unusable (a file sits where the directory should be)
    await writeFile(assetsDir, 'not a directory');
    const r1 = await c.upload(png);
    assert.equal(r1.status, 503);
    assert.equal(r1.json.error.code, 'asset_storage_failed');
    assert.equal((await t.call('GET', '/api/assets/usage', { role: 'creator' })).json.count, 0);
    await rm(assetsDir);

    // 2. the image is written but the workspace file cannot be saved: the new blob is removed again
    const blocker = `${dataFile}.${process.pid}.tmp`;
    await mkdir(blocker);
    const r2 = await c.upload(png);
    assert.equal(r2.status, 503);
    assert.deepEqual((await readdir(assetsDir)).filter((n) => n.endsWith('.png')), [], 'no unregistered image left behind');
    assert.equal((await t.call('GET', '/api/assets/usage', { role: 'creator' })).json.count, 0);
    await rm(blocker, { recursive: true });

    // 3. it recovers
    assert.equal((await c.upload(png)).status, 201);
    assert.equal((await t.call('GET', `/api/assets/${sha256Hex(png)}`, { role: 'creator' })).status, 200);
  } finally {
    await t.close();
  }
});

test('persistence: retained images, references and review state survive a restart; workspaces never share bytes', async () => {
  const tmp = await tempDir();
  const file = path.join(tmp.dir, 'data.json');
  let app = await createApp({ dataFile: file, semantic: null });
  let url = await app.listen(0);
  const call = async (method, p, { role = 'creator', body, raw, headers } = {}) => {
    const h = { ...(headers ?? {}), 'x-demo-role': role };
    if (body) h['content-type'] = 'application/json';
    const res = await fetch(url + p, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const buffer = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {}
    return { status: res.status, json, buffer };
  };
  try {
    const png = makeStripedPng();
    const sha = sha256Hex(png);
    assert.equal((await call('POST', '/api/assets', { raw: png, headers: OCTET })).status, 201);
    const made = await call('POST', '/api/submissions', { body: submission(sha) });
    assert.equal(made.status, 201);
    await app.close();

    app = await createApp({ dataFile: file, semantic: null });
    url = await app.listen(0);
    const d = (await call('GET', `/api/submissions/${made.json.id}`, { role: 'reviewer' })).json;
    assert.equal(d.current.image.status, 'retained');
    assert.equal(d.current.image.sha256, sha);
    assert.ok((await call('GET', d.current.image.url, { role: 'reviewer' })).buffer.equals(png), 'the same bytes after a restart');
    assert.deepEqual((await call('GET', '/api/assets/usage')).json.count, 1);

    // a different workspace file has its own directory and cannot see these bytes
    const other = await createApp({ dataFile: path.join(tmp.dir, 'other.json'), semantic: null });
    const otherUrl = await other.listen(0);
    const r = await fetch(`${otherUrl}/api/assets/${sha}`, { headers: { 'x-demo-role': 'creator' } });
    assert.equal(r.status, 404);
    await other.close();
    assert.notEqual(`${file}.assets`, `${path.join(tmp.dir, 'other.json')}.assets`);
  } finally {
    await app.close();
    await tmp.cleanup();
  }
});

// ---------- authenticated mode ----------

test('authenticated: every asset route needs a session; uploads need role, CSRF and Origin; provenance is the real actor', async () => {
  const t = await startAuthApp({ users: ['creator', 'manager', 'reviewer'] });
  try {
    const png = makeStripedPng();
    const sha = sha256Hex(png);
    const anon = t.client();
    assert.equal((await anon.call('GET', `/api/assets/${sha}`)).status, 401);
    assert.equal((await anon.call('GET', '/api/assets/usage')).status, 401);
    assert.equal((await anon.call('POST', '/api/assets', { raw: png, headers: { ...OCTET, 'x-demo-role': 'manager' } })).status, 401);

    const [creator, reviewer] = [await t.as('creator'), await t.as('reviewer')];
    const up = (c, extra = {}) => c.call('POST', '/api/assets', { raw: png, headers: OCTET, ...extra });
    assert.equal((await up(creator, { csrf: null })).status, 403);
    assert.equal((await up(creator, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await up(creator, { origin: null })).status, 403);
    assert.equal((await up(reviewer)).status, 403);
    assert.equal((await up(creator, { headers: { ...OCTET, 'x-demo-role': 'reviewer' } })).status, 201, 'the forged header changes nothing');
    const first = (await up(creator)).json.asset;
    assert.deepEqual(first.createdBy, { id: t.ids.creator, name: 'Synthetic creator', role: 'creator' });

    // a different signed-in person views exactly the retained image
    const got = await reviewer.call('GET', `/api/assets/${sha}`);
    assert.equal(got.status, 200);
    assert.ok(got.buffer.equals(png));
    assert.equal((await t.client().call('GET', `/api/assets/${sha}`, { cookie: 'bp_session=AAAA.BBBB' })).status, 401);
  } finally {
    await t.close();
  }
});

test('authenticated: upload, save, restart, a DIFFERENT reviewer approves the retained image; replacing it makes the approval stale', async () => {
  const t = await startAuthApp({ users: ['creator', 'reviewer'] });
  try {
    const [a, b] = [makeStripedPng(), makeStripedPng({ colors: [[10, 10, 10], [240, 240, 240]] })];
    const [sa, sb] = [sha256Hex(a), sha256Hex(b)];
    let creator = await t.as('creator');
    for (const bytes of [a, b]) assert.equal((await creator.call('POST', '/api/assets', { raw: bytes, headers: OCTET })).status, 201);
    const made = await creator.call('POST', '/api/submissions', { body: submission(sa) });
    assert.equal(made.status, 201, made.text);
    await creator.call('POST', `/api/submissions/${made.json.id}/request-review`, { body: { revision: 1, expected: made.json.workflow.binding } });

    await t.restart();
    const reviewer = await t.as('reviewer');
    const seen = (await reviewer.call('GET', `/api/submissions/${made.json.id}`)).json;
    assert.equal(seen.current.image.status, 'retained');
    assert.ok((await reviewer.call('GET', seen.current.image.url)).buffer.equals(a), 'after a restart the reviewer sees exactly the retained image');
    const ok = await reviewer.call('POST', `/api/submissions/${made.json.id}/approve`, { body: { revision: 1, expected: seen.workflow.binding } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.json.events.at(-1).binding.assetHash, assetHash(asset(sa, { fileSha256: sa })));

    creator = await t.as('creator');
    const rev = await creator.call('POST', `/api/submissions/${made.json.id}/revisions`, { body: { baseRevision: 1, text: cleanContent().text, asset: asset(sb) } });
    assert.deepEqual(rev.json.workflow.staleApproval.reasons, ['asset']);
    assert.equal(rev.json.workflow.status, 'approval_stale');
    // self-review separation still holds: the creator cannot approve their own revision
    const mine = (await creator.call('GET', `/api/submissions/${made.json.id}`)).json;
    assert.equal(mine.workflow.eligibility.approve.selfReview, true);
    // asset files live beside the AUTHENTICATED workspace file, not any demo file
    assert.ok((await readdir(`${t.files.dataFile}.assets`)).some((n) => n === `${sa}.png`));
  } finally {
    await t.close();
  }
});
