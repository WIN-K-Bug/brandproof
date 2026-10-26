# BrandProof: Round 1 submission plan

Team name: **bhangaledhruv7** · Event: **Codex 48** · Product: **BrandProof**

> Source material for the Round 1 PDF, which is authored and verified separately.
> Everything below describes what exists in this repository today or is explicitly labelled as planned. There are no interviews, user numbers or accuracy figures in this document, because none have been collected.
> Build window (provisional, exact round deadlines unconfirmed): 24 Oct 2026 09:00 IST to 26 Oct 2026 09:00 IST.

## Rubric map

| Rubric criterion | Weight | Where it is answered |
|---|---|---|
| Problem understanding | 25 | Sections 1, 2, 10 |
| Solution quality | 25 | Sections 3, 4, 5 |
| Technical depth | 20 | Section 6 (stack and hardest challenge) |
| Originality | 15 | Sections 3 and 6 (evidence-bound approvals) |
| Feasibility | 15 | Sections 7, 8, 9, 11 |

The 11 sections follow the order the organisers asked for.

---

## 1. Understanding of the problem

Brand teams publish campaign copy and images through many hands: creators draft, managers adjust, reviewers sign off. Brand guidelines live in documents that people have to remember or search. Three things go wrong repeatedly:

- **Inconsistency is caught late or not at all.** Product names, banned words, tone and colours drift, and the person reviewing has to hold the whole guide in their head.
- **Claims go out without evidence.** A number or superlative in copy ("lasts 30 hours", "the best") is only as good as the fact sheet behind it, and nobody checks the two against each other.
- **Approvals do not stay true.** A manager approves a piece, someone edits one line, the guidelines are updated, and the "approved" label stays on content that nobody reviewed in its final form.

Most review tooling stops at "flag things". The harder problem is making a review *trustworthy*: every finding should point at the exact rule or fact that raised it, say plainly what is known versus merely unchecked, and every approval should mean something specific.

## 2. Who is affected

- **Content creators** need fast, specific, fixable feedback before they send work for review, not a vague "off-brand".
- **Brand and marketing managers** own the guidelines and need a way to keep them as structured, versioned, citable rules instead of a PDF nobody reads.
- **Reviewers and approvers** need evidence at the point of decision and need to know that what they approve is exactly what ships.
- **Audiences and the organisation** are affected indirectly by inaccurate claims, inaccessible images and inconsistent messaging.

We have not interviewed any of these groups. The description above is our reasoning about the workflow, to be validated in later rounds (see Section 9).

## 3. Our solution

**BrandProof** reviews campaign content *before publication* against approved brand rules, approved facts and brand assets, and binds every approval to the exact content it covered.

The idea that sets it apart is **evidence-bound approval**:

1. Findings carry real rule and fact IDs, the exact source quote, the span of text that triggered them, an explanation, and (where one is safe) a correction that preserves intent.
2. The checker separates three situations that most tools blur: an **explicit contradiction** of an approved fact, a claim with **no matching approved fact found by these checks**, and a statement that is **ambiguous** and needs a human. A number or superlative with no matching fact is *unverified*, never called false.
3. An approval is bound to the **copy, the image details and the guideline version** it was given against. Changing any of them, including publishing a new guideline version, makes the approval show **Re-review required**. The server also refuses an approval if the reviewer's screen was out of date.
4. People stay in control. Nothing is auto-applied; suggestions are applied or dismissed by a person, and every decision is recorded with who, when and what it was bound to.

Current status: a working local prototype in demo mode (see Section 5 for exactly what works, and `README.md` for limits).

## 4. Complete workflow

