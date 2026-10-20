# Multilingual quality: offline candidates and review protocol

Prepared **2026-10-20 UTC**. **Linguistic quality is not yet measured.**

This is a reusable preparation set, not a live evaluation runner. All sentences,
glosses, lemma suggestions and meaning labels are **AI-authored synthetic drafts,
unreviewed by independent linguists or bilingual humans, and not ground truth**.
They contain no personal data. No provider request, credential read or paid test
was performed for this suite. Passing its tests does not establish fluency,
translation accuracy, pronunciation quality or learning effectiveness.

## Files and current evidence

- `tests/fixtures/multilingual-quality-candidates.json`: **53 v2 candidate
  inputs**—38 source probes plus 15 reverse-target probes—with tentative meaning
  notes, example-review prompts and locale cautions.
- `tests/quality/fixture-structure.test.ts`: offline structure, coverage,
  production-input compatibility and original-selection checks. It imports local
  contracts, not provider adapters. A Fetch tripwire fails accidental Fetch use;
  this is not an OS-level network sandbox.
- This document: review rubric, interpretation limits and a gated future plan.

Run only the installed local commands from the repository root; neither command
installs packages or invokes a paid service:

```sh
node node_modules/vitest/vitest.mjs run tests/quality/fixture-structure.test.ts --environment node
node node_modules/typescript/bin/tsc --noEmit
```

Observed on 2026-10-20: **1 targeted test file / 70 tests passed**; repository
TypeScript checking passed. The 53 candidate inputs passed the production lookup
validator. These are **integrity results, not 70 translation judgments, 53 correct
translations, or a percentage accuracy result**. No model responses exist in this
set. Keep it separate from the English reference set in
[`MODEL_VALIDATION.md`](./MODEL_VALIDATION.md); do not combine their denominators.

| Evidence | Status | What remains unknown |
|---|---|---|
| Registry, schema and pair coverage | Passed offline | Actual language understanding |
| Exact original UTF-16 / grapheme ranges | Passed offline | Correct linguistic boundaries in every real document |
| Input compatibility with local contracts | Passed offline | Live model/project availability and provider acceptance |
| Source sentences and tentative meaning hints | AI-authored, unreviewed | Naturalness and label correctness |
| Bilingual review and adjudication | Not run | All semantic judgments |
| Generated examples and requested-level suitability | Not run | Faithfulness, variety and useful difficulty |
| Pronunciation / audio listening review | Not run | Sounds, stress, tones, accent and intelligibility |
| Actual live usage, cost and latency | Not measured | No provider calls to measure |
| Learning benefit | Not measured | Retention, transfer and learner outcomes |

## Candidate coverage and conventions

The original **38 source probes** retain two or three cases per source language:

| Source | Source-probe cases | Default cross-language target | Additional same-language case |
|---|---:|---|---|
| en | 3 | ru | en: ambiguous *bat* |
| ru | 2 | en | — |
| es | 2 | ru | — |
| fr | 3 | ru | fr: negated idiom |
| de | 2 | ru | — |
| it | 2 | ru | — |
| pt | 2 | ru | — |
| zh | 2 | ru | — |
| ja | 3 | ru | ja: social-connections idiom |
| ko | 2 | ru | — |
| ar | 3 | ru | ar: diacritized book |
| hi | 2 | ru | — |
| tr | 2 | ru | — |
| uk | 2 | ru | — |
| pl | 2 | ru | — |
| nl | 2 | ru | — |
| kk | 2 | ru | — |

The **15 reverse-target probes** add one Russian-source case for each supported
target other than Russian and English. Russian therefore has **17 source cases
in total**: the original two ru→en cases and these 15 additional cases.

