// Prints the WCAG 2.x contrast ratio of the app's own main text/background pairs, computed from the ACTUAL custom properties in public/styles.css
// (the :root block, and the prefers-contrast: more block for the increased-contrast variant), so the figures cannot drift from the stylesheet.
// Text pairs need 4.5:1; non-text pairs (focus ring, control borders, severity bars) need 3:1. An engineering self-check of our own palette,
// NOT an accessibility audit or certification. Disabled controls are measured too (they are kept legible on purpose).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastRatio, displayRatio } from '../src/color.js';

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'styles.css'), 'utf8');
const tokensOf = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]));
const root = tokensOf(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
// aliases written as var(--x)
for (const m of css.match(/:root\s*\{([\s\S]*?)\n\}/)[1].matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)\s*;/g)) root[m[1]] = root[m[2]];
const more = tokensOf((css.match(/@media \(prefers-contrast: more\)\s*\{\s*:root\s*\{([^}]*)\}/) ?? [])[1] ?? '');
const lit = { noticeErr: '#5E1A0B' };

const text = (t) => [
  ['body text (walnut) on paper', t.walnut, t.paper],
  ['body text on the dotted ground', t.walnut, t.ground],
  ['muted text on paper', t.muted, t.paper],
  ['muted text on the ground', t.muted, t.ground],
  ['muted text on raised surfaces (table headers, dialog footer)', t.muted, t.raised],
  ['placeholder text (faint) on paper', t.faint, t.paper],
  ['secondary text (walnut-2) on paper', t['walnut-2'], t.paper],
  ['active navigation item (walnut on amber)', t.walnut, t.amber],
  ['hover fill (walnut on amber-pale)', t.walnut, t['amber-pale']],
  ['primary button label (walnut on amber)', t.walnut, t.amber],
  ['primary button hover (walnut on darker amber)', t.walnut, t['amber-hover']],
  ['disabled button label on its hatch', t.muted, t['hatch-b']],
  ['demo tape text (cream on walnut)', t.cream, t.walnut],
  ['demo tape label and link (amber on walnut)', t.amber, t.walnut],
  ['blocked verdict: secondary line (cream-2 on walnut)', t['cream-2'], t.walnut],
  ['blocked verdict: disabled button on the dark hatch', t['cream-2'], t['hatch-dark-a']],
  ['selected tab / pressed filter (cream on walnut)', t.cream, t.walnut],
  ['phone tab bar label (cream on walnut)', t.cream, t.walnut],
  ['phone tab bar hover (cream on walnut-2)', t.cream, t['walnut-2']],
  ['in-review verdict: muted line on sage-pale', t.muted, t['sage-pale']],
  ['approved verdict and approved tag (walnut on sage)', t.walnut, t.sage],
  ['re-review verdict: muted line on amber-pale', t.muted, t['amber-pale']],
  ['exhibit label (walnut on sage)', t.walnut, t.sage],
  ['error text on paper', t.err, t.paper],
  ['error status pair', t.err, t['err-bg']],
  ['warning status pair', t.warn, t['warn-bg']],
  ['success status pair', t.ok, t['ok-bg']],
  ['needs-review / in-review tag', t.review, t['review-bg']],
  ['neutral / legacy tag', t.neutral, t['neutral-bg']],
  ['registered-source tag (sage-deep on sage-pale)', t['sage-deep'], t['sage-pale']],
  ['blocking tag (cream on walnut)', t.cream, t.walnut],
  ['warning tag (walnut on amber)', t.walnut, t.amber],
  ['notice: error', lit.noticeErr, t['err-bg']],
  ['notice: info (walnut on sage-pale)', t.walnut, t['sage-pale']],
  ['toast: neutral (cream on walnut)', t.cream, t.walnut],
  ['toast: error (cream on err)', t.cream, t.err],
  ['toast: success (cream on sage-deep)', t.cream, t['sage-deep']],
];
const nonText = (t) => [
  ['focus ring (walnut) against paper', t.focus, t.paper],
  ['focus ring (walnut) against the ground', t.focus, t.ground],
  ['focus ring (walnut) against amber (selected nav, primary button)', t.focus, t.amber],
  ['focus ring on dark surfaces (amber) against walnut', t['focus-dark'], t.walnut],
  ['control border (walnut) against paper', t['line-strong'], t.paper],
  ['box rule and hard shadow (walnut) against the ground', t.line, t.ground],
  ['severity bar: blocking (walnut) against paper', t.walnut, t.paper],
  ['severity bar: warning (amber) against its walnut frame', t.amber, t.walnut],
  ['severity bar: needs review (sage-deep) against paper', t['sage-deep'], t.paper],
  ['progress bar fill (sage-deep) against paper', t['sage-deep'], t.paper],
  ['cited-passage outline (sage-deep) against paper', t['sage-deep'], t.paper],
];

let low = 0;
let total = 0;
const run = (title, rows, need) => {
  console.log(`\n${title}`);
  for (const [name, fg, bg] of rows) {
    const r = displayRatio(contrastRatio(fg, bg));
    const ok = r >= need;
    total++;
    if (!ok) low++;
    console.log(`${ok ? 'ok  ' : 'LOW '} ${String(r).padEnd(6)} ${name}  (${fg} on ${bg})`);
  }
};
run('Text pairs, default appearance (need 4.5:1)', text(root), 4.5);
run('Non-text pairs, default appearance (need 3:1)', nonText(root), 3);
if (Object.keys(more).length) {
  const inc = { ...root, ...more };
  run('Text pairs, prefers-contrast: more (need 4.5:1)', text(inc), 4.5);
  run('Non-text pairs, prefers-contrast: more (need 3:1)', nonText(inc), 3);
}
console.log(`\n${total - low} of ${total} pairs meet their threshold. Computed from public/styles.css; normal-size text; not an audit.`);
process.exit(low ? 1 : 0);
