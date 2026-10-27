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

`npm run eval:claims` runs `tests/fixtures/claims-scope.json` (143 scored cases plus 13 documented known limits; 98 and 11 before m25), written by the team against the fictional seed guidelines. Labels (`RULE:status` per case, the rules that may be reported supported, and the exact replacement texts allowed) were written from what a careful human would conclude. Result recorded 24 Oct 2026:

| Group | Cases | Expected non-supported findings | TP | FP | FN |
|---|---|---|---|---|---|
| clean controls | 6 | 0 | 0 | 0 | 0 |
| upper-bound wording | 11 | 6 | 6 | 0 | 0 |
| guarantee / minimum | 7 | 9 | 9 | 0 | 0 |
| operating conditions | 6 | 5 | 5 | 0 | 0 |
| competitor / other subject | 8 | 7 | 7 | 0 | 0 |
| quotation / attribution | 9 | 9 | 9 | 0 | 0 |
| negation | 2 | 2 | 2 | 0 | 0 |
| safe vs advice-only correction | 12 | 13 | 13 | 0 | 0 |
| mixed (unsupported + contradicted + supported) | 3 | 6 | 6 | 0 | 0 |
| denied directives ("Do not advertise…", "Never say…") | 13 | 13 | 13 | 0 | 0 |
| retired or disowned figures ("old… incorrect", "used to be…") | 12 | 12 | 12 | 0 | 0 |
| controls beside them (affirmative rewrite, qualified claim, near-miss wording, denial + affirmative in one text) | 11 | 6 | 6 | 0 | 0 |
| other subject, explicit (m25) | 12 | 12 | 12 | 0 | 0 |
| same subject or none named: controls (m25) | 12 | 0 | 0 | 0 | 0 |
| editing instructions and examples (m25) | 7 | 7 | 7 | 0 | 0 |
| ordinary copy with the same verbs: controls (m25) | 6 | 2 | 2 | 0 | 0 |
| unquantified endurance and its controls (m25) | 6 | 4 | 4 | 0 | 0 |
| **total** | **143** | **113** | **113** | **0** | **0** |

Also: 0 false-support or missing-support mismatches; 0 replacement-text mismatches; **13 cases offered a rewrite, each rewrite was applied and the text re-checked: none broke** (every contradiction of a rewritten fact disappeared and no new non-supported finding appeared).

Read this honestly:

- The corpus was written together with the rules, so 100 % is a **regression baseline, not accuracy**. It says the rules do what we designed them to do on our own sentences, nothing about real copy.
- Two labels were corrected after the first run because my first label was wrong about the design, not because the output was fitted: "other brands … the Aurora Lamp **runs** up to 12 hours" is reported as a different-clause caution (the word *runs* alone is not a topic word of the fact), and "competitors claim 30 hours but the Aurora Lamp lasts 30 hours" is a caution for both figures (the attribution window reaches the neighbouring clause), so no rewrite is offered. Both are the conservative outcome and both are documented behaviour.
- The distinction between *unsupported / needs review* and *contradicted* is part of the labels (for example "guaranteed 30 hours" is both an unverified claim and a contradicted figure, with no replacement).

## Subject and intent (m25)

An independent first challenge against the published build (16 predeclared, AI-authored synthetic cases; not a real-world accuracy set) found five breaches, all reproduced here before any change (`handoffs/evidence/m25-FIRST-RUN-challenge-v1-before.json`):

1. **False support, three times.** "Our phone battery lasts up to 12 hours at medium brightness.", "The museum audio guide battery lasts up to 12 hours…" and "The office printer includes a 2-year warranty." were shown as **supported** by the lamp's facts. The checks needed only a topic word ("battery", "warranty") and a matching figure in one clause; nothing tied the fact to the sentence's subject. (The competitor rule only knew a few words such as "competitor" and "other brands".)
2. **An unsafe rewrite.** "Please delete the sentence: Aurora Lamp battery lasts 30 hours." was a **contradiction** (a blocking error) with an offered automatic replacement "up to 12 hours at medium brightness", turning an instruction to delete a claim into an instruction to publish one.
3. **A coverage miss.** "Aurora Lamp keeps shining continuously from breakfast until midnight without needing a charge." produced no finding.

