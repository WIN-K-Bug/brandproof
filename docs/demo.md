# Demos: which one to use, how to start it, and a presenter route

BrandProof has several **separate** local demos. They never share data, and each runs in **demo mode**: the "Acting as" box is a switch for walking through the roles. It is **not sign-in**. The real-identity mode is a different setup (`BRANDPROOF_MODE=authenticated`, see [authentication.md](authentication.md)) with its own browser walkthrough on synthetic accounts.

Everything is fictional (the brand Fernlight, its Aurora Lamp, the fact sheets, the campaigns, the generated images). Nothing is a real company's policy, and no real person's data is involved.

## Which demo for which story

| Story | Command | First port tried | Data it uses | May the presenter save or approve things? |
|---|---|---|---|---|
| Original three campaigns | `npm start` | 4173 | `data/brandproof.json` (**protected**) | **No.** Leave it as it is; do not present from it if the data must stay unchanged. |
| **Read-only tour** of the showcase: evidence, history, stale approval, dossier, impact preview | `npm run demo:start` | **4174** | `demo-data/fernlight-showcase.json` + `.assets/` (**preserved**) | **No.** Look and click through only (see the route below). |
| **The source changes (12 → 8 hours)**: activate, re-review, repair, approve again | `npm run demo:consequence` | **4180** | `demo-data/aurora-8h-scenario.json` (own file, created on first start) | **Yes**, this is the demo for it. |
| Same story, scripted | `npm run judge-rehearsal` | none (throwaway server) | throwaway temporary data | Not a live demo: it drives a headless browser and prints PASS/FAIL and screenshots. |
| **Text in the image (optional OCR)** | `npm run demo:imagetext` | **4185** | `demo-data/image-text-scenario.json` (own file, created on first start) | **Yes.** |

Each launcher tries 16 consecutive ports from the first one and **prints the URL it actually got** (for example `listening on http://127.0.0.1:4185`): use that URL, not the table. A port is skipped when something already listens there; nothing is stopped or killed. Check with the printed line, or pin one with `DEMO_PORT`: PowerShell `$env:DEMO_PORT='4190'; npm run demo:imagetext`. Checked on this machine with 4173 and 4174 busy: the consequence demo printed 4180 and the image-text demo printed 4185.

Starting a launcher on a data file that already holds its story **writes nothing** (the bootstrap checks each step first; a test compares the file byte for byte after a second run). Starting one on a path that does not exist yet **creates that file** by calling the app's own API; that is how `demo-data/aurora-8h-scenario.json` and `demo-data/image-text-scenario.json` come to exist.

## What the demos read from an image, and what a person must do

- **Colours: the person chooses them.** BrandProof never extracts colours or a palette from an image on its own. In the editor a person types or picks a colour, or clicks the retained image to sample the colour of **that one clicked pixel** (the person decides what it means). Contrast and palette findings use only the colours chosen, say so, and are not a certification of the whole image.
- **Words in an image: only through the optional, human-confirmed OCR.** The local reader gives a **draft** that can be wrong or empty. The person must **compare the draft with the words and digits actually printed** in the image, correct only what the reader misread, and confirm it. Only the confirmed transcription is checked.
- **A transcript cannot fix artwork.** Editing it does not change the image. To fix a claim that is printed in the artwork, **replace the image**, then read, compare and confirm again. BrandProof cannot compare a transcript with the pixels, so a person could still type words the image does not print; who confirmed it is recorded, and that is all. Details: [ocr-image-text.md](ocr-image-text.md).
- Nothing is sent anywhere: the reader runs on this computer.

## Start commands

PowerShell, from the project folder (Git Bash accepts the same `npm run` lines):

```
npm run demo:start          # showcase: use only the read-only route below; prints its URL (4174 or the next free port)
npm run demo:consequence    # isolated: the 12 -> 8 hours story; prints its URL (4180 or the next free port)
npm run demo:imagetext      # isolated: text in the image; prints its URL (4185 or the next free port)
```

Stop each with Ctrl+C in its own terminal. Only to (re)build the showcase data without serving (stop the showcase server first, so two processes do not write one file): `npm run demo:bootstrap`.

Each launcher refuses any data path under `data/`. To give a mutating demo a **brand-new private copy** of its story instead of its default file, point the matching variable at a path that does not exist yet and is outside `data/` and outside `demo-data/` (`BRANDPROOF_CONSEQUENCE_DATA`, `BRANDPROOF_IMAGETEXT_DATA`; for the showcase `BRANDPROOF_DEMO_DATA`). The launcher then builds the story there from nothing. It never needs, and these docs never ask for, moving, deleting or reseeding an existing data file.

