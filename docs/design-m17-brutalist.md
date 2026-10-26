# Design m17: brutalist sage, walnut and amber

The user asked for a new look built from three colours (sage green, walnut brown, amber glow), "creative design styles" and "some brutalism design language". It was designed first as a 17-board canvas, reviewed against the Apple design skill, and then implemented in the real app (`public/`). This replaces the m16 "framed sheet" look ([design-pass.md](design-pass.md)) and keeps all of its behaviour. Everything below was measured on **synthetic, isolated data**. The preserved demo data and the main data were never opened.

## 1. The language

| Role | Colour | Where |
|---|---|---|
| Structure and blocking | walnut `#2B1D15` | 3px rules around every box, hard offset shadows, text, the blocked verdict band, blocking tags, the selected tab, the demo tape, the phone tab bar |
| Attention and the one primary action | amber `#FFB52E` (pale `#FFE6AE`) | the primary button, the current navigation item, warnings, the "NOT READY" stamp, highlighted claims (pale) |
| Proof | sage `#9CB38D` (deep `#34513A`, pale `#D8E5CD`) | exhibit headers, approved tags and the approved verdict, cited passages, registered-source tags |
| Ground and paper | `#E3E9DA` with a dotted grid; paper `#FFFCF4` | the page, and the boxes on it |

- **Type** is self-hosted: Archivo Black for display, Archivo (variable, 400 to 800) for text, and Space Mono for labels, tags and numbers. The four latin `woff2` files total 87 KB, live in `public/` and are served by this server (`font/woff2` was added to the static type map in `src/app.js`; the CSP `default-src 'self'` already allows same-origin fonts). Licences are in `docs/licenses/` (SIL OFL 1.1). If the files do not load, fallbacks are named (Arial Black or Segoe UI Black; Segoe UI or system-ui; Consolas). No CDN is used and no request leaves the machine.
- **Brutalist moves.** Square corners everywhere. 3px walnut rules. Shadows are solid offset blocks with zero blur: 4px for buttons, 6px for boxes, 8px for the verdict band, and 10px for dialogs. A button presses into its shadow (`:active` moves it 4px), and under reduced motion the shadow collapses without the movement. Disabled buttons are hatched and dashed, not faded.
- **Creative moments.** Each one carries information.
  - **The verdict band** is the old decision bar. Its look follows the workflow state (`data-state` on `.flow`): blocked is a walnut band with an amber shadow; ready and draft are paper; in review is sage-pale; approved is sage; re-review is amber-pale with a dashed rule; rejected has a 5px rule.
  - **A rubber stamp** repeats the state in one word: NOT READY, READY, DRAFT, IN REVIEW, APPROVED, RE-REVIEW or REJECTED. It is CSS generated content with empty alternative text (`content: "…" / ""`), so screen readers skip it. The sentence in the band carries the meaning.
  - **Exhibits.** Each finding's evidence block is lettered by a CSS counter (EXHIBIT A, B…), with a sage header and the source passage on ruled paper. The source view's full text is on ruled paper too.
  - **The demo tape** is a walnut strip across the top, with the demo label in amber.
- **Navigation.** On a desk it is a top bar: the mark, boxed navigation segments with the current one in amber, and the role picker. At 1200px and below, the navigation becomes its own full-width row. At 600px and below it is a walnut **tab bar fixed to the bottom edge**: five sections with icons, the current one in amber, and the queue count as a badge. The page and the toasts clear it. This was the Apple review's top finding on the canvas: on a phone, top-level navigation belongs in a tab bar.
- **Dialogs** are 4px walnut boxes on a 10px shadow. On a phone they rise from the bottom edge as a sheet. The approve dialog's warning acknowledgement is an amber slip.

## 2. What the canvas review changed, and what it did not

The Apple design review of the canvas (rating Good) was folded in where CSS alone could do it:
- the bottom tab bar
- verdict states for every workflow state
- focus on every surface (3px walnut; amber on walnut surfaces)
- a press state
- rem sizes, with a 17px body on phones
- one meaning per colour (sage is proof and nothing else, so the old teal-means-four-things limitation is gone)
- control borders at full walnut strength (15.9:1 against paper, up from 3.14:1)

**Not changed, because each would change behaviour, not the look:**
- The Approve button in the approve dialog still works before the warning box is ticked. It shows an error and does not approve, exactly as before. The canvas showed it disabled until the box is ticked.
- The role picker stays in the top bar. The canvas put it in a phone "demo settings" sheet.
- The submission selector and the breadcrumb markup are unchanged.

