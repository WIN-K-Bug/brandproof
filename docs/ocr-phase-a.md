# Phase A: can a free, fully local OCR read campaign images well enough for a human-confirmed workflow?

**Verdict: yes for clear text, with real failure modes that the workflow must (and does) keep a person in front of.** Measured on synthetic images rendered from text declared in advance. This is feasibility evidence, not an accuracy figure for real campaign images.

## What was run

- **Engine:** Tesseract.js **7.0.0** (Apache-2.0) with its WASM core `tesseract.js-core` **7.0.0** (Apache-2.0), run in a Node worker thread. Current release verified on the npm registry on 25 Oct 2026 (`latest` = 7.0.0; core `^7.0.0`). Installed with exact pins, install scripts disabled, as an *optional* dependency (`npm install` without it leaves the app working).
- **English data:** `tessdata_fast` `eng.traineddata`, integer LSTM model, 4,113,088 bytes, **SHA-256 `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2`**, from the upstream commit `923915d4ced2a7235221788285785a29c4a42d4a` of `tesseract-ocr/tessdata_fast` (Apache-2.0), downloaded once into `.cache/ocr/` and verified against the pin before it is used (`npm run fetch-ocr`).
- **Not usable:** the float `tessdata_best` model (SHA-256 `8280aed0…66ba`, 15.4 MB) crashes this core: `Aborted(missing function: _ZN9tesseract13DotProductSSEEPKfS1_i)` (`docs/evidence/ocr/phase-a-best-data-crash.txt`). Only the integer model is supported.
- **Official references consulted:** the Tesseract.js README, `docs/api.md` and `docs/local-installation.md`. They describe browser samples (CDN worker/core/language paths and version numbers such as v5.0.0) and do not cover Node, `cacheMethod`, or `errorHandler` completely, so Node behaviour was verified **in the installed source** instead of copied from samples.
- **Test images:** 9 "clear" and 9 "hard" fictional PNGs rendered with headless Edge from text written in `tests/fixtures/ocr/fixtures-spec.json` and `fixtures-stress.json` **before any recognition ran** (the expectation cannot be tuned to the output). Phrases that matter are included: "Aurora Lamp", "30 hours", "up to 12 hours", "Indoor use only", "2-year warranty".

## Findings from the installed source (they shaped the design)

1. **Default language source is a CDN.** If `langPath` is not set, Tesseract.js fetches `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`. Observed: under the network blocker the worker attempted exactly that URL (blocked and recorded). BrandProof therefore always passes a local `langPath`, checks the file's existence and SHA-256 **before** starting a worker, and never starts one otherwise.
2. **A worker error is thrown as an uncaught exception** (taking the process down) unless an `errorHandler` is supplied; with a handler, `createWorker` then **never settles** (it hangs). BrandProof always supplies one and wraps everything in a start timeout and a hard recognition timeout.
3. **A hung or failed `createWorker` cannot be terminated by the caller** (no handle). BrandProof hosts the engine inside its own worker thread, so terminating that one thread stops everything inside it.
4. In Node the core is `require`d from the installed package (no CDN) and the worker is a local `worker_threads` file.

## Network disabled, demonstrated

`scripts/ocr-proof/block-network.cjs` is preloaded (`node --require …`) into the process, and Node worker threads inherit it. It records and refuses every non-loopback `net.connect`, `dns` lookup, `http(s)` request, `tls.connect` and `fetch`, writing to one log shared across threads. Controls recorded in `docs/evidence/ocr/phase-a-controls.json`:

| Check | Result |
|---|---|
| deliberate `fetch('https://example.com/')` | refused, recorded (the blocker is live) |
| library default (no `langPath`) | worker `fetch` of the jsDelivr URL above, blocked and recorded; `createWorker` never settled (8 s timeout) |
| local `langPath` with no file | `ENOENT` reported through the error handler, **0 network attempts**, `createWorker` never settled (timeout) |
| 9 clean + 9 hard fixtures with the pinned local data | all recognised, **0 network attempts** |
| the full browser flow, HTTP server and reader worker included (`npm run ui-smoke-ocr`) | exactly 1 recorded attempt: the deliberate control |

This shows no request was made by Node code in those runs. It does not inspect what the browser itself does (the walkthrough pages are `http://127.0.0.1` only).

## Results, clean set (predeclared expectations; whitespace-normalised comparison; reproduced from the repo with `phase-a.mjs`)

| Fixture | Kind | ms | confidence | exact | char error rate | every number exact | raw transcript |
|---|---|---|---|---|---|---|---|
| clear-large | clear, high contrast | 216 | 95 | yes | 0 | yes | `Aurora Lamp / A full charge lasts up to 12 hours. / Indoor use only.` |
| clear-30-hours | clear, the wrong figure | 101 | 95 | yes | 0 | yes | `The battery lasts 30 hours / on a single charge.` |
| inverted-banner | light on dark | 104 | 95 | yes | 0 | yes | `Aurora Lamp / 2-year warranty.` |
| wrapped-paragraph | wrapped multiline claim | 203 | 95 | yes | 0 | yes | three lines, wrapped as rendered |
| small-text | 13 px | 101 | 94 | yes | 0 | yes | `Indoor use only. 2-year warranty. Up to 12 hours at medium brightness.` |
| low-contrast | about 1.5 : 1 | 139 | 95 | yes | 0 | yes | `A full charge lasts up to 12 hours.` |
| rotated-7deg | rotated 7° | 161 | 93 | **no** | 0.03 | yes | `Aurora Lamp lasts / **Up** to 12 hours.` (case differs from `up`) |
| text-free-blank | no text | 25 | 0 | yes | 0 | yes | *(empty)* |
| text-free-stripes | no text | 28 | 0 | yes | 0 | yes | *(empty)* |