1. **Manager sets up the brand library.** Terminology rules, approved facts (with exact source quotes), palette and thresholds are edited as structured entries and published as a numbered, hashed **guideline version**.
2. **Creator submits campaign copy and image details.** Copy is typed; for the image, the creator gives alt text, selects the text and background colours, and lists the colours used. A local image file can be loaded to sample colours by clicking it (the person chooses each colour; nothing is extracted automatically). *(This is the Round 1 plan as first written. Since then the PNG itself is retained by the server and bound to approvals: see [assets.md](assets.md).)*
3. **BrandProof checks it** with deterministic rules and shows findings next to the highlighted copy, each with source evidence.
4. **Creator fixes and resubmits.** Safe corrections are applied to a draft with one click; the draft is saved as a new **revision**. Revisions can be compared word by word, with findings resolved, new and still open.
5. **Creator requests review.** Collaborators comment on the revision or on a specific rule.
6. **Reviewer or manager decides.** The server decides whether approval is allowed (blocking findings stop it; warnings need an explicit acknowledgement). The decision records the exact binding.
7. **Change after approval.** Any later edit, image change or guideline version makes the status **Re-review required** in the workspace, the queue and the history, with the reason.
8. **Insights.** Recurring issues are counted by rule across saved revisions, showing what keeps coming back and what has been fixed.

## 5. Features

Working today (verified by 310 automated tests and a scripted browser walkthrough):

- Structured, editable, versioned brand library (terminology, approved facts, palette, thresholds) with a version history and change summary.
- Deterministic checks: terminology and capitalisation, exclamation style, approved-fact comparison (numeric and statement facts, negation and qualifier handling, clause-level association), unverified-claim detection, palette distance, selected-colour WCAG contrast, alt-text checks.
- Findings with real IDs, exact quotes, spans, explanations and safe corrections; unverified and needs-review states kept apart from contradictions.
- Revision history with word-level comparison; comments; request-review, approve and reject with server-derived eligibility.
- Binding of approvals to content, image details and guideline version; stale-approval detection; expected-state check that returns 409 if the reviewer's view is out of date.
- Concurrency-safe local persistence (serialised atomic writes) and optimistic revision checks, so concurrent edits are never silently lost.
- Review queue and recurring-issue insights.
- **Persistent campaign images:** a creator attaches a PNG that the server validates and retains by digest; reviewers see exactly those bytes after reload or restart; approvals are bound to the image, replacement makes them stale, and history keeps each revision's image. Older metadata-only records are labelled honestly. Colour checks stay manual; text inside an image has its own optional, human-confirmed path (see ocr-image-text.md).
- **Approved-source registry:** paste or load a small text source; a manager approves an exact immutable version; rules and facts cite an exact passage that the server validates; findings open the cited passage highlighted; replacing or withdrawing a cited source makes approvals Re-review required. Typed sources stay explicitly Legacy.
- **Authenticated workspace mode** (separate from the demo): real local accounts, server-derived roles, session cookies with CSRF and origin protection, rate-limited sign-in, scrypt password hashes, actor ids on every record, and a rule that nobody can approve a submission they created or edited. Local only: no HTTPS or encryption at rest.
- Contextual-AI adapter *contract* in place; no AI provider is connected, and the UI says so.
- Optional **AI source matching**: a small open embedding model (Apache-2.0) run locally in a worker thread shows which approved sources are topically relevant to selected passages of a saved revision. It measures relevance only, is not generative review, and has no effect on findings or approval. Needs an optional install; shown as unavailable otherwise.

Planned, not built: confidential multi-user deployment with real authentication; contextual AI review; document ingestion (PDF/Word) for guidelines; image analysis beyond user-selected colours.

## 6. Technology stack and the hardest technical challenge

**Stack (all chosen to be free, local and dependency-light):**

- **Node.js 22 with no runtime dependencies** for the server (`node:http`, `node:crypto`, `node:fs`, `node:test`). It runs from a clean checkout with `node server.js`, which matters in a 48-hour window and on any teammate's machine.
- **Vanilla JavaScript front end** with DOM construction that only creates text nodes, plus a strict Content-Security-Policy, so user content cannot become markup.
- **JSON-file persistence** behind a small store that serialises writes and commits atomically. We chose this over a database because the milestone is a single-machine demo and the store interface is the seam where a real database would go.
- **SHA-256 content hashing** (canonical JSON) for binding approvals.
- **Optional local semantic matching** with Transformers.js and a small open embedding model, run locally with no hosted inference (see `docs/architecture.md`); the app works without it.

