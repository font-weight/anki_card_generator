import React, { useEffect, useRef, useState } from 'react';
import { LANGUAGES, defaultLocale } from '@english-reader/contracts';
import { languageFeatureLabel, grammarRequestCost, languageChatCost } from './grammar-copy';
import { lookupPreferences } from '../runtime/reader-preferences';
import type { SettingsPatch, PublicSettings, LanguageCode } from '@english-reader/contracts';
import { getRpcWarnings } from '../runtime/rpc-metadata';
import { errorText, type UiRpc } from './interfaces';

type EditableSettings = Omit<SettingsPatch, 'learnerLevel'>;
const sections = {
  openai: 'Подключение OpenAI',
  anki: 'Anki и колода',
  languages: 'Языки, разбор и чат',
  services: 'Произношение и сервисы',
} as const;
type Section = keyof typeof sections;
const navIcons: Record<Section, string> = {
  openai: 'M15 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0Zm-2 4 7 7h2v-4h-3v-3h-3',
  anki: 'M6 16H4V4h13v2M8 8h12v12H8z',
  languages: 'M3 6h12M9 3v3M5 8c1 3 4 6 7 8M13 6c-1 5-4 9-9 12M14 21l4-10 4 10m-7-3h6',
  services: 'M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8m3-12a11 11 0 0 1 0 16',
};
type AnkiCheckState = { state: 'idle' | 'checking' } | { state: 'success'; deckCount: number } | { state: 'error'; message: string };
type SettingsNotification = { id: number; kind: 'progress' | 'success' | 'error'; message: string; dismissAfterMs?: number };
/** Mount ONLY in an extension-owned trusted page. Secret input never uses UI state or public settings. */
export function SettingsApp({ rpc }: { rpc: UiRpc }) {
  const [section, setSection] = useState<Section>('languages');
  const [settings, setSettings] = useState<EditableSettings>({});
  const [decks, setDecks] = useState<string[]>([]);
  const [notification, setNotification] = useState<SettingsNotification | null>(null);
  const notificationId = useRef(0);
  useEffect(() => {
    if (!notification?.dismissAfterMs) return;
    const timer = window.setTimeout(() => {
      setNotification(current => current?.id === notification.id ? null : current);
    }, notification.dismissAfterMs);
    return () => window.clearTimeout(timer);
  }, [notification]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [modelsConsent, setModelsConsent] = useState(false);
  const [grammarModelsConsent, setGrammarModelsConsent] = useState(false);
  const grammarSetupInFlight = useRef(false);
  const [legacyModelsConsent, setLegacyModelsConsent] = useState(false);
  const [persist, setPersist] = useState(false);
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [persistAnki, setPersistAnki] = useState(false);
  const [isTestEndpoint, setIsTestEndpoint] = useState(false);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [repairAcknowledged, setRepairAcknowledged] = useState(false);
  const [ankiCheck, setAnkiCheck] = useState<AnkiCheckState>({ state: 'idle' });
  const ankiCheckInFlight = useRef(false);
  const repairRequired = warnings.includes('SETTINGS_REPAIR_REQUIRED');
  const queueReviewRequired = warnings.includes('ANKI_QUEUE_REVIEW_REQUIRED');
  function notify(kind: SettingsNotification['kind'], message: string, dismissAfterMs?: number) {
    // A new identity also announces an identical result from a repeated action.
    setNotification({ id: ++notificationId.current, kind, message, dismissAfterMs });
  }
  function applyWarnings(data: unknown) { setWarnings(getRpcWarnings(data)); setRepairAcknowledged(false); }
  async function updateSettings(payload: Record<string, unknown>) { const result = await rpc<PublicSettings>('settings.update', payload); applyWarnings(result); return result; }
  useEffect(() => { let live = true; setReady(false); setLoading(true); notify('progress', 'Загрузка настроек…'); rpc<PublicSettings>('settings.getPublic').then(s => { if (live) { setReady(true); setNotification(null); applyWarnings(s); setHasOpenAIKey(s.hasOpenAIKey === true); setIsTestEndpoint(s.ankiEndpoint === 'http://127.0.0.1:18765'); const {sourceLanguage, targetLanguage, dialect} = lookupPreferences(s); setSettings({ sourceLanguage, targetLanguage, dialect, defaultDeck: s.defaultDeck ?? '', defaultMode: s.defaultMode ?? 'recognition', dictionaryEnabled: s.dictionaryEnabled ?? false, cloudAudioEnabled: s.cloudAudioEnabled ?? false, includeAudioByDefault: s.includeAudioByDefault ?? false, ...(s.ankiEndpoint === 'http://127.0.0.1:18765' ? {} : { ankiEndpoint: s.ankiEndpoint ?? 'http://127.0.0.1:8765' }), audioSpeed: s.audioSpeed ?? 1, grammarEnabled:s.grammarEnabled??false,grammarIncludeExplanation:s.grammarIncludeExplanation??true,grammarExplanationLanguage:s.grammarExplanationLanguage??s.targetLanguage??'ru',grammarDeck:s.grammarDeck??'' }); } }).catch(e => { if (live) { setReady(false); notify('error', errorText(e)); } }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [rpc, reload]);
  async function run(action: () => Promise<unknown>, success: string, progress = 'Выполняем действие…', dismissSuccessAfterMs?: number) {
    if (busy || !ready) return; setBusy(true); notify('progress', progress);
    try { await action(); notify('success', success, dismissSuccessAfterMs); } catch (e) { notify('error', errorText(e)); } finally { setBusy(false); }
  }
  async function checkAnki() {
    if (busy || !ready || repairRequired || ankiCheckInFlight.current) return;
    ankiCheckInFlight.current = true;
    setAnkiCheck({ state: 'checking' });
    try {
      await run(async () => {
        try {
          const result = await rpc<{ deckNames?: string[] }>('anki.configuration');
          const names = result.deckNames ?? [];
          setDecks(names);
          setAnkiCheck({ state: 'success', deckCount: names.length });
        } catch (error) {
          setAnkiCheck({ state: 'error', message: errorText(error) });
          throw error;
        }
      }, 'Соединение с Anki проверено. Список колод обновлён.', 'Проверяем Anki и получаем колоды…');
    } finally { ankiCheckInFlight.current = false; }
  }
  async function prepareGrammarModel() {
    if (busy || !ready || repairRequired || !grammarModelsConsent || grammarSetupInFlight.current) return;
    grammarSetupInFlight.current = true;
    try {
      await run(async () => {
        try { await rpc('grammar.initializeModel'); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ANKI_SCHEMA_MISMATCH') {
            throw new Error('Не удалось подтвердить совместимость типа грамматики. Проверьте AnkiConnect и тип LanguageReader.Grammar.v2: существующий несовместимый тип не перезаписывается. Повторное добавление без исправления не поможет.');
          }
          throw error;
        }
      }, 'Совместимый тип грамматики подготовлен. Вернитесь к открытой карточке и повторите добавление.', 'Проверяем и подготавливаем тип грамматики…');
    } finally { grammarSetupInFlight.current = false; }
  }
  const update = (patch: Partial<EditableSettings>) => { if ('ankiEndpoint' in patch) setRepairAcknowledged(false); setSettings(s => ({ ...s, ...patch })); };
  return <main className="page settings-page">
    <aside className="settings-sidebar">
      <strong>Language Reader for Anki</strong><h1>Настройки</h1>
      <nav aria-label="Разделы настроек">{(Object.keys(sections) as Section[]).map(id =>
        <button key={id} aria-current={id === section ? 'page' : undefined} onClick={() => setSection(id)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={navIcons[id]} /></svg>{sections[id]}
        </button>)}</nav>
    </aside>
    <div className="settings-content stack"><h2>{sections[section]}</h2>
    <div className="settings-notifications">
      <div className={notification ? `settings-notification ${notification.kind}` : undefined} data-compact={notification?.dismissAfterMs ? true : undefined}>
        {/* Keep announcement regions mounted; only one contains each result. */}
        <div className="settings-notification-message" tabIndex={notification ? 0 : undefined}>
          <div role="status" aria-live="polite" aria-atomic="true">{notification && notification.kind !== 'error' && <span key={notification.id}>{notification.message}</span>}</div>
          <div role="alert" aria-atomic="true">{notification?.kind === 'error' && <span key={notification.id}>{notification.message}</span>}</div>
        </div>
        {notification && <button type="button" aria-label="Закрыть уведомление" title="Закрыть уведомление" onClick={() => setNotification(null)}>
          <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 3l10 10M13 3 3 13"/></svg>
        </button>}
      </div>
    </div>
    {!loading && !ready && <button onClick={() => setReload(value => value + 1)}>Повторить загрузку настроек</button>}
    <fieldset hidden={section !== 'openai'} disabled={busy || !ready}><legend>Ключ OpenAI API</legend><p>Вставьте ключ API и нажмите «Сохранить ключ».</p><p>Перевод отправляет в OpenAI выбранное выражение и небольшой контекст (не более 1500 символов UTF-16), не книгу целиком. API OpenAI оплачивается отдельно от подписки ChatGPT.</p>

      <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const input = form.elements.namedItem('openai-key') as HTMLInputElement; const key = input.value.trim(); if (!key) return; input.value = ''; void run(async () => { await rpc('secrets.setOpenAIKey', { key, persist }); setHasOpenAIKey(true); }, 'Ключ сохранён. Теперь можно проверить подключение.'); }}>
        <p className="badge">{hasOpenAIKey === null ? 'Проверяем наличие ключа…' : hasOpenAIKey ? 'Ключ настроен (значение скрыто)' : 'Ключ не настроен'}</p><label>Ключ OpenAI API<input name="openai-key" type="password" autoComplete="off" spellCheck={false} aria-describedby="key-hint" /></label>
        <p id="key-hint" className="muted">По умолчанию ключ хранится только в текущей сессии браузера. Не вставляйте ключ в страницу книги или в чат.</p>
        <label className="check"><input type="checkbox" checked={persist} onChange={e => setPersist(e.target.checked)} />Сохранять ключ локально между перезапусками. Это не криптографически защищённое хранилище.</label>
        <div className="row"><button type="submit">Сохранить ключ</button><button type="button" onClick={() => void run(async () => { await rpc('secrets.clearOpenAIKey'); setHasOpenAIKey(false); }, 'Ключ удалён.')}>Удалить ключ</button><button type="button" disabled={busy || !hasOpenAIKey} onClick={() => void run(async () => { const r = await rpc<{ ok: boolean; error: { message: string } | null }>('providers.test', { provider: 'openai', allowPaidTest: false }); if (!r.ok) throw new Error(r.error?.message ?? 'OpenAI недоступен.'); }, 'Диагностика OpenAI завершена без платного тестового перевода.')}>Проверить подключение</button></div><p className="muted">Проверка подключения не запускает платный перевод. Сохранение ключа само по себе не отправляет запрос в OpenAI.</p>
      </form>
    </fieldset>
    <fieldset hidden={section !== 'anki'} disabled={busy || !ready}><legend>Подключение Anki</legend><p>Установите Anki для компьютера и дополнение AnkiConnect. Anki должен быть открыт. Расширение подключается только к локальному AnkiConnect.</p>
      <label>Адрес локального AnkiConnect<select disabled={isTestEndpoint} value={isTestEndpoint ? 'http://127.0.0.1:18765' : settings.ankiEndpoint ?? 'http://127.0.0.1:8765'} onChange={e => update({ ankiEndpoint: e.target.value as NonNullable<SettingsPatch['ankiEndpoint']> })}>{isTestEndpoint && <option value="http://127.0.0.1:18765">127.0.0.1:18765 — только тестовый режим</option>}<option value="http://127.0.0.1:8765">127.0.0.1:8765</option><option value="http://localhost:8765">localhost:8765</option></select></label>{isTestEndpoint && <p className="status" role="status">Тестовый режим: используется изолированный AnkiConnect 127.0.0.1:18765. Адрес доступен только для чтения; сохранение настроек не изменяет рабочий адрес Anki.</p>}<small>После изменения адреса сохраните настройки перед проверкой соединения.</small>
      <details><summary>Ключ AnkiConnect (если настроен в дополнении)</summary>
        <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('anki-key') as HTMLInputElement; const key = input.value.trim(); if (!key) return; input.value = ''; void run(() => updateSettings({ patch: {}, ankiKey: key, persistAnkiKey: persistAnki }), 'Ключ AnkiConnect сохранён.'); }}>
          <label>Ключ API AnkiConnect<input name="anki-key" type="password" autoComplete="off" spellCheck={false} /></label>
          <p className="muted">Нужен только если вы задали apiKey в AnkiConnect. Ключ не отображается повторно и по умолчанию хранится в сессии браузера.</p>
          <label className="check"><input type="checkbox" checked={persistAnki} onChange={e => setPersistAnki(e.target.checked)} />Сохранять ключ AnkiConnect между перезапусками (локально, без криптографической защиты).</label>
          <div className="row"><button type="submit">Сохранить ключ AnkiConnect</button><button type="button" onClick={() => void run(() => updateSettings({ patch: {}, ankiKey: null }), 'Ключ AnkiConnect удалён.')}>Удалить ключ AnkiConnect</button></div>
        </form>
      </details>
      <button disabled={repairRequired || ankiCheck.state === 'checking'} aria-busy={ankiCheck.state === 'checking'} onClick={() => void checkAnki()}>Проверить Anki и получить колоды</button>
      {ankiCheck.state === 'checking' && <p className="status">Проверяем Anki и получаем колоды…</p>}
      {ankiCheck.state === 'success' && <p className="status">Соединение с Anki проверено. Колод получено: {ankiCheck.deckCount}. Выберите колоду в поле ниже.</p>}
      {ankiCheck.state === 'error' && <p className="status error">{ankiCheck.message}</p>}
      <label>Колода<input list="reader-decks" value={settings.defaultDeck ?? ''} placeholder="English::Reading" onChange={e => update({ defaultDeck: e.target.value })} /><datalist id="reader-decks">{decks.map(d => <option key={d} value={d} />)}</datalist></label><small>English::Reading — предлагаемое имя, колода не создаётся молча.</small>
      <label>Тип заметки по умолчанию<select value={settings.defaultMode ?? 'recognition'} onChange={e => update({ defaultMode: e.target.value as 'recognition' | 'cloze' })}><option value="recognition">Узнавание</option><option value="cloze">Пропуск (c1)</option></select></label>
      <label className="check"><input type="checkbox" checked={modelsConsent} onChange={e => setModelsConsent(e.target.checked)} />Разрешаю создать многоязычные типы LanguageReader.Recognition.v2 и LanguageReader.Cloze.v2. Старые заметки EnglishReader остаются без изменений. Существующая конфликтующая схема не должна изменяться автоматически.</label>
      <button disabled={!modelsConsent || busy || repairRequired} onClick={() => void run(() => rpc('anki.initializeModels', { modelVersion: 2 }), 'Многоязычные типы заметок v2 подготовлены.')}>Создать собственные типы заметок</button>
      <details className="anki-legacy-recovery"><summary>Восстановление типов v1 для старой очереди</summary>
        <p>Только для ранее сохранённых операций EnglishReader (английский → русский). Новые многоязычные заметки используют типы v2 выше. Эта настройка не меняет старые заметки, не преобразует сохранённые операции и не отправляет очередь автоматически.</p>
        <label className="check"><input type="checkbox" checked={legacyModelsConsent} onChange={e => setLegacyModelsConsent(e.target.checked)} />Отдельно разрешаю создать отсутствующие прежние типы EnglishReader.Recognition.v1 и EnglishReader.Cloze.v1 для старой очереди. Существующие конфликтующие схемы должны остаться без изменений.</label>
        <button disabled={!legacyModelsConsent || busy || repairRequired} onClick={() => void run(() => rpc('anki.initializeModels', { modelVersion: 1 }), 'Прежние типы v1 подготовлены. Проверьте сохранённую очередь перед повторной отправкой.')}>Создать прежние типы v1 для старой очереди</button>
      </details>
      <button disabled={!settings.defaultDeck?.trim() || busy || repairRequired} onClick={() => void run(() => rpc('anki.createDeck', { deckName: settings.defaultDeck }), 'Колода создана.')}>Создать указанную колоду (явное действие)</button>
    </fieldset>
    <fieldset hidden={section !== 'languages'} disabled={busy || !ready}><legend>Перевод</legend>
      <div className="row"><label className="inline-field">Язык текста<select value={settings.sourceLanguage ?? 'en'} onChange={e => { const language = e.target.value as LanguageCode; update({ sourceLanguage: language, dialect: defaultLocale(language) }); }}>{LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label><label className="inline-field">Язык перевода<select value={settings.targetLanguage ?? 'ru'} onChange={e => update({ targetLanguage: e.target.value as LanguageCode })}>{LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label></div>
      {settings.sourceLanguage === settings.targetLanguage && <p className="status">Одноязычный режим изучения: объяснения, перефразирование и примеры на изучаемом языке.</p>}
      {(settings.sourceLanguage === 'zh' || settings.targetLanguage === 'zh') && <p className="muted">Китайский: стандартный мандаринский, упрощённая письменность; для произношения выбран zh-CN.</p>}
      {(settings.sourceLanguage === 'ar' || settings.targetLanguage === 'ar') && <p className="muted">Арабский: современный литературный арабский (MSA), не региональный разговорный диалект. Для системного голоса используется локаль ar-SA.</p>}
      {(settings.sourceLanguage ?? 'en') === 'en' && <label className="settings-half">Произношение английского<select value={settings.dialect ?? 'en-US'} onChange={e => update({ dialect: e.target.value as 'en-US' | 'en-GB' })}><option value="en-US">Американский английский</option><option value="en-GB">Британский английский</option></select></label>}
    </fieldset>
    <fieldset hidden={section !== 'services'} disabled={busy || !ready}><legend>Голос и дополнительные источники</legend>
      <p className="muted">Модель перевода и карточек: GPT-6 Luna (gpt-6-luna). Перевод и примеры используют reasoning none; явное уточнение — low. При недоступности модели автоматической замены нет. Облачное аудио использует отдельную модель.</p>
      <label className="check"><input type="checkbox" checked={!!settings.dictionaryEnabled} onChange={e => update({ dictionaryEnabled: e.target.checked })} />Разрешить dictionaryapi.dev получать выбранное слово для словарной транскрипции английского. Для других языков этот источник не используется. Сервис необязательный.</label>
      <label className="check"><input type="checkbox" checked={!!settings.cloudAudioEnabled} onChange={e => update({ cloudAudioEnabled: e.target.checked })} />Разрешить платное облачное аудио OpenAI (gpt-4o-mini-tts) только по явному платному действию.</label>
      <label>Скорость облачного аудио<input type="number" min="0.25" max="4" step="0.25" value={settings.audioSpeed ?? 1} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value)) update({ audioSpeed: Math.min(4, Math.max(0.25, value)) }); }} /></label>
      <p className="muted">В окне перевода флажок «Создать аудиофайл» всегда выключен сначала: его включение сразу отправляет платный запрос. Старая настройка аудио по умолчанию больше не включает его автоматически. Готовый файл можно прослушать до добавления; в Anki будет сохранён тот же файл.</p><p className="muted">Кнопка рядом с крестиком в окне перевода произносит выражение системным голосом. Наличие голоса не гарантируется; системное прослушивание не создаёт аудиофайл для Anki. При отсутствии подходящего голоса произношение будет недоступно, без подмены другим языком.</p>
    </fieldset>
    <fieldset hidden={section !== 'languages'} disabled={busy || !ready}><legend>Разбор и языковой чат</legend>
      <label className="settings-switch">
        <span>{languageFeatureLabel}</span>
        <input type="checkbox" checked={!!settings.grammarEnabled} aria-describedby="grammar-consent-hint" onChange={e => update({grammarEnabled:e.target.checked})} />
      </label>
      <p className="muted" id="grammar-consent-hint">{settings.grammarEnabled
        ? 'После сохранения нажмите и отпустите левый Alt без других клавиш, чтобы запустить разбор и открыть из него языковой чат.'
        : 'Разбор и чат выключены.'} {grammarRequestCost} {languageChatCost}</p>
      <div className="row">
        <label className="inline-field">Язык объяснений и ответов чата<select value={settings.grammarExplanationLanguage??settings.targetLanguage??'ru'} onChange={e => update({grammarExplanationLanguage:e.target.value as LanguageCode})}>{LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label>
        <label className="inline-field">Отдельная колода грамматики<input list="reader-decks" value={settings.grammarDeck??''} onChange={e => update({grammarDeck:e.target.value})} placeholder="Основная колода" /></label>
      </div>
      <label className="settings-switch"><span>Добавлять пример или сравнение в подробный разбор</span><input type="checkbox" name="grammarIncludeExplanation" checked={settings.grammarIncludeExplanation!==false} onChange={e => update({grammarIncludeExplanation:e.target.checked})} /></label>
      <details><summary>Тип заметки для грамматики</summary>
      <label className="check"><input type="checkbox" checked={grammarModelsConsent} onChange={e => setGrammarModelsConsent(e.target.checked)} />Разрешаю создать отдельный тип LanguageReader.Grammar.v2, если совместимого типа ещё нет. Совместимый LanguageReader.Grammar.v1 используется без изменений; несовместимые типы и существующие карточки не изменяются.</label>
      <button disabled={!grammarModelsConsent||busy||repairRequired} onClick={() => void prepareGrammarModel()}>Подготовить тип грамматики</button>
      </details>
    </fieldset>
    {repairRequired && <section className="status error" role="alert"><h2>Нужно восстановить настройки AnkiConnect</h2><p>Сохранённый адрес больше не поддерживается. Показанный выше адрес — только вариант для исправления, а не активное подключение. До подтверждения диагностика и создание в Anki отключены.</p><label className="check"><input type="checkbox" checked={repairAcknowledged} onChange={e => setRepairAcknowledged(e.target.checked)} />Я проверил выбранный адрес AnkiConnect и подтверждаю его сохранение как рабочего адреса.</label></section>}
    {queueReviewRequired && <p className="status" role="alert">Старые операции Anki требуют проверки в очереди. Исправление настроек не переносит и не отправляет их автоматически. Просмотрите сохранённые заметки перед отменой или дальнейшими действиями.</p>}
    <div className="settings-footer row between"><small>Изменения применятся после сохранения.</small><button className="primary" disabled={busy || !ready || (repairRequired && !repairAcknowledged)} onClick={() => void run(() => updateSettings({ patch: { ...settings, defaultDeck: settings.defaultDeck?.trim() || undefined } }), 'Настройки сохранены.', 'Сохраняем настройки…', 2000)}>Сохранить настройки</button></div>
    <details hidden={section !== 'services'}><summary>Как читать и хранить данные</summary><p>Импорт PDF/EPUB сохраняет файл только в этом браузере. OCR, DRM и fixed-layout EPUB не поддерживаются. Локальные ссылки на книги могут не открываться на другом устройстве.</p><p>Очередь — это ещё не подтверждённое добавление в Anki. Проверяйте её статус после восстановления связи. Очистка кэша не должна удалять очередь или библиотеку.</p><p>Не удаляйте данные расширения без резервной копии Anki и исходных файлов книг.</p></details>
    </div>
  </main>;
}
