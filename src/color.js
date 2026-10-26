/** Colour maths: WCAG 2.x contrast ratio and CIE76 colour distance. */

export function normalizeHex(s) {
  if (typeof s !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return '#' + h.toUpperCase();
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex);
  if (!h) throw new Error('Invalid hex colour: ' + hex);
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const linear = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Ratio rounded DOWN to 2dp so a failing 4.499 never displays as a passing-looking 4.50. */
export const displayRatio = (r) => Math.floor(r * 100) / 100;

export function rgbToLab([r8, g8, b8]) {
  const [r, g, b] = [r8, g8, b8].map(linear);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(hexA, hexB) {
  const a = rgbToLab(hexToRgb(hexA));
  const b = rgbToLab(hexToRgb(hexB));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function nearestColor(hex, palette) {
  let best = null;
  for (const c of palette) {
    const d = deltaE(hex, c.hex);
    if (!best || d < best.deltaE) best = { color: c, deltaE: d };
  }
  return best;
}
