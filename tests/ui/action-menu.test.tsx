import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from '../../apps/extension/src/action/ActionMenu';

const baseUrl = 'chrome-extension://own-extension/';
type Tab = Pick<chrome.tabs.Tab, 'id' | 'url'>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function eventMock<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    fire: (...args: Parameters<T>) => { for (const listener of listeners) listener(...args); },
    listeners,
  };
}
let node: HTMLDivElement, root: ReturnType<typeof createRoot>, unmounted: boolean;
let tab: Tab | undefined;
let query: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>, sendMessage: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.spyOn>;
let activated: ReturnType<typeof eventMock<() => void>>;
let updated: ReturnType<typeof eventMock<(id: number, change: chrome.tabs.OnUpdatedInfo) => void>>;
let fetchMock: ReturnType<typeof vi.fn>, inject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node);
  root = createRoot(node); unmounted = false;
  tab = { id: 12, url: 'https://example.com/article' };
  query = vi.fn(async () => tab ? [tab] : []);
  create = vi.fn(async () => ({ id: 21 }));
  sendMessage = vi.fn(async () => ({ ok: true }));
  fetchMock = vi.fn(); inject = vi.fn();
  activated = eventMock(); updated = eventMock();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    tabs: { query, create, onActivated: activated, onUpdated: updated },
    runtime: { getURL: (path: string) => `${baseUrl}${path}`, sendMessage },
    scripting: { executeScript: inject },
  });
  close = vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function mount() { await act(async () => root.render(<ActionMenu />)); }
