# Verification notes

What was actually run, and how to reproduce it. Nothing here is a claim about real-world accuracy.

Environment of the recorded runs: Windows 11, Node.js 22.19.0, Edge (headless) for the browser checks, 24 Oct 2026.

## 1. Automated tests

```
npm test
```

Recorded result with the optional package and model installed: **310 tests, 309 passed, 0 failed, 1 skipped** (the 204 earlier tests, 17 factual-qualifier tests, 33 image-text tests (11 reader-service, 15 API/provenance, 7 real-engine) and 1 extra scenario test, 15 impact-preview tests, 14 dossier tests, 1 port-fallback test, 2 scenario tests and 23 single-writer tests; the one skip is the POSIX-only SIGTERM test, which cannot run on Windows; one test runs the real local model).

Recorded result with the model directory pointed at an empty folder (`BRANDPROOF_MODEL_DIR=<empty dir> npm test`): **310 tests, 301 passed, 0 failed, 9 skipped when BOTH optional parts are absent** (302 passed and 8 skipped with only the reader's language data absent; 309 and 1 with everything installed). The skips are the real-model test, the 7 real-engine OCR tests and the POSIX-only signal test (the same single skipped real-model test; everything else passes without the model). The skipped test is the real-model test and it prints the reason. The app starts and serves with the AI source matching status "unavailable", and all other tests pass. This is how the core app is shown to be runnable without the optional dependency or model.

Coverage by file:

| File | Focus |
|---|---|
| `tests/checks.test.js` | Rule engine: terminology, facts, claims, negation, qualifiers, clauses, contrast, palette, alt text, spans. |
| `tests/workflow.test.js` | Stale-approval detection for copy, image details and guideline changes; eligibility and role gates; acknowledgement; **decision on a stale view returns 409**; guideline versioning; comparison; insights. |
| `tests/store.test.js` | Serialised atomic persistence, failure isolation, corrupt-file refusal; word diff; AI adapter contract. |
| `tests/validate.test.js` | Input validation and normalisation. |
| `tests/api.test.js` | HTTP: headers, Host/Origin guard, static-file escape attempts, size limits, end-to-end flow, concurrency (parallel comments, revisions, creations, restart persistence), hostile text. |
| `tests/semantic.test.js` | Source caching by guideline hash, ranking, bounded queue and single concurrency, stale results discarded when the guidelines or revision change **during** inference, unavailable states, worker lifecycle (a late exit from an old worker cannot kill its replacement), and the real model. Uses a clearly labelled test-double embedder for plumbing tests only; the real model test is separate. |
| `tests/detection.test.js` | Detection fixtures (below). |
| `tests/single-writer.test.js` (+ `fixtures/writer-child.mjs`) | One writer per data file with REAL separate processes (23 tests, 22 run on Windows): second writer refused with bytes unchanged, simultaneous starts on a new file, distinct files in parallel, close drains accepted writes and refuses later ones, every failed start-up releases, kill and stale-marker recovery (only for a verifiably dead owner), live/foreign/unreadable/bad-pid/half-finished markers refused and untouched, four-process recovery race, a marker that is not ours is never released, exit hooks, path aliases, the hard-link limit, credential-file races, real servers on one file and on different files, and file symlinks (a symlinked data file is refused, never replaced, including after the owner's first write). 19 removed protections each failed the suite. See [single-writer.md](single-writer.md). |
| `tests/ocr.test.js`, `tests/ocr-api.test.js`, `tests/ocr-real.test.js` (+ `ocr-helpers.js`, `fixtures/ocr/`) | Text in images (11 + 15 + 7): the reader service with a fake worker (bounds, timeout, crash, cancel, late callbacks, cache bound to the digest, no number fixing), the API and provenance rules (digest-bound reading, roles, damaged bytes, forged fields, explicit confirmation, stale drafts, findings on the transcription, approval binding and stale reasons, carry-forward vs drop, authenticated mode), and the REAL engine (exact clear fixtures, recorded hard-fixture failures, network blocked with 0 attempts, unavailable when data is missing or altered, timeout recovery, bounded concurrency; skipped without the optional parts). 27 mutations of the new logic: 26 failed the suite, 1 equivalent. See [ocr-image-text.md](ocr-image-text.md). |
| `tests/listen.test.js` | Port fallback leaves no stale listeners (no MaxListeners warning after a long run of busy ports); fails without the fix. |
| `tests/demo-consequence.test.js` | The separate 12 → 8 hours scenario: idempotent bootstrap, the preview reports the battery passage gone and the other two unchanged, real activation makes the approval stale for evidence; the launcher refuses real data and the showcase file. |
| `tests/dossier.test.js` | Review dossier (14 tests, including the provenance of the image fingerprint, independent recomputation of every digest by its stated method, and the checker revision): content and exact excerpts, checksum, read-only, no paths/secrets/usernames/source text/image bytes/comment bodies, image states and corruption, stale approval, coherence under a commit during verification and under constant change (409), hostile text, demo and authenticated permissions. Each control removed in turn: the suite failed every time. See [dossier.md](dossier.md). |
| `tests/impact.test.js` | Source change-impact preview (15 tests): exact continuity classes, no writes (bytes, mtime, state, versions, events), campaign buckets predicted vs the real statuses after the real activation, uncited sources, withdrawal, request validation and non-monotonic activation, stale-preview refusal for five kinds of change on both writes, optional/validated/foreign digests, a two-manager race, consistent previews during a write, demo and authenticated permissions (forged headers, CSRF, Origin, registrant gate), full preview → activate → repair → distinct-reviewer flow. Each control removed in turn: the suite failed every time. See [impact-preview.md](impact-preview.md). |
| `tests/claims-scope.test.js` | Factual qualifier / scope / safe-correction integrity, plus the denied/retired-claim gate (17 tests): the synthetic claims corpus, the four reproduced gaps with quotes and spans, replacement withheld for risky wordings, optional fact conditions (validation, persistence, hash-stable absence, effect on the offered replacement). Each mechanism was removed in turn and the suite failed every time. See [claims-scope.md](claims-scope.md). |
| `tests/sources.test.js` (+ `sources-helpers.js`) | Source registry: normalisation and spans, registration limits and roles, no fetching of URLs, approval/rejection rules, drafts never replacing the active version, immutability, link validation (invented/mismatched/pending/rejected/withdrawn/superseded, forged fields, policies), repeated passages and Unicode offsets, legacy never relabelled, evidence in every binding, stale approvals and the approval block after replacement/withdrawal, repair paths, old-approval compatibility, races (decision, request-review, concurrent approvals/versions/registrations, publish vs activation, activation during inference), retrieval only from active approved sources, restart persistence. 26 tests. |
| `tests/assets.test.js` (+ `png-helpers.js`) | Campaign images. Validator: every colour type / bit depth / interlacing accepted with true dimensions; JPEG, SVG, HTML, signature-only, truncated, bad checksum (data or only the stored CRC), data after IEND, decompression bomb, bad scanline filter, short data, unknown critical chunk, animation, missing palette all refused; dimension/pixel/byte limits. API: server-computed digest/size/dimensions, client name/type/digest ignored, exact bytes and fixed safe headers, wrong types, roles, streaming size limit, traversal/case/unregistered files never served, tampered or missing file reported and review/approval blocked, forged/unknown/malformed/mismatched references refused, metadata-only legacy labelled with an unchanged hash, approval bound to the retained digest and stale on replacement with history and comparison, manual colour checks unchanged, concurrent quota (no orphans), idempotent concurrent identical uploads, blob and registry failures with recovery, restart persistence and workspace isolation, authenticated 401/CSRF/Origin/role/provenance and a distinct reviewer approving after a restart. 19 tests. Each control was checked by removing it (reference check, binding, integrity check, quota, bounded decode, CRC check, missing-bytes block): the suite fails every time. |
| `tests/assets-integrity.test.js` | Repair of two independently reported failures. **Same-size corruption** of a retained image: serving gives 500 `asset_corrupt`, and review request and approval are refused with 409 `asset_corrupt` (previously 201/Approved because only the file size was checked), with no event recorded. **Restoration**: re-uploading the identical valid bytes restores a corrupt, missing, truncated or empty file (response says which), after which review and approval work; different bytes cannot repair it; a directory in the file's place is reported unavailable and the failed restoration is clean. **Temp files**: injected open / partial-write / fsync / close / rename failures leave no temp file and no final file, and a failed restoration leaves the damaged file exactly as it was. The decision binding and stale-view check still apply. `verify` reports ok / missing / corrupt / unavailable from real bytes. Authenticated flow with a distinct reviewer (a reviewer cannot upload; the creator repairs). 9 tests; each reported behaviour was re-introduced and the suite failed every time. |
| `tests/sources-retrieval.test.js` | Retrieval and retired evidence: an active linked rule is a candidate with openable registered provenance; **withdrawal** and **replacement** of the cited source remove the linked rule from candidates even with a warm cache (cache rebuilt, text not embedded), a draft replacement changes nothing, relinking restores it pointing at the new version, unlinking to legacy returns it as legacy, historical findings keep their evidence flagged withdrawn, and `semanticSources` keeps legacy entries / drops every non-active state / fails closed. Verified to fail without the filter. 5 tests. |
| `tests/sources-auth.test.js` | The same registry under real sessions: 401/CSRF/Origin on every source route, role gates, forged actor/status fields ignored, registrant cannot approve their own version, source-to-approval flow with distinct people, restart persistence with actor ids. 4 tests. |
| `tests/auth-concurrency.test.js` | Credential generations: reset/disable/change during an in-flight sign-in, stale password change, concurrent changes, last-owner invariant, bounded hashing (dummy hash once, at most 2 scrypt jobs, 503 beyond the queue), failed disk writes. 13 tests using a parking hasher seam. |
| `tests/auth.test.js` (+ `auth-helpers.js`) | Authenticated mode: 34 tests with synthetic accounts in temporary directories (see [authentication.md](authentication.md#tests)). Uses a reduced scrypt cost, tests only. |

## 2. Detection fixtures

```
npm run eval
```

30 synthetic cases / 24 expected findings, written by the team after the rules existed against the fictional guidelines: TP 24, FP 0, FN 0. This is a **regression baseline**, not an accuracy measurement.

### 2b. Claims-scope corpus

```
npm run eval:claims
```

98 scored synthetic cases (plus 11 documented known limits, not scored) over qualifiers, guarantees, operating conditions, competitor and quotation attribution, negation, safe vs advice-only corrections, mixed claims, clean controls, and denied or retired claims: TP 86, FP 0, FN 0; no false green; every one of the 13 offered rewrites was applied and re-checked without breaking. Again a regression baseline over our own sentences, not accuracy; details, the two labels corrected after the first run, and the known limits are in [claims-scope.md](claims-scope.md).

## 3. Real local model

```
npm run verify-semantic
```

Output and honest reading: [semantic-matching.md](semantic-matching.md#measured-verification-real-model-seed-guideline-set-v1-13-sources).

## 4. Browser walkthrough

```
npm run ui-smoke
```

Starts its own server on a free localhost port with a throwaway data directory, drives headless Edge/Chrome over the DevTools protocol, and prints PASS/FAIL per check. Recorded result: **14 of 14 checks passed, 0 skipped** (navigation, demo banner, role picker, seeded findings, draft findings following the latest text, unsaved drafts refused by AI source matching, status text, paraphrase retrieving `FCT-001`, unrelated passage giving no confident match, labelled result without percentages, approval with acknowledgement, **Re-review required** after a guideline change, clean browser console).

Screenshots from that run are in `docs/evidence/`:

- `workspace.png` – seeded draft with highlighted copy and blocking findings
- `edit.png` – draft editor with live findings
- `ai-source-matching.png` – AI source matching results (paraphrase and unrelated passage)
- `stale-approval.png` – "Re-review required" after a guideline change
- `queue.png`, `library.png`, `insights.png`

The browser tooling only works where Edge or Chrome is installed (`BRANDPROOF_BROWSER` overrides the path).

## 4a. Factual-claims browser walkthrough

```
npm run ui-smoke-claims
```

Throwaway demo-mode server and synthetic data. Recorded result: **15 of 15 checks passed** (the last four are the denied-claim and retired-figure flow: two cautions with advice and no Apply button, only the affirmative sentence offers a rewrite, Apply to draft leaves the denial and the history unchanged and nothing inverts; screenshot `claims-5-denied-and-retired.png`; the first eleven are): a sentence with "always exactly 12 hours at maximum brightness" is a Needs-review caution (not a match) with advice quoting the approved wording and no Apply button; a 30-hour figure offers `up to 12 hours at medium brightness`; a competitor figure is a caution with no Apply button while our own "up to 12 hours" in the same sentence stays consistent; Apply to draft changes only the safe case; a person's rewrite clears the caution; the saved revision has no battery caution; the library shows the approved condition; clean console. Screenshots: `claims-1-caution-and-safe-fix.png`, `claims-1b-caution-advice-only.png`, `claims-2-competitor.png`, `claims-3-human-rewrite.png`, `claims-4-library-condition.png`.

After this milestone the existing walkthroughs were re-run on the new code: `ui-smoke` 14/14, `ui-smoke-auth` 17/17, `ui-smoke-sources` 23/23, `ui-smoke-assets` 22/22, `ui-smoke-a11y` 43/43, and `demo:rehearse` passed.

## 4a2. Impact-preview browser walkthrough

```
npm run ui-smoke-impact
```

Authenticated mode, synthetic accounts, a fictional fact sheet, throwaway data. Recorded result: **25 of 25 checks passed** (details in [impact-preview.md](impact-preview.md#measured-synthetic-fictional-data-24-oct-2026)). Screenshots: `docs/evidence/impact-1-preview-top.png`, `impact-2-preview-dependencies.png`, `impact-3-stale-refused.png`, `impact-4-after-activation.png`, `impact-5-repaired-approved.png`, `impact-6-narrow.png`. The earlier walkthroughs were re-run on the final code: `ui-smoke` 14/14, `ui-smoke-auth` 17/17, `ui-smoke-sources` 23/23, `ui-smoke-assets` 22/22, `ui-smoke-a11y` 43/43, `ui-smoke-claims` 11/11, and `demo:rehearse` passed.

## 4a3. Review-dossier browser walkthrough

```
npm run ui-smoke-dossier
```

Authenticated mode, synthetic accounts, fictional sheet, generated PNG, throwaway data. Recorded result: **25 of 25 checks passed** (details in [dossier.md](dossier.md#measured-synthetic-fictional-data-24-oct-2026)), including a real browser download compared with the visible report. Screenshots: `docs/evidence/dossier-1-report-top.png`, `dossier-2-decisions-and-findings.png`, `dossier-3-stale-approval.png`, `dossier-4-image-corrupt.png`, `dossier-5-print.png`, `dossier-6-narrow.png`.

## 4a12. Deployment candidate (m21)

Render free-tier candidate: [render-deploy.md](render-deploy.md), `render.yaml`. Re-runnable: `node --test tests/judge-health.test.js tests/render-candidate.test.js tests/judge-startup.test.js` (the `/healthz` route allocates no session and reveals nothing; the exact `render.yaml` environment starts the real server; health, strict host and origin, the Secure `__Host-` cookie, two-visitor isolation and the core path through https-style headers, restart on the same and on a new empty folder, and the refused configurations) and `npm run package:public` (the clean public package, scanned, with hashes). Local only: **not** run on Render, Linux, a container or real TLS; `render.yaml` is not validated by Render. Details and the first-run logs are in the development handoff `m21-deployment-candidate.md`, which is not part of the public package.

## 4a11. Isolated judge demo (m20)

Design, settings, lifetimes, bounds and limits: [judge-demo.md](judge-demo.md). Re-runnable on fictional data in temp folders:
- `node --test tests/judge.test.js tests/judge-startup.test.js tests/judge-entry.test.js tests/judge-concurrency.test.js`: 38 tests (the last file, 9, was added in m20b after a review reproduced a cap race: simultaneous starts, rollback of a failed start, simultaneous writes against the storage cap; it fails 7 of 9 against the m20 code, `handoffs/evidence/m20b-new-tests-against-old-code.txt`). Two cookie jars cannot read or write each other's submissions, comments, decisions or images; every tamper channel (headers, query, path, body, other and duplicate cookies); unknown, tampered, malformed and expired sessions; capacity, start rate, storage, image and open-session bounds; one listener only; reload, restart and stale-lock recovery; reset; the approve and stale path; the fallback without the optional model and OCR; the host and origin protections; every setting and refusal; the real `server.js` including a restart after a hard stop.
- `node scripts/browser/ui-smoke-judge.mjs`: 49 checks with **two independent browser instances** (separate profiles and cookie jars) against one demo, at desktop and 390 and 320 px: the fictional-data, separate-session and simulation wording (and the absence of claims that are false for a hosted demo), the compact three-step guide with its "More detail" disclosure, real-key keyboard use, the guide's footprint on a phone, a campaign made in one browser never appearing in the other, reload persistence, the approve and stale path, Reset, the session-ended state, the capacity page, no sideways scroll, a clean console. Screenshots: `docs/evidence/judge-*.png`.
- The tests were also checked against nine deliberate breaks of `src/judge.js`, made in an **isolated copy of the tree, never the live one**; all were caught (`handoffs/evidence/m20-mutation-check.txt`, with the control run and one mutation that had to be redone because it was first written as a no-op). Not covered: any hosting platform, container runtime or TLS proxy; per-address rate limiting; a replacement container's stale root marker; real devices, screen readers.

## 4a10. Deployment start-up (m19)

Settings, files, limits and the optional-feature fallback are in [deployment.md](deployment.md). Re-runnable: `node --test tests/startup.test.js tests/deploy-host.test.js tests/deploy-entry.test.js` (27 tests on isolated fictional data in a temp folder): default loopback binding, the preserved local port retry, a configured host, the opt-in deployment start, the assigned-port conflict (clear failure, exit 1, no fallback, no lock left), refusals before anything is opened, the host and origin guard, the core product flow on the real `node server.js` (check, explained findings, the approval gate, a human decision, a second process refused, a restart after a hard stop). The new tests were also checked against four deliberate breaks of the code; the results, the first failures during development and the one hang found in the test harness are in [handoffs/m19-deployment-startup.md](../handoffs/m19-deployment-startup.md). Not covered: any hosting platform or container runtime, a real TLS proxy, stale-lock recovery for a replacement container.

## 4a9. Brutalist sage / walnut / amber design (m17)

The current look, its tokens, the self-hosted fonts (SIL OFL, `docs/licenses/`), and what the canvas review changed are in [design-m17-brutalist.md](design-m17-brutalist.md). Re-runnable checks:
- `npm run ui-smoke-design`, 31 checks: solid offset shadows only, with no blur; the verdict band and its stamp, hidden from screen readers; lettered exhibits; the fonts loading from this server with no remote request; the phone tab bar fixed at the bottom and not covering the last control; 44px targets on a phone; a 3px focus ring, walnut or amber on walnut, on 14 real Tab presses; reflow at 200% text size and at 720, 360 and 320px; reduced motion and increased contrast.
- `npm run ui-contrast`: 96 pairs computed from the real tokens.
- `npm run ui-smoke-layout`: 57/57.

Not covered: a dark theme, real devices, screen readers.

## 4a8. Visual design pass (m16, look since replaced by 4a9)

The design direction, the Taste and Apple skills used, the audit, three review rounds and every measurement are in [design-pass.md](design-pass.md). Re-runnable checks: `npm run ui-smoke-design` (24 checks: one primary action in the decision bar, no resting shadows, every button, field, tab and navigation link at least 44px on a phone, a solid 2px dark-teal focus ring on 14 real Tab presses, no sideways scroll at 200% text size and at 720, 360 and 320px, reduced motion and increased contrast honoured), `npm run ui-contrast` (70 pairs computed from the real tokens in `public/styles.css`, including the increased-contrast variant), and `npm run design-evidence` (the same isolated synthetic workspace photographed at 1440, 768, 390 and 320px). Not covered: a dark theme, real devices, screen readers (see the limitations in design-pass.md).

## 4a7. Page layout at phone and tablet widths

`npm run ui-smoke-layout` builds the showcase story in a temp directory plus a campaign and a source with long names (one unbroken 60-character word each) and a campaign with a retained image and a saved text-in-image transcription, then opens 11 views (campaign, approved campaign, editor, library, sources, a long-named source, a source version, queue, insights, dossier, About) at **320, 390, 768 and 1360 px**. A view passes only if the DOCUMENT does not scroll sideways (`scrollWidth <= clientWidth`) and no element sticks out of the screen unless it sits inside a deliberate horizontal scroller; it also fails on text clipped by a hidden-overflow box, presses real Tab through the navigation and requires each focused link to be fully visible, opens the last link with Enter, and requires the campaign header actions and selector to stay on screen. The skip link (parked off-screen until focused) and text scrolling inside an input are excluded on purpose. **Measured before the fix: 30 of 57 checks passed; after: 57 of 57.** Before, the worst pages were 1290 px wide on a 390 px screen (queue), 959 (campaign), 916 (dossier), 690 (library), 653 (insights), 541 (sources), and the queue was also 1536 px wide on a 1345 px desktop window. Measurements: `docs/evidence/layout-before.json`, `layout-after.json`; screenshots `docs/evidence/layout-before-*.png` and `layout-after-*.png`. Causes and fixes: single-column grids (`.stack`, `.ws-head`, `.ws > .col`) sized their column to the widest content (a `<select>` listing a long title, an unbroken word), so they now use `minmax(0, 1fr)`; flex items that could not shrink (the selector row, the Approve/Reject row) may now shrink or wrap; long words wrap (`overflow-wrap`). Chrome leaves a link that is only partly visible in the scrolling phone navigation row where it is when Tab reaches it, so a three-line `focusin` handler in `public/app.js` scrolls the focused link fully into view. Tabs and tables keep their own horizontal scrolling, and the page's `overflow-x` is not hidden. Not covered: the sign-in screen and the authenticated People page, and no real phone (headless Edge device emulation only).

## 4a6. Text in images

`npm run ui-smoke-ocr` (real reader, synthetic accounts and PNGs, run under a network blocker): **36 of 36** (read → draft equals the printed words → unconfirmed save refused → confirm → finding on the transcription with its source link and advice to replace the image, no rewrite → replace the image with a rotated one the reader really misreads, correct ONLY the misread to the printed words → save → replace the image with the corrected artwork that prints every qualifier, confirm unchanged → findings consistent → a different signed-in reviewer approves → dossier states the printed-words rule and its limit → replace the image again, Re-review required naming the image and its text → 0 network requests beyond the deliberate control); then the reader off: **4 of 4**. Phase A proof (separate): [ocr-phase-a.md](ocr-phase-a.md). Details, evidence and limits: [ocr-image-text.md](ocr-image-text.md).

## 4a5. Single-writer repair

`node scripts/verify/single-writer-probe.mjs [--root <tree>]` reproduces the two-real-process scenario. Previous build: both writers opened, both writes acknowledged, only `writer-B` persisted (lost acknowledged write). This build: the second writer is refused and `writer-A` persists. Full evidence, recovery rules and limits: [single-writer.md](single-writer.md). After the repair the eight browser walkthroughs, the judge rehearsal, `demo:rehearse` and both evals were re-run and pass.

## 4a4. Judge rehearsal and clean-install check

`npm run judge-rehearsal`: scripted, automated, 29 of 29 checks, 88 automated actions (49 excluding sign-ins), about 87 s of wall-clock including fixed waits. Not a human study. The package was extracted into temporary directories and run with no dependencies (A), with copied local dependencies and model (B, labelled as a copy), with model-absent fallbacks, and installed from the local npm cache with `--offline` (D). Full tables, commands, failure behaviour and limits: [judge-rehearsal.md](judge-rehearsal.md).

## 4b. Authenticated-mode browser walkthrough

```
npm run ui-smoke-auth
```

Synthetic accounts only, throwaway data directory, passwords random and never printed. Recorded result: **17 of 17 checks passed**: signed-out visitors see only the sign-in form; wrong password gives a generic error; the signed-in actor and server-given role are shown with **no role switcher**; the session cookie is not readable from page scripts; the author's own **Approve is disabled with the reason shown**; sign-out closes the workspace even on reload; a different reviewer approves; History names the reviewer as the actor (no "demo role" label); a reviewer has no People page and the server refuses admin routes (403); the owner sees the account activity trail; clean console (expected 401/403 network lines excluded).

Screenshots: `docs/evidence/auth-sign-in.png`, `auth-self-approval-blocked.png`, `auth-approved-by-reviewer.png`, `auth-people.png`.

The interactive owner-setup command (`npm run auth:setup`) was **not** run during development (it needs a human typing a real password); only its non-interactive refusal and the library code under it (covered by the tests) were exercised.

Concurrency findings from the independent review were fixed and re-probed (see [authentication.md](authentication.md#credential-generations-and-concurrency)): the reviewer's unmodified probe now reports both `issueReproduced` fields false and one active owner.

Mutation checks (done by hand once): disabling the self-approval rule, the CSRF check, server-derived roles (trusting the demo header) or logout revocation each made `auth.test.js` fail.

## 4c. Source-to-finding browser walkthrough

```
npm run ui-smoke-sources
```

Authenticated mode, synthetic accounts, a fictional fact sheet, throwaway data. Recorded result: **23 of 23 checks passed**: a pasted source is only a pending draft; the manager must confirm the text was read before approving; the existing rule is explicitly legacy; the passage is selected in the source text and previewed exactly; the rule shows as Registered with source and offsets; guidelines v2 publish; the reviewer approves; the finding shows Registered source and opens the exact passage highlighted; a pending replacement changes nothing; approving version 2 makes the approval Re-review required with evidence as the reason; Approve is disabled with the reason after a new review request; the repair panel appears; relinking and publishing clears it; the review then ends Approved; the banner is one line (43 px) and the decision buttons stay on one row; clean console. Native file-chooser upload is covered by API tests, not driven in the browser.

Screenshots: `docs/evidence/sources-1-draft.png`, `sources-2-approved.png`, `sources-3-pick-passage.png`, `sources-4-finding-registered.png`, `sources-5-exact-passage.png`, `sources-6-stale-evidence.png`, `sources-6b-approve-blocked.png`, `sources-7-repair.png`, `sources-8-reapproved.png`.

## 4d. Campaign-image browser walkthrough

```
npm run ui-smoke-assets
```

Authenticated mode, synthetic accounts, generated fictional PNGs, throwaway data. Recorded result: **22 of 22 checks passed**: no image before attaching; a PNG uploads and shows as Retained with its true 240 × 120 size; after saving, the page's image has exactly the uploaded bytes (SHA-256 compared in the page) and decodes at the right size; alt text is meaningful; the image survives a page reload; **after a server restart a different reviewer sees exactly the retained bytes** and approves; replacing the image shows the new one in the draft, the approval becomes Re-review required with the image as the reason, and History keeps each revision's own image; comparison names the image file; a non-PNG and a truncated PNG are refused (the second by the server) with the draft explicitly keeping the previous image and Save still working; removal is explicit; a metadata-only revision says its image was not retained; at 420 px there is no horizontal scrolling and the image fits; clean console. Late-upload discarding is implemented (a sequence number invalidates stale uploads) but not driven in the browser.

Screenshots: `docs/evidence/assets-1-draft-retained.png`, `assets-2-creator-view.png`, `assets-3-reviewer-after-restart.png`, `assets-4-history-two-images.png`, `assets-5-upload-refused.png`, `assets-6-metadata-only.png`, `assets-7-narrow.png`.

## 4e. Integrated keyboard / accessibility walkthrough and showcase checks

```
npm run ui-smoke-a11y     # real keyboard events in a real browser, on a throwaway showcase
npm run demo:rehearse     # presenter path through the API
npm run ui-contrast       # our own colour pairs
node scripts/browser/demo-screens.mjs http://127.0.0.1:4174   # READ-ONLY screenshots of the running showcase
```

**`ui-smoke-a11y`: 43 of 43 checks passed** (with the real offline matcher installed; AI-matching steps are reported as skipped, not passed, when it is not). It drives the keyboard (Tab, Shift+Tab, Enter, Space, Escape, arrows, Home): the first Tab stop is the skip link and it moves focus to the content; Enter on a nav link opens the page, updates the document title and puts focus on the page heading; the whole edit-apply-fix-save-request-review path is done with the keyboard; the demo role is changed with arrow keys; opening a dialog moves focus into it, it has an accessible name, **Escape closes it and returns focus to the button that opened it**; an approval that needs acknowledgement announces an **assertive (role=alert)** error and the dialog stays open; Space ticks the checkbox and Enter approves; a missing required reason shows an inline alert and moves focus to that field; the side tabs are a real tablist (roving tabindex, ArrowLeft/ArrowRight/Home/End, tabpanel); the exact-passage link opens the source with the cited text highlighted (outlined, not colour-only); image replacement shows its status in a polite live region and history keeps each image; keyboard-started AI source matching shows relevance results; at **420 px** none of seven pages scrolls horizontally and no visible control is under 24 px tall; clean console. Screenshots: `docs/evidence/demo-1-skip-link-focus.png`, `demo-2-dialog-open.png`, `demo-3-error-announced.png`, `demo-4-source-link-focus.png`, `demo-5-replaced-image.png`, `demo-6-source-matching.png`, `demo-7-narrow-workspace.png`, `demo-8-narrow-source.png`.

**`ui-contrast`: 19 of 19 of the app's own main text/background pairs reach at least 4.5:1** (lowest 5.47:1). It is a self-check of our own palette, not an audit.

**`demo:rehearse`: passed** (13 assertions): approving source version 2 makes the approval Re-review required with evidence as the reason, three facts need relinking, each quote is found once in version 2, publishing the relinks succeeds, and a fresh review ends Approved.

**Live showcase (port 4174), read-only screenshots: 8 of 8 checks passed**, `docs/evidence/demo-live-*.png`.

Problems this walkthrough found in the app and that were fixed: tabs were announced as tabs but had no arrow-key support, roving tabindex or tabpanel; error toasts were announced politely rather than assertively; after saving, approving or rejecting, keyboard focus was dropped to the page start; the background AI-matcher status poll repainted the side panel and pulled focus away from the user; a missing reject reason did not move focus to the field; the page title never changed; route changes did not place focus on the new page. (A separate finding in the test driver itself, raw key events for arrow keys not being delivered, was a tool problem, not an app problem.)

**Not done, and not claimed:** no screen-reader testing of any kind, no testing with users who rely on assistive technology, no WCAG conformance audit or certification, only Chromium (Edge, headless). The operating-system file chooser cannot be operated by this tool (the input is focusable and labelled; choosing a file was done through the DevTools protocol). Picking a colour from the image still needs a mouse (typing a hex value or using the colour input is the keyboard route). Selecting a passage in a source is by mouse drag; typing start and end numbers is the keyboard route.

## 5. Packaging

```
npm run package
```

Writes `dist/brandproof-source.zip` from an allow-list and fails if the archive would contain `node_modules`, `.cache`, `data`, `.git`, environment files, key files, model weights, credential files (`users.json`), backups (`*.bak-*`), or any file whose content looks like a real scrypt hash or session cookie. It does not upload anything.

## 6. Known gaps in verification

- No usability study, no screen-reader pass, no testing on browsers other than headless Edge.
- No load or long-running testing.
- The AI source matching thresholds are heuristics from six probes.
- The detection fixtures are not independent of the rules.