| Target | Case ID | Selected Russian expression |
|---|---|---|
| es | `ru-to-es-bench` | скамейку |
| fr | `ru-to-fr-not-finished` | не закончила |
| de | `ru-to-de-poison` | Яд |
| it | `ru-to-it-hotel-room` | номер |
| pt | `ru-to-pt-bookshop` | книжном магазине |
| zh | `ru-to-zh-financial-bank` | Банк |
| ja | `ru-to-ja-bridge` | Мост |
| ko | `ru-to-ko-chestnuts` | каштаны |
| ar | `ru-to-ar-not-written` | не написал |
| hi | `ru-to-hi-yesterday` | Вчера |
| tr | `ru-to-tr-hundred` | сто |
| uk | `ru-to-uk-sunday` | воскресенье |
| pl | `ru-to-pl-shop` | магазин |
| nl | `ru-to-nl-sofa` | диване |
| kk | `ru-to-kk-bought` | купил |

This is **36 directed pairs**: both directions between Russian and each of the
16 other languages, plus the four original same-language pairs. It is not a
289-pair semantic benchmark. One reverse case per target merely prepares a
future script/grammar check; no target output has been generated or judged.

Tags overlap: polysemy, inflection, idioms, negation, false friends, CJK scripts,
RTL, graphemes, decomposed Unicode, astral prefixes, repeated selections,
same-language paraphrase, ambiguity and pronunciation-sensitive words. New tags
identify reverse targets, intended target-script checks, level-review cautions
and omitted subjects; these are **review topics, not passed linguistic tests**. A
false-friend comparison may involve English or Russian; the case hint states the
particular confusion, not a universal relationship between two languages.

- `targetStart` and `targetEnd` index the **original source sentence**, not the
  target-language translation. They are zero-based UTF-16 code-unit offsets with
  an exclusive end. Do not normalize text before slicing. The French cafe case
  deliberately uses `e` plus a combining acute accent; emoji prefixes require two
  code units. Repeated-word cases deliberately select a later occurrence.
- `input.expression` must equal that exact slice, with complete graphemes. The
  lemma may have a different spelling/form without changing the original input.
- `expectedMeaningHints` is a reviewer aid, not an executable answer key.
  Where supplied, `targetGlossCandidates` is nonexhaustive and must not be exact-string scored.
  Inflected equivalents, synonyms and natural phrasing may be valid. Conversely,
  matching one candidate string does not make the whole answer correct.
- V2 distinguishes `coverageRole="source_probe"` and
  `coverageRole="reverse_target_probe"`. The 15 reverse probes deliberately have
  **empty `targetGlossCandidates` arrays**: their English meaning notes are not
  target-language answers. A bilingual reviewer must assess actual target
  output, including grammar, script, naturalness and regional conventions.
  Russian-input range tests do not test how an Arabic or CJK answer is rendered.
- Some selected tokens exclude a nearby negative marker. A lexical equivalent
  may therefore be positive while the **sentence interpretation must remain
  negative**. Distinguish the selected token's meaning from the whole clause's
  polarity, tense and modality. Some idioms have negative wording but express
  positive eagerness, such as Italian `Non vedo l'ora`.
- Alternative hints for *bat* represent separate possible senses, not synonyms
  to collapse into one sense. Reviewer cautions explicitly flag less decisive
  contexts, such as the Polish keys and German park bench.
- Requested levels are **A2 (40), B1 (6), B2 (7)**. This small set neither covers
  all CEFR levels nor certifies the source sentences at those levels. It is not
  representative of the entire 17 × 17 language-pair space or regional varieties.
- The A2 English *bat* hints now avoid specialist words such as “mammal” and
  “implement,” while retaining both plausible senses. Their level is still
  unvalidated. The Arabic book paraphrase `مؤلَّف للقراءة` is explicitly flagged
  as possibly too advanced for A2 and needs a simpler natural MSA review.
- The Japanese bridge/eating and Korean chestnut/going contexts omit the subject.
  Do not silently invent person, gender or number in Russian renderings. Slash
  alternatives in draft hints illustrate uncertainty, not mandatory wording or
  proof of a singular subject. The Kazakh availability idiom and proposed
  citation form specifically need a native-speaker check; none is claimed.
