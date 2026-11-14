import type { AddNotePayload, AddNoteData, NoteDraft, QueueItem, SafeError, OperationState } from '../../contracts/src/index.ts';
import { canonicalJson, semanticKeys, sha256, draftVersion } from '../../note-templates/src/index.ts';
import type { SemanticKeys } from '../../note-templates/src/index.ts';
import { AnkiClient, AnkiError } from './anki.ts';
import { ServiceError, safeError } from './errors.ts';
import type { AudioSnapshot } from './audio.ts';
import { createAudioInputCacheKey, validateAudioSnapshot } from './audio.ts';

export type QueueTargetIdentity = 'anki:loopback:8765' | 'anki:isolated-test:18765';
const PRODUCTION_TARGET: QueueTargetIdentity = 'anki:loopback:8765';

export interface QueueRecord extends QueueItem {
  targetIdentity: QueueTargetIdentity;
  revision: number;
  fingerprint: string;
  keys: SemanticKeys;
  mediaFilename: string | null;
  audioSnapshot: AudioSnapshot | null;
  audioCacheKey: string | null;
  lease: { owner: string; expiresAt: string } | null;
  automaticRetries: number;
  submissionUncertain: boolean;
}
/** Every write is a committed IndexedDB transaction, not an in-memory fallback. */
export interface QueueStore {
  create(record: QueueRecord): Promise<{ created: boolean; record: QueueRecord }>;
  get(operationId: string): Promise<QueueRecord | null>;
  compareAndSwap(operationId: string, expectedRevision: number, next: QueueRecord): Promise<boolean>;
  list(): Promise<QueueRecord[]>;
}
export interface QueueAudio {
  /** Local-only snapshot: no provider request. Must preserve exact context, speed, dialect and voice/model. */
  snapshot(draft: NoteDraft, audioId?: string): Promise<AudioSnapshot>;
  /** Uses the confirmed snapshot, never new settings, a translation or model lookup. */
  prepare(snapshot: AudioSnapshot): Promise<{ audioId: string }>;
  /** Must verify that cached audio matches the complete persisted snapshot identity. */
  read(audioId: string, snapshot: AudioSnapshot): Promise<Uint8Array | null>;
}
export interface DurableQueueOptions {
  store: QueueStore;
  anki: Pick<AnkiClient, 'assertReady' | 'findOperation' | 'findDuplicates' | 'storeAudio' | 'prepareNote' | 'addPreparedNote'>;
  audio?: QueueAudio;
  now?: () => number;
  onUpdated?: (record: QueueRecord) => void | Promise<void>;
  scheduleWake?: (timestamp: number | null) => void | Promise<void>;
  ownerId?: string;
  targetIdentity?: QueueTargetIdentity;
}
class QueueCasConflict extends ServiceError { constructor() { super('OPERATION_CONFLICT'); } }
class QueueWakeError extends ServiceError { constructor() { super('INTERNAL_ERROR', 'Не удалось запланировать восстановление очереди.', true); } }
const BACKOFF = [30_000, 120_000, 600_000] as const;
const LEASE_MS = 120_000;
const ACTIVE = new Set<OperationState>(['pending', 'ready', 'reconciling']);
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const copy = <T>(value: T): T => structuredClone(value);

