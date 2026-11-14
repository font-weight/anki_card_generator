# 0.7.4 repeated lookup failures: findings and verification

Date: 2026-10-23. Status: offline-validated reconstruction update; live-provider/browser verification remains outstanding.

## Baseline and evidence

Continued the delivered 0.7.3 commit `c7f4976c7920c7f9a0ffcaa9768bcc255aff59c9`, tree `70dc9273333f66d28766226a8e1134cd1d57210f`, by restoring its history bundle into a separate checkout. Source ZIP SHA-256: `d028ac1e47e4b52ac984dad7bb24e7e34995e51ce3f103c1e773d137c4c060b8`. All 234 baseline source files were compared byte-for-byte with that commit; `git fsck --full` passed. This was not restarted from the old published 0.5 source.

All three new screenshots were inspected directly. They show the updated reading popup failing with `INVALID_MODEL_OUTPUT` for `fireside-tales`, `seemed`, and `ZIP` in Russian surrounding text. The `seemed` popup ends its context at “Ted had”, although the visible book continues “scored a point.” No raw provider response, HTTP status, actual request or timing record accompanied the screenshots. Therefore no single exact live failure cause is asserted, and no claim is made that these fixtures are recovered provider output.

## Demonstrated defects and fixes

1. **Sentence truncation at inline source wrapping.** A synthetic EPUB-style paragraph containing `Ted had\nscored a point.` reproduced the precise cutoff: `Intl.Segmenter` treated the formatting newline as a sentence boundary. Segmentation now uses an equal-length shadow string with inline line breaks represented as spaces. Original source text, newlines, Unicode and UTF-16 offsets are retained in the payload. Actual structural blocks and Unicode paragraph separators stay distinct, and the 1500-unit limit is unchanged. A narrow English honorific rule also avoids splitting `Mr. Boffin`. The screenshot's actual DOM was unavailable, so the matching reproduction does not establish its exact markup.

2. **Request failures mislabeled as generated-output failures.** The previous HTTP error mapper used `INVALID_MODEL_OUTPUT` for unrecognized 400 responses, before any generated output existed. These now return `OPENAI_REQUEST_REJECTED` with one safe request-category reason. Non-JSON HTTP errors retain their HTTP category instead of being mislabeled JSON-output failures. The popup does not offer a blind repeat of unchanged rejected parameters.

3. **Valid response text fragmentation rejected.** The parser previously required exactly one `output_text` part. It now concatenates ordered text parts within one assistant message and parses the resulting single JSON document. Separate competing messages, two JSON objects, Markdown fences, invalid JSON, refusals and malformed/incomplete output are still rejected or classified explicitly. It does not repair or fabricate content.

4. **Narrow unchanged acronym equivalent rejected.** The target-script check formerly rejected `ZIP` even alongside a useful Russian equivalent such as `ZIP-архив`. Only an exact uppercase selected token may now accompany another target-script explanatory equivalent in the same sense. A bare acronym, unrelated abbreviation, case-changed copy, ordinary untranslated word or wrong definition language remains invalid. No explanatory translation is synthesized locally.

5. **Known candidate lemma formatting rejected.** Against an already validated local candidate only, case, NFC and horizontal-space equivalents are accepted and mapped to that candidate's existing canonical lemma. Wrong inflection, invented phrase, changed particle, newline, altered candidate ID or changed source range is not accepted. Selected surface text is never normalized.

6. **Generation dependency order.** The strict request schema now places candidate selection before its dependent lemma/senses/IPA and generates sense IDs before referencing one as the recommendation. Required keys and validation constraints are unchanged. Prompt instructions clarify hyphenated compounds, incomplete source fragments, acronym equivalents and independent sense/candidate IDs. Lookup cache namespace is `language-reader-lookup-v7-dependent-fields`, model schema version `language-reader-model-v6`, request schema name `language_reader_lookup_v6`.

Incomplete response envelopes are recognized before requiring an output message, allowing a genuinely truncated response to show `MODEL_INCOMPLETE` rather than a generic malformed structure. Usage attribution is retained where the envelope supplies it, without placing provider IDs in public diagnostics.

