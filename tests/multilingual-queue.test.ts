import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openReaderStorage } from '../packages/storage/src/index.ts';
import type { StoredOperation } from '../packages/storage/src/index.ts';
import { createReaderServices, SecretVault } from '../packages/services/src/index.ts';
import { DurableQueue } from '../packages/services/src/queue.ts';
import type { DurableQueueOptions, QueueRecord, QueueStore } from '../packages/services/src/queue.ts';
import { AnkiClient } from '../packages/services/src/anki.ts';
import type { PreparedAnkiNote } from '../packages/services/src/anki.ts';
import { createDraftAudioSnapshot, createAudioInputCacheKey } from '../packages/services/src/audio.ts';
import type { AudioSnapshot } from '../packages/services/src/audio.ts';
import {
  ALL_MODEL_NAMES, MODEL_NAMES, MULTILINGUAL_MODEL_NAMES, NOTE_FIELDS,
  modelDefinition, semanticKeys,
} from '../packages/note-templates/src/index.ts';
import { LANGUAGE_CODES, validateNoteDraft } from '../packages/contracts/src/index.ts';
import type {
  AddNotePayload, Dialect, LegacyNoteDraft, MultilingualNoteDraft, NoteDraft,
} from '../packages/contracts/src/index.ts';

const operationId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const audioId = '33333333-3333-4333-8333-333333333333';
const thirdId = '44444444-4444-4444-8444-444444444444';

function multilingualDraft(): MultilingualNoteDraft {
  return {
    draftVersion: 2, sourceLanguage: 'fr', targetLanguage: 'ru', learnerLevel: 'B1',
    mode: 'recognition', deckName: 'Language test', tags: ['reader'],
    expression: 'chat', lemma: 'chat', partOfSpeech: 'noun',
    selectedSense: { id: 'cat', translations: ['кот'], definition: 'Un petit animal domestique.' },
    context: { sentence: 'Le chat dort.', targetStart: 3, targetEnd: 7 },
    pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null },
    examples: [{ text: 'Le chat joue.', translation: 'Кот играет.', source: 'ai' }],
    source: { kind: 'html', title: 'Fixture', url: 'https://example.com/book', documentId: null,
      page: null, chapter: null, cfi: null },
  };
}

function legacyDraft(): LegacyNoteDraft {
  return {
    sourceLanguage: 'en', targetLanguage: 'ru', mode: 'recognition', deckName: 'Language test', tags: ['reader'],
    expression: 'read', lemma: 'read', partOfSpeech: 'verb',
    selectedSense: { id: 'read', translations: ['читать'], definitionEn: 'To understand written words.' },
    context: { sentence: 'I read books.', targetStart: 2, targetEnd: 6 },
    pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null },
    extraExample: { textEn: 'I read every day.', textRu: 'Я читаю каждый день.', source: 'ai' },
    source: { kind: 'html', title: 'Fixture', url: 'https://example.com/book', documentId: null,
      page: null, chapter: null, cfi: null },
  };
}

function upgradedEnglishDraft(): MultilingualNoteDraft {
  const old = legacyDraft();
  const { selectedSense, extraExample, ...rest } = old;
  return { ...rest, draftVersion: 2, learnerLevel: 'B1',
    selectedSense: { id: selectedSense.id, translations: [...selectedSense.translations], definition: selectedSense.definitionEn },
    examples: extraExample ? [{ text: extraExample.textEn, translation: extraExample.textRu, source: 'ai' }] : [],
  };
}

const payload = (draft: NoteDraft = multilingualDraft(), id = operationId): AddNotePayload =>
  ({ operationId: id, draft, includeAudio: false });