### Optional parts and their fallbacks

| If this is missing | What you see | What still works | How to enable (optional, run by you) |
|---|---|---|---|
| The OCR package or its language data | `demo:imagetext` prints `Reading text from images: UNAVAILABLE (reason)`; in the editor the **Read text from image** button is disabled and says why | Everything else, including **typing the transcription yourself**, confirming it and having it checked | `npm install` then `npm run fetch-ocr` (downloads the pinned 4.1 MB English data once, verifies its SHA-256; nothing of yours is sent) |
| The embedding model | The showcase prints `AI source matching: UNAVAILABLE (reason)` | Everything except *Find relevant sources* | `npm install` then `npm run fetch-model` |
| Edge or Chrome | `npm run judge-rehearsal` and the `ui-smoke-*` runs cannot start | The live demos in a browser you open yourself | install one, or set `BRANDPROOF_BROWSER` to its path |
| A free port in the range | `No free port from N to N+15` | Nothing starts | set `DEMO_PORT` to a free port |

## Presenter route 1: read-only tour of the preserved showcase (port 4174)

Use this route on `demo-data/fernlight-showcase.json` and nothing else. It only **looks**: opening campaigns, findings, the exact source passage, History, the dossier and the impact preview write nothing. Whoever presents must not press any button that saves. The server does not enforce this (demo mode has no read-only switch), so it rests on the presenter. **Do not press:** Save as revision, Request review, Approve / Reject / Request changes, Approve version / Withdraw, Publish new version, Relink, anything that registers a source, creates a campaign, uploads an image or posts a comment.

1. **SUB-6** (a draft with blocking findings): read the highlighted copy. Open the first finding: it names the approved fact and shows **Registered source SRC-1 v1**. Click *Open the exact passage in the source*: the cited sentence is highlighted in the fact sheet.
2. **SUB-4** (Approved): open *History*: two revisions, each with its own image. The approval note names what it was bound to.
3. **SUB-5** (Re-review required): the image was replaced after approval, so the approval no longer applies. Open *History* to see both images.
4. Press **Review dossier** on SUB-4 or SUB-5: the one-page record (recorded decisions against findings recomputed today, exact cited passages, image integrity). *Download JSON snapshot* only saves a file to your Downloads folder. It is a local snapshot, not a certificate.
5. **Sources, SRC-1**: version 2 is pending. Acting as **Manager**, open *Version 2* and press **Preview impact…**. Read it (read-only: three citations with the same words in the same place, SUB-4 would become *Re-review required*, SUB-3 in review would be blocked until repair, and what is *not* covered). **Stop there: do not press Approve version.** This showcase's version 2 only adds a care note; for "the battery claim changes" use route 2.
6. **AI source matching** (only if the launcher printed `READY`): on SUB-6 tick a passage and *Find relevant sources*. Say what it is: relevance with similarity scores, not a verdict on truth or compliance.

The showcase builds these items (idempotent, never destructive):

| Item | State you will see |
|---|---|
| **SRC-1** "Fernlight Aurora Lamp fact sheet (fictional showcase)" | version 1 registered by the Creator role, **approved** by the Manager role (in force); version 2 registered and left **pending** on purpose |
| Guidelines v2 | facts FCT-001 (battery), FCT-002 (indoor use) and FCT-004 (warranty) **linked to exact passages** of SRC-1 v1; everything else stays explicitly **Legacy** |
| **SUB-4** Aurora launch banner | revision 1 a problematic draft (name-only image details), revision 2 corrected with a **retained image**, review requested, **approved** by the Reviewer role |
| **SUB-5** Winter reading lamp post | approved with image A, then image B saved in revision 2: shows **Re-review required** (image details changed); history keeps both images |
| **SUB-6** Waterproof claim draft | a draft with blocking findings (30 hours, "waterproof") whose evidence is a **Registered source** with an openable exact passage |
| SUB-1 to SUB-3 | the original seeded fictional campaigns |

## Presenter route 2: the source changes (isolated, may be changed freely)

`npm run demo:consequence` (own data file; prints its URL, 4180 first). It builds the story up to the moment before the manager looks at the pending version 2 ("up to 8 hours"). Exact clicks, in order, are in [judge-rehearsal.md](judge-rehearsal.md): Preview impact, activate, *Re-review required*, repair in the Brand library, apply the safe correction, a different role approves, dossier. The same story is replayed by `npm run judge-rehearsal` on throwaway data with distinct signed-in accounts (needs Edge or Chrome; it makes no claim about how long a person needs).

