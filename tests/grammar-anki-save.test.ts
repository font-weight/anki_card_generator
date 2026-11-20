import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { AnkiClient, AnkiError } from '../packages/services/src/anki.ts';
import { GrammarSaveCoordinator } from '../packages/services/src/grammar-save.ts';
import { openReaderStorage } from '../packages/storage/src/index.ts';
import { GRAMMAR_MODEL_NAME, GRAMMAR_CURRENT_MODEL_NAME, GRAMMAR_NOTE_FIELDS, grammarModelDefinition, grammarSemanticKeys } from '../packages/note-templates/src/grammar.ts';
import type { GrammarModelName } from '../packages/note-templates/src/grammar.ts';
import type { GrammarDraft } from '../packages/contracts/src/grammar.ts';

const draft: GrammarDraft = {
  draftKind: 'grammar', draftVersion: 1, sentence: 'They were sitting nearby.',
  construction: { text: 'were sitting', targetStart: 5, targetEnd: 17 },
  question: 'Что выражает were sitting?', answer: 'Действие в процессе в прошлом.',
  rule: 'Прошедшее длительное время.', explanation: null, translation: 'Они сидели неподалёку.',
  sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru', learnerLevel: 'B1',
  deckName: 'grammar', tags: ['Grammar'],
  source: { kind: 'html', title: 'Synthetic', url: 'https://example.test', documentId: null, page: null, chapter: null, cfi: null },
};
type Model = { fields: string[]; name: string; type: number; tmpls: { qfmt: string; afmt: string }[] };
function model(name: GrammarModelName): Model {
  const definition = grammarModelDefinition(name);
  return { name, fields: [...GRAMMAR_NOTE_FIELDS], type: 0, tmpls: [{ qfmt: definition.cardTemplates[0]!.Front, afmt: definition.cardTemplates[0]!.Back }] };
}
function mockAnki(initial: Model[] = []) {
  const models = new Map(initial.map(value => [value.name, value]));
  const calls: { action: string; params: any }[] = [];
  const notes: { noteId: number; modelName: string; fields: Record<string, { value: string; order: number }> }[] = [];
  let intercept: ((body: typeof calls[number]) => Response | undefined) | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const intercepted = intercept?.(body); if (intercepted) return intercepted;
    let result: unknown;
    switch (body.action) {
      case 'version': result = 6; break;
      case 'deckNames': result = ['grammar']; break;
      case 'modelNames': result = [...models.keys()]; break;
      case 'modelFieldNames': result = models.get(body.params.modelName)?.fields; break;
      case 'findModelsByName': result = body.params.modelNames.map((name: string) => models.get(name)); break;
      case 'createModel': {
        assert.equal(models.has(body.params.modelName), false, 'existing model must never be overwritten');
        assert.deepEqual(body.params, grammarModelDefinition(body.params.modelName));
        const created = model(body.params.modelName); models.set(created.name, created); result = created; break;
      }
      case 'findNotes': {
        assert.match(body.params.query, /note:LanguageReader\.Grammar\.v1/);
        assert.match(body.params.query, /note:LanguageReader\.Grammar\.v2/);
        result = notes.filter(note => body.params.query.includes(note.fields.OperationId!.value)).map(note => note.noteId); break;
      }
      case 'notesInfo': result = notes.filter(note => body.params.notes.includes(note.noteId)); break;
      case 'addNote': {
        const note = body.params.note;
        assert.deepEqual(note.options, { allowDuplicate: false, duplicateScope: 'collection' });
        result = 700 + notes.length;
        notes.push({ noteId: result as number, modelName: note.modelName,
          fields: Object.fromEntries(Object.entries(note.fields).map(([key, value], order) => [key, { value: value as string, order }])) }); break;
      }
      case 'guiBrowse': result = []; break;
      default: throw new Error(`Unexpected mocked action ${body.action}`);
    }
    return Response.json({ result, error: null });
  };
  return { models, calls, notes, client: new AnkiClient({ fetch: fetcher }), intercept: (handler?: typeof intercept) => { intercept = handler; } };
}
const mutations = (mock: ReturnType<typeof mockAnki>) => mock.calls.filter(call => call.action === 'createModel' || call.action === 'addNote');