// Deliberately mocked persistence and AnkiConnect transport. Nothing reaches a live profile,
// provider, desktop, filesystem store, or paid endpoint; real queue/client code is exercised.
class MockStore implements QueueStore {
  rows = new Map<string, QueueRecord>();
  async create(row: QueueRecord) {
    const old = this.rows.get(row.operationId);
    if (old) return { created: false, record: structuredClone(old) };
    this.rows.set(row.operationId, structuredClone(row));
    return { created: true, record: structuredClone(row) };
  }
  async get(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  async compareAndSwap(id: string, revision: number, row: QueueRecord) {
    if (this.rows.get(id)?.revision !== revision) return false;
    this.rows.set(id, structuredClone(row));
    return true;
  }
  async list() { return structuredClone([...this.rows.values()]); }
}

type MockRequest = { action: string; params: Record<string, any> };
type RemoteNote = { noteId: number; note: PreparedAnkiNote };
const response = (result: unknown) => new Response(JSON.stringify({ result, error: null }));

function setup(extra: Pick<DurableQueueOptions, 'audio'> = {}, store: QueueStore = new MockStore()) {
  const remote = new Map<number, RemoteNote>();
  const requests: MockRequest[] = [];
  const models = new Map<string, ReturnType<typeof modelDefinition>>();
  for (const version of [1, 2] as const) {
    for (const mode of ['recognition', 'cloze'] as const) {
      const model = modelDefinition(mode, version);
      models.set(model.modelName, model);
    }
  }
  let offline = false, loseNextAddReply = false, now = 1_000_000;
  let addCount = 0, mediaCount = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as MockRequest;
    requests.push(structuredClone(request));
    assert.ok((await store.list()).length > 0, 'durable intent precedes every mocked external request');
    if (offline) throw new TypeError('Mock Anki offline');
    switch (request.action) {
      case 'findNotes': {
        const query = String(request.params.query);
        for (const name of ALL_MODEL_NAMES) assert.ok(query.includes(`"note:${name}"`), `search includes ${name}`);
        const match = /"(OperationId|LexemeKey):([0-9a-f-]+)"/iu.exec(query);
        assert.ok(match, 'only generated exact-key searches');
        return response([...remote.values()].filter(({ note }) => note.fields[match[1]!] === match[2]).map(({ noteId }) => noteId));
      }
      case 'notesInfo':
        return response((request.params.notes as number[]).map(id => {
          const saved = remote.get(id)!;
          return { noteId: id, modelName: saved.note.modelName,
            fields: Object.fromEntries(Object.entries(saved.note.fields).map(([name, value], order) => [name, { value, order }])) };
        }));
      case 'version': return response(6);
      case 'deckNames': return response(['Language test']);
      case 'modelFieldNames': return response(models.get(request.params.modelName)!.inOrderFields);
      case 'findModelsByName':
        return response((request.params.modelNames as string[]).map(name => {
          const model = models.get(name)!;
          return { name, type: model.isCloze ? 1 : 0,
            tmpls: [{ qfmt: model.cardTemplates[0]!.Front, afmt: model.cardTemplates[0]!.Back }] };
        }));
      case 'storeMediaFile':
        mediaCount++;
        assert.equal(request.params.deleteExisting, false);
        return response('multilingual-fixture.mp3');
      case 'addNote': {
        const note = request.params.note as PreparedAnkiNote;
        const saved = await store.get(note.fields.OperationId!);
        assert.equal(saved?.state, 'submitting');
        assert.equal(saved?.submissionUncertain, true);
        assert.deepEqual(note.options, { allowDuplicate: false, duplicateScope: 'collection' });
        assert.ok(![...remote.values()].some(row => row.note.fields.OperationId === note.fields.OperationId), 'never submit a duplicate operation');
        const noteId = 100 + remote.size;
        remote.set(noteId, { noteId, note: structuredClone(note) });
        addCount++;
        if (loseNextAddReply) { loseNextAddReply = false; throw new TypeError('Mock lost response after acceptance'); }
        return response(noteId);
      }
      default: throw new Error(`Unexpected mocked Anki action: ${request.action}`);
    }
  };
  const anki = new AnkiClient({ fetch: fetcher });
  const options: DurableQueueOptions = { store, anki, now: () => now, ...extra };
  return {
    store, remote, requests, anki, options, fetcher, queue: new DurableQueue(options),
    offline: (value: boolean) => { offline = value; },
    loseReply: () => { loseNextAddReply = true; },
    advance: (delta: number) => { now += delta; },
    counts: () => ({ addCount, mediaCount }),
  };
}

