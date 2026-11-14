# Language Reader 0.7.1 reconstructed: verification

Date: 2026-10-22. This update implements verb base-form display and a redesigned extension-icon menu on the verified **0.7.0 reconstructed** baseline. It is not a recovered original 0.6.1 source release. No installed extension, personal browser profile or Anki collection was modified. Nothing was pushed, published or deployed. Live paid API calls: **0**.

## Baseline and scope

- Starting commit: `144f26cf246dad502c8d543e9021f1bd73380f39`.
- Starting source ZIP SHA-256: `12ea60a096d649cd8f8d226afee7d618038a81a4004c19758a0e77833f215de5`.
- Starting extension ZIP SHA-256: `62f83e6fddcc897962bb76b37a7acdb9002391a322c38b48da8e31632ac3ff2d`.
- Both hashes were checked; all 215 archived source files matched the restored starting commit byte-for-byte. Work continued in an isolated clone of its history bundle, not a replacement checkout of the older published 0.5 source.
- Package/lockfile version: `0.7.1-reconstructed`; extension manifest: `0.7.1`, displayed as `0.7.1 reconstructed`.

## Implemented

### Verb infinitive / base form

The reading popup exposes the existing validated lookup lemma for recognized verb POS labels. Examples: `went` → `Инфинитив: go`; `went by` → `Инфинитив: go by`. Arabic, Chinese, Japanese, Korean and auxiliary/modal labels use `Начальная форма`. No English `to` is invented and no extra request is made.

Nouns/adverbs, unknown or mixed POS, unresolved contextual ambiguity, empty or visibly alternative lemmas do not produce a guessed row. The POS label allowlist is deliberately finite. This is a presentation feature, not a second lemmatizer or independent linguistic validation of a provider's lemma. A semantically incorrect but well-formed provider lemma can still require user correction.

The surface remains the heading; sentence text and exact UTF-16 occurrence remain unchanged. Deliberate lemma edits and refinement update the row. New tests cover cached/manual phrasal results, refinement, stale replacement, repeated Unicode text, surface pronunciation, examples, prepared-audio binding, Anki draft equality and cloze answer concealment. Contracts, provider prompts, cache versions, note templates and existing cards were not changed.

### Extension-icon menu only

The toolbar popup has an isolated 360px layout, restrained green/neutral colors, tab context, one primary action, button navigation and light/dark/forced-color CSS. Shared reader, Settings and library styling is unchanged.

Opening the menu reads current-tab metadata only. It does not probe/inject content, call provider/Anki services, or silently open a tab. The own-library state needs no activation; restricted/unknown pages offer the library instead. Normal websites offer an explicit enable action without claiming the reader was inactive. Navigation changes invalidate stale results. Repeated actions, explicit retries, close/unmount cleanup and failed operations are covered by mocks.

## Executed checks

Environment: Node `v24.19.0`, npm `11.9.0`, the existing lockfile dependency installation. All provider/audio/Anki inputs are mocks or synthetic fixtures.

- `npm test`: **53 Vitest files / 812 tests** plus **398 Node service tests**, total **1,210 passing**, **0 failed**, **0 skipped**.
- Increase over 0.7.0: **166 tests**. Verb display: 63 helper + 17 UI/data-flow cases. Menu: 32 state + 35 rendered workflow + 19 CSS/contrast cases.
- `npm run typecheck`: passed.
- `npm run build`: passed, production extension.
- `VITE_ISOLATED_ANKI_TEST=1 npm run build`: passed, isolated fixture variant.
- `node tests/security/artifact-isolation.mjs`: passed for both variants. This is the existing offline build-artifact check, not a resumed separate review.
- `git diff --check`: passed.
- Lint: no configured lint script/linter; no lint success is claimed.
- Existing non-fatal bundler warnings about chunk size and `inlineDynamicImports` remain.

The unchanged regression suites cover inherited grammar/Shift/Alt behavior, 40-family phrasal handling, queue/audio consent, search, bookmarks and appearance. Passing fixture suites do not prove every real-world workflow.

CSS contracts check the body reset, bounded width/feedback, focus-visible rules and light/dark/forced-color support. Calculated main/muted/primary text contrast ratios are 12.52/5.18/7.50 in light mode and 13.54/8.38/7.06 in dark mode. These are **static CSS and jsdom component checks**, not a full accessibility audit or observed browser rendering.

## Not run / limitations

**Real-browser E2E, visual rendering, keyboard interaction and screenshots: NOT RUN for this update.** The earlier Chromium attempt was blocked before interaction by denied local sockets; the escalation then failed during environment setup. That unchanged denied operation was neither retried nor bypassed.

No live provider, real API billing/latency, real audio generation, personal Anki, installed-extension interaction, OS Alt behavior or real PDF/EPUB rendering was exercised. The stopped separate service/security review was not resumed or reassigned.

If the owner later chooses a browser smoke test, use a separately authorized temporary profile and synthetic fixtures, keeping the installed extension and personal Anki collection unchanged. The production ZIP is an artifact, not a claim of successful installation or completed real-browser validation.

## Deliverables and identity

The delivery report/manifest identifies the final commit/tree and SHA-256 hashes. The source ZIP contains every tracked final source/test/documentation file and `HISTORY.bundle`; dependencies, build outputs, browser/Anki profiles, personal books and secrets are excluded. The bundle is checked by an actual fresh clone, `git fsck --full`, final HEAD/tree comparison and byte comparison of the restored source files. Production and isolated ZIP contents are checked against their built directories; manifest version and required entries are verified.

The source and production build are saved as separate 0.7.1 artifacts, preserving the prior 0.7.0 delivery. Local commits include version metadata, feature changes, focused tests and this verification documentation. No remote push is configured or performed.