test('compatible v1 uses named fields despite harmless ordering and unused extra fields', async () => {
  const existing = model(GRAMMAR_MODEL_NAME);
  existing.fields = ['OperationId', ...GRAMMAR_NOTE_FIELDS.slice(1).reverse(), 'PrivateUnusedField'];
  const mock = mockAnki([existing]);
  assert.equal(await mock.client.assertGrammarReady(draft), GRAMMAR_MODEL_NAME);
  assert.deepEqual(await mock.client.initializeGrammarModel(true), { created: [], existing: [GRAMMAR_MODEL_NAME] });
  assert.deepEqual(mutations(mock), []);
  assert.equal(mock.models.get(GRAMMAR_MODEL_NAME), existing);
});

test('missing fields, nonunique primary field, altered rendering and multiple/cloze cards remain incompatible', async () => {
  const cases: ((value: Model) => void)[] = [
    value => { value.fields = value.fields.filter(field => field !== 'Translation'); },
    value => { value.fields = ['Sentence', ...value.fields.filter(field => field !== 'Sentence')]; },
    value => { value.fields.push('Question'); },
    value => { value.tmpls[0]!.qfmt = '{{Question}}'; },
    value => { value.tmpls.push({ ...value.tmpls[0]! }); },
    value => { value.type = 1; },
  ];
  for (const change of cases) {
    const existing = model(GRAMMAR_MODEL_NAME); change(existing);
    const mock = mockAnki([existing]);
    await assert.rejects(mock.client.assertGrammarReady(draft), { code: 'ANKI_SCHEMA_MISMATCH' });
    assert.deepEqual(mutations(mock), []);
  }
});

test('explicit setup creates separate v2 for missing or incompatible v1 and preserves existing content', async () => {
  for (const legacy of [undefined, { ...model(GRAMMAR_MODEL_NAME), fields: ['Front', 'Back'] }]) {
    const mock = mockAnki(legacy ? [legacy] : []);
    await assert.rejects(mock.client.initializeGrammarModel(false), { code: 'PERMISSION_DENIED' });
    assert.deepEqual(mock.calls, []);
    const before = structuredClone(legacy);
    assert.deepEqual(await mock.client.initializeGrammarModel(true), { created: [GRAMMAR_CURRENT_MODEL_NAME], existing: [] });
    assert.deepEqual(mock.models.get(GRAMMAR_MODEL_NAME), before);
    assert.equal(await mock.client.assertGrammarReady(draft), GRAMMAR_CURRENT_MODEL_NAME);
    assert.deepEqual(await mock.client.initializeGrammarModel(true), { created: [], existing: [GRAMMAR_CURRENT_MODEL_NAME] });
    assert.equal(mutations(mock).length, 1);
    assert.equal(mock.notes.length, 0);
  }
});

test('an incompatible v2 collision is reported rather than rewritten or bypassed with arbitrary model names', async () => {
  const mock = mockAnki([{ ...model(GRAMMAR_MODEL_NAME), fields: ['Wrong'] }, { ...model(GRAMMAR_CURRENT_MODEL_NAME), fields: ['Wrong'] }]);
  const before = structuredClone([...mock.models.values()]);
  await assert.rejects(mock.client.initializeGrammarModel(true), { code: 'ANKI_SCHEMA_MISMATCH' });
  assert.deepEqual([...mock.models.values()], before);
  assert.deepEqual(mutations(mock), []);
});

test('auth, transport and malformed schema responses never masquerade as permission to create a fallback', async () => {
  for (const response of [Response.json({ result: null, error: 'invalid key' }), new Response('broken json'), Response.json({ result: [1], error: null }), new Response('', { status: 503 })]) {
    const mock = mockAnki([model(GRAMMAR_MODEL_NAME)]);
    mock.intercept(body => body.action === 'modelFieldNames' ? response : undefined);
    await assert.rejects(mock.client.initializeGrammarModel(true));
    assert.deepEqual(mutations(mock), []);
  }
});