### The policy (two gates and a short bounded list; the subject gate was made positive in m25b)

Both gates sit in front of every verdict about a numeric or yes/no fact, for the text and for a person's confirmed image transcription alike. What they cannot place goes to **needs review** (a warning a person must acknowledge), with **advice only**: never supported, never contradicted, never rewritten.

**Intent.** A sentence that is an editing instruction ("delete / remove / rewrite / replace … the sentence / claim / line / figure …", "this line should be removed", an instruction in the sentence just before that points forward: "the next sentence", "below"), or that disowns itself as an example, placeholder, fictional, made-up or hypothetical text ("example claim", "placeholder copy", "fictional"), is not asserting the figure. The explanation says so, and the advice says to read it and carry out the instruction if that is what it is. Verbs alone do not trigger it ("Fix your sleep", "Cut the cord", "Change the way you read", "Replace your desk lamp with the Aurora Lamp" are still ordinary copy): there must be a piece of text as the object.

**Subject (positive scope, m25b).** The approved data already says what the facts are about: the naming rules (the preferred product names, their listed misspellings, and the noun a product name ends in, here "lamp") and the words of the fact itself (its label, statement, source quote, topic, unit and condition words). A sentence is read as about the approved product only when its words **say so or say nothing about any subject**; every other word in the subject position makes the subject **unknown**, and an unknown subject goes to a person. The first version of this gate (m25) looked for particular shapes (a verb from a short list, the words before the topic noun) and was bypassed by an unlisted verb ("Printers flaunt a 2-year warranty.") and by a product name inside a possessive phrase about another device ("Aurora Lamp owners' phone battery lasts…"), both found by the independent review. The rule is now:
- A word is **accounted for** when it is ordinary wording (determiners, prepositions, conjunctions, pronouns, adverbs, auxiliaries, the usual verbs that attach a figure to a subject, and ordinary descriptive, quantity and purpose words such as "new", "single", "designed"), wording about how strongly a figure is claimed (guaranteed, exactly, always, at least, up to, might…, which the guarantee, exactness, qualifier and hedge gates already judge), a word the approved fact itself uses, or part of the product's or the company's name. **Anything else is unknown, whatever part of speech it is**: an unfamiliar verb is as unknown as an unfamiliar noun.
- Which words stand for the subject: when the fact's first topic term in the clause is itself a verb ("The Aurora Lamp **lasts** …") or is followed by a verb ("a full charge **lasts** …"), the phrase it ends, back to its determiner (whatever introduced it belongs to another thought: "We tell readers a full charge lasts …"), plus a clause-initial prepositional adjunct ("On the brightest setting a full charge lasts …"). Otherwise everything before the figure ("Printers flaunt a …", "Phones flaunt battery life of …", "Phone cases for Aurora Lamp battery …"). After the figure, the phrase around a topic noun ("12 hours of phone battery") and "on / in / for / from / inside / within / aboard the …" phrases.
- **The product's name settles only the words it governs.** A stretch that names the product is about the product when nothing unknown stands between the name and the claim; only the words immediately before the name, back to its determiner, are excused as describing it ("our new reading lamp"). So the name never blesses a possessive phrase about something else: in "Aurora Lamp owners' phone battery", "Aurora Lamp Pro battery" and "The Aurora Lamp's companion phone battery", the words after the name are unknown. The company name alone does not make another product the lamp ("Fernlight phone battery" is still a phone).
Wording that names no subject at all and uses only accounted-for words ("A full charge lasts up to 12 hours", "Includes a 2-year warranty", "Enjoy up to 12 hours of battery", "Designed for indoor use only") is the **justified bare campaign statement** and is read as about the campaign's own product, as before. The price is that **an unfamiliar word anywhere in the subject position is a caution even when the sentence is about the lamp** ("Flaunt a 2-year warranty.", "The Aurora Lamp flaunts a 2-year warranty.", "Our new reading light battery lasts…"): see the limits.