test('v2 queued language pair, examples, level and audio survive caller/preferences mutation and worker restart', async () => {
  const preferences: { dialect: Dialect; speed: number } = { dialect: 'fr-FR', speed: 0.8 };
  const prepared: AudioSnapshot[] = [];
  let snapshotCalls = 0;
  const h = setup({ audio: {
    snapshot: async draft => { snapshotCalls++; return createDraftAudioSnapshot(draft, preferences); },
    prepare: async snapshot => { prepared.push(structuredClone(snapshot)); return { audioId }; },
    read: async (id, snapshot) => { assert.equal(id, audioId); assert.deepEqual(snapshot, prepared[0]); return new Uint8Array([73, 68, 51, 4]); },
  } });
  h.offline(true);
  const input = { ...payload(), includeAudio: true };
  const original = structuredClone(input);
  const pending = h.queue.add(input);
  const mutable = input.draft as MultilingualNoteDraft;
  mutable.sourceLanguage = 'ja'; mutable.targetLanguage = 'en'; mutable.learnerLevel = 'C2';
  mutable.examples[0]!.text = 'Changed caller text'; mutable.selectedSense.translations[0] = 'Changed meaning';
  assert.equal((await pending).status, 'queued');
  const before = await h.store.get(operationId);
  assert.deepEqual(before?.draft, original.draft);
  assert.equal(before?.audioSnapshot?.snapshotVersion, 2);
  assert.equal(before?.audioSnapshot?.dialect, 'fr-FR');
  assert.equal(before?.audioSnapshot?.speed, 0.8);
  assert.equal(before?.audioCacheKey, await createAudioInputCacheKey(before!.audioSnapshot!));
  preferences.dialect = 'ja-JP'; preferences.speed = 2;
  await h.queue.add(original);
  assert.equal(snapshotCalls, 1, 'same operation must not resnapshot changed settings');
  const listed = await h.queue.list();
  (listed[0]!.draft as MultilingualNoteDraft).examples.length = 0;
  assert.deepEqual((await h.store.get(operationId))?.draft, original.draft, 'returned records are not live storage aliases');
  h.offline(false);
  const after = await new DurableQueue(h.options).retry(operationId);
  assert.equal(after.state, 'synced');
  assert.deepEqual(after.draft, before!.draft);
  assert.deepEqual(after.audioSnapshot, before!.audioSnapshot);
  assert.deepEqual(after.keys, before!.keys);
  assert.equal(after.fingerprint, before!.fingerprint);
  assert.deepEqual(prepared, [before!.audioSnapshot]);
  const note = h.remote.get(after.noteId!)!.note;
  assert.equal(note.modelName, MULTILINGUAL_MODEL_NAMES.recognition);
  assert.equal(note.fields.SourceLanguage, 'fr'); assert.equal(note.fields.TargetLanguage, 'ru');
  assert.equal(note.fields.LearnerLevel, 'B1');
  assert.match(note.fields.Examples!, /Le chat joue/);
  assert.equal(note.fields.Audio, '[sound:multilingual-fixture.mp3]');
  assert.deepEqual(h.counts(), { addCount: 1, mediaCount: 1 });
});

test('same v2 OperationId rejects changed pair, selected examples, example translation, level or version', async () => {
  const h = setup(); h.offline(true);
  const original = payload(); await h.queue.add(original);
  const before = await h.store.get(operationId);
  const changes: Array<(draft: MultilingualNoteDraft) => void> = [
    draft => { draft.sourceLanguage = 'es'; },
    draft => { draft.targetLanguage = 'en'; },
    draft => { draft.examples = []; },
    draft => { draft.examples[0]!.text = 'Un autre chat dort.'; },
    draft => { draft.examples[0]!.translation = 'Другой кот спит.'; },
    draft => { draft.learnerLevel = 'C1'; },
  ];
  for (const change of changes) {
    const different = structuredClone(original);
    change(different.draft as MultilingualNoteDraft);
    await assert.rejects(h.queue.add(different), { code: 'OPERATION_CONFLICT' });
    assert.deepEqual(await h.store.get(operationId), before, 'conflict cannot mutate durable intent');
  }
  await assert.rejects(h.queue.add(payload(legacyDraft())), { code: 'OPERATION_CONFLICT' });
  assert.equal(h.counts().addCount, 0);
});

