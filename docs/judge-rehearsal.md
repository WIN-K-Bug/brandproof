# Judge-style rehearsal and clean-install check

Two things were verified: that the whole evidence story runs end to end in a real browser with distinct signed-in people, and that the credential-free source package can be extracted and run somewhere clean. Both used only synthetic temporary data. Nothing here is a human study, a spoken-demo timing or a claim about how long a person needs.

## 1. The 12 → 8 hours scenario

The showcase demo's pending version 2 only adds a care note, so it cannot honestly narrate "the battery claim changes". The scenario below is **separate and fictional**: a fact sheet says battery life is "up to 12 hours at medium brightness", and a replacement version says "up to 8 hours". Activating it makes the governing passage disappear while two other cited passages stay put, so the narration is literally what happens.

### Replay it

```
npm run judge-rehearsal      # headless Edge/Chrome, throwaway authenticated workspace, ~90 s, never touches data/ or a running server
```

Needs Edge or Chrome (`BRANDPROOF_BROWSER` overrides the path). It prints PASS/FAIL per check, an action and time table, and writes screenshots to `docs/evidence/judge/` and a machine-readable `rehearsal-report.json` beside them.

To run the same story **live by hand** (demo mode, role switch; this is the mutating demo for the source-change story, so do it here and never on the preserved showcase: see [demo.md](demo.md)):

```
npm run demo:consequence     # port 4180 or the next free one; data in demo-data/aurora-8h-scenario.json (own file, idempotent)
```