**8 of 9 exact; all 9 with every number exact; both text-free images read as empty (nothing invented).** The one miss is a capital letter.

## Results, hard set

| Fixture | Kind | ms | confidence | exact | CER | numbers exact | raw transcript |
|---|---|---|---|---|---|---|---|
| tiny-9px | 9 px text | 93 | 65 | no | 0.061 | yes | `Indoor use only. 2-year **waranty Upto** 12 hours.` |
| rotated-15deg | rotated 15° | 107 | 83 | no | 0.152 | yes | `**ora** Lamp lasts / Up to 12 hours` (first word cut) |
| very-low-contrast | about 1.15 : 1 | 89 | 95 | yes | 0 | yes | read correctly |
| blurred | 1.4 px blur | 53 | 95 | yes | 0 | yes | read correctly |
| gradient-busy-background | white on a strong gradient | 17 | **0** | no | 1.0 | **no** | **(empty: the text was missed entirely)** |
| script-italic | cursive display font | 65 | 79 | no | 0.036 | yes | `Aurora Lamp: **vp** to 12 hours.` |
| decimals-and-percent | `12.5 hours`, `100%` | 100 | 95 | yes | 0 | yes | read correctly |
| all-caps-banner | `NO MORE THAN 8 HOURS` | 106 | 95 | yes | 0 | yes | read correctly |
| jpeg-like-noise | speckled background | 117 | 95 | yes | 0 | yes | read correctly |

**5 of 9 exact; 8 of 9 with every number exact.** Failures are real: tiny text is misspelled, a steep rotation loses a word, a script font turns "up" into "vp", and white text over a busy gradient is **missed entirely and reported as empty** (confidence 0). Nothing is corrected afterwards. Confidence is the engine's own heuristic: it was 95 for a correct read and 65 to 83 on misreadings, but the gradient failure shows that a low or zero value is not a promise that text is absent.

## Review set (added for the m14b patch; predeclared in `tests/fixtures/ocr/fixtures-review.json`)

| Fixture | Kind | ms | confidence | exact | every number exact | raw transcript |
|---|---|---|---|---|---|---|
| qualified-banner | corrected artwork: **every approved qualifier is printed** | 196 | 95 | yes | yes | `Aurora Lamp / A full charge lasts up to 12 hours at medium brightness. / Indoor use only.` |
| consolas-30-hours | monospace image of the wrong claim, rendered by us | 67 | 92 | yes | yes | `The battery lasts 30 hours / on a single charge.` |

(`repo-review.json`, network blocker on, 0 recognition attempts.) The independent reviewer reported a different, unseen Consolas rendering of the same claim that this engine read as "3@ hours" at confidence 93, and a faint rotated image read as bad text at confidence 27. Those files are the reviewer's; they are cited here as reported and **not** reproduced or tuned for. Our own Consolas rendering reads exactly, so no failure is simulated on it: the browser walkthrough corrects only the misread that really occurs on our fixtures (the capital "Up" on the rotated image). A digit misread like "3@" is precisely why the confirmation asks the person to compare the text digit by digit with the printed words; nothing is repaired automatically.

## Bounds, measured on this machine (Windows 11, Node 22.19.0)

- Worker start about 0.27 s (the first run) to 0.72 s (a loaded machine); per image 7 to 220 ms for these sizes; nine images in about 1.4 to 1.8 s.
- Peak process memory about 105 to 121 MB (one worker, images up to 900 × 420).
- Three recognitions submitted at once on one worker are serialised by it (241 ms for three). BrandProof's own queue is bounded regardless (one running, two waiting).
- `terminate()` returns at once and the process can exit.

## What this proves, and what it does not

- It supports a **human-confirmed** workflow: clear text, including the figures that matter, was read exactly in 9 of 9 clean cases (one capital letter off), offline.
- It does **not** show how the engine performs on photographs, textured or curved surfaces, handwriting, other languages or large images, and these renders are easy (flat vector text). The orchestrator is expected to test unseen images.
- The hard set shows the failure modes a reviewer will see. That is why a draft is never trusted: the person compares it with the image, corrects it and confirms it.

## Reproduce

```
npm install                 # installs the optional, exactly pinned tesseract.js 7.0.0
npm run fetch-ocr           # downloads and verifies the pinned English data into .cache/ocr
node --require ./scripts/ocr-proof/block-network.cjs scripts/ocr-proof/phase-a.mjs clean
node --require ./scripts/ocr-proof/block-network.cjs scripts/ocr-proof/phase-a.mjs stress
```

Raw outputs: `docs/evidence/ocr/` (`phase-a-clean-fast.json`, `phase-a-stress-fast.json` from the isolated first run; `repo-clean.json`, `repo-stress.json` from the repository; `phase-a-controls.json`; `phase-a-best-data-crash.txt`). The Phase A work ran for about 50 minutes, a few over the 45-minute timebox, because the evidence needed two extra controls (the CDN default and the crash behaviour).