test('a schema preflight failure can be repaired explicitly and saved with the same operation and draft', async () => {
  const mock = mockAnki([{ ...model(GRAMMAR_MODEL_NAME), fields: ['LegacyQuestion', 'LegacyAnswer'] }]);
  const storage = await openReaderStorage({ indexedDB: new IDBFactory() });
  try {
    const save = new GrammarSaveCoordinator(storage, () => mock.client), operationId = crypto.randomUUID();
    const payload = { operationId, draft };
    await assert.rejects(save.add(payload), { code: 'ANKI_SCHEMA_MISMATCH' });
    assert.equal(await storage.getMetadata(`grammar-operation:${operationId}`), null);
    assert.deepEqual(mutations(mock), []);
    await mock.client.initializeGrammarModel(true);
    const saved = await save.add(payload);
    assert.equal(saved.status, 'added'); assert.equal(saved.noteId, 700);
    assert.equal(mock.notes[0]!.modelName, GRAMMAR_CURRENT_MODEL_NAME);
    assert.equal(mock.notes[0]!.fields.OperationId!.value, operationId);
    assert.equal(mock.notes[0]!.fields.Answer!.value, draft.answer);
    assert.equal((await save.add(payload)).status, 'already_added');
    assert.equal(mock.calls.filter(call => call.action === 'addNote').length, 1);
  } finally { storage.close(); }
});

test('a known-failed add retries explicitly after repair, using the same frozen operation without duplicate notes', async () => {
  const mock = mockAnki([model(GRAMMAR_MODEL_NAME)]), operationId = crypto.randomUUID();
  const storage = await openReaderStorage({ indexedDB: new IDBFactory() });
  try {
    mock.intercept(body => {
      if (body.action !== 'addNote') return undefined;
      mock.models.get(GRAMMAR_MODEL_NAME)!.fields = ['ChangedElsewhere'];
      return Response.json({ result: null, error: 'model field not found' });
    });
    await assert.rejects(new GrammarSaveCoordinator(storage, () => mock.client).add({ operationId, draft }), { code: 'ANKI_SCHEMA_MISMATCH' });
    assert.equal((await storage.getMetadata<any>(`grammar-operation:${operationId}`))?.state, 'retryable');
    await mock.client.initializeGrammarModel(true); mock.intercept();
    const retry = new GrammarSaveCoordinator(storage, () => mock.client);
    assert.equal((await retry.add({ operationId, draft })).status, 'added');
    assert.equal((await retry.add({ operationId, draft })).status, 'already_added');
    const adds = mock.calls.filter(call => call.action === 'addNote');
    assert.equal(adds.length, 2); assert.equal(mock.notes.length, 1);
    assert.equal(adds[0]!.params.note.modelName, GRAMMAR_MODEL_NAME);
    assert.equal(adds[1]!.params.note.modelName, GRAMMAR_CURRENT_MODEL_NAME);
    assert.deepEqual(adds[1]!.params.note.fields, adds[0]!.params.note.fields);
  } finally { storage.close(); }
});

test('an uncertain old-model add is reconciled across both namespaces before model setup checks', async () => {
  const mock = mockAnki([model(GRAMMAR_MODEL_NAME)]), operationId = crypto.randomUUID();
  const storage = await openReaderStorage({ indexedDB: new IDBFactory() });
  try {
    const adapter = {
      assertGrammarReady: (value: GrammarDraft) => mock.client.assertGrammarReady(value),
      findGrammarOperation: (id: string, keys: { contentKey: string; lexemeKey: string }) => mock.client.findGrammarOperation(id, keys),
      addGrammarNote: async (id: string, value: GrammarDraft, keys: { contentKey: string; lexemeKey: string }, name: GrammarModelName) => {
        await mock.client.addGrammarNote(id, value, keys, name);
        throw new AnkiError('NETWORK_TIMEOUT', 'Lost add response', true, true);
      },
    };
    await assert.rejects(new GrammarSaveCoordinator(storage, () => adapter).add({ operationId, draft }), { code: 'NETWORK_TIMEOUT' });
    mock.models.get(GRAMMAR_MODEL_NAME)!.fields = ['EditedAfterAdd'];
    await mock.client.initializeGrammarModel(true);
    const before = mock.calls.length;
    const result = await new GrammarSaveCoordinator(storage, () => mock.client).add({ operationId, draft });
    assert.equal(result.status, 'already_added'); assert.equal(result.noteId, 700);
    assert.deepEqual(mock.calls.slice(before).map(call => call.action), ['findNotes', 'notesInfo']);
    assert.equal(mock.calls.filter(call => call.action === 'addNote').length, 1);
    assert.equal(mock.notes.length, 1);
  } finally { storage.close(); }
});

