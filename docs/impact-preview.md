# Source change-impact preview

Before a manager activates a pending source version, or withdraws an active source, BrandProof can show what the change would do. The preview is **read-only**, calculated on the saved (committed) data, and never approves, relinks, rewrites copy or notifies anyone.

This is one focused slice of the evidence lifecycle (source passage → fact → campaign → accountable decision → changed evidence → preview → repair → new decision). It is not a claim that other tools lack something similar: we compared nothing and make no uniqueness claim.

## What it shows (three different things, never mixed)

| Category | Question it answers | Where it comes from |
|---|---|---|
| **Exact dependencies** | Which rules and facts of the *current published guidelines* cite this source, and does each cited quote survive in the proposed text? | the evidence links (`sourceId`, `version`, `start`, `end`) and the registry text |
| **Campaign finding references** | Which campaigns have a *current-revision finding* that cites one of those rules? (any status, including "supported") | the same checks the workspace runs, on each campaign's latest revision |
| **Workflow consequences (whole binding)** | What happens to each campaign's approval or review? | the engine's own workflow derivation, run against the *current* and the *proposed* evidence set |

**The third category is deliberately not "selective".** An approval is bound to the whole guideline and evidence set. When the evidence changes, every approved campaign becomes *Re-review required*, including campaigns with no finding that cites this source. The preview counts them that way (the Care-tips campaign in the browser walkthrough has no citing finding and is still counted). If no rule cites the source, the evidence hash does not change, and the preview says no approval is affected.

Counts are real ones from saved data, in exclusive buckets: approved campaigns that become stale; campaigns already needing re-review; campaigns in review whose viewed binding changes (and how many stay blocked from approval until a repair); drafts or rejected campaigns with a finding that cites a dependent rule; everything else is unaffected. There is no risk score, no time saved and no accuracy figure.

## Exact continuity of each cited quote

Compared against the proposed version's text (activation only), conservatively:

| Result | Meaning |
|---|---|
| **Same words, same place** | The quote is at the same offsets. If the words also occur elsewhere that is shown, not hidden. |
| **Same words, one other place** | Exactly one occurrence elsewhere; its position and text are shown. |
| **Same words, several places** | More than one occurrence and none at the old offsets. No position is chosen. |
| **These words are gone** | No occurrence. The preview does **not** say the rule is now wrong. |
| **Too short to match** | Blank or under 3 non-space characters. Never auto-matched. |
| **Evidence withdrawn** | Withdrawal preview: the rule stops having registered evidence. |

Text equality is not equality of meaning, and a preview never relinks anything. **Even an unchanged quote still needs a new link to the new version** under the existing policy: its state after activation is "Replaced" until a manager relinks and publishes. The page also lists which whole lines were removed and added (exact lines, each openable highlighted in the right version).

## Not covered (stated in the preview itself)

- Typed **legacy** rules are not linked to any registered document; the preview cannot say whether they rest on this one. Zero registered dependencies is not "safe".
- Only the **current published** guidelines are examined, not an unpublished draft in the library.
- Findings are those on each campaign's **current** revision today; the list is not a prediction.
- Policies (palette, claims words, thresholds) cannot cite registered sources in this slice.

## Binding the write to what was read

The preview carries a **digest** over: the action, the source and candidate version digests, the active version, the guideline version and hash, the current and proposed evidence hashes, and a fingerprint of every campaign (head revision, content/image hash, last review/decision event). The approve and withdraw routes accept an optional `previewDigest`; **when present the server recomputes the preview inside the same serialised write and refuses with `409 stale_preview` if anything moved**, recording nothing. Any of these makes a preview stale: another version activated, guidelines published, a campaign revised, sent for review or decided, a campaign created. Comments do not.

