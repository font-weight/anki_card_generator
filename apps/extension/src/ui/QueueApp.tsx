import React, { useCallback, useEffect, useRef, useState } from 'react';
import { draftExamples, getLanguage, type QueueItem, type Source } from '@english-reader/contracts';
import { chapterTitle, displayBookTitle } from '../readers/book-presentation';
import { getRpcWarnings } from '../runtime/rpc-metadata';
import { errorText, type UiRpc } from './interfaces';

type WordPage = { items: QueueItem[]; nextCursor: string | null };
const labels: Record<QueueItem['state'], string> = {
  pending: 'Ожидает отправки', preparing_audio: 'Подготовка аудио',
  awaiting_audio_decision: 'Нужно проверить аудио', awaiting_duplicate_decision: 'Возможный дубликат',
  ready: 'Готово к отправке', submitting: 'Отправляется', reconciling: 'Проверяем результат',
  synced: 'Добавлено в Anki', failed: 'Не удалось отправить', cancelled: 'Отменено локально',
};
const countFormat = new Intl.PluralRules('ru');
const countForms: Record<string, string> = { one: 'запись', few: 'записи', many: 'записей', other: 'записей' };

function sourceLabel(source?: Source) {
  if (!source) return '';
  const title = source.kind === 'html' ? source.title : displayBookTitle(source.title || '');
  const location = source.page ? `Стр. ${source.page}` : chapterTitle(source.chapter || '');
  return [title, location].filter(Boolean).join(' · ');
}

function SymbolIcon({ name }: {name: 'book' | 'refresh' | 'external' | 'empty'}) {
  const shapes = {
    book: <><path d="M3 5c3-1 6 0 9 2 3-2 6-3 9-2v14c-3-1-6 0-9 2-3-2-6-3-9-2Z"/><path d="M12 7v14"/></>,
    refresh: <><path d="M19 9a7 7 0 1 0 0 6M19 4v5h-5"/></>,
    external: <><path d="M13 4h7v7m0-7L10 14"/><path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/></>,
    empty: <><rect x="2" y="5" width="16" height="12" rx="2" transform="rotate(-11 10 11)"/><rect x="5" y="7" width="16" height="12" rx="2" fill="var(--wb-surface)" transform="rotate(5 13 13)"/><path d="m8 11 6 .5m-6 3 9 .7"/></>,
  };
  return <svg className="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}

function RemovalDialog({word, busy, error, onCancel, onConfirm}: {
  word: string; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal?.();
    if (!element.open) element.setAttribute('open', '');
    keep.current?.focus();
    return () => { if (element.open) element.close?.(); };
  }, []);
  return <dialog ref={dialog} className="wb-dialog" aria-labelledby="remove-word-heading" aria-describedby="remove-word-description"
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="remove-word-heading">Убрать «<bdi>{word}</bdi>» из базы слов?</h2>
    <p id="remove-word-description">Запись исчезнет из списка. Заметка и её карточки останутся в Anki.</p>
    {error && <p className="wb-error" role="alert">{error}</p>}
    <div className="wb-dialog-actions">
      <button ref={keep} disabled={busy} onClick={onCancel}>Оставить</button>
      <button className="wb-remove-confirm" disabled={busy} onClick={onConfirm}>{busy ? 'Убираем…' : 'Убрать из базы'}</button>
    </div>
  </dialog>;
}

