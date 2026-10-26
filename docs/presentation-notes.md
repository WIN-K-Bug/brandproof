# Presentation, demo and limitations notes

Short notes for whoever presents BrandProof (Team bhangaledhruv7, Codex 48). Everything here matches what the repository actually does today and what was actually run. Nothing below is a user-study result, a market claim or an accuracy figure.

## One sentence

BrandProof checks campaign copy and image details against approved, versioned brand facts and registered source documents, explains every finding with the exact passage that raised it, binds each human approval to the exact inputs it covered, and shows what a change to the evidence would do **before** it is made.

## Who it is for

A small brand or marketing team whose approved facts change after a campaign was approved, and who need to answer: *what exactly was reviewed, against which evidence, who decided, and what must be looked at again now?*

## The story in six beats (fictional "Fernlight" brand)

No speaking time has been measured; do not quote a duration. The beats below are what the scripted rehearsal drives (see [judge-rehearsal.md](judge-rehearsal.md): 88 automated actions including 10 sign-ins, about 87 s of automated wall-clock with fixed waits, which says nothing about a human or a spoken demo). For a live run of the 12 → 8 hours change use `npm run demo:consequence`; the showcase's pending version only adds a care note.

1. **A flawed claim**: the copy says 30 hours of battery (in the showcase, SUB-6). The finding quotes the exact sentence of the registered fact sheet and opens it highlighted. It says what the evidence says; it does not guess.
2. **A corrected campaign** (SUB-4): approved by a reviewer. The approval records the content, image, guideline and evidence it covered.
3. **The source changes.** A manager opens the pending fact-sheet version and presses **Preview impact**: which rules cite it, whether each exact quote is still there, which campaigns are affected (every approved one, because approvals bind the whole evidence set), and what is *not* covered. Nothing is saved by looking.
4. **Activate.** The approval now says **Re-review required**, with the reason. Approving is blocked until a manager relinks the affected rules; nothing is relinked or approved automatically.
5. **Repair and decide again**, by a different person. In signed-in mode nobody can approve what they wrote.
6. **The dossier**: one printable page and a JSON file with the exact copy, image integrity, evidence, recorded decisions and the findings recomputed today, labelled as a local snapshot that can already be out of date.

Say plainly: the checks are deterministic rules, not an AI judge; contextual AI review is unavailable and nothing simulates it.

## What is real today (verified)

- Rules and facts: terminology, tone, exclamation style, numeric and statement facts with qualifier, guarantee, operating-condition, competitor/attribution and negation handling (an "up to 12 hours" fact does not support "always 12" or a competitor's figure), unverified-claim detection, palette distance, selected-colour contrast, alt text.
- Safe corrections: automatic replacement only when it keeps the approved qualifiers; otherwise advice for a person.
- Approvals bound to content, image details, guideline version and registered evidence; stale detection; decisions on an out-of-date view refused (409).
- Registered sources with manager-approved immutable versions and exact passage links; **change-impact preview** with a digest that makes a stale write refuse.
- Retained PNG campaign images with integrity checking.
- Optional **text-in-image** review: an offline reader drafts the text of a retained image, a person corrects and confirms it, and the confirmed text is checked and bound to the approval (experimental; clear text was read exactly in the synthetic proof, hard text was not).
- Optional local semantic **relevance** matching (a small embedding model run offline; relevance only, never a verdict).
- Two modes: a demo with a role switch (not security) and a separate signed-in mode with real local accounts, CSRF and Origin checks, and no self-approval.
- **Review dossier** with a JSON download.
- 310 automated tests (301 when the optional model and reader data are absent), nine scripted browser runs (eight walkthroughs plus the end-to-end judge rehearsal) with screenshots in `docs/evidence/`, two labelled synthetic corpora (regression baselines), and a checked clean-extraction of the source package (no dependency download was run; see [judge-rehearsal.md](judge-rehearsal.md)).

## What is NOT claimed

- No real users, interviews, time saved, adoption or accuracy numbers. The synthetic corpora were written by us alongside the rules: they show the rules do what we designed, not how they perform on real copy.
- No legal, compliance, accessibility-certification or security-audit claim. Colour and contrast use only the colours a person chooses (typed, picked, or sampled from one clicked pixel; never extracted automatically). Text in an image is checked only through a transcription a person confirms (an optional local reader can draft it, and it can be wrong); nothing else is read from the pixels. A person must compare the draft with the words and digits actually printed, and fixing a claim in the artwork means replacing the image, not editing the transcript.
- Not "the only" tool of its kind: we compared nothing and say nothing about other products. Brand-review products have approvals and audit trails; our narrower contribution is the exact evidence lifecycle and the preview before a change.
- A dossier is a local snapshot, not a certificate, signature or permission to publish. Its checksum detects accidental change only.
- "Equal words" in the impact preview are not "equal meaning", and a gone passage is not proof a claim is wrong.

## Known limits to say out loud

- Local, single-machine, unencrypted storage; sign-in is local only (no HTTPS, no encryption at rest, sessions in memory). Not for confidential data.
- Deterministic text rules miss paraphrases, number words ("thirty hours") and unlisted condition or attribution wording; they err toward "needs review". A plain figure at or below an "up to" limit is now a caution, not a match.
- Sources are pasted text or small `.txt`/`.md` files (no PDF or URL fetching). Legacy typed rules cannot be linked to evidence and the preview cannot assess them.
- PNG only for retained images; no deletion in this version.
- The impact preview is conservative: any campaign change anywhere makes an open preview stale. Its `previewDigest` is optional on the API (always sent by the UI).
- One writer process and one data file; no multi-user sync.
- The optional dependency has two high-severity advisories in an image decoder it never uses (see `docs/semantic-matching.md`).

## Running the demo

```
npm run demo:start         # preserved showcase, READ-ONLY tour only (4174 or the next free port; it prints the URL)
npm run demo:consequence   # isolated: the 12 -> 8 hours source change, free to change (4180 or next)
npm run demo:imagetext     # isolated: text in the image, optional OCR (4185 or next)
npm run judge-rehearsal    # scripted replay on throwaway data (needs Edge or Chrome)
npm run demo:rehearse      # API replay of the showcase steps on throwaway data
```

Which demo for which story, the exact fallbacks when the optional reader or model is missing, and a concise presenter route per demo: [demo.md](demo.md). The preserved showcase is never the place to approve a version, relink, publish or save; use the isolated demos for that. If a server was started before a feature was added, restart it; the data is unchanged.

## Where each claim is backed

| Claim | Evidence in the repo |
|---|---|
| Exact-qualifier cautions and safe replacements | [claims-scope.md](claims-scope.md), `npm run eval:claims`, `ui-smoke-claims` |
| Preview before a source change | [impact-preview.md](impact-preview.md), `tests/impact.test.js`, `ui-smoke-impact` |
| Dossier and what each digest means | [dossier.md](dossier.md), `tests/dossier.test.js`, `ui-smoke-dossier` |
| Evidence and approval binding | [sources.md](sources.md), [architecture.md](architecture.md) |
| Signed-in mode | [authentication.md](authentication.md) |
| The end-to-end story and the clean install check | [judge-rehearsal.md](judge-rehearsal.md) |
| Everything that was run | [verification.md](verification.md) |

## Team

Roles are **proposed**, not recorded contributions: see [contributions.md](contributions.md). Each member submits personal details themselves; none are stored here.
