import type { NoteDraft, ErrorCode, DuplicateMatch } from '../../contracts/src/index.ts';
import { ServiceError } from './errors.ts';
import {
  MODEL_NAMES, NOTE_FIELDS, buildNoteFields, modelDefinition, semanticKeys, validMediaFilename,
  modelNamesFor, noteFieldsFor, draftVersion, ALL_MODEL_NAMES,
} from '../../note-templates/src/index.ts';
import type { NoteFields, SemanticKeys } from '../../note-templates/src/index.ts';

export class AnkiError extends ServiceError {
  uncertain: boolean;
  constructor(code: ErrorCode, message: string, retryable = false, uncertain = false) {
    super(code, message, retryable); this.name = 'AnkiError'; this.uncertain = uncertain;
  }
}
export interface AnkiClientOptions {
  endpoint?: string;
  isolatedTestMode?: true;
  getApiKey?: () => Promise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface AnkiNoteInfo { noteId: number; modelName: string; fields: Record<string, { value: string; order: number }> }
export type { DuplicateMatch };
export interface PreparedAnkiNote {
  deckName: string;
  modelName: string;
  fields: NoteFields;
  tags: string[];
  options: { allowDuplicate: false; duplicateScope: 'collection' };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const schemaError = () => new AnkiError('ANKI_SCHEMA_MISMATCH', 'Ответ AnkiConnect или тип заметки несовместим. Обновите AnkiConnect и проверьте типы EnglishReader.');

export function validateAnkiEndpoint(endpoint?: string, isolatedTestMode = false): string {
  if (isolatedTestMode === true) {
    if (endpoint !== undefined && endpoint !== 'http://127.0.0.1:18765') {
      throw new AnkiError('INVALID_INPUT', 'Изолированный тест разрешён только на http://127.0.0.1:18765.');
    }
    return 'http://127.0.0.1:18765/';
  }
  const actual = endpoint ?? 'http://127.0.0.1:8765';
  if (!['http://127.0.0.1:8765', 'http://localhost:8765'].includes(actual)) {
    throw new AnkiError('INVALID_INPUT', 'Разрешён только локальный AnkiConnect на порту 8765.');
  }
  // localhost is an accepted production UI value, but transport always uses literal loopback.
  return actual === 'http://localhost:8765' ? 'http://127.0.0.1:8765/' : actual + '/';
}

function apiError(raw: string): AnkiError {
  // Never echo remote errors: they may contain a secret, content, or private path.
  if (/origin|cors|permission denied/iu.test(raw)) return new AnkiError('ANKI_ORIGIN_DENIED', 'AnkiConnect не разрешает origin этого расширения.');
  if (/key|auth|unauthori/iu.test(raw)) return new AnkiError('ANKI_AUTH', 'Проверьте отдельный ключ AnkiConnect.');
  if (/duplicate/iu.test(raw)) return new AnkiError('OPERATION_CONFLICT', 'В Anki уже может существовать заметка этой операции. Нужна сверка.');
  if (/deck.*(?:not found|does not exist|was not found)|(?:missing|unknown|invalid).*deck/iu.test(raw)) {
    return new AnkiError('ANKI_DECK_NOT_FOUND', 'Выбранная колода отсутствует в Anki.');
  }
  if (/model|field|template|unsupported action|unsupported version/iu.test(raw)) return schemaError();
  return new AnkiError('ANKI_UNAVAILABLE', 'AnkiConnect отклонил запрос. Проверьте открытый профиль Anki.', false);
}

export class AnkiClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  private fetcher: typeof globalThis.fetch;
  private getApiKey: () => Promise<string | null | undefined>;
  constructor(options: AnkiClientOptions = {}) {
    this.endpoint = validateAnkiEndpoint(options.endpoint, options.isolatedTestMode);
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new AnkiError('INVALID_INPUT', 'Некорректный таймаут AnkiConnect.');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.getApiKey = options.getApiKey ?? (async () => null);
  }

