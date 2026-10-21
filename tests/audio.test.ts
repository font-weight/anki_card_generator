import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioService, AudioServiceError, MAX_AUDIO_BYTES, TTS_ENDPOINT, createAudioCacheKey, createAudioInputCacheKey, createDraftAudioSnapshot, freezeAudioInput, validateAudioSnapshot, selectLocalVoice,
} from '../packages/services/src/audio.ts';
import type { AudioCache, AudioServiceOptions, ExtensionAudioPlayback, LocalAudioEntry, AudioDraft, AudioSnapshot } from '../packages/services/src/audio.ts';

// Synthetic header fixture tests transport validation only, not decoding or auditory quality.
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
const input = { text: 'read', context: 'I read the book yesterday.', pronunciation: '/rɛd/', dialect: 'en-US' as const, speed: 1 };
const uuid = 'c04f8451-3d8b-411a-b71a-75035f17bed0';
const testKey = 'unit-test-openai-credential';
const ok = () => new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });
function cache(): AudioCache & { entries: Map<string, LocalAudioEntry> } {
  const entries = new Map<string, LocalAudioEntry>();
  return { entries, async getById(id) { return entries.get(id) ?? null; },
    async getByCacheKey(key) { return [...entries.values()].find(entry => entry.cacheKey === key) ?? null; },
    async put(entry) { entries.set(entry.audioId, entry); },
  };
}
function service(extra: Partial<AudioServiceOptions> = {}) {
  return new AudioService({ fetch: async () => ok(), getOpenAIKey: () => testKey,
    hasCloudAudioConsent: () => true, cache: cache(), createId: () => uuid,
    now: () => new Date('2026-10-20T17:00:00Z'), ...extra });
}
function playback(extra: Partial<ExtensionAudioPlayback> = {}): ExtensionAudioPlayback {
  return { async playMp3() {}, async listVoices() { return [{ voiceURI: 'local-en-us', lang: 'en-US', localService: true }]; }, async speakLocal() {}, ...extra };
}

test('TTS sends bounded text/context to the fixed endpoint and stores local MP3 bytes', async () => {
  const local = cache();
  const audio = service({ cache: local, fetch: async (url, options) => {
    assert.equal(url, TTS_ENDPOINT);
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.equal((options?.headers as Record<string, string>).Authorization, `Bearer ${testKey}`);
    const body = JSON.parse(options?.body as string);
    assert.equal(body.model, 'gpt-4o-mini-tts');
    assert.equal(body.voice, 'coral');
    assert.equal(body.response_format, 'mp3');
    assert.equal(body.input, 'read');
    assert.ok(body.instructions.includes(input.context));
    return ok();
  } });
  const result = await audio.prepare(input);
  assert.deepEqual(result.metadata, { audioId: uuid, text: 'read', dialect: 'en-US', voice: 'coral', model: 'gpt-4o-mini-tts',
    speed: 1, format: 'mp3', byteLength: mp3.length, createdAt: '2026-10-20T17:00:00.000Z' });
  assert.deepEqual(result.warnings, ['AI_GENERATED_AUDIO']);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(local.entries.get(uuid)?.bytes, mp3);
  assert.ok(!JSON.stringify(result).includes(testKey));
  assert.ok(!JSON.stringify(result).includes('http'));
});

test('cloud TTS requires consent and key before any paid request', async () => {
  let requests = 0;
  const fetch = async () => { requests++; return ok(); };
  await assert.rejects(service({ fetch, hasCloudAudioConsent: () => false }).prepare(input), { code: 'PERMISSION_DENIED' });
  await assert.rejects(service({ fetch, getOpenAIKey: () => null }).prepare(input), { code: 'OPENAI_AUTH' });
  assert.equal(requests, 0);
});

test('audio cache key includes every pronunciation-relevant component', async () => {
  const identity = { ...input, context: input.context, pronunciation: input.pronunciation,
    voice: 'coral', model: 'gpt-4o-mini-tts', format: 'mp3' };
  const baseline = await createAudioCacheKey(identity);
  assert.match(baseline, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await createAudioCacheKey({ ...identity }), baseline);
  for (const changed of [ { text: 'Read' }, { context: 'I read every day.' }, { pronunciation: '/riːd/' },
    { dialect: 'en-GB' as const }, { speed: 0.8 }, { voice: 'other' }, { model: 'future' }, { format: 'wav' } ]) {
    assert.notEqual(await createAudioCacheKey({ ...identity, ...changed }), baseline);
  }
});

test('cache hit and concurrent identical prepare avoid a second paid request', async () => {
  let requests = 0;
  const audio = service({ fetch: async () => { requests++; await new Promise(resolve => setTimeout(resolve, 5)); return ok(); } });
  const [first, second] = await Promise.all([audio.prepare(input), audio.prepare(input)]);
  assert.deepEqual(first.metadata, second.metadata);
  assert.equal(requests, 1);
  const cached = await audio.prepare(input);
  assert.equal(cached.cacheHit, true);
  assert.equal(requests, 1);
});