for (const mode of ['recognition', 'cloze'] as const) {
  test(`v2 ${mode} lost reply reconciles exact v2 model after restart without second add`, async () => {
    const h = setup(); h.loseReply();
    const draft = multilingualDraft(); draft.mode = mode;
    assert.equal((await h.queue.add(payload(draft))).status, 'queued');
    const before = await h.store.get(operationId);
    assert.equal(before?.state, 'reconciling'); assert.equal(before?.submissionUncertain, true);
    assert.equal(h.remote.get(100)!.note.modelName, MULTILINGUAL_MODEL_NAMES[mode]);
    await assert.rejects(h.anki.findOperation(operationId, before!.keys, mode, 1), { code: 'OPERATION_CONFLICT' });
    assert.equal(await h.anki.findOperation(operationId, before!.keys, mode, 2), 100);
    const after = await new DurableQueue(h.options).retry(operationId);
    assert.equal(after.state, 'synced'); assert.equal(after.noteId, 100);
    assert.equal(after.submissionUncertain, false);
    assert.equal(after.fingerprint, before!.fingerprint);
    assert.equal(h.counts().addCount, 1);
    assert.equal((await h.queue.add(payload(draft))).status, 'already_added');
    assert.equal(h.counts().addCount, 1);
  });
}

test('v2 reconciliation refuses a legacy-model operation collision instead of claiming success or resubmitting', async () => {
  const h = setup(); h.loseReply();
  await h.queue.add(payload());
  h.remote.get(100)!.note.modelName = MODEL_NAMES.recognition;
  const after = await new DurableQueue(h.options).retry(operationId);
  assert.equal(after.state, 'reconciling');
  assert.equal(after.lastError?.code, 'OPERATION_CONFLICT');
  assert.equal(after.submissionUncertain, true);
  assert.equal(after.noteId, null);
  assert.equal(h.counts().addCount, 1);
});

test('v2 en→ru detects legacy lexical duplicates while keeping distinct content and requiring add_new consent', async () => {
  const h = setup();
  const old = payload(legacyDraft());
  assert.equal((await h.queue.add(old)).status, 'added');
  const legacyBefore = structuredClone(h.remote.get(100));
  const next = payload(upgradedEnglishDraft(), secondId);
  const legacyKeys = await semanticKeys(old.draft), nextKeys = await semanticKeys(next.draft);
  assert.equal(nextKeys.lexemeKey, legacyKeys.lexemeKey);
  assert.notEqual(nextKeys.contentKey, legacyKeys.contentKey);
  const matches = await h.anki.findDuplicates(next.draft, nextKeys);
  assert.deepEqual(matches.map(match => [match.noteId, match.modelName, match.exactContent]), [[100, MODEL_NAMES.recognition, false]]);
  assert.equal((await h.queue.add(next)).status, 'duplicate_review');
  assert.equal(h.counts().addCount, 1);
  await assert.rejects(h.queue.add({ ...next, duplicateAction: 'add_new' }), { code: 'PERMISSION_DENIED' });
  assert.equal((await h.queue.add({ ...next, duplicateAction: 'add_new' }, { duplicateConfirmed: true })).status, 'already_added');
  assert.equal(h.counts().addCount, 2);
  assert.deepEqual(h.remote.get(100), legacyBefore, 'legacy note remains untouched');
  assert.equal(h.remote.get(101)!.note.modelName, MULTILINGUAL_MODEL_NAMES.recognition);
  assert.equal((await h.anki.findDuplicates(old.draft)).length, 2, 'legacy reader also sees new v2 lexical duplicate');
});

test('changed v2 language pair is independent; changed examples/level still trigger lexical duplicate review', async () => {
  const h = setup();
  assert.equal((await h.queue.add(payload())).status, 'added');
  const otherPair = multilingualDraft(); otherPair.targetLanguage = 'en';
  assert.equal((await h.queue.add(payload(otherPair, secondId))).status, 'added');
  const otherExamples = multilingualDraft(); otherExamples.examples = []; otherExamples.learnerLevel = 'A1';
  assert.equal((await h.queue.add(payload(otherExamples, thirdId))).status, 'duplicate_review');
  assert.equal(h.counts().addCount, 2);
  assert.notEqual((await h.store.get(operationId))?.keys.lexemeKey, (await h.store.get(secondId))?.keys.lexemeKey);
});

