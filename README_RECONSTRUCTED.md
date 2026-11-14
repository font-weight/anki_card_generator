# Language Reader 0.7.5 reconstructed

This is a newly implemented reconstruction plus contextual English phrasal-verb support. It is **not** the original 0.6.1 source and is **not** byte-identical to the reference extension.

## Provenance

- Repository: https://github.com/font-weight/anki_card_generator
- Published source reference: `0d3225566d7968158d87bf998c873ae3c6b4b253` (`feat/english-reader-v1`, version 0.5.0).
- Exact source tree: `52f78fb949b1e4bbfde71ea533a87972a40ee2e5`.
- All 194 tracked source blobs were retrieved through the connected GitHub reader and verified against their Git SHA-1 object IDs. The imported local tree exactly matches the published tree.
- Local history starts with snapshot import commit `15f9ab8ea485b4a2a313f74c13a28ed518cae1ed`; it does not claim to reproduce unpublished commits or original upstream ancestry.
- Compiled 0.6.1 behavior reference SHA-256: `b6b9e5e1d36f3a6fd04b76db374480236bcb8bd03dbe3cc2e8cb6233d832c189`. No source maps or original post-0.5 source were available.

## 0.7.5 sentence translation
New explicit lookups request the full supplied source-sentence translation in the same provider call. Recognition and cloze answers show it above vocabulary meanings; the exact studied word/phrase remains underlined in the unchanged source sentence. No guessed translated-word alignment, new Anki fields, template migration, old-note rewrite or automatic paid repair is introduced. Legacy queued drafts without this field remain valid.

The reported `bound on` screenshot shows `validation/definition_language`, not a readable provider response. Request-specific schema guidance now states source/target language roles on each definition/translation, and the popup explains the AI language mismatch without blaming correctly selected settings. This is mitigation, not proof of a live-provider cure. See `docs/V0_7_5_TEST_REPORT.md`.

## 0.7.4 repeated-lookup correction

This update continues delivered 0.7.3 commit `c7f4976c7920c7f9a0ffcaa9768bcc255aff59c9`, tree `70dc9273333f66d28766226a8e1134cd1d57210f`, from the source archive SHA-256 `d028ac1e47e4b52ac984dad7bb24e7e34995e51ce3f103c1e773d137c4c060b8` and its verified history bundle.

- Inline source line breaks no longer prematurely end the context sentence. Segmentation uses an equal-length view only; original text and UTF-16 selection offsets remain unchanged. Real structural paragraphs and the 1500-unit limit remain separate.
- One assistant response may contain several ordered text parts forming one valid JSON document. Competing messages, malformed JSON, missing fields and changed source bindings are still rejected. Exact uppercase acronyms may accompany a target-script explanatory equivalent; ordinary untranslated words do not receive an exemption.
- Strict-schema generation order now chooses the candidate before its lemma and generates senses before referring to their IDs. Known candidate lemmas accept only case, NFC and inline-space equivalence, then use the existing local canonical lemma. No new phrase, source normalization or invented meaning is introduced.
- API request rejection now has code `OPENAI_REQUEST_REJECTED`, distinct from model output failure. The popup does not offer a blind retry for unchanged rejected parameters. Other translation retries remain explicit, one request per action, with a possible-charge notice.
- “Технические сведения” includes only a fixed stage/reason category and its explanation, never raw provider bodies, keys, IDs or source passages. The requested language pair is visible even on failure; “Проверить языки в настройках” opens Settings without sending a translation request.

The three screenshot failures have no raw API response attached, so their exact live cause is still unknown. These are demonstrated code fixes, not a claim that all real provider replies now succeed. If an error persists, share the “Код” and “Диагностика” lines only; no API key or full response is needed. See `docs/V0_7_4_TEST_REPORT.md`.

## 0.7.3 baseline and fixes

This update continues the delivered 0.7.2 commit `fda17b4851dc87a0e1360c780a93162ed7c4ec79`, tree `45615d8e6f15811a40e9b32e174bc02386cfde0e`. Its source archive SHA-256 is `79ba50031f60eda21170a96a5583c608d63be6ec9625f27c02c9e93619332bcb`. All 226 source blobs and the restored Git history were verified before the update; this does not restart from the older published source.

- The in-reading vocabulary panel now separates loading, failure and result states. The surface word and returned verb lemma are prominent; the large unconditional save warning is gone. A failure offers an explicit retry and a possible-charge notice, with only a public error code under technical details.
- Vocabulary requests use one provider POST per explicit action, not hidden transport retries. The outgoing strict schema matches the local sense-ID, count and pronunciation-dialect constraints; malformed data is still rejected. Exact selected surface, candidate IDs, offsets and source-language definitions remain enforced.
- Grammar can reuse a compatible v1 model or explicitly create a separate `LanguageReader.Grammar.v2` through Settings. Existing models/cards are never overwritten. Schema failures point to setup rather than pretending that another Add fixes the model. Retries keep the same operation and reconcile both model namespaces.
- Active-book arrow/PageUp/PageDown routing works from the outer library document or current EPUB/FB2 frame without an initial text click. Input fields, other controls, IME and popup interactions remain protected; opening a book does not steal focus.

