# Pronunciation, audio, and secret storage

Implementation/check date: **2026-10-20**. This document describes the B2 service boundary, not a claim that the Windows extension or live APIs have passed validation.

## Provider and privacy boundaries

- `PronunciationService` calls only `https://api.dictionaryapi.dev/api/v2/entries/en/<encoded-word>`, and only when the trusted saved dictionary-consent callback returns true. Only a single English word, including internal apostrophes/hyphens, is accepted for dictionary networking. Phrases, paths and arbitrary URLs never become dictionary requests. No surrounding sentence, key, book, title or source URL is sent.
- `AudioService` calls only `https://api.openai.com/v1/audio/speech` after trusted cloud-audio consent. It sends selected text, optional short context and pronunciation/selected-sense discriminator, dialect instructions, fixed model/voice/format and speed. The caller must supply a saved lookup/draft, not an arbitrary untrusted provider request or book metadata. Source context is capped at 1,500 UTF-16 units and text at 500.
- Both clients set `redirect: 'error'`, omit cookies/credentials and referrers, and bound response sizes and total fetch/body time. Returned redirects are also rejected. Provider-generated URLs are not fetched. Injected `fetch` is an internal test/host dependency, not a public configurable provider URL.
- No developer key is embedded, no key is logged, and no raw upstream error/body is included in public errors. API usage is separate from a ChatGPT subscription. Text and cloud audio can incur separate API charges. No price estimate or invented usage is returned for the binary speech response.
- The library, queue, lookup cache, and generated MP3 remain local to the extension. Local storage does not mean encrypted or immune to device compromise.

## Dictionary IPA: what can and cannot be claimed

`PronunciationService.get({expression,dialect,generatedCandidate?})` returns `{pronunciation,alternatives,warnings}` internally. The parent maps this to RPC v1 `{pronunciation,variants,ambiguous}` and warning strings.

- Dictionary entries must match the requested word. Text IPA comes from documented `phonetics[].text` or `phonetic` fields. Audio URLs are not downloaded.
- Every dictionary variant has `dialect: 'unknown'`. Requested dialect, audio filename, entry ordering, or an undocumented response property are not evidence for an accent or contextual sense.
- Multiple distinct IPA strings are never resolved by choosing the first. The reviewed homograph set includes **read, lead, close** and further common heteronyms. Even a single returned IPA for a known homograph is not silently considered context-correct. The set is conservative, not exhaustive.
- A single non-listed dictionary IPA can be displayed as a dictionary-sourced candidate, with both `DICTIONARY_DIALECT_UNVERIFIED` and `DICTIONARY_CONTEXT_UNVERIFIED`. It is not proof that the provider verified the current sentence's meaning.
- A supplied contextual model IPA remains `source: 'generated'`, `sourceUrl: null`, and carries `GENERATED_IPA_APPROXIMATE`. Ambiguous dictionary data never upgrades that candidate to dictionary-verified. A phrase may use this approximate fallback without being sent to the word dictionary.
- All available sanitized entry/phonetic source URLs and licenses are retained in internal alternatives. `licenses[].scope` distinguishes an entry license from a phonetic/audio license; these are not necessarily interchangeable. For the compact RPC license field prefer the entry license. Do not assert that an audio-file license licenses a transcription. URL-only license information is retained internally even when the compact contract cannot represent it.
- Missing dictionary access, no IPA, bad JSON, timeouts and provider failure return warnings, not a failed translation. Warnings are machine codes for A's Russian UI mapping.

## Exportable MP3 and cache

The configured model is **gpt-4o-mini-tts**, voice **coral**, format **mp3**, default dialect **en-US**, default speed **1**. Model or voice is not silently substituted. Official documentation lists this configuration; target-project access and actual audio have not been tested. A specific model snapshot was not pinned without a project-level live verification.

The content-addressed cache key is SHA-256 over a versioned tuple containing exact text, short context, pronunciation/selected-sense discriminator, dialect, voice, model, speed, format, and an optional local-only full selected-sense/range discriminator. A word-only key is not sufficient for known homographs and is rejected when no discriminator/context is supplied. Context and discriminator are both included, not just one or a random model sense ID. Parent should use selected meaning text/definition or validated IPA, not unstable sense IDs. `cacheDiscriminator` (at most 2,048 units) can encode the complete selected meaning and range; it is hashed locally but never included in the TTS request. `createAudioInputCacheKey(input)` uses the same normalization and identity as prepare, so queue reconciliation must use this helper rather than recreate the hash logic.