## 3. Files

- `public/styles.css`: rewritten. Every class name and the m15 reflow and touch rules are kept. Reduced motion and increased contrast are handled. Increased contrast darkens secondary text and hairlines, drops the dotted ground, flattens the hatch and makes dashed rules solid.
- `public/workspace.js`: one attribute. `flowBar()` sets `data-state` (blocked, ready, draft, in_review, approved, approval_stale, rejected). No text, order or button logic changed.
- `src/app.js`: one line, `'.woff2': 'font/woff2'` in the static type map. No other server change.
- `public/archivo.woff2`, `archivo-black.woff2`, `space-mono-400.woff2`, `space-mono-700.woff2`, and `docs/licenses/OFL-*.txt`: new.
- `scripts/ui-contrast.mjs`: pairs rewritten for the new tokens, 48 pairs and 96 with the increased-contrast variant.
- `scripts/browser/ui-smoke-design.mjs`: updated, now 31 checks. The old "no shadow at rest" rule became "no blurred shadow anywhere" plus a check that boxes do sit on a hard shadow. The focus ring check is now 3px walnut, or amber on walnut, and must pass through the dark band. New checks cover the stamp and its empty alternative text, lettered exhibits, the self-hosted fonts loading with no remote request, the phone tab bar, and the last control on a phone page staying above the tab bar.

## 4. Measured

The ratios are computed by `npm run ui-contrast` from the real tokens.

| Check | Result |
|---|---|
| Contrast pairs | **96 of 96** pass: 37 text pairs at 4.5:1 or more and 11 non-text pairs at 3:1 or more, each also under increased contrast. Lowest text pair: the disabled label on its hatch, 5.9:1. |
| Focus ring | walnut on paper 15.9:1; on the ground 13.1:1; walnut on amber 9.2:1; amber on walnut 9.2:1 |
| Primary button label (walnut on amber) | 9.2:1 |
| Disabled label on its hatch | 5.9:1 light; cream-2 on the dark hatch 8.3:1 |
| `ui-smoke-design` | **31/31**, including: one primary action; no blur anywhere; the NOT READY stamp hidden from screen readers; exhibits lettered; fonts loaded from this server with 0 remote requests; the phone tab bar fixed at the bottom with every section on screen; 44px targets on campaign, queue, source, library and the editor; 14 real Tab stops each with a solid 3px ring of the right colour; no sideways scroll at 200% text size or at 720, 360 and 320px; reduced motion and increased contrast honoured under emulation |
| `ui-smoke-layout` (m15 overflow regression) | **57/57** at 320, 390, 768 and 1360 across 11 views, including Tab through every navigation link with each one fully visible |
| Regression | see the handoff (`handoffs/m17-brutalist-design.md`) for the run on the final code |

Screenshots of the same isolated workspace at 1440, 768, 390 and 320px are in `docs/evidence/design-m17-<width>-<view>.png`, with the focus ring in `design-m17-focus-ring.png`.

## 5. Limitations, candidly

- **Brutalism overrides some of the Taste skill's house rules** used in m16: hard shadows, zero radius, monospace labels and a strong walnut band. That was the user's explicit request, and the Taste lint would now flag those choices. Accessibility still gates: contrast, targets, focus, reflow and motion.
- **Light appearance only.** No dark theme is offered or claimed. Increased contrast and reduced motion were checked by emulation and computed pairs, not by a person using a system setting.
- **The phone tab bar fits five sections.** With an owner account, a sixth (People) narrows each one to about 53px at 320px wide. The labels wrap to two lines at 11px, which is the floor.
- **Labels are not upper-cased by CSS** except the role label above the picker and in the generated stamp and exhibit text. Several tests read visible text, and screen readers can spell out upper-cased text letter by letter. The logo line under "BrandProof" shows the team name in its exact spelling and case (bhangaledhruv7), so it is deliberately not upper-cased.
- **Measured on headless Edge only**, with device emulation. No real phone, Safari, Firefox or screen reader was used. `:has()` styles the acknowledgement slip in the approve dialog; a browser without it shows a plain row, and the dialog still works.
- **Fonts are the latin subset.** Other scripts fall back to system fonts glyph by glyph.

## 6. Reproduce

```
npm run ui-smoke-design                                   # 31 checks, isolated synthetic data
npm run ui-contrast                                       # 96 pairs from public/styles.css
npm run ui-smoke-layout                                   # 57 checks, the m15 overflow regression
node scripts/browser/design-evidence.mjs --tag m17        # docs/evidence/design-m17-<width>-<view>.png
```
