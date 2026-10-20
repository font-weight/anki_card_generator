import type { ErrorCode, SafeError } from '../../contracts/src/index.ts';
const messages:Record<ErrorCode,string> = {
 INVALID_INPUT:'Некорректные данные запроса.',PERMISSION_DENIED:'Нет разрешения для этого действия.',EXTRACTION_FAILED:'Не удалось извлечь подходящий фрагмент.',OPENAI_AUTH:'Проверьте ключ OpenAI API.',OPENAI_QUOTA:'Недостаточно квоты OpenAI API.',OPENAI_RATE_LIMIT:'Достигнут лимит запросов OpenAI.',MODEL_UNAVAILABLE:'Выбранная модель недоступна.',MODEL_REFUSAL:'Модель отказалась обработать запрос.',INVALID_MODEL_OUTPUT:'Модель вернула некорректную структуру.',NETWORK_TIMEOUT:'Превышено время ожидания сети.',DICTIONARY_UNAVAILABLE:'Словарь недоступен.',AUDIO_UNAVAILABLE:'Аудио недоступно.',ANKI_UNAVAILABLE:'AnkiConnect недоступен.',ANKI_AUTH:'Проверьте ключ AnkiConnect.',ANKI_ORIGIN_DENIED:'AnkiConnect не разрешает источник расширения.',ANKI_SCHEMA_MISMATCH:'Поля типа заметки несовместимы.',STORAGE_QUOTA:'Недостаточно локального места.',OPERATION_CONFLICT:'Операция конфликтует с сохранённым состоянием.',REQUEST_CANCELLED:'Запрос отменён.',MODEL_INCOMPLETE:'Ответ модели не завершён.',LOOKUP_EXPIRED:'Результат перевода больше не доступен.',ANKI_DECK_NOT_FOUND:'Выбранная колода не найдена.',STORAGE_UNAVAILABLE:'Локальное хранилище недоступно.',INTERNAL_ERROR:'Не удалось выполнить действие.'
};
export class ServiceError extends Error {
 readonly code:ErrorCode; readonly retryable:boolean;
 constructor(code:ErrorCode,message?:string,retryable=false){super(message??messages[code]);this.name='ServiceError';this.code=code;this.retryable=retryable;}
 toJSON():SafeError{return {code:this.code,message:messages[this.code],retryable:this.retryable};}
}
export function safeError(error:unknown):SafeError {return error instanceof ServiceError?error.toJSON():{code:'INTERNAL_ERROR',message:messages.INTERNAL_ERROR,retryable:false};}
export function storageError(error:unknown):ServiceError {return error instanceof ServiceError?error:new ServiceError(error instanceof Error&&error.name==='QuotaExceededError'?'STORAGE_QUOTA':'STORAGE_UNAVAILABLE');}