/** One instance belongs in the extension service worker, not each UI page. */
export class DurableQueue {
  private store: QueueStore;
  private anki: DurableQueueOptions['anki'];
  private audio?: QueueAudio;
  private now: () => number;
  private onUpdated?: DurableQueueOptions['onUpdated'];
  private scheduleWake?: DurableQueueOptions['scheduleWake'];
  private owner: string;
  private targetIdentity: QueueTargetIdentity;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(options: DurableQueueOptions) {
    this.store = options.store; this.anki = options.anki; this.audio = options.audio;
    this.now = options.now ?? Date.now; this.onUpdated = options.onUpdated;
    this.scheduleWake = options.scheduleWake; this.owner = options.ownerId ?? crypto.randomUUID();
    this.targetIdentity = options.targetIdentity ?? PRODUCTION_TARGET;
    if (!['anki:loopback:8765', 'anki:isolated-test:18765'].includes(this.targetIdentity)) throw new ServiceError('INVALID_INPUT');
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private assertTarget(record: QueueRecord): void {
    // An absent target is unverified, not production. Preserve it for explicit review; never infer or retarget.
    if (record.targetIdentity === undefined) throw new ServiceError('OPERATION_CONFLICT', 'Цель старой операции не подтверждена. Проверьте её и создайте новое намерение.');
    if (record.targetIdentity !== this.targetIdentity) throw new ServiceError('OPERATION_CONFLICT', 'Операция принадлежит другому профилю Anki.');
  }
  private async requireRecord(operationId: string): Promise<QueueRecord> {
    if (!uuid(operationId)) throw new ServiceError('INVALID_INPUT');
    const record = await this.store.get(operationId);
    if (!record) throw new ServiceError('INVALID_INPUT', 'Операция не найдена.');
    this.assertTarget(record);
    return record;
  }
  private async save(record: QueueRecord, patch: Partial<QueueRecord>): Promise<QueueRecord> {
    this.assertTarget(record);
    if (patch.targetIdentity !== undefined && patch.targetIdentity !== record.targetIdentity) throw new ServiceError('OPERATION_CONFLICT');
    const next = { ...record, ...patch, revision: record.revision + 1, updatedAt: new Date(this.now()).toISOString() };
    if (!await this.store.compareAndSwap(record.operationId, record.revision, next)) throw new QueueCasConflict();
    try { void Promise.resolve(this.onUpdated?.(copy(next))).catch(() => undefined); } catch { /* A UI hint cannot block durable progress. */ }
    return next;
  }
  private leaseLive(record: QueueRecord): boolean {
    return record.lease !== null && Date.parse(record.lease.expiresAt) > this.now();
  }
  private async claim(record: QueueRecord): Promise<QueueRecord | null> {
    this.assertTarget(record);
    if (this.leaseLive(record) && record.lease!.owner !== this.owner) return null;
    try { return await this.save(record, { lease: { owner: this.owner, expiresAt: new Date(this.now() + LEASE_MS).toISOString() } }); }
    catch (error) { if (error instanceof ServiceError && error.code === 'OPERATION_CONFLICT') return null; throw error; }
  }
  private async schedule(): Promise<void> {
    if (!this.scheduleWake) return;
    const times = (await this.store.list()).filter((row) => (ACTIVE.has(row.state) && row.nextAttemptAt !== null) || ['submitting', 'preparing_audio'].includes(row.state))
      .map((row) => ['submitting', 'preparing_audio'].includes(row.state)
        ? Math.max(this.now(), row.lease ? Date.parse(row.lease!.expiresAt) : this.now())
        : Math.max(Date.parse(row.nextAttemptAt!), this.leaseLive(row) ? Date.parse(row.lease!.expiresAt) : 0));
    try { await this.scheduleWake(times.length ? Math.min(...times) : null); }
    catch { throw new QueueWakeError(); }
  }
  async list(): Promise<QueueRecord[]> { return (await this.store.list()).map(copy); }

  async add(payload: AddNotePayload, options: { duplicateConfirmed?: boolean } = {}): Promise<AddNoteData> {
    // Freeze before entering the async queue so a caller cannot mutate a waiting intent.
    const input = copy(payload);
    if (!uuid(input.operationId)) throw new ServiceError('INVALID_INPUT');
    if ((input.duplicateAction ?? 'review') === 'add_new' && options.duplicateConfirmed !== true) throw new ServiceError('PERMISSION_DENIED');
    return this.serial(async () => {
      const intent = { draft: input.draft, includeAudio: input.includeAudio, audioId: input.audioId ?? null };
      const fingerprint = await sha256(canonicalJson({ ...intent, targetIdentity: this.targetIdentity }));
      const known = await this.store.get(input.operationId);
      if (known) this.assertTarget(known);
      if (known && known.fingerprint !== fingerprint) throw new ServiceError('OPERATION_CONFLICT');
      const keys = await semanticKeys(input.draft);
      // Pure local construction, only after target validation; never an Anki RPC.
      this.anki.prepareNote(input.operationId, input.draft, keys);
      let audioSnapshot: AudioSnapshot | null = null;
      let audioCacheKey: string | null = null;
      let snapshotError: SafeError | null = null;
      if (!known && input.includeAudio) {
        try {
          if (!this.audio) throw new ServiceError('AUDIO_UNAVAILABLE');
          audioSnapshot = validateAudioSnapshot(await this.audio.snapshot(copy(input.draft), input.audioId));
          audioCacheKey = await createAudioInputCacheKey(audioSnapshot);
        } catch (error) { snapshotError = error instanceof ServiceError ? safeError(error) : new ServiceError('AUDIO_UNAVAILABLE').toJSON(); }
      }
      const timestamp = new Date(this.now()).toISOString();
      const proposed: QueueRecord = {
        operationId: input.operationId, targetIdentity: this.targetIdentity, draft: input.draft, includeAudio: input.includeAudio,
        audioId: input.audioId ?? null, duplicateAction: input.duplicateAction ?? 'review',
        state: snapshotError ? 'awaiting_audio_decision' : 'pending', attempts: 0, lastError: snapshotError, noteId: null, createdAt: timestamp,
        updatedAt: timestamp, nextAttemptAt: snapshotError ? null : timestamp, revision: 0, fingerprint, keys,
        mediaFilename: null, audioSnapshot, audioCacheKey, lease: null, automaticRetries: 0, submissionUncertain: false,
      };
      // Atomic create completes before ANY Anki/TTS/network request.
      const inserted = await this.store.create(proposed);
      let record = inserted.record;
      this.assertTarget(record);
      if (record.fingerprint !== fingerprint) throw new ServiceError('OPERATION_CONFLICT', 'Этот идентификатор уже использован с другим черновиком.');
      if (record.state === 'synced') return { operationId: record.operationId, status: 'already_added', noteId: record.noteId };
      if (record.state === 'cancelled') throw new ServiceError('OPERATION_CONFLICT', 'Отменённая операция не может быть отправлена повторно.');
      if (record.state === 'awaiting_duplicate_decision' && input.duplicateAction === 'add_new' && options.duplicateConfirmed === true) {
        record = await this.save(record, { duplicateAction: 'add_new', state: 'ready', nextAttemptAt: timestamp, lastError: null });
      }
      if (ACTIVE.has(record.state) && record.nextAttemptAt !== null && Date.parse(record.nextAttemptAt) <= this.now()) record = await this.process(record);
      await this.schedule();
      return { operationId: record.operationId, status: record.state === 'synced' ? (inserted.created ? 'added' : 'already_added')
        : record.state === 'awaiting_duplicate_decision' ? 'duplicate_review' : 'queued', noteId: record.noteId };
    });
  }

  private async retryFailure(record: QueueRecord, error: unknown): Promise<QueueRecord> {
    const safe = safeError(error);
    const uncertain = record.submissionUncertain || record.state === 'submitting' || (error instanceof AnkiError && error.uncertain);
    const nextState: OperationState = uncertain ? 'reconciling' : safe.retryable ? 'pending' : 'failed';
    const delay = (safe.retryable || uncertain) ? BACKOFF[record.automaticRetries] : undefined;
    const updated = await this.save(record, {
      state: nextState, lastError: safe, lease: null, submissionUncertain: uncertain,
      automaticRetries: record.automaticRetries + (delay === undefined ? 0 : 1),
      nextAttemptAt: delay === undefined ? null : new Date(this.now() + delay).toISOString(),
    });
    await this.schedule();
    return updated;
  }
  private async audioDecision(record: QueueRecord, error: unknown): Promise<QueueRecord> {
    const safe: SafeError = error instanceof ServiceError ? safeError(error) : new ServiceError('AUDIO_UNAVAILABLE').toJSON();
    const updated = await this.save(record, { state: 'awaiting_audio_decision', lastError: safe, nextAttemptAt: null, lease: null });
    await this.schedule();
    return updated;
  }
  private async process(initial: QueueRecord): Promise<QueueRecord> {
    let record = await this.claim(initial);
    if (!record) return await this.requireRecord(initial.operationId);
    try {
      record = await this.save(record, { attempts: record.attempts + 1 });
      // A persisted lease must already have a host alarm before any external work can stall or terminate the worker.
      await this.schedule();
      // Mandatory reconciliation on every send, including after worker death and before technical retries.
      const existing = await this.anki.findOperation(record.operationId, record.keys, record.draft.mode, draftVersion(record.draft));
      if (existing !== null) return await this.save(record, {
        state: 'synced', noteId: existing, nextAttemptAt: null, lastError: null, lease: null, submissionUncertain: false,
      });
      // The negative result is a completed findNotes + exact notesInfo inspection, never a timeout.
      // Same immutable OperationId and allowDuplicate=false remain the final race guard in Anki.
      if (record.state === 'reconciling') record = await this.save(record, { state: 'ready', submissionUncertain: false });
      await this.anki.assertReady(record.draft);
      if (record.duplicateAction === 'review') {
        const matches = await this.anki.findDuplicates(record.draft, record.keys);
        if (matches.length) return await this.save(record, { state: 'awaiting_duplicate_decision', nextAttemptAt: null, lastError: null, lease: null });
      }
      if (record.includeAudio && (!record.mediaFilename || !record.audioSnapshot)) {
        try {
          if (!this.audio || !record.audioSnapshot) throw new ServiceError('AUDIO_UNAVAILABLE');
          const snapshot = validateAudioSnapshot(record.audioSnapshot);
          const audioCacheKey = await createAudioInputCacheKey(snapshot);
          if (record.audioCacheKey && record.audioCacheKey !== audioCacheKey) throw new ServiceError('AUDIO_UNAVAILABLE');
          // Pin by deterministic key before TTS inserts bytes, closing the put-before-audioId eviction window.
          record = await this.save(record, { state: 'preparing_audio', audioCacheKey,
            lease: { owner: this.owner, expiresAt: new Date(this.now() + LEASE_MS).toISOString() } });
          await this.schedule();
          if (!record.audioId) {
            const audio = await this.audio.prepare(snapshot);
            if (!uuid(audio.audioId)) throw new ServiceError('AUDIO_UNAVAILABLE');
            // Persist media reference before reading it; storage LRU protects outbox dependencies.
            record = await this.save(record, { audioId: audio.audioId });
          }
          const bytes = await this.audio.read(record.audioId!, snapshot);
          if (!bytes) {
            record = await this.save(record, { audioId: null });
            throw new ServiceError('AUDIO_UNAVAILABLE');
          }
          record = await this.save(record, { lease: { owner: this.owner, expiresAt: new Date(this.now() + LEASE_MS).toISOString() } });
          await this.schedule();
          const mediaFilename = await this.anki.storeAudio(record.operationId, bytes);
          record = await this.save(record, { mediaFilename, state: 'ready' });
        } catch (error) {
          if (error instanceof QueueWakeError || (error instanceof ServiceError && ['STORAGE_QUOTA', 'STORAGE_UNAVAILABLE', 'OPERATION_CONFLICT'].includes(error.code))) throw error;
          return await this.audioDecision(record, error);
        }
      }
      record = await this.save(record, { state: 'ready', lastError: null });
      const note = this.anki.prepareNote(record.operationId, record.draft, record.keys, record.includeAudio ? record.mediaFilename : null);
      // Commit the uncertainty marker before crossing the external mutation boundary.
      record = await this.save(record, { state: 'submitting', submissionUncertain: true,
        lease: { owner: this.owner, expiresAt: new Date(this.now() + LEASE_MS).toISOString() } });
      await this.schedule();
      let noteId: number;
      try { noteId = await this.anki.addPreparedNote(note); }
      catch (error) {
        // A definite server error still gets a reconciliation pass for duplicate rejection.
        if (error instanceof AnkiError && !error.uncertain && error.code !== 'OPERATION_CONFLICT') {
          record = await this.save(record, { state: 'ready', submissionUncertain: false });
        }
        return await this.retryFailure(record, error);
      }
      // If this storage commit fails, the persisted state remains submitting. Recovery searches, not blindly adds.
      return await this.save(record, { state: 'synced', noteId, lastError: null, nextAttemptAt: null, lease: null, submissionUncertain: false });
    } catch (error) {
      if (error instanceof QueueWakeError) {
        // All in-process schedule calls precede the next external side effect. A new submitting marker here
        // is known not to have been dispatched; older reconciling uncertainty must remain intact.
        const durable = await this.requireRecord(record.operationId);
        if (['pending', 'ready', 'preparing_audio', 'submitting', 'reconciling'].includes(durable.state)) {
          const uncertain = durable.state !== 'submitting' && durable.submissionUncertain;
          await this.save(durable, { state: uncertain ? 'reconciling' : 'pending', submissionUncertain: uncertain,
            lease: null, nextAttemptAt: durable.nextAttemptAt ?? new Date(this.now()).toISOString(), lastError: error.toJSON() });
        }
        throw error;
      }
      // A CAS/storage failure must not be converted into success. The already-armed watchdog survives it.
      if (error instanceof QueueCasConflict || (error instanceof ServiceError && ['STORAGE_QUOTA', 'STORAGE_UNAVAILABLE'].includes(error.code))) throw error;
      return await this.retryFailure(record, error);
    }
  }

  async retry(operationId: string): Promise<QueueRecord> {
    return this.serial(async () => {
      let record = await this.requireRecord(operationId);
      if (['synced', 'cancelled'].includes(record.state)) return record;
      if (['awaiting_audio_decision', 'awaiting_duplicate_decision'].includes(record.state)) throw new ServiceError('OPERATION_CONFLICT', 'Сначала выберите решение для аудио или дубликата.');
      if (this.leaseLive(record) && record.lease?.owner !== this.owner) throw new ServiceError('OPERATION_CONFLICT');
      record = await this.save(record, { state: record.submissionUncertain || ['submitting', 'reconciling'].includes(record.state) ? 'reconciling' : 'pending',
        nextAttemptAt: new Date(this.now()).toISOString(), automaticRetries: 0, lease: null });
      record = await this.process(record);
      await this.schedule();
      return record;
    });
  }
  async cancel(operationId: string): Promise<QueueRecord> {
    return this.serial(async () => {
      let record = await this.requireRecord(operationId);
      if (record.state === 'synced' || record.state === 'cancelled') return record;
      if (record.submissionUncertain || ['submitting', 'reconciling'].includes(record.state) || this.leaseLive(record)) {
        throw new ServiceError('OPERATION_CONFLICT', 'Исход отправки ещё неизвестен. Сначала нужна сверка с Anki.');
      }
      record = await this.save(record, { state: 'cancelled', nextAttemptAt: null, lease: null, lastError: null });
      await this.schedule(); return record;
    });
  }
  async resolveAudio(operationId: string, action: 'retry' | 'save_without_audio' | 'cancel'): Promise<QueueRecord> {
    return this.serial(async () => {
      let record = await this.requireRecord(operationId);
      if (record.state !== 'awaiting_audio_decision') throw new ServiceError('OPERATION_CONFLICT');
      if (!['retry', 'save_without_audio', 'cancel'].includes(action)) throw new ServiceError('INVALID_INPUT');
      if (action === 'retry' && !record.audioSnapshot) {
        try {
          if (!this.audio) throw new ServiceError('AUDIO_UNAVAILABLE');
          const snapshot = validateAudioSnapshot(await this.audio.snapshot(copy(record.draft)));
          const audioCacheKey = await createAudioInputCacheKey(snapshot);
          record = await this.save(record, { audioSnapshot: snapshot, audioCacheKey, audioId: null, mediaFilename: null });
        } catch (error) {
          record = await this.audioDecision(record, error);
          await this.schedule(); return record;
        }
      }
      record = await this.save(record, { state: action === 'cancel' ? 'cancelled' : 'pending',
        includeAudio: action === 'save_without_audio' ? false : record.includeAudio,
        nextAttemptAt: action === 'cancel' ? null : new Date(this.now()).toISOString(),
        lastError: null, automaticRetries: 0, lease: null });
      if (action !== 'cancel') record = await this.process(record);
      await this.schedule(); return record;
    });
  }
  /** Called on SW startup / restart. No paid audio generation is silently repeated after a crash. */
  async recover(): Promise<void> {
    await this.serial(async () => {
      const records = await this.store.list();
      for (const record of records) this.assertTarget(record);
      for (let record of records) {
        if (this.leaseLive(record) && record.lease?.owner !== this.owner) continue;
        if (record.state === 'submitting') record = await this.save(record, { state: 'reconciling', submissionUncertain: true, lease: null, nextAttemptAt: new Date(this.now()).toISOString() });
        else if (record.state === 'preparing_audio') record = await this.save(record, { state: 'awaiting_audio_decision', lease: null,
          nextAttemptAt: null, lastError: new ServiceError('AUDIO_UNAVAILABLE', 'Подготовка аудио была прервана.').toJSON() });
        else if (record.lease) await this.save(record, { lease: null });
      }
      await this.processDueUnlocked();
    });
  }
  async processDue(): Promise<void> { await this.serial(() => this.processDueUnlocked()); }
  private async processDueUnlocked(): Promise<void> {
    const rows = (await this.store.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
    for (const record of rows) this.assertTarget(record);
    for (let record of rows) {
      if (!this.leaseLive(record)) {
        if (record.state === 'submitting') record = await this.save(record, { state: 'reconciling', submissionUncertain: true, lease: null, nextAttemptAt: new Date(this.now()).toISOString() });
        else if (record.state === 'preparing_audio') record = await this.save(record, { state: 'awaiting_audio_decision', lease: null, nextAttemptAt: null, lastError: new ServiceError('AUDIO_UNAVAILABLE').toJSON() });
      }
      if (ACTIVE.has(record.state) && record.nextAttemptAt !== null && Date.parse(record.nextAttemptAt) <= this.now()) await this.process(record);
    }
    await this.schedule();
  }
}
