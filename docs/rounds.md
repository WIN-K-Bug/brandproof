# Measurable improvements across the three rounds

Team **bhangaledhruv7** · Codex 48 · BrandProof

Three things we will measure and report each round. We report only numbers we actually produce, with the method next to them. **No figures below are results**; the "Round 1 baseline" column is what the repository can show today, and everything else is a target to be measured later.

Build window (provisional): 24 Oct 2026 09:00 IST to 26 Oct 2026 09:00 IST. Exact round deadlines are unconfirmed.

## 1. Detection fixture quality

**What:** how well the rule checks reproduce a set of labelled test cases.

**How measured:** `npm run eval` runs `tests/fixtures/detection.json` through the real checker and prints true positives, false positives, false negatives, precision and recall. A case lists the `RULE:status` findings it must produce (and nothing else). Supported findings are excluded from scoring.

**Honest limits:** the fixtures are **synthetic and written by the team after the rules existed**, against the fictional Fernlight guidelines. They are a regression baseline. They are **not** a measure of real-world accuracy and must never be quoted as one.

| | Round 1 baseline | Round 2 target | Round 3 target |
|---|---|---|---|
| Labelled cases | 30 cases / 24 expected findings (fixture file) | grow the set, adding cases from any real user-provided copy (with permission) | grow again; add adversarial phrasing |
| Precision / recall on the fixtures | 1.00 / 1.00 (by construction: cases were written to match; see limits) | keep ≥ 1.00 on the old cases, report new-case results *before* fixing the rules | same, plus a held-out slice nobody tuned against |

The number that matters from Round 2 onward is performance on cases written *before* looking at the rules' output.

A second synthetic corpus covers factual qualifiers and scope (`npm run eval:claims`, 98 scored cases, 11 documented known limits; see [claims-scope.md](claims-scope.md)). It has the same limits: authored with the rules, a regression baseline, not accuracy.

## 2. Stale-approval prevention

**What:** an approval must never remain valid after the content, image details or guidelines it covered change, and a decision must never be recorded on a screen the user saw out of date.

**How measured:** automated tests, counted by *mutation path*. A mutation path is one way to change something an approval is bound to. Each must have a passing test that shows the status becomes **Re-review required** (or, for a decision on a stale view, a 409 with nothing recorded).

| Mutation path | Round 1 coverage |
|---|---|
| Copy text edited (new revision) | tested |
| Image details edited (alt text, name, colours) | tested |
| Image file fingerprint changed | tested |
| Guideline version published | tested |
| Decision made after a guideline change since the page loaded | tested (409, nothing recorded) |
| Decision made after content changed since the page loaded | tested |
| Concurrent revisions from the same base | tested (one wins, rest 409) |
| Same bound inputs in authenticated mode (edit after approval, guideline change, decision on a stale view) | tested in `tests/auth.test.js` |
| Decision by the person who wrote or edited the submission (authenticated mode) | refused (403), tested |
| Campaign image replaced or removed (approval must go stale; history keeps the old bytes) | tested, API and browser |
| Approval on an image whose bytes are missing from storage | refused (409), tested |
| Cited source replaced or withdrawn (approval must go stale, approving must be blocked) | tested, including races with decisions and with inference |
| Decision made after a source activation since the page loaded | tested (409, nothing recorded) |
| Source activation or withdrawal made on an impact preview that is no longer current (source, guidelines or any campaign changed) | tested (409 `stale_preview`, nothing recorded) |

Target: **every** bound input has a test, in every round. Each new feature that adds an input to the binding must add its mutation path and test in the same change. Reported as "covered paths / known paths".

## 3. Review usability

**What:** whether a creator or reviewer can complete the workflow quickly and without confusion.

**How measured (Round 2 onward):** a scripted task run by people other than the builders, on the fictional seed data. For each task record: completed yes/no, number of actions (clicks and typed fields), elapsed time, and any point where the person said they were unsure what a status or finding meant. Tasks:

1. Find why a given submission cannot be approved.
2. Fix it from the suggestions and save a new revision.
3. Request review, then (as reviewer) approve it.
4. Find out why an approved item now says "Re-review required".

**Round 1 baseline:** none. We have not run a usability study and report no results. We can state only the action count of the happy path from the app as built, to be re-measured each round.

| | Round 1 | Round 2 target | Round 3 target |
|---|---|---|---|
| Study run with outside participants | not done | run on the four tasks, report completion and time | repeat after fixes, report change |
| Accessibility checks | keyboard focus styles, labelled controls, semantic landmarks (manual) | keyboard-only run of the four tasks; contrast check of the UI's own colours | screen-reader pass and fixes |

Only report improvements as differences between measured runs.
