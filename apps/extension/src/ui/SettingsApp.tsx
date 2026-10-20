import React, { useEffect, useState } from 'react';
import type { SettingsPatch, PublicSettings } from '@english-reader/contracts';
import { errorText, type UiRpc } from './interfaces';

type EditableSettings = SettingsPatch;
/** Mount ONLY in an extension-owned trusted page. Secret input never uses UI state or public settings. */
export function SettingsApp({ rpc }: { rpc: UiRpc }) {
  const [settings, setSettings] = useState<EditableSettings>({});
  const [decks, setDecks] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelsConsent, setModelsConsent] = useState(false);
  const [persist, setPersist] = useState(false);
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [persistAnki, setPersistAnki] = useState(false);
  const [isTestEndpoint, setIsTestEndpoint] = useState(false);
  useEffect(() => { let live = true; rpc<PublicSettings>('settings.getPublic').then(s => { if (live) { setHasOpenAIKey(s.hasOpenAIKey === true); setIsTestEndpoint(s.ankiEndpoint === 'http://127.0.0.1:18765'); setSettings({ defaultDeck: s.defaultDeck ?? '', defaultMode: s.defaultMode ?? 'recognition', dialect: s.dialect ?? 'en-US', dictionaryEnabled: s.dictionaryEnabled ?? false, cloudAudioEnabled: s.cloudAudioEnabled ?? false, includeAudioByDefault: s.includeAudioByDefault ?? false, ...(s.ankiEndpoint === 'http://127.0.0.1:18765' ? {} : { ankiEndpoint: s.ankiEndpoint ?? 'http://127.0.0.1:8765' }), audioSpeed: s.audioSpeed ?? 1 }); } }).catch(e => live && setError(errorText(e))); return () => { live = false; }; }, [rpc]);
  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return; setBusy(true); setError(''); setStatus('');
    try { await action(); setStatus(success); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const update = (patch: Partial<EditableSettings>) => setSettings(s => ({ ...s, ...patch }));
  return <main className="page stack"><header><p className="muted">ENGLISH READER FOR ANKI</p><h1>Настройка чтения</h1><p>Выберите слово или выражение до пяти слов и нажмите Shift. Escape закрывает перевод. Наведение само по себе ничего не отправляет.</p></header>
    {error && <p className="status error" role="alert">{error}</p>}{status && <p className="status" role="status">{status}</p>}
    <fieldset disabled={busy}><legend>1. Подключение OpenAI</legend><p>Вставьте ключ API и нажмите «Сохранить ключ».</p><p>Перевод отправляет в OpenAI выбранное выражение и небольшой контекст (не более 1500 символов UTF-16), не книгу целиком. API OpenAI оплачивается отдельно от подписки ChatGPT.</p>

      <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const input = form.elements.namedItem('openai-key') as HTMLInputElement; const key = input.value.trim(); if (!key) return; input.value = ''; void run(async () => { await rpc('secrets.setOpenAIKey', { key, persist }); setHasOpenAIKey(true); }, 'Ключ сохранён. Теперь можно проверить подключение.'); }}>
        <p role="status" className="badge">{hasOpenAIKey === null ? 'Проверяем наличие ключа…' : hasOpenAIKey ? 'Ключ настроен (значение скрыто)' : 'Ключ не настроен'}</p><label>Ключ OpenAI API<input name="openai-key" type="password" autoComplete="off" spellCheck={false} aria-describedby="key-hint" /></label>
        <p id="key-hint" className="muted">По умолчанию ключ хранится только в текущей сессии браузера. Не вставляйте ключ в страницу книги или в чат.</p>
        <label className="check"><input type="checkbox" checked={persist} onChange={e => setPersist(e.target.checked)} />Сохранять ключ локально между перезапусками. Это не криптографически защищённое хранилище.</label>
        <div className="row"><button type="submit">Сохранить ключ</button><button type="button" onClick={() => void run(async () => { await rpc('secrets.clearOpenAIKey'); setHasOpenAIKey(false); }, 'Ключ удалён.')}>Удалить ключ</button><button type="button" disabled={busy || !hasOpenAIKey} onClick={() => void run(async () => { const r = await rpc<{ ok: boolean; error: { message: string } | null }>('providers.test', { provider: 'openai', allowPaidTest: false }); if (!r.ok) throw new Error(r.error?.message ?? 'OpenAI недоступен.'); }, 'Диагностика OpenAI завершена без платного тестового перевода.')}>Проверить подключение</button></div><p className="muted">Проверка подключения не запускает платный перевод. Сохранение ключа само по себе не отправляет запрос в OpenAI.</p>
      </form>
    </fieldset>
    <fieldset disabled={busy}><legend>2. Anki и колода</legend><p>Установите Anki для компьютера и дополнение AnkiConnect. Anki должен быть открыт. Расширение подключается только к локальному AnkiConnect.</p>
      <label>Адрес локального AnkiConnect<select disabled={isTestEndpoint} value={isTestEndpoint ? 'http://127.0.0.1:18765' : settings.ankiEndpoint ?? 'http://127.0.0.1:8765'} onChange={e => update({ ankiEndpoint: e.target.value as NonNullable<SettingsPatch['ankiEndpoint']> })}>{isTestEndpoint && <option value="http://127.0.0.1:18765">127.0.0.1:18765 — только тестовый режим</option>}<option value="http://127.0.0.1:8765">127.0.0.1:8765</option><option value="http://localhost:8765">localhost:8765</option><option value="http://[::1]:8765">[::1]:8765</option></select></label>{isTestEndpoint && <p className="status" role="status">Тестовый режим: используется изолированный AnkiConnect 127.0.0.1:18765. Адрес доступен только для чтения; сохранение настроек не изменяет рабочий адрес Anki.</p>}<small>После изменения адреса сохраните настройки перед проверкой соединения.</small>
      <details><summary>Ключ AnkiConnect (если настроен в дополнении)</summary>
        <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('anki-key') as HTMLInputElement; const key = input.value.trim(); if (!key) return; input.value = ''; void run(() => rpc('settings.update', { patch: {}, ankiKey: key, persistAnkiKey: persistAnki }), 'Ключ AnkiConnect сохранён.'); }}>
          <label>Ключ API AnkiConnect<input name="anki-key" type="password" autoComplete="off" spellCheck={false} /></label>
          <p className="muted">Нужен только если вы задали apiKey в AnkiConnect. Ключ не отображается повторно и по умолчанию хранится в сессии браузера.</p>
          <label className="check"><input type="checkbox" checked={persistAnki} onChange={e => setPersistAnki(e.target.checked)} />Сохранять ключ AnkiConnect между перезапусками (локально, без криптографической защиты).</label>
          <div className="row"><button type="submit">Сохранить ключ AnkiConnect</button><button type="button" onClick={() => void run(() => rpc('settings.update', { patch: {}, ankiKey: null }), 'Ключ AnkiConnect удалён.')}>Удалить ключ AnkiConnect</button></div>
        </form>
      </details>
      <button onClick={() => void run(async () => { const r = await rpc<{ deckNames?: string[] }>('anki.configuration'); setDecks(r.deckNames ?? []); }, 'Соединение с Anki проверено. Список колод обновлён.')}>Проверить Anki и получить колоды</button>
      <label>Колода<input list="reader-decks" value={settings.defaultDeck ?? ''} placeholder="English::Reading" onChange={e => update({ defaultDeck: e.target.value })} /><datalist id="reader-decks">{decks.map(d => <option key={d} value={d} />)}</datalist></label><small>English::Reading — предлагаемое имя, колода не создаётся молча.</small>
      <label>Тип заметки по умолчанию<select value={settings.defaultMode ?? 'recognition'} onChange={e => update({ defaultMode: e.target.value as 'recognition' | 'cloze' })}><option value="recognition">Узнавание</option><option value="cloze">Пропуск (c1)</option></select></label>
      <label className="check"><input type="checkbox" checked={modelsConsent} onChange={e => setModelsConsent(e.target.checked)} />Разрешаю создать типы EnglishReader.Recognition.v1 и EnglishReader.Cloze.v1. Существующая конфликтующая схема не должна изменяться автоматически.</label>
      <button disabled={!modelsConsent || busy} onClick={() => void run(() => rpc('anki.initializeModels', {}), 'Типы заметок подготовлены.')}>Создать собственные типы заметок</button>
      <button disabled={!settings.defaultDeck?.trim() || busy} onClick={() => void run(() => rpc('anki.createDeck', { deckName: settings.defaultDeck }), 'Колода создана.')}>Создать указанную колоду (явное действие)</button>
    </fieldset>
    <fieldset disabled={busy}><legend>3. Произношение и дополнительные сервисы</legend>
      <label>Диалект<select value={settings.dialect ?? 'en-US'} onChange={e => update({ dialect: e.target.value as 'en-US' | 'en-GB' })}><option value="en-US">Американский английский</option><option value="en-GB">Британский английский</option></select></label>
      <label className="check"><input type="checkbox" checked={!!settings.dictionaryEnabled} onChange={e => update({ dictionaryEnabled: e.target.checked })} />Разрешить dictionaryapi.dev получать выбранное слово для словарной транскрипции. Сервис необязательный.</label>
      <label className="check"><input type="checkbox" checked={!!settings.cloudAudioEnabled} onChange={e => update({ cloudAudioEnabled: e.target.checked })} />Разрешить платное облачное аудио OpenAI (gpt-4o-mini-tts) по явному действию или при сохранении с аудио.</label>
      <label>Скорость облачного аудио<input type="number" min="0.25" max="4" step="0.25" value={settings.audioSpeed ?? 1} onChange={e => { const value = e.target.valueAsNumber; if (Number.isFinite(value)) update({ audioSpeed: Math.min(4, Math.max(0.25, value)) }); }} /></label>
      <label className="check"><input type="checkbox" checked={!!settings.includeAudioByDefault} disabled={!settings.cloudAudioEnabled} onChange={e => update({ includeAudioByDefault: e.target.checked })} />Предлагать аудиофайл при сохранении заметки по умолчанию.</label><p className="muted">Быстрое прослушивание использует доступный системный голос. Наличие голоса не гарантируется; системное прослушивание не создаёт аудиофайл для Anki. Дополнительные объяснения: B1.</p>
    </fieldset>
    <div className="row"><button className="primary" disabled={busy} onClick={() => void run(() => rpc('settings.update', { patch: { ...settings, defaultDeck: settings.defaultDeck?.trim() || undefined } }), 'Настройки сохранены.')}>Сохранить настройки</button></div>
    <details><summary>Как читать и хранить данные</summary><p>Импорт PDF/EPUB сохраняет файл только в этом браузере. OCR, DRM и fixed-layout EPUB не поддерживаются. Локальные ссылки на книги могут не открываться на другом устройстве.</p><p>Очередь — это ещё не подтверждённое добавление в Anki. Проверяйте её статус после восстановления связи. Очистка кэша не должна удалять очередь или библиотеку.</p><p>Не удаляйте данные расширения без резервной копии Anki и исходных файлов книг.</p></details>
  </main>;
}
