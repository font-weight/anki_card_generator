import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { openReaderStorage } from '../packages/storage/src/index.ts';
import { createReaderServices, SecretVault } from '../packages/services/src/index.ts';
import type { RuntimeSender } from '../packages/services/src/index.ts';
import type { SecretStorageArea } from '../packages/services/src/secrets.ts';
import { AudioService, TTS_ENDPOINT } from '../packages/services/src/audio.ts';
import type { AudioCache, LocalAudioEntry } from '../packages/services/src/audio.ts';
import type { PreparedAnkiNote } from '../packages/services/src/anki.ts';
import { modelDefinition, MULTILINGUAL_MODEL_NAMES } from '../packages/note-templates/src/index.ts';
import { senseDefinition } from '../packages/contracts/src/index.ts';
import type { LookupData, LookupPayload, NoteDraftV3, Operation, RpcData, RpcResponse } from '../packages/contracts/src/index.ts';

// Independent, fully mocked audit. No real provider, API key, profile or browser.
const bytes = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
for (const gate of ['cache', 'key'] as const) {
  test(`independent audit: consent revoked during deferred ${gate} read blocks paid dispatch`, async () => {
    let consent = true, requests = 0;
    const entered = deferred<void>(), release = deferred<void>();
    const cache: AudioCache = {
      getById: async () => null,
      getByCacheKey: async () => { if (gate === 'cache') { entered.resolve(); await release.promise; } return null; },
      put: async () => {},
    };
    const service = new AudioService({ cache, hasCloudAudioConsent: () => consent,
      getOpenAIKey: async () => { if (gate === 'key') { entered.resolve(); await release.promise; } return 'synthetic-audit-key'; },
      fetch: async () => { requests++; return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }); },
    });
    const pending = service.prepare({ text: 'hello', dialect: 'en-US' });
    await entered.promise;
    consent = false; release.resolve();
    await assert.rejects(pending, { code: 'PERMISSION_DENIED' });
    assert.equal(requests, 0, 'No provider request is allowed after pre-dispatch revocation');
  });
}

const extensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const page = { id: extensionId, url: `chrome-extension://${extensionId}/settings.html`, frameId: 0 };
const reader = { id: extensionId, url: 'https://audit.example/read', documentId: 'audit-document', frameId: 0, tab: { id: 7 } };
const input: LookupPayload = { expression: 'bank', context: { sentence: 'The bank faces another bank.', targetStart: 4, targetEnd: 8 }, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', dialect: 'en-GB' };
const senses = Array.from({ length: 8 }, (_, i) => ({ id: `meaning-${i}`, definition: `Definition ${i}.`, translations: Array.from({ length: 4 }, (_, j) => `перевод ${i}-${j}`) }));
const output = { lemma: 'bank', partOfSpeech: 'noun', recommendedSenseId: senses[0]!.id, contextAmbiguous: false, senses, ipaCandidate: { ipa: '/bæŋk/', dialect: 'en-GB' }, extraExample: null };
function area(): SecretStorageArea {
  const values: Record<string, unknown> = {};
  return { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])),
    set: async next => { Object.assign(values, next); }, remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, setAccessLevel: async () => {} };
}
function success<T extends Operation>(response: RpcResponse): RpcData[T] {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw Error('Expected success');
  return response.data as RpcData[T];
}
function draftFor(data: LookupData): NoteDraftV3 {
  const meanings = data.senses.map(sense => ({ id: sense.id, definition: senseDefinition(sense), translations: [...sense.translations] }));
  return { draftVersion: 3, expression: data.expression, lemma: data.lemma, partOfSpeech: data.partOfSpeech,
    sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, learnerLevel: input.learnerLevel,
    selectedSense: structuredClone(meanings[0]!), senses: meanings, context: { ...input.context },
    pronunciation: { ipa: '/bæŋk/', dialect: 'en-GB', source: 'generated', sourceUrl: null },
    mode: 'recognition', deckName: 'Test', tags: [], examples: [],
    source: { kind: 'html', title: 'Audit source', url: reader.url, documentId: null, page: null, chapter: null, cfi: null } };
}
async function harness() {
  const indexedDB = new IDBFactory();
  let storage = await openReaderStorage({ indexedDB });
  const secrets = new SecretVault({ session: area(), local: area() });
  await secrets.setOpenAIKey('synthetic-audit-only-not-a-real-key');
  const notes = new Map<number, PreparedAnkiNote>();
  const calls: string[] = [], played: LocalAudioEntry[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    const address = String(url), body = JSON.parse(String(options?.body));
    if (address === TTS_ENDPOINT) { calls.push('tts'); return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }); }
    if (address === 'https://api.openai.com/v1/responses') {
      calls.push('lookup');
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
    }
    assert.equal(address, 'http://127.0.0.1:8765/', 'All network must remain in this mock');
    const { action, params } = body; calls.push(action);
    const result = (value: unknown) => Response.json({ result: value, error: null });
    if (action === 'findNotes') {
      const key = /"(OperationId|LexemeKey):([a-f0-9-]+)"/i.exec(params.query)!;
      return result([...notes].filter(([, note]) => note.fields[key[1]!] === key[2]).map(([id]) => id));
    }
    if (action === 'notesInfo') return result(params.notes.map((id: number) => ({ noteId: id, modelName: notes.get(id)!.modelName,
      fields: Object.fromEntries(Object.entries(notes.get(id)!.fields).map(([name, value], order) => [name, { value, order }])) })));
    if (action === 'version') return result(6);
    if (action === 'deckNames') return result(['Test']);
    if (action === 'modelFieldNames') return result(modelDefinition(params.modelName.includes('Cloze') ? 'cloze' : 'recognition', 2).inOrderFields);
    if (action === 'findModelsByName') return result(params.modelNames.map((name: string) => {
      const model = modelDefinition(name.includes('Cloze') ? 'cloze' : 'recognition', 2);
      return { name, type: model.isCloze ? 1 : 0, tmpls: [{ qfmt: model.cardTemplates[0]!.Front, afmt: model.cardTemplates[0]!.Back }] };
    }));
    if (action === 'storeMediaFile') { assert.deepEqual(new Uint8Array(Buffer.from(params.data, 'base64')), bytes); return result(params.filename); }
    if (action === 'addNote') { const id = notes.size + 10; notes.set(id, structuredClone(params.note)); return result(id); }
    throw Error(`Unexpected mocked Anki action ${action}`);
  };
  const create = () => createReaderServices({ storage, secrets, fetch: fetcher,
    confirmations: { requireConsent: async () => true },
    runtime: { extensionId, allowedPageUrls: [page.url], isRegisteredReader: sender => sender.documentId === reader.documentId },
    playback: { listVoices: async () => [], speakLocal: async () => {}, playMp3: async entry => { played.push(entry); } } });
  let app = create();
  const send = (type: Operation, payload: unknown = {}, sender: RuntimeSender = reader) => app.handleMessage({ v: 1, requestId: crypto.randomUUID(), type, payload }, sender);
  await send('settings.update', { patch: { cloudAudioEnabled: true } }, page).then(success);
  return { calls, notes, played, send, storage: () => storage,
    restart: async () => { app.close(); storage = await openReaderStorage({ indexedDB }); app = create(); await app.resumeQueue(); },
    close: () => app.close() };
}

