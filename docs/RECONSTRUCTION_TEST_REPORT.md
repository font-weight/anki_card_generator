# Language Reader 0.7.0 reconstructed: verification report

Date: 2026-10-22. This is a **new reconstruction**, not recovered original 0.6.1 source and not a byte-identical replica. Nothing was installed into an existing browser, sent to a personal Anki collection, or published to GitHub. Live paid API calls: **0**.

## Provenance and local history

Published base: `font-weight/anki_card_generator`, branch `feat/english-reader-v1`, upstream commit `0d3225566d7968158d87bf998c873ae3c6b4b253` (0.5.0). All 194 source blobs were checked against their Git object IDs. Local snapshot tree `52f78fb949b1e4bbfde71ea533a87972a40ee2e5` matches the upstream tree exactly.

1. `15f9ab8ea485b4a2a313f74c13a28ed518cae1ed`: verified 0.5.0 snapshot import.
2. `4e4084b8b55142f4b301f99458e15bcd4ff8f6a6`: reconstructed reader/grammar and contextual phrasal implementation.
3. `b5d5bd4707d63bea4cddd53d4c4fcd7d4acee9d4`: regression tests and unrun browser specification.
4. Final documentation commit is identified in the delivery manifest, along with source/build/history SHA-256 hashes. The delivered extension is rebuilt at that final commit.

The local history is intentionally distinct from upstream ancestry. The compiled 0.6.1 behavior reference had SHA-256 `b6b9e5e1d36f3a6fd04b76db374480236bcb8bd03dbe3cc2e8cb6233d832c189`. It was not treated as recovered source.

## Reconstruction checklist and actual evidence

| Requested item | Implementation and local verification | Remaining limitation |
| --- | --- | --- |
| 0.5.1 compact action menu; own library ready | Implemented. Action target tests distinguish the extension's library from restricted or unrelated pages. | Real extension toolbar interaction not run. |
| Shift on book text with focus outside EPUB iframe | Implemented. Trusted parent-frame gesture, editable/IME/chord/stale-frame checks; exact PDF/EPUB provenance; existing navigation/search/bookmark/appearance regressions pass. | Real Chromium iframe focus and OS keyboard behavior not exercised. |
| Popup replacement and pending save identity | Implemented. Shared popup lifecycle cancels old requests, ignores stale completions, closes detached anchors and preserves dispatched save identity. | Real browser rendering not exercised. |
| 0.5.2 every-sense source definitions and target translations | Implemented. Prompt explicitly specifies both; every sense passes conservative language/script checks. Versioned lookup cache invalidates earlier semantics. Invalid output is rejected without automatic paid repair. Existing cards are not rewritten. | Heuristics are not a complete language detector or semantic proof; actual provider outputs not tested. |
| 0.6 default-off LeftAlt grammar | Implemented. Separate paid Settings opt-in; only clean trusted LeftAlt release can auto-generate after opt-in. Chords, AltGr, typing, IME, stale gestures and cancellation covered. Hover and ordinary reopen generate nothing. Explicit fallback opens an idle preview. Revoking opt-in during deferred key retrieval prevents dispatch. | OS Alt/menu behavior and real browser gestures not run. |
| Exact sentence, useful grammar question, editable answer/rule/explanation/translation | Implemented. Exact original sentence retained; one construction/question requested; independent explanation language and optional detailed explanation; editable preview. | Grammatical usefulness and target-language accuracy remain provider-dependent and need human preview review. |
| Separate grammar setup and manual Add | Implemented. Explicit setup consent for `LanguageReader.Grammar.v1`; conflicts fail without overwrite. Optional grammar deck falls back to default deck. No audio/cloze, automatic save, hidden retry or background grammar queue. Immutable operation snapshot and read-only uncertain-save reconciliation tested. | Real AnkiConnect compatibility and collection writes not tested. |
| 0.6.1 numeric offset recovery | Implemented. Strict shape/type/size checks precede repair; repair only for unique exact construction text in unchanged source; full plaintext/grapheme validation follows. Bilbo `were sitting` regression repairs `[35,47)` to `[34,46)`. Ambiguous, fuzzy, rewritten and invalid-grapheme cases are rejected, without a paid retry. | No provider call was needed or run. |
| New contextual phrasal lookup | Implemented. Finite local English candidates/inflections are supplied to the SAME initial lookup. Hovering the verb or particle works. Tests cover `cloud over`, `clouded over`, `go by`, `went by`, literal negatives, repeated text and Unicode. | General unrestricted phrasal recognition is deliberately partial: finite contiguous lexicon; contextual semantic choice is model-dependent. |
| Manual selection, ambiguity and separable verbs | Implemented. Any explicit selection wins, including reselecting the same single token after hover. `a cloud over the city` and transport `go by bus` are locally excluded. Uncertain model choice can retain the original token. `turn it off` never invents a contiguous `turn off` span; select the full text manually. | No automatic discontinuous/multispan contract. Conservative single-word fallback outside supported cases. |
| Exact surface/lemma/ranges through all consumers | Implemented. Locally canonical candidate IDs bind exact source surface and UTF-16 offsets separately from lemma; model offsets are not trusted. Cache validates the original request plus candidates and exact resolved target. Reopen, refinement, examples, audio input, Anki draft and generated cloze retain the chosen occurrence. Manual requests retain strict expression equality. | Mocked providers/audio/Anki only; real audio generation not run. |
| DOM/PDF/EPUB text boundaries | Implemented. Inline-node, PDF-style text-layer, same-origin EPUB frame, Unicode/grapheme and repeated-occurrence tests pass without source-text rewriting. | These are DOM/component fixtures, not proof of every real PDF/EPUB layout. |

