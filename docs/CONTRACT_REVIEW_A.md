# Independent contract and fixture review — dot a

Reviewed 2026-10-20. Scope: delivered `packages/contracts/src/{index,schemas,constants}.ts` and `fixtures/language.json`. No B-owned files changed. No provider, paid-model, dictionary, or real Anki calls performed.

## Result

Corrected B artifact SHA-256: `6683bed11730ec09b7b89f3912075480b660cb1c8753713a2f083e3b6b985077` (parent delivery evidence). Independently rerun against imported canonical source.

`npx vitest run tests/review/contracts-review.test.ts`: **18 passing tests + 1 expected-failing alignment test**. The expected failure is an unresolved mismatch, **not a passing protection**. Convert it to ordinary `it` only after verified correction.

### Current finding

**OPEN-7 — hyphenated-word budget mismatch (medium).** New `countEnglishWords` uses `Intl.Segmenter('en', {granularity:'word'})`; that treats `well-known` as two words, while HTML extraction retains it as one word. The five-word UI selection `one two three four well-known` is therefore rejected by canonical validation as six words. U+2011 non-breaking hyphen has the same mismatch. Share the same agreed apostrophe/hyphen-aware counting implementation between contracts and extraction. Punctuation-separated six-word input is now correctly rejected.

### Retested and resolved/reclassified original findings

- **GAP-1/GAP-5 — fixed.** Own-property schema lookup now rejects prototype-named root and nested additional fields. Original issue was unvalidated extra data, not demonstrated prototype pollution. Regression tests now ordinary passing tests.
- **GAP-4 — fixed.** `validateData` reruns `validateNoteDraft` on queue list items and retry/cancel/resolveAudio operation drafts. Invalid original-range semantics rejected by independent queue test.
- **GAP-6 — fixed for comma-separated phrase; OPEN-7 above remains.** Six lexical words separated only by punctuation now rejected.
- **GAP-2 — downstream privacy boundary verified, not an open contract defect.** Canonical schema accepts HTTP(S) query/hash-bearing source URLs; `safeSourceUrl` clears both, and `buildNoteFields` calls it. Independent rendering test verifies source query/fragment tokens do not survive in note fields. Credentials and non-HTTP(S) URLs remain rejected. This verifies note-output sanitation, not a claim of live-model network inspection.
- **GAP-3 — documented compatibility, not a defect.** `docs/API_CONTRACTS.md` explicitly allows null EPUB chapter/CFI when unavailable. Positive test verifies this without fabricating source location. Reader must preserve accurate available locations and be honest when navigation cannot be restored.

### Validated protections

- Exact original UTF-16 slice, including repeated targets; rejection of wrong/out-of-bounds/fractional/inverted ranges and split surrogate pairs.
- Aggregate context budget includes `before` and `after`; whitespace-separated six-word phrase rejected.
- Source/target language, dialect, learner level, RPC version, known operation and ordinary additional-property checks.
- Credentials in URLs and non-HTTP(S) protocols rejected.
- HTML/PDF/EPUB contradictory page/location fields and zero PDF page rejected.
- Generated IPA cannot carry dictionary source URL; unavailable IPA constraints checked; selected sense has at most two translations.
- Duplicate sense IDs, missing recommended sense, ambiguity with non-null recommendation and more than four senses rejected.
- Non-loopback Anki endpoint and extra secret field in reader settings response rejected.

## Independent semantic review of requested hard shortlist

These are synthetic agent-authored candidate references, **not gold labels**. Review is an independent agent plausibility/consistency review only. No human/expert approval, live-model quality score, or 95% accuracy claim is established. All **186** fixture inputs independently passed canonical request validation and `sentence.slice(targetStart,targetEnd) === expression`; all 22 requested shortlist entries exist and retain explicit synthetic / non-human-vetted provenance. Do not rewrite their author provenance to imply human review.

| Fixture(s) | Review judgment |
|---|---|
| `phrasal-get-away-with` | Intended avoidance of punishment is correct; cheating context rules out literal escape. “Избежать наказания за” is natural. “Остаться безнаказанным за” is awkward as an isolated gloss: prefer “остаться безнаказанным” or “сойти с рук”; not a wrong intended sense. |
| `idiom-blessing-disguise` | Correct apparent-misfortune/actual-benefit interpretation. “Нет худа без добра” is an idiomatic equivalent rather than a syntactically substitutable noun phrase; evaluator must accept paraphrase, not demand substitution. |
| `irregular-lay-recline`, `irregular-lain` | Correct lemma `lie`, not `lay` or lying/untruth. Past and participle clues are explicit. “Лежать” fits both; inanimate letters are acceptable. |
| `negation-not-uncommon` | Correct litotes: not rare, not necessarily extremely frequent. Russian candidates are plausible. |
| `negation-need-not`, `negation-must-not` | Correct lack of necessity versus prohibition distinction. Keep negative modal phrases intact; generic lemma reduction to positive `need`/`must` would lose the selected meaning. |
| `negation-not-necessarily` | Correct non-entailment, not “never.” |
| `negation-cannot-help` | Correct unavoidable action, not inability to assist. Russian “не могу не” requires continuation, appropriately supplied by smiling context. |
| `homograph-read-past`, `range-repeat-read-past` | Past-tense reading and /red/ are correct. Second occurrence target in repeated case is correct. Infinitive Russian gloss is an acceptable lemma-oriented variant, not a required whole-sentence translation. |
| `homograph-lead-metal` | Correct metal noun and /led/. |
| `homograph-close-near`, `range-repeated-close` | Correct adjective/proximity, unvoiced final /s/. Repeated case selects the second `close`, not the earlier verb. Russian adjective/adverb gloss differences should not cause automatic rejection. |
| `homograph-minute-small` | Correct adjective “extremely small,” second-syllable stress; not time unit. |
| `ambiguous-match` | Fire-lighting stick versus correspondence is genuinely unresolved; null recommendation is justified. Listed senses are examples, not exhaustive candidate coverage. |
| `ambiguous-seal` | Closure/material versus official impression remains unresolved; animal is pragmatically disfavored by “damaged.” Null recommendation is reasonable. |
| `ambiguous-close` | Physical proximity versus personal relationship is unresolved; null recommendation justified. Other plausible contextual senses should not be scored wrong merely for being absent from reference. |
| `context-fair-decision-control` | Decision strongly supports just/reasonable; do not invent dictionary-wide ambiguity. |
| `injection-fake-json` | Correct lightweight sense. Quoted JSON is source text, not an instruction; fixture must not be executed. |
| `injection-forged-provenance` | Correct lead-metal reading. Quoted label cannot establish dictionary verification; schema-valid IPA alone is not provenance evidence. |
| `range-combining-mark` | Correct fine/penalty interpretation and decomposed accented source. Keep original string; NFC before applying offsets would move target. |

No substantive wrong intended sense found in this 22-item shortlist. Two minor gloss/style caveats are recorded above. This review does not certify the remaining fixtures semantically or measure model performance.

## Next steps

Dot b: align canonical word segmentation with extractor for supported internal hyphens; notify dot a after replacement. Dot a: rerun OPEN-7 and convert its expected failure only when desired alignment is verified. Preserve the distinction between structural tests, independent-agent semantic review, and real provider/human evaluation.

### Extraction audit

HTML extraction counts Unicode lexical matches, retaining straight/curly apostrophes and ASCII, U+2010, U+2011 internal hyphens. It rejects six comma-delimited words and accepts five lexical words containing an apostrophe or supported hyphen. This was independently exercised with jsdom. No B-owned implementation files were modified by the reviewer.
