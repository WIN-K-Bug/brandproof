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

## 4a13. Phone recovery (m22)

`npm run ui-smoke-phone` (`node scripts/browser/ui-smoke-phone.mjs`): 26 checks on the isolated judge demo with a movable clock (optional model and OCR off), Edge or Chrome, fictional data.

A phone report said the banner, brand, role picker and guide looked clipped at 390x844. At default text size and zoom that was **not reproduced**: at 390, 360, 320, 300 and down to 240 px wide, at device scale 1, 2 and 3, on a fresh load, after a real-key role switch, and with the "session ended" and "earlier session had ended" banners, the page was never wider than the screen. What did reproduce once the text size was raised (a normal phone setting, equal to browser zoom): the workspace page became wider than the screen (a long no-wrap chip, and tab-bar labels and the count badge outgrowing their columns). Full-width bars stop at the screen edge while that wider content continues, which looks like clipped bars.

Fixed in `public/styles.css`: chips and tags may not exceed their container and wrap on a phone; the tab-bar label and badge sizes are capped to their column. Second finding: an old deep link after a lost session showed only "No submission SUB-4."; it now also offers an "Open the workspace" button (announced as an alert, scrolled into view) in `public/workspace.js`.

Checks cover 390 px at text 100, 125, 150 and 200%, 320 px at 100, 125 and 150%, the queue, sources and library pages at 150%, real-key role switching, the ended banners, and the recovery button.

**Remaining limits, measured after the m22 fix** (`handoffs/evidence/m22-after-fix-*`): 320 px at 200% text still scrolled sideways by 20 px and the 195 px page was 23 px wider than the screen. Both were closed in m23, below. The native Brave DevTools "Fit to window" view was not available here, so the exact setting behind the original report is unresolved.


## 4a22. Arriving from another site keeps the session (m31)

The session cookie is `SameSite=Strict` (also Secure, HttpOnly and `__Host-`), so a browser withholds it on a navigation that starts on another site, and on every reload of that page. The server then saw a visitor with no cookie, started a NEW session and replaced the cookie, which left the visitor's earlier session unreachable: a saved revision seemed to vanish, silently (m30 reproduced it in Edge and Brave, regular and private). Fixed without relaxing the cookie: a cross-site top-level navigation (`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) that carries no valid cookie and no `?entry=1` marker is answered with a constant landing page (`ENTRY_PAGE` in `src/judge.js`): no session, no cookie, `no-store`. Its script (`public/enter.js`: `location.replace('/?entry=1' + location.hash)`, which reads nothing else) and, with scripts off, its meta refresh and link continue to the same page from the demo's own origin, where the cookie is sent; the marked request is never bounced again (no loop), and `public/app.js` shows the clean address again. A visitor with a live session is resumed (the hop touches nothing); a visitor without one gets exactly one session. Requests that are typed, same-origin, same-site, missing or with malformed `Sec-Fetch-*` headers, non-navigations and frames behave as before, and the hop uses no session, slot or start rate. Origin, role, CSRF, isolation and quota rules are unchanged.

- `tests/judge-cross-site-entry.test.js` (8 tests): the landing page is constant, inline-free and reflects nothing; the way on is one literal plus the fragment; the marker prevents a loop; a live session is not replaced; only a cross-site top-level navigation is bounced; the hop uses no slot or rate; cross-origin writes, a foreign Host, POST and HEAD answer as before; the cookie attributes are exact.
- `npm run ui-smoke-cross-site-entry` (23 checks, real HTTPS: the real `server.js` with the render.yaml settings behind a local TLS proxy; the certificate is made at run time in memory and never stored; `scripts/browser/tls-harness.mjs`): typed control; first visit by clicking a link on another site with a deep link to a campaign that is not the default one; save then reload keeps the same session and revision; arriving again resumes it; another visitor stays isolated; a page on another site posting to the API changes nothing; scripts switched off still land on a working page; a server that lost its sessions says so and starts one new one. `M31_PROFILE` selects edge-regular (default), edge-private, brave-regular or brave-private.
- Not changed: the cookie (Strict, Secure, HttpOnly, `__Host-`), the server's other routes, authenticated mode (not offered for a deployment).

