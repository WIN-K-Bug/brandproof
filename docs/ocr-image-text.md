# Text in images: read a draft, correct it, confirm it

An optional, local, human-confirmed way to bring the words inside a retained campaign image under the same checks as the copy. **Experimental and awaiting independent review.** The feasibility evidence is separate: [ocr-phase-a.md](ocr-phase-a.md).

## What it is, in one paragraph

A person editing a revision with a retained PNG can press **Read text from image**. A pinned, offline Tesseract.js reads the image on this computer and returns a **draft**. The person compares it with the image, corrects it, ticks an explicit confirmation and saves a new revision. The server stores the confirmed text as a **separate field** of that revision, bound to the exact image digest, attributed to the signed-in account, with honest provenance. The existing rules then run over that transcription as their own field, so findings, quotes, offsets and source links refer to it. The confirmed text and the image digest are part of the approval binding, so changing either makes the approval stale.

## The rule: match the words actually printed

The transcript records what the image says. **Editing it does not change the image.** A person corrects only what the reader misread (for example a capital "Up" that is printed as "up", or a digit) so that the text equals the printed words. To change a claim that is printed in the artwork, **replace the image, then transcribe and confirm again**. The editor, the saved card, the advice on every finding in the transcription and the review dossier say so in these words: *Match the words actually printed. Editing this transcript does not change the image. To fix a claim in the artwork, replace the image, then transcribe and confirm again.* The confirmation reads "I compared this text with the words printed in the image, digit by digit, and confirm that it matches them."

**Limit (stated in the same places):** BrandProof cannot compare the transcript with the pixels, so a person can still type words the image does not print. That would defeat this check; the system records who confirmed it, against which exact image digest, and whether the text came from a reading or was typed and edited, but it cannot prevent it. No demonstration, test or screenshot uses a transcript that differs from what its image prints as a repair.

## What it is not

- It is **not a verifier.** OCR can misread any word or digit and can miss text entirely (see the hard set in the proof). A confirmed transcription is a person's record of what the image says, **not** evidence that the reading was right, and never source evidence or an approval.
- It does **not** read colours, contrast, logos or layout, and does not claim the whole image was captured. Text that was not transcribed is not checked, and the page says so.
- It is **not required.** Without the optional package or language data the reading is "unavailable" with the reason, the manual transcription box still works, and everything else is unchanged. Nothing is downloaded automatically.

## Setup (optional)

```
npm install            # installs the optional, exactly pinned tesseract.js 7.0.0 (and its WASM core 7.0.0)
npm run fetch-ocr      # downloads the pinned English data (4.1 MB) into .cache/ocr and verifies its SHA-256
```

Pins, licences (Apache-2.0 for the engine, WASM core and data) and the upstream commit are in `src/ocr-engine.json`. `.cache/` and `node_modules/` stay out of the source package and backups. `BRANDPROOF_OCR_DIR` overrides the data folder. Run live: `npm run demo:imagetext` (separate fictional data, port 4185 or the next free one).

## Architecture (`src/ocr.js`, `src/ocr-worker.js`)

- The engine runs inside **its own worker thread**; the service can terminate that thread at any time, which also stops anything the library started inside it.
- **One recognition at a time, two waiting, then `429 ocr_busy`.** A hard **30 s timeout** terminates the thread (`504 ocr_timeout`); a worker error, crash or exit fails only the job running on it (`502 ocr_failed`, path-free message) and the next job starts a fresh worker. A late message from a worker that is no longer current is ignored. The worker stops after 60 s idle. Results over 4,000 characters are refused (`422`). Images above 4 million pixels or 2 MiB are refused (they cannot be retained anyway).
- **Cancellation:** closing the browser connection aborts the request; a queued job is removed, a running one stops the worker.
- **Local only, by construction:** the worker is always given a local `langPath`; the data file's presence, size **and SHA-256** are checked before any worker starts. Missing or altered data is `503 ocr_unavailable` ("run `npm run fetch-ocr`"), never a fetch.
- **Drafts** are held in memory only (32 entries, 1 hour), keyed by engine fingerprint **and image digest**. A cached result is returned only for the identical image.

## Server contract

| Route | Rule |
|---|---|
| `GET /api/ocr/status` | state, reason, engine and limits; no paths |
| `POST /api/assets/:sha/ocr` | **creator or manager** only (session + CSRF + Origin in authenticated mode). `:sha` must be a 64-hex digest **registered in this workspace**: no paths, no URLs. Optional body `{submissionId, revision}` ties it to a saved revision, which must really hold that image (`409 image_mismatch`). The bytes are read and hashed first: missing → `404 asset_missing`, damaged → `409 asset_corrupt`, and the engine is never reached. The response is bound to the digest and says whether the revision has been superseded meanwhile. |
| `POST /api/submissions` and `…/revisions` | optional `imageText: { text, draftId?, confirmed }`. Only those three fields are read. **Who, when, which image and what kind of provenance are set by the server.** |

Server rules when saving a transcription: it needs a retained image (`422 no_retained_image`); `confirmed` must be exactly `true` (`422 confirmation_required`); an OCR draft is accepted as the source only if it is still held **and was made for this very image** (`409 ocr_draft_stale`: a late or stale reading can never attach to another image); an unknown draft id is recorded honestly as `typed` with `draftUnavailable`; with no new confirmation, the previous one **carries forward only for the identical image digest**, otherwise the revision has none (so replacing or removing the image drops it). Forged `confirmedBy`, `imageSha256`, `confirmedAt` or provenance in the request are ignored (tested).