It builds the story up to the moment before the manager looks at the pending version: approved fact sheet v1, three facts linked, an approved campaign with a retained image, and version 2 (8 hours) pending. Then, acting as **Manager**: Sources → the fact sheet → Version 2 → *Preview impact…* → *Approve version…*; as **Reviewer**/**Creator** see *Re-review required* and the blocked approval; as Manager repair in the Brand library (*Choose passage…* for the battery fact, change its value and statement to 8 hours, *Relink to same quote…* for the other two, *Publish new version*); as Creator apply the safe correction and request review; as Reviewer approve; open *Review dossier*. In demo mode the "different person" is a role switch, not an identity; the rehearsal above uses real signed-in accounts. (The seeded sample campaigns are also in that workspace, so the preview's totals include them.)

### What the rehearsal drives (all through the real UI)

Setup, not counted: three synthetic accounts, the fact sheet version 1 registered and approved, three facts linked, guidelines published (the registration, approval and linking screens have their own walkthrough in `ui-smoke-sources`).

| # | Step | Evidence |
|---|---|---|
| 1 | A claim ("30 hours") is flagged against the registered fact sheet; its exact passage opens highlighted | `01-claim-finding.png`, `02-exact-passage.png` |
| 2 | The creator applies the safe correction (keeps "up to" and the condition), attaches a PNG (retained by the server), requests review | `03-corrected-with-image.png` |
| 3 | A **different signed-in reviewer** approves; the approval is attributed to a non-author | `04-approved.png` |
| 4 | Version 2 ("up to 8 hours") is registered as a draft; version 1 stays in force | |
| 5 | The manager previews the impact (file bytes unchanged), reads the exact old and new lines, then activates | `05-impact-preview-top.png`, `06-impact-preview-dependencies.png` |
| 6 | **Re-review required** with the evidence as the reason; a new review cannot be approved ("no longer in force") | `07-stale-approval.png`, `08-approve-blocked.png` |
| 7 | The manager edits the fact to 8 hours, relinks all three rules to version 2, publishes | `09-repair-panel.png`, `10-fact-edit.png` |
| 8 | The old copy is now a blocking contradiction; the creator applies the safe correction and requests review | |
| 9 | The reviewer approves again; history keeps **both** approvals with different evidence hashes | `11-approved-again.png` |
| 10 | The dossier shows Approved, image integrity verified now, the exact new passage; a real JSON download is parsed, checksum-verified and compared with the page | `12-dossier.png` |

### Recorded run (24 Oct 2026, this machine): SCRIPTED and AUTOMATED

29 of 29 checks passed. **88 automated actions** (an action is one fill, click, select, key press, file choice or address change): 49 in the story and 39 spent on 10 sign-ins (four actions each, three for the first; the story switches between the three accounts several times). By account: creator 37, reviewer 26, manager 25. By kind: 48 clicks, 27 fills, 10 address changes, 1 file choice, 1 select, 1 text selection. Wall-clock **87 s**, which includes fixed sleeps of 0.5 to 1.3 s after almost every action to let the page settle.

These are properties of the script. They are **not** how long a person needs, not an estimate of a spoken demonstration, and not evidence of time saved. Per-step counts and times are in `rehearsal-report.json`.

### Failure and recovery behaviour seen

- A stale preview: covered in `ui-smoke-impact` (approval refused, preview reloads, box cleared).
- Blocked approval until repair: step 6 above.
- A damaged stored image: covered in `ui-smoke-dossier` (reported as not ready today).

## 2. Clean install check of the source package

*(A dated record of the 24 Oct 2026 check on an earlier package with 269 tests. Later checkpoints re-ran the clean extraction with their own counts in [verification.md](verification.md) and the handoffs; the optional OCR reader and its fallbacks are described in [demo.md](demo.md) and [ocr-image-text.md](ocr-image-text.md).)*

The package (`npm run package`, `dist/brandproof-source*.zip`) was extracted into a new temporary directory **outside the project** with Windows `tar.exe` (`tar -xf package.zip -C <empty dir>`; GNU tar from Git Bash cannot read zips). It holds 177 entries and no `node_modules`, `.cache`, `data`, `demo-data`, `.git`, `.env`, credentials, backups or model weights. Four copies were checked on Node 22.19.0 / npm 11.6.2, Windows 11. The project's own folder name contains a space; the copies did not, so both layouts have run.

| Copy | State | Result |
|---|---|---|
| **A** | package only, **no dependencies, no model** | `npm test`: 269 tests, 267 pass, 0 fail, **2 skipped** (the real-model test and the POSIX-only signal test). `npm run eval`, `eval:claims`, `demo:rehearse`, `demo:consequence` (built the scenario in 7 steps), `ui-smoke-impact` (25/25) and `judge-rehearsal` (29/29) all pass. No `node_modules` was ever created. |
| **B** | A **plus a COPY of this machine's existing `node_modules` and `.cache`** | `npm test`: 268 pass, **1 skipped** (the POSIX-only signal test). `verify-semantic` runs the real local model. Server status `ready`. **This is a copied local install, not a fresh download.** |
| **C** (B with settings) | model directory empty / `BRANDPROOF_SEMANTIC=off` | status `unavailable` with the reason in each case; the app serves and all other behaviour is unchanged |
| **D** | package only, then `npm ci --offline` (network forbidden) | succeeded in 9 s: 53 packages from the **local npm cache** (`@huggingface/transformers` 3.8.1, matching the lockfile). `npm test`: 267 pass, 2 skipped (no model weights: they are not in the package or in npm and need `npm run fetch-model`, which needs the network). **The cache was filled by an earlier real download on this machine, so this is not proof of a clean offline install either.** |

**Not proven, and not claimed:** a truly fresh dependency download (no network install was run, by instruction); fetching the model from scratch; any Node older than 22 (only 22.19.0 was available; `engines` is advisory in npm and older Node would fail at syntax); macOS or Linux.

### Startup, ports and failures (from copy A, default settings)

Commands: `node server.js` (or `npm start`); `PORT=4301 node server.js` (PowerShell: `$env:PORT='4301'; node server.js`); `DEMO_PORT=4340 npm run demo:start`; `BRANDPROOF_MODE=authenticated node server.js`.

| Situation | Behaviour observed |
|---|---|
| default start with 4173 and 4174 already in use by other servers | listened on **4175**; used its own `data/brandproof.json` inside the copy; the original data and both running servers were untouched |
| a second default start on the **same data file** while the first is running | refused: `Could not start: Another BrandProof process (pid N …) has this workspace file open … use the running server or a different data file`, exit 1, no port taken (a different data file would take the next free port); see [single-writer.md](single-writer.md) |
| `PORT=4301` free | listened on 4301 |
| `PORT=4302` busy (occupied by a throwaway listener) | next free port, 4303 |
| `PORT=abc` | fell back to the default and then the next free port |
| all 20 ports from `PORT` busy | `Could not start server: listen EADDRINUSE …`, exit code 1 (after the fix below, with no listener warning) |
| corrupt data file | `Could not start: Data file … is not valid JSON. Fix or move it; BrandProof will not overwrite it.`, exit 1, file unchanged |
| wrong schema version | refuses, names the version |
| authenticated mode with no users | starts, says `No users yet…run npm run auth:setup`, creates no account |
| `npm run demo:start` in the copy (no `demo-data` in the package) | built the whole fictional showcase from nothing (14 steps) and served it on the requested port; AI matching reported `UNAVAILABLE` with the reason in A, `READY` in B |
| model absent | `/api/semantic/status` is `unavailable` with the reason; the UI card says so; nothing is mocked |

**One defect found and fixed:** retrying a long run of busy ports printed Node's `MaxListenersExceededWarning`, because each failed `listen()` left its `listening` callback registered. `listen()` now removes both callbacks on either outcome; `tests/listen.test.js` occupies 14 ports, retries them all, and asserts no leftover listeners and no warning (it fails without the fix).

### Limits seen

- `/api/semantic/status` includes the local path of the model folder in its `reason` text when the model is missing. It is a localhost, same-machine value (a session is required in authenticated mode), and the dossier does not include it, but it is a local path in an API response.
- The rehearsals need an installed Edge or Chrome; the core app and tests do not.
- With the model present, `demo:start` waits for it to warm up (up to 90 s, then it reports the state honestly); in copy B it was ready within the 20 s I allowed.
