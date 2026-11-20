import { grammarFeatureLabel, grammarRequestCost } from './grammar-copy';
import { ContractValidationError } from '../../../../packages/contracts/src/validation.ts';
import { subscribeGrammarConsentChange } from '../runtime/grammar-consent';
import React, { useEffect, useRef, useState } from 'react';
import { validateGrammarDraft, validateGrammarLookupData } from '../../../../packages/contracts/src/grammar.ts';
import type { GrammarDraft, GrammarLookupResult, GrammarLookupPayload, GrammarNoFinding } from '../../../../packages/contracts/src/grammar.ts';
import type { Source } from '@english-reader/contracts';
import { renderGrammarPreview, grammarPreviewDocument } from '../../../../packages/note-templates/src/grammar.ts';
import { errorText, type UiRpc } from './interfaces';
import { isTrustedUiEvent } from './user-actions';
import grammarStyle from './grammar-popup.css?inline';
import { GrammarChat } from './GrammarChat';

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
type GrammarSettings = { grammarEnabled?: boolean; grammarIncludeExplanation?: boolean; grammarDeck?: string; defaultDeck?: string; grammarExplanationLanguage?: GrammarLookupPayload['explanationLanguage'] };
const editable = ['question', 'answer', 'rule', 'explanation', 'translation'] as const;
const labels = { question: 'Вопрос', answer: 'Ответ', rule: 'Правило', explanation: 'Объяснение', translation: 'Перевод предложения' };
const limits = { question: 500, answer: 1000, rule: 1000, explanation: 2000, translation: 2000 };

