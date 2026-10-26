# Architecture

BrandProof is a small Node.js 22 application with **no runtime dependencies** for the core. An optional local embedding feature adds one exactly pinned package. Everything runs on one machine and the server listens on `127.0.0.1` only.

```
browser (public/*.js, CSP: self only)
   │  JSON over HTTP, X-Demo-Role header
   ▼
src/app.js      routing, validation, limits, security headers
   ├─ src/validate.js   input validation and normalisation
   ├─ src/service.js    workflow, versions, binding, eligibility (pure over state)
   │     └─ src/checks.js     deterministic rule engine
   ├─ src/assets.js     PNG validation, content-addressed image files, asset registry, single-flight upload
   ├─ src/sources.js    source registry, evidence links, effective-evidence manifest, retrieval passages
   ├─ src/auth.js       authenticated mode: scrypt, sessions, CSRF token, rate limits, users and audit
   ├─ src/store.js      serialised, atomic JSON persistence (optional backups, file mode, refusal hooks)
   ├─ src/ai.js         contextual-AI adapter contract (no provider connected)
   └─ src/semantic.js   optional local "AI source matching"
         └─ src/semantic-worker.js   embedding model in a worker thread
```

## Data model

One JSON document (`data/brandproof.json`): a sequence of **guideline versions**, and **submissions**. A submission holds immutable **revisions** (copy + image details), **comments**, and an append-only list of **events** (review requested, approved, rejected).

- A guideline version is the whole structured guide (terms, approved facts, palette, thresholds, claim policy), its SHA-256, who published it and a note. Entry IDs (`TRM-001`, `FCT-001`, `COL-001`) are never reused across versions.
- An approval event stores the **binding**: SHA-256 of the copy, SHA-256 of the image details, the guideline hash and version.

## Modes and identity

`createApp({ mode })` is either **demo** (role from the `X-Demo-Role` header; not security) or **authenticated** (identity from a server-side session only; the header is never read). Each route is classified public, authenticated, or owner-only. In authenticated mode the request pipeline is: Host check → strict Origin match for unsafe methods → session lookup (cookie → hashed secret) → CSRF token check → owner check → body parse (size-limited) → handler with `{ role, actor }` taken from the **current** account record. Services take an `actor` ({ id, name, role }) and fall back to the demo role label; the same workflow code runs in both modes. Self-approval prevention is derived in `deriveWorkflow` from the actor id and the authors of the submission. Credentials live in a separate store (`users.json`) from the workspace, and each mode refuses the other's workspace file. Details: [authentication.md](authentication.md).

## Campaign images (`src/assets.js`)

Image bytes are stored as `<workspace file>.assets/<sha256>.png`; the workspace state holds a registry (`state.assets`) and revisions refer to an image only by its server-computed digest (`asset.retainedSha256`). Upload is validate (full PNG structure, CRCs, bounded zlib decode) -> quota check -> write file (temp, fsync, rename) -> register in the serialised store write, single-flight, with the new file removed if registration fails. Serving is a fixed route that only resolves registered digests, re-hashes the file, and sends a fixed type with restrictive headers. The digest joins `assetHash` only when present, so old approvals are untouched; replacing an image changes the binding. See [assets.md](assets.md).

## Source registry and evidence (`src/sources.js`)

Sources live in the same workspace state (one serialised, atomic store). A source has immutable versions (normalised text, SHA-256 of that text, registrant, status) and an append-only event list; `activeVersion` says which approved version is in force. Rules and facts may carry a link `{ sourceId, version, start, end }`; `resolveEvidence` (run inside the publishing mutation) validates it against the active approved version and rewrites the stored source from the registry text. `evidenceManifest` lists every linked rule with the *current* state of its version; its hash is the `evidenceHash` in every approval binding, in the `expected` payload of decisions and in the semantic-matching race check. Approval is blocked while any linked rule cites evidence that is not in force. A separate *retrieval hash* covers the passages of all active approved sources used for contextual matching. Full trust model: [sources.md](sources.md).

## Text in images (`src/ocr.js`, `src/ocr-worker.js`)