- `ar-SA` is the registry voice/pronunciation locale; the text convention is MSA,
  **not a Saudi-dialect quality claim**. `zh-CN` here means simplified written
  Standard Mandarin, not every Chinese variety. Brazilian Portuguese, Cyrillic
  Kazakh and every other requested locale still require competent review.

## Human bilingual review before any accuracy claim

Use a reviewer competent in **both the specific source and target languages**;
same-language cases need a competent source-language reviewer. One person's
review of one pair does not validate the other 16 sources. AI author self-checks
and structural test runs are not independent human review.

1. Review the original sentence, selected range and context first, preferably
   before reading the tentative hints to reduce anchoring. Decide whether the
   sentence is natural, the selection is meaningful and context is sufficient.
2. Correct or reject weak source sentences and labels. Record the exact case ID,
   reason, revised interpretation and reviewer scope. Preserve AI authorship;
   never relabel the original fixture as human-authored.
3. Freeze a reviewed dataset version/hash and an agreed scoring protocol **before
   seeing model outputs**. Keep review records separately under an approved
   destination. This v2 file deliberately enforces its unreviewed status; a
   reviewed derivative needs explicit versioning and updated validation.
4. Have a second qualified reviewer adjudicate disagreement where feasible. If
   expertise is unavailable, mark that pair **not reviewed** rather than letting
   another model's agreement stand in for human evidence.
5. On any later approved model output, assess source and target semantics
   directly; use the hint only as a revisable aid. Record rationale for errors
   and uncertainty without demanding one exact translation or model sense ID.

### Rubric for lookup and examples

Score each dimension **2 = acceptable**, **1 = minor/revisable issue**,
**0 = materially wrong**. Also allow **not reviewed**, **not applicable** and
**blocked/no output**, which are reported separately, never silently converted
to correct results. Decide the release criteria before running the evaluation.

| Dimension | What an acceptable result establishes | Material problems to flag |
|---|---|---|
| Source contextual meaning | Correct selected occurrence, lexical sense, inflection and clause scope | Wrong sense, mistranslated negation/tense/modality, literalized idiom, confused repeated word |
| Target semantic accuracy | Natural equivalents in the requested target language for one sense | Wrong language, false friend, omitted core meaning, unrelated senses merged together |
| Source-language explanation | Understandable definition in the source language without changing meaning | English-only fallback for other sources, misleading simplification, circular explanation |
| Recommendation and ambiguity | Recommended sense fits the context; materially unresolved alternatives remain separate with no forced recommendation | Correct translation buried under a wrong selected sense, invented certainty, collapsed alternatives |
| Lemma / morphology | Useful citation form distinguished from the original inflected selection | Rewriting the source, wrong lemma or grammatical analysis that misleads learning |
| Selected-sense consistency | Lookup, explicitly selected sense, every example and card meaning agree; examples retain the vocabulary lexeme or a valid inflection | Examples switch senses or merely describe a related situation without using the selected vocabulary |
| Example faithfulness | Natural source examples plus faithful target renderings of meaning, polarity, modality and participants | Hallucinated context, incorrect agreement, mismatched translation, falsely claimed quotation/provenance |
| Example variety | Meaningful variation in situation and syntax without changing the selected sense | Near-duplicate sentences, only swapping a name, irrelevant complexity |
| Rough level suitability | Wording and explanation plausibly suit the requested learner while preserving meaning | Removing a difficult but essential distinction, misleading “CEFR-certified” labeling |
| Same-language usefulness | Clear, faithful paraphrase rather than invented cross-language translation | Merely copying the phrase, changing its sense, unexplained circular synonyms |

For examples, review each returned example individually and the group as a
whole. The current contract permits one to three examples; note the actual
count. A single example cannot demonstrate within-set variety. Additional
examples are an explicit action, not an assumed free part of lookup. Fix and
freeze the selected sense before testing enrichment so a lookup error is not
confounded with an example-generation error. Do not count a syntactically valid
JSON response as an acceptable linguistic result.