for (const text of ['read', 'lead', 'close']) {
  test(`ambiguous ${text} cannot use word-only cloud cache`, async () => {
    await assert.rejects(service().prepare({ text }), { code: 'INVALID_INPUT' });
  });
}

test('validates size, speed, dialect and generated pronunciation discriminator', async () => {
  for (const invalid of [{ text: '' }, { text: 'x'.repeat(501) }, { ...input, speed: Infinity }, { ...input, speed: 0.1 },
    { ...input, context: 'x'.repeat(1501) }, { ...input, pronunciation: '' }]) {
    await assert.rejects(service().prepare(invalid), { code: 'INVALID_INPUT' });
  }
});

for (const [status, body, code] of [
  [401, { error: { message: testKey } }, 'OPENAI_AUTH'],
  [403, { error: { message: testKey } }, 'OPENAI_AUTH'],
  [429, { error: { code: 'insufficient_quota', message: testKey } }, 'OPENAI_QUOTA'],
  [429, { error: { code: 'rate_limit_exceeded', message: testKey } }, 'OPENAI_RATE_LIMIT'],
  [404, { error: { code: 'model_not_found', message: testKey } }, 'MODEL_UNAVAILABLE'],
  [400, { error: { code: 'unsupported_model', message: testKey } }, 'MODEL_UNAVAILABLE'],
  [500, { error: { message: testKey } }, 'AUDIO_UNAVAILABLE'],
] as const) {
  test(`safe TTS ${status}/${code}, no automatic retry or model fallback`, async () => {
    let requests = 0;
    const local = cache();
    await assert.rejects(service({ cache: local, fetch: async () => { requests++; return new Response(JSON.stringify(body), { status }); } }).prepare(input), error => {
      assert.equal((error as AudioServiceError).code, code);
      assert.ok(!String(error).includes(testKey));
      assert.ok(!JSON.stringify(error).includes(testKey));
      return true;
    });
    assert.equal(requests, 1);
    assert.equal(local.entries.size, 0);
  });
}

test('network exception text is sanitized', async () => {
  await assert.rejects(service({ fetch: async () => { throw new Error(testKey); } }).prepare(input), error => {
    assert.equal((error as AudioServiceError).code, 'AUDIO_UNAVAILABLE');
    assert.ok(!String(error).includes(testKey)); return true;
  });
});

test('deadline covers the whole response body and aborts fetch', async () => {
  let signal: AbortSignal | null | undefined;
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const audio = service({ timeoutMs: 5, fetch: async (_, options) => { signal = options?.signal; return new Response(stalled); } });
  await assert.rejects(audio.prepare(input), { code: 'NETWORK_TIMEOUT' });
  assert.equal(signal?.aborted, true);
});

test('oversized, empty, wrong-content-type and non-MP3 success responses never create audio', async () => {
  for (const response of [new Response(mp3, { headers: { 'content-length': String(MAX_AUDIO_BYTES + 1) } }),
    new Response(''), new Response('{}', { headers: { 'content-type': 'application/json' } }), new Response('not mp3')]) {
    const local = cache();
    await assert.rejects(service({ cache: local, fetch: async () => response }).prepare(input), { code: 'AUDIO_UNAVAILABLE' });
    assert.equal(local.entries.size, 0);
  }
});

test('streaming size limit applies even without content-length', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES + 1)); controller.close(); } });
  await assert.rejects(service({ fetch: async () => new Response(stream) }).prepare(input), { code: 'AUDIO_UNAVAILABLE' });
});

test('unexpected redirected response is rejected without storing bytes', async () => {
  const response = ok(); Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(service({ fetch: async () => response }).prepare(input), { code: 'AUDIO_UNAVAILABLE' });
});

test('failure to persist does not return a pretend audioId', async () => {
  const local = cache();
  local.put = async () => { throw new AudioServiceError('STORAGE_QUOTA', 'Storage full'); };
  await assert.rejects(service({ cache: local }).prepare(input), { code: 'STORAGE_QUOTA' });
});

test('cached playback delegates only to the extension-owned document callback', async () => {
  let played = false;
  const audio = service({ playback: playback({ async playMp3(entry) { played = true; assert.deepEqual(entry.bytes, mp3); } }) });
  const prepared = await audio.prepare(input);
  assert.deepEqual(await audio.playCached(prepared.metadata.audioId), { played: true, method: 'cached_audio' });
  assert.equal(played, true);
});

test('missing playback document/audio fails honestly', async () => {
  const audio = service();
  await audio.prepare(input);
  await assert.rejects(audio.playCached(uuid), { code: 'AUDIO_UNAVAILABLE' });
  await assert.rejects(audio.playCached('d04f8451-3d8b-411a-b71a-75035f17bed0'), { code: 'AUDIO_UNAVAILABLE' });
  await assert.rejects(audio.playLocal({ text: 'hello' }), { code: 'AUDIO_UNAVAILABLE' });
});