Successful preparation returns only metadata plus internal cache-hit/warning indicators. An opaque UUID `audioId` resolves to local MP3 bytes. It is not a provider URL or a promise that `speechSynthesis` can export audio. Bytes must pass content-type and basic MP3 signature checks; these detect obvious wrong responses, not full decoding or pronunciation quality. A browser audio smoke test is still required.

The default deadline is 20 seconds, bounded to at most 30 seconds including body reads. The response cap is 10 MiB, error-body cap 64 KiB. Identical simultaneous requests share one promise. There is **no automatic paid retry**, even for a transient error; cancellation/timeout does not guarantee the provider did not bill. `OPENAI_AUTH`, `OPENAI_QUOTA`, `OPENAI_RATE_LIMIT`, `MODEL_UNAVAILABLE`, `NETWORK_TIMEOUT` and `AUDIO_UNAVAILABLE` are differentiated. No alternate model is attempted.

`AI_GENERATED_AUDIO` must be visibly disclosed in the UI. Persisting bytes must succeed before a successful metadata result is returned. Queue integration must keep an audio failure in `awaiting_audio_decision` and expose retry / save_without_audio / cancel; it must not invent a sound field.

### Storage adapter (parent-owned)

`AudioCache` provides `getByCacheKey`, `getById`, and `put`. Its `LocalAudioEntry` contains bytes, MIME type, metadata, cacheKey and ISO timestamps. The production adapter maps this to B's IndexedDB `AudioEntry` Blob representation. Production storage owns the 100 MiB application cache ceiling, LRU access times, atomic replacement, quota handling and protection of all pending queue references. The audio service itself does not evict or clear queue media. Do not use the test-only in-memory cache as production storage.

## Playback adapter (dot a-owned document)

`ExtensionAudioPlayback` is an injected internal bridge:

- `playMp3(entry)` plays locally persisted bytes.
- `listVoices()` returns actual browser/OS voice metadata.
- `speakLocal({text,dialect,speed,voiceURI})` speaks through an exact locally available voice.

The implementation belongs in a **bundled extension-owned document**, such as an offscreen page. Never call `new Audio()` or `speechSynthesis` in the service worker or a webpage/book context. If A uses offscreen, it must declare the `offscreen` permission, create/deduplicate the document, authenticate internal messages and handle document closure. Chrome's `AUDIO_PLAYBACK` reason can close the document after 30 seconds without playback. The bridge should load bytes from the shared local store by audioId rather than serialize an entire book or unrelated data through messaging. Blob URLs are ephemeral local playback handles and must be revoked; they are not exportable audio identities.

Local-only preview accepts `localService === true` and the exact requested en-US/en-GB dialect, with a default local voice preferred. No remote voice or silent wrong-dialect fallback is used. A must handle asynchronous `voiceschanged` before reporting its list and **re-check the selected voice's localService and exact URI at speak time**, since voices can change between calls. Missing local voice/document and playback failure return `AUDIO_UNAVAILABLE`. Local preview returns `{played,method:'local_speech'}` only, never audioId/MP3. The meaning of `played:true` is that the injected bridge confirmed playback started; it does not prove the user heard the whole utterance. The bridge must reject if playback is blocked or not started.

## BYOK and AnkiConnect secrets

`SecretVault` is an internal service adapter over promise-based `chrome.storage.session` and `chrome.storage.local`. `storage.sync` is not accepted as a dependency.

1. Call `init()` before registering RPC or rendering provider-enabled UI. Both available storage areas are restricted to `TRUSTED_CONTEXTS` before reads or writes. Failure to apply a supported restriction fails closed.
2. `setOpenAIKey(key,{persist?:boolean})` and `setAnkiConnectKey` default to session-only. User opt-in is required for `persist:true`. Session-only replacement deletes any old persisted copy. Local storage is not a cryptographic vault.
3. If session storage is absent, fail closed; never silently fall back to persistent storage. If local access-level restriction is unavailable, persistent secret reads/writes are disabled, but session storage remains possible. A normal supported modern Chrome build provides these APIs.
4. `clearOpenAIKey()` and `clearAnkiConnectKey()` attempt removal from both areas, do not clear unrelated extension settings, and report partial failure safely.
5. Mutations are serialized within the service instance. Keep one vault instance per worker; ordinary worker restart reads the selected storage again. Session keys expire when the browser/extension session is cleared, not merely when the worker sleeps. No home-grown encryption is implemented.
6. `status()` exposes configured booleans and storage mode only. `getOpenAIKeyForService()` and `getAnkiConnectKeyForService()` are internal injected provider dependencies and **must never be registered as public RPC operations**. No key prefixes/suffixes are displayed.
7. Parent's sender guard must restrict setters/clearers to approved extension-owned settings pages; matching extension ID alone is insufficient. The vault is not a substitute for authenticating the original Chrome message sender. A public request cannot self-declare trusted status.