An optional reader service: a pinned offline Tesseract.js inside its own worker thread, bounded (one running, two queued, 30 s timeout, idle stop), cancellable, with path-free errors, that returns a DRAFT bound to the image digest. `POST /api/assets/:sha/ocr` (creator or manager) reads a retained image after re-hashing its bytes. A person's confirmed transcription is saved by `service.js` as `revision.imageText`, with provenance and the image digest decided by the server; its `imageTextHash` is part of the approval binding only when present; `runChecks` runs the same text rules over it as the distinct field `imageText` (advice-only corrections). Details and limits: [ocr-image-text.md](ocr-image-text.md); feasibility proof: [ocr-phase-a.md](ocr-phase-a.md).

## Review dossier (`src/dossier.js`)

`buildDossier(state, id, { integrity, now, mode })` is pure over one committed state and returns the campaign snapshot (recorded events with their bindings compared with today's inputs, findings recomputed today, exact cited excerpts, image state, status headline, limits, checksum). `GET /api/submissions/:id/dossier` reads the image integrity from disk, then accepts the result only if `store.state` is still the object it started from, rebuilding up to four times before answering 409. The browser page (`public/dossier.js`) renders the object as text nodes and builds the explicit JSON download in the browser. Details: [dossier.md](dossier.md).

## Source change-impact preview (`src/impact.js`)

A pure function over committed state: `previewSourceChange(state, { sourceId, action, version, actor })`. It simulates the activation or withdrawal on shallow copies of the registry, then reuses `evidenceManifest` and `deriveWorkflow` so the counts are the ones the real change produces. It returns exact dependencies with continuity of each cited quote, campaign finding references, whole-binding workflow effects and a digest over the baseline state. `GET /api/sources/:id/impact` (managers only) serves it from `store.state` synchronously, so a response always describes one committed state. The approve and withdraw routes accept an optional `previewDigest` and, when present, recompute the preview inside the serialised mutation and refuse with `409 stale_preview` on any difference. Details and limits: [impact-preview.md](impact-preview.md).

## Rule engine (`src/checks.js`)

Pure function `(content, guidelines) → findings`. Each finding has a rule ID, status, severity, exact quote, span, explanation, source (document, section, quote), evidence, and a correction that is either a safe `replace` or free-text `advice`.

Statuses: `violation`, `contradicted` (explicit conflict with an approved fact, cites it), `unverified` (no matching approved fact found by these checks; cites the substantiation policy, never a fact), `needs_review` (ambiguous wording), `supported`.

How facts are compared:

1. Text is split into sentences, then clauses (commas, colons, dashes, brackets and "and/but/while…").
2. A numeric fact is compared with a figure only if the figure carries the fact's unit **and** a topic word of the fact is in the **same clause**. A topic in another clause gives `needs_review`.
3. Negation ("does not last 12 hours") and qualifiers ("over", "at least", "about", "up to") are handled explicitly; uncertain cases become `needs_review`. An "up to N" fact supports only "up to N" about our product under its recorded conditions: exact or guaranteed wording, a differing operating condition, another subject (competitor, "their") and quoted or attributed figures are `needs_review` with advice, and a replacement is offered only when it provably keeps the approved qualifiers ([claims-scope.md](claims-scope.md)).
4. Statement facts match literal phrases; "not waterproof" is consistent, "not only waterproof" is not.
5. A claim signal ("best", "guaranteed", a percentage…) is flagged `unverified` unless that exact phrase was judged against a fact. Judged facts hide only their own phrase, not the rest of the sentence.

Image checks use values the user selects: WCAG contrast of the chosen text/background colours, CIE76 distance of the listed colours to the palette, alt-text presence and quality. Anything not provided is reported under **Not checked**.

## Workflow and approval integrity (`src/service.js`)

- **Status is derived, never stored.** `deriveWorkflow` recomputes hashes from the stored copy, image details and the current guideline version, and compares them with the binding of the latest approval. Differences yield the reasons `content`, `asset`, `guideline`.
- Statuses: Draft, In review, Approved, Rejected, **Re-review required** (an approval exists whose binding no longer matches, including after a new revision).
- **Eligibility is server-side.** For the requesting demo role: who may revise, request review, approve, reject; blocking findings stop approval; warnings require `acknowledgeWarnings`.
- **Decisions carry what the person saw.** Request-review, approve and reject must send `expected` (content, image and guideline hashes + guideline version) and the revision number. The server rejects with **409** if the revision is no longer latest or anything it was bound to changed, and records nothing.
- Revisions use optimistic concurrency (`baseRevision`). Guideline publication uses `baseVersion`.

## Persistence (`src/store.js`)

`mutate(fn)` runs one change at a time (promise queue) on a clone of the state; only after the file is written (temp file, `fsync`, rename, with retries for Windows file locks) is the clone published (deep-frozen). A failing change leaves memory and disk untouched. A corrupt or wrong-schema file is never overwritten. This prevents lost updates under concurrent requests inside ONE process; it is **not** a multi-user database.

**One writer per file.** The store holds the whole file in memory, so two writers on one file would each acknowledge saves and the later rewrite would silently drop the earlier one (reproduced with two real processes). `Store.open` therefore takes exclusive ownership of the file FIRST (before any read, seeding or backup) through `src/lock.js`, for the workspace and for the credential file alike; a second opener, in this process or another, is refused with an actionable message and nothing is read or changed. `close()` stops accepting writes, lets accepted ones finish, then releases ownership; `createApp().close()` does this for every file it owns, and start-up failures release what they took. Different files never conflict, so free-port fallback still works for separate data. Details, recovery and limits: [single-writer.md](single-writer.md).

## HTTP surface (`src/app.js`)

- Host header must be `localhost`/`127.0.0.1`; cross-origin writes are refused; bodies are limited to 512 KB; JSON content type required; every field validated with explicit limits.
- Static files come only from `public/` (explicit allow-list built at start-up).
- Headers: strict CSP (`default-src 'self'`, no inline scripts or styles), `nosniff`, `X-Frame-Options: DENY`.
- The UI builds DOM with text nodes only, so stored content cannot become markup.

## Contextual-AI adapter (`src/ai.js`)

A contract (status, `describe()`, `review()`) with only an *unconfigured* provider. The engine always reports **Rules mode, contextual AI unavailable**. Nothing simulates AI.

## Local AI source matching (`src/semantic*.js`)

Optional and **separate from findings, eligibility and approval**. It embeds the approved sources (facts, terminology and policy quotes) and selected passages of a *saved* revision with a small local model and ranks sources by cosine similarity.

- Runs in a **worker thread**; the model loads **offline** from `.cache/models` after a SHA-256 integrity check. Remote model loading is disabled in the worker.
- Source embeddings are **cached by guideline hash** (bounded LRU).
- **One inference at a time**, at most 4 queued requests (429 when busy), 60 s timeout, ≤ 8 passages of ≤ 500 characters, ≤ 2000 characters per request.
- **Staleness:** a request carries the content and guideline hashes it was made for and is refused before inference if they are out of date. After inference the server re-checks the latest revision and guideline hash; if either changed, the result is discarded with **409**. The UI additionally drops any result whose key (submission, revision, content hash, guideline hash) no longer matches what is on screen.
- **Worker lifecycle:** callbacks are tied to the specific worker; a late exit or error from a replaced worker is ignored, so it cannot kill its successor.
- Unavailable states (package missing, model files missing, load error, timeout) are reported with the reason. Details and limits: [semantic-matching.md](semantic-matching.md).

## Front end (`public/`)

Plain ES modules: `app.js` (shell, routing, role switch), `workspace.js` (review surface, editor, findings, discussion, history, comparison, AI source matching), `library.js` (structured guideline editor and versions), `queue.js`, `insights.js`, `ui.js` (DOM helpers, API client). Draft checks use a sequence number plus an identity snapshot so a late response never replaces the findings for newer text or another campaign.

## Route to a real deployment (future milestones, not built)

1. **Identity and authorisation:** a local authenticated mode now exists (see above and [authentication.md](authentication.md)). Still to do for a real deployment: HTTPS, SSO/MFA, per-organisation roles and tenant isolation.
2. **Storage:** replace `store.js` with a transactional database behind the same `mutate` contract, with access control, encryption at rest, backups and an audit log.
3. **Confidentiality:** TLS, secrets management, tenant isolation, retention rules, and a review of what leaves the machine.
4. **Contextual AI:** implement a provider behind `src/ai.js` after a data-handling decision; keep AI output labelled, advisory, and unable to mark claims supported or contradicted without citing an approved fact.
5. **Operations:** CI, deployment target, monitoring, load limits.