type ItemActions = (type: string, item: QueueItem, extra?: Record<string, unknown>) => void;
function WordEntry({item, busy, onAction, onRemove}: {
  item: QueueItem; busy: boolean; onAction: ItemActions; onRemove: (item: QueueItem, trigger: HTMLButtonElement) => void;
}) {
  const {draft, state} = item;
  const source = sourceLabel(draft.source);
  const examples = draftExamples(draft) || [];
  const canRetry = ['pending', 'ready', 'failed'].includes(state);
  const canCancel = canRetry || state === 'awaiting_audio_decision' || state === 'awaiting_duplicate_decision';
  return <article className="wb-entry">
    <header><h2 dir="auto" lang={draft.sourceLanguage}>{draft.expression || 'Заметка'}</h2>
      <span className={`wb-state wb-state-${state}`}><span aria-hidden="true">{state === 'synced' ? '✓' : state === 'failed' ? '!' : '•'}</span>{labels[state]}</span></header>
    <p className="wb-meaning" dir="auto" lang={draft.targetLanguage}>{draft.selectedSense?.translations.join('; ')}</p>
    {draft.context?.sentence && <p className="wb-context" dir="auto" lang={draft.sourceLanguage}>{draft.context.sentence}</p>}
    {source && <p className="wb-source"><SymbolIcon name="book"/><bdi>{source}</bdi></p>}
    {state === 'cancelled' && <p className="wb-hint">Отменена только локальная операция. Эта отмена не проверяет, не изменяет и не удаляет заметку в Anki. Если результат неизвестен, проверьте исходное место назначения.</p>}
    {['failed', 'submitting', 'reconciling'].includes(state) && <p className="wb-hint">Если результат отправки неизвестен, проверьте исходный адрес AnkiConnect и колоду перед повторным добавлением.</p>}
    {item.lastError && <p className="wb-error">{typeof item.lastError === 'string' ? item.lastError : item.lastError.message}</p>}
    {state === 'awaiting_duplicate_decision' && <p className="wb-hint">Найдены возможные дубликаты. Автоматическая отправка приостановлена.</p>}
    <div className="wb-actions">
      {!!item.noteId && <button disabled={busy} onClick={() => onAction('anki.openNote', item)}>Открыть в Anki <SymbolIcon name="external"/></button>}
      {state === 'synced' && !!item.noteId && <button className="wb-quiet" disabled={busy} onClick={event => onRemove(item, event.currentTarget)}>Убрать из базы</button>}
      {canRetry && <button disabled={busy} onClick={() => onAction('queue.retry', item)}>Повторить отправку</button>}
      {state === 'awaiting_audio_decision' && <>
        <button disabled={busy} onClick={() => onAction('queue.resolveAudio', item, { action: 'retry' })}>Повторить подготовку аудио</button>
        <button disabled={busy} onClick={() => onAction('queue.resolveAudio', item, { action: 'save_without_audio' })}>Подтверждаю: отправить без аудио</button>
      </>}
      {state === 'awaiting_duplicate_decision' && <button disabled={busy} onClick={() => onAction('anki.addNote', item, {
        draft, includeAudio: item.includeAudio, ...(item.audioId ? {audioId:item.audioId} : {}), duplicateAction: 'add_new',
      })}>Подтверждаю: добавить новую заметку несмотря на дубликат</button>}
      {canCancel && <button className="wb-quiet" disabled={busy} onClick={() => onAction('queue.cancel', item)}>Отменить локальную операцию</button>}
      <details className="wb-details"><summary>Подробности</summary>
        <div><p>Колода: <bdi>{draft.deckName}</bdi> · {draft.mode === 'cloze' ? 'Пропуск (c1)' : 'Узнавание'}</p>
          {draft.sourceLanguage && draft.targetLanguage && <p>{getLanguage(draft.sourceLanguage).name} → {getLanguage(draft.targetLanguage).name.toLocaleLowerCase('ru')}</p>}
          {examples.map((example, index) => <div key={index}><p lang={draft.sourceLanguage} dir="auto">{example.text}</p><p lang={draft.targetLanguage} dir="auto">{example.translation}</p></div>)}
        </div>
      </details>
    </div>
  </article>;
}