test('legacy queued draft, audio snapshot, keys and fingerprint are not upgraded during v2-era recovery', async () => {
  const prepared: AudioSnapshot[] = [];
  let snapshotCalls = 0;
  const h = setup({ audio: {
    snapshot: async draft => { snapshotCalls++; return createDraftAudioSnapshot(draft, { dialect: 'en-GB', speed: 0.75 }); },
    prepare: async snapshot => { prepared.push(structuredClone(snapshot)); return { audioId }; },
    read: async () => new Uint8Array([73, 68, 51, 4]),
  } });
  h.offline(true);
  const original = { ...payload(legacyDraft()), includeAudio: true };
  await h.queue.add(original);
  const before = await h.store.get(operationId);
  assert.equal(before?.audioSnapshot?.snapshotVersion, 1);
  assert.equal(Object.hasOwn(before!.draft, 'draftVersion'), false);
  h.offline(false); h.advance(30_001);
  await new DurableQueue(h.options).recover();
  const after = await h.store.get(operationId);
  assert.equal(after?.state, 'synced');
  assert.deepEqual(after?.draft, before!.draft);
  assert.deepEqual(after?.audioSnapshot, before!.audioSnapshot);
  assert.deepEqual(after?.keys, before!.keys);
  assert.equal(after?.fingerprint, before!.fingerprint);
  assert.equal(after?.audioCacheKey, before!.audioCacheKey);
  assert.deepEqual(prepared, [before!.audioSnapshot]); assert.equal(snapshotCalls, 1);
  assert.equal(Object.hasOwn(after!.draft, 'draftVersion'), false);
  const note = h.remote.get(after!.noteId!)!.note;
  assert.equal(note.modelName, MODEL_NAMES.recognition);
  assert.deepEqual(Object.keys(note.fields), [...NOTE_FIELDS]);
  assert.equal(note.fields.DefinitionEN, legacyDraft().selectedSense.definitionEn);
  assert.equal(note.fields.ExtraExample, legacyDraft().extraExample!.textEn);
  assert.equal(note.fields.Definition, undefined); assert.equal(note.fields.Examples, undefined);
  assert.equal(note.fields.SourceLanguage, undefined);
});

test('legacy lost reply still reconciles as v1 even when v2 models are present', async () => {
  const h = setup(); h.loseReply();
  const original = payload(legacyDraft());
  assert.equal((await h.queue.add(original)).status, 'queued');
  const before = await h.store.get(operationId);
  assert.equal(before?.state, 'reconciling');
  assert.equal(await h.anki.findOperation(operationId, before!.keys, 'recognition'), 100, 'omitted version is still legacy v1');
  await assert.rejects(h.anki.findOperation(operationId, before!.keys, 'recognition', 2), { code: 'OPERATION_CONFLICT' });
  const after = await new DurableQueue(h.options).retry(operationId);
  assert.equal(after.state, 'synced'); assert.equal(after.noteId, 100);
  assert.deepEqual(after.draft, original.draft);
  assert.equal(h.counts().addCount, 1);
});