**Hardest technical challenge: making "supported", "contradicted" and "unverified" mean something honest using deterministic checks.** Language is ambiguous: "Battery life, 30 hours", "does not last 12 hours", "over 12 hours" and "lasts 12 hours and is clinically proven" all mix figures, topics and claims. Naïve matching produces confident wrong answers (calling an unrelated number false, or an unrelated claim covered). Our approach splits sentences into clauses, only compares a figure with a fact when the fact's topic is in the same clause, handles negation and qualifiers explicitly, and downgrades anything uncertain to *needs review* rather than guessing. A claim is only absorbed by a fact if its exact phrase was judged against that fact. A second hard problem is **keeping approvals honest under concurrency and change**: the server derives status from recomputed hashes, serialises writes, and rejects decisions made on a stale view.

## 7. Member responsibilities (proposed)

These are **planning assignments, not statements of completed work**. Actual individual contributions are described by each member in their own submission.

| Member | Proposed responsibility |
|---|---|
| kevin george | Product, research and pitch |
| dhruv bhangale | Front end and accessibility |
| Sahil Sakhure | Back end, rules engine and version integrity |
| eric siju | QA, deployment and documentation |

Names are the full names exactly as supplied. Contact details are not recorded in this repository (Section 11).

## 8. Plan across all three rounds

| Round | Focus | Planned work |
|---|---|---|
| 1 | Understanding and a credible, working core | This milestone: rule engine, versioned library, evidence-bound approvals, demo UI, tests, honest documentation. |
| 2 | End-to-end workflow and reliability | Harden the full creator → reviewer → approval path; broaden fixtures; error and edge-case handling; usability pass with real users if available; start separation of identity and storage from the demo. |
| 3 | Completeness, reliability, usability | Close gaps found in round 2; polish accessibility and responsiveness; documentation and demo script; decide whether an AI provider or deployment is feasible within the constraints. |

Three measurable improvements tracked across rounds are defined in `docs/rounds.md`: detection fixture quality, stale-approval prevention, and review usability.

Constraint: only existing Claude Code and ChatGPT Plus subscriptions, no paid services, and no assumption that either provides an application API key.

## 9. Expected impact

We make **no quantitative impact claim**, because we have not measured any. What we expect, as hypotheses to test:

- Creators fix more issues before review because findings are specific and fixable.
- Reviewers spend their time on judgement rather than hunting for guideline conflicts, because evidence is attached.
- Fewer outdated approvals survive an edit, because the binding makes the stale state visible and blocks silent reuse.
- Managers can see which rules recur, so guidelines can be clarified where people keep stumbling.

Each hypothesis maps to a measure in `docs/rounds.md`; we will report results only from data we actually collect.

## 10. Future scope

Presented as future milestones, **not current capability**:

- **Confidential multi-user deployment:** real authentication and per-organisation authorisation, server-side database with access control and audit log, encryption in transit and at rest, and a deployment target. The store interface and server-derived permissions are the seams for this.
- **Real contextual AI review** behind the existing adapter contract (tone, messaging fit, claims that need reasoning). Output would be labelled as AI, advisory, and unable to mark a claim supported or contradicted without citing an approved fact.
- **Guideline ingestion** from existing documents with human confirmation of extracted rules and facts.
- **Richer asset checks:** logo and layout rules and automated colour extraction. (Text in images now has an optional, human-confirmed path: see [ocr-image-text.md](ocr-image-text.md).)
- **Integrations** with publishing tools so approval gates real publication.

## 11. Participant details

Team name: **bhangaledhruv7**, exactly as supplied. Event: **Codex 48**. (This plan was first written under the earlier team name 4MUSKETEERS.)

The organisers require each member to submit their own **full name, e-mail and contribution**. The full names below are exactly as supplied by the user; we have not independently verified any certificate details. E-mails are held in the separate submission folder and are deliberately **not** recorded in this repository. Actual contributions have **not** been provided yet, and the roles above are proposals, not completed work.

| Full name (as supplied) | E-mail | Contribution (own words, after the work is done) |
|---|---|---|
| kevin george | *held in the submission folder, not here* | *not yet provided by kevin george* |
| dhruv bhangale | *held in the submission folder, not here* | *not yet provided by dhruv bhangale* |
| Sahil Sakhure | *held in the submission folder, not here* | *not yet provided by Sahil Sakhure* |
| eric siju | *held in the submission folder, not here* | *not yet provided by eric siju* |