export function QueueApp({rpc, subscribe}: { rpc: UiRpc; subscribe?: (listener: () => void) => () => void }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [error, setError] = useState('');
  const [queueReviewRequired, setQueueReviewRequired] = useState(false);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<QueueItem | null>(null);
  const sequence = useRef(0), locked = useRef(false);
  const removeTrigger = useRef<HTMLButtonElement | null>(null), refreshButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    const token = ++sequence.current;
    try {
      const response = await rpc<WordPage>('queue.list');
      if (token !== sequence.current) return;
      setQueueReviewRequired(getRpcWarnings(response).includes('ANKI_QUEUE_REVIEW_REQUIRED'));
      setItems(response.items); setCursor(response.nextCursor ?? null); setLoaded(true); setError('');
    } catch (e) {
      if (token === sequence.current) { setError(errorText(e)); setLoaded(true); }
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
    const reconnect = () => void refresh();
    window.addEventListener('online', reconnect); window.addEventListener('focus', reconnect);
    const unsubscribe = subscribe?.(reconnect);
    return () => {
      sequence.current++;
      window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect); unsubscribe?.();
    };
  }, [refresh, subscribe]);
  function closeRemoval() {
    setRemoving(null);
    setError('');
    requestAnimationFrame(() => (removeTrigger.current?.isConnected ? removeTrigger.current : refreshButton.current)?.focus());
  }
  async function act(type: string, item: QueueItem, extra: Record<string, unknown> = {}) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      await rpc(type, type === 'anki.openNote' ? {noteId: item.noteId} : {operationId: item.operationId, ...extra});
      if (type === 'queue.removeLocal') {
        setItems(current => current.filter(row => row.operationId !== item.operationId));
        closeRemoval();
      }
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  async function loadMore() {
    if (!cursor || locked.current) return;
    locked.current = true; setBusy(true);
    const token = sequence.current;
    try {
      const response = await rpc<WordPage>('queue.list', {cursor});
      if (token !== sequence.current) return;
      if (getRpcWarnings(response).includes('ANKI_QUEUE_REVIEW_REQUIRED')) setQueueReviewRequired(true);
      setItems(current => [...current, ...response.items.filter(row => !current.some(old => old.operationId === row.operationId))]);
      setCursor(response.nextCursor ?? null); setError('');
    } catch (e) { if (token === sequence.current) setError(errorText(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="word-base"><header className="wb-brand">Language Reader for Anki</header><main>
    <header className="wb-heading"><div><h1>База слов</h1>
      {loaded && <p>{cursor ? `Показано: ${items.length}` : `${items.length} ${countForms[countFormat.select(items.length)]}`}</p>}
    </div><button ref={refreshButton} onClick={() => void refresh()}><SymbolIcon name="refresh"/>Обновить</button></header>
    {queueReviewRequired && <p className="wb-error" role="alert">Старые операции требуют проверки после изменения адреса AnkiConnect. Это не обычная очередь для повторной отправки. Проверьте исходную колоду и сообщения об ошибках перед дальнейшими действиями.</p>}
    {error && !removing && <p className="wb-error" role="alert">{error}</p>}
    {!loaded && <p role="status">Загружаем записи…</p>}
    {loaded && !items.length && !error && <section className="wb-empty"><SymbolIcon name="empty"/><h2>Пока нет сохранённых слов</h2>
      <p>Откройте книгу, переведите слово с помощью Shift и нажмите «Добавить в Anki».</p>
      <a href="library.html"><SymbolIcon name="book"/>Открыть библиотеку</a></section>}
    <div className="wb-list">{items.map(item => <WordEntry key={item.operationId} item={item} busy={busy}
      onAction={(type, row, payload) => void act(type, row, payload)}
      onRemove={(row, trigger) => { removeTrigger.current = trigger; setError(''); setRemoving(row); }}/>)}</div>
    {cursor && <button className="wb-more" disabled={busy} onClick={() => void loadMore()}>Загрузить ещё</button>}
    {removing && <RemovalDialog word={removing.draft.expression} busy={busy} error={error} onCancel={closeRemoval}
      onConfirm={() => void act('queue.removeLocal', removing)}/>}
  </main></div>;
}