  private async invoke(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const controller = new AbortController();
    let mutationDispatched = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => undefined);
        reject(new AnkiError('NETWORK_TIMEOUT', 'AnkiConnect не ответил вовремя.', true, mutationDispatched));
      }, this.timeoutMs);
    });
    const work = async (): Promise<unknown> => {
      const key = await this.getApiKey();
      controller.signal.throwIfAborted();
      mutationDispatched = action === 'addNote';
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params, ...(key ? { key } : {}) }),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (response.status === 401) throw new AnkiError('ANKI_AUTH', 'Проверьте отдельный ключ AnkiConnect.');
      if (response.status === 403) throw new AnkiError('ANKI_ORIGIN_DENIED', 'AnkiConnect не разрешает origin этого расширения.');
      if (!response.ok || response.redirected) throw new AnkiError('ANKI_UNAVAILABLE', 'AnkiConnect вернул сетевую ошибку.', true, mutationDispatched);
      const limit = 2 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit || !response.body) throw new AnkiError('ANKI_SCHEMA_MISMATCH', 'Некорректный размер ответа AnkiConnect.', false, mutationDispatched);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '', size = 0;
      while (true) {
        controller.signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) { await reader.cancel(); throw new AnkiError('ANKI_SCHEMA_MISMATCH', 'Ответ AnkiConnect слишком велик.', false, mutationDispatched); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new AnkiError('ANKI_SCHEMA_MISMATCH', 'AnkiConnect вернул неверный JSON.', false, mutationDispatched); }
      if (!object(body) || !Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) {
        throw new AnkiError('ANKI_SCHEMA_MISMATCH', 'Неверная структура ответа AnkiConnect.', false, mutationDispatched);
      }
      if (body.error !== null) {
        if (typeof body.error !== 'string') throw new AnkiError('ANKI_SCHEMA_MISMATCH', 'Неверная структура ошибки AnkiConnect.', false, mutationDispatched);
        throw apiError(body.error);
      }
      return body.result;
    };
    try { return await Promise.race([work(), timedOut]); }
    catch (error) {
      if (error instanceof AnkiError) throw error;
      if (controller.signal.aborted) throw new AnkiError('NETWORK_TIMEOUT', 'AnkiConnect не ответил вовремя.', true, mutationDispatched);
      // Browser network errors cannot reliably distinguish closed Anki, a missing add-on, or CORS denial.
      throw new AnkiError('ANKI_UNAVAILABLE', 'Не удалось подключиться к AnkiConnect. Проверьте Anki, дополнение и разрешение origin.', true, mutationDispatched);
    } finally {
      if (timer) clearTimeout(timer);
      if (reader) { try { reader.releaseLock(); } catch { /* Pending reads are cancelled by the deadline. */ } }
    }
  }

  async version(): Promise<number> {
    const version = await this.invoke('version');
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 6) throw schemaError();
    return version;
  }
  async deckNames(): Promise<string[]> {
    const names = await this.invoke('deckNames');
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && name.length <= 512)) throw schemaError();
    return names;
  }
  async createDeck(deckName: string): Promise<{ deckName: string; deckId: number }> {
    if (typeof deckName !== 'string' || !deckName.trim() || deckName.length > 200 || /[\x00-\x1f\x7f]/u.test(deckName)) throw new AnkiError('INVALID_INPUT', 'Некорректное имя колоды.');
    const deckId = await this.invoke('createDeck', { deck: deckName });
    if (!isId(deckId)) throw schemaError();
    return { deckName, deckId };
  }
  async modelNames(): Promise<string[]> {
    const names = await this.invoke('modelNames');
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) throw schemaError();
    return names;
  }
  async assertModel(mode: NoteDraft['mode'], version: 1 | 2 = 1): Promise<void> {
    const modelName = modelNamesFor(version)[mode];
    const fields = await this.invoke('modelFieldNames', { modelName });
    if (!Array.isArray(fields) || fields.length !== noteFieldsFor(version).length || fields.some((field, index) => field !== noteFieldsFor(version)[index])) throw schemaError();
    // Inspect type and templates, not just names. A Basic model named Cloze is not a cloze model.
    const models = await this.invoke('findModelsByName', { modelNames: [modelName] });
    const expected = modelDefinition(mode, version);
    if (!Array.isArray(models) || models.length !== 1 || !object(models[0])) throw schemaError();
    const model = models[0];
    if (model.name !== modelName || model.type !== (mode === 'cloze' ? 1 : 0) || !Array.isArray(model.tmpls) || model.tmpls.length !== 1) throw schemaError();
    const template = model.tmpls[0];
    if (!object(template) || template.qfmt !== expected.cardTemplates[0]!.Front || template.afmt !== expected.cardTemplates[0]!.Back) throw schemaError();
  }
  async initializeModels(consent: boolean, version: 1 | 2 = 1): Promise<{ created: string[]; existing: string[] }> {
    if (consent !== true) throw new AnkiError('PERMISSION_DENIED', 'Для создания типов заметок нужно согласие в настройках.');
    await this.version();
    const names = await this.modelNames();
    // Validate every existing model before creating anything; never overwrite user models.
    for (const mode of ['recognition', 'cloze'] as const) if (names.includes(modelNamesFor(version)[mode])) await this.assertModel(mode, version);
    const created: string[] = [];
    const existing: string[] = [];
    for (const mode of ['recognition', 'cloze'] as const) {
      const name = modelNamesFor(version)[mode];
      if (names.includes(name)) { existing.push(name); continue; }
      await this.invoke('createModel', modelDefinition(mode, version));
      await this.assertModel(mode, version);
      created.push(name);
    }
    return { created, existing };
  }
  async assertReady(draft: NoteDraft): Promise<void> {
    await this.version();
    if (!(await this.deckNames()).includes(draft.deckName)) throw new AnkiError('ANKI_DECK_NOT_FOUND', 'Выбранная колода отсутствует в Anki.');
    await this.assertModel(draft.mode, draftVersion(draft));
  }

  private async findByField(field: 'OperationId' | 'LexemeKey', value: string): Promise<AnkiNoteInfo[]> {
    // Only service-generated hashes / validated UUIDs are interpolated, never arbitrary queries.
    if (!/^[0-9a-f-]+$/iu.test(value) || value.length > 64) throw new AnkiError('INVALID_INPUT', 'Некорректный ключ поиска заметки.');
    const query = `(${ALL_MODEL_NAMES.map(name=>`"note:${name}"`).join(" or ")}) "${field}:${value}"`;
    const ids = await this.invoke('findNotes', { query });
    if (!Array.isArray(ids) || !ids.every(isId) || ids.length > 10_000) throw schemaError();
    if (!ids.length) return [];
    const notes: AnkiNoteInfo[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const result = await this.invoke('notesInfo', { notes: batch });
      if (!Array.isArray(result) || result.length !== batch.length) throw schemaError();
      for (const note of result) {
        if (!object(note) || !isId(note.noteId) || !batch.includes(note.noteId) || typeof note.modelName !== 'string' || !object(note.fields)) throw schemaError();
        const validFields: AnkiNoteInfo['fields'] = {};
        for (const [name, data] of Object.entries(note.fields)) {
          if (!object(data) || typeof data.value !== 'string' || typeof data.order !== 'number') throw schemaError();
          validFields[name] = { value: data.value, order: data.order };
        }
        // Anki text search is not an equality constraint. Verify exact raw service keys.
        if (ALL_MODEL_NAMES.includes(note.modelName) && validFields[field]?.value === value) {
          notes.push({ noteId: note.noteId, modelName: note.modelName, fields: validFields });
        }
      }
    }
    return notes;
  }
  async findOperation(operationId: string, keys: SemanticKeys, mode: NoteDraft['mode'], version: 1 | 2 = 1): Promise<number | null> {
    const matches = await this.findByField('OperationId', operationId);
    if (!matches.length) return null;
    if (matches.length !== 1 || matches[0]!.modelName !== modelNamesFor(version)[mode] ||
        matches[0]!.fields.ContentKey?.value !== keys.contentKey || matches[0]!.fields.LexemeKey?.value !== keys.lexemeKey) {
      throw new AnkiError('OPERATION_CONFLICT', 'Идентификатор операции найден с другим содержимым или более одного раза.');
    }
    return matches[0]!.noteId;
  }
  async findDuplicates(draft: NoteDraft, keys?: SemanticKeys): Promise<DuplicateMatch[]> {
    const actualKeys = keys ?? await semanticKeys(draft);
    return (await this.findByField('LexemeKey', actualKeys.lexemeKey)).map((note) => ({
      noteId: note.noteId, modelName: note.modelName,
      expression: (note.fields.Expression?.value ?? '').slice(0, 256),
      meaning: (note.fields.Meaning?.value ?? '').slice(0, 500),
      exactContent: note.fields.ContentKey?.value === actualKeys.contentKey,
    }));
  }
  async storeAudio(operationId: string, bytes: Uint8Array): Promise<string> {
    if (!/^[0-9a-f-]{36}$/iu.test(operationId) || bytes.byteLength < 1 || bytes.byteLength > 10 * 1024 * 1024) throw new AnkiError('AUDIO_UNAVAILABLE', 'Некорректный аудиофайл.');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const result = await this.invoke('storeMediaFile', { filename: `englishreader-${operationId}.mp3`, data: btoa(binary), deleteExisting: false });
    if (!validMediaFilename(result)) throw new AnkiError('AUDIO_UNAVAILABLE', 'AnkiConnect вернул небезопасное имя аудиофайла.');
    return result;
  }
  prepareNote(operationId: string, draft: NoteDraft, keys: SemanticKeys, mediaFilename?: string | null): PreparedAnkiNote {
    return { deckName: draft.deckName, modelName: modelNamesFor(draftVersion(draft))[draft.mode],
      fields: buildNoteFields(operationId, draft, keys, mediaFilename), tags: [...draft.tags],
      options: { allowDuplicate: false, duplicateScope: 'collection' } };
  }
  async addPreparedNote(note: PreparedAnkiNote): Promise<number> {
    const noteId = await this.invoke('addNote', { note });
    if (!isId(noteId)) throw new AnkiError('ANKI_SCHEMA_MISMATCH', 'AnkiConnect не вернул идентификатор заметки.', false, true);
    return noteId;
  }
  async openNote(noteId: number): Promise<void> {
    if (!isId(noteId)) throw new AnkiError('INVALID_INPUT', 'Некорректный идентификатор заметки.');
    const info = await this.invoke('notesInfo', { notes: [noteId] });
    if (!Array.isArray(info) || info.length !== 1 || !object(info[0]) || info[0].noteId !== noteId ||
      !ALL_MODEL_NAMES.includes(String(info[0].modelName))) {
      throw new AnkiError('PERMISSION_DENIED', 'Можно открыть только заметку EnglishReader.');
    }
    await this.invoke('guiBrowse', { query: `nid:${noteId}` });
  }
}
