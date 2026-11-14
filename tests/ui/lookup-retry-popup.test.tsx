import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingPopup } from '../../apps/extension/src/ui/ReadingPopup';
import { lookupFailure } from '../../apps/extension/src/ui/lookup-feedback';
import { uiCss } from '../../apps/extension/src/ui/styles';
import * as userActions from '../../apps/extension/src/ui/user-actions';
import type { LookupData, NoteDraft } from '@english-reader/contracts';
import type { PopupOptions, UiRpc } from '../../apps/extension/src/ui/interfaces';

const payload = { expression: 'kept', context: { sentence: 'Frodo kept up the custom.', targetStart: 6, targetEnd: 10 }, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', dialect: 'en-US' } as const;
const source = { kind: 'html', title: 'Offline reader fixture', url: 'https://reader.example', documentId: null, page: null, chapter: null, cfi: null } as const;
const pronunciation = { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null } as const;
const result = (expression = 'kept'): LookupData => ({ lookupId: `lookup-${expression}`, expression, lemma: expression === 'kept' ? 'keep' : expression, partOfSpeech: 'verb', recommendedSenseId: 'retain', contextAmbiguous: false, senses: [{ id: 'retain', translations: ['сохранять'], definition: 'To continue to have something.' }], ipaCandidate: null, extraExample: null });
const malformed = () => Object.assign(new Error('RAW_PROVIDER_BODY model=gpt-private key=sk-private prompt=PRIVATE-TEXT'), { code: 'INVALID_MODEL_OUTPUT', details: { output: 'PRIVATE-OUTPUT' } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fakeRpc(overrides: Record<string, unknown> = {}): UiRpc {
  return vi.fn(async (type: string, payload?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    if (type in overrides) { const value = overrides[type]; return typeof value === 'function' ? value(payload, options) : value; }
    if (type === 'settings.getReader') return { defaultDeck: 'Offline' };
    if (type === 'lookup') return result();
    if (type === 'pronunciation.get') return { pronunciation };
    if (type === 'anki.addNote') return { status: 'queued', noteId: null };
    return {};
  }) as UiRpc;
}
const options = (rpc: UiRpc): PopupOptions => ({ rpc, lookupPayload: payload, source, anchor: new DOMRect(10, 10, 10, 10) });
const calls = (rpc: UiRpc, type: string) => vi.mocked(rpc).mock.calls.filter(call => call[0] === type);
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  // Component behavior and DOM structure only. This is not browser layout or
  // native-event trust evidence, and no provider/Anki connection is involved.
  vi.spyOn(userActions, 'isTrustedUiEvent').mockReturnValue(true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });
const button = (label: string) => [...node.querySelectorAll('button')].find(item => item.textContent === label);
async function render(rpc: UiRpc, next = options(rpc)) { await act(async () => root.render(<ReadingPopup options={next} close={() => {}} />)); }
async function editLemma(value: string) {
  const field = [...node.querySelectorAll('label')].find(item => item.firstChild?.textContent === 'Лемма')!.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
const state = () => node.querySelector('.reading-popup')?.getAttribute('data-lookup-state');

describe('focused reading lookup feedback and explicit retry', () => {
  it('shows the selected word and exact source context while loading, with no premature warning or retry', async () => {
    const pending = deferred<LookupData>(), rpc = fakeRpc({ lookup: () => pending.promise });
    await render(rpc);
    expect(state()).toBe('loading'); expect(node.querySelector('header strong')?.textContent).toBe('kept');
    expect(node.querySelector('[role=status]')?.textContent).toContain('Переводим в контексте');
    expect(node.querySelector('.sentence')?.textContent).toBe(payload.context.sentence);
    expect(node.querySelector('mark')?.textContent).toBe('kept');
    expect(button('Повторить перевод')).toBeUndefined(); expect(node.querySelector('.reading-notice')).toBeNull();
    expect(node.textContent).not.toContain('отправленное сохранение'); expect(calls(rpc, 'lookup')).toHaveLength(1);
    expect(uiCss).toContain('.reading-popup{width:min(520px,calc(100vw - 24px))');
    expect(uiCss).toContain('.popup{width:min(430px,calc(100vw - 24px))');
  });

  it('turns a rejected malformed response into a short failure state with optional safe code, never raw diagnostic content', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject(malformed()) }); await render(rpc);
    expect(state()).toBe('error'); expect(node.querySelector('[role=alert]')?.textContent).toContain('Не удалось получить перевод');
    expect(node.querySelector('[role=alert]')?.textContent).toContain('Не удалось прочитать ответ');
    const details = node.querySelector<HTMLDetailsElement>('.reading-error-details')!;
    expect(details.open).toBe(false); expect(details.textContent).toContain('Код: INVALID_MODEL_OUTPUT');
    expect(node.textContent).toContain('Это новый запрос к ИИ. Он может быть платным.');
    expect(node.textContent).not.toMatch(/RAW_PROVIDER|PRIVATE|gpt-private|sk-private/);
    expect(node.querySelector('.translation')).toBeNull(); expect(button('Добавить в Anki')).toBeUndefined();
    expect(calls(rpc, 'pronunciation.get')).toHaveLength(0); expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
    expect(node.querySelector('.reading-notice')).toBeNull();
  });

  it('does not display arbitrary error messages or unknown codes even inside technical details', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject(Object.assign(new Error('sk-secret PRIVATE'), { code: 'UNKNOWN_PRIVATE' })) });
    await render(rpc); expect(node.textContent).toContain('Проверьте подключение');
    expect(node.querySelector('.reading-error-details')).toBeNull(); expect(node.textContent).not.toMatch(/secret|PRIVATE/);
    expect(lookupFailure({ code: '__proto__', message: 'private' })).toEqual({ message: 'Проверьте подключение и попробуйте ещё раз.' });
  });

  it('shows precise safe failure categories only inside collapsed technical details', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject(Object.assign(malformed(), {
      diagnostics: {stage: 'validation', reason: 'definition_language'},
    })) }); await render(rpc);
    const details = node.querySelector<HTMLDetailsElement>('.reading-error-details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Проверка перевода: Определение не соответствует выбранному языку текста.');
    expect(details.textContent).toContain('Диагностика: validation/definition_language');
    expect(node.querySelector('[role=alert]')?.textContent).not.toContain('definition_language');
    expect(node.textContent).not.toMatch(/RAW_PROVIDER|PRIVATE|sk-private|gpt-private/);
    expect(calls(rpc, 'lookup')).toHaveLength(1);
    expect(node.querySelector('[role=alert]')?.textContent).toContain('Язык ответа ИИ не прошёл проверку');
    expect(node.querySelector('[role=alert]')?.textContent).toContain('менять настройки не нужно');
    expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
  });

  it('explains the bounded English versus Cyrillic script mismatch without exposing rejected text', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject({
      code: 'INVALID_MODEL_OUTPUT', diagnostics: {stage:'validation', reason:'definition_script_cyrillic'},
      message: 'PRIVATE_REJECTED_DEFINITION',
    }) }); await render(rpc);
    const details = node.querySelector<HTMLDetailsElement>('.reading-error-details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Ожидалось определение на английском');
    expect(details.textContent).toContain('кириллицей без латинских букв');
    expect(details.textContent).toContain('validation/definition_script_cyrillic');
    expect(node.textContent).not.toContain('PRIVATE_REJECTED_DEFINITION');
    expect(node.querySelector('[role=alert]')?.textContent).toContain('менять настройки не нужно');
    expect(calls(rpc, 'lookup')).toHaveLength(1);
    expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
  });

  it('distinguishes request rejection from malformed translation without auto retry or Anki mutation', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject({code: 'OPENAI_REQUEST_REJECTED',
      diagnostics: {stage: 'request', reason: 'request_schema'}, message: 'PRIVATE PARAMETER'}) });
    await render(rpc);
    expect(node.querySelector('[role=alert]')?.textContent).toContain('API отклонил запрос до перевода');
    expect(node.textContent).toContain('API не принял формат запроса расширения');
    expect(node.textContent).not.toContain('Не удалось прочитать ответ');
    expect(node.textContent).not.toContain('PRIVATE PARAMETER');
    expect(button('Повторить перевод')).toBeUndefined();
    expect(node.textContent).toContain('Повтор того же запроса не исправит его параметры');
    expect(calls(rpc, 'lookup')).toHaveLength(1); expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
  });

  it('rejects arbitrary diagnostic extras and displays only the known code', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject({code: 'INVALID_MODEL_OUTPUT',
      diagnostics: {stage: 'validation', reason: 'lookup_shape', output: 'PRIVATE TEXT'}}) });
    await render(rpc); const details = node.querySelector('.reading-error-details')!;
    expect(details.textContent).toBe('Технические сведенияКод: INVALID_MODEL_OUTPUT');
    expect(node.textContent).not.toContain('PRIVATE TEXT');
  });

  it('shows the actual requested language settings during failure and never retries merely by opening settings', async () => {
    const settings = {sourceLanguage: 'ru', targetLanguage: 'en', learnerLevel: 'A2', dialect: 'ru-RU'};
    const rpc = fakeRpc({'settings.getReader': settings, lookup: () => Promise.reject(malformed())});
    const openSettings = vi.fn(async () => {});
    await render(rpc, {...options(rpc), openSettings});
    expect(node.querySelector('.reading-language')?.textContent).toBe('Русский → Английский · A2');
    expect(calls(rpc, 'lookup')[0]![1]).toMatchObject(settings);
    await act(async () => button('Проверить языки в настройках')!.click());
    expect(openSettings).toHaveBeenCalledOnce(); expect(calls(rpc, 'lookup')).toHaveLength(1);
    await act(async () => window.dispatchEvent(new FocusEvent('focus')));
    expect(calls(rpc, 'lookup')).toHaveLength(1); expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
    await act(async () => button('Повторить перевод')!.click());
    expect(calls(rpc, 'lookup')).toHaveLength(2);
  });

  it('sends exactly one lookup per explicit retry, rejects same-tick double clicks and does not change the source payload', async () => {
    const pending = deferred<LookupData>();
    const lookup = vi.fn().mockRejectedValueOnce(malformed()).mockReturnValueOnce(pending.promise);
    const rpc = fakeRpc({ lookup }); await render(rpc); const retry = button('Повторить перевод')!;
    await act(async () => { retry.click(); retry.click(); retry.click(); });
    expect(lookup).toHaveBeenCalledTimes(2); expect(state()).toBe('loading'); expect(button('Повторить перевод')).toBeUndefined();
    expect(document.activeElement).toBe(node.querySelector('[role=dialog]'));
    expect(calls(rpc, 'lookup')[1]![1]).toEqual(calls(rpc, 'lookup')[0]![1]);
    expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
    await act(async () => pending.resolve(result()));
    expect(state()).toBe('ready'); expect(node.querySelector('.verb-base-form')?.textContent).toBe('Инфинитив: keep');
    expect(node.querySelector('.translation')?.textContent).toBe('сохранять'); expect(node.querySelector('.reading-error-details')).toBeNull();
    expect(button('Повторить перевод')).toBeUndefined(); expect(calls(rpc, 'pronunciation.get')).toHaveLength(1);
  });

  it('never retries an error automatically, on rerender, focus, hover, or Enter on the panel', async () => {
    vi.useFakeTimers(); const rpc = fakeRpc({ lookup: () => Promise.reject(malformed()) }); const stable = options(rpc);
    await render(rpc, stable);
    await act(async () => {
      node.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      button('Повторить перевод')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      window.dispatchEvent(new FocusEvent('focus')); vi.advanceTimersByTime(100000);
    });
    await render(rpc, stable); expect(calls(rpc, 'lookup')).toHaveLength(1);
    await act(async () => button('Повторить перевод')!.click());
    expect(calls(rpc, 'lookup')).toHaveLength(2); expect(state()).toBe('error');
    await act(async () => vi.advanceTimersByTime(100000)); expect(calls(rpc, 'lookup')).toHaveLength(2);
  });

  it('requires native event provenance for a paid retry', async () => {
    const rpc = fakeRpc({ lookup: () => Promise.reject(malformed()) }); await render(rpc);
    vi.mocked(userActions.isTrustedUiEvent).mockRestore();
    await act(async () => button('Повторить перевод')!.click());
    expect(calls(rpc, 'lookup')).toHaveLength(1); expect(state()).toBe('error');
  });

  it('times out without automatic retry and ignores the old answer even after a deliberate new request starts', async () => {
    vi.useFakeTimers(); const old = deferred<LookupData>(), next = deferred<LookupData>();
    const rpc = fakeRpc({ lookup: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise) });
    await render(rpc); const firstSignal = calls(rpc, 'lookup')[0]![2]!.signal!;
    await act(async () => vi.advanceTimersByTime(25001));
    expect(state()).toBe('error'); expect(firstSignal.aborted).toBe(true); expect(calls(rpc, 'lookup')).toHaveLength(1);
    expect(node.querySelector('[role=alert]')?.textContent).toContain('слишком много времени');
    await act(async () => button('Повторить перевод')!.click());
    await act(async () => old.resolve({ ...result(), lemma: 'STALE' }));
    expect(state()).toBe('loading'); expect(node.textContent).not.toContain('STALE');
    await act(async () => next.resolve(result()));
    expect(state()).toBe('ready'); expect(calls(rpc, 'lookup')).toHaveLength(2);
  });

  it('aborts a pending retry on close and ignores the late answer without follow-on requests', async () => {
    const pending = deferred<LookupData>(); const rpc = fakeRpc({ lookup: vi.fn().mockRejectedValueOnce(malformed()).mockReturnValueOnce(pending.promise) });
    const close = vi.fn(() => root.render(null));
    await act(async () => root.render(<ReadingPopup options={options(rpc)} close={close} />));
    await act(async () => button('Повторить перевод')!.click()); const signal = calls(rpc, 'lookup')[1]![2]!.signal!;
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Закрыть перевод"]')!.click());
    expect(close).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(result()));
    expect(node.textContent).toBe(''); expect(calls(rpc, 'pronunciation.get')).toHaveLength(0); expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
  });

  it.each(['resolve', 'reject'] as const)('ignores a late retry %s after selecting a newer word', async outcome => {
    const pending = deferred<LookupData>();
    const rpc = fakeRpc({ lookup: vi.fn().mockRejectedValueOnce(malformed()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result('shore')) });
    await render(rpc); await act(async () => button('Повторить перевод')!.click()); const signal = calls(rpc, 'lookup')[1]![2]!.signal!;
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'shore', context: { sentence: 'The shore was quiet.', targetStart: 4, targetEnd: 9 } } });
    expect(signal.aborted).toBe(true); expect(node.querySelector('header strong')?.textContent).toBe('shore');
    await act(async () => { if (outcome === 'resolve') pending.resolve({ ...result(), lemma: 'STALE' }); else pending.reject(malformed()); });
    expect(state()).toBe('ready'); expect(node.querySelector('header strong')?.textContent).toBe('shore');
    expect(node.textContent).not.toContain('STALE'); expect(node.querySelector('[role=alert]')).toBeNull();
    expect(calls(rpc, 'pronunciation.get')).toHaveLength(1); expect(calls(rpc, 'lookup')).toHaveLength(3);
  });

  it('does not issue a late retry lookup if its settings read completes after replacement', async () => {
    const settings = deferred<{ defaultDeck: string }>();
    const rpc = fakeRpc({
      'settings.getReader': vi.fn().mockResolvedValueOnce({ defaultDeck: 'Offline' }).mockReturnValueOnce(settings.promise).mockResolvedValue({ defaultDeck: 'Offline' }),
      lookup: vi.fn().mockRejectedValueOnce(malformed()).mockResolvedValue(result('shore')),
    });
    await render(rpc); await act(async () => button('Повторить перевод')!.click());
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'shore', context: { sentence: 'The shore was quiet.', targetStart: 4, targetEnd: 9 } } });
    await act(async () => settings.resolve({ defaultDeck: 'OLD' }));
    expect(calls(rpc, 'lookup')).toHaveLength(2); expect(state()).toBe('ready'); expect(node.querySelector('header strong')?.textContent).toBe('shore');
  });

  it('shows an unsaved-edit notice only for a changed draft, not editing mode or passive pronunciation, and removes it on revert', async () => {
    const ipa = deferred<{ pronunciation: NoteDraft['pronunciation'] }>(); const rpc = fakeRpc({ 'pronunciation.get': () => ipa.promise });
    await render(rpc); expect(node.querySelector('.reading-notice')).toBeNull();
    await act(async () => ipa.resolve({ pronunciation: { ipa: '/kept/', dialect: 'en-US', source: 'dictionary', sourceUrl: null } }));
    expect(node.querySelector('.reading-notice')).toBeNull();
    await act(async () => button('Редактировать')!.click()); expect(node.querySelector('.reading-notice')).toBeNull();
    await editLemma('retain'); expect(node.querySelector('.reading-notice')?.textContent).toContain('Есть несохранённые правки');
    await editLemma('keep'); expect(node.querySelector('.reading-notice')).toBeNull();
    expect(calls(rpc, 'lookup')).toHaveLength(1); expect(calls(rpc, 'anki.addNote')).toHaveLength(0);
  });

  it('keeps pending and uncertain Anki saves distinct from lookup retry and reuses the immutable save identity', async () => {
    const saving = deferred<unknown>();
    const rpc = fakeRpc({
      lookup: vi.fn().mockRejectedValueOnce(malformed()).mockResolvedValue(result()),
      'anki.addNote': vi.fn().mockReturnValueOnce(saving.promise).mockResolvedValue({ status: 'already_added', noteId: 1 }),
    });
    await render(rpc); await act(async () => button('Повторить перевод')!.click());
    await act(async () => button('Редактировать')!.click()); await editLemma('retain');
    await act(async () => button('Добавить в Anki')!.click());
    expect(node.textContent).toContain('Сохранение отправлено. Закрытие окна его не отменит.');
    expect(node.textContent).not.toContain('Есть несохранённые правки'); expect(button('Повторить перевод')).toBeUndefined();
    const first = structuredClone(calls(rpc, 'anki.addNote')[0]![1]);
    await act(async () => saving.reject(new Error('Save connection lost')));
    expect(node.textContent).toContain('При неизвестном результате проверьте очередь и Anki');
    expect(button('Повторить перевод')).toBeUndefined(); expect(button('Готово')!.disabled).toBe(true);
    await act(async () => button('Повторить сохранение')!.click());
    const saves = calls(rpc, 'anki.addNote'); expect(saves).toHaveLength(2); expect(saves[1]![1]).toEqual(first);
    expect((saves[1]![1]!.draft as NoteDraft).lemma).toBe('retain');
    expect(calls(rpc, 'lookup')).toHaveLength(2); expect(calls(rpc, 'queue.retry')).toHaveLength(0); expect(calls(rpc, 'queue.cancel')).toHaveLength(0);
    expect(node.querySelector('.reading-notice')).toBeNull();
  });

  it('never offers translation retry for a refinement failure with an existing draft', async () => {
    const rpc = fakeRpc({ 'lookup.refine': () => Promise.reject(new Error('Refinement unavailable')) }); await render(rpc);
    await act(async () => button('Уточнить смысл — платный запрос')!.click());
    expect(state()).toBe('ready'); expect(node.querySelector('.translation')?.textContent).toBe('сохранять');
    expect(button('Повторить перевод')).toBeUndefined(); expect(calls(rpc, 'lookup')).toHaveLength(1);
    await act(async () => button('Добавить в Anki')!.click()); expect(calls(rpc, 'anki.addNote')).toHaveLength(1);
  });
});
