import { readLookupDiagnostics, type LookupDiagnostics } from '@english-reader/contracts';

/** UI copy is chosen from fixed codes, never from a provider response, transport
 * message, model name, key, prompt, or diagnostic payload. Unknown errors stay
 * generic. Keep this lookup-only so save/queue recovery semantics are unchanged. */
const messages = {
  INVALID_MODEL_OUTPUT: 'Не удалось прочитать ответ. Можно попробовать ещё раз.',
  MODEL_INCOMPLETE: 'Ответ пришёл не полностью. Можно попробовать ещё раз.',
  MODEL_REFUSAL: 'Не удалось перевести этот фрагмент. Попробуйте выбрать другое слово или предложение.',
  NETWORK_TIMEOUT: 'Перевод занял слишком много времени. Можно попробовать ещё раз.',
  OPENAI_AUTH: 'Проверьте API-ключ в настройках расширения.',
  OPENAI_QUOTA: 'Проверьте доступный баланс и лимиты API.',
  OPENAI_REQUEST_REJECTED: 'API отклонил запрос до перевода. Причина указана в технических сведениях.',
  OPENAI_RATE_LIMIT: 'Слишком много запросов. Подождите немного перед повтором.',
  MODEL_UNAVAILABLE: 'Перевод сейчас недоступен. Попробуйте позже.',
  PERMISSION_DENIED: 'Нет доступа к переводу. Проверьте настройки расширения.',
  INVALID_INPUT: 'Не удалось перевести выделение. Попробуйте выбрать слово ещё раз.',
  REQUEST_CANCELLED: 'Запрос был остановлен. Можно попробовать ещё раз.',
  INTERNAL_ERROR: 'Не удалось выполнить запрос. Можно попробовать ещё раз.',
} as const;
const stages: Record<LookupDiagnostics['stage'], string> = {
  request: 'Отправка запроса', response: 'Ответ API', output: 'Чтение результата', validation: 'Проверка перевода',
};
const reasons: Record<LookupDiagnostics['reason'], string> = {
  request_rejected: 'API отклонил запрос. Повтор без изменений может не помочь.',
  request_schema: 'API не принял формат запроса расширения. Это не ошибка выбранного слова.',
  request_parameter: 'API не принял один из параметров запроса расширения.',
  request_model: 'API не принял указанную модель.',
  response_too_large: 'Ответ API превышает допустимый размер.',
  response_json: 'Ответ API не является корректным JSON.',
  response_shape: 'Неожиданная структура ответа API.',
  response_status: 'Неожиданный статус ответа API.',
  output_missing: 'В ответе нет текста перевода.',
  output_multiple: 'API вернул несколько отдельных ответов вместо одного.',
  output_json: 'Текст результата не является корректным JSON.',
  output_refusal: 'Модель отказалась обрабатывать этот фрагмент.',
  output_incomplete: 'Модель не завершила ответ. Частичный перевод не используется.',
  lookup_shape: 'Не совпадают обязательные поля результата.',
  sentence_translation: 'Неверный формат полного перевода предложения.',
  sense_shape: 'Неверная структура одного из значений.',
  sense_id: 'Неверный или повторяющийся идентификатор значения.',
  sense_translations: 'Неверный формат списка переводов.',
  sense_definition: 'Неверный формат определения.',
  definition_language: 'Определение не соответствует выбранному языку текста.',
  definition_script_cyrillic: 'Ожидалось определение на английском; получен текст с кириллицей без латинских букв. Сам текст ответа не сохраняется в диагностике.',
  translation_language: 'Перевод не соответствует выбранному языку перевода.',
  candidate_binding: 'Выбранное выражение или его лемма не совпадают с исходным фрагментом.',
  recommendation: 'Рекомендованное значение не совпадает со списком значений.',
  ipa_shape: 'Неверный формат транскрипции.',
  ipa_dialect: 'Транскрипция не соответствует выбранному варианту произношения.',
  result_contract: 'Результат не прошёл проверку обязательных полей.',
  result_binding: 'Результат не совпадает с выбранным фрагментом текста.',
  examples_shape: 'Неверный формат примеров.',
  input_invalid: 'Не удалось проверить выбранный фрагмент текста.',
};
export interface LookupFailure { message: string; code?: keyof typeof messages; diagnostics?: LookupDiagnostics }
export function lookupDiagnosticText(diagnostics: LookupDiagnostics): { stage: string; reason: string } {
  return { stage: stages[diagnostics.stage], reason: reasons[diagnostics.reason] };
}
export function lookupFailure(error: unknown): LookupFailure {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && Object.hasOwn(messages, code)) {
    const safeCode = code as keyof typeof messages;
    const diagnostics = readLookupDiagnostics((error as {diagnostics?: unknown}).diagnostics);
    const languageFailure = safeCode === 'INVALID_MODEL_OUTPUT' && diagnostics?.stage === 'validation' &&
      (diagnostics.reason === 'definition_language' || diagnostics.reason === 'definition_script_cyrillic' || diagnostics.reason === 'translation_language');
    const message = languageFailure
      ? 'Язык ответа ИИ не прошёл проверку. Это не означает, что слово выделено неправильно. Если выбранные языки верны, менять настройки не нужно.'
      : messages[safeCode];
    return { message, code: safeCode, ...(diagnostics ? {diagnostics} : {}) };
  }
  return { message: 'Проверьте подключение и попробуйте ещё раз.' };
}
