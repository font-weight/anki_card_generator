import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingPopup } from '../../apps/extension/src/ui/ReadingPopup';
import { mountReadingPopup } from '../../apps/extension/src/ui/mount';
import * as userActions from '../../apps/extension/src/ui/user-actions';
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
      button('Создать пример ИИ — платный запрос').click();
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

});