## 4a21. Diagnostic: "Session ended" after save then reload (m30, no product change)

A native private-window observation (a fresh session saved a revision, then an immediate Ctrl+R showed "Session ended") was investigated on isolated synthetic servers. **The reported symptom was not reproduced.** `scripts/browser/diag-private-reload.mjs` runs the real `server.js` with the render.yaml settings (Secure `__Host-` cookie, ephemeral root, the free-tier limits) behind a local TLS proxy that logs only names, a 6-hex tag of the cookie hash, Set-Cookie attributes, statuses, cache headers and Sec-Fetch-* headers (never a cookie value, token, address or body), and drives headless Edge and Brave (regular and private flags, each in its own empty profile). Findings, with the logs in `handoffs/evidence/m30-*`: save then reload, hard reload, address-bar load, deep link and save-in-flight reload kept the session in all four profiles; no 304 or conditional request ever occurs (static files carry no ETag, `cache-control: no-cache`); a restart that keeps the folder keeps the session; a restart with an empty folder gives the "Session ended" screen only to a page that is already open and makes a request, and a reload after it starts a new session; idle expiry gives a new session on reload. **One related behaviour was reproduced in all four profiles:** a page reached by clicking a link on another site has its root request (and its reloads) sent as cross-site, the browser withholds the `SameSite=Strict` cookie (reason `SchemefulSameSiteStrict`), and the server starts a new session without saying so, so a saved revision seems to vanish. That shows as a new session, not as the ended screen. Nothing was changed in the product; the handoff has the evidence and the options for an independent audit. `scripts/browser/diag-private-engaged.mjs` checks whether the private flags took effect in headless mode (inconclusive for Edge). `scripts/browser/cdp.mjs` gained optional `args`/`exe` launch settings and `send`/`on`/`profile` (diagnostics only).

## 4a20. Save lifecycle and campaign identity (m29)

A save whose answer arrived after the person had moved from campaign A to B and started editing B used to clear B's draft and paint A's page under B's address; saving from that page could write A's words into B (when A's new head revision equalled B's). Reproduced in a real browser first (the first run is kept), then fixed in the page: one save per draft at a time with the form locked while it is in flight, the answer applied only if the person is still on the same campaign and draft (otherwise reported by campaign id), and a reload that never paints a detail for a campaign that is not the selected one. The server was not changed and never lost data.

- `npm run ui-smoke-save-race`: 22 checks. The server handles every request normally; only the delivery of one save response to the page is held. Scenarios: a normal save; waiting for a held save (the button says "Saving…" and cannot be pressed again); late success after moving to B and typing in B (B's page, address, picker and unsaved text stay, the toast names A); late refusal (409) in the same situation (B untouched, the message names A, nothing is said about a draft that is not open); Save pressed twice (exactly one POST, one message); words typed with the keyboard during a save (the form is locked, so nothing is silently lost); leaving A and coming back before the answer (A shows its new revision, no stale page); and the consequence probe (editing what the page shows and saving never puts A's words into B). The first run on the unchanged code: 9 of 17, and the consequence probe 1 of 3 (`handoffs/evidence/m29-FIRST-RUN-*`). Screenshots: `docs/evidence/saverace-*.png`.
- `scripts/browser/cdp.mjs` gained `insertText` (real typing into the focused field).

## 4a19. Dialog reflow at small heights (m28)
Independent rehearsal in a 683×598 window found the source approval dialog hard to use: two nested scrollbars, the acknowledgement out of view, and a blank cream dialog after dragging the outer scrollbar. Reproduced on synthetic data at the reported geometry, with two separate causes (below), both in the shared dialog primitive.