test('independent audit: max meanings persist across cache restart; prepared file is played and exported once', async () => {
  const h = await harness();
  try {
    const first = success<'lookup'>(await h.send('lookup', input));
    await h.restart();
    const cached = success<'lookup'>(await h.send('lookup', input));
    assert.deepEqual(cached.senses, first.senses); assert.equal(h.calls.filter(call => call === 'lookup').length, 1);
    const draft = draftFor(cached), before = structuredClone(draft), operationId = crypto.randomUUID();
    const audio = success<'audio.prepare'>(await h.send('audio.prepare', { lookupId: cached.lookupId, senseId: draft.selectedSense.id, draft }));
    success(await h.send('audio.play', { audioId: audio.audioId }));
    const intent = { operationId, draft, includeAudio: true, audioId: audio.audioId };
    assert.equal(success<'anki.addNote'>(await h.send('anki.addNote', intent, page)).status, 'added');
    assert.equal(success<'anki.addNote'>(await h.send('anki.addNote', intent, page)).status, 'already_added');
    await h.restart();
    const row = await h.storage().getOperation(operationId);
    assert.equal(row!.state, 'synced'); assert.deepEqual(row!.draft, before);
    assert.equal((row!.draft as NoteDraftV3).senses.reduce((n, sense) => n + sense.translations.length, 0), 32);
    assert.equal(h.played[0]!.audioId, row!.audioId); assert.deepEqual(h.played[0]!.bytes, bytes);
    assert.equal(h.calls.filter(call => call === 'tts').length, 1);
    assert.equal(h.calls.filter(call => call === 'storeMediaFile').length, 1);
    assert.equal(h.calls.filter(call => call === 'addNote').length, 1);
    const note = h.notes.get(10)!;
    assert.equal(note.modelName, MULTILINGUAL_MODEL_NAMES.recognition);
    const document = new JSDOM(note.fields.Meaning).window.document;
    assert.equal(document.querySelectorAll('.sense-group').length, 8);
    for (const sense of senses) for (const translation of sense.translations) assert.ok(document.body.textContent!.includes(translation));
    assert.equal((row!.draft as NoteDraftV3).pronunciation.ipa, '/bæŋk/');
    assert.equal(new JSDOM(note.fields.IPA).window.document.body.textContent, '[bæŋk]');
  } finally { h.close(); }
});

for (const mutation of ['last-translation', 'raw-ipa'] as const) {
  test(`independent audit: stale ready ID after ${mutation} edit cannot attach or auto-regenerate across restart`, async () => {
    const h = await harness();
    try {
      const lookup = success<'lookup'>(await h.send('lookup', input)), draft = draftFor(lookup);
      const audio = success<'audio.prepare'>(await h.send('audio.prepare', { lookupId: lookup.lookupId, senseId: draft.selectedSense.id, draft }));
      if (mutation === 'last-translation') draft.senses[7]!.translations[3] = 'изменённый последний перевод';
      else draft.pronunciation.ipa = '[bæŋk]';
      const operationId = crypto.randomUUID();
      assert.equal(success<'anki.addNote'>(await h.send('anki.addNote', { operationId, draft, includeAudio: true, audioId: audio.audioId }, page)).status, 'queued');
      await h.restart();
      const row = await h.storage().getOperation(operationId);
      assert.equal(row!.state, 'awaiting_audio_decision'); assert.deepEqual(row!.draft, draft);
      assert.equal(h.calls.filter(call => call === 'tts').length, 1);
      assert.equal(h.calls.filter(call => call === 'addNote' || call === 'storeMediaFile').length, 0);
      success(await h.send('queue.resolveAudio', { operationId, action: 'save_without_audio' }, page));
      assert.equal(h.calls.filter(call => call === 'tts').length, 1);
      assert.equal(h.notes.get(10)!.fields.Audio, '');
    } finally { h.close(); }
  });
}
