import zlib from 'node:zlib';

/** Tiny PNG writer for tests and the browser walkthrough. All images it makes are synthetic and fictional. */
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function ihdr({ width, height, bitDepth = 8, colorType = 2, interlace = 0 }) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = bitDepth;
  d[9] = colorType;
  d[12] = interlace;
  return d;
}

const passesOf = (w, h, interlace) => (interlace ? ADAM7.map(([x0, y0, dx, dy]) => [Math.ceil((w - x0) / dx), Math.ceil((h - y0) / dy)]).filter(([a, b]) => a > 0 && b > 0) : [[w, h]]);

/** Raw filtered scanlines (filter 0) with a repeating byte pattern taken from `pixel`. */
export function rawScanlines({ width, height, bitDepth = 8, colorType = 2, interlace = 0, pixel = [30, 60, 90] }) {
  const bits = CHANNELS[colorType] * bitDepth;
  const rows = [];
  for (const [pw, ph] of passesOf(width, height, interlace)) {
    const rowBytes = Math.ceil((pw * bits) / 8);
    for (let y = 0; y < ph; y++) {
      const row = Buffer.alloc(1 + rowBytes);
      for (let i = 0; i < rowBytes; i++) row[1 + i] = pixel[i % pixel.length];
      rows.push(row);
    }
  }
  return Buffer.concat(rows);
}

/** A valid PNG. `idatSplit` makes several IDAT chunks. `extra` are ancillary chunks placed before IDAT. */
export function makePng({ width = 16, height = 16, bitDepth = 8, colorType = 2, interlace = 0, pixel = [30, 60, 90], idatSplit = 1, extra = [], palette } = {}) {
  const raw = rawScanlines({ width, height, bitDepth, colorType, interlace, pixel });
  const z = zlib.deflateSync(raw);
  const size = Math.ceil(z.length / idatSplit);
  const idats = [];
  for (let i = 0; i < z.length; i += size) idats.push(chunk('IDAT', z.subarray(i, i + size)));
  const pl = colorType === 3 ? [chunk('PLTE', palette ?? Buffer.from([0, 0, 0, 255, 255, 255, 200, 30, 30, 30, 200, 30]))] : [];
  return Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height, bitDepth, colorType, interlace })), ...pl, ...extra, ...idats, chunk('IEND')]);
}

/** Vertical stripes in the given RGB colours: a recognisable fictional "campaign image". */
export function makeStripedPng({ width = 240, height = 120, colors = [[15, 42, 67], [27, 156, 143], [242, 169, 59]] } = {}) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const c = colors[Math.floor((x * colors.length) / width)];
      row[1 + x * 3] = c[0];
      row[2 + x * 3] = c[1];
      row[3 + x * 3] = c[2];
    }
    rows.push(row);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height })), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND')]);
}

/** Deliberately broken variants, each a realistic way for an upload to be wrong. */
export const broken = {
  truncated: (png) => png.subarray(0, png.length - 20),
  /** Only the stored checksum of the header chunk is wrong; every byte of data is intact. */
  crcOnly: (png) => {
    const b = Buffer.from(png);
    b[8 + 4 + 4 + 13 + 3] ^= 0x01;
    return b;
  },
  badCrc: (png) => {
    const b = Buffer.from(png);
    b[b.length - 20] ^= 0xff; // inside the last IDAT/IEND region
    return b;
  },
  trailing: (png) => Buffer.concat([png, Buffer.from('garbage after the end')]),
  noEnd: (png) => png.subarray(0, png.length - 12),
  /** A tiny file whose compressed data expands to far more than its header allows. */
  bomb: ({ width = 8, height = 8 } = {}) => {
    const bigRaw = Buffer.alloc(30 * 1024 * 1024);
    return Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height })), chunk('IDAT', zlib.deflateSync(bigRaw, { level: 9 })), chunk('IEND')]);
  },
  badFilter: ({ width = 4, height = 4 } = {}) => {
    const raw = rawScanlines({ width, height });
    raw[0] = 9;
    return Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height })), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND')]);
  },
  shortData: ({ width = 8, height = 8 } = {}) => {
    const raw = rawScanlines({ width, height }).subarray(0, 40);
    return Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height })), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND')]);
  },
  /** Header claims dimensions; only the header is checked before it is refused. */
  dims: (width, height) => Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height })), chunk('IDAT', zlib.deflateSync(Buffer.alloc(8))), chunk('IEND')]),
  criticalUnknown: () => makePng({ extra: [chunk('ZZZZ', Buffer.from('x'))] }),
  animated: () => makePng({ extra: [chunk('acTL', Buffer.alloc(8))] }),
  missingPalette: () => {
    const raw = rawScanlines({ width: 4, height: 4, colorType: 3, pixel: [0] });
    return Buffer.concat([SIG, chunk('IHDR', ihdr({ width: 4, height: 4, colorType: 3 })), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND')]);
  },
};

export const jpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]);
export const svgText = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const htmlText = Buffer.from('<!doctype html><script>alert(1)</script>');
/** PNG signature followed by nothing valid: a magic prefix alone must not be enough. */
export const sigOnly = Buffer.concat([SIG, Buffer.alloc(200, 7)]);

/** Incompressible pixel data (deterministic noise), for tests that need a large file from a small image. */
export function makeNoisePng({ width = 40, height = 40, seed = 1 } = {}) {
  let x = seed >>> 0 || 1;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < row.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      row[i] = x & 0xff;
    }
    rows.push(row);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr({ width, height })), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND')]);
}
