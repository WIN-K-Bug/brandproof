# Review dossier

One campaign's current saved state, the evidence behind it and the recorded decisions, in one place: a readable, printable page and an explicit JSON download. It answers "what exactly was reviewed, using which evidence, and what did the people decide?" without collecting scattered screens.

It is a **factual local snapshot**. It is not a compliance certificate, a signature, a tamper-proof ledger or permission to publish, and it says so on the page and in the file.

## Where

- Open a campaign and press **Review dossier** (address `#/dossier/SUB-n`).
- **Print** uses the browser's print dialog (a print stylesheet hides navigation and buttons). No PDF library or service is involved.
- **Download JSON snapshot** is an explicit button: the browser builds the file from what the server returned and saves it under a fixed safe name, `brandproof-dossier-SUB-n-revN.json`. Nothing is downloaded or sent automatically, and nothing is uploaded.
- API: `GET /api/submissions/:id/dossier`. Read-only. Any signed-in role may read it in authenticated mode (a session is required); in demo mode, like the campaign itself, it needs no role.

## What it contains

| Section | Content |
|---|---|
| Snapshot | format and version, time taken, engine description, a prominent "may be out of date" note |
| Status today | workflow status, a one-sentence headline, what stands in the way today (blocking findings, evidence no longer in force, an image that cannot be verified), finding counts (no readiness score), factual separation-of-duties note |
| Copy as saved | the current revision's exact text, author, time, content digest; older revisions as digests only |
| Image | none / metadata-only / retained, and for a retained image its digest, size, dimensions, uploader, and the integrity verified **now** (ok, corrupt, missing, unavailable) |
| Guidelines and evidence | guideline version and hash, evidence hash, every linked rule with source, version, passage offsets and state; legacy count |
| Recorded decisions | every stored event with actor, note, time and the binding hashes it covered, each compared with the saved inputs now (still matches, or which input changed) |
| Findings recomputed today | rule, status, quote, span, correction, evidence, provenance (registered with source/version/offsets/state, or legacy typed) |
| Cited source passages | the exact cited passage cut from the registry text (≤ 500 characters), its source version, state and digest, and an in-app link |
| Limits | fixed statements, plus a checksum with what it can and cannot show |

**Recorded versus recomputed.** Decisions, actors, notes and the hashes each decision covered are stored data and are labelled *Recorded*. Findings are produced again today by the rules against today's guidelines and are labelled *Recomputed*: the findings a reviewer actually saw in the past were never stored, so none are reconstructed or implied.

**A past approval is not "ready today".** If the image is corrupt or missing, evidence is no longer in force, or blocking findings exist, the headline and the "standing in the way" list say so even when the recorded approval still matches the saved inputs.

## What it deliberately leaves out

Filesystem paths, credentials, password hashes, session and CSRF data, login usernames, emails, source full texts (only cited passages), image bytes, comment bodies (only a count), other campaigns and the model cache. Links are addresses inside this local workspace and the page says they are not public or shareable.

## Coherence

The snapshot is built by a pure function from **one committed state**, so everything in it belongs together. The only asynchronous input is the image integrity check, read from disk. The route records which committed state it started from, awaits the check, and accepts the result only if the store still holds that very state; otherwise it rebuilds (up to four attempts) and then answers `409 snapshot_changed` rather than returning a mixture. The response is deterministic for a given state and clock.

## What each digest is a digest of

The file and the page state this (`hashMethods`). These are descriptions of the existing, unchanged methods; they do not change any approval binding. All are lowercase hex SHA-256, of *different things*, and must not be compared with one another.

| Field | Digest of |
|---|---|
| `currentRevision.contentSha256` | the canonical JSON `{"text": <saved copy>}` (keys sorted, UTF-8). **Not** the raw text bytes. |
| `image.sha256`, `retainedImageSha256` | the **actual bytes** of the retained PNG, computed by the server |
| `versionTextSha256` (source) | the UTF-8 bytes of the source version's **normalised** text (LF endings, composed accents); not any original file |
| `assetBindingHash`, `guidelines.hash`, `evidence.hash` and the hashes inside recorded bindings | canonical JSON of **metadata**: the image details (with the retained digest as a string, not the bytes), the whole guideline set, and the linked rules with the state of the source version each cites |
| `checksum.value` | the canonical JSON of every other field of the file |

Each is recomputed independently in `tests/dossier.test.js`.

**Fingerprint note.** An image details record may hold a "browser-reported fingerprint". For a *retained* image the app copies the server's digest into it, and the dossier says whether it still equals the server-computed digest (a difference would be reported, not hidden; the server refuses to save one). Only a legacy **metadata-only** record says the image itself was not held and cannot be checked.

## Checker revision

`snapshot.engine.checkerRevision` (for example `rules-2026.10.24-denied-context`) is a **hand-maintained label** bumped by the authors when the rules change in a way that can change findings. It is not derived from the code, not a build identity or signature, and a forgotten bump is possible; otherwise the rules are unversioned. The dossier says so. `formatVersion` is 3 (version 1 files lacked `hashMethods` and the checker revision; version 2 lacked the `imageText` block and `hashMethods.imageTextHash`).

## Checksum

`checksum.value` is SHA-256 over the canonical JSON (sorted keys) of every other field. It lets a reader notice accidental change. Anyone can recompute it, so it is **not** an authenticity check and does not prove who produced the file.

## Measured (synthetic fictional data, 24 Oct 2026)

`tests/dossier.test.js`, 14 tests: content and exact cited excerpt with registered and legacy provenance; checksum recomputation and sensitivity; read-only (data file byte-identical); no paths, secrets, usernames, source full text, image bytes or comment bodies; images (none, metadata-only, retained and verified, same-size corruption, missing file, restoration, a past approval not called ready); stale approval after a source change with the recorded binding unchanged and the reason named; a commit during image verification yields a rebuilt, consistent snapshot; a workspace that keeps changing yields 409 after four attempts; hostile text stays data; demo and authenticated permissions (401 without a session, forged role header ignored, usernames and credentials absent, separation-of-duties stated by account id). Each control was removed in turn (recheck after verification, bounded retry, integrity read, not-ready note, metadata-only presentation, comment/source/path leaks, stale-binding comparison, checksum): the suite failed every time.

Browser, `npm run ui-smoke-dossier` (authenticated mode, synthetic accounts, fictional sheet, generated PNG), 25 of 25: signed-out visitors see only the sign-in form; the report, headings and warnings; hostile-looking title and copy render as text; a real browser download is saved under the fixed name, parses, matches its checksum, causes no network request, and agrees with the visible report on title, copy, digests, every finding, every event and every cited passage; the file contains no path, credential, username, source full text or image bytes; after a source change the page says Re-review required and why; with the stored image damaged it says it is not ready today; keyboard reach of the button; print layout; 420 px with no horizontal scroll; unknown campaign gives a clear error; the retained image is not called unretained; the page explains what each digest is a digest of and states the checker revision with its honest note. Screenshots: `docs/evidence/dossier-1-report-top.png` … `dossier-6-narrow.png`.

## Limits

- Current campaign only. Older revisions appear as digests, not text; no mass export, no sharing, no PDF.
- Historic findings are not reconstructed (they were never stored).
- A downloaded file is a point-in-time copy and can be out of date immediately; it is only as trustworthy as the workspace it came from (unencrypted local storage, demo roles or local accounts).
- The image integrity is checked when the dossier is built; the bytes themselves are not included.
- The checksum is not a signature.
