# Language Reader 0.7.3 reconstructed: lookup, grammar saves and keyboard paging

Date: 2026-10-23. Baseline: the delivered 0.7.2 commit `fda17b4851dc87a0e1360c780a93162ed7c4ec79`, tree `45615d8e6f15811a40e9b32e174bc02386cfde0e`. The source archive was SHA-256 verified, all 226 source blobs compared to the commit, and its HISTORY.bundle cloned and checked with `git fsck --full` before editing. No stale upstream 0.5 checkout was substituted.

## Evidence and diagnosis

Both user screenshots were inspected as images. The first is the in-reading popup for `kept` in a sentence containing `kept up`, not the extension-icon toolbar. It shows an unhelpful generic structured-output failure and an oversized always-visible warning. The second shows a generated grammar draft and an Anki schema error during saving.

### Lookup

The `kept` inflection and `keep up` candidate already exist in the local lexicon. The actual failed provider response was not supplied, so the screenshot cannot establish which field was invalid. Offline code/tests identified a concrete outbound/inbound contract mismatch: the provider schema allowed arbitrary sense IDs, any supported pronunciation dialect, and counts outside the local bounds, whereas local validation rejected those values. In particular candidate span IDs contain colons and are not valid sense IDs; the two ID namespaces were not explained clearly in the prompt.

The request now exposes the same sense-ID pattern and count bounds, restricts non-null IPA to the exact requested dialect, and explains candidate vs sense IDs and `kept`/`kept up` lemmas. Cache versions were incremented. Local validation remains strict: forged candidates/spans, changed source, duplicate/unknown sense IDs, wrong definition language/dialect, markup and malformed output are still rejected. No fabricated translations or additional repair call is introduced. Supported structured-output keywords were checked against the [official guide](https://developers.openai.com/api/docs/guides/structured-outputs); real provider acceptance was not exercised.

Vocabulary lookup/refinement/enrichment no longer silently retry transport/provider failures. Each action sends at most one POST. Only an explicit new user action can retry; a timeout/cancellation may still have incurred a provider charge.

### Grammar saving

The exact installed Anki fields/templates remain unknown. Offline code/tests show that the old setup and save path hard-coded one v1 model and rejected harmless field ordering differences, while setup simply rechecked a conflict without a recovery path. The popup dropped the structured error code and suggested repeated Add with no setup-specific guidance.

Compatible v1 models remain usable. Required fields are matched by name, while `OperationId` must remain first and the exact single-card front/back templates remain required. Extra unused fields and reordering of non-primary fields are accepted; arbitrary templates or extra cards are not. Explicit Settings consent can create a separate `LanguageReader.Grammar.v2`, never rename, overwrite or delete existing models/notes. A conflicting v2 remains blocked. Network, authentication or malformed protocol replies do not authorize model replacement.

Save reconciliation looks up the immutable operation in both model namespaces before readiness checks. An uncertain dispatch is not resent just because a new model was prepared. Known pre-dispatch/schema failures can recover with the same frozen operation after explicit setup. The UI distinguishes model setup guidance from transport confirmation, and preserves the draft while Settings is opened.

### Keyboard paging

The previous EPUB/FB2 key listener was restricted to the reader root and iframe; PDF required focus inside the reader. This directly explains the click-first behavior in those code paths. A single active-reader owner now routes outer library and live frame events without shifting focus. It excludes editable fields, interactive controls and accessible widgets, active text selection, popups/dialogs, composition/IME, modifiers, repeated keydown, hidden or stale readers/frames. It preserves existing navigation serialization and unregisters on book replacement/unmount. The initial import-button focus has a narrowly scoped paging allowance, revoked on subsequent control interaction.

## Reading panel revision

Only `.reading-popup` grows to a maximum 520px, clamped to the viewport with scrollable overflow; the separate 392px toolbar correction is unchanged. A prominent surface-word heading and returned verb base form lead the result. Loading and error states remain useful even before a draft exists, with the exact source sentence highlighted. The error is plain language; technical disclosure contains only an allowlisted public code, not a raw provider body, source metadata or credentials.

Retry is explicit and synchronously guarded against double clicks/inflight work. Timeout, close, replacement and late results cannot revive a stale draft. It is unavailable once a result/draft or Anki snapshot exists. Unsaved-edit notice appears only after editable draft changes; pronunciation fetches are not treated as edits. Pending and uncertain-save cautions are contextual, and closing does not abort/resubmit a dispatched Anki operation.

## Executed checks

- `npm test`: **57 Vitest files / 876 tests** plus **421 Node tests**, total **1,297 passed**, **0 failed**, **0 skipped**. This is 74 additional passing cases versus 0.7.2.
- `npm run typecheck`: passed.
- Production and isolated fixture builds: passed with Node 24.19.0. Existing dependency versions were reused; a fresh dependency install was not claimed.
- Existing post-build artifact isolation check: passed for both target directories.
- Both compiled action HTML/CSS targets retain independent 392px roots and 580px scrolling; these are static/computed declarations, not measured browser geometry.
- Both compiled content/background targets contain the reading-only 520px panel, explicit retry/cost text, versioned lookup contract and grammar v2 support; the old always-on lookup warning is absent.
- `git diff --check`: passed. No lint script is configured.
- Existing non-fatal bundler chunk-size and `inlineDynamicImports` notices remain.

Coverage includes valid and malformed lookup output, `kept`/`kept up` irregular lemma/candidate identity, exact Unicode ranges and dialects, explicit retry single-dispatch/double-click handling, late timeout/close/new-selection responses, immutable save identity, actual dirty vs passive draft state, consented grammar setup and collisions, known-failed and uncertain saves across model versions, active outer/iframe paging, initial opener focus and real library component reopen/cleanup. These are offline mock/DOM tests, not real-browser proof.

## Not performed

- Real Chromium rendering, browser keyboard/OS behavior, extension loading and corrected-build screenshots: **NOT RUN**. The prior local-socket denial and escalation setup failure were not retried or bypassed.
- Real provider replies, API latency/billing, audio generation and personal Anki compatibility: **NOT RUN**. Live paid calls: zero.
- Installed extension/profile/collection changes, GitHub push, PR, publication or deployment: none.
- The separate stopped review was not resumed. These are the requested ordinary feature corrections and regressions.

Passing DOM/mock tests does not establish real layout, actual account/model acceptance or the exact cause of the two original live failures. No claim of a successful personal-Anki add is made.

## Delivery verification

The release is delivered with the tracked source, tests/docs and full local Git history bundle, plus the production extension ZIP and a short report. Final packaging verifies source bytes against HEAD, restores the bundle into a fresh checkout, runs `git fsck --full`, compares HEAD/tree and every source file, checks ZIP integrity and built-entry byte equality, and records SHA-256 hashes and confirmed Library file IDs. The final delivery report supplies the exact commit/tree rather than embedding a self-referential final hash here.
