import React, { act } from 'react';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrammarPopup } from '../../apps/extension/src/ui/GrammarPopup';
import type { GrammarPopupOptions } from '../../apps/extension/src/ui/GrammarPopup';
import type { GrammarLookupPayload } from '../../packages/contracts/src/grammar.ts';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';
import * as consent from '../../apps/extension/src/runtime/grammar-consent';
import * as userActions from '../../apps/extension/src/ui/user-actions';
const payload: GrammarLookupPayload = { sentence: 'They were sitting nearby.', sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru', learnerLevel: 'B1', includeExplanation: true };
const data = { grammarId: '12345678-1234-4234-8234-123456789abc', sentence: payload.sentence, construction: { text: 'were sitting', targetStart: 5, targetEnd: 17 }, question: 'Что выражает were sitting?', answer: 'Действие в процессе в прошлом.', rule: 'Форма were sitting показывает, что они уже сидели в описываемый момент.', explanation: 'Сравните с фразой «They sat down nearby». Здесь говорится, что они сели.', translation: 'Они сидели неподалёку.' };
const source = { kind: 'html', title: 'Synthetic', url: 'https://example.com', documentId: null, page: null, chapter: null, cfi: null } as const;
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.spyOn(userActions, 'isTrustedUiEvent').mockReturnValue(true); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fake(overrides: Record<string, unknown> = {}): UiRpc {
  return vi.fn(async (type: string, body?: Record<string, unknown>) => {
    if (type in overrides) { const val = overrides[type]; return typeof val === 'function' ? val(body) : val; }
    if (type === 'settings.getReader') return { grammarEnabled: true, grammarDeck: '', defaultDeck: 'Default' };
    if (type === 'grammar.lookup') return structuredClone(data);
    if (type === 'grammar.addNote') return { operationId: body!.operationId, status: 'added', noteId: 123 };
    return {};
  }) as UiRpc;
}
function opts(rpc: UiRpc, extra: Partial<GrammarPopupOptions> = {}): GrammarPopupOptions { return { rpc, payload, source, ...extra }; }
async function render(options: GrammarPopupOptions, close = vi.fn()) { await act(async () => root.render(<GrammarPopup options={options} close={close} />)); }
function button(text: string) { return [...node.querySelectorAll('button')].find(b => b.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function edit(label: string, value: string) { const field = node.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
function calls(rpc: UiRpc, type: string) { return vi.mocked(rpc).mock.calls.filter(call => call[0] === type); }
describe('grammar popup', () => {
  it('opens idle, preserves the original sentence and never auto-generates or saves on normal reopen', async () => {
    const rpc = fake(); await render(opts(rpc)); expect(calls(rpc, 'grammar.lookup')).toHaveLength(0); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0); expect(node.querySelector('.sentence')?.textContent).toBe(payload.sentence);
    await render(opts(rpc, { payload: { ...payload } })); expect(calls(rpc, 'grammar.lookup')).toHaveLength(0); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
    expect(node.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('false');
    expect(node.querySelector('h2')?.textContent).toBe('Разбор предложения по левому Alt');
    expect(node.querySelector('#grammar-request-cost')?.textContent).toContain('Это платный запрос.');
    expect(button('Разобрать предложение').getAttribute('aria-describedby')).toBe('grammar-request-cost');
  });
  it('explicit Generate creates one editable draft and uses optional grammar deck fallback without saving', async () => {
    const rpc = fake(); await render(opts(rpc, { trustedPage: true }));
    await act(async () => { button('Разобрать предложение').click(); button('Разобрать предложение').click(); });
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(1); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
    expect(node.querySelector('.sentence')?.textContent).toBe(payload.sentence); expect(node.querySelector('mark')?.textContent).toBe('were sitting');
    expect(node.querySelectorAll('textarea')).toHaveLength(5); expect(node.querySelector<HTMLInputElement>('input[aria-label="Колода"]')?.value).toBe('Default');
    expect(calls(rpc, 'audio.prepare')).toHaveLength(0); expect(node.textContent).not.toMatch(/Cloze/);
  });
  it('disabled grammar cannot generate even with an autoGenerate request', async () => {
    const rpc = fake({ 'settings.getReader': { grammarEnabled: false } }); await render(opts(rpc, { autoGenerate: true }));
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(0); expect(node.querySelector('[role="status"]')?.textContent).toContain('Разбор выключен'); expect(node.textContent).not.toContain('Alt');
  });
  it('only the explicitly opted-in Alt path can request automatic generation', async () => {
    const rpc = fake(); await render(opts(rpc, { autoGenerate: true }));
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(1); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
  });
  it('untrusted clicks do not generate', async () => {
    vi.mocked(userActions.isTrustedUiEvent).mockReturnValue(false);
    const rpc = fake(); await render(opts(rpc)); await click('Разобрать предложение'); expect(calls(rpc, 'grammar.lookup')).toHaveLength(0); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
  });
  it('manual Add uses edited fields, preserves sentence and blocks duplicate click', async () => {
    let finish!: (value: unknown) => void;
    const rpc = fake({ 'grammar.addNote': () => new Promise(resolve => { finish = resolve; }) });
    await render(opts(rpc)); await click('Разобрать предложение'); await edit('Ответ', 'Исправленный ответ.');
    await act(async () => { button('Добавить в Anki').click(); button('Добавить в Anki').click(); });
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1);
    const body = calls(rpc, 'grammar.addNote')[0][1] as any; expect(body.draft.answer).toBe('Исправленный ответ.'); expect(body.draft.sentence).toBe(payload.sentence);
    await act(async () => finish({ operationId: body.operationId, status: 'added', noteId: 12 })); expect(node.textContent).toContain('Добавлено в Anki');
    expect(node.querySelector('textarea')?.disabled).toBe(true);
  });
  it('validation failure remains editable and never dispatches Add', async () => {
    const rpc = fake(); await render(opts(rpc)); await click('Разобрать предложение'); await edit('Ответ', ''); await click('Добавить в Anki');
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(0); expect(node.querySelector('textarea')?.disabled).toBe(false);
  });
  it('uncertain Add retries only explicitly with the same immutable operation', async () => {
    let attempts = 0;
    const rpc = fake({ 'grammar.addNote': (body: any) => { if (++attempts === 1) throw new Error('Uncertain'); return { operationId: body.operationId, status: 'already_added', noteId: 12 }; } });
    await render(opts(rpc)); await click('Разобрать предложение'); await click('Добавить в Anki');
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1); expect(node.querySelector('textarea')?.disabled).toBe(true);
    await click('Повторить добавление'); expect(calls(rpc, 'grammar.addNote')).toHaveLength(2);
    expect(calls(rpc, 'grammar.addNote')[1][1]).toEqual(calls(rpc, 'grammar.addNote')[0][1]); expect(node.textContent).toContain('уже добавлена');
  });
  it('schema failure directs setup, keeps the draft, and retries only the same operation after returning', async () => {
    let attempts = 0;
    const openSettings = vi.fn();
    const rpc = fake({ 'grammar.addNote': (body: any) => {
      if (++attempts === 1) throw Object.assign(new Error('Поля типа заметки несовместимы.'), { code: 'ANKI_SCHEMA_MISMATCH', retryable: false });
      return { operationId: body.operationId, status: 'added', noteId: 81 };
    } });
    await render(opts(rpc, { trustedPage: true, openSettings }));
    await click('Разобрать предложение'); await edit('Ответ', 'Проверенный ответ.'); await click('Добавить в Anki');
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Подготовить тип грамматики');
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('повторная генерация не нужна');
    expect(node.textContent).toContain('Сам повтор добавления не исправляет');
    expect(button('Повторить добавление')).toBeUndefined();
    expect(node.querySelector('textarea')?.disabled).toBe(true);
    await click('Настроить тип грамматики');
    expect(openSettings).toHaveBeenCalledOnce();
    expect(calls(rpc, 'grammar.initializeModel')).toHaveLength(0);
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1);
    expect(node.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ответ"]')?.value).toBe('Проверенный ответ.');
    await click('Проверить после настройки');
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(2);
    expect(calls(rpc, 'grammar.addNote')[1][1]).toEqual(calls(rpc, 'grammar.addNote')[0][1]);
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(1);
    expect(node.textContent).toContain('Добавлено в Anki');
  });
  it('transport failure offers a guarded connection retry rather than model setup', async () => {
    const rpc = fake({ 'grammar.addNote': () => { throw Object.assign(new Error('Timeout'), { code: 'NETWORK_TIMEOUT', retryable: true }); } });
    await render(opts(rpc, { openSettings: vi.fn() })); await click('Разобрать предложение'); await click('Добавить в Anki');
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Anki открыт');
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('не будет отправлена повторно вслепую');
    expect(button('Проверить и повторить')).toBeDefined();
    expect(button('Настройки')).toBeDefined();
    expect(button('Настроить тип грамматики')).toBeUndefined();
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1);
    await click('Проверить и повторить');
    expect(calls(rpc, 'grammar.addNote')[1][1]).toEqual(calls(rpc, 'grammar.addNote')[0][1]);
  });
  it('an unresolved operation offers reconciliation, not a new generation or blind add', async () => {
    const rpc = fake({ 'grammar.addNote': () => { throw Object.assign(new Error('Conflict'), { code: 'OPERATION_CONFLICT', retryable: false }); } });
    await render(opts(rpc)); await click('Разобрать предложение'); await click('Добавить в Anki');
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Повторная отправка заблокирована');
    expect(button('Проверить результат')).toBeDefined();
    expect(button('Разобрать предложение')).toBeUndefined();
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1);
    expect(node.querySelector('textarea')?.disabled).toBe(true);
  });
  it('selection replacement clears old schema recovery and ignores an old save result', async () => {
    let resolve!: (value: unknown) => void;
    const rpc = fake({ 'grammar.addNote': () => new Promise(r => { resolve = r; }) });
    await render(opts(rpc)); await click('Разобрать предложение'); await click('Добавить в Anki');
    const old = calls(rpc, 'grammar.addNote')[0][1] as any;
    await render(opts(rpc, { payload: { ...payload, sentence: 'We are leaving now.' } }));
    await act(async () => resolve({ operationId: old.operationId, status: 'added', noteId: 12 }));
    expect(node.querySelector('.sentence')?.textContent).toBe('We are leaving now.');
    expect(node.querySelector('textarea')).toBeNull();
    expect(node.textContent).not.toContain('Добавлено в Anki');
    expect(button('Проверить после настройки')).toBeUndefined();
  });
  it('preview is same-renderer, sandboxed and does not add a note', async () => {
    const rpc = fake(); await render(opts(rpc)); await click('Разобрать предложение'); await click('Предпросмотр');
    const frames=Array.from(node.querySelectorAll('iframe'));
    expect(frames).toHaveLength(2);
    for(const frame of frames){expect(frame.getAttribute('sandbox')).toBe('');expect(frame.srcdoc).toContain('were sitting');expect(frame.srcdoc).toContain('font-family: Arial');}
    expect(frames[0]!.srcdoc).not.toContain(data.rule);expect(frames[1]!.srcdoc).toContain(data.rule);
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
  });
  it('closing or replacing a pending request aborts it and ignores late output', async () => {
    let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined;
    const rpc = vi.fn(async (type, _body, options) => { if (type === 'settings.getReader') return { grammarEnabled: true }; signal = options?.signal; return new Promise(r => { resolve = r; }); }) as UiRpc;
    const close = vi.fn(); await render(opts(rpc), close); await click('Разобрать предложение');
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="Закрыть"]')!.click()); expect(close).toHaveBeenCalledOnce(); expect(signal?.aborted).toBe(true);
    await act(async () => resolve(structuredClone(data))); expect(node.querySelector('textarea')).toBeNull();
  });
  it('new selection resets old fields and never accepts a stale result', async () => {
    let resolveOld!: (value: unknown) => void;
    const rpc = fake({ 'grammar.lookup': () => new Promise(r => { resolveOld = r; }) });
    await render(opts(rpc)); await click('Разобрать предложение');
    const next = { ...payload, sentence: 'We are leaving now.' }; await render(opts(rpc, { payload: next }));
    await act(async () => resolveOld(structuredClone(data))); expect(node.querySelector('.sentence')?.textContent).toBe(next.sentence); expect(node.querySelector('textarea')).toBeNull();
  });
  it('keeps a lexical-only result out of the editor and from Anki', async () => {
    const sentence = 'She put off the trip until Monday.';
    const rpc = fake({'grammar.lookup':{grammarId:data.grammarId,sentence,reason:'lexical_only'}});
    await render(opts(rpc, {payload:{...payload,sentence},autoGenerate:true}));
    expect(node.textContent).toContain('Здесь достаточно перевода');
    expect(node.querySelector('mark,textarea')).toBeNull();
    expect(button('Добавить в Anki')).toBeUndefined();
    expect(calls(rpc,'grammar.addNote')).toHaveLength(0);
  });
  it('displays the answer and its contextual purpose before the optional details', async () => {
    const rpc = fake(); await render(opts(rpc)); await click('Разобрать предложение');
    const blocks=node.querySelectorAll('.grammar-reading > div');
    expect(blocks[0]?.textContent).toContain(data.answer);expect(blocks[1]?.textContent).toContain(data.rule);
    expect(node.querySelector('.grammar-more')?.hasAttribute('open')).toBe(false);
    expect(node.querySelector('.grammar-edit')?.hasAttribute('open')).toBe(false);
    expect(node.querySelector('.grammar-more')?.textContent).toContain(data.explanation);
  });
  it('allows an explicit retry after lookup failure and never retries by itself',async()=>{
    let attempts=0;const rpc=fake({'grammar.lookup':()=>{if (++attempts===1) throw Object.assign(Error('Timeout'),{code:'NETWORK_TIMEOUT'});return data;}});
    await render(opts(rpc));await click('Разобрать предложение');
    expect(node.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error');
    const alert=node.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('OpenAI не ответил вовремя.');
    expect(alert.compareDocumentPosition(button('Повторить')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attempts).toBe(1);await click('Повторить');expect(attempts).toBe(2);
    expect(node.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready');
  });
  it('invalid model response is surfaced without hidden re-request', async () => {
    const rpc = fake({ 'grammar.lookup': { ...data, sentence: 'Changed sentence.' } });
    await render(opts(rpc)); await click('Разобрать предложение'); expect(calls(rpc, 'grammar.lookup')).toHaveLength(1);
    expect(node.querySelector('textarea')).toBeNull(); expect(node.querySelector('[role="alert"]')).not.toBeNull();
  });
});

it('observes consent revoked in another window without focus and cancels an ongoing provider lookup',async()=>{
 let enabled=true,notify!:()=>void,signal:AbortSignal|undefined,finish!:(result:unknown)=>void;
 vi.spyOn(consent,'subscribeGrammarConsentChange').mockImplementation(callback=>{notify=callback;return ()=>{};});
 const call=vi.fn(async(type:string,_body?:Record<string,unknown>,options?:{signal?:AbortSignal})=>{
  if(type==='settings.getReader')return {grammarEnabled:enabled};
  signal=options?.signal;return new Promise(resolve=>{finish=resolve;});
 }) as UiRpc;
 await render(opts(call,{autoGenerate:true}));expect(signal?.aborted).toBe(false);
 enabled=false;await act(async()=>notify());
 expect(signal?.aborted).toBe(true);expect(node.querySelector('[data-state="disabled"]')).not.toBeNull();
 await act(async()=>finish(data));expect(node.querySelector('textarea')).toBeNull();expect(calls(call,'grammar.lookup')).toHaveLength(1);
});

const launchChat = () => node.querySelector<HTMLButtonElement>('button[aria-label="Открыть языковой чат"]')!;
async function enterQuestion(value: string) {
  const field = node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openChat() { await act(async () => launchChat().click()); }
function answer(body: any, text = 'Форма were sitting показывает продолжающееся действие.') {
  return { grammarId: body.grammarId, turnId: body.turnId, kind: 'answer', answer: text };
}
it('opens a scoped chat only on an explicit button, keeps immutable source and requires a trusted send after disclosure', async () => {
  const rpc = fake({'grammar.chat': answer});
  await render(opts(rpc, {autoGenerate: true}));
  const buttons = [...node.querySelectorAll('.grammar-actions button')];
  expect(buttons.slice(-2)).toEqual([button('Предпросмотр'), launchChat()]);
  expect(launchChat().textContent).toContain('Языковой чат');
  await edit('Ответ', 'Мой черновик.');
  await openChat();
  expect(document.activeElement).toBe(node.querySelector('#grammar-chat-question'));
  expect(node.querySelector('.sentence')?.textContent).toBe(payload.sentence);
  expect(node.querySelector('.sentence mark')?.textContent).toBe('were sitting');
  expect(node.querySelector('#grammar-chat-cost')?.textContent).toMatch(/OpenAI.*токены/);
  expect(button('Отправить').disabled).toBe(true);
  await enterQuestion('Почему здесь were sitting?');
  expect(calls(rpc, 'grammar.chat')).toHaveLength(0);
  vi.mocked(userActions.isTrustedUiEvent).mockReturnValue(false);
  await click('Отправить'); expect(calls(rpc, 'grammar.chat')).toHaveLength(0);
  vi.mocked(userActions.isTrustedUiEvent).mockReturnValue(true);
  await click('Отправить');
  const call = calls(rpc, 'grammar.chat').at(0)?.[1];
  expect(call).toEqual({grammarId: data.grammarId, sentence: payload.sentence, question: 'Почему здесь were sitting?', turnId: expect.any(String), turnNumber: 1});
  expect(node.querySelector('.grammar-chat-answer')).toBeTruthy();
  await click('← К разбору'); expect(document.activeElement).toBe(launchChat());
  await openChat(); expect(node.querySelectorAll('.grammar-chat-answer')).toHaveLength(1);
  await click('← К разбору'); await click('Добавить в Anki');
  const sent = calls(rpc, 'grammar.addNote')[0][1] as any;
  expect(sent.draft.answer).toBe('Мой черновик.');
  expect(JSON.stringify(sent.draft)).not.toContain('Почему здесь were sitting?');
});
it('ignores duplicate sends, accepts a scope refusal and explicitly retries a failed step with a new turn id', async () => {
  let release!: (reply: unknown) => void;
  let attempts = 0;
  const rpc = fake({'grammar.chat': (body:any) => {
    if (++attempts === 1) return new Promise(r => { release = r; });
    if (attempts === 2) throw Object.assign(new Error('timeout'), { code: 'NETWORK_TIMEOUT' });
    return answer(body);
  }});
  await render(opts(rpc, {autoGenerate: true})); await openChat();
  await enterQuestion('Где купить билеты?');
  await act(async () => { button('Отправить').click(); button('Отправить').click(); });
  expect(attempts).toBe(1); expect(node.querySelector('.grammar-chat [role=status]')?.textContent).toContain('Готовим ответ');
  const first = calls(rpc, 'grammar.chat')[0][1]!;
  await act(async () => release({ grammarId: data.grammarId, turnId: first.turnId, kind:'out_of_scope' }));
  expect(node.querySelector('.grammar-chat-notice')?.textContent).toContain('Назовите языковую тему');
  expect(node.querySelector('.grammar-chat-answer')).toBeNull();
  await enterQuestion('А почему не Past Simple?'); await click('Отправить');
  expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toBe('OpenAI не ответил вовремя.');
  expect(attempts).toBe(2);
  await click('Повторить'); expect(attempts).toBe(3);
  const sends = calls(rpc, 'grammar.chat').map(c => c[1]!);
  expect(sends[1].question).toBe(sends[2].question);
  expect(sends[1].turnId).not.toBe(sends[2].turnId);
  expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
});
it('rechecks revoked consent on send without calling chat and cancels a pending question on changing the selection', async () => {
  let enabled=true, signal:AbortSignal|undefined, finish!:(reply: unknown)=>void;
  const rpc = vi.fn(async(type:string,body?:any,options?:{signal?:AbortSignal})=>{
    if(type==='settings.getReader') return {grammarEnabled:enabled};
    if(type==='grammar.lookup') return data;
    if(type==='grammar.chat') {signal=options?.signal; return new Promise(resolve=>{finish=resolve;});}
    return {};
  }) as UiRpc;
  await render(opts(rpc,{autoGenerate:true})); await openChat(); await enterQuestion('Что показывает форма?');
  enabled=false; await click('Отправить');
  expect(calls(rpc,'grammar.chat')).toHaveLength(0);expect(node.textContent).toContain('Разбор выключен');
  enabled=true; await render(opts(rpc,{autoGenerate:true,payload:{...payload}}));await openChat();
  await enterQuestion('Почему здесь were sitting?'); await click('Отправить');
  expect(signal?.aborted).toBe(false);
  const sent=calls(rpc,'grammar.chat')[0][1]!;
  await render(opts(rpc,{payload:{...payload,sentence:'We were running.'}}));
  expect(signal?.aborted).toBe(true);
  await act(async()=>finish(answer(sent,'Поздний ответ.')));
  expect(node.textContent).not.toContain('Поздний ответ.');
  expect(calls(rpc,'grammar.chat.close').map(c=>c[1])).toContainEqual({grammarId:data.grammarId});
  expect(launchChat()).toBeNull();
});
it('keeps earlier messages visible and blocks stale contexts from automatic resends', async()=>{
  let expired=false;
  const rpc=fake({'grammar.chat':(body:any)=>{
    if(expired) throw Object.assign(new Error('expired'),{code:'LOOKUP_EXPIRED'});
    return answer(body);
  }});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  for(const index of [0,1,2,3,4,5]){await enterQuestion('Вопрос '+index+' о форме?');await click('Отправить');}
  expect(node.querySelectorAll('.grammar-chat-answer')).toHaveLength(6);
  expect(node.querySelector('.grammar-chat-thread')?.textContent).toContain('Вопрос 0');
  expired=true;await enterQuestion('Почему?');await click('Отправить');
  expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toContain('чат завершён');
  expect(node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')?.readOnly).toBe(true);
  expect(node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')?.value).toBe('Почему?');
  expect(calls(rpc,'grammar.chat')).toHaveLength(7);
});

it('keeps an in-flight answer on the same card across Back and Preview without resending', async()=>{
  let finish!:(reply:unknown)=>void,signal:AbortSignal|undefined;
  const rpc=vi.fn(async(type:string,body?:any,options?:{signal?:AbortSignal})=>{
    if(type==='settings.getReader')return {grammarEnabled:true};
    if(type==='grammar.lookup')return data;
    if(type==='grammar.chat'){signal=options?.signal;return new Promise(resolve=>{finish=resolve;});}
    return {};
  }) as UiRpc;
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  await enterQuestion('Почему здесь were sitting?');await click('Отправить');
  const original=calls(rpc,'grammar.chat')[0][1]!;
  await click('← К разбору');expect(signal?.aborted).toBe(false);
  expect(document.activeElement).toBe(launchChat());
  await click('Предпросмотр');
  await act(async()=>finish(answer(original,'Ответ на вопрос в открытой карточке.')));
  expect(node.querySelector('.grammar-preview')).not.toBeNull();
  await openChat();
  expect(node.textContent).toContain('Ответ на вопрос в открытой карточке.');
  expect(document.activeElement).toBe(node.querySelector('#grammar-chat-question'));
  expect(calls(rpc,'grammar.chat')).toHaveLength(1);
  expect(calls(rpc,'grammar.lookup')).toHaveLength(1);
  await enterQuestion('Ещё один пример?');await click('Отправить');
  const next=calls(rpc,'grammar.chat')[1][1]!;
  await act(async()=>finish({...answer(next),turnId:original.turnId,answer:'Ответ другой попытки.'}));
  expect(node.textContent).not.toContain('Ответ другой попытки.');
  expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toBe('Не удалось получить ответ на вопрос.');
});

it('prefills an editable question and returns focus without sending; follow-ups appear after a verified answer', async()=>{
  const rpc=fake({'grammar.chat':(body:any)=>answer(body)});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  const choices=()=>[...node.querySelectorAll<HTMLButtonElement>('[role=group][aria-label="Подсказки для вопроса"] button')];
  const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  const initial=choices().map(el=>el.textContent);
  expect(initial).toHaveLength(3);
  expect(initial.join(' ')).toMatch(/were sitting|Past Simple/);
  const rpcCount=vi.mocked(rpc).mock.calls.length;
  for(const button of choices()){
    expect(button.type).toBe('button');expect(button.tabIndex).toBe(0);expect(button.getAttribute('aria-controls')).toBe(field.id);
    button.focus();
    await act(async()=>button.dispatchEvent(new MouseEvent('click',{detail:0,bubbles:true})));
    expect(document.activeElement).toBe(field);expect(field.value).toBe(button.textContent);
  }
  expect(vi.mocked(rpc).mock.calls).toHaveLength(rpcCount);
  await enterQuestion('А можно опустить were?');await click('Отправить');
  expect(calls(rpc,'grammar.chat')).toHaveLength(1);expect(calls(rpc,'grammar.chat')[0][1]?.question).toBe('А можно опустить were?');
  const next=choices().map(el=>el.textContent);expect(next).toHaveLength(2);expect(next).not.toEqual(initial);
  await act(async()=>choices()[0].click());expect(document.activeElement).toBe(field);
  expect(field.value).toBe(next[0]);expect(calls(rpc,'grammar.chat')).toHaveLength(1);
});
it('shows a local topic reset and keeps the composer ready for a fresh question',async()=>{
  const rpc=fake({'grammar.chat':(body:any)=>body.question==='Новая тема'
    ? {grammarId:body.grammarId,turnId:body.turnId,kind:'topic_reset'}
    : {grammarId:body.grammarId,turnId:body.turnId,kind:'answer',answer:'Mi piace viaggiare.'}});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  await enterQuestion('Как по-итальянски сказать „Я люблю путешествовать“?');await click('Отправить');
  await enterQuestion('Новая тема');await click('Отправить');
  expect(node.querySelector('.grammar-chat-thread')?.textContent).toContain('Mi piace viaggiare.');
  expect(node.querySelector('.grammar-chat-notice')?.textContent).toContain('Новая тема. Введите первый вопрос.');
  expect(field.value).toBe('');expect(field.readOnly).toBe(false);
  await enterQuestion('Как произносится слово island?');await click('Отправить');
  expect(calls(rpc,'grammar.chat')).toHaveLength(3);
  expect(node.querySelector('.grammar-chat [role=alert]')).toBeNull();
});

it('distinguishes local clarification from model abstention and incomplete or ungrounded answers',async()=>{
  const outcomes=['out_of_scope','model_out_of_scope','model_no_answer','MODEL_REFUSAL','MODEL_INCOMPLETE','INVALID_MODEL_OUTPUT'];
  const rpc=fake({'grammar.chat':(body:any)=>{
    const result=outcomes.shift()!;
    if(result==='out_of_scope'||result==='model_out_of_scope'||result==='model_no_answer')return {grammarId:body.grammarId,turnId:body.turnId,kind:result};
    throw Object.assign(new Error('fixture'),{code:result});
  }});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  const initial=[...node.querySelectorAll('.grammar-chat-options button')].map(el=>el.textContent);
  await enterQuestion('Где купить кофе?');await click('Отправить');
  const notices=()=>[...node.querySelectorAll('.grammar-chat-notice')].map(el=>el.textContent);
  expect(notices().at(-1)).toContain('Запрос в OpenAI не отправлялся.');
  expect(node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')?.value).toBe('Где купить кофе?');
  await enterQuestion('Почему здесь were sitting?');await click('Отправить');
  expect(notices().at(-1)).toContain('По оценке модели');
  expect(notices().at(-1)).not.toContain('не отправлялся');
  await enterQuestion('Почему здесь were sitting?');await click('Отправить');
  expect(notices().at(-1)).toContain('недостаточно сведений для уверенного объяснения');
  expect(notices().at(-1)).not.toMatch(/не отправлялся|рамки/);
  expect([...node.querySelectorAll('.grammar-chat-options button')].map(el=>el.textContent)).toEqual(initial);
  for(const [index,text] of ['Модель отклонила запрос','Ответ модели пришёл не полностью','Не удалось подтвердить ответ модели'].entries()){
    await enterQuestion('Почему здесь were sitting?');await click(index===0?'Отправить':'Повторить');
    expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toContain(text);
    expect(calls(rpc,'grammar.chat')).toHaveLength(index+4);
  }
});

it('shows a fixed reason for a limited or unverifiable model answer without issuing a retry',async()=>{
  const cases=[
    ['MODEL_INCOMPLETE','output','output_token_limit','лимит токенов'],
    ['INVALID_MODEL_OUTPUT','output','output_json','корректным JSON'],
    ['INVALID_MODEL_OUTPUT','validation','grammar_anchor','грамматическую форму'],
    ['INVALID_MODEL_OUTPUT','validation','grammar_evidence','Цитата'],
    ['INVALID_MODEL_OUTPUT','validation','grammar_answer_length','допустимую длину'],
    ['INVALID_MODEL_OUTPUT','validation','grammar_answer_format','в полученном формате'],
  ] as const;
  let attempts=0;
  const rpc=fake({'grammar.chat':()=>{
    const [code,stage,reason]=cases[attempts++];
    throw Object.assign(new Error('Private diagnostic text'),{code,diagnostics:{stage,reason}});
  }});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  await enterQuestion('Что показывает were sitting?');
  for(const [index,expected] of cases.entries()){
    await click(index?'Повторить':'Отправить');
    const alert=node.querySelector('.grammar-chat [role=alert]')?.textContent;
    expect(alert).toContain(expected[3]);expect(alert).not.toContain('Private diagnostic text');
    expect(attempts).toBe(index+1);
  }
});

it('keeps a live conversation during worker recovery, conflicts and interrupted paid turns',async()=>{
  let enabledCheckFails=false, attempts=0;
  const reasons=['answer','OPERATION_CONFLICT','REQUEST_CANCELLED','answer'];
  const rpc=fake({
    'settings.getReader':()=>{if(enabledCheckFails)throw new Error('worker waking');return {grammarEnabled:true};},
    'grammar.chat':(body:any)=>{const reason=reasons[attempts++];if(reason==='answer')return answer(body);throw Object.assign(new Error('stub'),{code:reason});},
  });
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  const field=()=>node.querySelector<HTMLTextAreaElement>('#grammar-chat-question');
  const first='Какая здесь форма?', next='Можно ли убрать were?';
  await enterQuestion(first);await click('Отправить');
  await enterQuestion(next);
  enabledCheckFails=true;
  await act(async()=>window.dispatchEvent(new Event('focus')));
  expect(field()?.value).toBe(next);
  expect(node.querySelector('.grammar-chat-answer')?.textContent).toContain('were sitting');
  await click('Отправить');expect(attempts).toBe(1);
  expect(field()?.value).toBe(next);
  expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toContain('Вопрос не отправлен');
  enabledCheckFails=false;
  await act(async()=>window.dispatchEvent(new Event('focus')));
  expect(attempts).toBe(1);
  await click('Повторить');
  expect(field()?.value).toBe(next);expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toContain('обрабатывается');
  await click('Повторить');
  expect(field()?.value).toBe(next);expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toContain('прерван');
  expect(node.querySelector('#grammar-chat-retry-cost')?.textContent).toContain('мог израсходовать токены');
  expect(button('Повторить').getAttribute('aria-describedby')).toContain('grammar-chat-retry-cost');
  await click('← К разбору');await openChat();expect(attempts).toBe(3);expect(field()?.value).toBe(next);
  await click('Повторить');
  expect(attempts).toBe(4);expect(node.querySelectorAll('.grammar-chat-answer')).toHaveLength(2);
  expect(calls(rpc,'grammar.chat').map(call=>call[1]!.turnNumber)).toEqual([1,2,3,4]);
  expect(new Set(calls(rpc,'grammar.chat').map(call=>call[1]!.turnId)).size).toBe(4);
});
it('preserves an edited follow-up while a previous question finishes and retains the original failed turn',async()=>{
  let release!:(value:unknown)=>void,attempts=0;
  const rpc=fake({'grammar.chat':(body:any)=>{if(++attempts===1)return new Promise(r=>{release=r;});
    if(attempts===2)throw Object.assign(new Error(),{code:'NETWORK_TIMEOUT'});return answer(body);}});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  await enterQuestion('Что за правило?');await click('Отправить');
  await enterQuestion('А что произойдёт, если убрать were?');
  await act(async()=>release(answer(calls(rpc,'grammar.chat')[0][1])));
  const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  expect(field.value).toBe('А что произойдёт, если убрать were?');
  await click('Отправить');expect(field.value).toBe('А что произойдёт, если убрать were?');
  await enterQuestion('Можно пример?');await click('Отправить');
  const log=node.querySelector('[role=log]')!;
  expect(log.textContent).toContain('А что произойдёт, если убрать were?');
  expect(log.textContent).toContain('OpenAI не ответил вовремя.');
  expect(log.querySelectorAll('.grammar-chat-answer')).toHaveLength(2);
});

it.each(['Как меняется смысл без were?', ''])('retains the latest draft %j and returns to the existing analysis after genuine expiry',async latestDraft=>{
  let rejectTurn!:(reason:unknown)=>void, attempts=0;
  const rpc=fake({'grammar.chat':(body:any)=>++attempts===1?answer(body):new Promise((_resolve,reject)=>{rejectTurn=reject;})});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  await enterQuestion('Почему здесь were sitting?');await click('Отправить');
  await enterQuestion('Какое здесь правило?');await click('Отправить');
  const textarea=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  await enterQuestion(latestDraft);
  await act(async()=>rejectTurn(Object.assign(new Error('expired'),{code:'LOOKUP_EXPIRED'})));
  expect(node.querySelector('#grammar-chat-question')).toBe(textarea);
  expect(textarea.value).toBe(latestDraft);expect(textarea.readOnly).toBe(true);expect(textarea.disabled).toBe(false);
  expect(node.querySelector('label[for="grammar-chat-question"]')?.textContent).toBe('Черновик вопроса');
  const log=node.querySelector('[role=log]')!.textContent!;
  expect(log).toContain('Почему здесь were sitting?');expect(log).toContain('продолжающееся действие.');expect(log).toContain('Какое здесь правило?');
  expect(node.querySelector('.grammar-chat-options')).toBeNull();expect(button('Повторить')).toBeUndefined();expect(button('Отправить')).toBeUndefined();
  const total=vi.mocked(rpc).mock.calls.length;
  const select=button('Выделить для копирования');
  expect(select.disabled).toBe(latestDraft==='');
  if(latestDraft){
    select.focus();await act(async()=>select.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0})));
    expect(document.activeElement).toBe(textarea);expect(textarea.selectionStart).toBe(0);expect(textarea.selectionEnd).toBe(latestDraft.length);
    expect(node.querySelector('.grammar-chat-recovery [role=status]')?.textContent).toContain('выделен');
  }
  await click('Вернуться к разбору');
  const archive=node.querySelector<HTMLButtonElement>('button[aria-label="Открыть переписку этой карточки"]')!;
  expect(document.activeElement).toBe(archive);
  expect(node.querySelector('.grammar-reading')?.textContent).toContain(data.rule);
  await act(async()=>archive.click());
  expect(node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')?.value).toBe(latestDraft);
  expect(node.querySelector('.grammar-chat-answer')).toBeTruthy();
  expect(button('Повторить')).toBeUndefined();expect(button('Отправить')).toBeUndefined();
  expect(vi.mocked(rpc).mock.calls).toHaveLength(total);
  expect(calls(rpc,'grammar.lookup')).toHaveLength(1);expect(calls(rpc,'grammar.chat')).toHaveLength(2);
});
it('keeps a denied capability closed and does not expose another session through the expiry branch',async()=>{
  const rpc=fake({'grammar.chat':()=>{throw Object.assign(new Error('foreign scope'),{code:'PERMISSION_DENIED'});}});
  await render(opts(rpc,{autoGenerate:true}));await openChat();await enterQuestion('Какое здесь правило?');await click('Отправить');
  expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toContain('недоступен');
  expect(node.querySelector('.grammar-chat-recovery, #grammar-chat-question')).toBeNull();
  await click('← К разбору');await openChat();
  expect(node.querySelector('.grammar-chat-recovery, #grammar-chat-question')).toBeNull();
  expect(button('Отправить')).toBeUndefined();expect(button('Повторить')).toBeUndefined();
  expect(calls(rpc,'grammar.lookup')).toHaveLength(1);expect(calls(rpc,'grammar.chat')).toHaveLength(1);
});

it('attributes the ready lesson as free only on an answer marked by the background',async()=>{
  const rpc=fake({'grammar.chat':(body:any)=>({...answer(body),...(body.turnNumber===1?{source:'analysis'}:{})})});
  await render(opts(rpc,{autoGenerate:true}));await openChat();
  expect(node.querySelector('#grammar-chat-cost')?.textContent).toContain('из текущего разбора бесплатно');
  for(const q of ['Процитируй правило из карточки','Что означает were?']){await enterQuestion(q);await click('Отправить');}
  const rows=node.querySelectorAll('.grammar-chat-answer');
  expect(rows[0].textContent).toContain('без запроса в OpenAI');
  expect(rows[1].textContent).not.toContain('без запроса в OpenAI');
});


it('opens a general language topic and follows a long lesson into practice without modifying the grammar card', async () => {
  const topic = 'дай полное объяснение темы Present Perfect';
  const exercise = 'Дай упражнение по этой теме';
  const feedback = 'Мой ответ: I have finished. Проверь его.';
  const lesson = [
    'Present Perfect соединяет событие в прошлом с настоящим.',
    'I have finished the book. '.repeat(220),
    'Запись <em>finished</em> и **have** приведена как текст.',
    'Когда важен конкретный момент в прошлом, сравните с Past Simple.',
  ].join('\n\n');
  const replies = [lesson, 'Заполните пропуск: I ___ finished the book.', 'Верно: с I используется have.'];
  let index = 0;
  const rpc = fake({'grammar.chat': (body: any) => answer(body, replies[index++])});
  await render(opts(rpc, {autoGenerate: true}));
  await openChat();
  const source = node.querySelector<HTMLDetailsElement>('details.grammar-chat-source')!;
  expect(source.open).toBe(false);
  expect(source.textContent).toContain(payload.sentence);
  expect(node.querySelector('.grammar-chat-privacy')?.textContent).toMatch(/только ваш вопрос.*недавние реплики.*предложение и его разбор/);
  const thread = node.querySelector<HTMLElement>('[role="log"]')!;
  await enterQuestion(topic); await click('Отправить');
  const rendered = thread.querySelector('.language-chat-markdown')!;
  expect([...rendered.querySelectorAll('p')].map(row => row.textContent).join('\n\n')).toBe(lesson.replace('**have**', 'have'));
  expect(rendered.querySelector('em')).toBeNull();
  expect(rendered.querySelector('strong')?.textContent).toBe('have');
  expect(thread.tabIndex).toBe(0);
  expect(thread.scrollTop).toBe(0);
  for(const question of [exercise, feedback]){
    await enterQuestion(question); await click('Отправить');
  }
  expect(calls(rpc, 'grammar.chat').map(call => call[1]!.question)).toEqual([topic, exercise, feedback]);
  const draft = 'Теперь хочу потренировать вопросы.';
  await enterQuestion(draft); await click('← К разбору');
  expect(node.querySelector('.grammar-reading')?.textContent).toContain(data.rule);
  await openChat();
  expect(node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')?.value).toBe(draft);
  expect(thread.isConnected).toBe(false);
  expect(node.querySelectorAll('.grammar-chat-answer')).toHaveLength(3);
  expect(calls(rpc, 'grammar.lookup')).toHaveLength(1);
  expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
});

it('distinguishes the input character allowance from the paid output-token ceiling and accepts the full question', async () => {
  const rpc = fake({'grammar.chat': answer});
  await render(opts(rpc, {autoGenerate: true})); await openChat();
  const field = node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  const counter = node.querySelector('#grammar-chat-count')!;
  expect(field.maxLength).toBe(10000);
  expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(counter.id);
  expect(counter.textContent).toMatch(/^0 \/ 10\s000 знаков$/);
  expect(node.querySelector('#grammar-chat-cost')?.textContent).toMatch(/оплачивается.*до 10\s000 выходных токенов/);
  const question = 'а'.repeat(9998) + '💬';
  await enterQuestion(question);
  expect(counter.textContent).toMatch(/^10\s000 \/ 10\s000 знаков$/);
  expect(button('Отправить').disabled).toBe(false);
  await enterQuestion(question + '?');
  expect(button('Отправить').disabled).toBe(true);
  expect(calls(rpc, 'grammar.chat')).toHaveLength(0);
  await enterQuestion(question); await click('Отправить');
  expect(calls(rpc, 'grammar.chat')[0][1]?.question).toBe(question);
  expect(counter.textContent).toMatch(/^0 \/ 10\s000 знаков$/);
});

describe('long replies in a single scrollport', () => {
  const longAnswer = ['## Правило и форма', '**If + had + V₃**, would have + V₃.',
    ...Array.from({length:45},(_,i)=>'Пример '+(i+1)+'. If we had known, we would have called.'),
    'Последняя строка урока.'].join('\n\n');

  // jsdom does not implement text layout. Feed the actual mounted component
  // explicit rectangles and exercise the same submission/scroll lifecycle as the UI.
  function measure(width:number,height:number,questionHeight:number) {
    const panel=node.querySelector<HTMLElement>('.grammar-popup')!;
    const log=node.querySelector<HTMLElement>('[role=log]')!;
    let top=0;
    Object.defineProperties(panel,{
      scrollTop:{get:()=>top,set:(n:number)=>{top=Math.max(0,Math.min(4200-height,n));}},
      scrollHeight:{value:4200},clientHeight:{value:height},
    });
    vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
      const rows=[...log.children];
      const y=460+Math.max(0,rows.indexOf(this.closest('.grammar-chat-turn')!))*920;
      const actualY=this===panel?0:y-top+(this.matches('.grammar-chat-answer')?questionHeight:0);
      const actualHeight=this===panel?height:this.matches('.grammar-chat-answer')?1500:questionHeight+1500;
      return {x:0,y:actualY,width,height:actualHeight,top:actualY,bottom:actualY+actualHeight,left:0,right:width,toJSON:()=>({})};
    });
    return {panel,log};
  }

  it.each([[320,230,48],[390,430,62],[320,240,390]])('shows the start of the new long reply on a %i px screen',async(width,height,questionHeight)=>{
    const rpc=fake({'grammar.chat':(body:any)=>answer(body,longAnswer)});
    await render(opts(rpc,{autoGenerate:true}));await openChat();
    const {panel,log}=measure(width,height,questionHeight);
    await enterQuestion('Отправь мне правило целиком');await click('Отправить');
    await enterQuestion('дай полное объяснение как использовать правило это');await click('Отправить');
    const row=log.lastElementChild!;
    const origin=questionHeight>height/2?row.querySelector('.grammar-chat-answer')!:row;
    expect(origin.getBoundingClientRect().top).toBe(12);
    expect(log.scrollTop).toBe(0);
    const style=readFileSync(resolve('apps/extension/src/ui/grammar-popup.css'),'utf8');
    expect(style).toMatch(/\.grammar-popup\[data-grammar-chat-open\][^{]*\{[^}]*overflow-y:\s*auto/);
    expect(style?.match(/\.grammar-chat-thread \{[^}]*\}/)?.[0]).not.toMatch(/overflow-y|max-height/);
    expect(log.querySelector('h4')?.textContent).toBe('Правило и форма');
    expect(row.textContent).toContain('Последняя строка урока.');
    panel.scrollTop=0;expect(panel.scrollTop).toBe(0);
    panel.scrollTop=panel.scrollHeight;expect(panel.scrollTop).toBe(panel.scrollHeight-height);
    await enterQuestion('Ещё один вопрос');expect(panel.scrollTop).toBe(panel.scrollHeight-height);
  });

  it('keeps an earlier selection, reading position and draft when a delayed answer arrives',async()=>{
    let finish!:(value:unknown)=>void, activeBody:any;
    const rpc=fake({'grammar.chat':(body:any)=>{
      if(body.turnNumber===1)return answer(body,'Первый ответ содержит пример.');
      activeBody=body;return new Promise(resolve=>{finish=resolve;});
    }});
    await render(opts(rpc,{autoGenerate:true}));await openChat();
    const {panel,log}=measure(390,350,54);
    await enterQuestion('Первый вопрос');await click('Отправить');
    const earlier=log.firstElementChild!;
    await enterQuestion('Покажи примеры');await click('Отправить');
    const text=earlier.querySelector('.language-chat-markdown p')!.firstChild!;
    const range=document.createRange();range.setStart(text,0);range.setEnd(text,6);
    const selection=document.getSelection()!;selection.removeAllRanges();selection.addRange(range);
    panel.scrollTop=91;panel.dispatchEvent(new Event('scroll'));
    await enterQuestion('Черновик');const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
    field.setSelectionRange(4,7);
    await act(async()=>finish(answer(activeBody,longAnswer)));
    expect(panel.scrollTop).toBe(91);expect(earlier).toBe(log.firstElementChild);
    expect(selection.toString()).toBe('Первый');expect(field.value).toBe('Черновик');
    expect([field.selectionStart,field.selectionEnd]).toEqual([4,7]);
    await click('← К разбору');await openChat();
    expect(panel.scrollTop).toBe(91);expect(node.querySelectorAll('.grammar-chat-turn')).toHaveLength(2);
    selection.removeAllRanges();
  });

  it('replaces the failed row on manual retry and treats editing/resubmitting as a separate question',async()=>{
    let attempt=0;
    const rpc=fake({'grammar.chat':(body:any)=>{
      if(++attempt%2===1)throw Object.assign(new Error('fixture'),{code:'MODEL_INCOMPLETE'});
      return answer(body,longAnswer);
    }});
    await render(opts(rpc,{autoGenerate:true}));await openChat();
    const {log}=measure(320,330,55);
    const q='Почему здесь прошедшее время?';
    await enterQuestion(q);await click('Отправить');
    const firstRow=log.firstElementChild!,firstQuestion=firstRow.querySelector('.grammar-chat-question');
    expect(firstRow.querySelector('[role=alert]')).toBeTruthy();
    await click('Повторить');expect(log.children).toHaveLength(1);expect(log.firstElementChild).toBe(firstRow);
    expect(firstRow.querySelector('.grammar-chat-question')).toBe(firstQuestion);
    await enterQuestion(q);await click('Отправить');expect(log.children).toHaveLength(2);
    await enterQuestion('');await enterQuestion(q);await click('Отправить');expect(log.children).toHaveLength(3);
    const requests=calls(rpc,'grammar.chat');
    expect(new Set(requests.map(([,b])=>b?.turnId)).size).toBe(4);
    expect(requests.every(([,b])=>b && !('rowId' in b))).toBe(true);
  });
});
