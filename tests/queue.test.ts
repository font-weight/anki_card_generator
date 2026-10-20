import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableQueue } from '../packages/services/src/queue.ts';
import type { QueueStore, QueueRecord, DurableQueueOptions } from '../packages/services/src/queue.ts';
import { AnkiClient, AnkiError } from '../packages/services/src/anki.ts';
import { ServiceError } from '../packages/services/src/errors.ts';
import type { AudioSnapshot } from '../packages/services/src/audio.ts';
import { createAudioInputCacheKey } from '../packages/services/src/audio.ts';
import type { NoteDraft, AddNotePayload } from '../packages/contracts/src/index.ts';
const id = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const audioId = '33333333-3333-4333-8333-333333333333';
const draft = (): NoteDraft => ({ sourceLanguage: 'en', targetLanguage: 'ru', mode: 'recognition', deckName: 'Английский', tags: [],
  expression: 'read', lemma: 'read', partOfSpeech: 'verb', selectedSense: { id: 'sense', translations: ['читать'], definitionEn: 'To understand written words.' },
  context: { sentence: 'I read books.', targetStart: 2, targetEnd: 6 }, pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null }, extraExample: null,
  source: { kind: 'html', title: 'Book', url: 'https://example.com/book', documentId: null, page: null, chapter: null, cfi: null } });
const audioSnapshot = (): AudioSnapshot => ({ snapshotVersion: 1, text: 'read', context: 'I read books.', pronunciation: null, cacheDiscriminator: 'fixture', dialect: 'en-US', speed: 1, voice: 'coral', model: 'gpt-4o-mini-tts', format: 'mp3' });
const payload = (): AddNotePayload => ({ operationId: id, draft: draft(), includeAudio: false });
// Deliberate deterministic mocked persistence/Anki adapters. No production in-memory fallback exists.
class MockStore implements QueueStore {
  rows = new Map<string, QueueRecord>();
  failSynced = false;
  failCreate = false;
  async create(row: QueueRecord) {
    if (this.failCreate) throw new ServiceError('STORAGE_QUOTA');
    const old = this.rows.get(row.operationId); if (old) return { created: false, record: structuredClone(old) };
    this.rows.set(row.operationId, structuredClone(row)); return { created: true, record: structuredClone(row) };
  }
  async get(key: string) { return structuredClone(this.rows.get(key) ?? null); }
  async compareAndSwap(key: string, revision: number, row: QueueRecord) {
    if (this.failSynced && row.state === 'synced') { this.failSynced = false; throw new ServiceError('STORAGE_QUOTA'); }
    if (this.rows.get(key)?.revision !== revision) return false;
    this.rows.set(key, structuredClone(row)); return true;
  }
  async list() { return structuredClone([...this.rows.values()]); }
}
function setup(extra: Partial<DurableQueueOptions> = {}) {
  const store = new MockStore(); let now = 1_000_000; let offline = false; let lost = false; let probeBroken = false;
  let mediaBroken = false; let addCount = 0; let mediaCount = 0; let nextWake: number | null = null;
  const notes = new Map<string, { noteId: number; note: any }>(); const log: string[] = [];
  const transport = new AnkiClient();
  const anki: DurableQueueOptions['anki'] = {
    async findOperation(operationId, keys, mode) {
      log.push('find'); assert.ok(await store.get(operationId), 'persist before external read');
      if (offline || probeBroken) throw new AnkiError('ANKI_UNAVAILABLE', 'Mock offline', true);
      const existing = notes.get(operationId); return existing?.noteId ?? null;
    },
    async assertReady() { log.push('ready'); if (offline) throw new AnkiError('ANKI_UNAVAILABLE', 'Mock offline', true); },
    async findDuplicates(_draft, keys) {
      log.push('duplicates'); return [...notes.values()].filter(v => v.note.fields.LexemeKey === keys!.lexemeKey)
        .map(v => ({ noteId: v.noteId, modelName: v.note.modelName, expression: v.note.fields.Expression, meaning: v.note.fields.Meaning, exactContent: v.note.fields.ContentKey === keys!.contentKey }));
    },
    async storeAudio() { mediaCount++; if (mediaBroken) throw new AnkiError('ANKI_UNAVAILABLE', 'Mock media failure', true); return 'произношение.mp3'; },
    prepareNote: transport.prepareNote.bind(transport),
    async addPreparedNote(note) {
      log.push('add'); addCount++;
      const saved = await store.get(note.fields.OperationId); assert.equal(saved?.state, 'submitting'); assert.equal(saved?.submissionUncertain, true);
      assert.equal(note.options.allowDuplicate, false); assert.equal(note.options.duplicateScope, 'collection');
      if (notes.has(note.fields.OperationId)) throw new AnkiError('OPERATION_CONFLICT', 'Mock duplicate');
      notes.set(note.fields.OperationId, { noteId: 100 + notes.size, note });
      if (lost) throw new AnkiError('NETWORK_TIMEOUT', 'Mock lost response', true, true);
      return notes.get(note.fields.OperationId)!.noteId;
    },
  };
  const options: DurableQueueOptions = { store, anki, now: () => now, scheduleWake: t => { nextWake = t; }, ...extra };
  return { store, anki, options, queue: new DurableQueue(options), notes, log,
    setNow: (t: number) => { now = t; }, setOffline: (v: boolean) => { offline = v; }, setLost: (v: boolean) => { lost = v; },
    setProbeBroken: (v: boolean) => { probeBroken = v; }, setMediaBroken: (v: boolean) => { mediaBroken = v; },
    counts: () => ({ addCount, mediaCount }), wake: () => nextWake, time: () => now };
}

