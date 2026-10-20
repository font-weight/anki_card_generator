import {attachRpcWarnings} from './rpc-metadata';
/** UI receives data only, never provider credentials. Runtime schemas are owned by contracts. */
export async function rpc<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const requestId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({v:1, requestId, type, payload}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Превышено время ожидания. Проверьте состояние операции перед повторным сохранением.')), 45000); }),
    ]);
    if (!response || response.v !== 1 || response.requestId !== requestId) throw new Error('Некорректный ответ расширения.');
    if (!response.ok) throw new Error(response.error?.message || 'Не удалось выполнить операцию.');
    if(!response.data||typeof response.data!=='object')throw new Error('Некорректные данные ответа.');
    return attachRpcWarnings(response.data,Array.isArray(response.warnings)?response.warnings:[]) as T;
  } finally { if (timer) clearTimeout(timer); }
}
