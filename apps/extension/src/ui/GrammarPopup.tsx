import React, { useEffect, useRef, useState } from 'react';
import { validateGrammarDraft, validateGrammarLookupData } from '../../../../packages/contracts/src/grammar.ts';
import type { GrammarDraft, GrammarLookupData, GrammarLookupPayload } from '../../../../packages/contracts/src/grammar.ts';
import type { Source } from '@english-reader/contracts';
import { renderGrammarPreview } from '../../../../packages/note-templates/src/grammar.ts';
import { errorText, type UiRpc } from './interfaces';
import { isTrustedUiEvent } from './user-actions';

export interface GrammarPopupOptions {
  rpc: UiRpc;
  payload: GrammarLookupPayload;
  source: Source;
  /** Only a clean trusted LeftAlt action after explicit grammar opt-in may set this. */
  autoGenerate?: boolean;
  trustedPage?: boolean;
  openSettings?: () => void | Promise<void>;
  onClose?: () => void;
}
type SaveResult = { operationId: string; status: 'added' | 'already_added'; noteId: number };
type GrammarSettings = { grammarEnabled?: boolean; grammarDeck?: string; defaultDeck?: string; grammarExplanationLanguage?: GrammarLookupPayload['explanationLanguage'] };
const editable = ['question', 'answer', 'rule', 'explanation', 'translation'] as const;
const labels = { question: 'Вопрос', answer: 'Ответ', rule: 'Правило', explanation: 'Объяснение', translation: 'Перевод предложения' };
const limits = { question: 500, answer: 1000, rule: 1000, explanation: 2000, translation: 2000 };

