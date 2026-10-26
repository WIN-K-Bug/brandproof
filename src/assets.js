/**
 * Persistent campaign images.
 *
 * Architecture (documented in docs/assets.md):
 *  - Image bytes live in a content-addressed directory NEXT TO the workspace file (`<workspace file>.assets/<sha256>.png`),
 *    so the two modes (demo / authenticated) and different workspaces never share bytes.
 *  - The workspace state keeps a REGISTRY (`state.assets[sha256]`): bytes, dimensions, who uploaded and when. A revision
 *    refers to an image only by its server-computed SHA-256 (`asset.retainedSha256`). The reference is immutable: it is
 *    the hash of the bytes, so the bytes cannot change under it, and the hash is part of the approval binding.
 *  - Upload order: validate -> write blob (temp file, fsync, rename) -> register in the serialised store write. Uploads are
 *    single-flight, so quota checks cannot race. If registration fails the blob is removed again (only if it was new), so
 *    nothing unregistered stays on disk and nothing registered is ever missing its bytes. A crash between the two steps can
 *    leave an unregistered orphan file: it is never served, never counted and never referenced.
 *  - Nothing is ever deleted once registered (history keeps its images). There is no garbage collection in this slice.
 *
 * Validation is server-side and ignores everything the client says (name, type, digest, dimensions): PNG only; signature,
 * chunk structure and order, every chunk CRC, IHDR limits, palette rules, the zlib stream (bounded, fully consumed, exact
 * decompressed size) and every scanline filter byte are checked. Pixels are not reconstructed and no colour is extracted. (Reading text from a retained image is a separate, optional, human-confirmed feature: see src/ocr.js.)
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HttpError } from './util.js';

export const ASSET_LIMITS = {
  imageBytes: 2 * 1024 * 1024,
  maxDimension: 4096,
  maxPixels: 4_000_000,
  maxRawBytes: 40 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  count: 200,
  chunks: 1000,
};

export const SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const bad = (code, message, status = 422) => new HttpError(status, code, message);

/** Passes as [width, height] of each scanline group; non-interlaced is one pass. */
function passes(w, h, interlace) {
  if (!interlace) return [[w, h]];
  return ADAM7.map(([x0, y0, dx, dy]) => [Math.ceil((w - x0) / dx), Math.ceil((h - y0) / dy)]).filter(([pw, ph]) => pw > 0 && ph > 0);
}