test('local speech only uses localService true with an exact dialect; never exports an MP3', async () => {
  let spoken = false;
  const audio = service({ hasCloudAudioConsent: () => false, fetch: async () => { throw new Error('network forbidden'); }, playback: playback({
    async listVoices() { return [{ voiceURI: 'remote', lang: 'en-US', localService: false },
      { voiceURI: 'wrong-dialect', lang: 'en-GB', localService: true }, { voiceURI: 'local-us', lang: 'en_US', localService: true }]; },
    async speakLocal(data) { spoken = true; assert.equal(data.voiceURI, 'local-us'); },
  }) });
  const result = await audio.playLocal({ text: 'hello' });
  assert.deepEqual(result, { played: true, method: 'local_speech' });
  assert.equal(spoken, true);
  assert.ok(!('audioId' in result));
});

test('remote-only voice lists and wrong dialect produce unavailable, not silent network fallback', async () => {
  assert.equal(selectLocalVoice([{ voiceURI: 'remote', lang: 'en-US', localService: false }], 'en-US'), null);
  await assert.rejects(service({ playback: playback({ async listVoices() { return [{ voiceURI: 'gb', lang: 'en-GB', localService: true }]; } }) }).playLocal({ text: 'hello' }), { code: 'AUDIO_UNAVAILABLE' });
});

test('full cache discriminator stays local and input helper matches the persisted key', async () => {
  const local = cache();
  const sensitiveIdentity = 'full-selected-meaning-and-range-not-provider-context';
  const request = { ...input, cacheDiscriminator: sensitiveIdentity };
  const audio = service({ cache: local, fetch: async (_, options) => {
    assert.ok(!String(options?.body).includes(sensitiveIdentity));
    return ok();
  } });
  await audio.prepare(request);
  assert.equal(await createAudioInputCacheKey(request), local.entries.get(uuid)?.cacheKey);
  assert.notEqual(await createAudioInputCacheKey(request), await createAudioInputCacheKey({ ...request, cacheDiscriminator: 'another-full-sense' }));
  await assert.rejects(audio.prepare({ ...request, cacheDiscriminator: 'x'.repeat(2049) }), { code: 'INVALID_INPUT' });
});

const audioDraft: AudioDraft = {
  expression: 'read', lemma: 'read', partOfSpeech: 'verb',
  selectedSense: { id: 'unstable-model-id', translations: ['читать'], definitionEn: 'Understand written words.' },
  context: { sentence: 'I read the book yesterday.', targetStart: 2, targetEnd: 6 },
  pronunciation: { ipa: '/rɛd/', dialect: 'unknown', source: 'generated', sourceUrl: null },
};

test('draft audio snapshot freezes resolved defaults, complete semantic identity and provider configuration', async () => {
  const draft = structuredClone(audioDraft), preferences = { dialect: 'en-GB' as const, speed: 0.8 };
  const promise = createDraftAudioSnapshot(draft, preferences);
  draft.selectedSense.translations[0] = 'изменено'; preferences.speed = 1.8;
  const snapshot = await promise;
  assert.equal(snapshot.dialect, 'en-GB'); assert.equal(snapshot.speed, 0.8);
  assert.equal(snapshot.model, 'gpt-4o-mini-tts'); assert.equal(snapshot.voice, 'coral'); assert.equal(snapshot.format, 'mp3');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(validateAudioSnapshot(structuredClone(snapshot)), snapshot);
  const stable = await createDraftAudioSnapshot({ ...audioDraft, selectedSense: { ...audioDraft.selectedSense, id: 'new-model-id' } }, { dialect: 'en-GB', speed: 0.8 });
  assert.equal(await createAudioInputCacheKey(stable), await createAudioInputCacheKey(snapshot));
  const changed = await createDraftAudioSnapshot(draft, { dialect: 'en-GB', speed: 0.8 });
  assert.notEqual(await createAudioInputCacheKey(changed), await createAudioInputCacheKey(snapshot));
});

test('maximum valid context/definition/IPA do not overflow the locally hashed discriminator', async () => {
  const draft = structuredClone(audioDraft);
  draft.context.sentence = 'read' + 'x'.repeat(1496); draft.context.targetStart = 0; draft.context.targetEnd = 4;
  draft.selectedSense.definitionEn = 'x'.repeat(500);
  draft.selectedSense.translations = ['я'.repeat(200), 'ю'.repeat(200)];
  draft.pronunciation.ipa = 'a'.repeat(256);
  const snapshot = await createDraftAudioSnapshot(draft, { dialect: 'en-US', speed: 1 });
  assert.equal(snapshot.context.length, 1500);
  assert.equal(snapshot.cacheDiscriminator.length, 73);
  assert.ok(!snapshot.cacheDiscriminator.includes(draft.selectedSense.definitionEn));
});

test('missing or incompatible persisted snapshot requests an audio decision without network or silent fallback', async () => {
  const snapshot = freezeAudioInput(input);
  for (const bad of [null, {}, { ...snapshot, model: 'replacement' }, { ...snapshot, voice: 'other' },
    { ...snapshot, format: 'wav' }, { ...snapshot, snapshotVersion: 2 }, { ...snapshot, speed: undefined }]) {
    assert.throws(() => validateAudioSnapshot(bad), { code: 'AUDIO_UNAVAILABLE' });
  }
  let calls = 0;
  await assert.rejects(service({ fetch: async () => { calls++; return ok(); } }).prepare({ ...snapshot, model: 'replacement' } as unknown as AudioSnapshot), { code: 'AUDIO_UNAVAILABLE' });
  assert.equal(calls, 0);
});

