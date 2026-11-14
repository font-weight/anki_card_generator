# 0.7.5 — full sentence translation and phrase lookup feedback

Date: 2026-10-29. Status: offline-validated update; live provider and browser validation remain outstanding.

## Baseline
Used the exact delivered 0.7.4 reconstructed source ZIP, SHA-256 a41d3a723303dae5bc556c131622038a41234b1d8271cf589c1570b6e398a4bd. Existing dependencies were reused from the prior local 0.7.4 workspace; no new dependency installation or dependency-version changes. Node 24.22.1. HISTORY.bundle retains the supplied historical history, not a claim that this update was pushed or committed. No GitHub publication, user secrets, live provider requests or personal Anki access.

## Requested cards
- New explicit lookup responses require sentenceTranslation for the entire supplied context.sentence in the target language. Same-language mode requests a faithful paraphrase; fragments are translated without inventing their ending. Adjacent context is for disambiguation only.
- This is part of the existing lookup, not an extra request. Model, reasoning effort and token ceilings are unchanged. No automatic paid retries/repair, fabricated translation or guessed alignment.
- Recognition and cloze answers show the translation above the vocabulary meanings. The front does not reveal it. Plain text is escaped against HTML, native cloze, media and LaTeX syntax.
- The original studied word or phrase is underlined using the validated exact UTF-16 range. Repeated occurrences, inline text and emoji are tested; the original sentence is not replaced. In cloze, the answer is concealed on the question side and underlined when revealed.
- Translation is carried in the immutable v3 draft, durable queue and semantic content key. Lexical duplicate discovery stays unchanged. Lost-response recovery retains the translation without sending the note twice.
- Existing v2 Anki models/fields/templates are unchanged: the new answer block is stored within Meaning. No type migration or old-note rewrite. Old persisted drafts without translation remain valid and do not acquire a fake translation. New cache namespace prevents old cached lookups from hiding the feature.
- Script validation is a conservative check, not proof of translation completeness or semantic quality. Users still review generated content.

## Screenshot and manual selection + Shift
The actual supplied screenshot pixels show English→Russian B2, selected “bound on”, INVALID_MODEL_OUTPUT, validation/definition_language. The second actual screenshot shows the same code/category for the single word “lighted” in “Shut out the yesterdays which have lighted fools the way to dusty death.” This confirms the observed failure is not exclusive to two-word selections. The provider responses were not provided. For English the relevant guard only checks that a definition contains Latin script; ordinary English definitions are not rejected by an English stopword heuristic. Thus the precise provider cause is unproven.

The actual outbound mock request was traced: instructions are included, sourceLanguage=en and targetLanguage=ru remain distinct in the JSON payload, and the original prompt already asks definitions in the source language. No contradictory language-role instruction was found. The exact-context lighted fixture preserves its surface form and sends the correct roles.

Request-specific strict schema descriptions now bind every definition to the source language and every equivalent to the target language. Error feedback explains the generated-answer language mismatch and does not imply correctly selected settings are wrong. The guard remains; genuinely invalid output is not silently accepted. A bounded definition_script_cyrillic category identifies the specific case “English expected, Cyrillic present with no Latin letters”; the UI shows that category without retaining any generated definition text. Other language failures remain generic. The diagnostic cannot be treated as proof that the text is specifically Russian. This is a mitigation, not a claim of guaranteed live-provider repair.

The user's observation that it seems to affect all manually selected two-word verbs was checked with actual DOM ranges across inline nodes, registered Shift activation, lookup payload construction and a mocked provider. The fixtures cover bound on, went by, kept up, clouded over, go by, put up with and a single-word went control, each in document and EPUB iframe paths (14 tests). Selected phrases/ranges and language settings are preserved, hover candidates are omitted for manual selections, and exactly one lookup occurs. No deterministic phrase-selection defect was reproduced. These tests use a trusted-event-shaped stub and are not actual browser trusted keyboard input.

## Verification
- npm test: 60 Vitest files / 928 tests and 491 Node service tests, total 1419 passed, 0 failed, 0 skipped.
- npm run typecheck: passed.
- Production build and isolated fixture build: passed. Post-build artifact-isolation check passed for both.
- Independent read-only review: template/pipeline/compatibility/diagnostic checks passed.
- Browser E2E attempted: Chromium could not start because socket() returned Operation not permitted in process_singleton_posix.cc. Two setup failures, five tests did not run; no browser product assertion was reached. No workaround/escalation used.
- Live OpenAI, actual Anki Desktop/AnkiConnect, real installed-browser rendering, actual trusted Shift input and translation quality: not tested. No lint script is defined.
- Existing non-fatal bundler chunk-size and inlineDynamicImports warnings remain.

Source ZIP excludes node_modules, build output, test traces/screenshots and private input images. Extension ZIP contains the production english-reader directory; the isolated test build is not distributed as the extension.

## Installation
Extract the extension ZIP. Replace files in the same unpacked-extension directory used for 0.7.4, then click Reload in chrome://extensions. Do not uninstall or clear extension storage. Existing cards are unchanged; new lookups/cards include sentence translation. Review the card preview and try a separate Anki test profile first.