**A workspace that declares no product name** (no naming rule besides the company name) has no subject to compare with: the subject gate stays off there, and the behaviour is the previous one. The intent gate does not depend on it.

**Unquantified endurance (bounded).** A sentence about a duration fact (a unit in hours, days…) that promises endurance with no figure and names the fact's topic noun ("battery", "charge"; not a topic verb such as "lasts") is needs review when its wording is on a short closed list: continuously, non-stop, round the clock, all day / night / week, day and night, days on end, forever, endless, never runs out, without needing / requiring a charge, without recharging, until / till midnight / morning / evening / night / bedtime / dawn / dusk / sunrise / sunset, from <word> until / till / to <one of those>. It is not a paraphrase detector: other ways of saying it are still missed (see the limits).

Order of the gates for a figure: negation → competitor words → **editing note** → attribution → denied or retired wording (all as before) → **subject** → the qualifier, guarantee, condition and rewrite rules (as before). The existing gates keep their explanations; the new ones apply only where those did not already send the sentence to a person.

### Intentional policy changes, and what they cost

- A claim about a different subject is **no longer a contradiction** of the lamp's fact either: "Our phone battery lasts 30 hours." used to be a blocking error with an offered rewrite to the lamp's wording, and is now needs review. Likewise "The printer is waterproof." (a lamp fact says the lamp is not).
- An editing instruction about a claim is a **warning**, not a blocking error.
- **False caution is the price.** Anything with an explicit subject word the approved data does not use now goes to a person, including sentences that are in fact about the lamp: "Our new reading light battery lasts up to 12 hours" ("light" is not the product noun here), "On the brightest setting a full charge lasts up to 12 hours" (a determiner-led phrase before the figure is read as a possible subject; it was already a documented limit and is now a caution), "Maria's lab measured a full charge at 30 hours." (correctly: not our claim). A person who reads such a finding can acknowledge it and approve; the advice says what to check.
- **m25b widens that cost on purpose.** Unfamiliar words before a yes/no phrase in the same clause now make the subject unknown too: "Warm light for indoor use only." is a caution ("warm" and "light" are not accounted for), and so is markup in front of the phrase (the dossier browser check's fixture text had to put its markup in a sentence of its own for that reason; its assertions did not change). The alternative, trusting any sentence that merely contains a product word or an unfamiliar verb, is the false green the review found.
- A rule that fires on a word needs the word: an unlisted verb after a bare subject ("Printers flaunt a 2-year warranty.") is **not** caught (a documented limit, below).

### What this does not cover (documented limits, scored separately, not promises)

Subjects given in another language or in a phrase far from the figure; "…, courtesy of the phone" after the figure (no determiner phrase of the listed kind); a product named only by a word the approved data does not use; endurance wording outside the closed list ("keeps going and going"); an instruction written in another language or an unusual form; any sentence where the subject is implied by an earlier sentence. The corpus lists four new limits (`tests/fixtures/claims-scope.json`, `known-limit`), including one over-caution.

**Residual after m25b (each is a case in the corpus, `known-limit`):** a subject in an earlier clause of the same sentence ("The phone, like the Aurora Lamp, lasts up to 12 hours…": the clause that carries the figure names no subject); a matrix subject before the claim's own phrase ("Phones tell readers a full charge lasts…": what introduces the phrase is read as another thought); **spelled-out numbers** ("A two-year warranty comes with every scanner." produces no finding: the figure parser reads digits only, so the sentence is never compared; a pre-existing limit, not a tiny safe fix because the unit is hyphenated and the subject follows the figure); and the **false cautions** that positive scope buys: an unfamiliar opening verb ("Flaunt a 2-year warranty.") and an unfamiliar verb after the product's name ("The Aurora Lamp flaunts a 2-year warranty.") are cautions, where a person reads and acknowledges them.

### If this is not enough: explicit scope on the fact (proposal, not built)

The smallest compatible extension is an optional per-fact list of subjects ("scope": ["Aurora Lamp", "lamp"]) in the guideline library, validated like the other optional fact fields. A fact without it keeps the behaviour above (the vocabulary derived from the naming rules and the fact's own words), so every existing guideline set stays valid and nothing is rewritten. It would let a library name exactly what a fact covers (and stop the brand-name or descriptive-word cases above) without any change to the checker's shape. Not implemented: it needs a library editor field, a migration note and its own tests.

### Evidence

- Reproduction of the first challenge before the change and after: `handoffs/evidence/m25-FIRST-RUN-challenge-v1-before.json` (5 breaches: 3 false support, 1 unsafe rewrite, 1 coverage miss) and `m25-run7-challenge-v1.json` (0). **Fixes made against that table are not evidence of generalisation**; a separately authored post-fix challenge is the next step.
- `tests/claims-applicability.test.js` (15 tests): the 16 predeclared cases as a table with their breach rules, the subject and intent cases above with positive controls, mixed sentences, the seeded campaigns, the legacy fallback, the transcription path, order independence, the endurance list, and the effect through the API (no blocking error, a warning that must be acknowledged, the person can still decide).
- The synthetic claims corpus grew from 109 to 156 cases (143 scored; 13 known limits): `m25-run10-eval-claims.txt`. Written by the implementer alongside the fix: a regression baseline over our own sentences, not accuracy.

## Known limits (13 documented cases, not scored)

These still behave as listed (`npm run eval:claims` prints them as "not handled"):

- Number words and paraphrases: "thirty hours", "a day and a half" are not read as figures.
- Condition wording outside the recorded words: "in power-saving mode" ("on the brightest setting" is now a caution through the subject gate, m25) (only the recorded `conditionTerms` signal a condition; "brightest" is not "brightness").
- Attribution without one of the listed verbs ("Maria's lab measured … 30 hours" is now a caution through the subject gate, m25), or further than three clauses before or one after the figure.
- A guarantee or "always" in a different clause than the figure ("up to 12 hours, always") does not change a within-limit "up to" figure (it does block an automatic rewrite).
- Conservative false cautions are expected: any mention of a condition word without the approved wording in the same sentence, a word such as "reviewers" or "others" in the figure's own clause, and plain figures at or below the limit all go to review rather than green.
- Denied and retired wording is a bounded list (see above): unlisted phrasings are missed (3 recorded cases) and some innocent sentences are over-cautioned (2 recorded cases).
- Subject detection is a short word list (competitor, rival, other brands/lamps/products, their, others). It cannot tell whose product a pronoun-free sentence is about. From m25 an explicit subject the approved data does not know is also caught; see "Subject and intent" above for what that does and does not cover.

## Tests

`tests/claims-scope.test.js` (17 tests; the last 7 are the denied/retired patch: the two held-out sentences with quotes and spans, 15 further denied or retired shapes including capitalisation, curly apostrophes and spacing, other facts, a denied approved figure not shown green, controls unchanged, a mixed text that rewrites only the affirmative sentence with a stable second pass, the API path, and the documented limit): the corpus matches its labels; each of the four reproduced gaps with quotes and spans; replacement withheld for eight risky wordings; "up to 12 does not establish a guaranteed 10"; legacy facts (no conditions) give advice only and hash-stable keys; exact facts with subject and attribution; conditions validate (422 on a wrong type), persist through the guideline API and change the offered replacement text. Each mechanism was removed in turn (plain figure supported, guarantee ignored, subject ignored, attribution ignored, condition ignored, rewrite always safe, condition dropped from rewrite): the suite failed every time. For the denied/retired gate: removing the whole gate, the directive part, the retired part, or turning it into a rewrite fails 5 to 6 tests each; making the directive need no verb fails 3; widening the 60-character window fails 1.

Browser: `npm run ui-smoke-claims` (11 checks) shows the caution without an Apply button, the safe correction, a competitor sentence, a human rewrite clearing the caution, the saved revision and the library showing the approved condition. Screenshots: `docs/evidence/claims-1-caution-and-safe-fix.png`, `claims-1b-caution-advice-only.png`, `claims-2-competitor.png`, `claims-3-human-rewrite.png`, `claims-4-library-condition.png`.