for (const version of [1, 2] as const) {
test(`canonical service adapter reconciles v${version} model across durable storage restart`, async () => {
  const factory = new IDBFactory();
  let storage = await openReaderStorage({ indexedDB: factory });
  const store: QueueStore = {
    create: async row => storage.createOperation(row as unknown as StoredOperation) as unknown as Promise<{ created: boolean; record: QueueRecord }>,
    get: async id => storage.getOperation(id) as unknown as Promise<QueueRecord | null>,
    compareAndSwap: async (id, revision, row) => storage.compareAndSwap(id, revision, row as unknown as StoredOperation),
    list: async () => storage.allOperations() as unknown as Promise<QueueRecord[]>,
  };
  const h = setup({}, store);
  const area = () => {
    const values: Record<string, unknown> = {};
    return {
      get: async (keys: string | string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, values[key]])),
      set: async (data: Record<string, unknown>) => { Object.assign(values, data); },
      remove: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key]; },
      setAccessLevel: async () => {},
    };
  };
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const sender = { id: extensionId, url: `chrome-extension://${extensionId}/queue.html`, frameId: 0 };
  const secrets = new SecretVault({ session: area(), local: area() });
  let now = 1_000_000;
  const makeApp = () => createReaderServices({
    storage, secrets, fetch: h.fetcher, now: () => now,
    runtime: { extensionId, allowedPageUrls: [sender.url], isRegisteredReader: () => false },
  });
  let app = makeApp();
  try {
    h.loseReply();
    const original = payload(version === 1 ? legacyDraft() : multilingualDraft());
    const added = await app.handleMessage({ v: 1, requestId: secondId, type: 'anki.addNote', payload: original }, sender);
    assert.ok(added.ok, JSON.stringify(added));
    assert.deepEqual(added.data, { operationId, status: 'queued', noteId: null });
    const before = await store.get(operationId);
    assert.equal(before?.state, 'reconciling');
    assert.equal(h.counts().addCount, 1);
    app.close();
    storage = await openReaderStorage({ indexedDB: factory });
    now += 30_001;
    app = makeApp();
    await app.resumeQueue();
    const after = await store.get(operationId);
    assert.equal(after?.state, 'synced', 'adapter must pass draft version, not fall back to v1 during exact model verification');
    assert.equal(after?.noteId, 100);
    assert.equal(after?.lastError, null);
    assert.deepEqual(after?.draft, before!.draft);
    assert.equal(after?.fingerprint, before!.fingerprint);
    assert.equal(h.remote.get(100)!.note.modelName, version === 1 ? MODEL_NAMES.recognition : MULTILINGUAL_MODEL_NAMES.recognition);
    assert.equal(Object.hasOwn(after!.draft, 'draftVersion'), version === 2);
    assert.equal(h.counts().addCount, 1, 'reconciliation never sends a second add');
  } finally { app.close(); }
});
}

test('all 17 source languages save v2 notes with exact UTF-16 context/range and neutral fields', async () => {
  const words = {
    en: 'cat', ru: 'кот', es: 'gato', fr: 'chat', de: 'Katze', it: 'gatto', pt: 'gato',
    zh: '猫', ja: '猫', ko: '고양이', ar: 'قط', hi: 'बिल्ली', tr: 'kedi', uk: 'кіт', pl: 'kot', nl: 'kat', kk: 'мысық',
  } as const;
  assert.equal(LANGUAGE_CODES.length, 17);
  for (const sourceLanguage of LANGUAGE_CODES) {
    const h = setup();
    const draft = multilingualDraft();
    draft.sourceLanguage = sourceLanguage; draft.targetLanguage = sourceLanguage === 'ru' ? 'en' : 'ru';
    draft.expression = words[sourceLanguage]; draft.lemma = words[sourceLanguage]; draft.mode = 'cloze';
    // An astral prefix checks that JS/Anki offsets remain UTF-16, not code-point positions.
    draft.context = { sentence: `🐈 ${draft.expression}.`, targetStart: 3, targetEnd: 3 + draft.expression.length };
    draft.examples = [];
    validateNoteDraft(draft);
    assert.equal((await h.queue.add(payload(draft))).status, 'added', sourceLanguage);
    const saved = await h.store.get(operationId), note = h.remote.get(100)!.note;
    assert.deepEqual(saved?.draft, draft, sourceLanguage);
    assert.equal(note.modelName, MULTILINGUAL_MODEL_NAMES.cloze);
    assert.equal(note.fields.SourceLanguage, sourceLanguage);
    assert.equal(note.fields.TargetLanguage, draft.targetLanguage);
    assert.equal(note.fields.Sentence, draft.context.sentence);
    assert.equal(note.fields.ClozeSentence, `🐈 {{c1::${draft.expression}}}.`);
    assert.equal(note.fields.DefinitionEN, undefined);
  }
});
