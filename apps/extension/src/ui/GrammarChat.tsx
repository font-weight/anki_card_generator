import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isLanguageChatText } from '../../../../packages/contracts/src/language-chat-text';
import { grammarQuestionSuggestions, GRAMMAR_QUESTION_LIMIT, GRAMMAR_ANSWER_LIMIT } from '../../../../packages/contracts/src/grammar-question';
import { readLookupDiagnostics, type LanguageCode, type GrammarChatReply } from '@english-reader/contracts';
import { lookupDiagnosticText } from './lookup-feedback';
import { languageChatContext, languageChatCost } from './grammar-copy';
import {LanguageChatMarkdown} from './LanguageChatMarkdown';
import type { UiRpc } from './interfaces';
import { isTrustedUiEvent } from './user-actions';

interface Props {
  rpc: UiRpc;
  grammarId: string;
  sentence: string;
  construction: string;
  explanationLanguage: LanguageCode;
  open: boolean;
  onBack: () => void;
  onPermissionError: () => void;
  onExpired: () => void;
}

// A retry gets a fresh transport identity while retaining the displayed question.
type Turn = { turnId: string; rowId: string; question: string };
type Message = Turn & (GrammarChatReply | {kind:'failed';message:string});
type Failure = { turn: Turn; draftRevision:number; message: string; canRetry: boolean; closed: boolean; expired?: boolean; uncertain?: boolean };

type DisplayTurn = Message | (Turn & {kind:'pending'}) | (Turn & {kind:'failure';failure:Failure});
const count = new Intl.NumberFormat('ru-RU');

function selectionIn(thread: HTMLElement) {
  const root = thread.getRootNode() as Document | (ShadowRoot & {getSelection?: () => Selection | null});
  const selection = root.getSelection?.() ?? thread.ownerDocument.getSelection();
  return selection && !selection.isCollapsed && (thread.contains(selection.anchorNode) || thread.contains(selection.focusNode));
}

function useChatReadingPosition(open: boolean, completedAttempt?: string) {
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef<{id: string; top: number} | null>(null);
  const remembered = useRef(0);

  useLayoutEffect(() => {
    const panel = log.current?.closest<HTMLElement>('.grammar-popup');
    if (!open || !panel) return;
    panel.scrollTop = remembered.current;
    const remember = () => { remembered.current = panel.scrollTop; };
    const cancelFollow = () => { follow.current = null; };
    const readerActions = ['wheel','pointerdown','touchstart','keydown','input','selectstart'] as const;
    for (const action of readerActions) panel.addEventListener(action,cancelFollow,{passive:true,capture:true});
    panel.addEventListener('scroll',remember,{passive:true});
    return () => {
      follow.current = null;
      for (const action of readerActions) panel.removeEventListener(action,cancelFollow,true);
      panel.removeEventListener('scroll',remember);
    };
  }, [open]);

  useLayoutEffect(() => {
    const intent = follow.current, thread = log.current;
    if (!open || !intent || !thread || intent.id !== completedAttempt) return;
    follow.current = null;
    const panel = thread.closest<HTMLElement>('.grammar-popup'), row = thread.lastElementChild;
    if (!panel || !row || !panel.clientHeight || Math.abs(panel.scrollTop-intent.top)>8 || selectionIn(thread)) return;
    const inset = 12, viewport = panel.getBoundingClientRect(), bounds = row.getBoundingClientRect();
    if (bounds.top >= viewport.top+inset && bounds.bottom <= viewport.bottom-inset) return;
    const answer = row.querySelector('.grammar-chat-answer')?.getBoundingClientRect();
    // A multi-paragraph question can itself be taller than the popup.
    const top = answer && answer.top-bounds.top>panel.clientHeight/2 ? answer.top : bounds.top;
    panel.scrollTop = Math.max(0, Math.min(panel.scrollHeight-panel.clientHeight, panel.scrollTop+top-viewport.top-inset));
    remembered.current = panel.scrollTop;
  }, [open,completedAttempt]);

  function followAttempt(id: string) {
    const panel = log.current?.closest<HTMLElement>('.grammar-popup');
    follow.current = panel ? {id,top:panel.scrollTop} : null;
  }
  return {log,followAttempt};
}