Pronunciation is a **separate assessment**: generated IPA is approximate, not
dictionary-verified. Locale labels, successful playback and plausible IPA
characters do not prove correct vowels, stress, tones, pitch accent or a chosen
heteronym reading. Arabic vowel marks and Mandarin/Japanese readings merit
qualified checking. Local voice availability is device-dependent. Cloud audio,
if separately authorized, requires listening review by a competent speaker and
its own usage record; no audio test is included here.

Good example scores alone do not demonstrate effective learning. That requires
a separately agreed learner study (for example delayed recall and transfer to
new contexts), with its own consent, design and measures. No such study or
retention result is asserted by this suite.

## Gated plan for a later authorized live evaluation — not implemented

There is **no API runner, key discovery, environment-secret access, endpoint or
automatic paid-test switch** in these files. This plan does not authorize or
start a live request. A future run requires an **explicitly approved total budget
and safe key setup for the particular evaluation**. Other documentation does not
establish that approval here. This task did not inspect credentials or verify
live-test authorization.

Before any execution, the evaluator must establish all of the following:

1. Safely supplied credentials, current model availability and current dated
   tariffs verified through approved means; no key pasted into fixtures, logs or
   commands. Preserve the explicitly configured models unless a change is
   separately agreed. Existing lifecycle risks are tracked in the model document.
2. A frozen, reviewed shortlist and explicit operations: lookup only first; a
   separately bounded enrichment subset after a reviewer fixes the selected
   senses; audio only if separately in scope. The 53 cases are not an instruction
   to send 53 lookups plus 53 enrichment requests. Start with a minimal schema
   smoke case, then seek approval for any expanded coverage.
3. A conservative cost bound within the explicitly approved evaluation budget.
   Reserve the maximum allowed output and every permitted retry **before** each
   request, using verified rates and conservative input bounds. Stop before a
   request that cannot fit the remaining approved amount. Do not invent a price
   or assume the entire set is affordable.
4. Explicit attempt, timeout and stop rules. Treat an uncertain timed-out request
   as potentially billed until reconciled. Do not blindly replay it. A budget
   stop or unsafe key situation is a blocker, not an accuracy failure or zero-cost
   success. No parallel runner may consume the same unreserved allowance.

### Record actual results, not assumptions

For each authorized attempt, retain only approved, nonsecret records: case ID,
dataset hash, operation, requested/returned model identity, prompt/schema
versions, requested languages/locale/level, attempt number, result/error status,
cache status and reviewer decision. Retain synthetic returned text only where
approved; do not log authorization headers, credentials or unrelated documents.

- **Usage and cost:** record actual provider-reported input/output token usage
  where available, including failed attempts with known usage. Missing usage is
  `unknown`, not zero. Separate a rate-based calculation from invoice-confirmed
  spend, recording tariff date, currency and cached-token distinctions where
  relevant. Track reservations and actual/reconciled charges across lookup,
  refinement, enrichment, retries and any audio against the approved evaluation
  budget.
- **Latency:** measure observed end-to-end elapsed time with a monotonic clock;
  record start/end boundaries and timeout duration. Separate lookup, enrichment,
  retries and cache hits. Do not relabel local unit-test duration as API latency.
  If reporting p50/p95, include sample count and method; tiny samples do not
  establish a reliable service-level claim.
- **Semantic results:** show numerator and denominator by language pair and
  category, with reviewer scope, unresolved disagreements, failures, unavailable
  outputs and predeclared exclusions. Count unhandled output/meaning failures
  according to the frozen protocol; never delete hard cases after observing them
  to improve the score. A tiny diagnostic set is not a population accuracy
  estimate; structural pass rates are not a substitute for semantic accuracy.
- **Stop/report:** stop at the authorized scope's completion, the spend bound,
  a required authorization/key gate or an unrecoverable blocker. Report the exact
  completed subset and what was not run. Do not declare “95% success,” fluent
  multilingual quality or proven learning outcomes from these 70 offline tests.

The next useful step is **qualified bilingual review of the candidate sentences
and hints**, not an automatic API run.