/** No generation, note creation or audio request occurs merely by opening this panel. */
export function GrammarPopup({ options, close }: { options: GrammarPopupOptions; close: () => void }) {
  const { rpc, payload, source } = options;
  const [draft, setDraft] = useState<GrammarDraft | null>(null);
  const [busy, setBusy] = useState<'generating' | 'saving' | ''>('');
  const [error, setError] = useState('');
  const [saveFailure, setSaveFailure] = useState<'schema' | 'transport' | 'conflict' | null>(null);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const lookupController = useRef<AbortController | null>(null);
  const draftRef = useRef<GrammarDraft | null>(null);
  const submitted = useRef<GrammarDraft | null>(null);
  const operationId = useRef(crypto.randomUUID());
  function updateDraft(value: GrammarDraft | null) { draftRef.current = value; setDraft(value); }
  async function generate(token = generation.current) {
    if (pending.current || submitted.current || draftRef.current) return;
    pending.current = true; setBusy('generating'); setError('');
    const controller = new AbortController(); lookupController.current = controller;
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const settings = await rpc<GrammarSettings>('settings.getReader', {}, { signal: controller.signal });
      if (token !== generation.current) return;
      if (settings.grammarEnabled !== true) throw new Error('Грамматика выключена. Включите экспериментальную функцию в настройках.');
      const input: GrammarLookupPayload = { ...payload, explanationLanguage: settings.grammarExplanationLanguage ?? payload.explanationLanguage ?? payload.targetLanguage };
      const data = validateGrammarLookupData(await rpc<GrammarLookupData>('grammar.lookup', input, { signal: controller.signal }), input);
      if (token !== generation.current) return;
      const { grammarId: _grammarId, ...content } = data;
      const next: GrammarDraft = { ...content, draftKind: 'grammar', draftVersion: 1,
        sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, explanationLanguage: input.explanationLanguage,
        learnerLevel: input.learnerLevel, deckName: settings.grammarDeck?.trim() || settings.defaultDeck || 'Default',
        tags: ['LanguageReader', 'Grammar'], source: structuredClone(source) };
      validateGrammarDraft(next); updateDraft(next);
    } catch (err) {
      if (token === generation.current) setError(controller.signal.aborted ? 'Запрос отменён или истекло время ожидания. Повторите только явно; отмена не гарантирует отсутствия списания.' : errorText(err));
    } finally {
      clearTimeout(timer);
      if (token === generation.current) { pending.current = false; setBusy(''); }
      if (lookupController.current === controller) lookupController.current = null;
    }
  }
  useEffect(() => {
    const token = ++generation.current;
    lookupController.current?.abort(); pending.current = false; submitted.current = null;
    operationId.current = crypto.randomUUID(); updateDraft(null); setBusy(''); setError(''); setSaveFailure(null); setSaved(null); setShowPreview(false);
    // autoGenerate is supplied only by the trusted clean-Alt activation adapter.
    if (options.autoGenerate === true) void generate(token);
    return () => { generation.current++; lookupController.current?.abort(); lookupController.current = null; pending.current = false; };
  }, [rpc, payload, source, options.autoGenerate]);
  function edit(key: typeof editable[number], value: string) {
    if (!draftRef.current || pending.current || submitted.current) return;
    updateDraft({ ...draftRef.current, [key]: value }); setError('');
  }
  async function save() {
    if (pending.current || saved || !draftRef.current) return;
    if (!submitted.current) {
      try { validateGrammarDraft(draftRef.current); }
      catch { setError('Проверьте поля карточки: нужны непустые значения допустимой длины без разметки.'); return; }
      submitted.current = structuredClone(draftRef.current);
    }
    pending.current = true; setBusy('saving'); setError(''); setSaveFailure(null);
    const token = generation.current;
    try {
      const result = await rpc<SaveResult>('grammar.addNote', { operationId: operationId.current, draft: submitted.current });
      if (token !== generation.current) return;
      if (result.operationId !== operationId.current || !['added', 'already_added'].includes(result.status) || !Number.isSafeInteger(result.noteId) || result.noteId <= 0) throw new Error('Результат добавления не подтверждён. Повторная попытка должна сначала проверить эту же операцию.');
      setSaved(result);
    } catch (err) {
      if (token === generation.current) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        if (code === 'ANKI_SCHEMA_MISMATCH') {
          setSaveFailure('schema');
          setError('Anki не подтвердил совместимость типа грамматики или вернул некорректный ответ. В настройках, раздел «Грамматика», нажмите «Подготовить тип грамматики» и подтвердите создание отдельного совместимого типа при необходимости. Затем вернитесь к этой карточке: повторная генерация не нужна.');
        } else if (code === 'ANKI_UNAVAILABLE' || code === 'NETWORK_TIMEOUT') {
          setSaveFailure('transport');
          setError('Не удалось получить подтверждение от AnkiConnect. Убедитесь, что Anki открыт и дополнение доступно, затем проверьте эту же операцию. Если результат прежней отправки неизвестен, карточка не будет отправлена повторно вслепую.');
        } else if (code === 'OPERATION_CONFLICT') {
          setSaveFailure('conflict');
          setError('Не удалось однозначно сверить предыдущее добавление. Повторная отправка заблокирована, чтобы не создать дубликат. Проверьте последнюю карточку в Anki; можно повторить проверку этой же операции без новой генерации.');
        } else setError(errorText(err));
      }
    }
    finally { if (token === generation.current) { pending.current = false; setBusy(''); } }
  }
  let preview: { front: string; back: string } | null = null;
  if (showPreview && draft) { try { preview = renderGrammarPreview(draft); } catch { /* Invalid edits are explained and remain editable. */ } }
  const dismiss = () => { generation.current++; lookupController.current?.abort(); close(); };
  const c = draft?.construction;
  const saveLabel = busy === 'saving' ? 'Добавляется…' : saved || !submitted.current ? 'Добавить в Anki'
    : saveFailure === 'schema' ? 'Проверить после настройки' : saveFailure === 'transport' ? 'Проверить и повторить'
    : saveFailure === 'conflict' ? 'Проверить результат' : 'Повторить добавление';
  return <section className="panel popup grammar-popup" role="dialog" aria-modal="false" aria-label="Карточка по грамматике" tabIndex={-1}>
    <header className="row between"><strong>Грамматика · эксперимент</strong><button type="button" aria-label="Закрыть" onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) dismiss(); }}>×</button></header>
    <p className="sentence" lang={payload.sourceLanguage} dir="auto">{c ? <>{payload.sentence.slice(0, c.targetStart)}<mark>{payload.sentence.slice(c.targetStart, c.targetEnd)}</mark>{payload.sentence.slice(c.targetEnd)}</> : payload.sentence}</p>
    {!draft && <>
      <p>Одна конструкция и один вопрос. Генерация использует платный OpenAI API; автоматических повторов и сохранения нет.</p>
      <button type="button" disabled={!!busy} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) void generate(); }}>{busy === 'generating' ? 'Создаётся…' : 'Создать карточку'}</button>
    </>}
    {draft && <>
      <p>Проверьте и при необходимости исправьте карточку. Исходное предложение не изменяется.</p>
      <div className="grammar-fields">{editable.map(key => draft[key] !== null && <label key={key}>{labels[key]}
        <textarea aria-label={labels[key]} maxLength={limits[key]} value={draft[key] ?? ''} lang={key === 'translation' ? draft.targetLanguage : draft.explanationLanguage} dir="auto"
          disabled={!!busy || !!submitted.current} onChange={event => edit(key, event.target.value)} />
      </label>)}</div>
      {options.trustedPage && <label>Колода<input aria-label="Колода" maxLength={200} value={draft.deckName} disabled={!!busy || !!submitted.current}
        onChange={event => { if (draftRef.current && !pending.current && !submitted.current) updateDraft({ ...draftRef.current, deckName: event.target.value }); }} /></label>}
      <button type="button" disabled={!!busy} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) setShowPreview(value => !value); }}>Предпросмотр</button>
      <button type="button" disabled={!!busy || !!saved} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) void save(); }}>{saveLabel}</button>
      {submitted.current && !saved && !busy && <p>Карточка сохранена в этом окне и зафиксирована для этой операции. Повторная попытка сначала сверяет результат в Anki.{saveFailure === 'schema' ? ' Сам повтор добавления не исправляет несовместимый тип заметки.' : ''}</p>}
    </>}
    {saved && <p role="status">{saved.status === 'added' ? 'Добавлено в Anki' : 'Эта операция уже добавлена в Anki'}</p>}
    {error && <p role="alert">{error}</p>}
    {options.openSettings && <button type="button" disabled={!!busy} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) void Promise.resolve(options.openSettings?.()).catch(err => setError(errorText(err))); }}>{saveFailure === 'schema' ? 'Настроить тип грамматики' : 'Настройки'}</button>}
    {showPreview && draft && (preview ? <iframe className="preview" title="Предпросмотр карточки по грамматике" sandbox="" srcDoc={'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font-family:Arial,sans-serif;line-height:1.5}.construction{color:#dc2626;text-decoration:underline;font-weight:700}.sentence{white-space:pre-wrap}</style>' + preview.front + '<hr>' + preview.back} /> : <p role="alert">Исправьте поля, чтобы показать предпросмотр.</p>)}
  </section>;
}