function primary() { return node.querySelector<HTMLButtonElement>('.action-primary')!; }
function button(label: string) {
  const found = [...node.querySelectorAll('button')].find(value => value.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(element = primary()) { await act(async () => element.click()); }
function expectNoActivation() {
  expect(sendMessage).not.toHaveBeenCalled();
  expect(inject).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

describe('toolbar menu render and read-only opening', () => {
  it('loads current-tab metadata without any content injection, service request or new tab', async () => {
    await mount();
    expect(query).toHaveBeenCalledExactlyOnceWith({ active: true, currentWindow: true });
    expectNoActivation(); expect(create).not.toHaveBeenCalled();
    expect(node.querySelector('h1')?.textContent).toBe('Language Reader for Anki');
    expect(node.querySelector('.action-page-label')?.textContent).toBe('example.com');
    expect(node.querySelector('[role=status]')?.textContent).toContain('Чтение на странице');
    expect(primary().textContent).toBe('Включить чтение');
    expect(primary().disabled).toBe(false);
    expect(node.querySelectorAll('a')).toHaveLength(0);
    expect(node.querySelectorAll('nav button')).toHaveLength(3);
    expect([...node.querySelectorAll('kbd')].map(key => key.textContent)).toEqual(['Shift']);
  });

  it('keeps the primary action disabled while the current tab is unknown', async () => {
    const lookup = deferred<Tab[]>(); query.mockReturnValueOnce(lookup.promise);
    await mount();
    expect(primary().disabled).toBe(true);
    expect(primary().getAttribute('aria-busy')).toBe('true');
    expect(primary().textContent).toBe('Проверяем вкладку…');
    await click(); expectNoActivation();
    await act(async () => lookup.resolve([tab!]));
    expect(primary().disabled).toBe(false);
    expect(primary().getAttribute('aria-busy')).toBe('false');
  });

  it.each([
    'chrome://settings/', 'about:blank', 'file:///book.pdf',
    'chrome-extension://other/library.html', `${baseUrl}settings.html`,
    'https://chromewebstore.google.com/detail/extension', 'https://chrome.google.com/webstore/detail/extension',
  ])('offers the library instead of activation on %s', async url => {
    tab = { id: 12, url }; await mount();
    expect(primary().textContent).toBe('Открыть библиотеку');
    expect(node.querySelector('[role=status]')?.textContent).toContain('Здесь чтение недоступно');
    expect(node.querySelectorAll('nav button')).toHaveLength(2);
    expectNoActivation();
    await click();
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: `${baseUrl}library.html` });
    expect(close).toHaveBeenCalledTimes(1); expectNoActivation();
  });

  it.each([undefined, { url: 'https://example.com/' }])('handles missing active tab or tab ID without offering injection', async missing => {
    tab = missing; await mount();
    expect(primary().textContent).toBe('Открыть библиотеку'); expectNoActivation();
  });

  it('recognizes its library with a query and hash and does not offer redundant enable/open actions', async () => {
    tab = { id: 12, url: `${baseUrl}library.html?book=4#chapter` }; await mount();
    expect(node.querySelector('[role=status]')?.textContent).toContain('Библиотека уже открыта');
    expect(primary().textContent).toBe('Вернуться в библиотеку');
    expect(node.querySelectorAll('nav button')).toHaveLength(2);
    await click();
    expect(close).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled(); expectNoActivation();
  });

  it('uses labeled, native keyboard-focusable controls and decorative icons', async () => {
    await mount();
    expect(node.querySelector('main')?.getAttribute('aria-label')).toBe('Language Reader for Anki');
    expect(node.querySelector('nav')?.getAttribute('aria-label')).toBe('Разделы Language Reader');
    for (const control of node.querySelectorAll('button')) {
      expect(control.type).toBe('button'); expect(control.tabIndex).toBe(0);
      expect(control.textContent?.trim().length).toBeGreaterThan(0);
      control.focus(); expect(document.activeElement).toBe(control);
    }
    for (const icon of node.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
    }
    expect(node.querySelector('[role=status]')?.getAttribute('aria-atomic')).toBe('true');
  });

  it('preserves the full long page label and all footer controls in the DOM (not a layout assertion)', async () => {
    const hostname = `${'long-subdomain-'.repeat(4)}example.${'another-'.repeat(7)}example.com`;
    tab = { id: 12, url: `https://${hostname}/article` }; await mount();
    const label = node.querySelector('.action-page-label bdi')!;
    expect(label.textContent).toBe(hostname);
    expect(label.getAttribute('title')).toBe(hostname);
    expect(button('Настройки').disabled).toBe(false);
    expect(button('База слов').disabled).toBe(false);
    expect(node.querySelector('nav')?.textContent).toContain('База слов');
    expectNoActivation();
  });

  it('keeps a long read error intact in a keyboard-focusable region with retry and footer controls', async () => {
    const message = 'ПодробнаяОшибкаБезПробелов'.repeat(100);
    query.mockRejectedValueOnce(new Error(message));
    await mount();
    const description = node.querySelector<HTMLParagraphElement>('.action-readiness p')!;
    expect(description.textContent).toBe(message);
    expect(description.tabIndex).toBe(0);
    description.focus(); expect(document.activeElement).toBe(description);
    expect(primary().textContent).toBe('Повторить проверку');
    expect(button('Настройки').disabled).toBe(false);
    expect(button('База слов').disabled).toBe(false);
    expectNoActivation();
  });

  it('keeps a long action error intact in a keyboard-focusable feedback region', async () => {
    const message = 'ПодробнаяОшибкаБезПробелов'.repeat(100);
    create.mockRejectedValueOnce(new Error(message));
    await mount(); await click(button('Настройки'));
    const feedback = node.querySelector<HTMLParagraphElement>('.action-feedback')!;
    expect(feedback.textContent).toBe(message);
    expect(feedback.tabIndex).toBe(0);
    feedback.focus(); expect(document.activeElement).toBe(feedback);
    expect(button('Настройки').disabled).toBe(false);
    expect(button('База слов').disabled).toBe(false);
    expect(close).not.toHaveBeenCalled(); expectNoActivation();
  });
});

describe('explicit toolbar actions', () => {
  it('suppresses same-tick and pending repeat activation clicks, then returns to the page without reactivation', async () => {
    const response = deferred<{ ok: boolean }>(); sendMessage.mockReturnValueOnce(response.promise);
    await mount();
    await act(async () => { primary().click(); primary().click(); });
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ hostType: 'reader.activate', tabId: 12 });
    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe('Подключение…');
    expect(primary().getAttribute('aria-busy')).toBe('true');
    for (const control of node.querySelectorAll('nav button')) expect((control as HTMLButtonElement).disabled).toBe(true);
    await click(); expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => response.resolve({ ok: true }));
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe('Вернуться к странице');
    expect(node.querySelector('[role=status]')?.textContent).toContain('Чтение включено');
    await click(); expect(close).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports a valid zero tab ID', async () => {
    tab = { id: 0, url: 'https://example.com/' }; await mount(); await click();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ hostType: 'reader.activate', tabId: 0 });
  });

  it.each([
    ['Библиотека', 'library'], ['Настройки', 'settings'], ['База слов', 'queue'],
  ])('opens %s only after an explicit click and blocks duplicate new tabs', async (label, page) => {
    const opened = deferred<{ id: number }>(); create.mockReturnValueOnce(opened.promise);
    await mount(); expect(create).not.toHaveBeenCalled();
    await act(async () => { button(label).click(); button(label).click(); });
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: `${baseUrl}${page}.html` });
    expect(primary().disabled).toBe(true); expect(close).not.toHaveBeenCalled(); expectNoActivation();
    await act(async () => opened.resolve({ id: 21 }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a failed tab open, keeps the menu open and allows an explicit retry', async () => {
    create.mockRejectedValueOnce(new Error('Не удалось создать вкладку.'));
    await mount(); await click(button('Настройки'));
    expect(node.querySelector('[role=alert]')?.textContent).toBe('Не удалось создать вкладку.');
    expect(close).not.toHaveBeenCalled(); expect(button('Настройки').disabled).toBe(false);
    await click(button('Настройки'));
    expect(create).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(1);
    expect(node.querySelector('[role=alert]')).toBeNull(); expectNoActivation();
  });

  it.each([
    { ok: false, error: 'Chrome запретил чтение на этой странице.' },
    { ok: false }, null,
  ])('shows activation failures without claiming success and allows retry: %j', async response => {
    sendMessage.mockResolvedValueOnce(response);
    await mount(); await click();
    expect(node.querySelector('[role=alert]')?.textContent).toBe(response?.error ?? 'Не удалось включить чтение на этой странице.');
    expect(primary().textContent).toBe('Включить чтение'); expect(primary().disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    await click();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(primary().textContent).toBe('Вернуться к странице');
    expect(node.querySelector('[role=alert]')).toBeNull();
  });

  it('recovers after a rejected activation request without an automatic retry', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Соединение прервано.'));
    await mount(); await click();
    expect(node.querySelector('[role=alert]')?.textContent).toBe('Соединение прервано.');
    expect(sendMessage).toHaveBeenCalledTimes(1); expect(primary().disabled).toBe(false);
    await click(); expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('shows a failed read, retries only on request, and deduplicates same-tick retry clicks', async () => {
    query.mockRejectedValueOnce(new Error('Вкладка закрыта.'));
    await mount();
    expect(primary().textContent).toBe('Повторить проверку');
    expect(node.querySelector('[role=alert]')?.textContent).toContain('Вкладка закрыта.');
    expect(query).toHaveBeenCalledTimes(1); expectNoActivation();
    await act(async () => { primary().click(); primary().click(); });
    expect(query).toHaveBeenCalledTimes(2);
    expect(primary().textContent).toBe('Включить чтение');
    expect(node.querySelector('[role=alert]')).toBeNull(); expectNoActivation();
  });
});

