# Language Reader 0.7.2 reconstructed: popup sizing correction

Date: 2026-10-22. Base: verified 0.7.1 commit `f5bff064294fee3ac7954d08f4655db014184092`. This is a focused correction of the extension-icon menu, not a reader/Settings redesign or a change to the verb base-form feature.

## User-reported defect and diagnosis

The supplied real-browser screenshot was inspected directly. It shows a narrow popup column, wrapped brand/status text, substantial vertical scrolling and cramped/clipped footer controls. This is a real 0.7.1 usability defect; the prior jsdom/CSS checks did not establish correct browser geometry.

The 0.7.1 stylesheet declared `width: 360px; max-width: 100vw` only on the inner menu. The `html`, `body` and `#root` elements had no independent width/min-width. Thus the inner width could be limited by the initially narrow viewport instead of supplying an intrinsic document size for popup autosizing. That code defect is consistent with the supplied screenshot. The built action page imports only its own CSS; shared reader/Settings styles were not a competing rule.

The previous CSS test asserted the problematic viewport cap. It has been replaced with document-sizing checks rather than retained as evidence of correct layout.

## Correction

- `html`, `body` and `#root` each establish `width: 392px`, `min-width: 392px`, border-box sizing and zero margin.
- The menu fills that document width without any viewport-relative cap. It has a 580px maximum height and scrollable overflow, not hidden/cropped controls.
- Slightly tighter vertical spacing leaves more room while preserving readable padding.
- The brand icon cannot shrink. Button labels and shortcut text can wrap within their flex/grid cells; footer buttons retain their independent cells.
- Long read/action errors remain intact, bounded and keyboard-focusable, with visible focus styles. All underlying actions, permissions, lookup and Anki behavior remain unchanged.

## Executed validation

- `npm test`: **54 Vitest files / 825 tests** plus **398 Node tests**, total **1,223 passed**, **0 failed**, **0 skipped**.
- **13 new cases** over 0.7.1: 10 source/freshly compiled CSS declaration cases and 3 long-label/error DOM cases. The earlier inadequate style assertions were corrected.
- `npm run typecheck`: passed.
- Production and isolated fixture builds: passed.
- Existing offline artifact-isolation check: passed for both builds.
- Both actual built action HTML/CSS artifacts were inspected: each links only its action stylesheet; the 392px roots, absence of viewport-relative sizing and 580px scroll fallback survived compilation.
- `git diff --check`: passed. No lint script is configured.
- Existing non-fatal bundler chunk-size and `inlineDynamicImports` warnings remain.

The sizing suite builds fresh action assets in memory (`write:false`); it never reads potentially stale `dist` output or starts a browser/server. Effective CSS declarations are checked with mocked starting widths of 120, 180 and 392px. These are **static/computed-declaration and DOM checks, not a browser layout simulation**. Existing behavior/contrast regressions continue to pass.

## Not performed

Real Chromium rendering/autosizing, browser keyboard interaction, screenshots of the corrected build and real-browser E2E were **NOT RUN**. The earlier socket/setup restriction was not retried or bypassed. The user’s screenshot proves the old defect, not successful rendering of this correction. Confirmation of the corrected geometry in a real browser remains outstanding.

No live paid API, real audio generation, personal Anki or installed-extension/profile operation was performed. No push, PR, publication or deployment was made. The separate stopped review was not resumed.

## Delivery

The final delivery report identifies the exact commit/tree and hashes. Source archives contain all tracked source, tests and documentation plus a Git history bundle. ZIP integrity and built-file bytes are checked. The bundle is restored to a fresh checkout and checked with `git fsck --full`, HEAD/tree comparison and source-byte equality. The 0.7.1 delivery remains separate; this corrected release is 0.7.2 reconstructed.
