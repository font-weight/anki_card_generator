import test from 'node:test';
import assert from 'node:assert/strict';
import { AnkiClient, AnkiError, validateAnkiEndpoint } from '../packages/services/src/anki.ts';
import { MODEL_NAMES, NOTE_FIELDS, modelDefinition } from '../packages/note-templates/src/index.ts';
import type { NoteDraft } from '../packages/contracts/src/index.ts';
const response = (result: unknown, error: string | null = null, status = 200) => new Response(JSON.stringify({ result, error }), { status });
// Explicit mocked transport. No live profile, collection, or media are touched.
const mockedFetch = (handler: (body: any, init: RequestInit) => Response | Promise<Response>) =>
  (async (_url: string | URL | Request, init?: RequestInit) => handler(JSON.parse(String(init?.body)), init!)) as typeof fetch;
const definitionRecord = (mode: 'recognition' | 'cloze') => {
  const d = modelDefinition(mode); return { name: d.modelName, type: mode === 'cloze' ? 1 : 0,
    tmpls: [{ qfmt: d.cardTemplates[0]!.Front, afmt: d.cardTemplates[0]!.Back }] };
};
const d = { mode: 'recognition', deckName: 'Колода' } as NoteDraft;

test('loopback endpoint enum only; localhost canonicalized and redirects prohibited', async () => {
  assert.equal(validateAnkiEndpoint('http://localhost:8765'), 'http://127.0.0.1:8765/');
  for (const endpoint of ['http://evil.test:8765', 'http://127.0.0.1.evil.test:8765', 'http://127.0.0.1:8765/path', 'https://127.0.0.1:8765', 'http://127.0.0.1:9000', 'http://a:b@127.0.0.1:8765', 'http://2130706433:8765']) {
    assert.throws(() => new AnkiClient({ endpoint }), { code: 'INVALID_INPUT' });
  }
  const client = new AnkiClient({ fetch: mockedFetch((body, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(body.version, 6); return response(6);
  }) }); assert.equal(await client.version(), 6);
});
test('HTTP200 error is checked and upstream secrets are never exposed', async () => {
  const client = new AnkiClient({ getApiKey: async () => 'fixture-not-a-secret', fetch: mockedFetch((body) => {
    assert.equal(body.key, 'fixture-not-a-secret'); return response(null, 'invalid key: fixture-not-a-secret');
  }) });
  await assert.rejects(client.version(), (err: AnkiError) => err.code === 'ANKI_AUTH' && !err.message.includes('fixture-not-a-secret'));
});
test('origin, network, protocol and absent-deck errors stay distinct', async () => {
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => response(null, 'origin not allowed')) }).version(), { code: 'ANKI_ORIGIN_DENIED' });
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => { throw new TypeError('sensitive details'); }) }).version(), { code: 'ANKI_UNAVAILABLE' });
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => response(5)) }).version(), { code: 'ANKI_SCHEMA_MISMATCH' });
  await assert.rejects(new AnkiClient({ fetch: mockedFetch((body) => response(body.action === 'version' ? 6 : ['Other'])) }).assertReady(d), { code: 'ANKI_DECK_NOT_FOUND' });
});
test('create models requires consent, exact fields and a true cloze model', async () => {
  const models = new Map<string, any>(); const actions: any[] = [];
  const client = new AnkiClient({ fetch: mockedFetch((body) => {
    actions.push(body); switch (body.action) {
      case 'version': return response(6);
      case 'modelNames': return response([...models.keys()]);
      case 'createModel': { const mode = body.params.isCloze ? 'cloze' : 'recognition'; models.set(body.params.modelName, definitionRecord(mode)); return response(models.get(body.params.modelName)); }
      case 'modelFieldNames': return response(NOTE_FIELDS);
      case 'findModelsByName': return response([models.get(body.params.modelNames[0])]);
      default: throw new Error('Unexpected mock action');
    }
  }) });
  await assert.rejects(client.initializeModels(false), { code: 'PERMISSION_DENIED' }); assert.equal(actions.length, 0);
  const result = await client.initializeModels(true); assert.equal(result.created.length, 2);
  const create = actions.filter(a => a.action === 'createModel'); assert.equal(create[1].params.isCloze, true);
  assert.deepEqual(create[0].params.inOrderFields, NOTE_FIELDS); assert.equal(create[1].params.cardTemplates.length, 1);
});
test('same-name incompatible model or misleading Basic-as-Cloze is never overwritten', async () => {
  const actions: string[] = [];
  const client = new AnkiClient({ fetch: mockedFetch((body) => {
    actions.push(body.action);
    if (body.action === 'version') return response(6);
    if (body.action === 'modelNames') return response([MODEL_NAMES.recognition]);
    if (body.action === 'modelFieldNames') return response(['Wrong']);
    throw new Error('Unexpected mock mutation');
  }) });
  await assert.rejects(client.initializeModels(true), { code: 'ANKI_SCHEMA_MISMATCH' }); assert.ok(!actions.includes('createModel'));
  const badCloze = new AnkiClient({ fetch: mockedFetch((body) => body.action === 'modelFieldNames' ? response(NOTE_FIELDS) : response([{ ...definitionRecord('cloze'), type: 0 }])) });
  await assert.rejects(badCloze.assertModel('cloze'), { code: 'ANKI_SCHEMA_MISMATCH' });
});
test('media is base64 bytes not URL/path, does not overwrite and honors actual Cyrillic filename', async () => {
  const client = new AnkiClient({ fetch: mockedFetch((body) => {
    assert.equal(body.action, 'storeMediaFile'); assert.equal(body.params.data, 'SUQz');
    assert.equal(body.params.deleteExisting, false); assert.equal(body.params.url, undefined); assert.equal(body.params.path, undefined);
    return response('произношение-2.mp3');
  }) });
  assert.equal(await client.storeAudio('11111111-1111-4111-8111-111111111111', new Uint8Array([73, 68, 51])), 'произношение-2.mp3');
});
test('lost or malformed add response is uncertain, API error is definite, result is noteId', async () => {
  const note = {} as any;
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => { throw new TypeError('lost response'); }) }).addPreparedNote(note), (err: AnkiError) => err.uncertain === true);
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => new Response('not-json')) }).addPreparedNote(note), (err: AnkiError) => err.uncertain === true);
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => response(null, 'invalid key')) }).addPreparedNote(note), (err: AnkiError) => err.uncertain === false);
  assert.equal(await new AnkiClient({ fetch: mockedFetch(() => response(123456)) }).addPreparedNote(note), 123456);
});
test('operation reconciliation verifies exact OperationId, model and semantic keys using notesInfo', async () => {
  const id = '11111111-1111-4111-8111-111111111111'; const keys = { lexemeKey: 'a'.repeat(64), contentKey: 'b'.repeat(64) };
  const make = (operation = id) => new AnkiClient({ fetch: mockedFetch((body) => body.action === 'findNotes' ? response([1]) : response([
    { noteId: 1, modelName: MODEL_NAMES.recognition, fields: { OperationId: { value: operation, order: 0 }, LexemeKey: { value: keys.lexemeKey, order: 1 }, ContentKey: { value: keys.contentKey, order: 2 } } },
  ])) });
  assert.equal(await make().findOperation(id, keys, 'recognition'), 1);
  assert.equal(await make(id + '-suffix').findOperation(id, keys, 'recognition'), null);
  await assert.rejects(make().findOperation(id, keys, 'cloze'), { code: 'OPERATION_CONFLICT' });
});
test('openNote refuses other models and passes noteId rather than cardId to guiBrowse', async () => {
  let query = '';
  const client = new AnkiClient({ fetch: mockedFetch((body) => {
    if (body.action === 'notesInfo') return response([{ noteId: 5, modelName: MODEL_NAMES.recognition }]);
    query = body.params.query; return response([9]);
  }) }); await client.openNote(5); assert.equal(query, 'nid:5');
  await assert.rejects(new AnkiClient({ fetch: mockedFetch(() => response([{ noteId: 5, modelName: 'Basic' }])) }).openNote(5), { code: 'PERMISSION_DENIED' });
});
test('whole-request deadline covers stalled key access and streaming body', async () => {
  let fetched = false;
  const stuckKey = new AnkiClient({ timeoutMs: 5, getApiKey: () => new Promise(() => {}), fetch: mockedFetch(() => { fetched = true; return response(6); }) });
  await assert.rejects(stuckKey.addPreparedNote({} as any), (err: AnkiError) => err.code === 'NETWORK_TIMEOUT' && !err.uncertain);
  assert.equal(fetched, false);
  let cancelled = false;
  const stuckBody = new AnkiClient({ timeoutMs: 5, fetch: mockedFetch(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  }))) });
  await assert.rejects(stuckBody.addPreparedNote({} as any), (err: AnkiError) => err.code === 'NETWORK_TIMEOUT' && err.uncertain);
  assert.equal(cancelled, true);
});
test('streaming response cap rejects oversized data without waiting for the full body', async () => {
  const client = new AnkiClient({ fetch: mockedFetch(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
  }))) });
  await assert.rejects(client.version(), { code: 'ANKI_SCHEMA_MISMATCH' });
});
test('explicit deck creation supports Cyrillic and checks returned deck ID', async () => {
  const client = new AnkiClient({ fetch: mockedFetch((body) => { assert.equal(body.action, 'createDeck'); assert.equal(body.params.deck, 'Чтение::Роман'); return response(42); }) });
  assert.deepEqual(await client.createDeck('Чтение::Роман'), { deckName: 'Чтение::Роман', deckId: 42 });
  await assert.rejects(client.createDeck(''), { code: 'INVALID_INPUT' });
});
test('isolatedTestMode forces exact 18765 and never falls back to personal 8765', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => { urls.push(String(url)); return response(6); }) as typeof fetch;
  const client = new AnkiClient({ isolatedTestMode: true, fetch: fetcher });
  assert.equal(client.endpoint, 'http://127.0.0.1:18765/'); assert.equal(await client.version(), 6);
  assert.deepEqual(urls, ['http://127.0.0.1:18765/']);
  assert.equal(validateAnkiEndpoint(undefined, true), 'http://127.0.0.1:18765/');
  for (const endpoint of ['http://127.0.0.1:8765', 'http://localhost:18765', 'http://[::1]:18765', 'http://127.0.0.1:18766', 'http://127.0.0.1:18765/path']) {
    assert.throws(() => new AnkiClient({ endpoint, isolatedTestMode: true, fetch: fetcher }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => new AnkiClient({ endpoint: 'http://127.0.0.1:18765', fetch: fetcher }), { code: 'INVALID_INPUT' });
  assert.equal(urls.length, 1, 'rejected endpoints cause zero fetches');
});
