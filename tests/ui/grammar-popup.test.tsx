import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GrammarPopup } from '../../apps/extension/src/ui/GrammarPopup';
import type { GrammarPopupOptions } from '../../apps/extension/src/ui/GrammarPopup';
import type { GrammarLookupPayload } from '../../packages/contracts/src/grammar.ts';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';
import * as userActions from '../../apps/extension/src/ui/user-actions';
const payload: GrammarLookupPayload = { sentence: 'They were sitting nearby.', sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru', learnerLevel: 'B1', includeExplanation: true };
const data = { grammarId: '12345678-1234-4234-8234-123456789abc', sentence: payload.sentence, construction: { text: 'were sitting', targetStart: 5, targetEnd: 17 }, question: 'Что выражает were sitting?', answer: 'Действие в процессе в прошлом.', rule: 'Прошедшее длительное время.', explanation: 'Форма задаёт фон сцены.', translation: 'Они сидели неподалёку.' };
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
    const rpc = fake(); await render(opts(rpc)); expect(rpc).not.toHaveBeenCalled(); expect(node.querySelector('.sentence')?.textContent).toBe(payload.sentence);
    await render(opts(rpc, { payload: { ...payload } })); expect(rpc).not.toHaveBeenCalled();
    expect(node.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('false');
  });
  it('explicit Generate creates one editable draft and uses optional grammar deck fallback without saving', async () => {
    const rpc = fake(); await render(opts(rpc, { trustedPage: true }));
    await act(async () => { button('Создать карточку').click(); button('Создать карточку').click(); });
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(1); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
    expect(node.querySelector('.sentence')?.textContent).toBe(payload.sentence); expect(node.querySelector('mark')?.textContent).toBe('were sitting');
    expect(node.querySelectorAll('textarea')).toHaveLength(5); expect(node.querySelector<HTMLInputElement>('input[aria-label="Колода"]')?.value).toBe('Default');
    expect(calls(rpc, 'audio.prepare')).toHaveLength(0); expect(node.textContent).not.toMatch(/Cloze/);
  });
  it('disabled grammar cannot generate even with an autoGenerate request', async () => {
    const rpc = fake({ 'settings.getReader': { grammarEnabled: false } }); await render(opts(rpc, { autoGenerate: true }));
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(0); expect(node.querySelector('[role="alert"]')?.textContent).toContain('выключена');
  });
  it('only the explicitly opted-in Alt path can request automatic generation', async () => {
    const rpc = fake(); await render(opts(rpc, { autoGenerate: true }));
    expect(calls(rpc, 'grammar.lookup')).toHaveLength(1); expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
  });
  it('untrusted clicks do not generate', async () => {
    vi.mocked(userActions.isTrustedUiEvent).mockReturnValue(false);
    const rpc = fake(); await render(opts(rpc)); await click('Создать карточку'); expect(rpc).not.toHaveBeenCalled();
  });
  it('manual Add uses edited fields, preserves sentence and blocks duplicate click', async () => {
    let finish!: (value: unknown) => void;
    const rpc = fake({ 'grammar.addNote': () => new Promise(resolve => { finish = resolve; }) });
    await render(opts(rpc)); await click('Создать карточку'); await edit('Ответ', 'Исправленный ответ.');
    await act(async () => { button('Добавить в Anki').click(); button('Добавить в Anki').click(); });
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1);
    const body = calls(rpc, 'grammar.addNote')[0][1] as any; expect(body.draft.answer).toBe('Исправленный ответ.'); expect(body.draft.sentence).toBe(payload.sentence);
    await act(async () => finish({ operationId: body.operationId, status: 'added', noteId: 12 })); expect(node.textContent).toContain('Добавлено в Anki');
    expect(node.querySelector('textarea')?.disabled).toBe(true);
  });
  it('validation failure remains editable and never dispatches Add', async () => {
    const rpc = fake(); await render(opts(rpc)); await click('Создать карточку'); await edit('Ответ', ''); await click('Добавить в Anki');
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(0); expect(node.querySelector('textarea')?.disabled).toBe(false);
  });
  it('uncertain Add retries only explicitly with the same immutable operation', async () => {
    let attempts = 0;
    const rpc = fake({ 'grammar.addNote': (body: any) => { if (++attempts === 1) throw new Error('Uncertain'); return { operationId: body.operationId, status: 'already_added', noteId: 12 }; } });
    await render(opts(rpc)); await click('Создать карточку'); await click('Добавить в Anki');
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
    await click('Создать карточку'); await edit('Ответ', 'Проверенный ответ.'); await click('Добавить в Anki');
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
    await render(opts(rpc, { openSettings: vi.fn() })); await click('Создать карточку'); await click('Добавить в Anki');
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
    await render(opts(rpc)); await click('Создать карточку'); await click('Добавить в Anki');
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Повторная отправка заблокирована');
    expect(button('Проверить результат')).toBeDefined();
    expect(button('Создать карточку')).toBeUndefined();
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(1);
    expect(node.querySelector('textarea')?.disabled).toBe(true);
  });
  it('selection replacement clears old schema recovery and ignores an old save result', async () => {
    let resolve!: (value: unknown) => void;
    const rpc = fake({ 'grammar.addNote': () => new Promise(r => { resolve = r; }) });
    await render(opts(rpc)); await click('Создать карточку'); await click('Добавить в Anki');
    const old = calls(rpc, 'grammar.addNote')[0][1] as any;
    await render(opts(rpc, { payload: { ...payload, sentence: 'We are leaving now.' } }));
    await act(async () => resolve({ operationId: old.operationId, status: 'added', noteId: 12 }));
    expect(node.querySelector('.sentence')?.textContent).toBe('We are leaving now.');
    expect(node.querySelector('textarea')).toBeNull();
    expect(node.textContent).not.toContain('Добавлено в Anki');
    expect(button('Проверить после настройки')).toBeUndefined();
  });
  it('preview is same-renderer, sandboxed and does not add a note', async () => {
    const rpc = fake(); await render(opts(rpc)); await click('Создать карточку'); await click('Предпросмотр');
    expect(node.querySelector('iframe')?.getAttribute('sandbox')).toBe(''); expect(node.querySelector('iframe')?.srcdoc).toContain('were sitting');
    expect(calls(rpc, 'grammar.addNote')).toHaveLength(0);
  });
  it('closing or replacing a pending request aborts it and ignores late output', async () => {
    let resolve!: (value: unknown) => void; let signal: AbortSignal | undefined;
    const rpc = vi.fn(async (type, _body, options) => { if (type === 'settings.getReader') return { grammarEnabled: true }; signal = options?.signal; return new Promise(r => { resolve = r; }); }) as UiRpc;
    const close = vi.fn(); await render(opts(rpc), close); await click('Создать карточку');
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="Закрыть"]')!.click()); expect(close).toHaveBeenCalledOnce(); expect(signal?.aborted).toBe(true);
    await act(async () => resolve(structuredClone(data))); expect(node.querySelector('textarea')).toBeNull();
  });
  it('new selection resets old fields and never accepts a stale result', async () => {
    let resolveOld!: (value: unknown) => void;
    const rpc = fake({ 'grammar.lookup': () => new Promise(r => { resolveOld = r; }) });
    await render(opts(rpc)); await click('Создать карточку');
    const next = { ...payload, sentence: 'We are leaving now.' }; await render(opts(rpc, { payload: next }));
    await act(async () => resolveOld(structuredClone(data))); expect(node.querySelector('.sentence')?.textContent).toBe(next.sentence); expect(node.querySelector('textarea')).toBeNull();
  });
  it('invalid model response is surfaced without hidden re-request', async () => {
    const rpc = fake({ 'grammar.lookup': { ...data, sentence: 'Changed sentence.' } });
    await render(opts(rpc)); await click('Создать карточку'); expect(calls(rpc, 'grammar.lookup')).toHaveLength(1);
    expect(node.querySelector('textarea')).toBeNull(); expect(node.querySelector('[role="alert"]')).not.toBeNull();
  });
});
