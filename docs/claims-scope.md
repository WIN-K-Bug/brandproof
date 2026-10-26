# Factual qualifiers, scope and safe corrections

What the numeric-fact checks do and do not conclude, why they are stricter than the first baseline, and what was measured. Everything here is deterministic text rules over the fictional Fernlight guidelines. **There is no semantic understanding, no general NLP coverage and no real-world accuracy claim.**

## The problem that was reproduced

The first baseline reduced "A full charge lasts up to 12 hours at medium brightness." to a number and a direction, so:

1. "A full charge always lasts exactly 12 hours at maximum brightness." was shown as **supported**.
2. "A full charge is guaranteed to last 12 hours." got a **supported** figure.
3. A 30-hour mismatch was auto-replaced with "12 hours", silently dropping "up to" and "at medium brightness".
4. "Our competitor battery lasts 30 hours; the Aurora Lamp lasts up to 12 hours." had the competitor's figure corrected with our fact.

Each was an over-confident answer: green support, or a destructive rewrite, where the wording had not been shown to match.

## Policy now

An approved "up to N" fact entitles a sentence to say "up to N" (or "up to" a smaller figure) about **our product** under **the approved conditions**. It does not establish that the product lasts N, always lasts N, is guaranteed to last N, or lasts N under other conditions.

| Wording about a fact with `claimRule: at-most` | Result |
|---|---|
| "up to 12" / "up to 10" (no guarantee/exact word, no conflicting condition) | **supported** (if the approved condition is not stated, the explanation says so) |
| plain, "about", "exactly", "always", "every time" with a figure at or below the limit | **needs_review** (explains that "up to" does not entail it) |
| "guaranteed", "promise", "ensure", "assured", "at least", "minimum" | **needs_review** |
| a condition word of the fact (for example *brightness*) without the approved condition wording | **needs_review** |
| competitor / rival / other brands / "their" in the clause | **needs_review**, nothing rewritten |
| quoted or attributed ("says", "according to", "reviewers", inside quotation marks) in the clause, up to three clauses before or one after | **needs_review**, nothing rewritten |
| negation | **needs_review** (unchanged from the first baseline) |
| a figure above the limit ("30 hours", "up to 30", "over 12") | **contradicted** whatever the wording; the rewrite rules below decide whether a replacement is offered |

Exact facts (`claimRule: exact`, such as warranty or recycled content): equal → supported, different → contradicted with a replacement; the subject, attribution and negation rules above apply to them too.

**Honest note on a policy change.** "Battery lasts 8 hours" used to be *supported* because 8 ≤ 12. It is now **needs_review**: "up to 12" does not establish a typical or guaranteed 8, and a reviewer should decide. This is deliberately stricter and three existing assertions were changed to say so (`tests/checks.test.js`: the 8-hours case, the "about 12 hours" case and the replacement text). No protection was weakened: every contradiction and every other review case from before is still produced.

Needs-review findings keep their existing meaning: a warning that must be acknowledged, never a finding that the copy is wrong, and never counted as contradicted. "Source relevance" is separate: the optional local matcher still only ranks topical relevance.

## Denied and retired claims are never rewritten (held-out safety patch)

An independent held-out challenge found that an automatic numeric replacement could **reverse** a sentence that is not making the claim at all: "Do not advertise that the battery lasts 30 hours." became "Do not advertise that the battery lasts up to 12 hours at medium brightness" (the opposite instruction), and "The old battery specification of 30 hours was incorrect." was rewritten to the approved value. The rule is now bounded and conservative: **a figure inside a denied or retired claim goes to a person (`needs_review`, advice only) and is never rewritten, and is never shown as supported either**, whether the figure is the wrong one or the approved one.

Two bounded checks (word lists, not understanding):

