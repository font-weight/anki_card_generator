import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openReaderStorage } from '../packages/storage/src/index.ts';
import type { StoredOperation } from '../packages/storage/src/index.ts';
import { createReaderServices, SecretVault } from '../packages/services/src/index.ts';
import { AnkiClient } from '../packages/services/src/anki.ts';
import type { PreparedAnkiNote } from '../packages/services/src/anki.ts';
import { DurableQueue } from '../packages/services/src/queue.ts';
import type { QueueRecord, QueueStore } from '../packages/services/src/queue.ts';
import { ALL_MODEL_NAMES, MODEL_NAMES, MULTILINGUAL_MODEL_NAMES, modelDefinition, semanticKeys } from '../packages/note-templates/src/index.ts';
import type { AddNotePayload, NoteDraft } from '../packages/contracts/src/index.ts';
import { fullMeaningsDraft, legacyDraft, multilingualDraft, operationId, secondOperationId } from './fixtures/full-meaning-drafts.ts';

// Real queue/client/service code; deliberately mocked AnkiConnect and persistence.
// No live profile, paid provider, public service or desktop is contacted.
class MockStore implements QueueStore {
  rows = new Map<string, QueueRecord>();
  async create(row: QueueRecord) {
    const old = this.rows.get(row.operationId);
    if (old) return { created: false, record: structuredClone(old) };
    this.rows.set(row.operationId, structuredClone(row)); return { created: true, record: structuredClone(row) };
  }
  async get(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  async compareAndSwap(id: string, revision: number, row: QueueRecord) {
    if (this.rows.get(id)?.revision !== revision) return false;
    this.rows.set(id, structuredClone(row)); return true;
  }
  async list() { return structuredClone([...this.rows.values()]); }
}
const payload = (draft: NoteDraft = fullMeaningsDraft(), id = operationId): AddNotePayload => ({ operationId: id, draft, includeAudio: false });

function setup(store: QueueStore = new MockStore()) {
  const remote = new Map<number, PreparedAnkiNote>(), actions: string[] = [];
  const models = new Map<string, ReturnType<typeof modelDefinition>>();
  for (const version of [1, 2] as const) for (const mode of ['recognition', 'cloze'] as const) {
    const model = modelDefinition(mode, version); models.set(model.modelName, model);
  }
  let offline = false, loseReply = false, now = 1_000_000, addCount = 0;
  const response = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
  const fetcher: typeof fetch = async (_url, init) => {
    const { action, params } = JSON.parse(String(init?.body)) as { action: string; params: Record<string, any> };
    actions.push(action);
    assert.ok((await store.list()).length > 0, 'persist before external calls');
    if (offline) throw new TypeError('Mock offline');
    switch (action) {
      case 'findNotes': {
        const query = String(params.query);
        for (const model of ALL_MODEL_NAMES) assert.ok(query.includes(`"note:${model}"`));
        const match = /"(OperationId|LexemeKey):([0-9a-f-]+)"/iu.exec(query)!;
        return response([...remote].filter(([, note]) => note.fields[match[1]!] === match[2]).map(([id]) => id));
      }
      case 'notesInfo': return response((params.notes as number[]).map(id => ({ noteId: id, modelName: remote.get(id)!.modelName,
        fields: Object.fromEntries(Object.entries(remote.get(id)!.fields).map(([name, value], order) => [name, { value, order }])) })));
      case 'version': return response(6);
      case 'deckNames': return response(['Test']);
      case 'modelFieldNames': return response(models.get(params.modelName)!.inOrderFields);
      case 'findModelsByName': return response((params.modelNames as string[]).map(name => {
        const model = models.get(name)!;
        return { name, type: model.isCloze ? 1 : 0, tmpls: [{ qfmt: model.cardTemplates[0]!.Front, afmt: model.cardTemplates[0]!.Back }] };
      }));
      case 'addNote': {
        const note = params.note as PreparedAnkiNote, saved = await store.get(note.fields.OperationId!);
        assert.equal(saved?.state, 'submitting'); assert.equal(saved?.submissionUncertain, true);
        assert.deepEqual(note.options, { allowDuplicate: false, duplicateScope: 'collection' });
        assert.ok(![...remote.values()].some(old => old.fields.OperationId === note.fields.OperationId));
        const id = 100 + remote.size; remote.set(id, structuredClone(note)); addCount++;
        if (loseReply) { loseReply = false; throw new TypeError('Mock accepted note but lost reply'); }
        return response(id);
      }
      default: throw new Error('Unexpected mocked action: ' + action);
    }
  };
  const anki = new AnkiClient({ fetch: fetcher }), options = { store, anki, now: () => now };
  return { store, remote, actions, anki, options, fetcher, queue: new DurableQueue(options),
    offline: (value: boolean) => { offline = value; }, loseReply: () => { loseReply = true; },
    advance: (delta: number) => { now += delta; }, addCount: () => addCount };
}

for (const mode of ['recognition', 'cloze'] as const) {
  test(`v3 ${mode} lost-response recovery uses unchanged v2 model and sends only once`, async () => {
    const h = setup(), draft = fullMeaningsDraft(); draft.mode = mode; h.loseReply();
    assert.equal((await h.queue.add(payload(draft))).status, 'queued');
    const before = await h.store.get(operationId);
    assert.equal(before?.state, 'reconciling'); assert.equal(h.remote.get(100)!.modelName, MULTILINGUAL_MODEL_NAMES[mode]);
    const recovered = await new DurableQueue(h.options).retry(operationId);
    assert.equal(recovered.state, 'synced'); assert.equal(recovered.noteId, 100);
    assert.deepEqual(recovered.draft, before!.draft); assert.equal(recovered.fingerprint, before!.fingerprint);
    assert.deepEqual(recovered.keys, before!.keys); assert.equal(h.addCount(), 1);
    assert.ok(h.actions.includes('modelFieldNames')); assert.ok(h.actions.includes('findModelsByName'));
    assert.ok(!h.actions.some(action => ['createModel', 'updateModelTemplates', 'updateModelStyling', 'updateNoteFields'].includes(action)));
  });
}

test('v3 reconciliation rejects wrong legacy model rather than accepting or re-adding', async () => {
  const h = setup(); h.loseReply(); await h.queue.add(payload());
  h.remote.get(100)!.modelName = MODEL_NAMES.recognition;
  const recovered = await new DurableQueue(h.options).retry(operationId);
  assert.equal(recovered.state, 'reconciling'); assert.equal(recovered.lastError?.code, 'OPERATION_CONFLICT');
  assert.equal(recovered.submissionUncertain, true); assert.equal(h.addCount(), 1);
});

test('v3 frozen all-senses outbox survives caller edits/restart and rejects changed operation snapshot', async () => {
  const h = setup(); h.offline(true);
  const request = payload(), original = structuredClone(request.draft), pending = h.queue.add(request);
  if (request.draft.draftVersion === 3) request.draft.senses[1]!.translations[0] = 'MUTATED';
  await pending;
  assert.deepEqual((await h.store.get(operationId))!.draft, original);
  await assert.rejects(h.queue.add(request), { code: 'OPERATION_CONFLICT' });
  h.offline(false); h.advance(30_001); await new DurableQueue(h.options).recover();
  assert.equal((await h.store.get(operationId))!.state, 'synced');
  assert.match(h.remote.get(100)!.fields.Meaning!, /понимать/u); assert.ok(!h.remote.get(100)!.fields.Meaning!.includes('MUTATED'));
  assert.equal(h.addCount(), 1);
});

for (const oldDraft of [legacyDraft, multilingualDraft]) {
  test(`v3 detects v${oldDraft().draftVersion ?? 1} lexical duplicates and never rewrites prior fields`, async () => {
    const h = setup(), old = oldDraft(); await h.queue.add(payload(old));
    const before = structuredClone(h.remote.get(100));
    const next = payload(fullMeaningsDraft(), secondOperationId);
    assert.equal((await semanticKeys(old)).lexemeKey, (await semanticKeys(next.draft)).lexemeKey);
    assert.notEqual((await semanticKeys(old)).contentKey, (await semanticKeys(next.draft)).contentKey);
    assert.equal((await h.queue.add(next)).status, 'duplicate_review'); assert.equal(h.addCount(), 1);
    await assert.rejects(h.queue.add({ ...next, duplicateAction: 'add_new' }), { code: 'PERMISSION_DENIED' });
    await h.queue.add({ ...next, duplicateAction: 'add_new' }, { duplicateConfirmed: true });
    assert.equal(h.addCount(), 2); assert.deepEqual(h.remote.get(100), before);
    assert.equal(h.remote.get(101)!.modelName, MULTILINGUAL_MODEL_NAMES.recognition);
    assert.equal((await h.anki.findDuplicates(old)).length, 2);
  });
}

test('v3 actual service bridge and IndexedDB restart reconcile the installed v2 model', async () => {
  const factory = new IDBFactory(); let storage = await openReaderStorage({ indexedDB: factory });
  const store: QueueStore = {
    create: row => storage.createOperation(row as unknown as StoredOperation) as unknown as Promise<{ created: boolean; record: QueueRecord }>,
    get: id => storage.getOperation(id) as unknown as Promise<QueueRecord | null>,
    compareAndSwap: (id, revision, row) => storage.compareAndSwap(id, revision, row as unknown as StoredOperation),
    list: () => storage.allOperations() as unknown as Promise<QueueRecord[]>,
  };
  const h = setup(store), area = () => {
    const values: Record<string, unknown> = {};
    return { get: async (keys: string | string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, values[key]])),
      set: async (data: Record<string, unknown>) => { Object.assign(values, data); },
      remove: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key]; }, setAccessLevel: async () => {} };
  };
  const secrets = new SecretVault({ session: area(), local: area() }), extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const sender = { id: extensionId, url: `chrome-extension://${extensionId}/queue.html`, frameId: 0 };
  let now = 1_000_000;
  const createApp = () => createReaderServices({ storage, secrets, fetch: h.fetcher, now: () => now,
    runtime: { extensionId, allowedPageUrls: [sender.url], isRegisteredReader: () => false } });
  let app = createApp();
  try {
    h.loseReply();
    const result = await app.handleMessage({ v: 1, requestId: secondOperationId, type: 'anki.addNote', payload: payload() }, sender);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.data, { operationId, status: 'queued', noteId: null });
    const before = await store.get(operationId); assert.equal(before?.state, 'reconciling');
    app.close(); storage = await openReaderStorage({ indexedDB: factory }); now += 30_001; app = createApp();
    await app.resumeQueue();
    const after = await store.get(operationId);
    assert.equal(after?.state, 'synced'); assert.equal(after?.noteId, 100); assert.equal(after?.lastError, null);
    assert.deepEqual(after?.draft, before!.draft); assert.equal(after?.fingerprint, before!.fingerprint);
    assert.equal(h.addCount(), 1); assert.equal(h.remote.get(100)!.modelName, MULTILINGUAL_MODEL_NAMES.recognition);
  } finally { app.close(); }
});
