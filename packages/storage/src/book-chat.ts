import {request,txDone} from './idb.ts';
import type { BookChatHistory, BookChatPage, BookChatTurn } from '../../contracts/src/book-chat.ts';
import { GRAMMAR_ANSWER_LIMIT, GRAMMAR_QUESTION_LIMIT } from '../../contracts/src/grammar-chat-limits.ts';
import { isLanguageCode } from '../../contracts/src/languages.ts';
import { isLanguageChatText } from '../../contracts/src/language-chat-text.ts';
import { ServiceError, storageError } from '../../services/src/errors.ts';

export const BOOK_CHAT_MAX_TURNS = 2_000;
export const BOOK_CHAT_MAX_UNITS = 32_000_000;
const PAGE_COUNT = 20;
const PAGE_UNITS = 200_000;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && isLanguageChatText(v);
const notices = new Set(['pending','out_of_scope','model_out_of_scope','model_no_answer','topic_reset']);

function validTurn(turn: unknown): turn is BookChatTurn {
  if (!record(turn) || !uuid(turn.turnId) || !text(turn.question, GRAMMAR_QUESTION_LIMIT) || typeof turn.kind !== 'string') return false;
  const fields = ['turnId','question','kind'];
  if (turn.kind === 'answer') {
    if (!text(turn.answer, GRAMMAR_ANSWER_LIMIT) || turn.source !== undefined && turn.source !== 'analysis' ||
        turn.language !== undefined && !isLanguageCode(turn.language)) return false;
    fields.push('answer','source','language');
  } else if (turn.kind === 'failed') {
    if (!text(turn.message, 2_000)) return false;
    fields.push('message');
  } else if (!notices.has(turn.kind)) return false;
  return Object.keys(turn).every(key => fields.includes(key));
}
const weight = (turn: BookChatTurn) => turn.question.length + (turn.kind === 'answer' ? turn.answer.length : turn.kind === 'failed' ? turn.message.length : 0);

type IndexEntry = { id: string; units: number };
type Head = { generation: string; entries: IndexEntry[] };
const empty = (): Head => ({generation: crypto.randomUUID(), entries: []});
const headerKey = (id: string) => 'book-chat-v1:' + id;
const turnKey = (id: string, turn: string) => headerKey(id) + ':' + turn;
function checkedHead(raw: unknown): Head {
  if (!record(raw) || !uuid(raw.generation) || !Array.isArray(raw.entries) || raw.entries.length > BOOK_CHAT_MAX_TURNS ||
      !raw.entries.every(e => record(e) && uuid(e.id) && Number.isSafeInteger(e.units) && Number(e.units) > 0) ||
      new Set(raw.entries.map(e => e.id)).size !== raw.entries.length) {
    throw new ServiceError('STORAGE_UNAVAILABLE');
  }
  return {generation: raw.generation, entries: raw.entries};
}
function equalTurn(a: BookChatTurn, b: BookChatTurn): boolean {
  if (a.question !== b.question || a.kind !== b.kind) return false;
  if (a.kind === 'answer' && b.kind === 'answer') return a.answer === b.answer && a.source === b.source && a.language === b.language;
  return a.kind !== 'failed' || (b.kind === 'failed' && a.message === b.message);
}

export async function deleteBookTranscript(meta: IDBObjectStore, id: string): Promise<void> {
  const item = await request(meta.get(headerKey(id)));
  if (item) {
    for (const entry of checkedHead(item.value).entries) meta.delete(turnKey(id, entry.id));
    meta.delete(headerKey(id));
  }
}

export function forStoredBook(db: IDBDatabase, id: string): BookChatHistory {
  if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new ServiceError('INVALID_INPUT');

  // libraryBooks is in the same transaction as the transcript: deleting a book,
  // clearing it in another tab and appending a late answer are strictly ordered.
  async function edit<T>(run: (meta: IDBObjectStore, head: Head) => Promise<T> | T): Promise<T> {
    let tx: IDBTransaction;
    try { tx = db.transaction(['libraryBooks','metadata'], 'readwrite'); }
    catch (error) { throw storageError(error); }
    const done = txDone(tx);
    void done.catch(() => {});
    try {
      const meta = tx.objectStore('metadata');
      const [book, raw] = await Promise.all([request(tx.objectStore('libraryBooks').getKey(id)), request(meta.get(headerKey(id)))]);
      if (!book) throw new ServiceError('INVALID_INPUT','Книга не сохранена в библиотеке.');
      const head = raw ? checkedHead(raw.value) : empty();
      if (!raw) meta.put({key:headerKey(id),value:head});
      const result = await run(meta,head);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Already completed or aborted. */ }
      await done.catch(() => {});
      throw storageError(error);
    }
  }
  function requireGeneration(head: Head, generation: string) {
    if (head.generation !== generation) throw new ServiceError('OPERATION_CONFLICT','История книги была очищена. Откройте её заново.');
  }
  return {
    async read(before) {
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1 || before > BOOK_CHAT_MAX_TURNS)) throw new ServiceError('INVALID_INPUT');
      return edit(async (meta,head): Promise<BookChatPage> => {
        const end = Math.min(before ?? head.entries.length, head.entries.length);
        let start = end, units = 0;
        while (start > 0 && end - start < PAGE_COUNT) {
          const size = head.entries[start - 1].units;
          if (units && units + size > PAGE_UNITS) break;
          units += size; start--;
        }
        const turns = await Promise.all(head.entries.slice(start,end).map(async entry => {
          const item = await request(meta.get(turnKey(id,entry.id)));
          if (!validTurn(item?.value) || item.value.turnId !== entry.id) throw new ServiceError('STORAGE_UNAVAILABLE');
          return item.value;
        }));
        return {generation:head.generation, turns, before:start || null};
      });
    },
    async upsert(input,generation) {
      if (!validTurn(input)) throw new ServiceError('INVALID_INPUT');
      const turn = structuredClone(input);
      return edit(async (meta,head) => {
        requireGeneration(head,generation);
        const key = turnKey(id,turn.turnId);
        const index = head.entries.findIndex(entry => entry.id === turn.turnId);
        if (index >= 0) {
          const item = await request(meta.get(key));
          if (!validTurn(item?.value)) throw new ServiceError('STORAGE_UNAVAILABLE');
          const previous = item.value;
          if (equalTurn(previous,turn) || (turn.kind === 'pending' && previous.question === turn.question)) return;
          if (previous.question !== turn.question || previous.kind !== 'pending') throw new ServiceError('OPERATION_CONFLICT');
        }
        const units = weight(turn);
        const total = head.entries.reduce((sum,e) => sum + e.units, 0) - (head.entries[index]?.units ?? 0) + units;
        if (index < 0 && head.entries.length >= BOOK_CHAT_MAX_TURNS || total > BOOK_CHAT_MAX_UNITS) throw new ServiceError('STORAGE_QUOTA');
        const entry = {id:turn.turnId,units};
        if (index < 0) head.entries.push(entry); else head.entries[index] = entry;
        meta.put({key,value:turn});
        meta.put({key:headerKey(id),value:head});
      });
    },
    clear(generation) {
      return edit((meta,head) => {
        requireGeneration(head,generation);
        for (const entry of head.entries) meta.delete(turnKey(id,entry.id));
        const next = empty();
        meta.put({key:headerKey(id),value:next});
        return {generation:next.generation,turns:[],before:null};
      });
    },
  };
}