test('operation identity must match exactly across v1 and v2 and duplicate matches block adds', async () => {
  const mock = mockAnki([model(GRAMMAR_MODEL_NAME), model(GRAMMAR_CURRENT_MODEL_NAME)]);
  const operationId = crypto.randomUUID(), keys = await grammarSemanticKeys(draft);
  await mock.client.addGrammarNote(operationId, draft, keys, GRAMMAR_CURRENT_MODEL_NAME);
  assert.equal(await mock.client.findGrammarOperation(operationId, keys), 700);
  await mock.client.openNote(700);
  await mock.client.addGrammarNote(operationId, draft, keys, GRAMMAR_MODEL_NAME);
  await assert.rejects(mock.client.findGrammarOperation(operationId, keys), { code: 'OPERATION_CONFLICT' });
});

test('a malformed add response remains pending and a new model never authorizes blind re-add', async () => {
  const mock = mockAnki([model(GRAMMAR_MODEL_NAME)]), operationId = crypto.randomUUID();
  const storage = await openReaderStorage({ indexedDB: new IDBFactory() });
  try {
    mock.intercept(body => body.action === 'addNote' ? new Response('lost response') : undefined);
    await assert.rejects(new GrammarSaveCoordinator(storage, () => mock.client).add({ operationId, draft }),
      (error: AnkiError) => error.code === 'ANKI_SCHEMA_MISMATCH' && error.uncertain);
    assert.equal((await storage.getMetadata<any>(`grammar-operation:${operationId}`))?.state, 'pending');
    mock.models.get(GRAMMAR_MODEL_NAME)!.fields = ['Incompatible'];
    await mock.client.initializeGrammarModel(true); mock.intercept();
    await assert.rejects(new GrammarSaveCoordinator(storage, () => mock.client).add({ operationId, draft }), { code: 'OPERATION_CONFLICT' });
    assert.equal(mock.calls.filter(call => call.action === 'addNote').length, 1);
    assert.equal(mock.notes.length, 0);
  } finally { storage.close(); }
});

test('uncertain setup is checked on explicit retry and an already created v2 is not created twice', async () => {
  const mock = mockAnki();
  mock.intercept(body => {
    if (body.action !== 'createModel') return undefined;
    mock.models.set(GRAMMAR_CURRENT_MODEL_NAME, model(GRAMMAR_CURRENT_MODEL_NAME));
    return new Response('lost response');
  });
  await assert.rejects(mock.client.initializeGrammarModel(true), { code: 'ANKI_SCHEMA_MISMATCH' });
  mock.intercept();
  assert.deepEqual(await mock.client.initializeGrammarModel(true), { created: [], existing: [GRAMMAR_CURRENT_MODEL_NAME] });
  assert.equal(mock.calls.filter(call => call.action === 'createModel').length, 1);
});

test('new grammar notes on an existing model print the FB2 chapter and preserve the source snapshot', async () => {
  for (const name of [GRAMMAR_MODEL_NAME, GRAMMAR_CURRENT_MODEL_NAME] as const) {
    const mock = mockAnki([model(name)]);
    const savedDraft = structuredClone(draft);
    savedDraft.source = { kind:'fb2', title:'The Quiet Coast', page:null, url:null, documentId:'local-book',
      chapter:'The Harbour at Dawn', cfi:'epubcfi(/6/2!/4/2:0)' };
    const before = structuredClone(savedDraft.source);
    const existing = await mock.client.assertGrammarReady(savedDraft);
    await mock.client.addGrammarNote(crypto.randomUUID(), savedDraft, await grammarSemanticKeys(savedDraft), existing);
    const note = mock.notes[0]!;
    assert.equal(note.modelName, name);
    assert.equal(note.fields.SourceLocation!.value, 'FB2 · The Harbour at Dawn');
    assert.doesNotMatch(JSON.stringify(note.fields), /epubcfi\(/i);
    assert.deepEqual(savedDraft.source, before);
    assert.deepEqual(mutations(mock).map(call => call.action), ['addNote']);
  }
});
