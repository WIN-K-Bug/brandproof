# Visual design pass: an evidence review desk

> **Superseded look (m17).** This is the m16 report and stays as the record of that pass. At the user's request the look was later replaced by a brutalist sage / walnut / amber design with self-hosted fonts; see [design-m17-brutalist.md](design-m17-brutalist.md). The m16 behaviour (one primary action, the reading order of the decision bar, the evidence block under each claim, 44px touch targets, reflow) carries over unchanged.

One bounded pass over the existing vanilla HTML/CSS/JS app (no framework, backend, storage, identity, CDN, font download or data change), done with the two design skills the user named: **Taste Skill** (`Leonxlnx/taste-skill`, tasteskill.dev) and **Apple Design** (`dickwu/apple-design-skill`, including its `SKILL.md`). One coherent pass, then three review-and-fix rounds. Everything below was measured on **synthetic, isolated data** (a temp workspace built by the showcase bootstrap plus two synthetic campaigns that carry a retained image); the preserved demo data and the main data were never opened.

## 1. Tools used, and what they could not do

| Item | What was done |
|---|---|
| Install | `npx skills add Leonxlnx/taste-skill -s design-taste-frontend -a claude-code -y --copy` and `npx skills add dickwu/apple-design-skill -s apple-design -a claude-code -y --copy` after `--help` and `-l` (list) on both repositories. Neither `.claude/` nor `.agents/` existed, so nothing could be overwritten. Installed to `.claude/skills/design-taste-frontend` and `.claude/skills/apple-design`; `skills-lock.json` records the source and content hash of each (taste `65049e18…`, apple `91293554…`). Seven installed files (SKILL.md, app-screens.md, inspect.mjs, draw.mjs, lint.mjs and app.json for Taste; SKILL.md and accessibility.md for Apple) were compared with local reference copies that were read first: identical apart from line endings. |
| Read in full | Taste `SKILL.md`; Taste `references/app-screens.md` (all 1,200 lines: the app-screen run, shells, sidebar, canvas, KPIs, charts, tables, forms, type and colour, density, states, the phone, house rules, tells). The page run in `SKILL.md` was not used: this is an app screen, not a landing page. Apple `SKILL.md`. |
| Apple references read | `accessibility.md`, `color.md`, `typography.md`, `layout.md`, `cross-platform.md`, `sidebars.md`, `buttons.md`, `feedback.md`, `entering-data.md`, `lists-and-tables.md`, `loading.md`, `designing-for-macos.md`. Apple's platform conventions are applied as web principles (see `cross-platform.md`): no macOS chrome was imitated. |
| Taste draw | `draw.mjs --app --kind support --screens detail,list,inbox --theme light --keep palette,type --options 3`, then `--style framed-sheet`. **Only two styles were dealt** (achromatic-ledger, framed-sheet): the tool said "2 app styles dealt for this brief". Sheet and seed: `docs/evidence/design-tools/taste-direction-framed-sheet.json`, **seed 1266659771**. |
| Taste inspect and lint | `inspect.mjs --app <url> --out …` before and after on seven routes; `lint.mjs --app public` before and after. Reports are in `docs/evidence/design-tools/`. |
| Not supported or not used, plainly | The inspector opens one URL at 1440, 768 and 390 only (not 320) and does not click, so the editor, the OCR draft, dialogs and focus states were photographed by our own CDP script (`scripts/browser/design-evidence.mjs`). It counted a list named `.timeline` (the source history) as a chart (`no-data-hue`, a false positive: the app draws no data charts). Its critique scoring (`references/critique.md`) is built for pages with pictures and motion; for an app screen the seven written questions in `app-screens.md` §2.7 were answered instead. `assets.mjs`, the scroll scenes and the motion layer do not apply to an app screen. `draw.mjs --theme dark` was not used (see limitations). No orchestrator browser tool was used. |

## 2. Direction

