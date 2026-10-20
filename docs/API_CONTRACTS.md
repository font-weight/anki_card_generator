# English Reader RPC and storage v1

Status: technically accepted by dot a through root relay 2026-10-20, including the additive operations/preferences below. Baseline names/semantics preserved. Runtime and live integration remain to be verified.

## Transport, validation, sources

Chrome `runtime.onMessage`, internal extension messaging only. No `onMessageExternal` listener. Request `{v:1, requestId:UUID, type:Operation, payload:object}`. Success `{v:1,requestId,ok:true,data:object,warnings:string[],meta?:Meta}`; error `{v:1,requestId,ok:false,error:{code:ErrorCode,message:string,retryable:boolean}}`. All objects reject unknown fields; strings are bounded and UTF-16 lengths; all numbers finite and safe integers unless expressly decimal. UUID uses canonical hyphenated UUID with version 1–8 and RFC variant. No absent/undefined properties on the wire: optional fields may be omitted, nullable fields must be null when absent. Errors are sanitized Russian-facing descriptions, never raw upstream bodies or keys.

`Meta = {cacheHit?:boolean, model?:"gpt-4.1-mini"|"gpt-4.1", promptVersion?:string<=64, schemaVersion?:"1", usage?:{inputTokens:integer>=0,outputTokens:integer>=0,totalTokens:integer>=0}}`. Omit unknown usage (never invent 0). No cost estimate in v1.

Sender classes: `reader` = own extension ID and a registered content-script document with http/https URL, or own explicit viewer extension page; `page` = exact allowlisted extension-owned popup/options/library/viewer pages. A supplies `extensionId`, exact extension page URL allowlist and a `isRegisteredReader(sender)` predicate; service denies by default. Matching sender ID alone is insufficient for privileged operations; opaque, foreign, external and unexpected schemes denied. The original sender must be checked, not a caller-supplied source field. No user-provided provider URL. HTML source URL never fetched.

`R` below means reader or page. `P` means extension-owned page only. Content iframe/book text cannot select providers or change settings. `add_new`, model creation, cloud audio consent and dictionary consent must follow real UI confirmation; service takes an injected confirmation guard, fail closed when not wired. A supplies trusted UI decisions, not model-produced booleans.

## Shared types

- `Dialect`: en-US | en-GB. `Level`: B1 (fixed v1). Languages: en and ru.
- `Context`: {sentence:string(1..1500),targetStart:integer(0..1499),targetEnd:integer(1..1500),before?:string(0..1500),after?:string(0..1500)}. Sum sentence+before+after <=1500 UTF-16 units. start < end, end <= sentence.length, and sentence.slice(start,end) === expression. Selection 1..5 English words (Intl.Segmenter, en, word granularity, isWordLike; adjacent apostrophe/hyphen compounds count as one lexical word), expression 1..256 units. No normalization before range validation.
- `Sense`: {id:string(1..64),translations:string[1..3],definitionEn:string(1..500)}; translations each 1..200 units. IDs unique within lookup. SelectedSense limits translations to 1..2.
- `ExtraExample`: null | {textEn:string(1..500),textRu:string(1..500),source:"ai"}.
- `Pronunciation`: {ipa:string(1..256)|null,dialect:Dialect|"unknown",source:"dictionary"|"generated"|"unavailable",sourceUrl:http(s)URL|null}. unavailable requires null IPA/sourceUrl and unknown dialect. generated sourceUrl must be null.
- `Source`: {kind:"html"|"pdf"|"epub",title:string(0..500),url:http(s)URL|null,documentId:string(1..128)|null,page:integer>=1|null,chapter:string(0..500)|null,cfi:string(1..2048)|null}. Local paths/file URLs forbidden. html requires page/chapter/cfi null; pdf requires documentId and page, chapter/cfi null; epub requires documentId, page null, chapter and CFI may be null when unavailable (never fabricate page).
- `NoteDraft`: exactly owner specification: sourceLanguage,targetLanguage,mode("recognition"|"cloze"),deckName(1..200),tags(string[0..32],each1..80,no whitespace),expression,lemma(1..256),partOfSpeech(1..80),selectedSense,context(without before/after),pronunciation,extraExample,source. Range must match expression. No API action/HTML allowed to bypass escaping. All NoteDraft fields required.
- `LookupData`: {lookupId:UUID,expression,lemma,partOfSpeech,recommendedSenseId:string|null,contextAmbiguous:boolean,senses:Sense[1..4],ipaCandidate:null|{ipa:string(1..256),dialect:Dialect|"unknown"},extraExample:ExtraExample}. Recommended ID must exist; ambiguous requires recommendedSenseId null. Base lookup extraExample is null. Service creates lookupId and copies original expression, never trusts model identity/source.
- `OperationState`: pending | preparing_audio | awaiting_audio_decision | awaiting_duplicate_decision | ready | submitting | reconciling | synced | failed | cancelled.
- `SafeError`: {code:ErrorCode,message:string(1..500),retryable:boolean}.
- `QueueItem`: {operationId:UUID,draft:NoteDraft,includeAudio:boolean,audioId:UUID|null,duplicateAction:"review"|"add_new",state:OperationState,attempts:integer>=0,lastError:SafeError|null,noteId:integer>=1|null,createdAt:ISO8601,updatedAt:ISO8601,nextAttemptAt:ISO8601|null}. Full confirmed immutable draft; no lookup-only snapshots or secrets. All fields required.
- `AudioMetadata`: {audioId:UUID,text:string(1..500),dialect:Dialect,voice:"coral",model:"gpt-4o-mini-tts",speed:number(0.25..4),format:"mp3",byteLength:integer(1..10485760),createdAt:ISO8601}. Never contains remote URLs or base64.
- `PronunciationVariant`: {ipa:string(1..256),dialect:Dialect|"unknown",source:"dictionary",sourceUrl:http(s)URL|null,license:null|{name:string(1..200),url:http(s)URL|null}}.
- `PublicSettings`: {learnerLevel:"B1",dialect:Dialect,dictionaryEnabled:boolean,cloudAudioEnabled:boolean,includeAudioByDefault:boolean,defaultDeck:string(1..200),defaultMode:"recognition"|"cloze",openAIKeyPersistence:"session"|"local",ankiKeyPersistence:"session"|"local",ankiEndpoint:"http://127.0.0.1:8765"|"http://localhost:8765",audioVoice:"coral",audioSpeed:number(0.25..4),cacheLimitBytes:104857600,hasOpenAIKey:boolean,hasAnkiKey:boolean}. Defaults B1/en-US/false/false/false/Default/recognition/session/session/127.0.0.1/coral/1/100MiB/false/false. Endpoint choices fixed v1, no arbitrary host/port.

