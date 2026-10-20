import React, { useEffect, useRef, useState } from 'react';
import { getLanguage, senseDefinition, exampleText, exampleTranslation, validateNoteDraft } from '@english-reader/contracts';
import { lookupPreferences } from '../runtime/reader-preferences';
import type { LookupData, NoteDraft, MultilingualNoteDraft, ContextExample, PublicSettings, AddNoteData } from '@english-reader/contracts';
import { isTrustedUiEvent } from './user-actions';
import { errorText, type PopupOptions } from './interfaces';

type SaveResult = AddNoteData;
const saveLabels = { added: 'Добавлено в Anki', queued: 'Сохранено в очередь — ещё не добавлено в Anki', already_added: 'Эта операция уже добавлена в Anki', duplicate_review: 'Найдены возможные дубликаты. Проверьте перед добавлением.' };
const generatedPronunciation = (result: LookupData): NoteDraft['pronunciation'] => ({ ipa: result.ipaCandidate?.ipa ?? null, dialect: result.ipaCandidate?.dialect ?? 'unknown', source: result.ipaCandidate ? 'generated' : 'unavailable', sourceUrl: null });
export function HighlightedSentence({ draft }: { draft: NoteDraft }) {
  const { sentence, targetStart, targetEnd } = draft.context;
  return <p className="sentence" lang={draft.sourceLanguage} dir="auto">{sentence.slice(0, targetStart)}<mark>{sentence.slice(targetStart, targetEnd)}</mark>{sentence.slice(targetEnd)}</p>;
}
export function ReadingPopup({ options, close }: { options: PopupOptions; close: () => void }) {
  const { rpc, lookupPayload, source } = options;
  const [data, setData] = useState<LookupData | null>(null);
  const [draft, setDraft] = useState<MultilingualNoteDraft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('loading');
  const [destinationRefreshing, setDestinationRefreshing] = useState(false);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [senseChosen, setSenseChosen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [exampleCandidates, setExampleCandidates] = useState<ContextExample[]>([]);
  const senseRevision = useRef(0);
  const pronunciationRevision = useRef(0);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [audioAllowed, setAudioAllowed] = useState(false);
  const [decks, setDecks] = useState<string[]>([]);
  const generation = useRef(0);
  const operation = useRef(crypto.randomUUID());
  const saving = useRef(false);
  const actionPending = useRef(false);
  const submitted = useRef<{ draft: NoteDraft; includeAudio: boolean } | null>(null);
  const settingsHandoffPending = useRef(false);
  const destinationRefreshPending = useRef(false);
  const container = useRef<HTMLElement>(null);
  function loadPronunciation(lookupId: string, token: number) {
    const revision = ++pronunciationRevision.current;
    void rpc<{ pronunciation: NoteDraft['pronunciation'] }>('pronunciation.get', { lookupId }).then(result => {
      if (token !== generation.current || revision !== pronunciationRevision.current || submitted.current) return;
      setDraft(current => current && token === generation.current && revision === pronunciationRevision.current && !submitted.current ? { ...current, pronunciation: result.pronunciation } : current);
    }).catch(() => {});
  }
  useEffect(() => {
    const token = ++generation.current;
    let lookupId: string | undefined;
    setData(null); setDraft(null); setSaved(null); setError(''); setBusy('loading'); setEditing(false); setPreview(false); setExampleCandidates([]); senseRevision.current++; pronunciationRevision.current++;
    operation.current = crypto.randomUUID(); saving.current = false; actionPending.current = false; submitted.current = null; settingsHandoffPending.current = false; destinationRefreshPending.current = false; setDestinationRefreshing(false); setSenseChosen(false);
    const timer = setTimeout(() => { if (token === generation.current) { generation.current++; setBusy(''); setError('Перевод занял слишком много времени. Закройте окно и повторите запрос.'); } }, 25000);
    rpc<Partial<PublicSettings>>('settings.getReader').then(async settings => {
      if (token !== generation.current) return;
      const preferences = lookupPreferences(settings, lookupPayload);
      const result = await rpc<LookupData>('lookup', { ...lookupPayload, ...preferences });
      if (token !== generation.current) return;
      lookupId = result.lookupId;
      const sense = result.senses.find(s => s.id === result.recommendedSenseId) ?? result.senses[0];
      setData(result); setSenseChosen(!result.contextAmbiguous);
      setAudioAllowed(settings.cloudAudioEnabled === true); setIncludeAudio(settings.cloudAudioEnabled === true && settings.includeAudioByDefault === true);
      setDraft({ draftVersion: 2, sourceLanguage: preferences.sourceLanguage, targetLanguage: preferences.targetLanguage, learnerLevel: preferences.learnerLevel, mode: settings.defaultMode === 'cloze' ? 'cloze' : 'recognition', deckName: typeof settings.defaultDeck === 'string' ? settings.defaultDeck : '', tags: ['EnglishReader'], expression: result.expression, lemma: result.lemma, partOfSpeech: result.partOfSpeech, selectedSense: { id: sense.id, definition: senseDefinition(sense), translations: sense.translations.slice(0, 2) }, context: { sentence: lookupPayload.context.sentence, targetStart: lookupPayload.context.targetStart, targetEnd: lookupPayload.context.targetEnd }, pronunciation: generatedPronunciation(result), examples: [], source });
      setBusy('');
      loadPronunciation(result.lookupId, token);
    }).catch(err => { if (token === generation.current) { setError(errorText(err)); setBusy(''); } }).finally(() => clearTimeout(timer));
    if (options.trustedPage === true) rpc<{ deckNames?: string[] }>('anki.decks').then(r => { if (token === generation.current) setDecks(r.deckNames ?? []); }).catch(() => {});
    return () => { clearTimeout(timer); generation.current++; if (lookupId) void rpc('lookup.cancel', { lookupId }).catch(() => {}); };
  }, [rpc, lookupPayload, source, options.trustedPage]);
  useEffect(() => {
    const refreshDestination = (event: FocusEvent) => {
      if (!isTrustedUiEvent(event) || !settingsHandoffPending.current) return;
      settingsHandoffPending.current = false;
      // Once an add was attempted, never mutate its immutable destination, even on an uncertain response.
      if (submitted.current || saving.current) return;
      destinationRefreshPending.current = true; setDestinationRefreshing(true);
      const token = generation.current;
      void rpc<Partial<PublicSettings>>('settings.getReader').then(preferences => {
        if (token !== generation.current || submitted.current || saving.current) return;
        setDraft(current => current ? { ...current, deckName: preferences.defaultDeck ?? current.deckName } : current);
      }).catch(err => { if (token === generation.current && !submitted.current) { setError('Не удалось обновить колоду из настроек. Откройте настройки ещё раз.'); setDraft(current => current ? { ...current, deckName: '' } : current); } }).finally(() => { if (token === generation.current) { destinationRefreshPending.current = false; setDestinationRefreshing(false); } });
    };
    window.addEventListener('focus', refreshDestination);
    return () => window.removeEventListener('focus', refreshDestination);
  }, [rpc]);
  async function save(addNew = false) {
    if (!draft || !senseChosen || destinationRefreshPending.current || busy || saving.current || actionPending.current || saved?.status === 'added' || saved?.status === 'already_added' || saved?.status === 'queued') return;
    if (!draft.deckName.trim()) { setError('Выберите колоду или укажите её имя в настройках.'); return; }
    if (!draft.selectedSense.translations.some(t => t.trim())) { setError('Укажите перевод выбранного значения.'); return; }
    // Local validation is definite and precedes the first dispatch. Keep invalid edits recoverable;
    // once dispatched, even an error must retain the immutable operation snapshot for safe retry.
    if (!submitted.current) {
      try { validateNoteDraft(draft); }
      catch {
        setError(!draft.lemma.trim() ? 'Укажите лемму.' : !senseDefinition(draft.selectedSense).trim() ? 'Укажите определение выбранного значения.' : 'Проверьте поля заметки: пустые, слишком длинные или некорректные значения нельзя сохранить.');
        setEditing(true); return;
      }
    }
    saving.current = true; setBusy('saving'); setError('');
    const token = generation.current;
    try {
      if (!submitted.current) submitted.current = { draft, includeAudio };
      const result = await rpc<SaveResult>('anki.addNote', { operationId: operation.current, ...submitted.current, duplicateAction: addNew ? 'add_new' : 'review' });
      if (token === generation.current) setSaved(result);
    } catch (err) { if (token === generation.current) setError(errorText(err)); }
    finally { if (token === generation.current) { saving.current = false; setBusy(''); } }
  }
  async function action(type: string, payload: Record<string, unknown>, onResult?: (value: any) => void) {
    if (busy || saving.current || actionPending.current) return;
    actionPending.current = true;
    const token = generation.current; setBusy(type.startsWith('audio') ? 'audio_loading' : 'loading'); setError('');
    try { const result = await rpc(type, payload); if (token === generation.current) onResult?.(result); }
    catch (err) { if (token === generation.current) setError(errorText(err)); }
    finally { if (token === generation.current) { actionPending.current = false; setBusy(''); } }
  }
  useEffect(() => {
    const element = container.current;
    function key(event: KeyboardEvent) {
      if (!isTrustedUiEvent(event) || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Enter' || event.repeat || event.altKey || event.metaKey || event.isComposing) return;
      const target = event.composedPath()[0] as HTMLElement;
      const field = target?.matches('input,textarea,select,button,summary,a,[contenteditable=true]');
      if ((event.ctrlKey && editing) || (!field && !editing && !event.ctrlKey)) { event.preventDefault(); void save(); }
    }
    element?.addEventListener('keydown', key);
    return () => element?.removeEventListener('keydown', key);
  });
  const saveDisabled = destinationRefreshing || !!busy || saved?.status === 'added' || saved?.status === 'already_added' || saved?.status === 'queued' || saved?.status === 'duplicate_review';
  const immutable = saveDisabled || submitted.current !== null;
  const edit = (change: Partial<MultilingualNoteDraft>) => { if (immutable || submitted.current) return; setDraft(d => d ? { ...d, ...change } : d); setSaved(null); };
  let rendered: { front: string; back: string } | undefined;
  if (preview && draft && options.renderPreview) { try { rendered = options.renderPreview(draft); } catch { /* Render failures are visible below. */ } }
  function guardUserAction(event: React.SyntheticEvent) {
    if (!isTrustedUiEvent(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); }
  }
  return <section onClickCapture={guardUserAction} onInputCapture={guardUserAction} onChangeCapture={guardUserAction} onKeyDownCapture={guardUserAction} ref={container} role="dialog" aria-modal="false" aria-label="Контекстный перевод" tabIndex={-1} className="panel popup stack">
    <header className="row between"><div><strong lang={draft?.sourceLanguage ?? lookupPayload.sourceLanguage} dir="auto">{draft?.expression ?? lookupPayload.expression}</strong> <small>{draft?.partOfSpeech}</small></div><div className="row"><button aria-label="Прослушать выражение системным голосом" disabled={!draft || !!busy} onClick={() => void action('audio.play', { lookupId: data?.lookupId })}>▶</button><button aria-label="Закрыть перевод" onClick={close}>×</button></div></header>
    {busy === 'loading' && !draft && <p role="status">Переводим в контексте…</p>}
    {error && <p role="alert" className="status error">{error}</p>}
    {draft && <>
      <p className="muted">{getLanguage(draft.sourceLanguage).name} → {getLanguage(draft.targetLanguage).name} · {draft.learnerLevel}</p>
      <p className="muted">{draft.pronunciation.ipa ? `${draft.pronunciation.source === 'generated' ? '≈ ' : ''}${draft.pronunciation.ipa} · ${draft.pronunciation.source === 'dictionary' ? 'словарь' : 'сгенерировано ИИ'}` : senseChosen ? 'Транскрипция недоступна для выбранного значения' : 'Транскрипция недоступна'}</p>
      {data?.contextAmbiguous && <p className="status" role="status">Контекст неоднозначен. Выберите подходящее значение.</p>}
      <p className="translation" lang={draft.targetLanguage} dir="auto">{senseChosen ? draft.selectedSense.translations.join('; ') : 'Значение пока не выбрано'}</p>
      <HighlightedSentence draft={draft} />
      <details open={!senseChosen}><summary>Другие значения ({data?.senses.length ?? 0})</summary>{data?.senses.map(sense => <label className="check" key={sense.id}><input type="radio" name="sense" checked={senseChosen && draft.selectedSense.id === sense.id} disabled={immutable} onChange={() => { senseRevision.current++; pronunciationRevision.current++; setExampleCandidates([]); setSenseChosen(true); edit({ selectedSense: { id: sense.id, definition: senseDefinition(sense), translations: sense.translations.slice(0, 2) }, pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null }, examples: [] }); }} /><span><span lang={draft.targetLanguage} dir="auto">{sense.translations.join('; ')}</span><small lang={draft.sourceLanguage} dir="auto" style={{ display: 'block' }}>{senseDefinition(sense)}</small></span></label>)}</details>
      {senseChosen && <details><summary>Определение на языке текста</summary><p lang={draft.sourceLanguage} dir="auto">{senseDefinition(draft.selectedSense)}</p></details>}
      {exampleCandidates.length > 0 && <fieldset disabled={immutable}><legend>Примеры использования — выберите для заметки</legend><p className="muted">Создано ИИ. Примеры необязательны и попадут только на обратную сторону. Выбрано: {draft.examples.length} из {exampleCandidates.length}.</p>{exampleCandidates.map((example, index) => <label className="check" key={`${index}:${example.text}`}><input type="checkbox" checked={draft.examples.includes(example)} onChange={event => edit({ examples: event.target.checked ? [...draft.examples, example].slice(0, 3) : draft.examples.filter(selected => selected !== example) })} /><span><span lang={draft.sourceLanguage} dir="auto" style={{ display: 'block' }}>{example.text}</span><small lang={draft.targetLanguage} dir="auto" style={{ display: 'block' }}>{example.translation}</small></span></label>)}</fieldset>}
      {editing && <fieldset disabled={immutable}><legend>Редактирование выбранного значения</legend><label>Перевод (до двух, через точку с запятой)<input lang={draft.targetLanguage} dir="auto" value={draft.selectedSense.translations.join('; ')} onChange={e => edit({ selectedSense: { ...draft.selectedSense, translations: e.target.value.split(';').slice(0, 2) } })} /></label><label>Лемма<input lang={draft.sourceLanguage} dir="auto" value={draft.lemma} onChange={e => edit({ lemma: e.target.value })} /></label><label>Определение на языке текста<textarea lang={draft.sourceLanguage} dir="auto" value={senseDefinition(draft.selectedSense)} onChange={e => edit({ selectedSense: { ...draft.selectedSense, definition: e.target.value } })} /></label><small>Исходное предложение и выбранный диапазон сохраняются без изменений. Ctrl+Enter — сохранить.</small></fieldset>}
      {error && submitted.current && !saved && <p className="muted">Запрос на сохранение уже отправлен. Повтор использует тот же снимок и идентификатор операции; редактирование заблокировано. При неизвестном результате проверьте очередь и исходную колоду Anki перед новым добавлением.</p>}
      <div className="row"><button className="primary" disabled={saveDisabled || !senseChosen} onClick={() => void save()}>{busy === 'saving' ? 'Сохраняем…' : submitted.current && !saved ? 'Повторить сохранение' : 'Добавить в Anki'}</button><button disabled={immutable || !senseChosen} onClick={() => setEditing(!editing)}>{editing ? 'Готово' : 'Редактировать'}</button><button disabled={!senseChosen} onClick={() => setPreview(!preview)}>Предпросмотр</button></div>
      {preview && (rendered ? <div className="stack"><span>Лицевая сторона</span><iframe className="preview" sandbox="" title="Предпросмотр лицевой стороны" srcDoc={rendered.front} /><span>Обратная сторона</span><iframe className="preview" sandbox="" title="Предпросмотр обратной стороны" srcDoc={rendered.back} /></div> : <p className="status">Предпросмотр недоступен: общий рендерер заметки не подключён.</p>)}
      <details><summary>Дополнительные действия</summary><div className="stack"><p className="muted">Уточнение использует gpt-4.1; до 3 примеров — отдельный платный запрос. API оплачивается отдельно от ChatGPT.</p><button disabled={immutable} onClick={() => { pronunciationRevision.current++; void action('lookup.refine', { lookupId: data?.lookupId }, (result: LookupData) => { if (submitted.current) return; senseRevision.current++; setExampleCandidates([]); setData(result); setSenseChosen(!result.contextAmbiguous); const sense = result.senses.find(s => s.id === result.recommendedSenseId) ?? result.senses[0]; edit({ lemma: result.lemma, partOfSpeech: result.partOfSpeech, selectedSense: { id: sense.id, definition: senseDefinition(sense), translations: sense.translations.slice(0, 2) }, pronunciation: generatedPronunciation(result), examples: [] }); loadPronunciation(result.lookupId, generation.current); }); }}>Уточнить смысл — платный запрос</button><button disabled={immutable || !senseChosen} onClick={() => { const revision = senseRevision.current; void action('card.enrich', { lookupId: data?.lookupId, senseId: draft.selectedSense.id }, result => { if (revision !== senseRevision.current) return; const examples: ContextExample[] = result.examples ?? (result.extraExample ? [{ text: exampleText(result.extraExample), translation: exampleTranslation(result.extraExample), source: 'ai' }] : []); setExampleCandidates(examples.slice(0, 3)); edit({ examples: [] }); }); }}>Получить до 3 примеров — платный запрос</button></div></details>
      <div className="row">{options.trustedPage === true ? <label className="inline-field">Колода<select value={draft.deckName} disabled={immutable} onChange={e => edit({ deckName: e.target.value })}><option value="">Выберите колоду</option>{[...new Set([...decks, ...(draft.deckName ? [draft.deckName] : [])])].map(d => <option key={d}>{d}</option>)}</select></label> : <div className="inline-field"><p className="muted">{destinationRefreshing ? 'Обновляем настройки колоды…' : draft.deckName ? 'Колода настроена' : 'Колода не настроена'}</p><button onClick={async () => { try { if (options.openSettings) { settingsHandoffPending.current = true; await options.openSettings(); } else setError('Откройте настройки через значок расширения.'); } catch (err) { settingsHandoffPending.current = false; setError(errorText(err)); } }}>Выбрать колоду в настройках</button></div>}<label className="inline-field">Тип заметки<select value={draft.mode} disabled={immutable} onChange={e => edit({ mode: e.target.value as NoteDraft['mode'] })}><option value="recognition">Узнавание</option><option value="cloze">Пропуск (c1)</option></select></label></div>
      <label className="check"><input type="checkbox" checked={includeAudio} disabled={!audioAllowed || immutable} onChange={e => setIncludeAudio(e.target.checked)} />Аудиофайл в Anki (платно)</label>{!audioAllowed && <small>Облачное аудио выключено. Согласие можно дать в настройках.</small>}
      {busy === 'audio_loading' && <p role="status">Подготовка произношения…</p>}
      {saved && <p role="status" className="status">{saveLabels[saved.status]}</p>}
      {saved?.status === 'duplicate_review' && <button disabled={!!busy} onClick={() => void save(true)}>Подтверждаю: добавить новую заметку несмотря на дубликат</button>}
      {saved?.noteId && <button onClick={() => void action('anki.openNote', { noteId: saved.noteId })}>Открыть заметку в Anki</button>}
    </>}
  </section>;
}