- **Product question.** What prevents this campaign from being responsibly approved, and what exact evidence resolves it?
- **Style: `framed-sheet`** (light), chosen over `achromatic-ledger` because reviewers work in long sessions across a queue, a campaign and its source passage, and the style's one move (a single tinted L-shaped frame holding the navigation, the work on a white sheet with a 1px edge and no shadow) gives the neutral frame the brief asks for, while keeping teal to the primary action. `--keep palette,type`: the product's teal and ink stay, and the type stays the system stack (`Segoe UI`, `system-ui`), which is also the only option that downloads nothing.
- **Its face** (chosen before any markup): the frame tinted one low-chroma step from the product's hue (`#eef2f4`) in place of the kit's `#f9fbfc`.
- **Signature element: the evidence annotation.** In every finding the approved fact and the exact source passage form one block (a 3px teal rule, a pale teal tint, the registered-source chip, the quoted passage and the link that opens it highlighted), sitting directly under the claim it explains. It is only a restyling of data the app already had.
- **Each screen's one question.** Campaign: *what stops approval and what is the next step?* (the decision bar and the findings). Review queue: *which campaign needs a decision or re-review next?* Source view: *is the cited passage still there, and who approved this version?* Dossier: *what exactly was reviewed and does it still apply?*

## 3. Audit before (screenshots `docs/evidence/design-before-<width>-<view>.png`)

1. **Heavy chrome.** A dark navy sidebar against a light canvas (Taste: 0 of 17 studied light screens; §9.2), a beige banner, a breadcrumb bar and a selector row before any content; on a phone about 470 px before the page title.
2. **No single next action.** A filled teal "Edit as new revision" in the copy card, a pale-teal disabled "Approve…" and "Request review" all competed; the lead question ("what stops approval") was never stated.
3. **Flat finding card.** The claim, fact, source label, source quote and link were equal-weight text; the connection between the claim and its exact passage was the product's best idea and the least visible.
4. **Tells.** Tracked uppercase micro-labels (BLOCKING, SOURCE, table headers, "BY 4MUSKETEERS"), left-aligned numeric columns, a gradient logo, an indigo status colour, a dingbat close glyph, resting shadows on every card.
5. **Weak interaction signals.** Focus ring `#2dd4bf` at 1.86:1 on white; control borders 1.62:1; disabled buttons shown as 50% opacity (about 2.1:1).
6. **Phone.** Controls 30 to 38 px high, a queue table that lost its identity column when scrolled, filter chips wrapping to three rows.

## 4. What changed (the three biggest effects)

**(1) Shell, navigation and typography.** One neutral frame (`--frame #eef2f4`) holds a light sidebar and the top bar; the active nav item is a neutral grey pill (not a coloured bar); counts are neutral chips; the page is a white sheet with a 1px edge, 14px radius, inset 8px from the right and bottom; the demo banner is one quiet line. A flat teal logo mark (no gradient). Sentence-case labels everywhere, a 22px/650 page title, sizes in `rem` so the browser's text-size setting scales them, system fonts only. On a phone the frame disappears (the sheet is the screen, the navigation is one scrolling row, the breadcrumb line is dropped).

**(2) Reading order and the one primary action.** The decision bar states what stops approval in words ("2 blocking findings stop approval.", then what to do about it, then the workflow state) and shows **one** filled primary button chosen from what the server already allows and from the blocking findings: with blocking findings it is *Edit as new revision* (the message says to change the copy, **or replace the image if the claim is printed in it**, which keeps the artwork-replacement rule in front of the reviewer); otherwise *Request review* or *Approve…*; an approved campaign has none. Disabled controls are flat grey, legible, and keep their reason in the tooltip and the text beside them. Findings use the evidence annotation described above.

**(3) Consistent cards, controls, states and focus.** One card style (1px edge, 10px radius, **no resting shadow**; shadows only on the dialog and toasts); one control height (34px desktop, 44px on touch with 16px form text); status as a pale tint with dark text of the same hue **plus a word or dot** (indigo replaced by a blue); one focus ring everywhere (2px solid `#0b5d57`, 2px gap, 7.7:1 on white); a press state on buttons; notices share one component; tables use sentence-case grey headers, right-aligned tabular figures, a fixed first column on a phone; the native file chooser matches the other controls; dialog close is an SVG with an accessible name. `prefers-contrast: more` darkens borders and secondary text; `prefers-reduced-motion` removes transitions.

Preserved, not touched: every rule and source explanation, the human OCR confirmation flow, the printed-words rule and the artwork-replacement warnings (all text strings unchanged), the m15 overflow fix, the data and the server behaviour.

## 5. Review rounds