## Operations, strict payload and data schemas

Each row specifies the exact object fields. Empty `{}` means no fields permitted. Fields with `?` optional, all other fields required.

| Operation | Source | Payload | Data |
|---|---|---|---|
| lookup | R | {expression,context:Context,sourceLanguage:"en",targetLanguage:"ru",learnerLevel:"B1",dialect:Dialect} | LookupData |
| lookup.refine | R | {lookupId:UUID,reason?:string(1..500)} | LookupData; explicit gpt-4.1 only, original saved short context, context must remain available |
| lookup.cancel | R | {lookupId?:UUID,requestId?:UUID}; at least one | {cancelled:boolean}; own sender scope only; cancellation never guarantees no billing |
| pronunciation.get | R | {lookupId:UUID} | {pronunciation:Pronunciation,variants:PronunciationVariant[0..16],ambiguous:boolean}; service uses saved expression/lemma; dictionary opt-in; no guessed homograph selection |
| card.enrich | R | {lookupId:UUID,senseId:string(1..64)} | {lookupId:UUID,senseId:string,extraExample:non-null ExtraExample}; explicit gpt-4.1-mini request |
| audio.prepare | R | {lookupId:UUID,senseId:string(1..64),speed?:number(0.25..4),draft?:NoteDraft} | AudioMetadata; cloud opt-in required; selected sense/context in cache key, no API URL |
| audio.play | R | {lookupId?:UUID,audioId?:UUID}; exactly one | {played:boolean,method:"local_speech"|"cached_audio"}; extension-owned document playback callback; local speech requires localService=true; no Audio in SW |
| anki.decks | P | {} | {deckNames:string[0..10000]} |
| anki.createDeck | P | {deckName:string(1..200)} | {deckName:string,deckId:integer>=1}; explicit action-bound confirmation |
| anki.status | R | {} | {available:boolean,version:integer|null,error:SafeError|null} |
| anki.configuration | P | {} | {endpoint:PublicSettings.ankiEndpoint,origin:string,deckNames:string[0..10000],models:[{name:string,exists:boolean,compatible:boolean}]} |
| anki.initializeModels | P | {} | {created:string[0..2],existing:string[0..2]}; onboarding confirmed guard required; never overwrite mismatch |
| anki.findDuplicates | R | {draft:NoteDraft} | {lexemeKey:string,contentKey:string,matches:[{noteId:integer>=1,modelName:string,expression:string,meaning:string,exactContent:boolean}]} |
| anki.addNote | R | {operationId:UUID,draft:NoteDraft,includeAudio:boolean,audioId?:UUID,duplicateAction?:"review"|"add_new"} | {operationId:UUID,status:"added"|"queued"|"already_added"|"duplicate_review",noteId:integer>=1|null}; duplicateAction defaults review; add_new requires explicit confirmation guard; immutable persisted snapshot before network |
| anki.openNote | R | {noteId:integer>=1} | {opened:boolean}; only EnglishReader-owned note, read and verify model before guiBrowse |
| queue.list | P | {states?:OperationState[1..11],limit?:integer(1..100),cursor?:string(1..128)} | {items:QueueItem[0..100],nextCursor:string|null}; default100; stable createdAt/operationId cursor |
| queue.retry | P | {operationId:UUID} | {operation:QueueItem}; manual retry same snapshot/operationId; reconciles uncertain first |
| queue.cancel | P | {operationId:UUID} | {operation:QueueItem}; pending cancellable; submitting/reconciling conflict until reconciliation; never delete created note |
| queue.resolveAudio | P | {operationId:UUID,action:"retry"|"save_without_audio"|"cancel"} | {operation:QueueItem}; awaiting_audio_decision only |
| settings.getReader | R | {} | {dialect:Dialect,defaultDeck:string(1..200),defaultMode:"recognition"|"cloze",includeAudioByDefault:boolean,cloudAudioEnabled:boolean} |
| settings.getPublic | P | {} | PublicSettings |
| settings.update | P | {patch:{dialect?:Dialect,dictionaryEnabled?:boolean,cloudAudioEnabled?:boolean,includeAudioByDefault?:boolean,ankiEndpoint?:PublicSettings.ankiEndpoint,audioSpeed?:number(0.25..4),defaultDeck?:string(1..200),defaultMode?:"recognition"|"cloze"},ankiKey?:string(1..512)|null,persistAnkiKey?:boolean}; nonempty patch or ankiKey; persistAnkiKey only with key | PublicSettings; consent changes verified by injected guard; Anki secret never in response |
| secrets.setOpenAIKey | P | {key:string(10..512),persist?:boolean}; defaultfalse | {configured:true,persistence:"session"|"local"}; no key read operation |
| secrets.clearOpenAIKey | P | {} | {configured:false}; remove session and local copies |
| providers.test | P | {provider:"openai"|"dictionary"|"anki",allowPaidTest?:boolean}; defaultfalse | {provider,ok:boolean,checkedAt:ISO8601,model:string|null,error:SafeError|null}; openai defaults read-only /models check, not StructuredOutput proof; live paid format test only explicit optin and injected budget approval |