function SourceContext({chat,children}:{chat:boolean;children:React.ReactNode}) {
  return chat ? <details className="grammar-source grammar-chat-source"><summary>Исходное предложение</summary>{children}</details>
    : <div className="grammar-source"><span className="grammar-caption">Исходное предложение</span>{children}</div>;
}
type EscapeRegistration = (back: (() => void) | null) => void;
/** No generation, note creation or audio request occurs merely by opening this panel. */
export function GrammarPopup({ options, close, registerChatBack }: { options: GrammarPopupOptions; close: () => void; registerChatBack?: EscapeRegistration }) {
  const { rpc, payload, source } = options;
  const [draft, setDraft] = useState<GrammarDraft | null>(null);
  const [busy, setBusy] = useState<'generating' | 'saving' | ''>('');
  const [error, setError] = useState('');
  const [saveFailure, setSaveFailure] = useState<'schema' | 'transport' | 'conflict' | null>(null);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [expiredChatId, setExpiredChatId] = useState<string | null>(null);
  const chatOpener = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const chatSession = useRef<{ grammarId: string; sentence: string } | null>(null);
  function releaseChatSession() {
    const session = chatSession.current;
    chatSession.current = null;
    if (session) void rpc('grammar.chat.close', { grammarId: session.grammarId }).catch(() => {});
  }
  function returnToAnalysis() { returnFocus.current = true; setChatOpen(false); }
  useEffect(() => {
    if (!chatOpen && returnFocus.current) {
      returnFocus.current = false;
      chatOpener.current?.focus({ preventScroll: true });
    }
  }, [chatOpen]);
  const [availability, setAvailability] = useState<'checking' | 'enabled' | 'disabled' | 'unavailable'>('checking');
  const [empty, setEmpty] = useState<GrammarNoFinding['reason'] | null>(null);
  const availabilityRevision = useRef(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const lookupController = useRef<AbortController | null>(null);
  const draftRef = useRef<GrammarDraft | null>(null);
  const submitted = useRef<GrammarDraft | null>(null);
  const operationId = useRef(crypto.randomUUID());
  function updateDraft(value: GrammarDraft | null) { draftRef.current = value; setDraft(value); }
  async function generate(token = generation.current) {
    if (pending.current || submitted.current || draftRef.current) return;
    pending.current = true; setBusy('generating'); setError(''); setEmpty(null);
    const controller = new AbortController(); lookupController.current = controller;
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const settings = await rpc<GrammarSettings>('settings.getReader', {}, { signal: controller.signal });
      if (token !== generation.current || controller.signal.aborted) return;
      if (settings.grammarEnabled !== true) { setAvailability('disabled'); return; }
      setAvailability('enabled');
      const input: GrammarLookupPayload = { ...payload, includeExplanation: settings.grammarIncludeExplanation ?? payload.includeExplanation, explanationLanguage: settings.grammarExplanationLanguage ?? payload.explanationLanguage ?? payload.targetLanguage };
      const data = validateGrammarLookupData(await rpc<GrammarLookupResult>('grammar.lookup', input, { signal: controller.signal }), input);
      if (token !== generation.current) return;
      if (controller.signal.aborted) return;
      if ('reason' in data) { setEmpty(data.reason); return; }
      const { grammarId: _grammarId, ...content } = data;
      const next: GrammarDraft = { ...content, draftKind: 'grammar', draftVersion: 1,
        sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, explanationLanguage: input.explanationLanguage,
        learnerLevel: input.learnerLevel, deckName: settings.grammarDeck?.trim() || settings.defaultDeck || 'Default',
        tags: ['LanguageReader', 'Grammar'], source: structuredClone(source) };
      validateGrammarDraft(next);
      chatSession.current = { grammarId: data.grammarId, sentence: data.sentence };
      setExpiredChatId(null);
      updateDraft(next);
    } catch (err) {
      if (token !== generation.current) return;
      const code = typeof err === 'object' && err && 'code' in err ? err.code : '';
      if (code === 'PERMISSION_DENIED' || code === 'REQUEST_CANCELLED') await refreshAvailability(token);
      if (token === generation.current) {
        let reason = 'Не удалось получить разбор предложения.';
        if (err instanceof ContractValidationError || code === 'INVALID_MODEL_OUTPUT') reason = 'Ответ модели не прошёл проверку. Не удалось подтвердить разбор исходного предложения.';
        else if (code === 'NETWORK_TIMEOUT') reason = 'OpenAI не ответил вовремя.';
        else if (code === 'OPENAI_AUTH') reason = 'OpenAI не принял API-ключ. Проверьте его в настройках.';
        else if (code) reason = errorText(err);
        setError(controller.signal.aborted ? 'Разбор прерван.' : reason);
      }
    } finally {
      clearTimeout(timer);
      if (token === generation.current) { pending.current = false; setBusy(''); }
      if (lookupController.current === controller) lookupController.current = null;
    }
  }
  async function refreshAvailability(token: number) {
    const revision = ++availabilityRevision.current;
    try {
      const settings = await rpc<GrammarSettings>('settings.getReader');
      if (token !== generation.current || revision !== availabilityRevision.current) return;
      const enabled = settings.grammarEnabled === true;
      setAvailability(enabled ? 'enabled' : 'disabled');
      setError(current => current === 'Не удалось проверить, включён ли разбор предложения.' ? '' : current);
      if (!enabled) { lookupController.current?.abort(); releaseChatSession(); setChatOpen(false); }
    } catch {
      if (token === generation.current && revision === availabilityRevision.current) {
        setError('Не удалось проверить, включён ли разбор предложения.'); setAvailability('unavailable'); lookupController.current?.abort();
      }
    }
  }
  useEffect(() => {
    const token = ++generation.current;
    lookupController.current?.abort(); pending.current = false; submitted.current = null;
    operationId.current = crypto.randomUUID(); updateDraft(null); setBusy(''); setError(''); setSaveFailure(null); setSaved(null); setShowPreview(false);
    setChatOpen(false); returnFocus.current = false; setEmpty(null); setAvailability('checking');
    // autoGenerate is supplied only by the trusted clean-Alt activation adapter.
    if (options.autoGenerate === true) void generate(token);
    else void refreshAvailability(token);
    const focus = () => { void refreshAvailability(token); };
    const unsubscribe = subscribeGrammarConsentChange(() => {
      lookupController.current?.abort();
      setAvailability('checking');
      void refreshAvailability(token);
    });
    window.addEventListener('focus', focus);
    return () => { unsubscribe(); window.removeEventListener('focus', focus); generation.current++; releaseChatSession(); lookupController.current?.abort(); lookupController.current = null; pending.current = false; };
  }, [rpc, payload, source, options.autoGenerate]);
  function edit(key: typeof editable[number], value: string) {
    if (!draftRef.current || pending.current || submitted.current) return;
    updateDraft({ ...draftRef.current, [key]: value }); setError('');
  }
  async function save() {
    if (availability !== 'enabled' || pending.current || saved || !draftRef.current) return;
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
        if (code === 'PERMISSION_DENIED') { await refreshAvailability(token); }
        else if (code === 'ANKI_SCHEMA_MISMATCH') {
          setSaveFailure('schema');
          setError('Anki не подтвердил совместимость типа грамматики или вернул некорректный ответ. В настройках, раздел «Разбор и языковой чат», нажмите «Подготовить тип грамматики» и подтвердите создание отдельного совместимого типа при необходимости. Затем вернитесь к этой карточке: повторная генерация не нужна.');
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
  const dismiss = () => { generation.current++; lookupController.current?.abort(); releaseChatSession(); close(); };
  const c = draft?.construction;
  const saveLabel = busy === 'saving' ? 'Добавляется…' : saved || !submitted.current ? 'Добавить в Anki'
    : saveFailure === 'schema' ? 'Проверить после настройки' : saveFailure === 'transport' ? 'Проверить и повторить'
    : saveFailure === 'conflict' ? 'Проверить результат' : 'Повторить добавление';
  const disabled = availability === 'disabled';
  const verifiedDraft = draft && !disabled && (availability === 'enabled' || !!chatSession.current);
  const unavailable = availability === 'unavailable';
  const waiting = busy === 'generating' || (availability === 'checking' && !error);
  const emptyLabels = {
    lexical_only: ['Здесь достаточно перевода', 'Смысл выражения лучше разобрать по словам. Выделите выражение и нажмите Shift.'],
    no_construction: ['Отдельный разбор не нужен', 'В этом предложении нет конструкции, которую стоит разбирать отдельно.'],
    uncertain: ['Недостаточно контекста', 'По одному предложению трудно уверенно объяснить конструкцию. Попробуйте другой отрывок.'],
  };
  const state = disabled ? 'disabled' : unavailable ? 'error' : waiting ? 'loading' : draft ? 'ready' : empty ? 'empty' : error ? 'error' : 'idle';
  const inChat = chatOpen && !disabled && !!chatSession.current;
  const chatExpired = !!chatSession.current && chatSession.current.grammarId === expiredChatId;
  const chatActionLabel = chatExpired ? 'Открыть переписку этой карточки' : 'Открыть языковой чат';
  React.useLayoutEffect(() => {
    registerChatBack?.(inChat ? returnToAnalysis : null);
    return () => registerChatBack?.(null);
  }, [inChat, registerChatBack]);
  const title = inChat ? 'Языковой чат' : disabled ? 'Разбор предложения' : grammarFeatureLabel;
  return <section className="panel popup grammar-popup" data-state={state} role="dialog" aria-modal="false" aria-label={title} tabIndex={-1}
    data-grammar-chat-open={inChat || undefined} onKeyDown={event => {
      if (inChat && event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && isTrustedUiEvent(event.nativeEvent)) {
        event.preventDefault(); event.stopPropagation(); returnToAnalysis();
      }
    }}>
    <style>{grammarStyle}</style>
    <header className="grammar-heading"><h2>{title}</h2><button type="button" aria-label="Закрыть" onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) dismiss(); }}>×</button></header>
    <SourceContext chat={inChat}>
      <p className="sentence" lang={payload.sourceLanguage} dir="auto">{c && verifiedDraft ? <>{payload.sentence.slice(0, c.targetStart)}<mark>{payload.sentence.slice(c.targetStart, c.targetEnd)}</mark>{payload.sentence.slice(c.targetEnd)}</> : payload.sentence}</p>
    </SourceContext>
    {error && !disabled && !inChat && <p role="alert">{error}</p>}
    {!inChat && (disabled ? <div className="grammar-state" role="status"><h3>Разбор выключен</h3></div>
      : unavailable ? <div className="grammar-state">
        <button type="button" onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) { setError(''); setAvailability('checking'); void refreshAvailability(generation.current); } }}>Повторить</button></div>
      : waiting ? <p className="grammar-progress" role="status">{busy === 'generating' ? 'Разбираем предложение…' : 'Проверяем настройки…'}</p>
      : empty ? <div className="grammar-state" role="status"><h3>{emptyLabels[empty][0]}</h3><p>{emptyLabels[empty][1]}</p></div>
      : !draft && <div className="grammar-state">
        <button className="primary" type="button" aria-describedby="grammar-request-cost" disabled={!!busy} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) void generate(); }}>{error ? 'Повторить' : 'Разобрать предложение'}</button>
        <small id="grammar-request-cost">{grammarRequestCost}</small></div>)}
    {verifiedDraft && draft && !inChat && <>
      <div className="grammar-reading">
        <div><h3>Смысл в этом предложении</h3><p lang={draft.explanationLanguage} dir="auto">{draft.answer}</p></div>
        <div><h3>Что показывает форма</h3><p lang={draft.explanationLanguage} dir="auto">{draft.rule}</p></div>
      </div>
      <details className="grammar-more"><summary>Подробнее</summary>
        {draft.explanation && <p lang={draft.explanationLanguage} dir="auto">{draft.explanation}</p>}
        <h3>Перевод предложения</h3><p lang={draft.targetLanguage} dir="auto">{draft.translation}</p>
        <h3>Вопрос для повторения</h3><p lang={draft.explanationLanguage} dir="auto">{draft.question}</p>
      </details>
      <details className="grammar-edit"><summary>Редактировать карточку</summary>
        <div className="grammar-fields">{editable.map(key => draft[key] !== null && <label key={key}>{labels[key]}
          <textarea aria-label={labels[key]} maxLength={limits[key]} value={draft[key] ?? ''} lang={key === 'translation' ? draft.targetLanguage : draft.explanationLanguage} dir="auto"
            disabled={!!busy || !!submitted.current} onChange={event => edit(key, event.target.value)} />
        </label>)}</div>
        {options.trustedPage && <label>Колода<input aria-label="Колода" maxLength={200} value={draft.deckName} disabled={!!busy || !!submitted.current}
          onChange={event => { if (draftRef.current && !pending.current && !submitted.current) updateDraft({ ...draftRef.current, deckName: event.target.value }); }} /></label>}
      </details>
      <div className="grammar-actions"><button className="primary" type="button" disabled={availability !== 'enabled' || !!busy || !!saved} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) void save(); }}>{saveLabel}</button>
        <button type="button" aria-expanded={showPreview} disabled={!!busy} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) setShowPreview(value => !value); }}>Предпросмотр</button>
        {chatSession.current && <button type="button" className="grammar-chat-launch" ref={chatOpener} aria-label={chatActionLabel}
          title={chatActionLabel} aria-expanded={false} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) setChatOpen(true); }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 13.2a3 3 0 0 1-3 3H9l-5 3.5V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>
            <path d="M9.4 8.1a2.1 2.1 0 0 1 4 .9c0 1.4-1.9 1.6-1.9 2.8m0 1.6h.01"/>
          </svg><span>{chatExpired ? 'Переписка' : 'Языковой чат'}</span>
        </button>}</div>
      {submitted.current && !saved && !busy && <p>Карточка сохранена в этом окне и зафиксирована для этой операции. Повторная попытка сначала сверяет результат в Anki.{saveFailure === 'schema' ? ' Сам повтор добавления не исправляет несовместимый тип заметки.' : ''}</p>}
    </>}
    {draft && chatSession.current && !disabled && <GrammarChat key={chatSession.current.grammarId}
      rpc={rpc} grammarId={chatSession.current.grammarId} sentence={chatSession.current.sentence} construction={draft.construction.text} explanationLanguage={draft.explanationLanguage}
      open={inChat} onBack={returnToAnalysis} onExpired={() => setExpiredChatId(chatSession.current?.grammarId ?? null)} onPermissionError={() => { void refreshAvailability(generation.current); }} />}
    {saved && !inChat && <p role="status">{saved.status === 'added' ? 'Добавлено в Anki' : 'Эта операция уже добавлена в Anki'}</p>}
    {!inChat && options.openSettings && (disabled || error) && <button type="button" disabled={!!busy} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) void Promise.resolve(options.openSettings?.()).catch(err => setError(errorText(err))); }}>{saveFailure === 'schema' ? 'Настроить тип грамматики' : 'Настройки'}</button>}
    {!inChat && showPreview && availability === 'enabled' && draft && (preview ? <div className="grammar-preview">
      <h3>Лицевая сторона</h3><iframe className="preview" title="Лицевая сторона карточки по грамматике" sandbox="" srcDoc={grammarPreviewDocument(preview.front)} />
      <h3>Обратная сторона</h3><iframe className="preview" title="Обратная сторона карточки по грамматике" sandbox="" srcDoc={grammarPreviewDocument(preview.back)} />
    </div> : <p role="alert">Исправьте поля, чтобы показать предпросмотр.</p>)}
  </section>;
}