## Stored record and approval binding

```
revision.imageText = {
  text, imageSha256, confirmedBy: { id?, name, role }, confirmedAt, confirmedInRevision, carriedFromRevision?,
  provenance: { kind: 'ocr-draft' | 'typed', edited: boolean | null,
                draft?: { id, textSha256, confidence, engine }, draftUnavailable? }
}
```

`imageTextHash = SHA-256(canonical({text, imageSha256}))` joins the approval binding **only when a transcription exists**, so every earlier binding compares exactly as before. A change to the transcription or the image yields the stale reason `imagetext` (and `asset` for a different image). The decision `expected` binding includes it: a client that omits or forges it gets `409 stale_view`. The review dossier (format 3) shows the confirmed text, who confirmed it, the digest it was confirmed against, whether it matches the retained image, the reading's engine and confidence heuristic, and what a confirmation does not prove.

## Checks on the transcription

The same text rules run over the confirmed text as the distinct field `imageText` ("Text in the image"). Spans and quotes slice the transcription; sources and explanations are unchanged. **Corrections are advice only** (the words live in the image; a replacement is quoted as suggested wording). When a retained image has no confirmed transcription, the findings panel says the text in the image was **not checked**.

## UI

In the editor, under the image: *Read text from image* (disabled with the reason when unavailable), *Cancel reading*, a progress/error area, a textarea for the person's transcription, and a **confirmation checkbox** (keyboard-operable) that must be ticked to save new or edited text. A late reading (another image, another draft, cancelled) is dropped. If the person already has text, a reading never overwrites it (an explicit "replace" button). In the view: a "Text in the image" card (confirmed by whom, from a reading or typed, edited or not), highlighted findings, and **Show in the text in the image** links from each finding.

## Evidence

- **Phase A** (separate): [ocr-phase-a.md](ocr-phase-a.md).
- **Tests:** 310 in the suite: 309 pass and 1 platform skip with everything installed; with the reader's language data absent 302 pass and 8 are skipped (the 7 real-engine tests and the platform test); with the embedding model also absent 301 pass and 9 are skipped; none fail. See [verification.md](verification.md). New: `tests/ocr.test.js` (11, service with a fake worker: bounded queue, timeout, crash/exit/error with path-free messages, late callbacks ignored, cancellation, idle stop, oversized result, cache bound to the digest, no number "fixing"), `tests/ocr-api.test.js` (15: bound to a retained digest and roles, damaged/missing bytes, revision references and a revision saved during a reading, queue bound over HTTP, connection-close cancellation, server-decided provenance and forged fields, explicit confirmation, stale drafts, findings on the transcription, binding and stale reasons on transcription/image change, carry-forward vs drop, decisions with old or forged `expected`, dossier, authenticated sessions/CSRF/roles/separation of duties), `tests/ocr-real.test.js` (7, **real engine**, skipped without it: the corrected-artwork banner is read exactly and its findings are consistent, clear fixtures exact against declared transcriptions, hard fixtures fail as recorded and are not repaired, **network blocker live with 0 recognition attempts**, missing or altered language data unavailable with 0 attempts, timeout recovery and undecodable bytes, bounded concurrency). 27 mutations of the new logic: 26 failed the suite; the 27th (first stale-worker guard) is equivalent because three further checks already ignore late messages.
- **Browser:** `npm run ui-smoke-ocr` runs the whole slice with the real reader **under the network blocker**: 36 of 36. A 30-hour image is read (draft equals the words it prints, declared in advance) → refused unconfirmed save → confirm → finding on the transcription with its exact source link, advice that tells the person to replace the image (no rewrite) → replace the image with a rotated one, which the reader really misreads ("Up" for the printed "up", as measured in Phase A) → the person corrects ONLY that so the transcript equals the printed words (the flow adapts: if the reader were right it would confirm unchanged) → save (provenance ocr-draft, edited) → replace the image with the **corrected artwork that prints every approved qualifier** → read, equal to the printed words, confirmed with no edit → findings consistent → request review → a different signed-in reviewer approves (binding names the transcription) → dossier states the rule and the limit → replace the image again → Re-review required naming the image and the text in it → 0 network requests beyond the deliberate control. Every confirmed transcript is asserted equal to the predeclared printed text of its fixture. No step changes a transcript to a claim its image does not print. With the reader off: 4 of 4 (button disabled with the reason, typed transcription saved as `typed`, checked like any other text). Screenshots: `docs/evidence/ocr-*.png`, `ocr-off-1-unavailable-typed.png`.

## Limits

- Feasibility was shown on **synthetic, flat-rendered** text; real photographs and other languages are untested (English only).
- A reading can be wrong or empty (hard set: tiny text, steep rotation, script fonts, white text over a gradient). The person is the check; there is no automatic comparison with the image.
- A confirmation proves a person saved that transcription, not that it is right. There is **no OCR-based contrast, palette, logo or layout check**.
- Drafts live in memory and are lost on restart (the transcription itself is stored with the revision).
- The reading takes about 0.1 to 0.8 s once started; it is local CPU work and unavailable on a machine where the optional packages cannot run.
- One shared reader per server, bounded; a busy reader refuses extra requests.
- The cached draft and the saved transcription are unencrypted local data like everything else.