`npm run demo:rehearse` replays the showcase's own source-activation and repair steps **through the API on throwaway data** (it never touches the preserved showcase file).

## Presenter route 3: text in the image (isolated, may be changed freely)

`npm run demo:imagetext` (own data file; prints its URL, 4185 first, and whether reading is AVAILABLE or UNAVAILABLE). Open the campaign **"Banner with text in the image"**; its retained banner prints "The battery lasts 30 hours on a single charge" and nothing has been transcribed yet. Acting as **Creator**:

1. *Edit as new revision* → **Read text from image**. A draft appears, labelled as possibly wrong. (If reading is unavailable, type the transcription instead.)
2. **Compare it with the printed words, digit by digit.** Correct only what the reader misread. Tick the confirmation. *Save*.
3. The 30-hour claim is now a finding on the **text in the image**, with its exact source passage and advice instead of a rewrite. Show the sentence on the page: *Match the words actually printed. Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.*
4. Do **not** edit the transcript to say 12 hours. Instead *Edit as new revision* and choose the corrected artwork `tests/fixtures/ocr/qualified-banner.png`, which really prints "up to 12 hours at medium brightness". The old transcription is dropped, not carried. Read the new image, compare, confirm, save: the findings are now consistent.
5. As Reviewer: the approval is bound to the confirmed text and the exact image; replacing the image again makes it *Re-review required*.

Limits to say out loud: the reader is a draft generator (clear synthetic text was read exactly in the proof; tiny, rotated, script or low-contrast text was not, and a digit misread such as "3@ hours" is possible); a confirmation is a person's record, not verification; nothing is read about colour, contrast, logos or layout from the image. Measured evidence: [ocr-phase-a.md](ocr-phase-a.md).

## Keep these honest points in the talk

Roles are a demo switch; sources are plain pasted text (no PDF or URL fetching); colours are chosen by a person (typed, picked or sampled from one clicked pixel), never extracted automatically; text in an image is checked only through a transcription a person confirms against the printed words; findings come from deterministic rules; the AI matcher is a small local embedding model, not generative review; data is stored unencrypted on this computer. No speaking time has been measured.

## Back up and move the data

The workspace is **two things**: the JSON file and its `.assets` folder of retained images. **Copy both together, with that demo's server stopped**:

```
demo-data/fernlight-showcase.json
demo-data/fernlight-showcase.json.assets/
```

Copying only the JSON leaves revisions pointing at images that are not there (they show a "could not be loaded" message and cannot be reviewed or approved until the same image is uploaded again). Authenticated mode additionally writes timestamped `*.bak-*` copies of its JSON files when it starts; the demo mode does not, so copy before you experiment. There is no deletion of sources or images in this version. A `.lock` file beside a data file is a runtime ownership marker, not data (see [single-writer.md](single-writer.md)).

## What activating or withdrawing a source does

Registering a source or a new version, and rejecting one, change nothing about existing approvals. **Approving a replacement version** or **withdrawing** a source that rules cite makes the cited evidence "no longer in force": approvals resting on those rules show **Re-review required** (reason: evidence), nobody can approve until a manager relinks or unlinks the affected rules and publishes, and publishing other guideline changes is refused until then. The unchanged history and each earlier approval stay readable. Details: [sources.md](sources.md). This is the part of the story to demonstrate on route 2, not on the preserved showcase.

## If something goes wrong

- *"No free port"*: another program holds the whole range; set `DEMO_PORT` to a free one.
- *AI source matching UNAVAILABLE*: the optional package or model is missing (`npm install`, `npm run fetch-model`). The demo works without it.
- *Reading text from images UNAVAILABLE*: the optional OCR package or data is missing (`npm install`, `npm run fetch-ocr`). Typing the transcription still works.
- *An image shows "could not be loaded"*: its file is missing or damaged. Upload the same PNG again in an edit (in an isolated demo); identical bytes restore it.
- *A mutating demo looks wrong after experimenting*: do not touch the preserved showcase or `data/`. Stop that demo, then start it on a **new, empty data path** (the variables above) to get a fresh story; keep the old file as history.
- *The showcase must stay as it is*: if anyone saved something by mistake, do not "fix" it by deleting files; restore from the copy you made before the session (see Back up).