`settings.update` Anki-key provision is an additive proposed schema choice because the mandatory operation list has no dedicated Anki-secret setter. To clear Anki key, proposed `ankiKey:null` (nullable only here) with persistAnkiKey omitted. All secrets restricted to P. Dot a explicitly approved this nullable shape.

## Events and lifecycle

`{v:1,type:"operation.updated",data:{operationId:UUID,state:OperationState,noteId:integer|null,error:SafeError|null}}`. Only extension-owned UI destinations, no broadcast to arbitrary tabs; event is a hint, durable storage authoritative. A forwards listener lifecycle/alarm/offscreen ports to B service instance. A must re-read queue on reconnect. Provider abort error is `REQUEST_CANCELLED` and incomplete is `MODEL_INCOMPLETE` (additive codes). No serviceworker entry from B.

## Error catalogue

Required codes: INVALID_INPUT (input/range/length/schema), PERMISSION_DENIED (sender/consent), EXTRACTION_FAILED (empty/unusable reader context), OPENAI_AUTH, OPENAI_QUOTA, OPENAI_RATE_LIMIT, MODEL_UNAVAILABLE, MODEL_REFUSAL, INVALID_MODEL_OUTPUT, NETWORK_TIMEOUT, DICTIONARY_UNAVAILABLE, AUDIO_UNAVAILABLE, ANKI_UNAVAILABLE, ANKI_AUTH, ANKI_ORIGIN_DENIED, ANKI_SCHEMA_MISMATCH, STORAGE_QUOTA, OPERATION_CONFLICT.