The provider response behind the screenshot and the user's actual Anki model fields were not available. The release fixes demonstrated code defects but does not claim to have reproduced those exact live responses. See `docs/V0_7_3_TEST_REPORT.md`.

## 0.7.1 baseline

This update continues the verified 0.7.0 reconstruction at `144f26cf246dad502c8d543e9021f1bd73380f39`. The starting source archive SHA-256 was `12ea60a096d649cd8f8d226afee7d618038a81a4004c19758a0e77833f215de5`; its history bundle was cloned into an isolated working copy and the restored commit was verified before editing. It does not replace 0.7 with the older published 0.5 checkpoint.

## Build and checks

Use Node 24+ and the committed lockfile:

```
npm ci
npm run typecheck
npm test
npm run build
```

Output: `dist/english-reader/` and `dist/english-reader.zip`. For the fixed-port isolated Anki fixture variant only:

```
VITE_ISOLATED_ANKI_TEST=1 npm run build
```

The delivered source archive includes `HISTORY.bundle`, containing all local reconstruction commits. After unpacking, recover it into a separate checkout with `git clone HISTORY.bundle recovered-source`. No remote push is configured or performed.

## 0.7.2 popup sizing correction

User feedback from an actual browser showed the 0.7.1 toolbar popup squeezed into a narrow, vertically scrolling column. That was a real defect missed by the static/component checks. The menu had a fixed inner width capped by `100vw`, but the document roots did not supply an independent width for the extension popup’s autosizing. The 0.7.2 correction fixes document-level sizing and removes that viewport-dependent width constraint. It does not change reader/Settings styling or activation/provider behavior. See `docs/V0_7_2_TEST_REPORT.md` for the sizing evidence and remaining browser-verification limit.

## New in 0.7.1

- Vocabulary results expose the existing lemma for clearly identified verbs. Infinitive-bearing languages use “Инфинитив”; Arabic, Chinese, Japanese, Korean and auxiliary/modal labels use “Начальная форма”. Unknown/mixed POS, unresolved ambiguity and missing or visibly alternative lemmas are omitted rather than guessed. This is presentation of the returned metadata, not independent morphological verification.
- The surface word remains the heading and the exact source span remains highlighted. Refinement and deliberate lemma edits update the row; the display does not create requests, alter the saved fields, or rewrite existing cards.
- The extension-icon menu now has its own styles, current-tab context and explicit buttons. Merely opening it reads tab metadata, not provider/Anki services, and does not inject the reader. It distinguishes the extension’s own library, normal websites and restricted pages. The existing reader popup and Settings design are unchanged apart from the requested lemma row.

## Inherited 0.7.0 behavior

- Shift uses a manual selection first. Without selection it reads the hovered word. In English, a bounded local lexicon of 40 base-verb families proposes at most 8 adjacent verb/particle candidates, including inflections such as `clouded over` and `went by`. The same first lookup chooses a candidate or the original word. No separate paid detection or repair request is made.
- Hover alone never requests a model. Literal `go by bus` and obvious noun `a cloud over the city` are excluded locally; contextual ambiguity still requires model/user judgment. A finite lexicon is not exhaustive.
- Separated `turn it off` is not converted into an invented contiguous `turn off` span. Select the full expression manually when needed.
- Definitions are in the source language for every sense; translations remain in the target language. Conservative language heuristics reject obvious mismatches, not every possible semantic error. Existing cards are not overwritten.
- Experimental grammar is off by default. Its paid opt-in is separate from vocabulary and audio. After opt-in, a clean left-Alt press/release on a sentence may generate once; chords, AltGr, typing, IME and stale gestures cancel. A grammar button opens a manual Generate flow.
- Grammar keeps the exact source sentence, asks one useful question, and has a separately selected explanation language. Translation remains in the translation language. Preview prose is editable before manual Add. It has no audio or cloze mode.
- Prepare the grammar model explicitly in Settings. Compatible `LanguageReader.Grammar.v1` models remain usable; 0.7.3 can create a separate `LanguageReader.Grammar.v2`. Existing conflicting models are never changed. An optional grammar deck falls back to the default deck when blank; no deck is created silently.
- Grammar has no automatic background retry or queue submission. A submitted operation remains bound to its exact draft. Uncertain adds are reconciled read-only; if no conclusive result exists, inspect Anki rather than blindly resubmit.

## Scope and validation limits

No installed extension, personal browser profile or Anki collection was modified. Nothing was pushed or published to GitHub. All provider and Anki feature tests use fixtures/mocks; live paid API calls: zero.

Real Chromium E2E could not launch in this execution environment because required local sockets were denied. One appropriate escalation failed during environment setup; the restriction was not bypassed. Do not treat mocked component coverage as completed real-browser validation. Provider behavior, real API latency/billing, real Anki compatibility, OS Alt behavior and rendered PDF/EPUB interaction still need a separate authorized isolated smoke test.

See `docs/V0_7_5_TEST_REPORT.md` for this update’s checks and remaining limits. `docs/V0_7_2_TEST_REPORT.md` records the previous toolbar sizing correction. `docs/V0_7_1_TEST_REPORT.md` is the earlier pre-feedback report; its static CSS checks did not establish actual browser sizing. `docs/RECONSTRUCTION_TEST_REPORT.md` records the prior 0.7.0 reconstruction; historical reports elsewhere in `docs/` belong to earlier versions.