The configured model, reasoning settings and token ceilings are unchanged: `gpt-6-luna`, lookup/enrichment `none`, refinement `low`, lookup maximum 3200 output tokens and enrichment 1800. The [official model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), [structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [text/output guide](https://developers.openai.com/api/docs/guides/text) were checked. They support the request features, ordered schema generation and content-array handling; they do not prove the user's actual request succeeded or identify its failure. There was no evidence supporting an unrequested model change or larger spending cap.

## Observable, bounded errors

“Технические сведения” remains collapsed by default. It now shows a public error code, fixed Russian explanation and `Диагностика: stage/reason`. Only enumerated categories can pass the service, RPC and lookup-UI boundaries; arbitrary extra fields cause the diagnostic object to be dropped. No raw provider text, request/response identifiers, API keys, URLs, source passages or arbitrary field paths are placed there.

Stages: `request`, `response`, `output`, `validation`.

Reasons:
- Request: `request_rejected`, `request_schema`, `request_parameter`, `request_model`.
- Response envelope: `response_too_large`, `response_json`, `response_shape`, `response_status`.
- Generated output: `output_missing`, `output_multiple`, `output_json`, `output_refusal`, `output_incomplete`.
- Validation: `lookup_shape`, `sense_shape`, `sense_id`, `sense_translations`, `sense_definition`, `definition_language`, `translation_language`, `candidate_binding`, `recommendation`, `ipa_shape`, `ipa_dialect`, `result_contract`, `result_binding`, `examples_shape`, `input_invalid`.

The actual requested language pair and learner level are visible while loading or on error. “Проверить языки в настройках” opens Settings; opening it or returning from it does not initiate another lookup. A new translation rereads the settings only after a new explicit translation action; the existing return-focus handler may separately refresh destination/audio preferences without translating. Submitted save snapshots remain unchanged.

“Повторить перевод” remains user-initiated, synchronously guarded against duplicate clicks and accompanied by “Это новый запрос к ИИ. Он может быть платным.” It is not offered for `OPENAI_REQUEST_REJECTED`; that state says to keep the safe code/category instead. There are no automatic provider retries, paid repairs, fallback models or automatic translation/Anki saves. A timed-out or cancelled dispatched provider request can still have incurred a charge.

If a failure recurs, report the displayed `Код` and `Диагностика` lines, version and requested language pair. Do not send an API key, full API response, private book or collection. The category identifies the failing check; it is not a semantic-quality guarantee or unique-cause diagnosis.

## Verification executed

- `npm test`: **59 Vitest files / 913 tests** and **470 Node tests**, **1,383 passed**, **0 failed**, **0 skipped**. This is **86 additional passing cases** compared with 0.7.3.
- `npm run typecheck`: passed.
- Production and isolated fixture builds: passed on Node 24.19.0 using existing locked dependencies. No fresh dependency installation is claimed.
- Existing post-build artifact-isolation check: both outputs passed.
- Actual compiled action HTML/CSS retains independent **392px** document roots and a **580px** scrollable menu. Static/computed declarations only, not measured browser geometry.
- Both compiled content/background targets contain version 0.7.4, the reading-only **520px** panel, explicit cost notice, bounded error categories, updated strict prompt/schema and inherited grammar v2 support.
- `git diff --check`: passed. There is no lint script. Existing non-fatal bundler chunk-size and `inlineDynamicImports` notices remain.

New regressions exercise valid/malformed `seemed`, `fireside-tales` and mixed-language `ZIP`; inflected surface vs dictionary lemma; straight/curly apostrophes, Unicode hyphens, case, repeated words and exact UTF-16 ranges; single-message fragments vs multiple competing answers; acronym boundary failures; schema dependency order; request/envelope/field-specific diagnostics; no raw detail propagation; one-call/no-repair behavior; complete inline-wrapped sentences, structural block separation, iframe occurrence identity and real length clipping. Existing immutable Anki save, grammar model compatibility/reconciliation, reader paging, audio, queue and book-progress tests all remain passing.

The main Russian README and legacy README.ru.md redirect were reconciled with this version's actual labels, behavior and test counts before source packaging.

## Not performed / remaining uncertainty

- Real Chromium, extension loading, native key/focus behavior and screenshot rendering: **not run**. The previous socket denial and escalation setup failure were not retried or bypassed.
- Real OpenAI generation, latency, billing, account/model acceptance, generated audio or personal Anki adds: **not run**. Live paid calls: **zero**.
- Installed extension, browser profile, existing Anki models/notes and personal collection: **unchanged**.
- No GitHub push, PR, publication or deployment by this implementation task. Publication is a separate held workflow.
- The separate stopped review was not resumed; this work addresses the requested lookup/extraction feature defects only.

Passing mocked/DOM tests establishes these code paths, not the exact cause of the three real failures or a guarantee that every valid natural-language answer will pass conservative guards. Remaining failures now expose an actionable bounded check category instead of an undifferentiated error.

## Artifact verification

The final source archive includes tracked source/tests/docs and `HISTORY.bundle`. Packaging compares every source byte with final HEAD, restores the bundle into a fresh checkout, checks its HEAD/tree and every file, runs `git fsck --full`, checks both ZIPs and compiled entry bytes, and records SHA-256 hashes. Exact final commit/tree and file hashes are recorded in the delivery report outside this self-referential source tree.