- **Denied directive:** a negative lead (do/does/must/should not, don't, never, cannot, may not, avoid…, stop…, refrain…, no longer, not to, forbidden, banned, not allowed to) followed within 60 characters, in the figure's clause or the one before it, by a claim verb (advertise, claim, say, state, promise, market, publish, mention, use, quote, list, show, tell, offer…).
- **Retired figure:** the sentence contains a word that disowns it (incorrect, wrong, mistaken, erroneous, inaccurate, typo, error, untrue, false, outdated, out of date, obsolete, superseded, retire(d), deprecated, discontinued, withdrawn, scrap(ped), drop(ped), overstated, exaggerated, misleading, old/older, former(ly), previous(ly), no longer, used to).

Other behaviour is unchanged: an affirmative mismatch is still rewritten when it is safe, the qualified approved claim is still supported, and near-miss wording ("Never worry: …", "We do not compromise on quality: …", "We never stop improving: …", "Don't miss out: …") is not caught. In a text that holds both, applying every offered correction changes only the affirmative sentence (tested, including a stable second pass).

Honest costs of a word list: it **over-cautions** (it is sentence-wide for retired words, so "the old 30 hours figure was wrong" also sends a "12 hours" in the same sentence to review; "We do not say much, but … up to 12 hours" and "Like an old friend, …" are false cautions, recorded as known limits) and it **misses** unlisted phrasings ("We have moved on from the 30 hours battery number", "belongs to the past", "was never true", other languages, an implied denial). Those are still judged as ordinary claims and may still get a rewrite. Terminology rewrites (for example a banned word with a replacement) are **not** covered by this gate: "Do not call the lamp cheap" can still be offered a replacement of the quoted word. No claim of general language understanding is made.

## Automatic replacement only when meaning is preserved

`Apply to draft` is offered only when **all** hold: the fact records its approved `conditions` (or is an exact fact), the figure is above the limit, there is no guarantee/exact word **anywhere in the sentence**, no conflicting condition anywhere in the sentence, no subject/attribution marker, the qualifier is plain or "up to", and what follows the figure is empty, the approved condition itself, or a short (≤ 5 words, no digits) neutral tail.

- "A full charge lasts 30 hours." → `up to 12 hours at medium brightness`
- "A full charge lasts up to 30 hours." → `12 hours at medium brightness`
- "A full charge lasts 30 hours at medium brightness." → `up to 12 hours`

Otherwise the finding carries advice that quotes the approved statement and says a person must rewrite it. A fact **without recorded conditions** (every guideline set saved before this milestone) never gets an automatic rewrite of an "up to" figure.

## New optional fact fields (additive)

On a numeric fact: `conditions` (approved operating-condition phrases, for example `["at medium brightness"]`) and `conditionTerms` (words that signal a condition, for example `["brightness"]`). Both are editable in the Brand library fact dialog. When absent the keys are **omitted from the stored object**, so the content hash of every earlier guideline version is unchanged (verified by test); when present they are part of the guideline and any change creates a new version like any other. The seed battery fact records them; the showcase demo data (created earlier) does not, so its story is unchanged and its battery corrections are advice only.

## Measured on the synthetic corpus

`npm run eval:claims` runs `tests/fixtures/claims-scope.json` (98 scored cases plus 11 documented known limits), written by the team against the fictional seed guidelines. Labels (`RULE:status` per case, the rules that may be reported supported, and the exact replacement texts allowed) were written from what a careful human would conclude. Result recorded 24 Oct 2026:

| Group | Cases | Expected non-supported findings | TP | FP | FN |
|---|---|---|---|---|---|
| clean controls | 6 | 0 | 0 | 0 | 0 |
| upper-bound wording | 11 | 6 | 6 | 0 | 0 |
| guarantee / minimum | 7 | 9 | 9 | 0 | 0 |
| operating conditions | 5 | 4 | 4 | 0 | 0 |
| competitor / other subject | 8 | 7 | 7 | 0 | 0 |
| quotation / attribution | 8 | 8 | 8 | 0 | 0 |
| negation | 2 | 2 | 2 | 0 | 0 |
| safe vs advice-only correction | 12 | 13 | 13 | 0 | 0 |
| mixed (unsupported + contradicted + supported) | 3 | 6 | 6 | 0 | 0 |
| denied directives ("Do not advertise…", "Never say…") | 13 | 13 | 13 | 0 | 0 |
| retired or disowned figures ("old… incorrect", "used to be…") | 12 | 12 | 12 | 0 | 0 |
| controls beside them (affirmative rewrite, qualified claim, near-miss wording, denial + affirmative in one text) | 11 | 6 | 6 | 0 | 0 |
| **total** | **98** | **86** | **86** | **0** | **0** |

Also: 0 false-support or missing-support mismatches; 0 replacement-text mismatches; **13 cases offered a rewrite, each rewrite was applied and the text re-checked: none broke** (every contradiction of a rewritten fact disappeared and no new non-supported finding appeared).

Read this honestly:

- The corpus was written together with the rules, so 100 % is a **regression baseline, not accuracy**. It says the rules do what we designed them to do on our own sentences, nothing about real copy.
- Two labels were corrected after the first run because my first label was wrong about the design, not because the output was fitted: "other brands … the Aurora Lamp **runs** up to 12 hours" is reported as a different-clause caution (the word *runs* alone is not a topic word of the fact), and "competitors claim 30 hours but the Aurora Lamp lasts 30 hours" is a caution for both figures (the attribution window reaches the neighbouring clause), so no rewrite is offered. Both are the conservative outcome and both are documented behaviour.
- The distinction between *unsupported / needs review* and *contradicted* is part of the labels (for example "guaranteed 30 hours" is both an unverified claim and a contradicted figure, with no replacement).

## Known limits (11 documented cases, not scored)

These still behave as listed (`npm run eval:claims` prints them as "not handled"):

- Number words and paraphrases: "thirty hours", "a day and a half" are not read as figures.
- Condition wording outside the recorded words: "on the brightest setting", "in power-saving mode" (only the recorded `conditionTerms` signal a condition; "brightest" is not "brightness").
- Attribution without one of the listed verbs ("Maria's lab measured … 30 hours"), or further than three clauses before or one after the figure.
- A guarantee or "always" in a different clause than the figure ("up to 12 hours, always") does not change a within-limit "up to" figure (it does block an automatic rewrite).
- Conservative false cautions are expected: any mention of a condition word without the approved wording in the same sentence, a word such as "reviewers" or "others" in the figure's own clause, and plain figures at or below the limit all go to review rather than green.
- Denied and retired wording is a bounded list (see above): unlisted phrasings are missed (3 recorded cases) and some innocent sentences are over-cautioned (2 recorded cases).
- Subject detection is a short word list (competitor, rival, other brands/lamps/products, their, others). It cannot tell whose product a pronoun-free sentence is about.

## Tests

`tests/claims-scope.test.js` (17 tests; the last 7 are the denied/retired patch: the two held-out sentences with quotes and spans, 15 further denied or retired shapes including capitalisation, curly apostrophes and spacing, other facts, a denied approved figure not shown green, controls unchanged, a mixed text that rewrites only the affirmative sentence with a stable second pass, the API path, and the documented limit): the corpus matches its labels; each of the four reproduced gaps with quotes and spans; replacement withheld for eight risky wordings; "up to 12 does not establish a guaranteed 10"; legacy facts (no conditions) give advice only and hash-stable keys; exact facts with subject and attribution; conditions validate (422 on a wrong type), persist through the guideline API and change the offered replacement text. Each mechanism was removed in turn (plain figure supported, guarantee ignored, subject ignored, attribution ignored, condition ignored, rewrite always safe, condition dropped from rewrite): the suite failed every time. For the denied/retired gate: removing the whole gate, the directive part, the retired part, or turning it into a rewrite fails 5 to 6 tests each; making the directive need no verb fails 3; widening the 60-character window fails 1.

Browser: `npm run ui-smoke-claims` (11 checks) shows the caution without an Apply button, the safe correction, a competitor sentence, a human rewrite clearing the caution, the saved revision and the library showing the approved condition. Screenshots: `docs/evidence/claims-1-caution-and-safe-fix.png`, `claims-1b-caution-advice-only.png`, `claims-2-competitor.png`, `claims-3-human-rewrite.png`, `claims-4-library-condition.png`.