// Integration below uses actual service routing/IndexedDB implementation with injected, offline transports.
import { IDBFactory } from 'fake-indexeddb';
import { openReaderStorage } from '../packages/storage/src/index.ts';
import { createReaderServices, SecretVault } from '../packages/services/src/index.ts';
import type { RuntimeSender } from '../packages/services/src/index.ts';
import {LANGUAGES,senseDefinition,draftSenses} from '../packages/contracts/src/index.ts';
import type { NoteDraft, NoteDraftV2, NoteDraftV3, Dialect, RpcResponse, AudioMetadata as RpcAudioMetadata } from '../packages/contracts/src/index.ts';
import type { SecretStorageArea } from '../packages/services/src/secrets.ts';
import { modelDefinition } from '../packages/note-templates/src/index.ts';

function integrationSecretArea(): SecretStorageArea {
  const values: Record<string, unknown> = {};
  return { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])); },
    async set(data) { Object.assign(values, data); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, async setAccessLevel() {} };
}
const integrationExtensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const integrationReader: RuntimeSender = { id: integrationExtensionId, url: 'https://example.com/read', documentId: 'audio-doc-1', frameId: 0, tab: { id: 2 } };
const integrationOther: RuntimeSender = { ...integrationReader, documentId: 'audio-doc-2', tab: { id: 3 } };
const integrationPage: RuntimeSender = { id: integrationExtensionId, url: `chrome-extension://${integrationExtensionId}/options.html` };
const integrationDraft: NoteDraft = {
  ...audioDraft, sourceLanguage: 'en', targetLanguage: 'ru', mode: 'recognition', deckName: 'Tests', tags: [],
  pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null },
  extraExample: null,
  source: { kind: 'html', title: 'Test', url: 'https://example.com/read', documentId: null, page: null, chapter: null, cfi: null },
};
function rpcOk(response: RpcResponse): any {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw new Error('Expected success');
  return response.data;
}
function rpcFails(response: RpcResponse, code: string) {
  assert.equal(response.ok, false, JSON.stringify(response));
  if (!response.ok) assert.equal(response.error.code, code);
}
async function integrationAudio(reviewedDraft:NoteDraft=integrationDraft,dialect:Dialect='en-GB') {
  const indexedDB = new IDBFactory(), name = `audio-test-${crypto.randomUUID()}`;
  let storage = await openReaderStorage({ indexedDB, name });
  const secrets = new SecretVault({ session: integrationSecretArea(), local: integrationSecretArea() });
  await secrets.setOpenAIKey('integration-placeholder-not-real');
  const control = { offline: true, played: 0, adds: 0, time: 1_000_000 };
  const ttsCalls: any[] = [];
  const mediaCalls: any[] = [];
  const lookupCalls: any[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/responses')) { lookupCalls.push(body); return Response.json({ id: 'resp_audio_mock', model: body.model, status: 'completed',
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
        lemma: reviewedDraft.lemma, partOfSpeech: reviewedDraft.partOfSpeech, recommendedSenseId: reviewedDraft.selectedSense.id,
        contextAmbiguous: false, senses: draftSenses(reviewedDraft).map(sense=>({id:sense.id,translations:sense.translations,definition:senseDefinition(sense)})), ipaCandidate: null, extraExample: null,
      }) }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); }
    if (url === TTS_ENDPOINT) { ttsCalls.push(body); return ok(); }
    if (control.offline) throw new Error('Mock Anki offline');
    let result: unknown;
    switch (body.action) {
      case 'findNotes': result = []; break;
      case 'version': result = 6; break;
      case 'deckNames': result = ['Tests']; break;
      case 'modelFieldNames': result = modelDefinition(reviewedDraft.mode,(reviewedDraft.draftVersion===2||reviewedDraft.draftVersion===3)?2:1).inOrderFields; break;
      case 'findModelsByName': { const definition = modelDefinition(reviewedDraft.mode,(reviewedDraft.draftVersion===2||reviewedDraft.draftVersion===3)?2:1); result = [{ name: definition.modelName, type: 0,
        tmpls: [{ qfmt: definition.cardTemplates[0]!.Front, afmt: definition.cardTemplates[0]!.Back }] }]; break; }
      case 'storeMediaFile': mediaCalls.push(body); result = 'audio-test.mp3'; break;
      case 'addNote': control.adds++; result = 987; break;
      default: throw new Error('Unexpected mock action');
    }
    return Response.json({ result, error: null });
  };
  const makeApp = () => createReaderServices({ storage, secrets, fetch: fetcher, now: () => control.time,
    runtime: { extensionId: integrationExtensionId, allowedPageUrls: [integrationPage.url!], isRegisteredReader: () => true },
    playback: playback({ async playMp3() { control.played++; } }), confirmations: { async requireConsent() { return true; } } });
  let app = makeApp();
  const send = (type: string, payload: unknown = {}, sender = integrationReader) => app.handleMessage({ v: 1, requestId: crypto.randomUUID(), type, payload }, sender);
  rpcOk(await send('settings.update', { patch: { cloudAudioEnabled: true,sourceLanguage:reviewedDraft.sourceLanguage,targetLanguage:reviewedDraft.targetLanguage, dialect, audioSpeed: 0.8 } }, integrationPage));
  const lookupPayload = { expression: reviewedDraft.expression,
    context: { ...reviewedDraft.context, before: 'Earlier that day.', after: 'I enjoyed it.' },
    sourceLanguage: reviewedDraft.sourceLanguage, targetLanguage: reviewedDraft.targetLanguage, learnerLevel:(reviewedDraft.draftVersion===2||reviewedDraft.draftVersion===3)?reviewedDraft.learnerLevel:'B1', dialect };
  const lookup = rpcOk(await send('lookup', lookupPayload));
  const restart = async () => { app.close(); storage = await openReaderStorage({ indexedDB, name }); app = makeApp(); };
  const evictAudio = async (audioId: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction('audioCache', 'readwrite'); transaction.objectStore('audioCache').delete(audioId); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); }
    finally { db.close(); }
  };
  return { control, ttsCalls, mediaCalls, lookupCalls, send, lookup, lookupPayload, restart, evictAudio, storage: () => storage, app: () => app };
}

