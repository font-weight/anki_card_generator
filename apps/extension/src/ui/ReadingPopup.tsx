import React, { useEffect, useRef, useState } from 'react';
import type { LookupData, NoteDraft, PublicSettings, AddNoteData } from '@english-reader/contracts';
import { errorText, type PopupOptions } from './interfaces';

type SaveResult = AddNoteData;
const saveLabels = { added: 'Добавлено в Anki', queued: 'Сохранено в очередь — ещё не добавлено в Anki', already_added: 'Эта операция уже добавлена в Anki', duplicate_review: 'Найдены возможные дубликаты. Проверьте перед добавлением.' };
export function HighlightedSentence({ draft }: { draft: NoteDraft }) {
  const { sentence, targetStart, targetEnd } = draft.context;
  return <p className="sentence">{sentence.slice(0, targetStart)}<mark>{sentence.slice(targetStart, targetEnd)}</mark>{sentence.slice(targetEnd)}</p>;
}
export function ReadingPopup({ options, close }: { options: PopupOptions; close: () => void }) {
  const { rpc, lookupPayload, source } = options;
  const [data, setData] = useState<LookupData | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('loading');
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [senseChosen, setSenseChosen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [audioAllowed, setAudioAllowed] = useState(false);
  const [decks, setDecks] = useState<string[]>([]);
  const generation = useRef(0);
  const operation = useRef(crypto.randomUUID());
  const saving = useRef(false);
  const submitted = useRef<{ draft: NoteDraft; includeAudio: boolean } | null>(null);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const token = ++generation.current;
    let lookupId: string | undefined;
    setData(null); setDraft(null); setSaved(null); setError(''); setBusy('loading'); setEditing(false); setPreview(false);
    operation.current = crypto.randomUUID(); saving.current = false; submitted.current = null; setSenseChosen(false);
    const timer = setTimeout(() => { if (token === generation.current) { generation.current++; setBusy(''); setError('Перевод занял слишком много времени. Закройте окно и повторите запрос.'); } }, 25000);
    rpc<Partial<PublicSettings>>('settings.getReader').then(async settings => {
      if (token !== generation.current) return;
      const result = await rpc<LookupData>('lookup', { ...lookupPayload, dialect: settings.dialect ?? lookupPayload.dialect });
      if (token !== generation.current) return;
      lookupId = result.lookupId;
      const sense = result.senses.find(s => s.id === result.recommendedSenseId) ?? result.senses[0];
      setData(result); setSenseChosen(!result.contextAmbiguous);
      setAudioAllowed(settings.cloudAudioEnabled === true); setIncludeAudio(settings.cloudAudioEnabled === true && settings.includeAudioByDefault === true);
      setDraft({ sourceLanguage: 'en', targetLanguage: 'ru', mode: settings.defaultMode === 'cloze' ? 'cloze' : 'recognition', deckName: typeof settings.defaultDeck === 'string' ? settings.defaultDeck : '', tags: ['EnglishReader'], expression: result.expression, lemma: result.lemma, partOfSpeech: result.partOfSpeech, selectedSense: { ...sense, translations: sense.translations.slice(0, 2) }, context: { sentence: lookupPayload.context.sentence, targetStart: lookupPayload.context.targetStart, targetEnd: lookupPayload.context.targetEnd }, pronunciation: { ipa: result.ipaCandidate?.ipa ?? null, dialect: result.ipaCandidate?.dialect ?? 'unknown', source: result.ipaCandidate ? 'generated' : 'unavailable', sourceUrl: null }, extraExample: result.extraExample, source });
      setBusy('');
      void rpc<{ pronunciation: NoteDraft['pronunciation'] }>('pronunciation.get', { lookupId: result.lookupId }).then(p => { if (token === generation.current) setDraft(d => d ? { ...d, pronunciation: p.pronunciation } : d); }).catch(() => {});
    }).catch(err => { if (token === generation.current) { setError(errorText(err)); setBusy(''); } }).finally(() => clearTimeout(timer));
    rpc<{ deckNames?: string[] }>('anki.decks').then(r => { if (token === generation.current) setDecks(r.deckNames ?? []); }).catch(() => {});
    return () => { clearTimeout(timer); generation.current++; if (lookupId) void rpc('lookup.cancel', { lookupId }).catch(() => {}); };
  }, [rpc, lookupPayload, source]);
  async function save(addNew = false) {
    if (!draft || !senseChosen || busy || saving.current || saved?.status === 'added' || saved?.status === 'already_added' || saved?.status === 'queued') return;
    if (!draft.deckName.trim()) { setError('Выберите колоду или укажите её имя в настройках.'); return; }
    if (!draft.selectedSense.translations.some(t => t.trim())) { setError('Укажите перевод выбранного значения.'); return; }
    saving.current = true; setBusy('saving'); setError('');
    const token = generation.current;
    try {
      if (!addNew || !submitted.current) submitted.current = { draft, includeAudio };
      const result = await rpc<SaveResult>('anki.addNote', { operationId: operation.current, ...submitted.current, duplicateAction: addNew ? 'add_new' : 'review' });
      if (token === generation.current) setSaved(result);
    } catch (err) { if (token === generation.current) setError(errorText(err)); }
    finally { if (token === generation.current) { saving.current = false; setBusy(''); } }
  }
  async function action(type: string, payload: Record<string, unknown>, onResult?: (value: any) => void) {
    if (busy) return;
    const token = generation.current; setBusy(type.startsWith('audio') ? 'audio_loading' : 'loading'); setError('');
    try { const result = await rpc(type, payload); if (token === generation.current) onResult?.(result); }
    catch (err) { if (token === generation.current) setError(errorText(err)); }
    finally { if (token === generation.current) setBusy(''); }
  }
  useEffect(() => {
    const element = container.current;
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Enter' || event.repeat || event.altKey || event.metaKey || event.isComposing) return;
      const target = event.composedPath()[0] as HTMLElement;
      const field = target?.matches('input,textarea,select,button,summary,a,[contenteditable=true]');
      if ((event.ctrlKey && editing) || (!field && !editing && !event.ctrlKey)) { event.preventDefault(); void save(); }
    }
    element?.addEventListener('keydown', key);
    return () => element?.removeEventListener('keydown', key);
  });
  const immutable = !!busy || saved?.status === 'added' || saved?.status === 'already_added' || saved?.status === 'queued' || saved?.status === 'duplicate_review';
  const edit = (change: Partial<NoteDraft>) => { if (immutable) return; setDraft(d => d ? { ...d, ...change } : d); setSaved(null); };
  let rendered: { front: string; back: string } | undefined;
  if (preview && draft && options.renderPreview) { try { rendered = options.renderPreview(draft); } catch { /* Render failures are visible below. */ } }
  return <section ref={container} role="dialog" aria-modal="false" aria-label="Контекстный перевод" tabIndex={-1} className="panel popup stack">
    <header className="row between"><div><strong>{draft?.expression ?? lookupPayload.expression}</strong> <small>{draft?.partOfSpeech}</small></div><div className="row"><button aria-label="Прослушать выражение системным голосом" disabled={!draft || !!busy} onClick={() => void action('audio.play', { lookupId: data?.lookupId })}>▶</button><button aria-label="Закрыть перевод" onClick={close}>×</button></div></header>
    {busy === 'loading' && !draft && <p role="status">Переводим в контексте…</p>}
    {error && <p role="alert" className="status error">{error}</p>}
    {draft && <>
      <p className="muted">{draft.pronunciation.ipa ? `${draft.pronunciation.source === 'generated' ? '≈ ' : ''}${draft.pronunciation.ipa} · ${draft.pronunciation.source === 'dictionary' ? 'словарь' : 'сгенерировано ИИ'}` : 'Транскрипция недоступна'}</p>
      {data?.contextAmbiguous && <p className="status" role="status">Контекст неоднозначен. Выберите подходящее значение.</p>}
      <p className="translation">{senseChosen ? draft.selectedSense.translations.join('; ') : 'Значение пока не выбрано'}</p>
      <HighlightedSentence draft={draft} />
      <details open={!senseChosen}><summary>Другие значения ({data?.senses.length ?? 0})</summary>{data?.senses.map(sense => <label className="check" key={sense.id}><input type="radio" name="sense" checked={senseChosen && draft.selectedSense.id === sense.id} disabled={immutable} onChange={() => { setSenseChosen(true); edit({ selectedSense: { ...sense, translations: sense.translations.slice(0, 2) } }); }} /><span>{sense.translations.join('; ')}<small style={{ display: 'block' }}>{sense.definitionEn}</small></span></label>)}</details>
      {senseChosen && <details><summary>Краткое определение на английском</summary><p>{draft.selectedSense.definitionEn}</p></details>}
      {draft.extraExample && <div><small>Пример создан ИИ</small><p>{draft.extraExample.textEn}</p><p className="muted">{draft.extraExample.textRu}</p></div>}
      {editing && <fieldset disabled={immutable}><legend>Редактирование выбранного значения</legend><label>Перевод (до двух, через точку с запятой)<input value={draft.selectedSense.translations.join('; ')} onChange={e => edit({ selectedSense: { ...draft.selectedSense, translations: e.target.value.split(';').slice(0, 2) } })} /></label><label>Лемма<input value={draft.lemma} onChange={e => edit({ lemma: e.target.value })} /></label><label>Определение на английском<textarea value={draft.selectedSense.definitionEn} onChange={e => edit({ selectedSense: { ...draft.selectedSense, definitionEn: e.target.value } })} /></label><small>Исходное предложение и выбранный диапазон сохраняются без изменений. Ctrl+Enter — сохранить.</small></fieldset>}
      <div className="row"><button className="primary" disabled={immutable || !senseChosen} onClick={() => void save()}>{busy === 'saving' ? 'Сохраняем…' : 'Добавить в Anki'}</button><button disabled={immutable || !senseChosen} onClick={() => setEditing(!editing)}>{editing ? 'Готово' : 'Редактировать'}</button><button disabled={!senseChosen} onClick={() => setPreview(!preview)}>Предпросмотр</button></div>
      {preview && (rendered ? <div className="stack"><span>Лицевая сторона</span><iframe className="preview" sandbox="" title="Предпросмотр лицевой стороны" srcDoc={rendered.front} /><span>Обратная сторона</span><iframe className="preview" sandbox="" title="Предпросмотр обратной стороны" srcDoc={rendered.back} /></div> : <p className="status">Предпросмотр недоступен: общий рендерер заметки не подключён.</p>)}
      <details><summary>Дополнительные действия</summary><div className="stack"><p className="muted">Уточнение использует gpt-4.1, пример — отдельный платный запрос. API оплачивается отдельно от ChatGPT.</p><button disabled={immutable} onClick={() => void action('lookup.refine', { lookupId: data?.lookupId }, (result: LookupData) => { setData(result); setSenseChosen(!result.contextAmbiguous); const sense = result.senses.find(s => s.id === result.recommendedSenseId) ?? result.senses[0]; edit({ selectedSense: { ...sense, translations: sense.translations.slice(0, 2) } }); })}>Уточнить смысл — платный запрос</button><button disabled={immutable || !senseChosen} onClick={() => void action('card.enrich', { lookupId: data?.lookupId, senseId: draft.selectedSense.id }, result => edit({ extraExample: result.extraExample }))}>Создать пример ИИ — платный запрос</button></div></details>
      <div className="row"><label className="inline-field">Колода<select value={draft.deckName} disabled={immutable} onChange={e => edit({ deckName: e.target.value })}><option value="">Выберите колоду</option>{[...new Set([...decks, ...(draft.deckName ? [draft.deckName] : [])])].map(d => <option key={d}>{d}</option>)}</select></label><label className="inline-field">Тип заметки<select value={draft.mode} disabled={immutable} onChange={e => edit({ mode: e.target.value as NoteDraft['mode'] })}><option value="recognition">Узнавание</option><option value="cloze">Пропуск (c1)</option></select></label></div>
      <label className="check"><input type="checkbox" checked={includeAudio} disabled={!audioAllowed || immutable} onChange={e => setIncludeAudio(e.target.checked)} />Аудиофайл в Anki (платно)</label>{!audioAllowed && <small>Облачное аудио выключено. Согласие можно дать в настройках.</small>}
      {busy === 'audio_loading' && <p role="status">Подготовка произношения…</p>}
      {saved && <p role="status" className="status">{saveLabels[saved.status]}</p>}
      {saved?.status === 'duplicate_review' && <button disabled={!!busy} onClick={() => void save(true)}>Подтверждаю: добавить новую заметку несмотря на дубликат</button>}
      {saved?.noteId && <button onClick={() => void action('anki.openNote', { noteId: saved.noteId })}>Открыть заметку в Anki</button>}
    </>}
  </section>;
}