test('two rapid Add calls with same operation persist once and create one actual note', async () => {
  const h = setup(); const result = await Promise.all([h.queue.add(payload()), h.queue.add(payload())]);
  assert.deepEqual(result.map(v => v.status), ['added', 'already_added']); assert.equal(h.counts().addCount, 1);
  assert.equal(h.store.rows.size, 1); assert.equal((await h.queue.list())[0]!.state, 'synced');
});
test('two distinct rapid intents are serialized; educational duplicate needs explicit add_new', async () => {
  const h = setup(); const second = { ...payload(), operationId: id2 };
  const result = await Promise.all([h.queue.add(payload()), h.queue.add(second)]);
  assert.equal(result[1].status, 'duplicate_review'); assert.equal(h.counts().addCount, 1);
  await assert.rejects(h.queue.add({ ...second, duplicateAction: 'add_new' }), { code: 'PERMISSION_DENIED' });
  assert.equal((await h.queue.add({ ...second, duplicateAction: 'add_new' }, { duplicateConfirmed: true })).status, 'already_added');
  assert.equal(h.counts().addCount, 2);
});
test('same operation with changed snapshot is OPERATION_CONFLICT; caller mutation cannot alter queued draft', async () => {
  const h = setup(); h.setOffline(true); const input = payload(); const work = h.queue.add(input); input.draft.lemma = 'mutated'; await work;
  assert.equal((await h.store.get(id))?.draft.lemma, 'read');
  await assert.rejects(h.queue.add(input), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(h.queue.add({ ...payload(), includeAudio: true }), { code: 'OPERATION_CONFLICT' });
});
test('operation persists before all external calls and storage quota blocks side effects', async () => {
  const h = setup(); h.store.failCreate = true;
  await assert.rejects(h.queue.add(payload()), { code: 'STORAGE_QUOTA' }); assert.deepEqual(h.log, []);
});
test('lost add response becomes reconciling; successful exact search prevents another add', async () => {
  const h = setup(); h.setLost(true);
  assert.equal((await h.queue.add(payload())).status, 'queued'); assert.equal((await h.store.get(id))?.state, 'reconciling');
  const record = await h.queue.retry(id); assert.equal(record.state, 'synced'); assert.equal(record.noteId, 100);
  assert.equal(h.counts().addCount, 1);
});
test('failed reconciliation never blind retries add and cancellation is refused while uncertain', async () => {
  const h = setup(); h.setLost(true); await h.queue.add(payload()); h.setProbeBroken(true);
  const record = await h.queue.retry(id); assert.equal(record.state, 'reconciling'); assert.equal(h.counts().addCount, 1);
  await assert.rejects(h.queue.cancel(id), { code: 'OPERATION_CONFLICT' });
});
test('crash after external success but before local commit recovers by finding OperationId', async () => {
  const h = setup(); h.store.failSynced = true;
  await assert.rejects(h.queue.add(payload()), { code: 'STORAGE_QUOTA' }); assert.equal((await h.store.get(id))?.state, 'submitting');
  h.setNow(h.time() + 120_001); const restarted = new DurableQueue(h.options); await restarted.recover();
  assert.equal((await h.store.get(id))?.state, 'synced'); assert.equal(h.counts().addCount, 1);
});
test('worker restart before add reconciles absent result then sends guarded immutable operation', async () => {
  const h = setup(); h.setOffline(true); await h.queue.add(payload()); const row = h.store.rows.get(id)!;
  row.state = 'submitting'; row.submissionUncertain = true; row.lease = null; h.setOffline(false);
  const restarted = new DurableQueue(h.options); await restarted.recover();
  assert.equal((await h.store.get(id))?.state, 'synced'); assert.equal(h.counts().addCount, 1); assert.equal(h.log[h.log.length - 1], 'add');
});
test('still-live prior lease schedules recovery rather than losing in-flight operations', async () => {
  const h = setup(); h.setOffline(true); await h.queue.add(payload()); const row = h.store.rows.get(id)!;
  row.state = 'submitting'; row.submissionUncertain = true; row.lease = { owner: 'old-worker', expiresAt: new Date(h.time() + 120_000).toISOString() };
  h.setOffline(false); const restarted = new DurableQueue(h.options); await restarted.recover();
  assert.equal(h.wake(), h.time() + 120_000); assert.equal(h.counts().addCount, 0);
  h.setNow(h.time() + 120_001); await restarted.processDue();
  assert.equal((await h.store.get(id))?.state, 'synced'); assert.equal(h.counts().addCount, 1);
});
test('offline automatic retry uses durable bounded 30s / 2m / 10m backoff', async () => {
  const h = setup(); h.setOffline(true); await h.queue.add(payload());
  for (const delay of [30_000, 120_000, 600_000]) {
    assert.equal(h.wake(), h.time() + delay); h.setNow(h.wake()!); await h.queue.processDue();
  }
  assert.equal(h.wake(), null); assert.equal((await h.store.get(id))?.attempts, 4);
  await h.queue.processDue(); await h.queue.add(payload()); assert.equal((await h.store.get(id))?.attempts, 4);
  h.setOffline(false); assert.equal((await h.queue.retry(id)).state, 'synced');
});
test('audio failure waits for explicit decision, save_without_audio preserves original fingerprint', async () => {
  const h = setup({ audio: { snapshot: async () => audioSnapshot(), prepare: async () => { throw new ServiceError('AUDIO_UNAVAILABLE'); }, read: async () => null } });
  const input = { ...payload(), includeAudio: true }; await h.queue.add(input);
  const before = await h.store.get(id); assert.equal(before?.state, 'awaiting_audio_decision'); assert.equal(h.counts().addCount, 0);
  const after = await h.queue.resolveAudio(id, 'save_without_audio'); assert.equal(after.state, 'synced'); assert.equal(after.fingerprint, before?.fingerprint);
  assert.equal(h.notes.get(id)?.note.fields.Audio, ''); assert.equal((await h.queue.add(input)).status, 'already_added');
});
test('storeMediaFile failure never substitutes fake sound; retry uses persisted audioId', async () => {
  let prepared = 0;
  const h = setup({ audio: { snapshot: async () => audioSnapshot(), prepare: async () => { prepared++; return { audioId }; }, read: async () => new Uint8Array([73, 68, 51]) } });
  h.setMediaBroken(true); await h.queue.add({ ...payload(), includeAudio: true });
  assert.equal((await h.store.get(id))?.state, 'awaiting_audio_decision'); assert.equal(prepared, 1); assert.equal(h.counts().addCount, 0);
  h.setMediaBroken(false); const row = await h.queue.resolveAudio(id, 'retry'); assert.equal(row.state, 'synced'); assert.equal(prepared, 1);
  assert.equal(h.notes.get(id)?.note.fields.Audio, '[sound:произношение.mp3]');
});
test('interrupted audio generation is not automatically billed again on worker restart', async () => {
  let prepared = 0;
  const h = setup({ audio: { snapshot: async () => audioSnapshot(), prepare: async () => { prepared++; return { audioId }; }, read: async () => new Uint8Array([73, 68, 51]) } });
  h.setOffline(true); await h.queue.add({ ...payload(), includeAudio: true });
  const row = h.store.rows.get(id)!; row.state = 'preparing_audio'; row.lease = null;
  h.setOffline(false); await new DurableQueue(h.options).recover();
  assert.equal((await h.store.get(id))?.state, 'awaiting_audio_decision'); assert.equal(prepared, 0);
});
test('pending cancellation is durable; synced cancellation never deletes an Anki note', async () => {
  const h = setup(); h.setOffline(true); await h.queue.add(payload()); assert.equal((await h.queue.cancel(id)).state, 'cancelled');
  await assert.rejects(h.queue.add(payload()), { code: 'OPERATION_CONFLICT' }); h.setOffline(false);
  await h.queue.add({ ...payload(), operationId: id2 }); assert.equal((await h.queue.cancel(id2)).state, 'synced'); assert.equal(h.notes.size, 1);
});
test('separate instances share atomic operation claim and cannot both send same ID', async () => {
  const h = setup(); const second = new DurableQueue(h.options);
  await Promise.all([h.queue.add(payload()), second.add(payload())]);
  assert.equal(h.counts().addCount, 1); assert.equal(h.store.rows.size, 1);
});

test('audio dialect/speed/model snapshot survives setting changes and retries', async () => {
  let speed = 1; let snapshots = 0; const prepared: AudioSnapshot[] = [];
  const h = setup({ audio: {
    snapshot: async () => { snapshots++; return { ...audioSnapshot(), speed }; },
    prepare: async (frozen) => { prepared.push(frozen); return { audioId }; },
    read: async (_id, frozen) => { assert.equal(frozen.speed, 1); return new Uint8Array([73, 68, 51]); },
  } });
  h.setOffline(true); const input = { ...payload(), includeAudio: true }; await h.queue.add(input);
  speed = 2; await h.queue.add(input); assert.equal(snapshots, 1);
  h.setOffline(false); await new DurableQueue(h.options).retry(id);
  assert.equal(prepared[0]?.speed, 1); assert.equal((await h.store.get(id))?.audioSnapshot?.speed, 1);
});
test('missing legacy audio snapshot waits for explicit retry instead of inventing settings', async () => {
  let prepared = 0;
  const h = setup({ audio: { snapshot: async () => audioSnapshot(), prepare: async () => { prepared++; return { audioId }; }, read: async () => new Uint8Array([73, 68, 51]) } });
  h.setOffline(true); await h.queue.add({ ...payload(), includeAudio: true });
  const row = h.store.rows.get(id)!; row.audioSnapshot = null; row.nextAttemptAt = new Date(h.time()).toISOString();
  h.setOffline(false); await h.queue.processDue();
  assert.equal((await h.store.get(id))?.state, 'awaiting_audio_decision'); assert.equal(prepared, 0);
  assert.equal((await h.queue.resolveAudio(id, 'retry')).state, 'synced'); assert.equal(prepared, 1);
});

test('durable audio cache key is pinned before provider/cache put and before audioId exists', async () => {
  const expected = await createAudioInputCacheKey(audioSnapshot());
  let h: ReturnType<typeof setup>;
  h = setup({ audio: {
    snapshot: async () => audioSnapshot(),
    prepare: async () => {
      const saved = await h.store.get(id); assert.equal(saved?.audioCacheKey, expected); assert.equal(saved?.audioId, null);
      return { audioId };
    }, read: async () => new Uint8Array([73, 68, 51]),
  } });
  await h.queue.add({ ...payload(), includeAudio: true });
  assert.equal((await h.store.get(id))?.audioCacheKey, expected);
});
test('explicit missing-snapshot retry persists new audio cache pin before generation', async () => {
  let first = true; let h: ReturnType<typeof setup>;
  const frozen = { ...audioSnapshot(), speed: 1.25 }; const expected = await createAudioInputCacheKey(frozen);
  h = setup({ audio: {
    snapshot: async () => { if (first) { first = false; throw new ServiceError('AUDIO_UNAVAILABLE'); } return frozen; },
    prepare: async () => { assert.equal((await h.store.get(id))?.audioCacheKey, expected); return { audioId }; },
    read: async () => new Uint8Array([73, 68, 51]),
  } });
  await h.queue.add({ ...payload(), includeAudio: true }); assert.equal((await h.store.get(id))?.audioCacheKey, null);
  assert.equal((await h.queue.resolveAudio(id, 'retry')).state, 'synced');
  assert.equal((await h.store.get(id))?.audioCacheKey, expected);
});