test('audio RPC verifies reviewed draft and grants cached playback only to preparing reader or trusted page', async () => {
  const h = await integrationAudio();
  const prepared = rpcOk(await h.send('audio.prepare', { lookupId: h.lookup.lookupId, senseId: integrationDraft.selectedSense.id, draft: integrationDraft })) as RpcAudioMetadata;
  rpcOk(await h.send('audio.play', { audioId: prepared.audioId }));
  rpcFails(await h.send('audio.play', { audioId: prepared.audioId }, integrationOther), 'PERMISSION_DENIED');
  rpcOk(await h.send('audio.play', { audioId: prepared.audioId }, integrationPage));
  assert.equal(h.control.played, 2);
  for (const patch of [{ lemma: 'another' }, { partOfSpeech: 'noun' },
    { selectedSense: { ...integrationDraft.selectedSense, id: 'different-id' } },
    { selectedSense: { ...integrationDraft.selectedSense, definitionEn: 'Different meaning.' } },
    { selectedSense: { ...integrationDraft.selectedSense, translations: ['несовместимо'] } },
    { context: { sentence: 'I read a different book.', targetStart: 2, targetEnd: 6 } }]) {
    rpcFails(await h.send('audio.prepare', { lookupId: h.lookup.lookupId, senseId: integrationDraft.selectedSense.id, draft: { ...integrationDraft, ...patch } }), 'INVALID_INPUT');
  }
  rpcFails(await h.send('audio.prepare', { lookupId: h.lookup.lookupId, senseId: integrationDraft.selectedSense.id,
    draft: { ...integrationDraft, pronunciation: { ipa: '/rɛd/', dialect: 'unknown', source: 'dictionary', sourceUrl: 'https://example.com/unverified' } } }), 'PERMISSION_DENIED');
  assert.equal(h.ttsCalls.length, 1);
  h.app().close();
});

test('prepared draft audio preserves selected speed across later settings change, queue persistence and worker restart', async () => {
  const h = await integrationAudio();
  const prepared = rpcOk(await h.send('audio.prepare', { lookupId: h.lookup.lookupId, senseId: integrationDraft.selectedSense.id, draft: integrationDraft, speed: 0.7 })) as RpcAudioMetadata;
  rpcOk(await h.send('settings.update', { patch: { sourceLanguage:'fr',targetLanguage:'ru',audioSpeed: 1.8, dialect: 'fr-FR' } }, integrationPage));
  const operationId = crypto.randomUUID();
  rpcOk(await h.send('anki.addNote', { operationId, draft: integrationDraft, includeAudio: true, audioId: prepared.audioId }));
  const stored = await h.storage().getOperation(operationId);
  const snapshot = stored?.audioSnapshot as AudioSnapshot;
  assert.equal(snapshot.speed, 0.7); assert.equal(snapshot.dialect, 'en-GB');
  await h.restart(); h.control.offline = false; h.control.time += 60_000;
  await h.app().resumeQueue();
  assert.equal((await h.storage().getOperation(operationId))?.state, 'synced');
  assert.equal(h.control.adds, 1); assert.equal(h.ttsCalls.length, 1);
  h.app().close();
});

test('queued audio without preprepared ID generates from frozen settings after restart, not new defaults', async () => {
  const h = await integrationAudio(), operationId = crypto.randomUUID();
  rpcOk(await h.send('anki.addNote', { operationId, draft: integrationDraft, includeAudio: true }));
  rpcOk(await h.send('settings.update', { patch: { sourceLanguage:'fr',targetLanguage:'ru',audioSpeed: 1.8, dialect: 'fr-FR' } }, integrationPage));
  await h.restart(); h.control.offline = false; h.control.time += 60_000;
  await h.app().resumeQueue();
  assert.equal((await h.storage().getOperation(operationId))?.state, 'synced');
  assert.equal(h.ttsCalls.length, 1); assert.equal(h.ttsCalls[0].speed, 0.8);
  assert.ok(h.ttsCalls[0].instructions.includes('British'));
  h.app().close();
});