/** Throws a 422 HttpError describing why `buf` is not an acceptable PNG; returns { width, height, ... } when it is. */
export function validatePng(buf, limits = ASSET_LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw bad('asset_invalid', 'No image data was sent.');
  if (buf.length > limits.imageBytes) throw bad('asset_too_large', `The image is larger than the ${Math.round(limits.imageBytes / 1024)} KB limit.`, 413);
  if (buf.length < SIGNATURE.length + 12 + 13 + 12 || !buf.subarray(0, 8).equals(SIGNATURE)) throw bad('asset_invalid', 'This is not a PNG image. Only PNG is accepted.');

  let pos = 8;
  let ihdr = null;
  let plte = false;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  let chunks = 0;
  const idat = [];

  while (pos < buf.length) {
    if (sawIend) throw bad('asset_invalid', 'The PNG has data after its end marker.');
    if (++chunks > limits.chunks) throw bad('asset_invalid', 'The PNG has too many chunks.');
    if (pos + 12 > buf.length) throw bad('asset_truncated', 'The PNG is truncated.');
    const len = buf.readUInt32BE(pos);
    if (len > 0x7fffffff || pos + 12 + len > buf.length) throw bad('asset_truncated', 'The PNG is truncated or a chunk length is wrong.');
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw bad('asset_invalid', 'The PNG contains a malformed chunk name.');
    if (type.charCodeAt(2) & 0x20) throw bad('asset_invalid', 'The PNG contains a reserved chunk.');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crc = buf.readUInt32BE(pos + 8 + len);
    if (zlib.crc32(buf.subarray(pos + 4, pos + 8 + len)) !== crc) throw bad('asset_invalid', `The PNG is corrupted (bad checksum in ${type}).`);

    if (chunks === 1 && type !== 'IHDR') throw bad('asset_invalid', 'The PNG does not start with its header chunk.');
    if (type === 'IHDR') {
      if (chunks !== 1 || len !== 13) throw bad('asset_invalid', 'The PNG header is malformed.');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const [bitDepth, colorType, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (!width || !height) throw bad('asset_invalid', 'The PNG has no pixels.');
      if (width > limits.maxDimension || height > limits.maxDimension) throw bad('asset_too_large', `Each side may be at most ${limits.maxDimension} pixels.`, 413);
      if (width * height > limits.maxPixels) throw bad('asset_too_large', `The image may have at most ${limits.maxPixels.toLocaleString('en-US')} pixels.`, 413);
      if (!DEPTHS[colorType]?.includes(bitDepth)) throw bad('asset_invalid', 'The PNG colour type and bit depth are not valid.');
      if (compression !== 0 || filter !== 0 || interlace > 1) throw bad('asset_invalid', 'The PNG uses an unsupported method.');
      ihdr = { width, height, bitDepth, colorType, interlace };
    } else if (type === 'PLTE') {
      if (plte || sawIdat) throw bad('asset_invalid', 'The PNG palette is misplaced.');
      if (len === 0 || len % 3 !== 0 || len / 3 > 2 ** ihdr.bitDepth || [0, 4].includes(ihdr.colorType)) throw bad('asset_invalid', 'The PNG palette is not valid.');
      plte = true;
    } else if (type === 'IDAT') {
      if (idatEnded) throw bad('asset_invalid', 'The PNG image data is split by another chunk.');
      sawIdat = true;
      idat.push(data);
    } else if (type === 'IEND') {
      if (len !== 0 || !sawIdat) throw bad('asset_invalid', 'The PNG end marker is malformed.');
      sawIend = true;
    } else {
      if (!(type.charCodeAt(0) & 0x20)) throw bad('asset_invalid', `The PNG needs a feature this app does not support (${type}).`);
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw bad('asset_invalid', 'Animated PNG is not supported.');
      if (sawIdat) idatEnded = true;
    }
    if (type !== 'IDAT' && sawIdat) idatEnded = true;
    pos += 12 + len;
  }
  if (!sawIend) throw bad('asset_truncated', 'The PNG is truncated (no end marker).');
  if (ihdr.colorType === 3 && !plte) throw bad('asset_invalid', 'The PNG is missing its palette.');

  // The compressed image data must be ONE well-formed zlib stream that decodes to exactly the right number of scanline bytes.
  const bits = CHANNELS[ihdr.colorType] * ihdr.bitDepth;
  const groups = passes(ihdr.width, ihdr.height, ihdr.interlace);
  const expected = groups.reduce((n, [pw, ph]) => n + ph * (1 + Math.ceil((pw * bits) / 8)), 0);
  if (expected > limits.maxRawBytes) throw bad('asset_too_large', 'The decoded image would be too large.', 413);
  const compressed = Buffer.concat(idat);
  let raw;
  try {
    const out = zlib.inflateSync(compressed, { maxOutputLength: expected + 1, info: true });
    raw = out.buffer;
    if (out.engine.bytesWritten !== compressed.length) throw new Error('trailing data');
  } catch (e) {
    if (e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) throw bad('asset_invalid', 'The PNG image data expands to more than its header allows.');
    throw bad('asset_truncated', 'The PNG image data is truncated or corrupted.');
  }
  if (raw.length !== expected) throw bad('asset_truncated', 'The PNG image data is shorter than its header says.');
  let at = 0;
  for (const [pw, ph] of groups) {
    const row = 1 + Math.ceil((pw * bits) / 8);
    for (let y = 0; y < ph; y++, at += row) if (raw[at] > 4) throw bad('asset_invalid', 'The PNG has an invalid scanline filter.');
  }
  return { width: ihdr.width, height: ihdr.height, bitDepth: ihdr.bitDepth, colorType: ihdr.colorType, interlaced: Boolean(ihdr.interlace), mime: 'image/png' };
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------- blob directory ----------

export class AssetStore {
  /** `fsApi` is a test seam (to inject partial-write, fsync, close or rename failures). The app always uses the real filesystem. */
  constructor(dir, { fsApi = fs } = {}) {
    this.dir = dir;
    this.fs = fsApi;
  }
  path(sha) {
    if (!SHA256.test(sha)) throw new Error('invalid asset reference');
    return path.join(this.dir, `${sha}.png`);
  }
  /**
   * Reads the retained file and checks it against its digest and recorded size (real integrity, not a size check).
   * Returns 'ok' | 'missing' | 'corrupt' | 'unavailable'. This is a point-in-time check: it cannot stop someone with
   * access to the folder from changing a file afterwards, only detect it the next time bytes are used.
   */
  async verify(sha, bytes) {
    let buf;
    try {
      buf = await this.fs.readFile(this.path(sha));
    } catch (e) {
      return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'missing' : 'unavailable';
    }
    return buf.length === bytes && sha256Hex(buf) === sha ? 'ok' : 'corrupt';
  }
  /**
   * Temp file + fsync + rename (which replaces any damaged file of the same name in one step). The temp file is removed
   * if ANYTHING fails before the rename completes: open, write, fsync, close or rename.
   */
  async write(sha, buf) {
    await this.fs.mkdir(this.dir, { recursive: true });
    const final = this.path(sha);
    const tmp = path.join(this.dir, `.${sha}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fh = await this.fs.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(buf);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await this.fs.rename(tmp, final);
    } catch (e) {
      await this.fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  async read(sha) {
    return this.fs.readFile(this.path(sha));
  }
  async remove(sha) {
    await this.fs.rm(this.path(sha), { force: true });
  }
}

// ---------- registry (inside the serialised workspace state) ----------

export const registryOf = (state) => state.assets ?? {};
export const retainedEntry = (state, sha) => (sha ? registryOf(state)[sha] : undefined);

export function usage(state) {
  const all = Object.values(registryOf(state));
  return { count: all.length, bytes: all.reduce((n, a) => n + a.bytes, 0) };
}

export function checkQuota(state, bytes, limits = ASSET_LIMITS) {
  const u = usage(state);
  if (u.count + 1 > limits.count) throw bad('asset_quota', `This workspace already holds the maximum of ${limits.count} images. Images are kept for history and cannot be deleted in this version.`, 413);
  if (u.bytes + bytes > limits.totalBytes) throw bad('asset_quota', `This workspace's image storage (${Math.round(limits.totalBytes / 1048576)} MB) is full. Images are kept for history and cannot be deleted in this version.`, 413);
}

/** Quota check + registration. Called inside Store.mutate, so it is atomic with every other change. */
export function registerAsset(d, info, limits = ASSET_LIMITS) {
  d.assets ??= {};
  const existing = d.assets[info.sha256];
  if (existing) return { entry: existing, created: false };
  checkQuota(d, info.bytes, limits);
  const entry = { sha256: info.sha256, bytes: info.bytes, width: info.width, height: info.height, mime: 'image/png', createdAt: info.now, createdBy: info.who };
  d.assets[info.sha256] = entry;
  return { entry, created: true };
}

/** What a revision's image is, for display: retained (bytes held here), metadata_only (name/fingerprint only) or none. */
export function describeImage(state, asset) {
  const sha = asset.retainedSha256;
  if (sha) {
    const e = retainedEntry(state, sha);
    return e
      ? { status: 'retained', sha256: sha, bytes: e.bytes, width: e.width, height: e.height, mime: e.mime, url: `/api/assets/${sha}`, uploadedBy: e.createdBy, uploadedAt: e.createdAt }
      : { status: 'missing', sha256: sha };
  }
  if (asset.name || asset.fileSha256) {
    return { status: 'metadata_only', note: 'Only a file name and a fingerprint reported by the browser were saved. The image itself is not retained, so it cannot be shown or checked.' };
  }
  return { status: 'none' };
}

/**
 * Single-flight upload: validate, write the blob, register. Returns { entry, created }.
 * `actorInfo` = { who, now }. Throws HttpError (never leaves an unregistered new blob behind).
 */
export function createUploader({ store, blobs, limits = ASSET_LIMITS }) {
  let chain = Promise.resolve();
  const run = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  return {
    upload(buf, { who, now }) {
      return run(async () => {
        const info = validatePng(buf, limits);
        const sha = sha256Hex(buf);
        const known = retainedEntry(store.state, sha);
        if (known) {
          // Same bytes as an image we already retain. If the stored file is missing, unreadable or damaged (same size or not),
          // replace it with the bytes just received (they were validated and hash to the registered digest). The rename is
          // atomic, so a reader sees the old file or the restored one, never a mixture.
          const state = await blobs.verify(sha, known.bytes);
          if (state !== 'ok') {
            try {
              await blobs.write(sha, buf);
            } catch {
              throw new HttpError(503, 'asset_storage_failed', 'The image could not be restored in storage. Nothing was changed.');
            }
          }
          return { entry: known, created: false, restored: state === 'ok' ? null : state };
        }
        checkQuota(store.state, buf.length, limits); // refuse before any bytes are written
        try {
          await blobs.write(sha, buf);
        } catch {
          throw new HttpError(503, 'asset_storage_failed', 'The image could not be stored. Nothing was saved.');
        }
        try {
          return await store.mutate((d) => registerAsset(d, { sha256: sha, bytes: buf.length, ...info, now, who }, limits));
        } catch (e) {
          await blobs.remove(sha).catch(() => {}); // the blob was new and is not registered: do not leave it behind
          if (e instanceof HttpError) throw e;
          throw new HttpError(503, 'asset_storage_failed', 'The image could not be recorded. Nothing was saved.');
        }
      });
    },
  };
}