### Automatic phrasal coverage

The local list has **40 base-verb families**, explicit common inflections, and contiguous two- or three-word expressions. At most **8 candidates** are emitted around the hovered token. Families: cloud, go, come, get, give, take, put, turn, look, bring, break, run, set, pick, call, carry, work, find, make, keep, hold, fall, stand, sit, show, grow, wake, leave, move, pass, pay, try, fill, end, figure, point, sort, shut, cut, die. This is a bounded list, not a claim to recognize every English phrasal or prepositional verb.

Lookup prompt version: `language-reader-lookup-v5-source-definitions-phrasal`. Model schema version: `language-reader-model-v4`. Candidate version: `contiguous-phrasal-v1`.

## Executed checks

Environment: Node `v24.19.0`, npm `11.9.0`; dependencies installed from the committed lockfile. All feature/provider/Anki inputs are isolated fixtures and mocks.

- Baseline before changes: 43 Vitest files / 606 tests, plus 353 Node service tests = **959 passing tests**; TypeScript passed.
- Final `npm test`: **48 Vitest files / 646 tests**, plus **398 Node service tests**, total **1,044 passed**, **0 failed**, **0 skipped** in these suites.
- `npm run typecheck`: passed.
- `npm run build`: passed, production extension.
- `VITE_ISOLATED_ANKI_TEST=1 npm run build`: passed, fixed isolated Anki fixture port build.
- `node tests/security/artifact-isolation.mjs`: passed for both builds. This is the repository's existing post-build packaging check, not a new service/security review.
- `git diff --check`: passed.
- Lint: no lint script or linter is configured in this repository; no lint success is claimed.
- Source/history restore and extension ZIP integrity/manifest/entry checks are recorded in the delivery manifest.

Non-fatal existing bundler warnings about chunk size and `inlineDynamicImports` were emitted; both builds completed successfully.

## Browser/provider tests not run

An attempted existing Playwright suite failed **before browser interaction**: isolated Chromium could not create required local sockets (`EPERM`). One appropriate escalation failed during environment setup. No restriction was bypassed or retried through a different browser route. Therefore, the launch failure is not reported as a successful browser test or as four behavioral regressions.

Three additional feature browser scenarios were authored in `tests/e2e/reconstructed-features.spec.ts` and typechecked but **not run**. They use synthetic HTML/EPUB fixtures and mocks, and cover hover/Shift/manual selection, focus outside the EPUB iframe, and clean LeftAlt versus chords/preview-only fallback.

Not exercised: real Chromium UI rendering, OS Alt behavior, a live OpenAI provider, real API latency/billing, real audio generation, or real AnkiConnect writes. No personal profile or installed extension was touched.

## Safe, non-destructive trial instructions

1. Keep the currently installed extension unchanged. Extract the supplied production ZIP and use a **separate temporary browser profile** to load its `english-reader` folder as an unpacked extension. Do not overwrite an existing extension folder or reuse a personal browser profile for this trial.
2. Begin with the source's synthetic fixtures, not personal books. Grammar and paid audio remain off. Do not enter a live API key unless the owner explicitly chooses a paid trial; ordinary hover should make no model request. A new vocabulary Shift lookup needs a provider response, so automated fixture testing is the zero-paid-call route.
3. For fully mocked browser tests in a suitable environment: run `npm ci`, `node tests/readers/create-fixtures.mjs`, `npm run build`, then `npx playwright test tests/e2e/reconstructed-features.spec.ts`. These new scenarios still require first execution/verification; do not infer their success from typecheck.
4. If the owner chooses to test real Anki, use a **separate empty test Anki profile/collection and test deck**, with the personal profile closed. Inspect Settings and explicitly initialize the grammar note type only in that test profile. Existing model conflicts must produce an error, not replacement. Review each preview and use manual Add only when wanted.
5. If the owner separately chooses a live provider trial, keep it inside the already agreed shared spending limit; no such spend was used by this reconstruction. Explicitly enable grammar only for that trial. Check one fresh sentence, reopen it for cache reuse, try the exact four requested phrasal surfaces and literal negatives, and verify the final saved field/cloze offsets. Do not run paid retries automatically.
6. To end the trial, close the test browser/Anki profile and leave personal data and the original installed extension untouched. No production rollout or publication is implied.

## Delivered-source hygiene

The source archive contains only tracked source, tests, lockfile, documentation and `HISTORY.bundle`. It excludes dependency directories, build directories, secrets/credential files, browser/Anki profiles, personal books, the compiled reference archive, and generated EPUB files. Tiny synthetic fixtures already present in the verified upstream source remain as test fixtures, not user books. The Git bundle contains the recoverable local commits, not local Git configuration or credentials.
