import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { QueueItem } from '@english-reader/contracts';
import { getRpcWarnings } from '../runtime/rpc-metadata';
import { errorText, type UiRpc } from './interfaces';

const labels: Record<string, string> = { pending: 'Ожидает отправки — не добавлено', preparing_audio: 'Подготовка аудио', awaiting_audio_decision: 'Ошибка аудио — требуется решение', awaiting_duplicate_decision: 'Нужно проверить дубликаты', ready: 'Готово к отправке — не добавлено', submitting: 'Отправляется', reconciling: 'Проверяем результат отправки', synced: 'Добавлено в Anki', failed: 'Не удалось отправить', cancelled: 'Отменено' };
export function QueueApp({ rpc, subscribe }: { rpc: UiRpc; subscribe?: (listener: () => void) => () => void }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [error, setError] = useState('');
  const [queueReviewRequired, setQueueReviewRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++seq.current;
    try { const response = await rpc<{ items: QueueItem[]; nextCursor: string | null }>('queue.list'); if (token !== seq.current) return; setQueueReviewRequired(getRpcWarnings(response).includes('ANKI_QUEUE_REVIEW_REQUIRED')); setItems(response.items); setCursor(response.nextCursor ?? null); setLoaded(true); setError(''); }
    catch (e) { if (token === seq.current) { setError(errorText(e)); setLoaded(true); } }
  }, [rpc]);
  useEffect(() => {
    void refresh();
    const reconnect = () => void refresh();
    window.addEventListener('online', reconnect); window.addEventListener('focus', reconnect);
    const unsubscribe = subscribe?.(reconnect);
    return () => { seq.current++; window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect); unsubscribe?.(); };
  }, [refresh, subscribe]);
  async function act(type: string, item: QueueItem, payload: Record<string, unknown> = {}) {
    if (busyId) return; setBusyId(item.operationId); setError('');
    try { await rpc(type, type === 'anki.openNote' ? { noteId: item.noteId } : { operationId: item.operationId, ...payload }); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setBusyId(''); }
  }
  async function loadMore() {
    if (!cursor || busyId) return;
    setBusyId('pagination'); const token = seq.current;
    try { const response = await rpc<{ items: QueueItem[]; nextCursor: string | null }>('queue.list', { cursor }); if (token === seq.current) { if (getRpcWarnings(response).includes('ANKI_QUEUE_REVIEW_REQUIRED')) setQueueReviewRequired(true); setItems(current => [...current, ...response.items.filter(item => !current.some(old => old.operationId === item.operationId))]); setCursor(response.nextCursor); } }
    catch (e) { setError(errorText(e)); } finally { setBusyId(''); }
  }
  return <main className="page stack"><header className="row between"><div><h1>Очередь заметок</h1><p>В очереди ≠ добавлено в Anki. Здесь хранится состояние отправки.</p></div><button onClick={() => void refresh()}>Обновить</button></header>
    {queueReviewRequired && <p className="status error" role="alert">Старые операции требуют проверки после изменения адреса AnkiConnect. Их сохранённые данные не перенесены и не отправлены автоматически. Это не обычная очередь для повторной отправки: просмотрите снимки заметок и сообщения об ошибках перед дальнейшими действиями.</p>}
    {error && <p className="status error" role="alert">{error}</p>}{!loaded && <p role="status">Загрузка очереди…</p>}{loaded && !items.length && !error && <p className="status">Очередь пуста.</p>}
    <div aria-live="polite">{items.map(item => <article className="queue-item stack" key={item.operationId}><div className="row between"><strong>{item.draft?.expression ?? 'Заметка'}</strong><span className="badge">{labels[item.state] ?? `Состояние: ${item.state}`}</span></div><small>Операция: {item.operationId}</small>
      {item.draft && <details><summary>Сохранённая заметка — проверить перед действием</summary><p><strong>Колода:</strong> {item.draft.deckName}</p><p><strong>Тип:</strong> {item.draft.mode === 'cloze' ? 'Пропуск (c1)' : 'Узнавание'}</p><p><strong>Выбранное значение:</strong> {item.draft.selectedSense?.translations.join('; ')}</p><p className="sentence">{item.draft.context?.sentence}</p><p className="muted">Источник: {item.draft.source?.title || 'Не указан'}</p><p className="muted">Это сохранённый снимок операции. Изменение настроек не меняет его и не переносит заметку автоматически.</p></details>}
      {item.lastError && <p className="error">{typeof item.lastError === 'string' ? item.lastError : item.lastError.message ?? 'Ошибка отправки'}</p>}
      <div className="row">{!['synced', 'cancelled', 'submitting', 'reconciling', 'awaiting_duplicate_decision', 'awaiting_audio_decision'].includes(item.state) && <><button disabled={!!busyId} onClick={() => void act('queue.retry', item)}>Повторить отправку</button><button disabled={!!busyId} onClick={() => void act('queue.cancel', item)}>Отменить отправку</button></>}{!!item.noteId && <button onClick={() => void act('anki.openNote', item, { noteId: item.noteId })}>Открыть в Anki</button>}</div>
      {item.state === 'awaiting_audio_decision' && <div className="row"><button disabled={!!busyId} onClick={() => void act('queue.resolveAudio', item, { action: 'retry' })}>Повторить подготовку аудио</button><button disabled={!!busyId} onClick={() => void act('queue.resolveAudio', item, { action: 'save_without_audio' })}>Подтверждаю: отправить без аудио</button></div>}
    {item.state === 'awaiting_duplicate_decision' && <div className="stack"><p className="status">Найдены возможные дубликаты. Автоматическая отправка приостановлена.</p><button disabled={!!busyId} onClick={() => void act('anki.addNote', item, { draft: item.draft, includeAudio: item.includeAudio, ...(item.audioId ? { audioId: item.audioId } : {}), duplicateAction: 'add_new' })}>Подтверждаю: добавить новую заметку несмотря на дубликат</button></div>}{['awaiting_duplicate_decision', 'awaiting_audio_decision'].includes(item.state) && <button disabled={!!busyId} onClick={() => void act('queue.cancel', item)}>Отменить отправку</button>}
    </article>)}</div>{cursor && <button disabled={!!busyId} onClick={() => void loadMore()}>Загрузить ещё</button>}
  </main>;
}
