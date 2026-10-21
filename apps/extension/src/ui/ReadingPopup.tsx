import React, { useEffect, useRef, useState } from 'react';
import { getLanguage, senseDefinition, exampleText, exampleTranslation, validateNoteDraft } from '@english-reader/contracts';
import { formatIpaDisplay } from '@english-reader/note-templates';
import { lookupPreferences } from '../runtime/reader-preferences';
import type { LookupData, NoteDraft, FullMeaningsNoteDraft, MultilingualSense, ContextExample, PublicSettings, AddNoteData } from '@english-reader/contracts';
import { preparedAudioDraftKey, usePreparedAudio } from './use-prepared-audio';
import { isTrustedUiEvent } from './user-actions';
import { errorText, type PopupOptions } from './interfaces';

type SaveResult = AddNoteData;
const saveLabels = { added: 'Добавлено в Anki', queued: 'Сохранено в очередь — ещё не добавлено в Anki', already_added: 'Эта операция уже добавлена в Anki', duplicate_review: 'Найдены возможные дубликаты. Проверьте перед добавлением.' };
const unavailablePronunciation: NoteDraft['pronunciation'] = { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null };
function orderedSenses(result: LookupData): MultilingualSense[] {
  const senses = result.senses.map(sense => ({ id: sense.id, definition: senseDefinition(sense), translations: [...sense.translations] }));
  const selected = senses.find(sense => sense.id === result.recommendedSenseId) ?? senses[0];
  return [selected, ...senses.filter(sense => sense.id !== selected.id)];
}
const audioEditsMessage = 'Облачное аудио недоступно после этих правок: нужны исходные лемма и определения, переводы выбранного значения — только из ответа, остальные значения — без изменений. Восстановите исходные значения или снимите флажок и сохраните свои правки без аудио.';
function audioEditsBlocked(draft: FullMeaningsNoteDraft, lookup: LookupData | null): boolean {
  if (!lookup) return true;
  const selected = lookup.senses.find(sense => sense.id === draft.selectedSense.id);
  if (!selected || draft.expression !== lookup.expression || draft.lemma !== lookup.lemma || draft.partOfSpeech !== lookup.partOfSpeech ||
      draft.selectedSense.definition !== senseDefinition(selected) || !draft.selectedSense.translations.every(translation => selected.translations.includes(translation))) return true;
  const ordered = [selected, ...lookup.senses.filter(sense => sense.id !== selected.id)];
  return draft.senses.length !== ordered.length || draft.senses.some((sense, index) => {
    const original = ordered[index];
    return sense.id !== original.id || sense.definition !== senseDefinition(original) ||
      (index > 0 && (sense.translations.length !== original.translations.length || sense.translations.some((translation, i) => translation !== original.translations[i])));
  });
}
const generatedPronunciation = (result: LookupData): NoteDraft['pronunciation'] => ({ ipa: result.ipaCandidate?.ipa ?? null, dialect: result.ipaCandidate?.dialect ?? 'unknown', source: result.ipaCandidate ? 'generated' : 'unavailable', sourceUrl: null });
export function HighlightedSentence({ draft }: { draft: NoteDraft }) {
  const { sentence, targetStart, targetEnd } = draft.context;
  return <p className="sentence" lang={draft.sourceLanguage} dir="auto">{sentence.slice(0, targetStart)}<mark>{sentence.slice(targetStart, targetEnd)}</mark>{sentence.slice(targetEnd)}</p>;
}
export function ReadingPopup({ options, close }: { options: PopupOptions; close: () => void }) {
  const { rpc, lookupPayload, source } = options;
  const [data, setData] = useState<LookupData | null>(null);
  const [draft, setDraft] = useState<FullMeaningsNoteDraft | null>(null);
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
  const includeAudioRef = useRef(false);
  const lookupIdRef = useRef<string | undefined>(undefined);
  const lookupSenseOrder = useRef<string[]>([]);
  const lookupDataRef = useRef<LookupData | null>(null);
  const [decks, setDecks] = useState<string[]>([]);
  const generation = useRef(0);
  const lookupController = useRef<AbortController | null>(null);
  const operation = useRef(crypto.randomUUID());
  const saving = useRef(false);
  const actionPending = useRef(false);
  const submitted = useRef<{ draft: NoteDraft; includeAudio: boolean; audioId?: string } | null>(null);
  const settingsHandoffPending = useRef(false);
  const destinationRefreshPending = useRef(false);
  const container = useRef<HTMLElement>(null);
  const draftRef = useRef<FullMeaningsNoteDraft | null>(null);
  const preparedAudio = usePreparedAudio({ rpc, draft, lookupId: data?.lookupId, audioAllowed });
  function updateDraft(next: FullMeaningsNoteDraft | null | ((current: FullMeaningsNoteDraft | null) => FullMeaningsNoteDraft | null)) {
    const updated = typeof next === 'function' ? next(draftRef.current) : next;
    if ((updated ? preparedAudioDraftKey(updated) : null) !== (draftRef.current ? preparedAudioDraftKey(draftRef.current) : null)) preparedAudio.reset();
    draftRef.current = updated;
    setDraft(updated);
  }
  function loadPronunciation(lookupId: string, token: number) {
    const revision = ++pronunciationRevision.current;
    void rpc<{ pronunciation: NoteDraft['pronunciation'] }>('pronunciation.get', { lookupId }).then(result => {
      if (token !== generation.current || revision !== pronunciationRevision.current || submitted.current) return;
      updateDraft(current => current && token === generation.current && revision === pronunciationRevision.current && !submitted.current ? { ...current, pronunciation: result.pronunciation } : current);
    }).catch(() => {});
  }
  useEffect(() => {
    const token = ++generation.current;
    const controller = new AbortController();
    lookupController.current = controller;
    let lookupId: string | undefined;
    preparedAudio.reset(); includeAudioRef.current = false; setIncludeAudio(false); setAudioAllowed(false); lookupIdRef.current = undefined; lookupSenseOrder.current = []; lookupDataRef.current = null;
    setData(null); updateDraft(null); setSaved(null); setError(''); setBusy('loading'); setEditing(false); setPreview(false); setExampleCandidates([]); senseRevision.current++; pronunciationRevision.current++;
    operation.current = crypto.randomUUID(); saving.current = false; actionPending.current = false; submitted.current = null; settingsHandoffPending.current = false; destinationRefreshPending.current = false; setDestinationRefreshing(false); setSenseChosen(false);
    const timer = setTimeout(() => { if (token === generation.current) { generation.current++; controller.abort(); setBusy(''); setError('Перевод занял слишком много времени. Закройте окно и повторите запрос.'); } }, 25000);
    rpc<Partial<PublicSettings>>('settings.getReader').then(async settings => {
      if (token !== generation.current) return;
      const preferences = lookupPreferences(settings, lookupPayload);
      const result = await rpc<LookupData>('lookup', { ...lookupPayload, ...preferences }, { signal: controller.signal });
      if (token !== generation.current) return;
      lookupId = result.lookupId; lookupIdRef.current = result.lookupId; lookupSenseOrder.current = result.senses.map(sense => sense.id); lookupDataRef.current = result;
      const senses = orderedSenses(result); const sense = senses[0];
      setData(result); setSenseChosen(!result.contextAmbiguous);
      // A stored default must never opt the reader into an immediate paid action.
      setAudioAllowed(settings.cloudAudioEnabled === true); includeAudioRef.current = false; setIncludeAudio(false);
      updateDraft({ draftVersion: 3, sourceLanguage: preferences.sourceLanguage, targetLanguage: preferences.targetLanguage, learnerLevel: preferences.learnerLevel, mode: settings.defaultMode === 'cloze' ? 'cloze' : 'recognition', deckName: typeof settings.defaultDeck === 'string' ? settings.defaultDeck : '', tags: ['EnglishReader'], expression: result.expression, lemma: result.lemma, partOfSpeech: result.partOfSpeech, selectedSense: sense, senses, context: { sentence: lookupPayload.context.sentence, targetStart: lookupPayload.context.targetStart, targetEnd: lookupPayload.context.targetEnd }, pronunciation: generatedPronunciation(result), examples: [], source });
      setBusy('');
      loadPronunciation(result.lookupId, token);
    }).catch(err => { if (token === generation.current) { setError(errorText(err)); setBusy(''); } }).finally(() => clearTimeout(timer));
    if (options.trustedPage === true) rpc<{ deckNames?: string[] }>('anki.decks').then(r => { if (token === generation.current) setDecks(r.deckNames ?? []); }).catch(() => {});
    return () => { clearTimeout(timer); generation.current++; controller.abort(); if (lookupController.current === controller) lookupController.current = null; if (lookupId) void rpc('lookup.cancel', { lookupId }).catch(() => {}); };
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
        setAudioAllowed(preferences.cloudAudioEnabled === true);
        if (preferences.cloudAudioEnabled !== true) { includeAudioRef.current = false; setIncludeAudio(false); preparedAudio.reset(); }
        updateDraft(current => current ? { ...current, deckName: preferences.defaultDeck ?? current.deckName } : current);
      }).catch(err => { if (token === generation.current && !submitted.current) { setError('Не удалось обновить колоду из настроек. Откройте настройки ещё раз.'); updateDraft(current => current ? { ...current, deckName: '' } : current); } }).finally(() => { if (token === generation.current) { destinationRefreshPending.current = false; setDestinationRefreshing(false); } });
    };
    window.addEventListener('focus', refreshDestination);
    return () => window.removeEventListener('focus', refreshDestination);
  }, [rpc]);
  async function save(addNew = false) {
    const draft = draftRef.current;
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
    if (!submitted.current && includeAudioRef.current && (preparedAudio.recoveryRequired || audioEditsBlocked(draft, lookupDataRef.current))) return;
    const audioId = draft ? preparedAudio.getAudioId(draft) : undefined;
    if (!submitted.current && includeAudioRef.current && (!audioAllowed || preparedAudio.isPreparing() || !audioId)) {
      setError('Дождитесь готового аудиофайла для этой версии карточки, создайте его явно или снимите флажок аудио.'); return;
    }
    saving.current = true; setBusy('saving'); setError('');
    const token = generation.current;
    try {
      if (!submitted.current) submitted.current = { draft, includeAudio: includeAudioRef.current, ...(includeAudioRef.current && audioId ? { audioId } : {}) };
      const result = await rpc<SaveResult>('anki.addNote', { operationId: operation.current, ...submitted.current, duplicateAction: addNew ? 'add_new' : 'review' });
      if (token === generation.current) setSaved(result);
    } catch (err) { if (token === generation.current) setError(errorText(err)); }
    finally { if (token === generation.current) { saving.current = false; setBusy(''); } }
  }
  async function openSettings() {
    try {
      if (options.openSettings) { settingsHandoffPending.current = true; await options.openSettings(); }
      else setError('Откройте настройки через значок расширения.');
    } catch (err) { settingsHandoffPending.current = false; setError(errorText(err)); }
  }
  async function prepareAudio() {
    if (!draftRef.current || !lookupIdRef.current || !includeAudioRef.current || !audioAllowed || !senseChosen || submitted.current || saving.current || actionPending.current || destinationRefreshPending.current || busy) return;
    if (preparedAudio.recoveryRequired || audioEditsBlocked(draftRef.current, lookupDataRef.current)) return;
    try { validateNoteDraft(draftRef.current); }
    catch { setError('Проверьте поля карточки перед созданием аудио.'); return; }
    setError('');
    const token = generation.current;
    await preparedAudio.prepare(draftRef.current, lookupIdRef.current);
    if (token === generation.current && includeAudioRef.current && draftRef.current && preparedAudio.getAudioId(draftRef.current)) setError('');
  }
  async function action(type: string, payload: Record<string, unknown>, onResult?: (value: any) => void, onError?: (error: unknown) => void) {
    if (busy || saving.current || actionPending.current) return;
    actionPending.current = true;
    const token = generation.current; setBusy(type.startsWith('audio') ? 'audio_loading' : 'loading'); setError('');
    try { const result = await rpc(type, payload, ['lookup.refine', 'card.enrich'].includes(type) ? { signal: lookupController.current?.signal } : undefined); if (token === generation.current) onResult?.(result); }
    catch (err) { if (token === generation.current) { if (onError) onError(err); else setError(errorText(err)); } }
    finally { if (token === generation.current) { actionPending.current = false; setBusy(''); } }
  }
  function playAudio() {
    const audioId = draftRef.current && includeAudioRef.current ? preparedAudio.getAudioId(draftRef.current) : undefined;
    // Capture the exact ready binding before dispatch. A late failure must not
    // invalidate audio belonging to a newer draft or a later lookup.
    const playbackFailed = audioId ? preparedAudio.capturePlaybackFailure(audioId) : undefined;
    void action('audio.play', audioId ? { audioId } : { lookupId: lookupIdRef.current }, undefined, playbackFailed);
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
  const edit = (change: Partial<FullMeaningsNoteDraft>) => {
    if (immutable || submitted.current || !draftRef.current) return;
    const current = draftRef.current;
    const meaningChanged = (change.selectedSense !== undefined && JSON.stringify(change.selectedSense) !== JSON.stringify(current.selectedSense)) ||
      (change.lemma !== undefined && change.lemma !== current.lemma) || (change.partOfSpeech !== undefined && change.partOfSpeech !== current.partOfSpeech);
    const selectedSense = change.selectedSense ?? current.selectedSense;
    // Repeated primary changes must not shuffle the other meanings. The service
    // compares this canonical lookup order when binding paid audio to the draft.
    const senses = [selectedSense, ...(change.senses ?? current.senses).filter(sense => sense.id !== selectedSense.id)
      .sort((a, b) => lookupSenseOrder.current.indexOf(a.id) - lookupSenseOrder.current.indexOf(b.id))];
    if (meaningChanged) { senseRevision.current++; pronunciationRevision.current++; setExampleCandidates([]); }
    updateDraft({ ...current, ...change, selectedSense, senses,
      ...(meaningChanged ? { examples: [], pronunciation: change.pronunciation ?? unavailablePronunciation } : {}) });
    setSaved(null);
  };
  function editSelected(change: Partial<MultilingualSense>) {
    if (draftRef.current) edit({ selectedSense: { ...draftRef.current.selectedSense, ...change } });
  }
  function restoreOriginalAudioMeanings() {
    if (!lookupDataRef.current || !draftRef.current || immutable || submitted.current) return;
    const original = lookupDataRef.current;
    const senses = orderedSenses({ ...original, recommendedSenseId: draftRef.current.selectedSense.id });
    edit({ lemma: original.lemma, partOfSpeech: original.partOfSpeech, selectedSense: senses[0], senses, pronunciation: unavailablePronunciation, examples: [] });
    setError('');
  }
  const audioEditsInvalid = draft ? audioEditsBlocked(draft, data) : false;
  const preparedAudioId = draft && includeAudio ? preparedAudio.getAudioId(draft) : undefined;
  let rendered: { front: string; back: string } | undefined;
  if (preview && draft && options.renderPreview) { try { rendered = options.renderPreview(draft); } catch { /* Render failures are visible below. */ } }
  function guardUserAction(event: React.SyntheticEvent) {
    if (!isTrustedUiEvent(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); }
  }
  return <section onClickCapture={guardUserAction} onInputCapture={guardUserAction} onChangeCapture={guardUserAction} onKeyDownCapture={guardUserAction} ref={container} role="dialog" aria-modal="false" aria-label="Контекстный перевод" tabIndex={-1} className="panel popup stack">
    <header className="row between"><div><strong lang={draft?.sourceLanguage ?? lookupPayload.sourceLanguage} dir="auto">{draft?.expression ?? lookupPayload.expression}</strong> <small>{draft?.partOfSpeech}</small></div><div className="row"><button aria-label={preparedAudioId ? 'Прослушать готовый аудиофайл' : 'Прослушать выражение системным голосом'} disabled={!draft || !!busy || preparedAudio.status === 'loading'} onClick={playAudio}>▶</button><button aria-label="Закрыть перевод" onClick={close}>×</button></div></header>
    <small className="muted">Новое выделение + Shift заменяет это окно. Несохранённые правки теряются; отправленное сохранение не отменяется — при неизвестном результате проверьте очередь и Anki.</small>
    {busy === 'loading' && !draft && <p role="status">Переводим в контексте…</p>}
    {error && <p role="alert" className="status error">{error}</p>}
    {draft && <>
      <p className="muted">{getLanguage(draft.sourceLanguage).name} → {getLanguage(draft.targetLanguage).name} · {draft.learnerLevel}</p>
      <p className="pronunciation">{draft.pronunciation.ipa ? <><span className="pronunciation-ipa" dir="ltr">{draft.pronunciation.source === 'generated' ? '≈ ' : ''}{formatIpaDisplay(draft.pronunciation.ipa)}</span><span className="pronunciation-source">{draft.pronunciation.source === 'dictionary' ? 'словарь' : 'сгенерировано ИИ'}</span></> : <span className="muted">{senseChosen ? 'Транскрипция недоступна для выбранного значения' : 'Транскрипция недоступна'}</span>}</p>
      {data?.contextAmbiguous && <p className="status" role="status">Контекст неоднозначен. Выберите подходящее значение.</p>}
      <p className="translation" lang={draft.targetLanguage} dir="auto">{senseChosen ? draft.selectedSense.translations.join('; ') : 'Значение пока не выбрано'}</p>
      <HighlightedSentence draft={draft} />
      <details open={!senseChosen}><summary>Значения в карточке ({draft.senses.length})</summary><p className="muted">Все значения и переводы из этого ответа сохранятся в карточке. Выбранное значение будет первым. Это подборка распространённых значений, не полный словарь.</p>{draft.senses.map(sense => <label className="check" key={sense.id}><input type="radio" name="sense" checked={senseChosen && draft.selectedSense.id === sense.id} disabled={immutable} onChange={() => { if (immutable) return; senseRevision.current++; pronunciationRevision.current++; setExampleCandidates([]); setSenseChosen(true); edit({ selectedSense: sense, pronunciation: unavailablePronunciation, examples: [] }); }} /><span><span lang={draft.targetLanguage} dir="auto">{sense.translations.join('; ')}</span><small lang={draft.sourceLanguage} dir="auto" style={{ display: 'block' }}>{senseDefinition(sense)}</small></span></label>)}</details>
      {senseChosen && <details><summary>Определение на языке текста</summary><p lang={draft.sourceLanguage} dir="auto">{senseDefinition(draft.selectedSense)}</p></details>}
      {exampleCandidates.length > 0 && <fieldset disabled={immutable}><legend>Примеры выбранного значения — выберите для заметки</legend><p className="muted">Создано ИИ только для выбранного значения. Примеры необязательны и попадут только на обратную сторону. Выбрано: {draft.examples.length} из {exampleCandidates.length}.</p>{exampleCandidates.map((example, index) => <label className="check" key={`${index}:${example.text}`}><input type="checkbox" checked={draft.examples.includes(example)} onChange={event => edit({ examples: event.target.checked ? [...draft.examples, example].slice(0, 3) : draft.examples.filter(selected => selected !== example) })} /><span><span lang={draft.sourceLanguage} dir="auto" style={{ display: 'block' }}>{example.text}</span><small lang={draft.targetLanguage} dir="auto" style={{ display: 'block' }}>{example.translation}</small></span></label>)}</fieldset>}
      {editing && <fieldset disabled={immutable}><legend>Редактирование выбранного значения</legend><label>Переводы (до четырёх, через точку с запятой)<input lang={draft.targetLanguage} dir="auto" value={draft.selectedSense.translations.join('; ')} onChange={e => editSelected({ translations: e.target.value.split(';').map(value => value.trim()) })} /></label><label>Лемма<input lang={draft.sourceLanguage} dir="auto" value={draft.lemma} onChange={e => edit({ lemma: e.target.value })} /></label><label>Определение на языке текста<textarea lang={draft.sourceLanguage} dir="auto" value={senseDefinition(draft.selectedSense)} onChange={e => editSelected({ definition: e.target.value })} /></label><small>Исходное предложение и выбранный диапазон сохраняются без изменений. Ctrl+Enter — сохранить.</small></fieldset>}
      {error && submitted.current && !saved && <p className="muted">Запрос на сохранение уже отправлен. Повтор использует тот же снимок и идентификатор операции; редактирование заблокировано. При неизвестном результате проверьте очередь и исходную колоду Anki перед новым добавлением.</p>}
      <div className="row"><button className="primary" disabled={saveDisabled || !senseChosen || preparedAudio.status === 'loading'} onClick={() => void save()}>{busy === 'saving' ? 'Сохраняем…' : submitted.current && !saved ? 'Повторить сохранение' : 'Добавить в Anki'}</button><button disabled={immutable || !senseChosen} onClick={() => setEditing(!editing)}>{editing ? 'Готово' : 'Редактировать'}</button><button disabled={!senseChosen} onClick={() => setPreview(!preview)}>Предпросмотр</button></div>
      {preview && (rendered ? <div className="stack"><span>Лицевая сторона</span><iframe className="preview" sandbox="" title="Предпросмотр лицевой стороны" srcDoc={rendered.front} /><span>Обратная сторона</span><iframe className="preview" sandbox="" title="Предпросмотр обратной стороны" srcDoc={rendered.back} /></div> : <p className="status">Предпросмотр недоступен: общий рендерер заметки не подключён.</p>)}
      <details><summary>Дополнительные действия</summary><div className="stack"><p className="muted">Перевод и примеры: GPT-6 Luna (gpt-6-luna), без reasoning. Уточнение: та же модель с reasoning low; до 3 примеров — отдельный платный запрос. API оплачивается отдельно от ChatGPT.</p><button disabled={immutable} onClick={() => { pronunciationRevision.current++; void action('lookup.refine', { lookupId: data?.lookupId }, (result: LookupData) => { if (submitted.current) return; senseRevision.current++; setExampleCandidates([]); setData(result); lookupIdRef.current = result.lookupId; lookupSenseOrder.current = result.senses.map(sense => sense.id); lookupDataRef.current = result; setSenseChosen(!result.contextAmbiguous); const senses = orderedSenses(result); const sense = senses[0]; edit({ lemma: result.lemma, partOfSpeech: result.partOfSpeech, selectedSense: sense, senses, pronunciation: generatedPronunciation(result), examples: [] }); loadPronunciation(result.lookupId, generation.current); }); }}>Уточнить смысл — платный запрос</button><button disabled={immutable || !senseChosen} onClick={() => { const revision = senseRevision.current; void action('card.enrich', { lookupId: data?.lookupId, senseId: draft.selectedSense.id }, result => { if (revision !== senseRevision.current) return; const examples: ContextExample[] = result.examples ?? (result.extraExample ? [{ text: exampleText(result.extraExample), translation: exampleTranslation(result.extraExample), source: 'ai' }] : []); setExampleCandidates(examples.slice(0, 3)); edit({ examples: [] }); }); }}>Получить до 3 примеров — платный запрос</button></div></details>
      <div className="row">{options.trustedPage === true ? <label className="inline-field">Колода<select value={draft.deckName} disabled={immutable} onChange={e => edit({ deckName: e.target.value })}><option value="">Выберите колоду</option>{[...new Set([...decks, ...(draft.deckName ? [draft.deckName] : [])])].map(d => <option key={d}>{d}</option>)}</select></label> : <div className="inline-field"><p className="muted">{destinationRefreshing ? 'Обновляем настройки колоды…' : draft.deckName ? 'Колода настроена' : 'Колода не настроена'}</p><button onClick={() => void openSettings()}>Выбрать колоду в настройках</button></div>}<label className="inline-field">Тип заметки<select value={draft.mode} disabled={immutable} onChange={e => edit({ mode: e.target.value as NoteDraft['mode'] })}><option value="recognition">Узнавание</option><option value="cloze">Пропуск (c1)</option></select></label></div>
      <label className="check"><input type="checkbox" checked={includeAudio} disabled={!audioAllowed || immutable || !senseChosen || (!includeAudio && (audioEditsInvalid || preparedAudio.recoveryRequired))} onChange={event => {
        if (!audioAllowed || immutable || submitted.current || saving.current || actionPending.current || destinationRefreshPending.current) return;
        includeAudioRef.current = event.target.checked; setIncludeAudio(event.target.checked);
        if (event.target.checked) void prepareAudio(); else preparedAudio.reset();
      }} />Создать аудиофайл (платный запрос)</label>
      {!audioAllowed && <div className="stack"><small>Облачное аудио выключено. Согласие можно дать в настройках расширения; затем вернитесь к переводу.</small><button onClick={() => void openSettings()}>Настройки облачного аудио</button></div>}
      {preparedAudio.recoveryRequired && <div className="stack"><p role="alert" className="status error">Подготовленный аудиофайл больше недоступен в этом окне.</p>{submitted.current ? <p className="muted">Снимок уже отправленной операции не изменён. Проверьте результат в очереди и Anki; повтор сохранения использует тот же снимок.</p> : <><p className="muted">Снимите флажок аудио, чтобы сохранить текущий черновик без аудио, или закройте перевод и выберите слово заново. Новый перевод и создание аудио могут быть платными. Автоматических запросов не будет.</p><p className="muted">Ваши правки остаются в этом окне до закрытия. При закрытии несохранённый черновик будет потерян.</p><button onClick={close}>Закрыть перевод и выбрать слово заново</button></>}</div>}
      {audioAllowed && audioEditsInvalid && !submitted.current && <div className="stack"><p role="alert" className="status">{audioEditsMessage}</p><small>Восстановление удалит ваши правки леммы и всех значений; аудио не создаётся автоматически.</small><button disabled={immutable} onClick={restoreOriginalAudioMeanings}>Восстановить исходные значения и лемму</button></div>}
      {includeAudio && !submitted.current && <div className="stack">
        <small>Флажок отправляет платный запрос. Снятие флажка не отменяет уже отправленный запрос и его стоимость.</small>
        {preparedAudio.status === 'loading' && <p role="status">Создаём аудиофайл для этой карточки…</p>}
        {preparedAudioId && <p role="status">Аудиофайл готов. Его можно прослушать кнопкой ▶; этот же файл будет добавлен в Anki.</p>}
        {preparedAudio.error && !preparedAudio.recoveryRequired && <p role="alert" className="status error">{preparedAudio.error}</p>}
        {!preparedAudioId && preparedAudio.status !== 'loading' && !audioEditsInvalid && !preparedAudio.recoveryRequired && <><p className="muted">Для текущей версии карточки аудиофайл ещё не готов. Создайте его явно или снимите флажок, чтобы сохранить без аудио.</p><button disabled={immutable || !audioAllowed || !senseChosen} onClick={() => void prepareAudio()}>{preparedAudio.status === 'error' ? 'Повторить создание аудио — платный запрос' : 'Создать аудио сейчас — платный запрос'}</button></>}
      </div>}
      {busy === 'audio_loading' && <p role="status">Подготовка произношения…</p>}
      {saved && <p role="status" className="status">{saveLabels[saved.status]}</p>}
      {saved?.status === 'duplicate_review' && <button disabled={!!busy} onClick={() => void save(true)}>Подтверждаю: добавить новую заметку несмотря на дубликат</button>}
      {saved?.noteId && <button onClick={() => void action('anki.openNote', { noteId: saved.noteId })}>Открыть заметку в Anki</button>}
    </>}
  </section>;
}
