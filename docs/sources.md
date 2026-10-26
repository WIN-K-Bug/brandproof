# Approved sources and evidence

Until this milestone a rule or fact carried a **typed** source label and quotation. A finding that shows a quote was therefore not proof that the quote exists in any document. The source registry makes evidence inspectable and versioned. It applies to **both** modes (demo and authenticated).

## The workflow (one vertical slice)

1. **Register** a source by pasting text or loading a small UTF-8 `.txt` / `.md` file (up to 100,000 characters). Creators and managers can do this. The text, title, file name, address label, digest, registrant and time are preserved. The result is **version 1, pending**. Nothing is approved by registering.
2. A **manager reads the exact text and approves that version** (a checkbox confirms the text was read; the request carries the digest of what was shown, so a different text cannot be approved by mistake). In authenticated mode the manager must be a different person from whoever registered that version. Approval makes the version **active** (in force). A manager can also **reject** a draft (with a reason).
3. A manager **links an exact passage** of an *active* version to a terminology rule or an approved fact (select the text, or type start and end). The server cuts the quote out of the registered text itself.
4. **Publish** the guidelines. The server validates every link again, inside the same serialised write that publishes, and stores the registered quote, source id, version, offsets and the text digest with the rule.
5. **Review a campaign.** A finding that rests on a linked rule says **Registered source**, shows the cited passage, and links to **the exact passage highlighted in the source text**. Findings from typed entries say **Legacy source: typed label and quote, not linked to a registered source**.
6. **Change over time.** A new version is a draft until a manager approves it (the active version does not change meanwhile). Approving it replaces the active version. A manager can also **withdraw** a source (reason required). See the effect below.

## What counts as evidence

| Version state | Meaning | Can be linked? | Counts as evidence? |
|---|---|---|---|
| pending | registered, awaiting a manager | no | no |
| rejected | a manager refused it | no | no |
| active | approved and currently in force | **yes** | **yes** |
| superseded | approved earlier; a newer version is in force | no | no (history only) |
| withdrawn | approved earlier; the source was withdrawn | no | no (history only) |

Only the **active approved version** can be linked or cited. Approved text is **immutable**: there is no edit route, a correction is a new version, and the history of who registered, approved, rejected or withdrew what stays.

## Linking rules (what the server enforces)

The client sends only `{ sourceId, version, start, end }` (an optional quote is only *checked*). The server rejects with 422 and a list of every problem (path, rule id, reason) if: the source or version does not exist; the version is pending, rejected, superseded or withdrawn; the span is not whole numbers, is empty, outside the text, splits a character (surrogate pair), is longer than 500 characters or has fewer than 3 non-space characters; a quote that was sent does not equal the text at those offsets. Forged `doc`, `section` or `quote` values are **overwritten** with registry values. Registered links are allowed on terminology rules and approved facts only (policy sources stay typed in this slice). Typed entries pass through unchanged and stay **legacy**; a typed label that merely *mentions* a source id is not relabelled.

## Text normalisation and offsets

Offsets and digests are defined on the **normalised** text so that Unicode and line endings cannot disagree between the browser, the server and the stored record:

- a leading BOM is removed; CRLF and lone CR become LF; text is Unicode **NFC**;
- control characters other than LF and TAB are refused; the replacement character U+FFFD (a decoding failure) is refused; empty text is refused;
- offsets are **UTF-16 code-unit indices** into that text, `[start, end)`; a span may not cut a surrogate pair;
- repeated passages are told apart by offset (the second "keep it calm." has its own start);
- the digest is **SHA-256 of the UTF-8 bytes of the normalised text**. It is **not** a digest of any original file, and the original file is not stored. Address (URL) fields are labels: **never fetched, opened or verified**.

## Effect on approvals (the trust model)

Every approval is bound to **copy + image details + guideline version + effective evidence**. The *effective evidence* is a manifest: for each linked rule/fact in the current guidelines, the source, version, offsets, text digest and the **current state** of that version (active / superseded / withdrawn). Its hash (`evidenceHash`) is part of the binding.

| Event | Effect |
|---|---|
| Register a source or a new version (draft) | none (it is pending; nothing governs) |
| Reject a draft | none |
| Approve a first version of an unlinked source | none for approvals (nothing cites it); it becomes available to link and to contextual retrieval |
| **Approve a replacement version** of a source that rules cite | the cited version becomes *superseded*: every approval resting on those rules shows **Re-review required** (reason: evidence); until a manager repairs the links, **no one can approve** |
| **Withdraw** a cited source | same as above (state *withdrawn*) |
| Manager relinks (same quote in the new version, or a new passage) or **unlinks to legacy**, then publishes | broken links disappear; the new guideline version also changes the binding; items go through review again |