Additive codes: REQUEST_CANCELLED, MODEL_INCOMPLETE, LOOKUP_EXPIRED, ANKI_DECK_NOT_FOUND, STORAGE_UNAVAILABLE, INTERNAL_ERROR. Retryable only transient timeout/rate limit/network/offline/storage access; authorization/quota/invalidinput/schema/conflict/refusal not automatically retried. Missing lookup cache produces LOOKUP_EXPIRED, not new unrequested model call. Maximum one controlled OpenAI retry within total request deadline; only safe eligible 429/5xx transient errors, never auth/quota/model unavailable. Anki uncertain add must reconcile, irrespective of generic retryable flag.

Success example: `{"v":1,"requestId":"3fbc6d2e-806b-4cae-8878-6b11c46b6901","ok":true,"data":{"operationId":"84340d08-9f93-4357-8549-e7611a509eae","status":"queued","noteId":null},"warnings":[]}`.
Error example: `{"v":1,"requestId":"3fbc6d2e-806b-4cae-8878-6b11c46b6901","ok":false,"error":{"code":"INVALID_INPUT","message":"Диапазон не совпадает с выбранным выражением.","retryable":false}}`.

## Storage API for A: local direct import, not Blob runtime RPC

B exports `openReaderStorage({indexedDB?,quotaEstimator?,now?})` and `ReaderStorage` API from packages/storage. Database `english-reader`, schema version1. A imports API into extension-owned library/viewer pages; B alone owns migrations. No whole book/base64 crosses runtime messaging.

Stores/keypaths: lookupCache/key; audioCache/audioId with unique cacheKey index; outbox/operationId with state, createdAt, nextAttemptAt indexes; libraryBooks/documentId; readingProgress/documentId; metadata/key. Cache entries have byteLength,lastAccessedAt,createdAt. Queue includes immutable payload fingerprint and lease metadata internal-only. Upgrades are monotonic and transactional; unknown newer database fails explicitly.

Methods:
- `getLookup(key):Promise<LookupCacheEntry|null>`, `putLookup(entry):Promise<void>`, `findLookup(lookupId):Promise<LookupCacheEntry|null>`; entries include validated request + result + model/prompt/schema/usage, no secret or source URL.
- `getAudio(audioId):Promise<AudioEntry|null>`, `findAudio(cacheKey):Promise<AudioEntry|null>`, `putAudio(entry):Promise<void>`; entry contains Blob + metadata + cacheKey, not temporaryURL; library/queue refs protect bytes.
- `getOperation(id)`, `putOperation(record)` internal, `createOperation(record):Promise<{created:boolean,record}>` atomic add/read fingerprint check, `listOperations({states?,limit?,cursor?})`, `mutateOperation(id,mutator)` atomic read/modify/write for claiming; no asynchronous external work inside IDB transaction.
- `saveBook({blob,kind:"pdf"|"epub",title,mimeType}):Promise<BookMetadata>`; SHA256 bytes fingerprint `documentId="sha256:"+hex`; stored only local. BookMetadata = {documentId,kind,title,mimeType,byteLength,createdAt,updatedAt}; title<=500, file<=250MiB, quota checked. `getBook(id):Promise<{metadata,blob}|null>`, `listBooks():Promise<BookMetadata[]>`, `deleteBook(id):Promise<void>` removes book/progress only, never outbox snapshot. A confirms user deletion in UI before call.
- `saveProgress({documentId,kind:"pdf",page:integer>=1,offset:number(0..1),updatedAt})` or `{documentId,kind:"epub",chapter:string|null,cfi:string(1..2048),updatedAt}`. `getProgress(id):Promise<ReadingProgress|null>`. Discriminants strict; stored book must exist with matching kind.
- `getMetadata(key)`, `setMetadata(key,value)` internal trusted settings; never secrets.
- `pruneCaches():Promise<{removedBytes:number}>`, `estimateStorage():Promise<{usage:number|null,quota:number|null,cacheBytes:number}>`, `close()`.

Cache cap100MiB. LRU applies only lookup/audio, never library/outbox. Audio referenced by unfinished outbox is protected. Cancelled and synced operations do not pin disposable audio; synced confirms that required media and note exist in Anki. If protected data alone exhausts capacity new optional cache may be skipped/evicted, never drop queued data. All writes map QuotaExceededError to STORAGE_QUOTA; quota estimation advisory, write failures still handled. No clear-pending API. Blob fingerprints computed locally, never uploaded.

## Host integration contract