| Round | Top problems found (screenshot) | Fixed |
|---|---|---|
| 1 | The dossier stopped 199px short of the right edge (inspector `unused-canvas`); the phone chrome was still tall and the nav row's last label sat 11px from the edge (inspector FAIL); the decision bar read lead, state, then fix, so the state interrupted the guidance | Centred the dossier column; banner label and button side by side on a phone; reordered the decision bar; the phone nav underline became a border (lint) |
| 2 | A thick grey scrollbar under the phone nav read as an underline; "Demo mode" wrapped to two lines; the queue's filter chips took three rows and its table lost the campaign name when scrolled; in the editor the Text size select poked out of its card (a `.field` grid column sized to its widest option) | Thin neutral scrollbar; no-wrap label; one scrolling chip row; fixed first column; `.field` columns may shrink |
| 3 | Insights numbers left-aligned; the Brand library list left 31% of the first screen empty; one more chip at the phone edge. **A regression I introduced and then caught by looking at the screenshot:** the library's two-column rule also hit the source page's Versions card | Right-aligned numbers; the library's rules and facts lists in two columns (scoped to a `lib-cols` class); chip padding |

## 6. Measured results

| Check | Before | After |
|---|---|---|
| Taste inspector (`--app`), campaign | 2 FAIL (6 tiny uppercase tracked labels; text within 16px of the edge at 768) + 2 WARN | **0 FAIL, 0 WARN** |
| Taste inspector, review queue | 2 FAIL + 2 WARN (32 of 32 numeric cells left-aligned) | **0 / 0** |
| Taste inspector, dossier | 2 FAIL + 3 WARN (200px dead strip, 4 of 12 blocks on the first screen) | **0 / 0** |
| Taste inspector, OCR confirmed, library, insights | not measured before | **0 / 0 each** |
| Taste inspector, source view | not measured before | 0 FAIL, 1 WARN (`no-data-hue`: counts the `.timeline` history list as a chart; the app draws no chart) |
| Taste lint (`--app`, `public/`) | 5 FAIL (gradient, indigo ×3, a dingbat) + 14 WARN | **0 FAIL**, 8 WARN, all defended: monospace is used for IDs, hex values and digests only (4); the two shadows are the dialog and the toasts, which float (2); `padStart` formats hex bytes (2) |
| Contrast pairs (`npm run ui-contrast`, from the real CSS tokens) | 19 hard-coded pairs | **70 of 70** pass (28 text pairs ≥4.5:1 and 7 non-text pairs ≥3:1, each also in the increased-contrast variant) |
| Focus ring against the sheet / the frame | 1.86:1 / 1.71:1 | **7.72:1 / 6.85:1** |
| Control border against white | 1.62:1 | **3.14:1** |
| Disabled button label | about 2.1:1 (50% opacity, estimated) | **6.31:1** |
| Interactive targets under 32px (buttons, links incl. inline text links, fields, tabs), 390 / 320 / 768 / 1440 px, 9 views each | 52 / 44 / 55 / 62 | 17 / 9 / 20 / 60 (what remains are inline text links, which WCAG exempts when inline, and 30px desktop small buttons) |
| Strict touch check at phone width (every button, field, tab, nav link and filter ≥44px; campaign, queue, source, library, editor) | not defined (controls were 30 to 38px) | **pass** (`npm run ui-smoke-design`) |
| Real Tab presses, 14 stops on the campaign page | ring 3px `#2dd4bf` | all show a solid 2px `rgb(11, 93, 87)` ring |
| Reflow | 0 overflow after m15 | still **0** at 1440, 768, 390 and 320 across 11 views (`ui-smoke-layout` 57/57); 200% text size at 1440, and 720/360/320px (zoom equivalents) on campaign, queue and dossier: no sideways scroll |
| Reduced motion; increased contrast | not checked | emulated: no element transitions or animates; `--muted` and `--line` take their darker values and return when the preference is off |
| Regression | | unit suite 310 (309 pass, 1 platform skip, 0 fail); `ui-smoke` 14/14, `a11y` 43/43, `auth` 17/17, `sources` 23/23, `assets` 22/22, `claims` 15/15, `impact` 25/25, `dossier` 25/25, `ocr` 36/36 + 4/4, `layout` 57/57, `design` 24/24, `judge-rehearsal` 29/29; data hashes unchanged |

Body size is unchanged (15px). The page title went from 23px/700 to 22px/650. The smallest rendered text is 11px (monospace IDs at 0.85em).

## 7. Citations