- `npm run ui-smoke-dialog-reflow`: 85 checks at 683×598, 320×568, 390×700 and 1360×900. Per viewport: the dialog fits the viewport with no sideways scroll; exactly one vertical scroller; title and actions visible without scrolling; text on screen at the top, middle and bottom of the wheel scroll (photographed, `docs/evidence/dialog-*.png`) and with the dialog itself scrolled to its end; the acknowledgement, note and Approve fully visible after wheeling to the end; Tab reaches the acknowledgement and note and then Approve, each visible when focused; an unchecked approval is refused with a message that is visible and inside the dialog, and saves nothing; Escape and Cancel change nothing. Also the preview alone, withdraw, and the add-terminology-rule dialog at the two small viewports, and on desktop a stale preview refused then a fresh checked approval activating. The first run on the unchanged code: 56 of 85 (`handoffs/evidence/m28-FIRST-RUN-repro-*`).
- `scripts/browser/ui-smoke-a11y.mjs`: one selector changed, `#toasts .toast` to `.toast`, because an error raised while a dialog is open now appears inside the dialog (the role=alert and the text assertions are unchanged).

## 4a18. Decision-time review receipts (m27)
Design, schema compatibility and limits: [dossier.md](dossier.md#decision-receipts-m27). Re-runnable on fictional data in temp folders:
- `node --test tests/decision-receipts.test.js`: 12 tests. The receipt equals the findings, counts and evidence of an independent read taken just before the decision, with the warning acknowledged; a refused decision (not in review, missing acknowledgement, wrong role, stale view, missing note, blocking finding, a contributor's self-approval) leaves the data file byte-identical; injected receipts, findings and verdicts in the body are ignored and no route can write an event; a later source, guideline or content change leaves the receipt byte-for-byte equal in the API, the dossier, the file and after a restart while the comparison with today changes; an older decision with no receipt shows as unavailable with no comparison; size bounds, including multi-byte text and emoji (counts stay complete, the most serious findings are kept, nothing is cut in half); hostile text stays data; the end-to-end scenario (approved at 12 hours, the source moves to 8, the old receipt compared with today, repair, re-approval, two different receipts in the dossier); authenticated mode (by account id, no username or credential); the public demo keeps each visitor's receipts in that visitor's session and reserves room for a receipt at the storage cap. The first run, with the module stubbed, failed 10 of 11 for the intended reasons (`handoffs/evidence/m27-FIRST-RUN-red-behaviour-*`; the other test, the refused-decision guard, already held and stays as a regression guard).
- `npm run ui-smoke-receipts`: 20 checks (authenticated mode, synthetic accounts): the receipt opens with the keyboard alone (Tab, Enter, Space) and shows then beside now; hostile copy and notes are text; the source change flips it to "no longer applies" with the evidence then and now; two receipts after the repair; the dossier carries both inside "Recorded decisions" with an unchanged section outline; an older workspace shows "Not recorded"; 390 px with no sideways scroll and a 44 px tap target. Screenshots: `docs/evidence/receipts-*.png`.
- Changed existing test: `tests/judge-scenario.test.js` compares the stored fields of the sample history as strictly as before and now sets aside only the computed comparison with today (which moves with the guidelines), with new assertions that the receipt itself is unchanged and the comparison moved.

## 4a17. Auth test client: transport diagnostics (m26)
A request made through `tests/auth-helpers.js` that fails at the transport level (nothing answered) now raises an error that says what happened: the underlying cause chain (code, errno, syscall, address, port, message), the method and route (query removed, long id-like segments masked), and the app's lifecycle (stage, request number, server state, port history, process uptime). It never prints a body, header, cookie, token, password or user name, retries nothing, hides nothing and leaves the original error as its `cause`. Re-runnable: `node --test tests/auth-transport-diagnostics.test.js` (5 tests: the cause chain and the removal of secrets, an injected transport failure through the real helper with sentinel secrets and a check that nothing is retried, a real refused connection, the lifecycle stages, and that ordinary calls are unchanged). It was added after an auth test failed once with a bare `fetch failed` in a first clean run (m25b); that failure is **still unexplained**, see the m26 handoff (`handoffs/m26-auth-transport-diagnostics.md`, a development record that is not part of the public package).

## 4a16. Claim applicability: subject and intent (m25)

Policy, costs and limits: [claims-scope.md](claims-scope.md#subject-and-intent-m25). Re-runnable (fictional text only):
- `node --test tests/claims-applicability.test.js`: 20 tests (15 from m25; m25b added 5: an unknown verb does not hide an unknown subject, the product's name does not bless a phrase about another device, the controls that must not move, the contradiction safeguards, and the matrix-clause and modifier-excuse rules). The orchestrator's first challenge (16 predeclared cases) as a table with its breach rules: 0 false support, 0 unsafe rewrite, 0 missing finding (it had 3, 1 and 1 before the change, kept in `handoffs/evidence/m25-FIRST-RUN-challenge-v1-before.json`); the subject and intent cases with positive controls, mixed sentences, the seeded campaigns, the no-declared-product fallback, the transcription path, order independence of the cached patterns (a bug found and fixed in this milestone), the endurance list, and the effect through the API (no blocking error, a warning that must be acknowledged, the person still decides). Fixes made against the first challenge are not evidence of generalisation.
- `npm run eval:claims`: 160 scored cases (the old 98 plus 62 written by the implementer), 16 known limits. A regression baseline over our own sentences, not accuracy; m25b promoted two limits that positive scope now handles and recorded five new residuals. A regression baseline over our own sentences, not accuracy.

## 4a15. Optional evidence-change journey (m24)

Design, API and limits: [judge-demo.md](judge-demo.md#the-optional-evidence-change-scenario-m24). Re-runnable on fictional data in temp folders (optional model and OCR off):
- `node --test tests/judge-scenario.test.js`: 11 tests. A fresh visitor starts it and the registered quote and the version-1 approval are real; previewing writes nothing (the stored workspace is byte-for-byte equal); the whole journey (activation stales the approval at once, a fresh approval is refused with the replaced-evidence reason, the repair and a Reviewer decision re-approve, the dossier holds both approvals with different evidence bindings, a start after completion changes nothing); simultaneous starts set it up once; the visitor's own campaign, comment and the sample campaigns keep their text and history; conflicting sessions are refused before any write; a second visitor never sees or changes the first's (the same `SRC-1` and `SUB-4` numbers are different records); the same-site Origin rule and the ordinary app having no such route; storage and image caps refuse before the first write and use no session slot; a set-up that fails part-way (three injected failure points) keeps the visitor's work, reports "only partly set up" and finishes without duplicates; Reset removes it and expiry reaches nothing. They were also checked against eight deliberate breaks of the new code, made in an isolated copy of the tree, never the live one; all were caught (`handoffs/evidence/m24-mutation-check.txt`, with its control run).
- `npm run ui-smoke-journey`: 118 checks, one separate browser profile (so one separate visitor) each at desktop, 390 and 320 px, through real clicks, form fields and key presses on the role picker: find the entry, start it, preview (nothing written), activate, stale and blocked, repair the facts and the copy, a Reviewer approves again, the dossier, a reload; no sideways page scroll at each stage; screenshots `docs/evidence/journey-*.png`. The timings it prints are of an automated script, not a user study.

## 4a14. Phone at the extremes (m23)

`npm run ui-smoke-phone` now asserts 54 checks: it adds 320 px with 200% text and 195 px wide (what 200% browser zoom leaves of a 390 px phone) to the workspace, queue, sources, library and insights pages, the retained-metadata chip, real-key role switching, the "session ended" notice, and the missing-deep-link recovery being visible above the bottom tab bar. First run before the fix: 6 of 54 failed (`handoffs/evidence/m23-FIRST-RUN-phone-before-fix.*`). Cause: grid containers whose single column was `auto` (the finding card, its exhibit and its source note) sized to their widest line, a key/value list kept a fixed 120px label column, and the stat tiles had a 180px minimum column. The fixed bottom tab bar only looked too wide because the page behind it was (the layout viewport grows with the overflowing content). Fix in `public/styles.css`: those grids may shrink (`minmax(0, 1fr)`) and their text wraps; at 360px and below a value goes under its label; the tile minimum is `min(180px, 100%)`. Text is not shrunk and overflow is not hidden. The tab labels stay capped to their column, which makes them about 11 CSS px at 320 px and 6.6 CSS px at 195 px (13 device px at the 2x zoom that produces 195 px).

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