`createReaderServices({storage, secrets, fetch, runtime:{extensionId,allowedPageUrls,isRegisteredReader}, playback, confirmations, onOperationUpdated, scheduleQueueWake, now, crypto})` returns `{handleMessage(message,sender):Promise<Response>,resumeQueue():Promise<void>,close():void}`. A owns actual onMessage listener (return true / async response), chrome.alarms and offscreen document. `scheduleQueueWake(timestamp|null)` only schedules earliest durable nextAttemptAt, never setInterval; backoff 30s/2m/10m bounded, manual retry afterward. Startup resume converts uncertain submitting to reconciling and restores due work. API key session access restricted TRUSTED_CONTEXTS via initialization. No opening arbitrary user URLs, book fetches, or remote custom endpoints.

Confirmation guard methods: `requireConsent(kind:"dictionary"|"cloud_audio"|"initialize_models"|"create_deck"|"add_duplicate"|"paid_provider_test",context):Promise<boolean>`. For saved dictionary/audio settings it verifies recorded user choice; initialize_models/add_duplicate/paidtest requires action-bound UI confirmation. A must not return true unconditionally. Exact callback wiring is integration-only, no additional public RPC fields.

## Validation evidence

Contract schemas/types/tests and B implementation are local proposals pending dot a confirmation. Mock/contract tests do not prove live provider/model availability, browser IndexedDB compatibility or actual Anki note rendering. Live OpenAI requires safe BYOK + explicit budget; live Anki requires isolated test profile. Both presently not_run.

Host confirmation implementation agreed: A opens trusted confirm.html with a nonce bound to original sender, request ID and operation. Resolve exactly once, verify the exact extension-page allowlist; arbitrary caller flags do not grant approval. Reader-only settings intentionally exclude secret/provider flags. createRpcHandler(dependencies) is an alias of the transport-independent handler factory; A owns async UI wrapper and runtime entry.

Audio draft amendment (dot a accepted): audio.prepare optionally takes the complete confirmed NoteDraft. Service verifies lookup expression, lemma, part of speech, exact context/range, sense ID/definition and chosen translations against the saved lookup, and validates dictionary provenance. This produces reusable audio bound to the exact draft; draft-less preparation remains preview-only. The immutable outbox saves a local AudioSnapshot containing dialect/speed/model/voice/format and a complete semantic discriminator; retry/restart never recomputes from mutable preferences. Source query strings and fragments are stripped before Anki fields.

Dictionary provenance: sanitized complete source URL lists and scoped entry/phonetic licenses are retained in the lookup-cache entry as internal pronunciationProvenance, counted under100MiB cache cap. Compact public variants expose entry license only, not a falsely attributed phonetic/audio license.

## Isolated Anki validation mode (host-only amendment)

A's personal Anki may occupy8765. The isolated test profile is on exactly http://127.0.0.1:18765. Do not stop, change or validate against the personal profile.

`createReaderServices({...dependencies, isolatedAnkiTestMode:true})` requires storage opened with `name:"english-reader-isolated-anki-test-v1"` (exported ISOLATED_TEST_DATABASE_NAME). It forces every Anki call to18765, ignores no endpoint errors and never falls back to8765. Normal mode refuses that database. Public configuration/settings reads report effective18765 truthfully, but settings.update cannot select18765, arbitraryports or change endpoint/Anki secret in test mode. Existing production Anki secrets are not reused for the testprofile. Public read AnkiEndpoint union adds18765 for truthful diagnostics only; writable ProductionAnkiEndpoint remains original8765 allowlist.

AnkiClient's host constructor `isolatedTestMode:true` permits only the exact testendpoint (or omitted endpoint, which resolves to it); false/default never permits18765. Each outbox record persists `targetIdentity` before any external call and includes it in immutable intent fingerprint. Runtime target mismatch fails before any Anki read/write. Legacy records lacking targetIdentity are blocked on both endpoints with OPERATION_CONFLICT; data is preserved for explicit review/new intent, never implicitly migrated. No target selector is accepted from reader RPC. This is testprofile isolation, not arbitrary custom-network support.

Privileged page sender defense: exact extension-page URL is necessary but insufficient. sender.frameId must be0 or absent; nested frame4 etc is denied even when URL matches settings. Reader registration remains separately scoped.


A integration privacy correction: anki.decks is privileged (extension-owned pages only). HTML page popups never render deck names and use the trusted settings chooser. Shadow DOM is not a confidentiality boundary.

Chrome runtime correction: production endpoints are IPv4 literal loopback 8765 or localhost (transport canonicalizes to 127.0.0.1). IPv6 literal was removed after Chrome ignored its CSP source. The separate constructor-only 18765 test mode is unchanged.
