# Dot B service-layer handoff

## Status

Implemented production service modules in isolated local staging; RPC v1 technically accepted by dot a with additive reader preferences/decks/createDeck and optional audio draft. No GitHub write/push/publication performed by B. Dot a owns final repository integration, extension entry, root dependency/lockfile/build config and Windows validation.

This is not a claim of complete live integration. Offline fake IndexedDB and provider mocks are labeled tests only. Production defaults are real fixed provider endpoints with injected fetch, never a mock fallback.

## Entry points

- `@english-reader/contracts`: canonical types, `payloadSchemas`, `dataSchemas`, `validateRequest`, `validateData`, `validateNoteDraft`, `DEFAULT_SETTINGS`, `PRIVILEGED_OPERATIONS`.
- `@english-reader/services`: `createReaderServices(dependencies)` -> `{handleMessage,resumeQueue,close,getPublicSettings}`; `createRpcHandler(dependencies)` -> callable `(request,sender)` with `.resumeQueue()` and `.close()` attached. No listener registered by B.
- `@english-reader/services` also exports `SecretVault`, `ServiceError`, `renderPreview`.
- `@english-reader/storage`: `openReaderStorage(options)` and `ReaderStorage` direct extension-page API. ISO UTC timestamp strings. Never transport book Blobs/base64 via runtime RPC.
- `@english-reader/note-templates`: `renderPreview(draft,{audioFilename?})` -> safe controlled `{front,back}` HTML; exact same field renderer/model definitions used for Anki. Cloze front never contains answer/audio.

See API_CONTRACTS.md for all 25 operations, event schema, permissions, payload bounds and storage methods. These sources are TypeScript ESM with explicit .ts imports, compatible with Vite/TypeScript allowImportingTsExtensions; compiled standalone artifact uses rewriteRelativeImportExtensions.

## Host wiring

1. `const storage = await openReaderStorage()` once in worker; extension library/viewer pages may separately open same database using this API only.
2. `const secrets = new SecretVault({session: chrome.storage.session, local: chrome.storage.local})`. Promise-based Chrome storage APIs are required. `.init()` restricts access with TRUSTED_CONTEXTS where supported. Never pass storage.sync. `getOpenAIKeyForService()` / `getAnkiConnectKeyForService()` are private host injections, not RPC methods.
3. Create service dependencies:
   - storage and secrets above; optional fetch/now for tests only.
   - runtime `{extensionId:chrome.runtime.id, allowedPageUrls:[exact bundled page URLs without query/fragment], isRegisteredReader(sender)}`. Sender is the original MessageSender. `isRegisteredReader` consults a trusted registration/injection ledger, never a boolean in request payload.
   - confirmations `{requireConsent(kind,{request,sender})}` with kinds dictionary, cloud_audio, initialize_models, create_deck, add_duplicate, paid_provider_test. Default is deny. A's trusted confirm.html nonce must bind original sender + request/operation, resolve once, verify exact page and never accept arbitrary caller consent booleans.
   - playback bridge `{playMp3(entry),listVoices(),speakLocal({text,dialect,speed,voiceURI})}` in extension-owned/offscreen document. LocalVoice shape `{voiceURI,lang,localService,default?}`. Re-check localService and exact voiceURI at execution. `playMp3` consumes local bytes; Blob URL lifetime belongs to that document. Do not run Audio or speechSynthesis in worker.
   - onOperationUpdated(event) targets extension-owned UI only. Event is hint; queue.list authoritative.
   - scheduleQueueWake(timestamp|null) updates/clears one chrome.alarms alarm; alarm invokes resumeQueue. No setInterval; resumeQueue on startup too. Browser must be running.
4. Runtime listener keeps response channel open and sends returned envelope. UI wrapper may unwrap success and throw safe error. Do not expose onMessageExternal.
5. Do not add extension pages to public host `isRegisteredReader` path. Known viewer pages belong in exact extension-page allowlist; EPUB document content remains sandboxed and never a trusted page itself.

## Important behavior

- Public preference split: settings.getReader exposes dialect/defaultDeck/defaultMode/includeAudioByDefault/cloudAudioEnabled only; settings.getPublic is privileged.
- Dictionary and cloud audio off by default. Enabling requires host confirmation; no dictionary data is fetched merely because translation ran.
- Secret defaults session. Persistent local explicit opt-in only; local is not encrypted vault. Public responses expose configured flags, never values. Anki key clearing uses settings.update `{patch:{},ankiKey:null}`.
- Lookup context total1500 original UTF16 units; exact selection1–5 words; one active lookup, coalescing, cancellation and complete contextual cache. Refine is explicit gpt-4.1, no automatic upgrade. Any unknown usage omitted, never zeroed. Cache hits have no new usage.
- Note selected translations1–2 same sense. Dictionary claim must match trusted locally recorded adapter provenance. Book/model-provided sources do not become dictionary proof.
- Anki semantic duplicate approval reuses SAME operationId with duplicateAction:add_new only after action-bound confirmation. Fingerprint covers immutable draft/audio intent, not review/add_new decision. Different content requires new operationId, not silent queue mutation.
- Anki add is persisted submitting/uncertain before request. Timeout/lost reply -> reconcile findNotes plus exact notesInfo. No blind retry; allowDuplicate=false and OperationId first field are additional guards, not a claim of native API idempotency.
- Queue has bounded30s/2m/10m retries, manual retry afterward. Audio failures await retry/save_without_audio/cancel. An interrupted TTS attempt is not silently repurchased after restart.
- Cache cap100MiB LRU only disposable lookup/audio. Queued required audio, books and operations never evicted by LRU. Book deletion removes book/progress, never confirmed outbox snapshot.
- Preview/source fields escape HTML, Anki media/cloze/LaTeX syntax. Only chosen occurrence gets c1. URL credentials rejected, queries/fragments stripped, private filesystem labels suppressed.

## Dependencies and verification

No external production dependencies introduced. Per-package package.json only. No root configuration or lockfile changed by B. Offline tests use node:test and fake-indexeddb6.2.6; TypeScript5.9.3 plus @types/node24.10.1 used in an isolated validation directory. Dot a may port execution to its agreed Vitest toolchain, but should retain actual tests and their meaning.

See VALIDATION_REPORT.md for exact final commands/counts and unrun stages; MODEL_VALIDATION.md, PRIVACY_AUDIO.md and ANKICONNECT_SETUP.md for official source checks. Fixtures contain186 cases with per-case expected meanings/variants/provenance and review labels. Agent/self/independent review is not expert human review. 95% semantic accuracy remains target, not a measured result.

## Open Questions

- Live OpenAI model access, strict request shape, language quality and TTS/coral remain untested without safe BYOK + explicit paid-test opt-in/budget. No paid test trigger is silently enabled; providers.test allowPaidTest needs a future bounded host harness and currently fails closed even after generic confirmation.
- Live Anki rendering and audio require a separate test profile. No owner personal collection access.
- Actual Chrome service-worker restart/offscreen/Windows localService behavior depends on A integration and runtime testing.
- Official OpenAI model lifecycle announcement is documented in MODEL_VALIDATION.md. Defaults remain owner-selected model aliases; replacement requires explicit coordinated change.

## Next Steps for dot a/dot b coordination

A: integrate accepted packages, run aggregate strict build/tests, wire nonce confirmations/offscreen/alarms and storage API, independently audit hard language fixtures, validate Windows unpacked build/test-only Anki profile. Report exact failures for B repair.

B: inspect A integration diagnostics, repair owned implementation, rerun affected and aggregate tests. Do not report live or release completion until corresponding evidence exists.