- The browser **always** sends the digest (the approve and withdraw dialogs load the preview themselves, require the read-confirmation box, and on a stale answer clear the box, reload the preview and say so).
- The field is **optional on the API** so existing callers and tests keep working. A caller that omits it still gets every earlier check (`expectedSha256` for the exact text, `expectedActiveVersion` for withdrawals, role, registrant-cannot-approve, not-pending). That means preview protection is enforced for the UI and for any caller that supplies a digest, not for callers that choose not to. A digest from a different change (for example a withdrawal preview used for an activation) is refused.
- Versions need not activate in order: previewing an *older* pending version while a newer one is in force is labelled "a step back".

## Who may use it

`GET /api/sources/:id/impact?action=activate&version=N` or `?action=withdraw`. **Managers only** (it reveals campaign and approval detail). In demo mode that is the Manager role (a demo switch, not security). In authenticated mode it needs a session whose server-side role is manager; the demo header is ignored and a forged header does not help. The preview also tells the viewer, from their real identity, whether the registrant-cannot-approve rule would stop them (the digest itself does not depend on the viewer).

## Cost and bounds

A preview evaluates every campaign's latest revision twice, synchronously, on the committed snapshot (a few milliseconds for this prototype's data; it grows linearly with campaigns). The workflow list is capped at 200 rows, lines at 12 per side (truncation is stated), quotes at 500 characters, occurrence counting at 50.

## Measured (synthetic fictional data, 24 Oct 2026)

`tests/impact.test.js`, 15 tests: continuity classes (unit and API: unchanged, repeated, moved, ambiguous, absent, too short, overlapping repeats); **no writes** (file bytes and mtime, committed state, guideline version count, source events); campaign buckets with the **predicted statuses compared with the statuses read from the real submission list after the real activation**; a source no rule cites changes nothing; withdrawal preview and real withdrawal; request validation (action, version, not pending, rejected, unknown source, non-monotonic activation); five kinds of change × activation and withdrawal each make an old digest return 409 with nothing recorded and a fresh digest succeed; optional/validated/foreign digest; two managers racing from the same baseline (exactly one wins, loser told `stale_preview`); previews during an in-flight write each describe one consistent state; demo and authenticated permissions including forged headers, CSRF and Origin on the digest-carrying write, and the registrant gate; the full preview → activate → stale → repair → distinct-reviewer flow. Each control was removed in turn (digest ignoring campaigns, continuity shortcuts, short quotes matched, selective staleness, whole-binding ignored, candidate state unchecked, digest ignored on either write, preview open to every role): the suite failed every time (one removal, of the guideline *hash* alone, is equivalent because the version number is also in the digest; removing both fails).

Browser, `npm run ui-smoke-impact` (authenticated mode, synthetic accounts, fictional fact sheet), 25 of 25: creator sees the button disabled and the server refuses creator and reviewer; the manager's preview shows 2 approved campaigns, 1 in review (blocked until 3 rule links are repaired), 1 draft, three citations (two same-place, one gone), verbatim old and new lines, and states nothing was saved; file bytes and source events are unchanged after the preview; a campaign created after the preview was read makes the approval refuse as out of date, the preview reloads with a warning and the box is cleared; approving on the fresh preview works; the real statuses match the prediction; the repair (publish with the changed fact and new links) makes the old copy a real blocking contradiction (12 vs 8 hours); the creator revises and a different person approves; at 420 px nothing scrolls horizontally and focus stays in the dialog, Escape closes it. Screenshots: `docs/evidence/impact-1-preview-top.png` … `impact-6-narrow.png`.

Fictional showcase data (`demo-data`, read on a throwaway copy): previewing SRC-1 version 2 reports three unchanged citations, SUB-4 becoming Re-review required, two already needing re-review, SUB-3 in review blocked, two drafts citing dependent rules.

## Limits

- Exact text only; no paraphrase or meaning detection.
- A single process and file: the digest protects against races inside this server, not against another program editing the data file.
- The preview does not repair: relinking and publishing stay manual actions with their existing checks, and a distinct reviewer still decides again.
- The digest is conservative: any campaign revision or review event anywhere makes an open preview stale, even if unrelated to the source.