describe('navigation, stale results and lifecycle', () => {
  it.each(['https://other.example/new', 'chrome://settings/', `${baseUrl}library.html`])('does not activate a different page discovered on click: %s', async url => {
    await mount(); tab = { id: 12, url }; await click();
    expectNoActivation();
    expect(node.querySelector('.action-feedback')?.textContent).toContain('Вкладка изменилась');
    expect(node.querySelector('.action-page-label')?.textContent).not.toBe('example.com');
  });

  it('requires a new click after a tab switch and binds activation to the newly displayed tab', async () => {
    await mount(); tab = { id: 13, url: 'https://other.example/' }; await click();
    expectNoActivation(); await click();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ hostType: 'reader.activate', tabId: 13 });
  });

  it('ignores a late initial tab read after a newer navigation update', async () => {
    const first = deferred<Tab[]>(); query.mockReturnValueOnce(first.promise);
    await mount(); tab = { id: 13, url: 'https://new.example/' };
    await act(async () => activated.fire());
    expect(node.querySelector('.action-page-label')?.textContent).toBe('new.example');
    await act(async () => first.resolve([{ id: 12, url: 'https://old.example/' }]));
    expect(node.querySelector('.action-page-label')?.textContent).toBe('new.example'); expectNoActivation();
  });

  it.each([{ ok: true }, { ok: false, error: 'Old page error' }])('ignores a stale activation response after navigation: %j', async result => {
    const response = deferred<unknown>(); sendMessage.mockReturnValueOnce(response.promise);
    await mount(); await click();
    tab = { id: 12, url: 'https://new.example/' };
    await act(async () => updated.fire(12, { url: tab!.url }));
    expect(node.querySelector('.action-page-label')?.textContent).toBe('new.example');
    await act(async () => response.resolve(result));
    expect(primary().textContent).toBe('Включить чтение');
    expect(node.querySelector('[role=alert]')).toBeNull();
    expect(node.querySelector('[role=status]')?.textContent).not.toContain('Чтение включено');
    await click(); expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rechecks after activation so a missing navigation event cannot produce a false success', async () => {
    const response = deferred<unknown>(); sendMessage.mockReturnValueOnce(response.promise);
    await mount(); await click();
    tab = { id: 12, url: 'https://new.example/' };
    await act(async () => response.resolve({ ok: true }));
    expect(primary().textContent).toBe('Включить чтение');
    expect(node.querySelector('.action-feedback')?.textContent).toContain('Вкладка изменилась');
    expect(node.querySelector('[role=status]')?.textContent).not.toContain('Чтение включено');
  });

  it('ignores unrelated tab changes, but clears success after reloading the same page', async () => {
    await mount(); await click();
    expect(primary().textContent).toBe('Вернуться к странице');
    const reads = query.mock.calls.length;
    await act(async () => updated.fire(99, { url: 'https://other.example/' }));
    expect(query).toHaveBeenCalledTimes(reads);
    await act(async () => updated.fire(12, { status: 'loading' }));
    expect(primary().textContent).toBe('Включить чтение');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('removes tab listeners on close and ignores late pending results', async () => {
    const response = deferred<unknown>(); sendMessage.mockReturnValueOnce(response.promise);
    await mount(); await click();
    await act(async () => root.unmount()); unmounted = true;
    expect(activated.listeners.size).toBe(0); expect(updated.listeners.size).toBe(0);
    expect(activated.removeListener).toHaveBeenCalledTimes(1); expect(updated.removeListener).toHaveBeenCalledTimes(1);
    const reads = query.mock.calls.length;
    await act(async () => response.resolve({ ok: true }));
    expect(query).toHaveBeenCalledTimes(reads); expect(close).not.toHaveBeenCalled();
  });

  it('does not close another page when a tab-open result arrives after unmount', async () => {
    const opened = deferred<unknown>(); create.mockReturnValueOnce(opened.promise);
    await mount(); await click(button('Библиотека'));
    await act(async () => root.unmount()); unmounted = true;
    await act(async () => opened.resolve({ id: 21 }));
    expect(close).not.toHaveBeenCalled(); expectNoActivation();
  });
});

it('shows the left Alt shortcut only after reading an enabled grammar preference', async () => {
  await act(async () => root.render(<ActionMenu readGrammarEnabled={async () => true} />));
  expect([...node.querySelectorAll('kbd')].map(key => key.textContent)).toEqual(['Shift', 'Alt']);
  expect(node.querySelector('.action-shortcuts')?.textContent).toContain('Разбор предложения и языковой чат по левому Alt');
  expect(node.querySelector('.action-shortcuts')?.textContent).toContain('платный запрос в OpenAI');
  expectNoActivation();
});