test('legacy preview audio cannot silently attach to a reviewed draft, even with same spelling', async () => {
  const h = await integrationAudio(), operationId = crypto.randomUUID();
  const response = await h.send('audio.prepare', { lookupId: h.lookup.lookupId, senseId: integrationDraft.selectedSense.id });
  const prepared = rpcOk(response) as RpcAudioMetadata;
  if (response.ok) assert.ok(response.warnings.includes('AUDIO_REVIEW_DRAFT_BEFORE_SAVE'));
  rpcOk(await h.send('anki.addNote', { operationId, draft: integrationDraft, includeAudio: true, audioId: prepared.audioId }));
  const record = await h.storage().getOperation(operationId);
  assert.equal(record?.state, 'awaiting_audio_decision'); assert.equal(record?.audioSnapshot, null);
  assert.equal(h.control.adds, 0); assert.equal(h.ttsCalls.length, 1);
  h.app().close();
});

const multilingualIntegrationDraft:NoteDraftV2={
  draftVersion:2,sourceLanguage:'fr',targetLanguage:'ru',learnerLevel:'B1',mode:'recognition',deckName:'Tests',tags:[],
  expression:'bonjour',lemma:'bonjour',partOfSpeech:'interjection',selectedSense:{id:'hello',translations:['привет'],definition:'Une salutation.'},
  context:{sentence:'Je dis bonjour.',targetStart:7,targetEnd:14},
  pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},examples:[],source:integrationDraft.source,
};

const fullMeaningsIntegrationDraft:NoteDraftV3={
 ...multilingualIntegrationDraft,draftVersion:3,
 senses:[multilingualIntegrationDraft.selectedSense,{id:'greeting',definition:'Un mot de politesse.',translations:['добрый день','здравствуйте','приветствую','приветик']}],
};

