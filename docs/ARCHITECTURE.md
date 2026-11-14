# English Reader architecture

## Boundaries

The Manifest V3 service worker owns provider/Anki requests, validation and queue orchestration. Content scripts only capture exact text ranges and show isolated UI. Runtime messages use versioned schemas from packages/contracts; sender identity and exact extension-owned pages determine privileges. No external messaging listener is registered.

Trusted extension pages own setup, secrets entry, library and queue. Books are read through the shared IndexedDB storage package directly in the extension origin; no base64 book messages. Content scripts never receive API keys. Provider URLs are fixed, not supplied by a web page or language model.

## Reading flow

A user explicitly enables the content script using activeTab. Mouse movement only records position. A trusted Shift event extracts a selection of at most five words or the word under the pointer. Text is preserved as UTF-16 with exact offsets. The popup reads safe preferences and calls lookup. Stale results are discarded. Saving creates a durable operation before any Anki network mutation.

PDF.js and its worker/resources are bundled locally. Canvas and text layers do not instantiate PDF scripting or automatic action handlers. EPUB import preflights archive limits and bounds actual decompression in a worker, removes active/external resources, and renders an iframe without allow-scripts. Original EPUB CSS/SVG/fonts are deliberately stripped in this version. A controlled typography layer and EPUB CFI preserve reading position.

## Confirmations and audio

Action-bound confirmation requests open a trusted extension page with a unique expiring nonce. The service worker binds the decision to its pending call; arbitrary web pages cannot answer it. Persistent settings record dictionary/cloud-audio consent. Local speech selects only localService voices. Cached audio is played in an offscreen document, because service workers do not provide Audio or speechSynthesis. No remote voice is silently substituted.

## Durability

B-owned IndexedDB migrations separate cache, outbox, library and progress. Cache pruning must not delete books or pending media. OperationId is the idempotency key. A potentially completed Anki request is reconciled before retry. The UI distinguishes queued from added, and rereads durable state when reopened.

## Build and verification

Node and dependency versions are pinned. Vite separately bundles extension pages, service worker ES module and content IIFE; Chrome minimum target is120. Browser tests use an isolated profile and never the user's existing collection or normal profile. Unit tests, static audits, Chromium tests, Windows Chrome and real provider/Anki evidence are reported separately.
