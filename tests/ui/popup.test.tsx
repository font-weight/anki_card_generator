import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingPopup } from '../../apps/extension/src/ui/ReadingPopup';
import { mountReadingPopup } from '../../apps/extension/src/ui/mount';
import * as userActions from '../../apps/extension/src/ui/user-actions';
import { renderPreview } from '@english-reader/note-templates';
import { uiCss } from '../../apps/extension/src/ui/styles';
import type { FullMeaningsNoteDraft, NoteDraft } from '@english-reader/contracts';
import type { PopupOptions, UiRpc } from '../../apps/extension/src/ui/interfaces';

const lookup = (expression = 'bank') => ({ lookupId: 'lookup-1', expression, lemma: expression, partOfSpeech: 'noun', recommendedSenseId: 'river', contextAmbiguous: false, senses: [{ id: 'river', translations: ['берег'], definitionEn: 'The land beside a river.' }, { id: 'money', translations: ['банк'], definitionEn: 'A financial institution.' }], ipaCandidate: { ipa: '/bæŋk/', dialect: 'en-US' }, extraExample: null });
const payload = { expression: 'bank', context: { sentence: 'The bank was green.', targetStart: 4, targetEnd: 8 }, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', dialect: 'en-US' } as const;
const source = { kind: 'html', title: 'Sample', url: 'https://example.com', documentId: null, page: null, chapter: null, cfi: null } as const;
function options(rpc: UiRpc): PopupOptions { return { rpc, trustedPage: true, lookupPayload: payload, source, anchor: new DOMRect(10, 10, 80, 20) }; }
function fakeRpc(overrides: Record<string, unknown> = {}): UiRpc {
  return vi.fn(async (type: string) => {
    if (type in overrides) { const value = overrides[type]; return typeof value === 'function' ? value() : value; }
    if (type === 'lookup') return lookup();
    if (type === 'settings.getReader') return { defaultDeck: 'Test' };
    if (type === 'anki.decks') return { deckNames: ['Test'] };
    if (type === 'pronunciation.get') return { pronunciation: { ipa: '/bæŋk/', dialect: 'en-US', source: 'generated', sourceUrl: null } };
    return {};
  }) as UiRpc;
}
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
// jsdom behavior tests explicitly substitute the trust gate; browser isTrusted is NOT simulated.
beforeEach(() => { vi.spyOn(userActions, 'isTrustedUiEvent').mockReturnValue(true); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); document.body.append(node); root = createRoot(node); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function render(rpc: UiRpc, opt = options(rpc)) { await act(async () => root.render(<ReadingPopup options={opt} close={() => {}} />)); }
function button(label: string) { return [...node.querySelectorAll('button')].find(b => b.textContent === label)!; }
function audioCheckbox() { return [...node.querySelectorAll('label')].find(label => label.textContent?.includes('Создать аудиофайл (платный запрос)'))!.querySelector<HTMLInputElement>('input')!; }
async function changeText(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
const audioId = '55555555-5555-4555-8555-555555555555';
const audioSettings = { defaultDeck: 'Test', cloudAudioEnabled: true };
describe('Reading popup', () => {
  it('preserves exact sentence and marks generated IPA honestly', async () => {
    await render(fakeRpc());
    expect(node.querySelector('mark')?.textContent).toBe('bank');
    expect(node.querySelector('.sentence')?.textContent).toBe(payload.context.sentence);
    expect(node.textContent).toContain('сгенерировано ИИ');
    expect(node.querySelector('[role=dialog]')?.getAttribute('aria-modal')).toBe('false');
  });
  it('never replaces a newer lookup with a stale response', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const old = new Promise(resolve => { resolveOld = resolve; });
    const rpc = fakeRpc({ lookup: vi.fn().mockReturnValueOnce(old).mockResolvedValue(lookup('shore')) });
    await render(rpc);
    const next = { ...options(rpc), lookupPayload: { ...payload, expression: 'shore', context: { sentence: 'The shore is green.', targetStart: 4, targetEnd: 9 } } };
    await render(rpc, next);
    expect(node.querySelector('strong')?.textContent).toBe('shore');
    await act(async () => resolveOld(lookup('bank')));
    expect(node.querySelector('strong')?.textContent).toBe('shore');
  });
  it('distinguishes queued from added and blocks duplicate add clicks', async () => {
    let finish: (value: unknown) => void = () => {};
    const rpc = fakeRpc({ 'anki.addNote': () => new Promise(resolve => { finish = resolve; }) });
    await render(rpc);
    await act(async () => { button('Добавить в Anki').click(); button('Добавить в Anki').click(); });
    expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'anki.addNote')).toHaveLength(1);
    await act(async () => finish({ operationId: 'x', status: 'queued', noteId: null }));
    expect(node.textContent).toContain('ещё не добавлено в Anki');
    expect(node.textContent).not.toContain('Добавлено в Anki');
  });
  it('selects just one alternate meaning', async () => {
    await render(fakeRpc());
    const radios = node.querySelectorAll<HTMLInputElement>('input[type=radio]');
    await act(async () => radios[1].click());
    expect(node.querySelector('.translation')?.textContent).toBe('банк');
  });
  it('shows same-renderer preview only in sandboxed iframe', async () => {
    const rpc = fakeRpc(); const renderPreview = vi.fn(() => ({ front: '<p>Front</p>', back: '<p>Back</p>' }));
    await render(rpc, { ...options(rpc), renderPreview });
    await act(async () => button('Предпросмотр').click());
    expect(renderPreview).toHaveBeenCalled();
    expect(node.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  });
  it('isolates styles and closes on outside click', async () => {
    let handle: ReturnType<typeof mountReadingPopup>;
    await act(async () => { handle = mountReadingPopup(options(fakeRpc())); });
    const host = document.querySelector('[data-english-reader-popup]');
    expect(host?.shadowRoot?.querySelector('[role=dialog]')).toBeTruthy();
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(host?.isConnected).toBe(false);
  });
  it('Enter adds from the panel but never from a field or repeated key', async () => {
    const rpc = fakeRpc({ 'anki.addNote': { operationId: 'x', status: 'added', noteId: 1 } });
    await render(rpc);
    const panel = node.querySelector('[role=dialog]')!;
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })));
    await act(async () => node.querySelector('select')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'anki.addNote')).toHaveLength(0);
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'anki.addNote')).toHaveLength(1);
  });
  it('Escape closes the nonmodal host', async () => {
    const onClose = vi.fn();
    await act(async () => { mountReadingPopup({ ...options(fakeRpc()), onClose }); });
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[data-english-reader-popup]')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not stay in loading forever and ignores the timed-out result', async () => {
    vi.useFakeTimers();
    try {
      let resolveLookup: (value: unknown) => void = () => {};
      const rpc = fakeRpc({ lookup: () => new Promise(resolve => { resolveLookup = resolve; }) });
      await render(rpc);
      await act(async () => vi.advanceTimersByTime(25001));
      expect(node.querySelector('[role=alert]')?.textContent).toContain('слишком много времени');
      await act(async () => resolveLookup(lookup()));
      expect(node.querySelector('.translation')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('applies reader dialect before lookup and uses deck/mode preferences', async () => {
    const rpc = fakeRpc({ 'settings.getReader': { dialect: 'en-GB', defaultDeck: 'English::Reading', defaultMode: 'cloze', includeAudioByDefault: false } });
    await render(rpc);
    const request = vi.mocked(rpc).mock.calls.find(call => call[0] === 'lookup');
    expect(request?.[1]?.dialect).toBe('en-GB');
    const selects = node.querySelectorAll<HTMLSelectElement>('select');
    expect(selects[0].value).toBe('English::Reading');
    expect(selects[1].value).toBe('cloze');
  });

  it('requires explicit sense choice for ambiguous context, including Enter', async () => {
    const rpc = fakeRpc({ lookup: { ...lookup(), contextAmbiguous: true, recommendedSenseId: null } });
    await render(rpc);
    expect(button('Добавить в Anki').disabled).toBe(true);
    expect([...node.querySelectorAll<HTMLInputElement>('input[type=radio]')].some(r => r.checked)).toBe(false);
    await act(async () => node.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(vi.mocked(rpc).mock.calls.some(c => c[0] === 'anki.addNote')).toBe(false);
    await act(async () => node.querySelector<HTMLInputElement>('input[type=radio]')!.click());
    expect(button('Добавить в Anki').disabled).toBe(false);
    expect(node.querySelector('.translation')?.textContent).toBe('берег');
  });
  it('duplicate confirmation reuses the exact submitted draft and operation ID', async () => {
    const rpc = fakeRpc({ 'anki.addNote': { operationId: 'x', status: 'duplicate_review', noteId: null } });
    await render(rpc);
    await act(async () => button('Добавить в Anki').click());
    expect(button('Редактировать').disabled).toBe(true);
    await act(async () => button('Подтверждаю: добавить новую заметку несмотря на дубликат').click());
    const calls = vi.mocked(rpc).mock.calls.filter(c => c[0] === 'anki.addNote');
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual({ ...calls[0][1], duplicateAction: 'add_new' });
  });

  it('production trust gate rejects synthetic paid actions, save, keyboard, and edits', async () => {
    vi.mocked(userActions.isTrustedUiEvent).mockRestore();
    const rpc = fakeRpc({ 'settings.getReader': { defaultDeck: 'Test', cloudAudioEnabled: true } });
    await render(rpc);
    const before = vi.mocked(rpc).mock.calls.length;
    expect(userActions.isTrustedUiEvent(new MouseEvent('click'))).toBe(false);
    await act(async () => {
      button('Добавить в Anki').click();
      button('Уточнить смысл — платный запрос').click();
      button('Получить до 3 примеров — платный запрос').click();
      audioCheckbox().click();
      button('Редактировать').click();
      node.querySelector<HTMLButtonElement>('[aria-label="Прослушать выражение системным голосом"]')!.click();
      node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
      node.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(vi.mocked(rpc).mock.calls).toHaveLength(before);
    expect(node.querySelector('fieldset')).toBeNull();
    expect(node.querySelector('.translation')?.textContent).toBe('берег');
  });

  it('webpage popup defaults to no private deck metadata or deck-list request', async () => {
    const rpc = fakeRpc({ 'settings.getReader': { defaultDeck: 'PRIVATE-HEALTH-DECK', defaultMode: 'recognition' }, 'anki.decks': { deckNames: ['PRIVATE-HEALTH-DECK', 'PRIVATE-WORK-DECK'] } });
    const openSettings = vi.fn(async () => {});
    const { trustedPage: _omit, ...pageOptions } = options(rpc);
    await render(rpc, { ...pageOptions, openSettings });
    expect(vi.mocked(rpc).mock.calls.some(c => c[0] === 'anki.decks')).toBe(false);
    expect(node.innerHTML).not.toContain('PRIVATE-');
    expect(node.textContent).toContain('Колода настроена');
    await act(async () => button('Выбрать колоду в настройках').click());
    expect(openSettings).toHaveBeenCalledOnce();
    await act(async () => button('Добавить в Anki').click());
    expect((vi.mocked(rpc).mock.calls.find(c => c[0] === 'anki.addNote')?.[1]?.draft as { deckName: string }).deckName).toBe('PRIVATE-HEALTH-DECK');
  });
  it('synthetic settings handoff is blocked by production trust gate', async () => {
    vi.mocked(userActions.isTrustedUiEvent).mockRestore();
    const rpc = fakeRpc(); const openSettings = vi.fn();
    await render(rpc, { ...options(rpc), trustedPage: false, openSettings });
    await act(async () => button('Выбрать колоду в настройках').click());
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('returning from settings refreshes unsaved destination without another paid lookup', async () => {
    const preferences = vi.fn().mockResolvedValueOnce({ defaultDeck: 'PRIVATE-OLD' }).mockResolvedValue({ defaultDeck: 'PRIVATE-NEW' });
    const rpc = fakeRpc({ 'settings.getReader': preferences });
    await render(rpc, { ...options(rpc), trustedPage: false, openSettings: vi.fn() });
    await act(async () => button('Выбрать колоду в настройках').click());
    await act(async () => window.dispatchEvent(new FocusEvent('focus')));
    expect(preferences).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'lookup')).toHaveLength(1);
    expect(node.innerHTML).not.toContain('PRIVATE-');
    expect(node.querySelector('.translation')?.textContent).toBe('берег');
    await act(async () => button('Добавить в Anki').click());
    expect((vi.mocked(rpc).mock.calls.find(c => c[0] === 'anki.addNote')?.[1]?.draft as { deckName: string }).deckName).toBe('PRIVATE-NEW');
  });
  it('returning from settings never changes a submitted operation destination', async () => {
    const preferences = vi.fn().mockResolvedValueOnce({ defaultDeck: 'PRIVATE-OLD' }).mockResolvedValue({ defaultDeck: 'PRIVATE-NEW' });
    const rpc = fakeRpc({ 'settings.getReader': preferences, 'anki.addNote': { operationId: 'x', status: 'duplicate_review', noteId: null } });
    await render(rpc, { ...options(rpc), trustedPage: false, openSettings: vi.fn() });
    await act(async () => button('Добавить в Anki').click());
    await act(async () => button('Выбрать колоду в настройках').click());
    await act(async () => window.dispatchEvent(new FocusEvent('focus')));
    expect(preferences).toHaveBeenCalledTimes(1);
    await act(async () => button('Подтверждаю: добавить новую заметку несмотря на дубликат').click());
    const calls = vi.mocked(rpc).mock.calls.filter(c => c[0] === 'anki.addNote');
    expect(calls[1][1]).toEqual({ ...calls[0][1], duplicateAction: 'add_new' });
  });

  it('creates a neutral multilingual draft with a frozen pair, CEFR, and explicit source locale', async () => {
    const preferences = vi.fn().mockResolvedValueOnce({ sourceLanguage: 'ar', targetLanguage: 'ru', learnerLevel: 'A2', dialect: 'ar-SA', defaultDeck: 'Test' }).mockResolvedValue({ sourceLanguage: 'ja', targetLanguage: 'en', learnerLevel: 'C1', dialect: 'ja-JP', defaultDeck: 'New deck' });
    const rpc = fakeRpc({ 'settings.getReader': preferences, 'pronunciation.get': { pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null } } });
    await render(rpc, { ...options(rpc), trustedPage: false, openSettings: vi.fn() });
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'lookup')?.[1]).toMatchObject({ sourceLanguage: 'ar', targetLanguage: 'ru', learnerLevel: 'A2', dialect: 'ar-SA' });
    expect(node.querySelector('.sentence')?.getAttribute('lang')).toBe('ar');
    expect(node.querySelector('.sentence')?.getAttribute('dir')).toBe('auto');
    expect(node.querySelector('.translation')?.getAttribute('lang')).toBe('ru');
    expect(node.textContent).toContain('Транскрипция недоступна');
    await act(async () => button('Выбрать колоду в настройках').click());
    await act(async () => window.dispatchEvent(new FocusEvent('focus')));
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as any;
    expect(draft).toMatchObject({ draftVersion: 3, sourceLanguage: 'ar', targetLanguage: 'ru', learnerLevel: 'A2', deckName: 'New deck', examples: [] });
    expect(draft.selectedSense.definition).toBe('The land beside a river.');
    expect(draft.selectedSense).not.toHaveProperty('definitionEn');
    expect(draft).not.toHaveProperty('extraExample');
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'lookup')).toHaveLength(1);
  });
  it('offers three generated candidates, selects none automatically, and exports only chosen examples', async () => {
    const examples = [1, 2, 3].map(number => ({ text: `Example ${number}`, translation: `Пример ${number}`, source: 'ai' }));
    const rpc = fakeRpc({ 'card.enrich': { lookupId: 'lookup-1', senseId: 'river', examples } });
    await render(rpc);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'card.enrich')).toBe(false);
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    const choices = node.querySelectorAll<HTMLInputElement>('fieldset input[type=checkbox]');
    expect(choices).toHaveLength(3);
    expect([...choices].every(choice => !choice.checked)).toBe(true);
    expect(node.textContent).toContain('попадут только на обратную сторону');
    await act(async () => choices[1].click());
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as any;
    expect(draft.examples).toEqual([examples[1]]);
    expect(draft.selectedSense.id).toBe('river');
  });
  it('clears candidate and selected examples when the meaning changes', async () => {
    const rpc = fakeRpc({ 'card.enrich': { examples: [{ text: 'Example', translation: 'Пример', source: 'ai' }] } });
    await render(rpc);
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await act(async () => node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!.click());
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    expect(node.textContent).not.toContain('Примеры использования — выберите для заметки');
    await act(async () => button('Добавить в Anki').click());
    expect((vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as any).examples).toEqual([]);
  });
  it('ignores stale example generation after a different lookup is opened', async () => {
    let resolveExamples: (value: unknown) => void = () => {};
    const rpc = fakeRpc({ 'card.enrich': () => new Promise(resolve => { resolveExamples = resolve; }) });
    await render(rpc);
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'shore', context: { sentence: 'The shore is green.', targetStart: 4, targetEnd: 9 } } });
    await act(async () => resolveExamples({ examples: [{ text: 'STALE EXAMPLE', translation: 'Старый пример', source: 'ai' }] }));
    expect(node.textContent).not.toContain('STALE EXAMPLE');
    expect(button('Добавить в Anki').disabled).toBe(false);
  });

  it('clears candidate and selected examples when a refined meaning replaces them', async () => {
    const refined = { ...lookup(), recommendedSenseId: 'money' };
    const rpc = fakeRpc({ 'card.enrich': { examples: [{ text: 'Old river example', translation: 'Старый пример', source: 'ai' }] }, 'lookup.refine': refined });
    await render(rpc);
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await act(async () => node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!.click());
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(node.textContent).not.toContain('Old river example');
    expect(node.querySelector('.translation')?.textContent).toBe('банк');
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as any;
    expect(draft.examples).toEqual([]);
    expect(draft.selectedSense.id).toBe('money');
  });

  it('requires a fresh choice if refinement becomes ambiguous, with no old examples saved', async () => {
    const rpc = fakeRpc({ 'card.enrich': { examples: [{ text: 'Old example', translation: 'Старый пример', source: 'ai' }] }, 'lookup.refine': { ...lookup(), contextAmbiguous: true, recommendedSenseId: null } });
    await render(rpc);
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await act(async () => node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!.click());
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(button('Добавить в Anki').disabled).toBe(true);
    expect(button('Получить до 3 примеров — платный запрос').disabled).toBe(true);
    expect(node.textContent).not.toContain('Old example');
    expect([...node.querySelectorAll<HTMLInputElement>('input[type=radio]')].some(radio => radio.checked)).toBe(false);
  });

  it('never starts an obsolete paid lookup after a slow settings hydration', async () => {
    let resolveOld!: (value: unknown) => void;
    const settings = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ sourceLanguage: 'ja', targetLanguage: 'ru', learnerLevel: 'A1', dialect: 'ja-JP', defaultDeck: 'Test' });
    const rpc = fakeRpc({ 'settings.getReader': settings });
    await render(rpc);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'lookup')).toBe(false);
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: '本', context: { sentence: 'この本はいいです。', targetStart: 2, targetEnd: 3 } } });
    await act(async () => resolveOld({ sourceLanguage: 'ar', targetLanguage: 'en', learnerLevel: 'C1', dialect: 'ar-SA' }));
    const calls = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'lookup');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ expression: '本', sourceLanguage: 'ja', targetLanguage: 'ru', learnerLevel: 'A1', dialect: 'ja-JP' });
  });

  it('preserves Arabic UTF-16 text and selected examples through a real sandboxed preview and draft', async () => {
    const expression = 'كتابًا';
    const sentence = 'قرأت كتابًا مفيدًا.';
    const targetStart = sentence.indexOf(expression);
    const context = { sentence, targetStart, targetEnd: targetStart + expression.length };
    const example = { text: 'هذا كتاب مفيد.', translation: 'これは役に立つ本です。', source: 'ai' };
    const rpc = fakeRpc({
      'settings.getReader': { sourceLanguage: 'ar', targetLanguage: 'ja', learnerLevel: 'A2', dialect: 'ar-SA', defaultDeck: 'Test' },
      lookup: { ...lookup(expression), recommendedSenseId: 'book', senses: [{ id: 'book', translations: ['本'], definition: 'مجموعة من الصفحات للقراءة.' }], ipaCandidate: null },
      'pronunciation.get': { pronunciation: { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null } },
      'card.enrich': { examples: [example] },
    });
    await render(rpc, { ...options(rpc), renderPreview, lookupPayload: { ...payload, expression, context } });
    expect(node.querySelector('.sentence')?.textContent).toBe(sentence);
    expect(node.querySelector('mark')?.textContent).toBe(expression);
    expect(node.querySelector('.sentence')?.getAttribute('lang')).toBe('ar');
    expect(node.querySelector('.sentence')?.getAttribute('dir')).toBe('auto');
    expect(node.querySelector('.translation')?.getAttribute('lang')).toBe('ja');
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await act(async () => node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!.click());
    await act(async () => button('Предпросмотр').click());
    const previews = node.querySelectorAll<HTMLIFrameElement>('iframe');
    expect(previews).toHaveLength(2);
    expect([...previews].every(preview => preview.getAttribute('sandbox') === '')).toBe(true);
    expect(previews[0].srcdoc).not.toContain(example.text);
    expect(previews[1].srcdoc).toContain(example.text);
    expect(previews[1].srcdoc).toContain(example.translation);
    expect(previews[1].srcdoc).toContain('dir="auto"');
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as any;
    expect(draft).toMatchObject({ expression, context, sourceLanguage: 'ar', targetLanguage: 'ja', learnerLevel: 'A2', examples: [example] });
  });

  it('does not save during IME composition, then supports Ctrl+Enter while editing', async () => {
    const rpc = fakeRpc();
    await render(rpc);
    await act(async () => button('Редактировать').click());
    const field = node.querySelector('textarea')!;
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })));
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    const calls = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.addNote');
    expect(calls).toHaveLength(1);
    expect((calls[0][1]?.draft as any).context).toEqual(payload.context);
  });

  it('focuses the nonmodal panel and restores the original field after dismissal', async () => {
    let frame = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++frame, callback); return frame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
    const original = document.createElement('input'); document.body.append(original); original.focus();
    const onClose = vi.fn();
    await act(async () => { mountReadingPopup({ ...options(fakeRpc()), onClose }); });
    await act(async () => { for (const [id, callback] of [...callbacks]) { callbacks.delete(id); callback(0); } });
    const host = document.querySelector<HTMLElement>('[data-english-reader-popup]')!;
    expect(document.activeElement).toBe(host);
    expect(host.shadowRoot?.activeElement?.getAttribute('role')).toBe('dialog');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(original);
    expect(onClose).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);
  });

  it('does not steal focus back if the user has already moved to another page field', async () => {
    const before = document.createElement('input'); const after = document.createElement('input');
    document.body.append(before, after); before.focus();
    let handle!: ReturnType<typeof mountReadingPopup>;
    await act(async () => { handle = mountReadingPopup(options(fakeRpc())); });
    after.focus();
    await act(async () => handle.close());
    expect(document.activeElement).toBe(after);
  });

  it('retries an uncertain save with the exact submitted snapshot and locks all edits', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('Connection lost after submission')).mockResolvedValue({ operationId: 'x', status: 'already_added', noteId: 1 });
    const rpc = fakeRpc({ 'anki.addNote': add });
    await render(rpc);
    await act(async () => button('Добавить в Anki').click());
    expect(node.textContent).toContain('тот же снимок и идентификатор');
    expect(button('Редактировать').disabled).toBe(true);
    expect(button('Уточнить смысл — платный запрос').disabled).toBe(true);
    expect(button('Получить до 3 примеров — платный запрос').disabled).toBe(true);
    expect([...node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[type=radio],input[type=checkbox],select')].every(field => field.matches(':disabled'))).toBe(true);
    await act(async () => button('Повторить сохранение').click());
    const calls = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.addNote');
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(node.textContent).toContain('Эта операция уже добавлена в Anki');
  });

  it('deduplicates repeated paid example actions before React rerenders and blocks a concurrent save', async () => {
    let resolve!: (value: unknown) => void;
    const rpc = fakeRpc({ 'card.enrich': () => new Promise(done => { resolve = done; }) });
    await render(rpc);
    await act(async () => { button('Получить до 3 примеров — платный запрос').click(); button('Получить до 3 примеров — платный запрос').click(); button('Добавить в Anki').click(); });
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'card.enrich')).toHaveLength(1);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    await act(async () => resolve({ examples: [] }));
    expect(button('Добавить в Anki').disabled).toBe(false);
  });

  it('does not let late pronunciation change the submitted draft or its preview', async () => {
    let resolve!: (value: unknown) => void;
    const rpc = fakeRpc({ 'pronunciation.get': () => new Promise(done => { resolve = done; }), 'anki.addNote': () => Promise.reject(new Error('uncertain save')) });
    const preview = vi.fn((_draft: NoteDraft) => ({ front: '<p>front</p>', back: '<p>back</p>' }));
    await render(rpc, { ...options(rpc), renderPreview: preview });
    await act(async () => button('Добавить в Anki').click());
    const submittedDraft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as any;
    await act(async () => resolve({ pronunciation: { ipa: '/DIFFERENT/', dialect: 'en-US', source: 'dictionary', sourceUrl: null } }));
    await act(async () => button('Предпросмотр').click());
    expect(preview.mock.calls.at(-1)?.[0]).toBe(submittedDraft);
    expect(node.textContent).not.toContain('DIFFERENT');
  });

  it('keeps a locally invalid empty lemma editable before dispatch, then saves the corrected draft', async () => {
    const rpc = fakeRpc({ 'anki.addNote': { operationId: 'x', status: 'added', noteId: 1 } });
    await render(rpc);
    await act(async () => button('Редактировать').click());
    const lemma = [...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Лемма')!.querySelector<HTMLInputElement>('input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(lemma, ''); lemma.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    expect(node.querySelector('[role=alert]')?.textContent).toBe('Укажите лемму.');
    expect(lemma.matches(':disabled')).toBe(false);
    expect(button('Готово').disabled).toBe(false);
    expect(node.textContent).not.toContain('Повторить сохранение');
    expect(node.textContent).not.toContain('редактирование заблокировано');
    await act(async () => { setValue.call(lemma, 'bank'); lemma.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Готово').click());
    await act(async () => button('Добавить в Anki').click());
    const calls = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.addNote');
    expect(calls).toHaveLength(1);
    expect((calls[0][1]?.draft as NoteDraft).lemma).toBe('bank');
  });

  it('validates the complete draft before freezing rather than only checking empty fields', async () => {
    const rpc = fakeRpc();
    await render(rpc);
    await act(async () => button('Редактировать').click());
    const lemma = [...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Лемма')!.querySelector<HTMLInputElement>('input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(lemma, 'x'.repeat(257)); lemma.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    expect(node.querySelector('[role=alert]')?.textContent).toContain('слишком длинные');
    expect(lemma.matches(':disabled')).toBe(false);
    expect(button('Готово').disabled).toBe(false);
  });

  it('atomically replaces refined lemma, part of speech and sense, and ignores delayed initial pronunciation', async () => {
    let resolveInitial!: (value: unknown) => void;
    let resolveCurrent!: (value: unknown) => void;
    const pronunciation = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; })).mockImplementationOnce(() => new Promise(resolve => { resolveCurrent = resolve; }));
    const initial = { ...lookup('saw'), lookupId: 'initial-saw', lemma: 'saw', partOfSpeech: 'noun', recommendedSenseId: 'tool', senses: [{ id: 'tool', translations: ['пила'], definition: 'A cutting tool.' }], ipaCandidate: { ipa: '/INITIAL/', dialect: 'en-US' } };
    const refined = { ...initial, lookupId: 'refined-see', lemma: 'see', partOfSpeech: 'verb', recommendedSenseId: 'vision', senses: [{ id: 'vision', translations: ['видеть'], definition: 'To notice with your eyes.' }], ipaCandidate: null };
    const rpc = fakeRpc({ lookup: initial, 'lookup.refine': refined, 'pronunciation.get': pronunciation, 'anki.decks': { deckNames: ['Test', 'Other deck'] } });
    const context = { sentence: 'I saw the bird.', targetStart: 2, targetEnd: 5 };
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'saw', context } });
    const [deck, mode] = node.querySelectorAll<HTMLSelectElement>('select');
    await act(async () => { deck.value = 'Other deck'; deck.dispatchEvent(new Event('change', { bubbles: true })); mode.value = 'cloze'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(node.querySelector('header small')?.textContent).toBe('verb');
    expect(node.querySelector('.translation')?.textContent).toBe('видеть');
    expect(node.textContent).not.toContain('[INITIAL]');
    expect(node.textContent).toContain('Транскрипция недоступна');
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'pronunciation.get').map(call => call[1])).toEqual([{ lookupId: 'initial-saw' }, { lookupId: 'refined-see' }]);
    await act(async () => resolveInitial({ pronunciation: { ipa: '/STALE_INITIAL/', dialect: 'en-US', source: 'generated', sourceUrl: null } }));
    expect(node.textContent).not.toContain('[STALE_INITIAL]');
    await act(async () => resolveCurrent({ pronunciation: { ipa: '/CURRENT/', dialect: 'en-US', source: 'generated', sourceUrl: null } }));
    await act(async () => button('Редактировать').click());
    expect([...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Лемма')!.querySelector<HTMLInputElement>('input')!.value).toBe('see');
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as NoteDraft;
    expect(draft).toMatchObject({ expression: 'saw', lemma: 'see', partOfSpeech: 'verb', selectedSense: { id: 'vision', definition: 'To notice with your eyes.', translations: ['видеть'] }, pronunciation: { ipa: '/CURRENT/' }, deckName: 'Other deck', mode: 'cloze', tags: ['EnglishReader'], context, source });
  });

  it('does not let pronunciation from an older refinement overwrite the latest meaning', async () => {
    let resolveOlder!: (value: unknown) => void;
    const pronunciation = vi.fn().mockResolvedValueOnce({ pronunciation: { ipa: '/BASE/', dialect: 'en-US', source: 'generated', sourceUrl: null } }).mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; })).mockResolvedValueOnce({ pronunciation: { ipa: '/LATEST/', dialect: 'en-US', source: 'generated', sourceUrl: null } });
    const refinement = vi.fn().mockResolvedValueOnce({ ...lookup(), lookupId: 'refine-1', lemma: 'first', partOfSpeech: 'verb', ipaCandidate: null }).mockResolvedValueOnce({ ...lookup(), lookupId: 'refine-2', lemma: 'latest', partOfSpeech: 'noun', ipaCandidate: null });
    const rpc = fakeRpc({ 'pronunciation.get': pronunciation, 'lookup.refine': refinement });
    await render(rpc);
    await act(async () => button('Уточнить смысл — платный запрос').click());
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(node.textContent).toContain('[LATEST]');
    await act(async () => resolveOlder({ pronunciation: { ipa: '/OLDER_REFINEMENT/', dialect: 'en-US', source: 'generated', sourceUrl: null } }));
    expect(node.textContent).not.toContain('[OLDER_REFINEMENT]');
    expect(node.textContent).toContain('[LATEST]');
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as NoteDraft;
    expect(draft).toMatchObject({ lemma: 'latest', partOfSpeech: 'noun', pronunciation: { ipa: '/LATEST/' } });
  });

  it('host Escape requires a trusted non-IME event before closing the popup', async () => {
    vi.mocked(userActions.isTrustedUiEvent).mockRestore();
    const onClose = vi.fn();
    await act(async () => { mountReadingPopup({ ...options(fakeRpc()), onClose }); });
    const host = document.querySelector<HTMLElement>('[data-english-reader-popup]')!;
    const panel = host.shadowRoot!.querySelector('[role=dialog]')!;
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true })));
    expect(host.isConnected).toBe(true); expect(onClose).not.toHaveBeenCalled();
    vi.spyOn(userActions, 'isTrustedUiEvent').mockReturnValue(true);
    const composing = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, composed: true, cancelable: true });
    await act(async () => panel.dispatchEvent(composing));
    expect(host.isConnected).toBe(true); expect(composing.defaultPrevented).toBe(false);
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, composed: true, cancelable: true })));
    expect(host.isConnected).toBe(true);
    await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true })));
    expect(host.isConnected).toBe(false); expect(onClose).toHaveBeenCalledOnce();
  });

  it('clears unbound pronunciation on manual meaning change and ignores its delayed lookup response', async () => {
    let resolvePronunciation!: (value: unknown) => void;
    const lookupResult = { ...lookup('lead'), lemma: 'lead', recommendedSenseId: 'metal', senses: [{ id: 'metal', translations: ['свинец'], definition: 'A heavy metal.' }, { id: 'guide', translations: ['вести'], definition: 'To guide a group.' }], ipaCandidate: { ipa: '/lɛd/', dialect: 'en-US' } };
    const rpc = fakeRpc({ lookup: lookupResult, 'pronunciation.get': () => new Promise(resolve => { resolvePronunciation = resolve; }) });
    const context = { sentence: 'They lead the team.', targetStart: 5, targetEnd: 9 };
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'lead', context } });
    expect(node.textContent).toContain('[lɛd]');
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    expect(node.querySelector('.translation')?.textContent).toBe('вести');
    expect(node.textContent).not.toContain('[lɛd]');
    expect(node.textContent).toContain('Транскрипция недоступна для выбранного значения');
    await act(async () => resolvePronunciation({ pronunciation: { ipa: '/lɛd/', dialect: 'en-US', source: 'generated', sourceUrl: null } }));
    expect(node.textContent).not.toContain('[lɛd]');
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'pronunciation.get')).toHaveLength(1);
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as NoteDraft;
    expect(draft.selectedSense.id).toBe('guide');
    expect(draft.pronunciation).toEqual({ ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null });
    expect(draft.context).toEqual(context);
  });

  it('retains all 8 returned meanings and all 4 translations, with the contextual meaning first', async () => {
    const senses = Array.from({ length: 8 }, (_, index) => ({ id: `sense-${index}`, definition: `Common definition ${index}.`, translations: Array.from({ length: 4 }, (_, translation) => `перевод-${index}-${translation}`) }));
    const rpc = fakeRpc({ lookup: { ...lookup(), recommendedSenseId: 'sense-7', senses } });
    await render(rpc, { ...options(rpc), renderPreview });
    expect(node.textContent).toContain('Значения в карточке (8)');
    expect(node.textContent).toContain('не полный словарь');
    expect(node.querySelector('.translation')?.textContent).toBe(senses[7].translations.join('; '));
    await act(async () => button('Предпросмотр').click());
    const back = node.querySelectorAll<HTMLIFrameElement>('iframe')[1].srcdoc;
    for (const sense of senses) for (const translation of sense.translations) expect(back).toContain(translation);
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as FullMeaningsNoteDraft;
    expect(draft.draftVersion).toBe(3);
    expect(draft.senses).toEqual([senses[7], ...senses.slice(0, 7)]);
    expect(draft.selectedSense).toEqual(draft.senses[0]);
  });

  it('keeps primary edits in the full list when switching away and back, and clears stale examples and IPA', async () => {
    const example = { text: 'The bank was steep.', translation: 'Берег был крутым.', source: 'ai' };
    const rpc = fakeRpc({ 'card.enrich': { examples: [example] } });
    await render(rpc);
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await act(async () => node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!.click());
    await act(async () => button('Редактировать').click());
    const translation = [...node.querySelectorAll('label')].find(label => label.textContent?.startsWith('Переводы ('))!.querySelector<HTMLInputElement>('input')!;
    await changeText(translation, 'берег; побережье; склон; отмель');
    await changeText(node.querySelector('textarea')!, 'Edited shore definition.');
    expect(node.textContent).not.toContain(example.text);
    expect(node.querySelector('.pronunciation-ipa')).toBeNull();
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    expect(node.querySelector('.translation')?.textContent).toBe('берег; побережье; склон; отмель');
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as FullMeaningsNoteDraft;
    expect(draft.selectedSense).toEqual(draft.senses[0]);
    expect(draft.selectedSense).toMatchObject({ id: 'river', definition: 'Edited shore definition.', translations: ['берег', 'побережье', 'склон', 'отмель'] });
    expect(draft.senses[1].id).toBe('money'); expect(draft.examples).toEqual([]); expect(draft.pronunciation.ipa).toBeNull();
  });

  it('does not silently truncate an over-limit translation edit and keeps it recoverable', async () => {
    const rpc = fakeRpc(); await render(rpc);
    await act(async () => button('Редактировать').click());
    const field = [...node.querySelectorAll('label')].find(label => label.textContent?.startsWith('Переводы ('))!.querySelector<HTMLInputElement>('input')!;
    await changeText(field, 'один; два; три; четыре; пять');
    await act(async () => button('Добавить в Anki').click());
    expect(field.value).toContain('пять'); expect(field.disabled).toBe(false);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    await changeText(field, 'один; два; три; четыре');
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as FullMeaningsNoteDraft;
    expect(draft.senses[0].translations).toEqual(['один', 'два', 'три', 'четыре']);
  });

  it('refinement replaces the complete meanings list atomically, rather than retaining obsolete lookup senses', async () => {
    const senses = [{ id: 'new-other', definition: 'Another new meaning.', translations: ['другой', 'иной', 'ещё один'] }, { id: 'new-primary', definition: 'The new primary meaning.', translations: ['первый', 'главный', 'основной', 'ключевой'] }];
    const rpc = fakeRpc({ 'lookup.refine': { ...lookup(), lookupId: 'new-lookup', lemma: 'refined', recommendedSenseId: 'new-primary', senses } });
    await render(rpc);
    await act(async () => button('Уточнить смысл — платный запрос').click());
    await act(async () => button('Добавить в Anki').click());
    const draft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as FullMeaningsNoteDraft;
    expect(draft.senses).toEqual([senses[1], senses[0]]); expect(draft.selectedSense).toEqual(draft.senses[0]);
    expect(draft.lemma).toBe('refined'); expect(draft.senses.some(sense => sense.id === 'river')).toBe(false);
  });

  it('shows enlarged square-bracket IPA with attribution while preserving the exact stored IPA', async () => {
    const pronunciation = { ipa: '/bæŋk/', dialect: 'en-US', source: 'dictionary', sourceUrl: 'https://dictionary.example/bank' };
    const rpc = fakeRpc({ 'pronunciation.get': { pronunciation } }); await render(rpc);
    expect(node.querySelector('.pronunciation-ipa')?.textContent).toBe('[bæŋk]');
    expect(node.querySelector('.pronunciation-source')?.textContent).toBe('словарь');
    expect(uiCss).toContain('.pronunciation-ipa{font-size:1.6em;');
    await act(async () => button('Добавить в Anki').click());
    expect((vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.draft as NoteDraft).pronunciation).toEqual(pronunciation);
  });

  it('never prepares paid audio from the old default preference, mount, or pronunciation hydration', async () => {
    const rpc = fakeRpc({ 'settings.getReader': { ...audioSettings, includeAudioByDefault: true } }); await render(rpc);
    expect(audioCheckbox().checked).toBe(false);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'audio.prepare')).toBe(false);
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ includeAudio: false });
  });

  it('checking audio prepares immediately, blocks a concurrent save, and reuses the same ID for preview and add', async () => {
    let resolveAudio!: (value: unknown) => void;
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': () => new Promise(resolve => { resolveAudio = resolve; }) }); await render(rpc);
    await act(async () => { audioCheckbox().click(); button('Добавить в Anki').click(); });
    const prepares = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare');
    expect(prepares).toHaveLength(1); expect(prepares[0][1]).toMatchObject({ lookupId: 'lookup-1', senseId: 'river', draft: { draftVersion: 3 } });
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    expect(audioCheckbox().disabled).toBe(false);
    await act(async () => resolveAudio({ audioId }));
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать готовый аудиофайл"]')!.click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'audio.play')?.[1]).toEqual({ audioId });
    await act(async () => button('Добавить в Anki').click());
    const saved = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1];
    expect(saved).toMatchObject({ includeAudio: true, audioId }); expect(saved?.draft).toEqual(prepares[0][1]?.draft);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
  });

  it('unticking ignores a late audio result, and rechecking the same pending draft makes no duplicate request', async () => {
    let resolveAudio!: (value: unknown) => void;
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': () => new Promise(resolve => { resolveAudio = resolve; }) }); await render(rpc);
    await act(async () => audioCheckbox().click());
    await act(async () => audioCheckbox().click());
    expect(audioCheckbox().checked).toBe(false);
    await act(async () => audioCheckbox().click());
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => audioCheckbox().click());
    await act(async () => resolveAudio({ audioId }));
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).toBeNull();
    await act(async () => button('Добавить в Anki').click());
    const saved = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1];
    expect(saved?.includeAudio).toBe(false); expect(saved).not.toHaveProperty('audioId');
  });

  it('a primary meaning change invalidates pending audio and never silently regenerates it', async () => {
    let resolveAudio!: (value: unknown) => void;
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': () => new Promise(resolve => { resolveAudio = resolve; }) }); await render(rpc);
    await act(async () => audioCheckbox().click());
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    await act(async () => resolveAudio({ audioId }));
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).toBeNull();
    expect(button('Создать аудио сейчас — платный запрос')).toBeTruthy();
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => audioCheckbox().click());
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ includeAudio: false, draft: { selectedSense: { id: 'money' } } });
  });

  it('late pronunciation invalidates ready audio without charging again', async () => {
    let resolvePronunciation!: (value: unknown) => void;
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'pronunciation.get': () => new Promise(resolve => { resolvePronunciation = resolve; }) }); await render(rpc);
    await act(async () => audioCheckbox().click());
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).not.toBeNull();
    await act(async () => resolvePronunciation({ pronunciation: { ipa: '/CHANGED/', dialect: 'en-US', source: 'dictionary', sourceUrl: null } }));
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).toBeNull();
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
  });

  it('audio errors need explicit retry or an unchecked save; save never generates audio implicitly', async () => {
    const prepare = vi.fn().mockRejectedValueOnce(new Error('Audio unavailable')).mockResolvedValue({ audioId });
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': prepare }); await render(rpc);
    await act(async () => audioCheckbox().click());
    expect(node.textContent).toContain('Audio unavailable');
    await act(async () => button('Добавить в Anki').click());
    expect(prepare).toHaveBeenCalledTimes(1); expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    await act(async () => button('Повторить создание аудио — платный запрос').click());
    await act(async () => button('Добавить в Anki').click());
    expect(prepare).toHaveBeenCalledTimes(2); expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]?.audioId).toBe(audioId);
  });

  it('freezes the prepared audio ID with an uncertain submitted intent and retries exactly that intent', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('Unknown result')).mockResolvedValue({ status: 'already_added', noteId: 1 });
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'anki.addNote': add }); await render(rpc);
    await act(async () => audioCheckbox().click());
    await act(async () => button('Добавить в Anki').click());
    expect(audioCheckbox().disabled).toBe(true);
    await act(async () => button('Повторить сохранение').click());
    const calls = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.addNote');
    expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]); expect(calls[0][1]?.audioId).toBe(audioId);
  });

  it('trusted settings return refreshes audio consent without another lookup or automatic prepare', async () => {
    const settings = vi.fn().mockResolvedValueOnce({ defaultDeck: 'Test', cloudAudioEnabled: false }).mockResolvedValue({ ...audioSettings, includeAudioByDefault: true, sourceLanguage: 'ja', targetLanguage: 'ar' });
    const rpc = fakeRpc({ 'settings.getReader': settings, 'audio.prepare': { audioId } }); const openSettings = vi.fn();
    await render(rpc, { ...options(rpc), trustedPage: false, openSettings });
    expect(audioCheckbox().disabled).toBe(true);
    await act(async () => button('Настройки облачного аудио').click());
    await act(async () => window.dispatchEvent(new FocusEvent('focus')));
    expect(openSettings).toHaveBeenCalledOnce(); expect(audioCheckbox().disabled).toBe(false); expect(audioCheckbox().checked).toBe(false);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'lookup')).toHaveLength(1);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'audio.prepare')).toBe(false);
    await act(async () => audioCheckbox().click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'audio.prepare')?.[1]?.draft).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'ru', context: payload.context });
  });

  it('revoking consent on trusted return clears pending audio intent and ignores its eventual result', async () => {
    let resolveAudio!: (value: unknown) => void;
    const settings = vi.fn().mockResolvedValueOnce(audioSettings).mockResolvedValue({ defaultDeck: 'Test', cloudAudioEnabled: false });
    const rpc = fakeRpc({ 'settings.getReader': settings, 'audio.prepare': () => new Promise(resolve => { resolveAudio = resolve; }) });
    await render(rpc, { ...options(rpc), trustedPage: false, openSettings: vi.fn() });
    await act(async () => audioCheckbox().click());
    await act(async () => button('Выбрать колоду в настройках').click());
    await act(async () => window.dispatchEvent(new FocusEvent('focus')));
    await act(async () => resolveAudio({ audioId }));
    expect(audioCheckbox().disabled).toBe(true); expect(audioCheckbox().checked).toBe(false);
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).toBeNull();
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ includeAudio: false });
  });

  it('keeps a prepared file across deck and note-mode changes without another request', async () => {
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'anki.decks': { deckNames: ['Test', 'Other'] } }); await render(rpc);
    await act(async () => audioCheckbox().click());
    const [deck, mode] = node.querySelectorAll<HTMLSelectElement>('select');
    await act(async () => { deck.value = 'Other'; deck.dispatchEvent(new Event('change', { bubbles: true })); mode.value = 'cloze'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).not.toBeNull();
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ includeAudio: true, audioId, draft: { deckName: 'Other', mode: 'cloze' } });
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
  });

  it('ignores an old prepared file after a newer popup lookup begins', async () => {
    let resolveAudio!: (value: unknown) => void;
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': () => new Promise(resolve => { resolveAudio = resolve; }), lookup: vi.fn().mockResolvedValueOnce(lookup()).mockResolvedValue({ ...lookup('shore'), lookupId: 'lookup-2' }) });
    await render(rpc);
    await act(async () => audioCheckbox().click());
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'shore', context: { sentence: 'The shore is green.', targetStart: 4, targetEnd: 9 } } });
    await act(async () => resolveAudio({ audioId }));
    expect(audioCheckbox().checked).toBe(false); expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).toBeNull();
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ includeAudio: false, draft: { expression: 'shore' } });
  });

  it('successive primary selections keep all other meanings in original lookup order for audio binding', async () => {
    const senses = [
      { id: 'A', definition: 'Meaning A.', translations: ['А'] },
      { id: 'B', definition: 'Meaning B.', translations: ['Б'] },
      { id: 'C', definition: 'Meaning C.', translations: ['В'] },
    ];
    const rpc = fakeRpc({ lookup: { ...lookup(), recommendedSenseId: 'A', senses }, 'settings.getReader': audioSettings, 'audio.prepare': { audioId } });
    await render(rpc);
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[2].click());
    await act(async () => audioCheckbox().click());
    const preparedDraft = vi.mocked(rpc).mock.calls.find(call => call[0] === 'audio.prepare')?.[1]?.draft as FullMeaningsNoteDraft;
    expect(preparedDraft.senses.map(sense => sense.id)).toEqual(['C', 'A', 'B']);
    expect(preparedDraft.selectedSense).toEqual(preparedDraft.senses[0]);
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ audioId, draft: preparedDraft });
  });

  it('preflights edited secondary meanings, suppresses futile audio requests, and preserves edits when saving without audio', async () => {
    const senses = [{ id: 'A', definition: 'Meaning A.', translations: ['первый', 'первичный'] }, { id: 'B', definition: 'Meaning B.', translations: ['второй'] }];
    const rpc = fakeRpc({ lookup: { ...lookup(), recommendedSenseId: 'A', senses }, 'settings.getReader': audioSettings, 'audio.prepare': { audioId } });
    await render(rpc); await act(async () => button('Редактировать').click());
    const translation = [...node.querySelectorAll('label')].find(label => label.textContent?.startsWith('Переводы ('))!.querySelector<HTMLInputElement>('input')!;
    await changeText(translation, 'первый');
    // The service permits a translation subset while A remains the primary sense.
    expect(audioCheckbox().disabled).toBe(false);
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    expect(audioCheckbox().disabled).toBe(true);
    expect(node.textContent).toContain('остальные значения — без изменений');
    expect(node.textContent).toContain('сохраните свои правки без аудио');
    await act(async () => audioCheckbox().click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'audio.prepare')).toBe(false);
    expect(button('Создать аудио сейчас — платный запрос')).toBeUndefined();
    await act(async () => button('Добавить в Anki').click());
    const saved = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1];
    expect(saved?.includeAudio).toBe(false);
    const draft = saved?.draft as FullMeaningsNoteDraft;
    expect(draft.senses.map(sense => sense.id)).toEqual(['B', 'A']);
    expect(draft.senses[1].translations).toEqual(['первый']);
  });

  it('explicit restoration repairs audio eligibility without charging or discarding edits before that action', async () => {
    const senses = [{ id: 'A', definition: 'Meaning A.', translations: ['первый', 'первичный'] }, { id: 'B', definition: 'Meaning B.', translations: ['второй'] }];
    const rpc = fakeRpc({ lookup: { ...lookup(), recommendedSenseId: 'A', senses }, 'settings.getReader': audioSettings, 'audio.prepare': { audioId } });
    await render(rpc); await act(async () => audioCheckbox().click());
    await act(async () => button('Редактировать').click());
    const translation = [...node.querySelectorAll('label')].find(label => label.textContent?.startsWith('Переводы ('))!.querySelector<HTMLInputElement>('input')!;
    await changeText(translation, 'первый');
    await act(async () => node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click());
    expect(audioCheckbox().checked).toBe(true); expect(audioCheckbox().disabled).toBe(false);
    expect(node.textContent).toContain('Восстановление удалит ваши правки');
    expect(button('Создать аудио сейчас — платный запрос')).toBeUndefined();
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => button('Восстановить исходные значения и лемму').click());
    expect(node.querySelector('.translation')?.textContent).toBe('второй');
    expect(node.textContent).toContain('первый; первичный');
    expect(node.textContent).not.toContain('Облачное аудио недоступно после этих правок');
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => button('Создать аудио сейчас — платный запрос').click());
    const prepares = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare');
    expect(prepares).toHaveLength(2);
    expect((prepares[1][1]?.draft as FullMeaningsNoteDraft).senses).toEqual([senses[1], senses[0]]);
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ includeAudio: true, audioId });
  });

  it.each(['lemma', 'definition', 'translation'] as const)('preflights a custom %s against the frozen lookup without weakening note editing', async fieldName => {
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId } }); await render(rpc);
    await act(async () => button('Редактировать').click());
    const field = fieldName === 'definition' ? node.querySelector('textarea')! : [...node.querySelectorAll('label')].find(label => fieldName === 'lemma' ? label.firstChild?.textContent === 'Лемма' : label.textContent?.startsWith('Переводы ('))!.querySelector<HTMLInputElement>('input')!;
    await changeText(field, fieldName === 'translation' ? 'свой перевод' : 'Custom edited value');
    expect(audioCheckbox().disabled).toBe(true); expect(field.disabled).toBe(false);
    await act(async () => audioCheckbox().click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'audio.prepare')).toBe(false);
    await act(async () => button('Восстановить исходные значения и лемму').click());
    expect(audioCheckbox().disabled).toBe(false);
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'audio.prepare')).toBe(false);
  });

  it.each(['PERMISSION_DENIED', 'AUDIO_UNAVAILABLE'])('invalidates a prepared preview after %s without an automatic paid recovery', async code => {
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'audio.play': () => Promise.reject(new Error(code)) }); await render(rpc);
    await act(async () => audioCheckbox().click());
    const original = vi.mocked(rpc).mock.calls.find(call => call[0] === 'audio.prepare')?.[1]?.draft;
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать готовый аудиофайл"]')!.click());
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).toBeNull();
    expect(node.textContent).toContain('аудиофайл больше недоступен');
    expect(node.textContent).toContain('Новый перевод и создание аудио могут быть платными');
    expect(node.textContent).toContain('Ваши правки остаются в этом окне до закрытия');
    expect(button('Повторить создание аудио — платный запрос')).toBeUndefined();
    expect(button('Создать аудио сейчас — платный запрос')).toBeUndefined();
    expect(audioCheckbox().checked).toBe(true); expect(audioCheckbox().disabled).toBe(false);
    expect(button('Редактировать').disabled).toBe(false);
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.some(call => call[0] === 'anki.addNote')).toBe(false);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'lookup')).toHaveLength(1);
    await act(async () => audioCheckbox().click());
    expect(audioCheckbox().checked).toBe(false); expect(audioCheckbox().disabled).toBe(true);
    await act(async () => audioCheckbox().click());
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => button('Добавить в Anki').click());
    const saved = vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1];
    expect(saved).toMatchObject({ includeAudio: false, draft: original }); expect(saved).not.toHaveProperty('audioId');
  });

  it('preserves edits through unavailable audio and closes only after the explicit recovery action', async () => {
    const close = vi.fn();
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'audio.play': () => Promise.reject(new Error('Cached file missing')) });
    await act(async () => root.render(<ReadingPopup options={options(rpc)} close={close} />));
    await act(async () => audioCheckbox().click());
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать готовый аудиофайл"]')!.click());
    await act(async () => button('Редактировать').click());
    const lemma = [...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Лемма')!.querySelector<HTMLInputElement>('input')!;
    await changeText(lemma, 'edited-bank');
    expect(lemma.value).toBe('edited-bank');
    expect(node.textContent).toContain('аудиофайл больше недоступен');
    expect(button('Повторить создание аудио — платный запрос')).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'lookup')).toHaveLength(1);
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'audio.prepare')).toHaveLength(1);
    await act(async () => button('Закрыть перевод и выбрать слово заново').click());
    expect(close).toHaveBeenCalledOnce();
    expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'lookup')).toHaveLength(1);
  });

  it('a late playback error from an old popup lookup cannot invalidate a new ready file even if its ID is the same', async () => {
    let rejectPlay!: (error: Error) => void;
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'audio.play': () => new Promise((_resolve, reject) => { rejectPlay = reject; }), lookup: vi.fn().mockResolvedValueOnce(lookup()).mockResolvedValue({ ...lookup('shore'), lookupId: 'lookup-2' }) });
    await render(rpc); await act(async () => audioCheckbox().click());
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать готовый аудиофайл"]')!.click());
    await render(rpc, { ...options(rpc), lookupPayload: { ...payload, expression: 'shore', context: { sentence: 'The shore is green.', targetStart: 4, targetEnd: 9 } } });
    await act(async () => audioCheckbox().click());
    await act(async () => rejectPlay(new Error('Old permission revoked')));
    expect(node.querySelector('[aria-label="Прослушать готовый аудиофайл"]')).not.toBeNull();
    expect(node.textContent).not.toContain('аудиофайл больше недоступен');
    await act(async () => button('Добавить в Anki').click());
    expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'anki.addNote')?.[1]).toMatchObject({ audioId, includeAudio: true, draft: { expression: 'shore' } });
  });

  it('a failed preview never rewrites an already submitted uncertain intent or its saved audio ID', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('Unknown save outcome')).mockResolvedValue({ status: 'already_added', noteId: 1 });
    const rpc = fakeRpc({ 'settings.getReader': audioSettings, 'audio.prepare': { audioId }, 'audio.play': () => Promise.reject(new Error('PERMISSION_DENIED')), 'anki.addNote': add });
    await render(rpc); await act(async () => audioCheckbox().click());
    await act(async () => button('Добавить в Anki').click());
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать готовый аудиофайл"]')!.click());
    expect(node.textContent).toContain('Снимок уже отправленной операции не изменён');
    expect(audioCheckbox().disabled).toBe(true);
    expect(button('Закрыть перевод и выбрать слово заново')).toBeUndefined();
    await act(async () => button('Повторить сохранение').click());
    const saved = vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.addNote');
    expect(saved).toHaveLength(2); expect(saved[1][1]).toEqual(saved[0][1]); expect(saved[1][1]?.audioId).toBe(audioId);
  });

});