export function GrammarChat({ rpc, grammarId, sentence, construction, explanationLanguage, open, onBack, onPermissionError, onExpired }: Props) {
  const [question, setQuestion] = useState('');
  const [copyHint, setCopyHint] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasAnswer, setHasAnswer] = useState(false);
  const [sending, setSending] = useState<Turn | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const pending = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const editRevision = useRef(0);
  const dispatched = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const completedAttempt = sending ? undefined : failure?.turn.turnId ?? messages.at(-1)?.turnId;
  const {log,followAttempt} = useChatReadingPosition(open,completedAttempt);

  function editQuestion(value: string) {
    editRevision.current++;
    setQuestion(value);
  }

  function selectDraft() {
    const input = field.current;
    if (!failure?.expired || !input) return;
    input.focus();
    input.select();
    // The selection is usable with the device's normal Copy action, including when
    // clipboard APIs are unavailable inside an untrusted page or its shadow root.
    setCopyHint('Текст выделен. Используйте команду копирования вашего устройства.');
  }

  function appendMessage(message: Message) {
    setMessages(history => [...history,message]);
  }

  // The chat stays mounted while this card shows its analysis or preview.
  // Its requests live until the card closes, its context changes, or consent is revoked.
  useLayoutEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  useEffect(() => { if (open) field.current?.focus({preventScroll:true}); }, [open]);

  async function send(turn: Turn) {
    if (!open || pending.current || failure?.closed || !turn.question.trim() || turn.question.length > GRAMMAR_QUESTION_LIMIT) return;
    const controller = new AbortController();
    pending.current = controller;
    const submittedRevision = editRevision.current;
    const matchesField = question.trim() === turn.question;
    followAttempt(turn.turnId);
    if (failure && failure.turn.rowId !== turn.rowId) {
      appendMessage({ ...failure.turn, kind: 'failed', message: failure.message });
    }
    dispatched.current = false;
    setFailure(null); setSending(turn); field.current?.focus({ preventScroll: true });
    try {
      const settings = await rpc<{grammarEnabled?: boolean}>('settings.getReader', {}, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!settings.grammarEnabled) {
        setFailure({ turn, draftRevision:submittedRevision, message: 'Разбор предложения и языковой чат выключены в настройках.', canRetry: false, closed: true });
        onPermissionError(); return;
      }
      dispatched.current = true;
      const turnNumber = ++sequence.current;
      const reply = await rpc<GrammarChatReply>('grammar.chat', { grammarId, sentence, turnId:turn.turnId, question:turn.question, turnNumber }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!reply || reply.grammarId !== grammarId || reply.turnId !== turn.turnId ||
          !(reply.kind === 'topic_reset' || reply.kind === 'out_of_scope' || reply.kind === 'model_out_of_scope' || reply.kind === 'model_no_answer' || (reply.kind === 'answer' && typeof reply.answer === 'string' && reply.answer.length <= GRAMMAR_ANSWER_LIMIT && isLanguageChatText(reply.answer)))) {
        throw new Error('Invalid reply');
      }
      appendMessage({ ...turn, ...reply });
      if (reply.kind === 'answer' || reply.kind === 'topic_reset') {
        setHasAnswer(reply.kind === 'answer');
        if (matchesField && submittedRevision === editRevision.current) setQuestion('');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === 'PERMISSION_DENIED') onPermissionError();
      if (code === 'LOOKUP_EXPIRED') onExpired();
      const closed = code === 'LOOKUP_EXPIRED' || code === 'PERMISSION_DENIED';
      const diagnostics = readLookupDiagnostics(error && typeof error === 'object' && 'diagnostics' in error ? error.diagnostics : undefined);
      const providerDetail = diagnostics && (code === 'INVALID_MODEL_OUTPUT' || code === 'MODEL_INCOMPLETE' && diagnostics.reason === 'output_token_limit')
        ? (diagnostics.reason === 'output_missing' ? 'В ответе модели нет текста.' : lookupDiagnosticText(diagnostics).reason) : undefined;
      const message = providerDetail ?? (diagnostics?.reason === 'response_interrupted' ? 'Соединение с OpenAI прервалось до получения полного ответа.'
        : code === 'LOOKUP_EXPIRED' ? 'Этот чат завершён и больше не принимает вопросы. Переписка и черновик остались в этом окне.'
        : code === 'PERMISSION_DENIED' ? 'Языковой чат недоступен. Проверьте, включён ли он в настройках.'
        : code === 'OPERATION_CONFLICT' ? 'Другой запрос ещё обрабатывается. Повторите вопрос, когда он завершится.'
        : code === 'REQUEST_CANCELLED' ? 'Запрос был прерван.'
        : code === 'MODEL_REFUSAL' ? 'Модель отклонила запрос и не дала ответа.'
        : code === 'MODEL_INCOMPLETE' ? 'Ответ модели пришёл не полностью.'
        : code === 'INVALID_MODEL_OUTPUT' ? 'Не удалось подтвердить ответ модели.'
        : code === 'NETWORK_TIMEOUT' ? 'OpenAI не ответил вовремя.'
        : code === 'OPENAI_AUTH' ? 'OpenAI не принял API-ключ. Проверьте его в настройках.'
        : !dispatched.current ? 'Не удалось проверить настройки языкового чата. Вопрос не отправлен.'
        : 'Не удалось получить ответ на вопрос.');
      const uncertain = dispatched.current && !closed && !['OPERATION_CONFLICT', 'OPENAI_AUTH'].includes(String(code));
      setFailure({ turn, draftRevision:submittedRevision, message, closed, expired: code === 'LOOKUP_EXPIRED', canRetry: !closed, uncertain });
    } finally {
      if (pending.current === controller) { pending.current = null; setSending(null); }
    }
  }
  if (!open) return null;
  const suggestions = grammarQuestionSuggestions(construction, hasAnswer);
  const retrying = failure?.canRetry === true && editRevision.current === failure.draftRevision && question.trim() === failure.turn.question;
  const turns: DisplayTurn[] = [...messages];
  if (sending) turns.push({...sending,kind:'pending'});
  else if (failure) turns.push({...failure.turn,kind:'failure',failure});
  return <section className="grammar-chat" aria-label="Языковой чат">
    {!failure?.expired && <button className="grammar-chat-back" type="button" onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) onBack(); }}>← К разбору</button>}
    <p className="grammar-chat-scope">Переписка доступна, пока открыта эта карточка. У следующего слова будет свой чат.</p>
    <div className="grammar-chat-thread" ref={log} role="log" tabIndex={messages.length > 0 || sending || failure ? 0 : undefined} aria-label="Вопросы и ответы" aria-live="polite">
      {turns.map(turn=><div className="grammar-chat-turn" key={turn.rowId}>
        <p className="grammar-chat-question"><strong>Вы</strong><span dir="auto">{turn.question}</span></p>
        {turn.kind==='answer'?<div className="grammar-chat-answer"><strong>Ответ</strong><LanguageChatMarkdown language={explanationLanguage} text={turn.answer}/>{turn.source==='analysis'&&<small>Из разбора предложения · без запроса в OpenAI</small>}</div>
          :turn.kind==='pending'?<p role="status" className="grammar-chat-notice">Готовим ответ…</p>
          :turn.kind==='failure'?<div className="grammar-chat-failure">
            <p role="alert">{turn.failure.message}</p>
            {turn.failure.uncertain && <p className="grammar-chat-retry-cost" id="grammar-chat-retry-cost">Предыдущий запрос мог израсходовать токены. Повтор отправит новый запрос.</p>}
          </div>
          :<p className="grammar-chat-notice">{turn.kind==='failed'?turn.message:
            turn.kind==='topic_reset'?'Новая тема. Введите первый вопрос. Смена темы бесплатна.':
            turn.kind==='model_out_of_scope'?'По оценке модели, запрос не об изучении языка. Уточните, что вы хотите разобрать или потренировать.':
            turn.kind==='model_no_answer'?'Модель сообщила, что ей недостаточно сведений для уверенного объяснения. Вы можете добавить пример или задать следующий вопрос.':
            'Назовите языковую тему или опишите упражнение. Запрос в OpenAI не отправлялся.'}</p>}
      </div>)}

    </div>
    {(!failure?.closed || failure.expired) && <div className={failure?.expired ? 'grammar-chat-compose grammar-chat-recovery' : 'grammar-chat-compose'}>
      <div className="grammar-chat-input-heading"><label htmlFor="grammar-chat-question">{failure?.expired ? 'Черновик вопроса' : 'Ваш вопрос'}</label>
        <small id="grammar-chat-count">{count.format(question.length)} / {count.format(GRAMMAR_QUESTION_LIMIT)} знаков</small></div>
      <textarea id="grammar-chat-question" ref={field} rows={3} aria-describedby="grammar-chat-count" maxLength={GRAMMAR_QUESTION_LIMIT} value={question}
        readOnly={!!failure?.expired} placeholder={failure?.expired ? 'Поле было пустым' : 'Например, объясни Present Perfect или дай упражнение на предлоги'} onChange={event => {
          if (!failure?.expired) editQuestion(event.target.value);
        }} />
      {failure?.expired ? <>
        <div className="grammar-chat-recovery-actions">
          <button type="button" disabled={!question} onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) selectDraft(); }}>Выделить для копирования</button>
          <button className="primary" type="button" onClick={event => { if (isTrustedUiEvent(event.nativeEvent)) onBack(); }}>Вернуться к разбору</button>
        </div>
        {copyHint && <small role="status">{copyHint}</small>}
      </> : <>
      <div className="grammar-chat-suggestions" role="group" aria-label="Подсказки для вопроса">
        <span>Можно спросить</span>
        <div className="grammar-chat-options">{suggestions.map(suggestion =>
          <button key={suggestion} type="button" aria-controls="grammar-chat-question" onClick={event => {
            if (!isTrustedUiEvent(event.nativeEvent)) return;
            editQuestion(suggestion);
            field.current?.focus();
          }}>{suggestion}</button>
        )}</div>
      </div>
      <small id="grammar-chat-cost">{languageChatCost} Дословную формулировку правила можно взять из текущего разбора бесплатно. Запрос к модели может расходовать токены и при отказе.</small>
      <details className="grammar-chat-privacy"><summary>Что отправляется в OpenAI</summary><small>{languageChatContext}</small></details>
      <button type="button" className="primary" aria-describedby={retrying && failure?.uncertain ? 'grammar-chat-cost grammar-chat-retry-cost' : 'grammar-chat-cost'} disabled={!!sending || !question.trim() || question.length > GRAMMAR_QUESTION_LIMIT}
        onClick={event => {
          if (!isTrustedUiEvent(event.nativeEvent)) return;
          const turnId=crypto.randomUUID();
          void send({turnId,rowId:retrying && failure ? failure.turn.rowId : turnId,question:question.trim()});
        }}>{retrying ? 'Повторить' : 'Отправить'}</button>
      </>}
    </div>}
  </section>;
}
