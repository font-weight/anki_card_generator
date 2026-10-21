import {attachRpcWarnings} from './rpc-metadata';
const cancelableLookups = new Set(['lookup', 'lookup.refine', 'card.enrich']);
/** UI receives data only, never provider credentials. Runtime schemas are owned by contracts.
 * Cancellation is deliberately lookup-only: a dispatched save belongs to the durable queue.
 * Stopping a provider request is best effort and never promises that its cost was avoided.
 */
export async function rpc<T = unknown>(type: string, payload: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<T> {
  const requestId = crypto.randomUUID();
  const signal = cancelableLookups.has(type) ? options.signal : undefined;
  const cancelledError = () => new DOMException('Запрос перевода отменён.', 'AbortError');
  if (signal?.aborted) throw cancelledError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let cancelSent = false;
  const cancel = () => {
    if (!cancelableLookups.has(type) || cancelSent) return;
    cancelSent = true;
    // Use the original RPC request ID: the first lookup has no lookupId yet.
    try { void Promise.resolve(chrome.runtime.sendMessage({v:1, requestId:crypto.randomUUID(), type:'lookup.cancel', payload:{requestId}})).catch(() => {}); }
    catch { /* Disconnected workers cannot acknowledge cancellation. Stale UI still stays invalid. */ }
  };
  const aborted = signal ? new Promise<never>((_, reject) => {
    abort = () => { cancel(); reject(cancelledError()); };
    signal.addEventListener('abort', abort, {once:true});
  }) : undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({v:1, requestId, type, payload}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel(); reject(new Error('Превышено время ожидания. Проверьте состояние операции перед повторным сохранением.')); }, 45000); }),
      ...(aborted ? [aborted] : []),
    ]);
    if (!response || response.v !== 1 || response.requestId !== requestId) throw new Error('Некорректный ответ расширения.');
    if (!response.ok) throw new Error(response.error?.message || 'Не удалось выполнить операцию.');
    if(!response.data||typeof response.data!=='object')throw new Error('Некорректные данные ответа.');
    return attachRpcWarnings(response.data,Array.isArray(response.warnings)?response.warnings:[]) as T;
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