**Apple (file › heading).** `accessibility.md › Vision`: "Strive to meet color contrast minimum standards" (4.5:1 for text up to 17 pt) and "Convey information with more than color alone" (status keeps a word or a dot); `accessibility.md › Mobility`: "Offer sufficiently sized controls" (44x44 default on touch; 28x28 on desktop) and "Let people use the keyboard alone to navigate and interact with your app" (the Tab and focus checks); `accessibility.md › Cognitive`: reduce motion and "Minimize use of time-boxed interface elements" (see limitation on toasts). `color.md › Best practices`: "Avoid using the same color to mean different things" (see limitation on teal). `typography.md › Ensuring legibility` and `› Supporting Dynamic Type`: "Make sure your app's layout adapts to all font sizes" (rem sizes, the 200% test). `layout.md › Visual hierarchy`: "Order content by relative importance" (the decision bar first, then copy and findings), "Group related items" (the evidence annotation) and `› Adaptability`: "Keep functionality the same as size classes change" (one set of functions at every width). `sidebars.md › Best practices`: at most two levels, nothing critical at the bottom of a sidebar. `buttons.md › Style`: "use a button that has a prominent visual style for the most likely action" and "Use style — not size — to visually distinguish the preferred choice"; `› Best practices`: "Always include a press state"; `› Role`: do not give the primary role to a destructive action. `feedback.md › Best practices`: "Show people when a command can't be carried out and help them understand why" (disabled controls keep their reason). `lists-and-tables.md › Content`: descriptive column headings. `cross-platform.md`: sidebar plus content pane, size classes as CSS media queries, semantic colours as custom properties.

**Taste (`references/app-screens.md`).** §3.1 tinted frame and white sheet; §3.2 sidebar and the neutral active pill; §9.2 "The sidebar is never dark or saturated" and the three text tiers at 4.5:1; §9.4 "A border or a shadow, never both"; §7.2 to §7.4 table headers in sentence case, right-aligned tabular figures; §8.3 one filled primary per screen; §11 states; §12 the phone (tables keep their first column fixed, filters in one scrolling row, targets at least 44px); §13 house rules and §14 tells (the gradient logo, indigo, the dingbat and the tracked caps were removed).

## 8. Limitations, candidly

- **Light appearance only.** Taste was dealt `--theme light`; there is no dark theme, and no parity with one is claimed. The increased-contrast variant exists and its values were checked by emulation and by computing every contrast pair, not by a person using a system setting.
- **Teal now has more than one meaning** (primary action, links and the selected tab; the evidence annotation; the "Guidelines v2" and registered-source chips; info notices). `color.md` warns against one colour meaning different things. It is restrained and always paired with words, but it is a trade-off.
- **Toasts still disappear by timer** (4.5s, 8s for errors), which `accessibility.md › Cognitive` advises against; errors that block a task are also shown in the page, but this was not redesigned.
- **Loading and empty states were reviewed, not redesigned.** Loading is still the words "Checking…" or an empty frame; there are no skeleton placeholders (Taste §11 house rule). Error notices share one component.
- **The sidebar cannot be hidden** (`sidebars.md` suggests it), and tables are not sortable or resizable. The phone navigation is a scrolling row, not a menu sheet.
- **Remaining visual weaknesses** after round 3: the top chrome is still two rows on desktop (the banner and the bar, about 84px); the campaign's left column ends well above its findings column; the "Text in the image" card keeps two long muted paragraphs because their wording is safety text (the printed-words rule and the cannot-compare-pixels limit) and was not shortened.
- **Measured on headless Edge/Chromium only**, with device emulation (no real phone, no Safari or Firefox, no screen reader). The library's two-column layout is plain CSS grid (no `:has()`), so older browsers get one column.
- **Counts of targets under 32px** include inline text links; they are shown for comparison, the strict 44px check is the one that gates.
- The skills, their `skills-lock.json` and `.taste-skill/` are development tooling and are not part of the source package; the inspector's screenshots under `.taste-skill/` are reproducible, and the ones this report cites are copied into `docs/evidence/`.

## 9. Reproduce

```
npm run design-evidence        # docs/evidence/design-after-<width>-<view>.png + design-after.json (isolated temp data)
node scripts/browser/design-evidence.mjs --serve --port 4301     # serve the same isolated workspace for the Taste inspector, then:
node .claude/skills/design-taste-frontend/scripts/inspect.mjs "http://127.0.0.1:4301/#/queue" --app --out .taste-skill/after/queue
node .claude/skills/design-taste-frontend/scripts/lint.mjs --app public
npm run ui-smoke-design        # touch targets, focus ring, zoom reflow, reduced motion, increased contrast, the single primary action, no resting shadows
npm run ui-contrast            # 70 contrast pairs computed from public/styles.css
npm run ui-smoke-layout        # the m15 overflow regression, still 57/57
```