Details that matter:

- **Not just a badge.** The status is derived from the binding, so an old approval cannot stay green. Lists, the workspace and the queue show the same state.
- **A review-required block.** While any linked rule cites evidence that is not in force, approving is refused (403, with the reason shown). Requesting review is still allowed.
- **A publish gate.** Publishing *any* guideline change while a link is broken is refused (422, listing each broken link). This forces repair first. Repair tools are in the Brand library: *Relink to same quote in version in force* (offered only if that quote occurs exactly once in the new version), *Choose passage…*, or *Unlink (legacy)*.
- **Races.** Requests to request-review/approve/reject carry the `evidenceHash` the person saw; if a source was activated or withdrawn in between, the server answers 409 `stale_view` (changed: evidence) and records nothing. All of this is decided inside one serialised store write, so a publish racing a source activation cannot leave a green approval on replaced evidence (tested). Contextual source matching re-checks the evidence and retrieval hashes after inference and discards the result (409) if they moved.
- **Old approvals.** Approvals recorded before this milestone have no `evidenceHash`; they are treated as "bound to no registered evidence", stay valid while nothing is linked, and become stale (reason: evidence) once linked evidence exists.
- **History is preserved.** Superseded and withdrawn versions, their approvers and the events stay readable; findings and approvals recorded earlier keep the binding they had.

## Impact preview before activation or withdrawal

A manager can read what approving a pending version or withdrawing the active one would change (dependencies and exact quote continuity, campaign references, whole-binding workflow effects) before doing it; the write then carries the preview digest and is refused as stale if the state moved. Read-only; never relinks or approves. See [impact-preview.md](impact-preview.md).

## Contextual retrieval (AI source matching)

Retrieval candidates are the guideline entries' quotes **plus passages of ACTIVE approved registered sources** (paragraph-sized chunks, at most 500 characters, capped). Pending, rejected, superseded and withdrawn text is never embedded.

**Retired evidence does not come back through the rules.** A guideline fact or term that is *linked* to a registered source is a candidate only while the version it cites is active, using the current registry state; if that source was withdrawn or replaced (or is missing) the rule is dropped from retrieval until a manager relinks it. Explicitly *legacy* (typed) entries stay candidates and are returned with `registered: null`. An active linked rule is returned **with registered provenance** (`sourceId`, `version`, `start`, `end`), so its exact passage can be opened. If no link states are supplied at all, linked entries are dropped (fail closed). Historical findings keep the evidence they were made with and show it flagged as withdrawn/replaced.

The embeddings cache is bound to the guideline hash, the retrieval hash **and** the effective-evidence hash, so a withdrawal or replacement cannot be served from a warm cache. A result for a registered passage links to that passage in its source. Similarity is **relevance, not truth or compliance**, and plays no part in findings or approval.

## Roles

| Action | Demo mode | Authenticated mode |
|---|---|---|
| Read sources | any role | signed-in users |
| Register source / new version | Creator, Manager | Creator, Manager |
| Approve / reject / withdraw | Manager | Manager; **not the person who registered that version** |
| Link evidence and publish | Manager | Manager |

Actor, role, status and approval fields in request bodies are ignored; the server records the real actor (authenticated) or the demo role label.

## Limits of this slice

Plain pasted text and small UTF-8 `.txt`/`.md` only: no PDF, OCR, HTML parsing, URL fetching or arbitrary file formats. Pasted text is not proven to match any original document (digest is of the normalised text). No source deletion (withdraw instead). No per-source access control. Policies (claims, contrast, alt text, palette, punctuation) still use typed legacy sources. A source of up to 100,000 characters is stored inline in the workspace file. Chunking for retrieval is by paragraph.

## Data and compatibility

- Workspace files gain, only when used: a `sources` list and `seq.source`; guideline entries may gain `source.sourceId`, `version`, `start`, `end`, `textSha256`; approval bindings gain `evidenceHash`. A file that has none of this loads and behaves as before; an untouched file does not even get a `sources` key.
- **No automatic migration.** Existing typed sources stay legacy until a manager links them.
- **Do not downgrade.** An older BrandProof build opening a file that contains linked sources would not understand the links. Keep a copy of `data/` before first registering sources. Authenticated mode writes timestamped backups (newest 3) when it opens its files; demo mode does not, so copy the file first.
- Nothing here resets or rewrites the main data directory.