## Documentation checked and remaining validation

Official primary references reviewed on 2026-10-20:

- [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech): `gpt-4o-mini-tts`, `coral`, output formats, AI-generated-voice disclosure.
- [OpenAI speech API reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create): fixed speech endpoint, instructions, MP3 and speed range 0.25–4.
- [Free Dictionary API](https://dictionaryapi.dev/): word endpoint and phonetic fields; no claim of documented per-sense/dialect binding.
- [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage): session lifetime, storage access levels and defaults.
- [Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen): offscreen permission, document requirements, runtime messaging, lifecycle.
- [Web Speech API specification](https://webaudio.github.io/web-speech-api/#dom-speechsynthesisvoice-localservice): localService distinguishes local from remote synthesis services.

Mock/contract tests exercise these boundaries. They are not live API availability, licensing completeness, actual MP3 decoding, pronunciation-quality, Windows voices or Chrome offscreen acceptance tests.

Not run: paid OpenAI TTS/live model access (no safely provided key or paid-test budget), live dictionary integration, real Chrome storage access-level inspection, Windows 10/11 local-voice and offscreen tests, real media export to an isolated Anki test profile. There is no production mock-success fallback.

## Integration checkpoint: immutable queue audio (2026-10-20)

The agreed optional `draft: NoteDraft` in `audio.prepare` binds audio preparation to the reviewed card. The service validates exact lookup expression, lemma, part of speech, source sentence and target range; selected sense ID/definition must match and the one or two selected translations must come from that sense. Dictionary-source IPA additionally requires stored provenance proof. No arbitrary draft is silently treated as the lookup result.

`createDraftAudioSnapshot(draft,{dialect,speed})` creates an immutable local snapshot containing version, exact text/context/IPA, resolved dialect/speed, fixed model/voice/format and a local-only semantic discriminator. The discriminator hashes the complete selected translations/definition, lemma, part of speech, original range and IPA provenance. It omits unstable model sense IDs and source URLs; it never truncates meaning to meet a field cap and is never sent to the speech provider. Long valid draft/context combinations therefore remain valid without losing cache identity.

`QueueAudio.snapshot(draft,audioId?)` runs locally for a new save intent, before its atomic durable creation. Queue records persist `audioSnapshot`; `prepare(snapshot)` and `read(audioId,snapshot)` use that exact snapshot on every retry and worker/browser restart, rather than re-reading current defaults. Existing prepared audio contributes its stored speed/dialect only after the full draft-bound cache hash verifies. Changing preferences later does not change a queued card's pronunciation or speed. The first committed snapshot wins repeated/add-race intents; derived global defaults are not allowed to rewrite an existing intent.

Unsupported/missing snapshots and mismatched/missing audio IDs fail closed into the queue's audio-decision flow. An explicit retry may capture current preferences only when no valid snapshot existed; otherwise it retains the original snapshot. There is no silent replacement or model fallback. This is implemented jointly in the parent audio bridge and B3 durable queue.

Legacy `audio.prepare` callers without `draft` can prepare a preview, but receive `AUDIO_REVIEW_DRAFT_BEFORE_SAVE`. Its separately namespaced cache identity cannot attach to a reviewed draft as if translations/IPA had been confirmed. New UI callers should always send the reviewed draft when preparing export audio.

For `audio.play(audioId)`, trusted extension pages may use local cached audio. A reader document may play only an audio ID that its own verified sender scope obtained through `audio.prepare`. The disposable authorization map is bounded to 512 audio IDs and 32 scopes per ID; no permission is inferred from knowing an opaque ID. After a worker restart, re-preparing the same authorized draft can obtain a cache hit and restore the reader's playback scope, without a new paid call.

Verification checkpoint:

- Strict TypeScript with `noUncheckedIndexedAccess`: passed using the temporary validation toolchain; no project dependency/lockfile change by B2.
- B2 tests: **62 passed** (33 audio including integration, 18 pronunciation, 11 secrets).
- Entire then-current B service suite: **191 passed**, zero failures.
- Integration regressions use the actual RPC router and IndexedDB storage with `fake-indexeddb` and injected mocked transports. They verify reviewed-draft consistency, reader ownership, original options across restart, and rejected legacy-preview attachment. These are still not live Chrome/Windows/OpenAI/Anki tests.