test('v3 prepared reader playback loses its grant after actual worker recreation; a fresh explicit lookup/prepare restores the same cached ID without TTS',async()=>{
 const draft=fullMeaningsIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 try{
  const first=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
  rpcOk(await h.send('audio.play',{audioId:first.audioId}));
  await h.restart();
  rpcFails(await h.send('audio.play',{audioId:first.audioId}),'PERMISSION_DENIED');
  rpcFails(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft}),'PERMISSION_DENIED');
  assert.equal(h.ttsCalls.length,1);assert.equal(h.lookupCalls.length,1);assert.equal(h.control.played,1);
  assert.ok(await h.storage().getAudio(first.audioId));assert.equal((await h.storage().allOperations()).length,0);
  // This is the user's fresh lookup after closing/reselecting, not automatic
  // recovery by the failed play request or permission broadening for raw IDs.
  const fresh=rpcOk(await h.send('lookup',h.lookupPayload));
  const recovered=rpcOk(await h.send('audio.prepare',{lookupId:fresh.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
  assert.equal(recovered.audioId,first.audioId);assert.equal(h.ttsCalls.length,1);assert.equal(h.lookupCalls.length,1);
  rpcOk(await h.send('audio.play',{audioId:recovered.audioId}));assert.equal(h.control.played,2);
  rpcFails(await h.send('audio.play',{audioId:recovered.audioId},integrationOther),'PERMISSION_DENIED');
 }finally{h.app().close();}
});

test('v3 unqueued audio eviction fails playback honestly and only a new explicit prepare regenerates it',async()=>{
 const draft=fullMeaningsIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 try{
  const first=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
  await h.evictAudio(first.audioId);
  rpcFails(await h.send('audio.play',{audioId:first.audioId}),'AUDIO_UNAVAILABLE');
  assert.equal(h.ttsCalls.length,1);assert.equal(h.lookupCalls.length,1);assert.equal(h.control.played,0);assert.equal(await h.storage().getAudio(first.audioId),null);
  const fresh=rpcOk(await h.send('lookup',h.lookupPayload));
  assert.equal(h.ttsCalls.length,1);
  const regenerated=rpcOk(await h.send('audio.prepare',{lookupId:fresh.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
  assert.notEqual(regenerated.audioId,first.audioId);assert.equal(h.ttsCalls.length,2);assert.equal(h.lookupCalls.length,1);
  rpcOk(await h.send('audio.play',{audioId:regenerated.audioId}));assert.equal(h.control.played,1);
 }finally{h.app().close();}
});

test('v3 prepared preview and queued add share exactly one MP3 after settings changes and restart',async()=>{
 const draft=fullMeaningsIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 try{
  const prepared=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft,speed:.65})) as RpcAudioMetadata;
  rpcOk(await h.send('audio.play',{audioId:prepared.audioId}));assert.equal(h.control.played,1);
  rpcOk(await h.send('settings.update',{patch:{sourceLanguage:'ja',targetLanguage:'en',dialect:'ja-JP',audioSpeed:1.8}},integrationPage));
  const operationId=crypto.randomUUID();rpcOk(await h.send('anki.addNote',{operationId,draft,includeAudio:true,audioId:prepared.audioId}));
  const stored=await h.storage().getOperation(operationId),snapshot=stored?.audioSnapshot as AudioSnapshot;
  assert.equal(stored?.audioId,prepared.audioId);assert.equal(snapshot.snapshotVersion,3);assert.equal(snapshot.speed,.65);
  assert.equal(snapshot.dialect,'fr-FR');assert.match(snapshot.cacheDiscriminator,/^draft-v3:/);assert.equal(h.ttsCalls.length,1);
  await h.restart();h.control.offline=false;h.control.time+=60_000;await h.app().resumeQueue();
  const complete=await h.storage().getOperation(operationId);assert.equal(complete?.state,'synced');assert.equal(complete?.audioId,prepared.audioId);
  assert.equal(h.control.adds,1);assert.equal(h.ttsCalls.length,1);assert.equal(h.mediaCalls.length,1);
  assert.equal(h.mediaCalls[0].params.data,Buffer.from(mp3).toString('base64'));
 }finally{h.app().close();}
});

test('v3 changed secondary meaning rejects prepared ID without hidden regeneration or adding a wrong file',async()=>{
 const draft=fullMeaningsIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 try{
  const prepared=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
  const changed=structuredClone(draft);changed.senses[1]!.translations[3]='новый перевод';
  const operationId=crypto.randomUUID();rpcOk(await h.send('anki.addNote',{operationId,draft:changed,includeAudio:true,audioId:prepared.audioId}));
  const record=await h.storage().getOperation(operationId);assert.equal(record?.state,'awaiting_audio_decision');assert.equal(record?.audioSnapshot,null);
  await h.restart();h.control.offline=false;h.control.time+=60_000;await h.app().resumeQueue();
  assert.equal((await h.storage().getOperation(operationId))?.state,'awaiting_audio_decision');
  assert.equal(h.control.adds,0);assert.equal(h.ttsCalls.length,1);assert.equal(h.mediaCalls.length,0);
 }finally{h.app().close();}
});

test('v3 explicit save without audio leaves a previously prepared shared cache file intact',async()=>{
 const draft=fullMeaningsIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 try{
  const prepared=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
  h.control.offline=false;const operationId=crypto.randomUUID();
  rpcOk(await h.send('anki.addNote',{operationId,draft,includeAudio:false}));
  const record=await h.storage().getOperation(operationId);assert.equal(record?.state,'synced');assert.equal(record?.audioId,null);
  assert.equal(h.ttsCalls.length,1);assert.equal(h.mediaCalls.length,0);assert.ok(await h.storage().getAudio(prepared.audioId));
  rpcOk(await h.send('audio.play',{audioId:prepared.audioId}));assert.equal(h.control.played,1);
 }finally{h.app().close();}
});

test('legacy unknown-dialect audio uses en-US only for valid unrelated language preferences',async()=>{
 const expected=await createDraftAudioSnapshot(audioDraft,{dialect:'en-US',speed:.8});
 for(const language of LANGUAGES.filter(language=>language.code!=='en')){
  const snapshot=await createDraftAudioSnapshot(audioDraft,{dialect:language.locale,speed:.8});
  assert.deepEqual(snapshot,expected);assert.equal(await createAudioInputCacheKey(snapshot),await createAudioInputCacheKey(expected));
 }
 const british=await createDraftAudioSnapshot(audioDraft,{dialect:'en-GB',speed:.8});assert.equal(british.dialect,'en-GB');
 const verifiedBritish=await createDraftAudioSnapshot({...audioDraft,pronunciation:{...audioDraft.pronunciation,dialect:'en-GB'}},{dialect:'fr-FR',speed:.8});assert.equal(verifiedBritish.dialect,'en-GB');
 await assert.rejects(createDraftAudioSnapshot(audioDraft,{dialect:'unrecognized' as Dialect,speed:.8}),{code:'INVALID_INPUT'});
});

test('v2 prepared French audio preserves frozen pair, locale and speed after settings change and restart',async()=>{
 const draft=multilingualIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 const prepared=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft,speed:.65})) as RpcAudioMetadata;
 assert.equal(prepared.sourceLanguage,'fr');assert.equal(prepared.dialect,'fr-FR');
 rpcOk(await h.send('settings.update',{patch:{sourceLanguage:'ja',targetLanguage:'en',dialect:'ja-JP',audioSpeed:1.8}},integrationPage));
 const operationId=crypto.randomUUID();rpcOk(await h.send('anki.addNote',{operationId,draft,includeAudio:true,audioId:prepared.audioId}));
 const snapshot=(await h.storage().getOperation(operationId))?.audioSnapshot as AudioSnapshot;
 assert.equal(snapshot.snapshotVersion,2);if(snapshot.snapshotVersion!==2)assert.fail('Expected v2 snapshot');
 assert.equal(snapshot.sourceLanguage,'fr');assert.equal(snapshot.targetLanguage,'ru');assert.equal(snapshot.locale,'fr-FR');assert.equal(snapshot.speed,.65);
 await h.restart();h.control.offline=false;h.control.time+=60_000;await h.app().resumeQueue();
 assert.equal((await h.storage().getOperation(operationId))?.state,'synced');assert.equal(h.control.adds,1);assert.equal(h.ttsCalls.length,1);
 assert.match(h.ttsCalls[0].instructions,/fr-FR/);assert.doesNotMatch(h.ttsCalls[0].instructions,/American|British|ja-JP/);h.app().close();
});

