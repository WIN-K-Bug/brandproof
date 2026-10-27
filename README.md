# BrandProof

**Evidence-backed brand review before publication.** Team **bhangaledhruv7** (kevin george, dhruv bhangale, Sahil Sakhure, eric siju) · Codex 48 hackathon prototype.

BrandProof checks campaign copy and image details against approved brand rules and facts, explains every finding with the source that raised it, and binds each approval to the exact content and guideline version it covered. If anything changes afterwards, the approval shows **Re-review required**.

> **Two modes.** *Demo mode* (default) is a walkthrough with a role picker. *Authenticated workspace* is a separate, opt-in mode with real local sign-in. See [Authenticated workspace](#authenticated-workspace-optional) and [docs/authentication.md](docs/authentication.md).
>
> **Demo mode.** The brand ("Fernlight"), its documents and its campaigns are **fictional**. Roles are a demo switch, **not authentication**. Data is saved in one file on this computer, **not confidential multi-user storage**. Findings come from deterministic rules; **contextual (generative) AI review is unavailable**. See [Limits](#limits).

## Run it

Requires **Node.js 22 or newer**. No install step is needed for the core app.

```
node server.js          # or: npm start
```

It binds to `127.0.0.1` only and prints its URL (default port 4173; the next free port is used if that one is busy, up to 20 ports; set `PORT=4300` to start elsewhere, in PowerShell `$env:PORT='4300'`). It never stops another process. **One server per data file:** if another BrandProof process already has the same data file open, this start is refused (with the reason) instead of falling through to another port, because two writers on one file lose saved changes; use the running server or another data file. The ownership marker is a small `<file>.lock` runtime file next to the data (not user data; see [docs/single-writer.md](docs/single-writer.md) for the rare manual recovery). A data file that is itself a symbolic link is refused (point the setting at the real file; a symlinked directory is fine). If the data file is corrupt or has an unknown schema it refuses to start and leaves the file alone. Data is stored in `data/brandproof.json`, created and seeded on first start. **Do not delete or reset that file if it holds data you want to keep.** **Deployment start-up (opt-in, prepared locally, not deployed anywhere):** `BRANDPROOF_DEPLOY=1` listens on a configured `BRANDPROOF_HOST` (default every interface) on exactly the assigned `PORT`, fails clearly if that port is taken instead of trying another one, requires an explicit `BRANDPROOF_DATA`, and answers only to the host names in `BRANDPROOF_ALLOWED_HOSTS`; see [docs/deployment.md](docs/deployment.md) for the settings, the writable paths, the one-process and restart limits and the optional-feature fallback. Without those variables nothing above changes. **Isolated fictional judge demo (opt-in, prepared locally, not deployed anywhere):** `BRANDPROOF_JUDGE_DEMO=1` with a dedicated `BRANDPROOF_JUDGE_ROOT` serves the same product with **no sign-in**, where each browser gets its own separate, fictional, expiring session (one process, one listener, server-chosen unpredictable cookie, bounded sessions, storage and open sessions); the roles stay a simulation. See [docs/judge-demo.md](docs/judge-demo.md) for the design and its trade-offs, the settings, the lifetime and restart behaviour and the limits. **Hosting candidate (prepared, not deployed):** [docs/render-deploy.md](docs/render-deploy.md) and `render.yaml` describe a temporary free-tier Render service for it (sessions are lost when the service sleeps or restarts); `npm run package:public` builds the clean public source folder and archive with a hash inventory. For a fresh private sandbox start the server on a new path instead: PowerShell `$env:BRANDPROOF_DATA="$env:TEMP\bp-sandbox.json"; $env:PORT='4190'; npm start` (seeded on first start, with its images in `<file>.assets`; the original data file is never opened).

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the automated tests (Node's built-in runner). |
| `npm run eval` | Scores the rule checks on the synthetic detection fixtures (a regression baseline, not accuracy). |
| `npm run judge-rehearsal` | Scripted, automated run of the whole 12 → 8 hours evidence story in a real browser with distinct signed-in accounts on throwaway data; prints action counts and automated timings (not a human study) and saves a screenshot sequence. See [docs/judge-rehearsal.md](docs/judge-rehearsal.md). |
| `npm run demo:consequence` | A third, separate fictional demo (port 4180 or the next free one; it prints the URL it got): the 12 → 8 hours source change, built idempotently in its own file `demo-data/aurora-8h-scenario.json`, ready for a live, **mutating** walkthrough. This is the demo for the source-change story. |
| `npm run eval:claims` | Scores the factual qualifier / scope checks on a synthetic corpus (regression baseline, not accuracy). See [docs/claims-scope.md](docs/claims-scope.md). |
| `npm run ui-smoke-layout` | Browser layout regression on isolated synthetic data with deliberately long names: at 320, 390, 768 and 1360 px wide no page may scroll sideways, no element may stick out of the screen except inside a deliberate scroller (tabs, tables, the phone navigation row), and Tab reaches every navigation link. See [docs/verification.md](docs/verification.md). |
| `npm run package:public` | Builds the publication candidate (`dist/public-candidate-m26/brandproof`, `dist/brandproof-public-candidate-m26.zip`) from an allow-list, scans every file for e-mail addresses, machine paths, keys and runtime data, and writes a per-file SHA-256 inventory. It publishes nothing. See [docs/render-deploy.md](docs/render-deploy.md). |
| `npm run ui-smoke-journey` | Browser proof of the optional "Try an evidence change" journey in the isolated judge demo, one separate visitor each at desktop, 390 and 320 px (118 checks): find the action in the guide, start it, preview the source change (nothing written), activate it, the approval goes stale and approving is blocked, repair the facts and the copy, a Reviewer approves again, the dossier keeps both decisions, a reload keeps it all. Real clicks, form fields and key presses. See [docs/judge-demo.md](docs/judge-demo.md). |
| `npm run ui-smoke-phone` | Phone regression on the isolated judge demo (54 checks): at 390, 320 and 195 px wide (195 px is what 200% browser zoom leaves of a 390 px phone), and at larger text sizes (up to 200% at 390 and 320 px), no sideways page scroll and every tab-bar label inside its column; the banner, brand, role picker and guide end inside the screen, also in the "session ended" states; real-key role switching; a missing deep link offers "Open the workspace". See [docs/verification.md](docs/verification.md). |
| `npm run ui-smoke-judge` | Isolated judge-demo proof with TWO independent browser instances (separate cookie jars) at desktop and 390/320px: the fictional-data, separate-session and simulation wording, the compact three-step guide, keyboard use, one browser never seeing the other's campaign, reload persistence, the approve and stale path, Reset, the session-ended and demo-full states, no sideways scroll. See [docs/judge-demo.md](docs/judge-demo.md). |
| `npm run ui-smoke-design` | Design regression on isolated synthetic data (31 checks): one primary action, solid offset shadows only (no blur), the verdict band and its screen-reader-silent stamp, lettered exhibits, self-hosted fonts, the phone tab bar, 44px touch targets on a phone, a visible 3px focus ring on real Tab presses, reflow at 200% text size and zoom equivalents, reduced motion and increased contrast. See [docs/design-pass.md](docs/design-pass.md) and [docs/design-m17-brutalist.md](docs/design-m17-brutalist.md). |
| `npm run design-evidence` | Photographs the same isolated workspace at 1440, 768, 390 and 320px into `docs/evidence/design-after-*.png`. |
| `npm run ui-smoke-dossier` | Browser walkthrough of the review dossier: report, a real JSON download compared with the page, stale approval, damaged image, print and narrow layouts (authenticated mode, synthetic accounts). |
| `npm run ui-smoke-impact` | Browser walkthrough of the source change-impact preview (authenticated mode, synthetic accounts): preview, stale-preview refusal, activation, real consequences, repair, a distinct reviewer. |
| `npm run ui-smoke-claims` | Browser walkthrough of a qualifier caution, a safe correction and a human rewrite on throwaway data. |
| `npm run auth:setup` | Authenticated mode: create the first owner account (interactive, password typed with echo off). |
| `npm run ui-smoke-auth` | Browser walkthrough of authenticated mode with synthetic throwaway accounts. |
| `npm run demo:start` | The second, separate **showcase demo** (fictional Fernlight story with a registered source, linked facts, retained images) on port 4174 or the next free port (it prints the URL it got). Own data in `demo-data/`; never touches `data/` or other running servers. Present it as a **read-only tour** (look and click through, do not save or approve): the preserved showcase file is not for experiments. See [docs/demo.md](docs/demo.md) for the route and for which demo to use for which story. |
| `npm run demo:rehearse` | Replays the showcase presenter path (source activation, stale approvals, repair) through the API on throwaway data. |
| `npm run ui-smoke-a11y` | Integrated keyboard / dialog-focus / error-announcement / tabs / narrow-screen walkthrough on a throwaway showcase. An engineering check, not an accessibility audit. |
| `npm run ui-contrast` | Contrast ratios of 48 text and non-text pairs (and the increased-contrast variant, 96 in all), computed from the real tokens in `public/styles.css`. |
| `npm run ui-smoke-assets` | Browser walkthrough of persistent campaign images: upload, save, reload, server restart, reviewer sees the same bytes, replacement makes the approval stale, history, failure recovery, metadata-only legacy, narrow screen. |
| `npm run ui-smoke-sources` | Browser walkthrough of the approved-source workflow (register, approve, link, review, replace, repair) with synthetic accounts and a fictional document. |
| `npm run ui-smoke` | Browser walkthrough on a throwaway server; saves screenshots to `docs/evidence/`. Needs Edge or Chrome installed. |
| `npm run fetch-ocr` | Optional: downloads and verifies the pinned English language data for reading text from images ([docs/ocr-image-text.md](docs/ocr-image-text.md)). |
| `npm run ui-smoke-ocr` | Browser walkthrough of the human-confirmed image-text flow with the real local reader under a network blocker, then with the reader off. |
| `npm run demo:imagetext` | A fifth, separate fictional demo (port 4185 or the next free one; it prints the URL and whether reading is AVAILABLE or UNAVAILABLE): read a draft of the text in a campaign image, compare it with the printed words and digits, correct only the reader's misreads, confirm, and replace the image to fix a claim. Own file `demo-data/image-text-scenario.json`; works without the optional reader by typing the transcription. |
| `npm run fetch-model` | Optional: downloads the pinned embedding model for AI source matching. |
| `npm run verify-semantic` | Optional: runs the real local model over the seed sources and prints what it retrieves. |
| `npm run package` | Builds `dist/brandproof-source.zip` from an allow-list and verifies it excludes `node_modules`, `.cache`, `data`, `.git`, env/key files and model weights. Local file only; nothing is uploaded. |

## Campaign images

A creator can attach a **PNG** to a revision. The server validates the actual image (not just its prefix), stores the bytes beside the workspace file under their SHA-256, and the revision refers to exactly those bytes. Reviewers see that image after a reload or restart; the approval is bound to its digest, so replacing the image makes the approval show **Re-review required**; earlier revisions keep their own image. Older records that only saved a name and a browser-reported fingerprint are shown honestly as **Metadata only: image not retained**. Limits: PNG only, 2 MiB and 4 million pixels per image, 50 MiB / 200 images per workspace, **no deletion in this version**, stored unencrypted. Text and palette colours stay **a person's choice**: BrandProof never extracts colours or a palette from an image on its own: a person types or picks them, or clicks the retained image to sample the colour of that one clicked pixel, and the contrast and palette findings use only the colours chosen. (Text inside the image has its own optional, human-confirmed path: see below.) See [docs/assets.md](docs/assets.md).

## Approved sources and evidence

Rules and facts can cite **registered sources** instead of typed labels. A pasted (or small `.txt`/`.md`) source is a **draft** until a manager approves that exact version; a manager then links an exact passage into a rule or fact and publishes; findings show the cited passage and open it **highlighted in the source**. Replacing or withdrawing a cited source makes approvals show **Re-review required** and blocks new approvals until a manager relinks. Rules whose source was typed stay explicitly **Legacy**. See [docs/sources.md](docs/sources.md) for the trust model, text normalisation, effects and limits. Only pasted text and small UTF-8 text files are read; URLs are labels and are never fetched.

## Source change-impact preview

Before a manager approves a replacement source version or withdraws a source, **Preview impact** shows, read-only: which rules and facts cite it and whether each exact quote survives in the new text (same place, moved, ambiguous, gone), which campaign findings cite those rules, and what happens to every campaign's approval or review, counted separately because approvals bind the whole evidence set. The approval or withdrawal then carries the preview's digest and the server refuses it if anything changed meanwhile. It never relinks, approves or judges meaning. See [docs/impact-preview.md](docs/impact-preview.md).

## Text in images (optional, human-confirmed, experimental)

With the optional local reader installed (`npm install`, then `npm run fetch-ocr`), an editor can press **Read text from image**: an offline Tesseract.js reads the retained PNG on this computer and returns a **draft**. The person compares it with the words and digits actually printed in the image, corrects only what the reader misread, and **explicitly confirms** it; the server saves it as a separate field of the new revision, bound to the exact image digest and attributed to the signed-in account. The normal rules then check that transcription (findings point at it, with their source links; corrections are advice only, because the words are in the image), and the transcription and image digest are part of the approval, so changing either means re-review. The rule everywhere it matters: *match the words actually printed*. Editing the transcript does not change the image; to fix a claim in the artwork, replace the image, then transcribe and confirm again. (BrandProof cannot compare a transcript with the pixels, so a person could still type words the image does not print; who confirmed it is recorded.) A reading can be wrong or miss text (a hard set of synthetic images is documented), it is never source evidence or an approval, it does not read colours, contrast or logos, and without the optional parts everything else, including typing the transcription yourself, works unchanged. See [docs/ocr-image-text.md](docs/ocr-image-text.md) and the feasibility proof [docs/ocr-phase-a.md](docs/ocr-phase-a.md).

## Review dossier

Open a campaign and press **Review dossier** for one readable, printable record: the exact saved copy and digest, the image state with integrity checked now, the guidelines and evidence in force, the cited source passages, the **recorded** decisions with the hashes each covered (compared with the saved inputs today), and the findings **recomputed today** (kept apart, because what a reviewer saw in the past was never stored). **Download JSON snapshot** saves the same content locally on an explicit click. It is a factual snapshot that can be out of date at once, not a certificate or signature, and it leaves out paths, credentials, source full texts and image bytes. See [docs/dossier.md](docs/dossier.md).

## Authenticated workspace (optional)

Demo mode's role picker is **not security**. For accountable review there is a separate mode with real local accounts:

```
npm run auth:setup                       # stop the server first; creates the owner (no default credentials exist)
BRANDPROOF_MODE=authenticated npm start  # PowerShell: $env:BRANDPROOF_MODE='authenticated'; npm start
```

Identity and role come only from a server-side session (HttpOnly, SameSite=Strict cookie; opaque expiring session; CSRF token and Origin checks; scrypt password hashes; rate-limited sign-in). The browser cannot choose or change a role. Everything done is attributed to a stable account id and name, and **nobody can approve a submission they created or edited**, whatever their role. It uses its own files (`data/auth-workspace.json`, `data/auth/users.json`) and refuses demo data files. It is local sign-in only: no HTTPS, no encryption at rest, sessions in memory. Decisions, threat model and limits: [docs/authentication.md](docs/authentication.md).

## Optional: AI source matching (local embeddings)

Off by default in the sense that it needs two extra things. The rest of the app works without them.

```
npm install                # installs the optional, exactly pinned @huggingface/transformers 3.8.1 into ./node_modules
npm run fetch-model        # downloads the pinned model files into ./.cache/models (about 23 MB), verifying SHA-256
npm run verify-semantic    # real inference, prints retrieved sources
```

Then start the app as usual. The workspace shows an **AI source matching** card: choose passages from the saved copy and see which approved sources are about the same topic, with similarity scores. It is a relevance retriever, **not** a fact checker and **not** generative review. Model identity, licence, limits and measured results: [docs/semantic-matching.md](docs/semantic-matching.md).

If the package or model is missing, the card says **Unavailable** and why; nothing is mocked.

## Demo walkthrough (seeded data)

> This walkthrough **saves revisions and publishes guidelines**. Run it on a throwaway workspace, not on data you want to keep: start the server with a new data path (see above, `BRANDPROOF_DATA`). For presenting without changing anything, use the read-only showcase tour, the isolated `demo:consequence` / `demo:imagetext` demos, or the scripted replay: [docs/demo.md](docs/demo.md).

1. **Workspace** opens `SUB-1`, a fictional draft with problems. Read the highlighted copy and the **Findings**: wrong product casing, a hype claim, battery hours and warranty that **contradict** approved facts, "waterproof" against an indoor-only fact, "best" and "guaranteed" as **unverified** (no matching approved fact found by these checks, which is not the same as false), repeated exclamation marks, and a low-contrast, generic-alt-text, off-palette image.
2. Each finding shows its rule or fact ID, the exact source quote, the span of text and a correction. Numbers that match no fact (for example "10,000 happy readers") are **not** flagged as false.
3. As **Creator**, click **Edit as new revision**, use **Apply to draft** on the safe corrections, edit the rest, and **Save as revision 2**. Open **History** to compare revisions.
4. **Request review**. Switch the role to **Reviewer**: **Approve** stays disabled while blocking findings remain, and says why.
5. Open `SUB-3` (in review, one warning). As Reviewer, **Approve…** needs you to acknowledge the warning. The approval is bound to copy, image details and guideline version.
6. Switch to **Manager**, open **Brand library**, change something (for example a claim word in *Rules & thresholds*), **Publish new version**. Return to `SUB-3`: it now says **Re-review required** because the guidelines changed. The Review queue and Insights reflect this.
7. On any saved revision, try **AI source matching** (if installed): select "How long can the lamp stay lit before recharging?" and watch it retrieve `FCT-001`.

## What is where

```
server.js            starts the server (127.0.0.1 by default; opt-in deployment start-up: docs/deployment.md)
src/                 rules engine, workflow, store, HTTP app, start-up settings, judge demo (judge.js), optional semantic matching
public/              the web app (plain JS modules + CSS, no build step)
tests/               automated tests and detection fixtures
scripts/             eval, model fetch/verify, browser smoke test, packaging
docs/                architecture, Round 1 plan, rounds, contributions, semantic matching, verification
```

Documents: [judge demo](docs/judge-demo.md) · [deployment start-up](docs/deployment.md) · [design pass](docs/design-pass.md) · [text in images](docs/ocr-image-text.md) · [OCR feasibility proof](docs/ocr-phase-a.md) · [single writer](docs/single-writer.md) · [judge rehearsal and clean install](docs/judge-rehearsal.md) · [presentation notes](docs/presentation-notes.md) · [review dossier](docs/dossier.md) · [impact preview](docs/impact-preview.md) · [claims scope](docs/claims-scope.md) · [showcase demo](docs/demo.md) · [architecture](docs/architecture.md) · [campaign images](docs/assets.md) · [sources and evidence](docs/sources.md) · [authentication](docs/authentication.md) · [Round 1 plan](docs/round-1-plan.md) · [three-round measures](docs/rounds.md) · [proposed contributions](docs/contributions.md) · [semantic matching](docs/semantic-matching.md) · [verification notes](docs/verification.md).

## Limits

- **Fictional demo.** Nothing here is a real brand's policy.
- **Demo-mode roles are not security.** Anyone using the page can pick any role. Eligibility is enforced by the server for the *chosen* role only. Use the authenticated mode when identity matters; even then it is local-only (no HTTPS, no encryption at rest).
- **Local, single-machine storage** (one JSON file). Writes are serialised and atomic, and one BrandProof process per file is enforced with an ownership marker (builds that predate it, other programs and hand edits are outside that guarantee), but there is no encryption, access control or multi-user sync. It is not suitable for confidential data.
- **Rules, not understanding.** Checks are deterministic text and number rules. They miss paraphrased claims, and number matching is limited to the units and topic words listed in each fact. Ambiguous wording is reported as *needs review* rather than guessed. An "up to 12 hours" fact does not support "always 12", "guaranteed 12" or a competitor's figure; a figure about another product ("our phone battery lasts up to 12 hours") or an editing note ("please delete the sentence: …") is sent to a person too (m25: subject and intent, with limits in [docs/claims-scope.md](docs/claims-scope.md)); those are cautions, and an automatic replacement is offered only when it keeps the approved "up to" and operating condition, otherwise a person rewrites ([docs/claims-scope.md](docs/claims-scope.md), with measured synthetic results and known limits).
- **No contextual AI review.** An adapter contract exists (`src/ai.js`) but no provider is connected. The local embedding feature is separate: it measures topical relevance only.
- **Images:** only PNG is retained (validated structurally and by bounded decoding, not interpreted), stored unencrypted next to the workspace file, with **no deletion** in this version and a workspace quota. Older records are metadata-only. Contrast and palette use only the colours a person chooses (typed, picked, or sampled from one clicked pixel; nothing is extracted automatically), and are **not** a certification of the whole image. Text in an image is checked only through a transcription a person confirms (an optional local reader can draft it); nothing else is read from the pixels.
- **Registered evidence is plain text.** Only pasted text and small UTF-8 text/Markdown files are read (no PDF, OCR or URL fetching); the digest is of the normalised text, not of an original file; policies still use typed (legacy) sources.
- **Guideline changes of any kind invalidate approvals,** even trivial ones. This is deliberate and conservative.
- **Optional dependency advisory:** `npm audit` reports 2 high-severity advisories in `sharp` (image decoders), pulled in by `@huggingface/transformers` 3.8.1. BrandProof only embeds text and never passes images to it. The suggested fix is a breaking major upgrade, which has not been adopted. See [docs/semantic-matching.md](docs/semantic-matching.md).
- Participant details and contributions are **not** recorded here; see [docs/contributions.md](docs/contributions.md) (proposed roles only).

## Licence and third-party notes

No licence has been chosen for BrandProof's own code yet. The optional model `Xenova/all-MiniLM-L6-v2` and `@huggingface/transformers` are Apache-2.0; details in [docs/semantic-matching.md](docs/semantic-matching.md).
