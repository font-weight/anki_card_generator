# Service layer validation report

Checked 2026-10-20. Node24.19.0. Current complete offline suite: **211 tests passed, 0 failed, 0 skipped**. This number is test cases, not language-quality score.

## Executed

1. Strict TypeScript5.9.3 check: ES2023, NodeNext, strict, noUncheckedIndexedAccess, DOM libraries, noEmit, all packages and tests. Exit0.
2. `node --experimental-strip-types --test tests/*.test.ts`:211 passed. Uses injected HTTP/service adapters and fake-indexeddb6.2.6. No live provider access.
3. Standalone JavaScript/declarations emitted by TypeScript with rewriteRelativeImportExtensions. All four packages compile; Node imports compiled services successfully. Confirmed exports SecretVault, ServiceError, createReaderServices, createRpcHandler, renderPreview.
4.186 language fixture inputs validated against original UTF16 substring and production lookup validator. Authored expected labels are not a measured model result. Dot a independently confirmed all186 selection ranges; difficult semantic audit pending.

## Covered

- All25 RPC operations have strict input/output schemas. Unknown fields including inherited constructor/toString/__proto__ names rejected; lengths, languages, ranges, nullable semantics, selection count, source URLs and nested queued draft semantics validated.
- Sender ID, exact extension-page allowlist and registered-reader checks; privileged operations inaccessible to reader contexts. Same browser document owns lookup/audio capabilities; spoofed/foreign senders denied before provider actions.
- OpenAI exact endpoint/model/schema, refusal/incomplete/invalid JSON, quota/auth/ratelimit/modelunavailable, total budgets, bounded bodies, deduplication, independent cancellation, contextualcache and fallback when disposablecache writefails. No secrets in errors.
- Dictionary opt-in, word-only requests, IPA provenance/license scopes, conservative read/lead/close/homograph handling. Local voices require localService=true. TTS fixedMP3/model/voice, fullkey, consent, deadlines, media bounds and immutable queue snapshot.
- Safe templates, oneRecognition template, actual cloze definition, selected occurrence only, Anki syntax/HTML escaping, source query/fragment stripping, semantic duplicate hashes independent of unstable model sense ID.
- Anki fixed loopback/no redirects, protocol6, HTTP200 error checking, deck/schema mismatch, media returnedfilename, exactnotesinfo reconciliation, own-note opening, createDeck confirmation.
- Durable operation creation before external call, CAS/lease concurrency, repeatedsameintent, alteredintentconflict, lostaddreply reconciliation, workerrestart before/after send, boundedbackoff, audio failure decisions and frozenpreferences acrossrestart.
- Fake IndexedDB creation/reopen/newerversion rejection, atomiccreate/CAS, quota,100MiB disposableLRU preservingqueueaudio andlibrary, localfingerprint books/progress/delete separation.
- Mock vertical workflow: lookup -> full validated draft -> real Anki productionadapter with fake HTTP -> noteId -> sameoperation repeat returns already_added with oneaddcall.

## Not run / limits

- Actual browser IndexedDB transaction behavior and quota exhaustion: not_run (fake-indexeddb test only).
- Windows Chrome MV3 build, workertermination, alarms, offscreen playback and local speech voices: A integration responsibility, no evidence claimed by B.
- Live OpenAI model availability, strictschema acceptance, semanticaccuracy, TTS/coral: not_run. Owner explicitly approved a USD5 shared A+B project ceiling; no safely supplied key exists here. A owns future paid-test execution and a single shared spend ledger; B will not start parallel paid tests. No paidcalls were made. Test harness must enforce budget before live execution.
- Live dictionary endpoint: not_run; official documented structure and mockresponses tested.
- Live Anki actual addon capabilities, isolatedprofile rendered Recognition/Cloze/media/duplicates: not_run. Separate testprofile allowed, personalcollection never touched. findModelsByName capability is failclosed and requires actual addon verification.
- Lint/wholeextension productionbundle/Windowsinstallation: not_run by B; root config belongs to A.
- Expert human languagegoldreview: not_run. Independent A hardcase semanticreview pending. >=95% is target, not reported achievement.

## Reproduce without root lockfile changes

Per-package runtime code has no thirdparty dependency. Tests require fake-indexeddb6.2.6; tests/package.json pins it. B validation installed TypeScript5.9.3 and @types/node24.10.1 only in an isolated temporary directory. Root dependency/toolchain changes are left to A.

No remote push/publication by B. Source and compiled packages are checkpoints for A integration, not store-release artifacts.

Final integration hardening: Intl.Segmenter English word counting agrees with A extractor (comma separators and single-word apostrophe/hyphen compounds tested); unfinished queue audio pinned by both predicted cache key and assigned audio ID before network/cache insertion; synced audio becomes disposable after confirmed Anki commit so the100MiB cap cannot fill permanently with completed work.

## Independent integration review and revision2

Independent agent review reproduced the missing crash-recovery alarm, then verified the fix: a lease-expiry watchdog is armed before external read/TTS/media/add and refreshed before send; hanging UI hints cannot block it. Scheduler errors fail closed before mutation, and post-send storage failures retain the alarm. No claim of human expert review is made.

Independent isolated-profile review exercised34 mocked Anki dispatches across routed actions. Every call used literal127.0.0.1:18765 with redirect:error and without the production Anki secret, even when stored preferences named8765 and caller dependencies were later mutated. Both target-mismatched and target-less legacy queue records were preserved and blocked before any network call. Privileged matching-URL frames1/4/99/-1 were denied, frame0 accepted. Independent full211-test and strict-TypeScript reruns passed.

No real Anki call was made by B or its offline reviewer. A must still validate the dedicated Windows test profile at18765; personal Anki8765 is expressly excluded.

Future test-budget adjustment belongs to A's single harness configuration/ledger, not an implied OpenAI account billing limit. Changes must preserve cumulative spent and reserved amounts; unknown billing is never zero. Current authorized total is USD5 shared A+B; no safe key or paid call yet.