test('v2 queued non-English audio uses persisted snapshot after restart, not new language preferences',async()=>{
 const draft=multilingualIntegrationDraft,h=await integrationAudio(draft,'fr-FR'),operationId=crypto.randomUUID();
 rpcOk(await h.send('anki.addNote',{operationId,draft,includeAudio:true}));
 rpcOk(await h.send('settings.update',{patch:{sourceLanguage:'de',targetLanguage:'en',dialect:'de-DE',audioSpeed:2}},integrationPage));
 await h.restart();h.control.offline=false;h.control.time+=60_000;await h.app().resumeQueue();
 assert.equal((await h.storage().getOperation(operationId))?.state,'synced');assert.equal(h.ttsCalls.length,1);assert.equal(h.ttsCalls[0].speed,.8);
 assert.match(h.ttsCalls[0].instructions,/fr-FR/);assert.doesNotMatch(h.ttsCalls[0].instructions,/de-DE|American|British/);h.app().close();
});

test('audio from a different v2 target language cannot attach to an otherwise identical reviewed draft',async()=>{
 const draft=multilingualIntegrationDraft,h=await integrationAudio(draft,'fr-FR');
 const prepared=rpcOk(await h.send('audio.prepare',{lookupId:h.lookup.lookupId,senseId:draft.selectedSense.id,draft})) as RpcAudioMetadata;
 const operationId=crypto.randomUUID();rpcOk(await h.send('anki.addNote',{operationId,draft:{...draft,targetLanguage:'de'},includeAudio:true,audioId:prepared.audioId}));
 const record=await h.storage().getOperation(operationId);assert.equal(record?.state,'awaiting_audio_decision');assert.equal(record?.audioSnapshot,null);
 assert.equal(h.control.adds,0);assert.equal(h.ttsCalls.length,1);h.app().close();
});

for(const cloudAudioEnabled of [true,false])test(`legacy missing-snapshot retry after switching to French uses legacy English default and respects cloud consent=${cloudAudioEnabled}`,async()=>{
 const h=await integrationAudio(),operationId=crypto.randomUUID();
 try{
  rpcOk(await h.send('anki.addNote',{operationId,draft:integrationDraft,includeAudio:true}));
  const original=await h.storage().getOperation(operationId);assert.ok(original);
  // Simulate a persisted legacy item which predates frozen audio intent storage.
  await h.storage().putOperation({...original,state:'awaiting_audio_decision',audioSnapshot:null,audioCacheKey:null,audioId:null,mediaFilename:null,lease:null,nextAttemptAt:null});
  rpcOk(await h.send('settings.update',{patch:{sourceLanguage:'fr',targetLanguage:'ru',dialect:'fr-FR',cloudAudioEnabled}},integrationPage));
  await h.restart();h.control.offline=false;h.control.time+=60_000;await h.app().resumeQueue();
  assert.equal((await h.storage().getOperation(operationId))?.state,'awaiting_audio_decision');assert.equal(h.ttsCalls.length,0);assert.equal(h.control.adds,0);
  rpcOk(await h.send('queue.resolveAudio',{operationId,action:'retry'},integrationPage));
  const afterRetry=await h.storage().getOperation(operationId),snapshot=afterRetry?.audioSnapshot as AudioSnapshot;
  assert.ok(snapshot,'Explicit retry must create a version-appropriate frozen audio intent');
  assert.equal(snapshot.snapshotVersion,1);assert.equal(snapshot.dialect,'en-US');assert.equal(snapshot.speed,.8);
  assert.equal(afterRetry?.audioCacheKey,await createAudioInputCacheKey(snapshot));
  if(!cloudAudioEnabled){
   assert.equal(afterRetry?.state,'awaiting_audio_decision');assert.equal((afterRetry?.lastError as {code?:string}|null)?.code,'PERMISSION_DENIED');assert.equal(h.ttsCalls.length,0);assert.equal(h.control.adds,0);
   rpcOk(await h.send('settings.update',{patch:{cloudAudioEnabled:true}},integrationPage));
   rpcOk(await h.send('queue.resolveAudio',{operationId,action:'retry'},integrationPage));
  }
  assert.equal((await h.storage().getOperation(operationId))?.state,'synced');assert.equal(h.ttsCalls.length,1);assert.equal(h.control.adds,1);
  assert.match(h.ttsCalls[0].instructions,/American English/);assert.doesNotMatch(h.ttsCalls[0].instructions,/fr-FR|Французский/);
  const settings=rpcOk(await h.send('settings.getPublic',{},integrationPage));assert.equal(settings.sourceLanguage,'fr');assert.equal(settings.dialect,'fr-FR');
 }finally{h.app().close();}
});
