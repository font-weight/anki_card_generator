import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReaderBookmark, StoredBook } from '../../apps/extension/src/readers/types';
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), dispose: vi.fn(), worker: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mocks.getDocument,
  TextLayer: class {
    constructor({ container }: { container: HTMLElement }) { const span = document.createElement('span'); span.textContent = 'Exact original PDF source.'; container.append(span); }
    render() { return Promise.resolve(); }
    cancel() {}
  },
}));
vi.mock('../../apps/extension/src/readers/pdf-worker', () => ({ createLocalPdfWorker: mocks.worker, disposePdfLoading: mocks.dispose }));
import { readFileSync } from 'node:fs';
import { PdfReader } from '../../apps/extension/src/readers/PdfReader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve };
}
const book = (id = 'tools', page = 1, offset = 0): StoredBook => ({ documentId: id, title: id + '.pdf', kind: 'pdf', size: 12,
  addedAt: 1, blob: { arrayBuffer: async () => new ArrayBuffer(12) } as Blob, progress: { page, offset, updatedAt: 1 } });
function fakePage(text = 'Needle on this page.') {
  let read = false;
  const reader = { read: vi.fn(async () => read ? { done: true, value: undefined } : (read = true, { done: false, value: { items: [{ str: text }] } })), cancel: vi.fn(async () => {}), releaseLock: vi.fn() };
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(async () => ({ items: [{ str: text }] })),
    streamTextContent: vi.fn(() => ({ getReader: () => reader })), reader,
  };
}
let node: HTMLDivElement, root: ReturnType<typeof createRoot>, pdf: PDFDocumentProxy, getPage: ReturnType<typeof vi.fn>;
let intersections: Map<Element, IntersectionObserverCallback>;
const progress = vi.fn();
const reader = () => node.querySelector<HTMLElement>('.er-pdf-reader')!;
const searchInput = () => node.querySelector<HTMLInputElement>('[aria-label="Поиск в PDF"]')!;
const searchStatus = () => node.querySelector('.er-pdf-search-status')?.textContent;
const counter = () => node.querySelector('.er-pdf-counter')!.textContent;
const findButton = (text: string) => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
async function render(value = book(), props: Partial<React.ComponentProps<typeof PdfReader>> = {}) {
  await act(async () => root.render(<PdfReader book={value} onProgress={progress} {...props} />));
}
async function settle() { await act(async () => { await vi.runAllTimersAsync(); }); }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function search(query: string) {
  await act(async () => { node.querySelector<HTMLDetailsElement>('.er-pdf-search-panel')!.open = true; });
  await input(searchInput(), query);
  await act(async () => node.querySelector('.er-pdf-search-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function visible(number: number) {
  const element = node.querySelector(`[data-page="${number}"]`)!;
  await act(async () => intersections.get(element)!([{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.clearAllMocks(); intersections = new Map();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { intersections.set(element, this.callback); }
    disconnect() { for (const [element, callback] of intersections) if (callback === this.callback) intersections.delete(element); }
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains('er-pdf-toolbar')) return new DOMRect(0, 0, 600, 80);
    if (this.dataset.page) return new DOMRect(0, 300 + (Number(this.dataset.page) - 1) * 816, 600, 800);
    return new DOMRect(0, 0, 600, 800);
  });
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
  getPage = vi.fn(async (number: number) => fakePage(number === 2 ? 'A needle in the second page.' : 'Different text.'));
  pdf = { numPages: 3, getPage } as unknown as PDFDocumentProxy;
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
  mocks.worker.mockReturnValue({ worker: {}, port: { addEventListener: vi.fn() }, destroy: vi.fn() });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); document.getSelection()?.removeAllRanges();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('PDF bookmarks and saved appearance', () => {
  it('adds a labeled current page and offset, rejects duplicate clicks, jumps and deletes explicitly', async () => {
    await render(book('bookmark', 2, .45));
    await input(node.querySelector<HTMLInputElement>('[aria-label="Название закладки PDF"]')!, 'My useful passage');
    await click(findButton('Добавить текущее место'));
    expect(node.querySelector('.er-pdf-bookmarks')?.textContent).toContain('My useful passage');
    await click(findButton('Добавить текущее место'));
    expect(node.querySelectorAll('.er-pdf-bookmarks li')).toHaveLength(1);
    expect(node.textContent).toContain('Это место уже есть в закладках.');
    await click(node.querySelector<HTMLButtonElement>('[aria-label="Следующая страница PDF"]')!);
    expect(counter()).toBe('Страница 3 из 3');
    await click(node.querySelector<HTMLButtonElement>('.er-pdf-bookmark-link')!);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 2, offset: .45 });
    expect(node.textContent).toContain('Только в этой сессии');
    await click(node.querySelector<HTMLButtonElement>('[aria-label="Удалить закладку «My useful passage»"]')!);
    expect(node.querySelectorAll('.er-pdf-bookmarks li')).toHaveLength(0);
  });

  it('reserves measured tail room so clamped scrolling still reaches a short final page and bookmark offset', async () => {
    let scrollY = 0;
    const viewport = 1000, pageHeight = 450, gap = 16;
    pdf = { numPages: 4, getPage } as unknown as PDFDocumentProxy;
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
    getPage.mockImplementation(async () => ({ ...fakePage(), getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: pageHeight * scale }) }));
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function(this: HTMLElement) {
      if (this.classList.contains('er-pdf-toolbar')) return new DOMRect(0, 0, 600, 80);
      if (this.dataset.page) return new DOMRect(0, 300 + (Number(this.dataset.page) - 1) * (pageHeight + gap) - scrollY, 600, pageHeight);
      return new DOMRect(0, 0, 600, viewport);
    });
    const styles = readFileSync('apps/extension/src/readers/pdf-reader.css', 'utf8');
    expect(styles).toContain('padding-bottom:max(1rem,calc(100vh - var(--er-pdf-reading-top,0px)))');
    vi.mocked(window.scrollBy).mockImplementation(((options: ScrollToOptions) => {
      // Browser clamp model: content ends after the final short page plus CSS tail space.
      const tail = viewport - (parseFloat(reader().style.getPropertyValue('--er-pdf-reading-top')) || 0);
      const maximum = 300 + 4 * (pageHeight + gap) + tail - viewport;
      scrollY = Math.min(maximum, Math.max(0, scrollY + (options.top || 0)));
    }) as typeof window.scrollBy);
    await render(); await visible(4);
    expect(reader().style.getPropertyValue('--er-pdf-reading-top')).toBe('92px');
    const jump = node.querySelector<HTMLInputElement>('[aria-label="Номер страницы PDF"]')!;
    await input(jump, '4');
    await act(async () => node.querySelector('.er-pdf-jump')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => { window.dispatchEvent(new Event('scroll')); await vi.runAllTimersAsync(); });
    expect(counter()).toBe('Страница 4 из 4'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: 0 });
    await render(book(), { bookmarks: [{ id: 'end', kind: 'pdf', page: 4, offset: .9, label: 'End', createdAt: 1 }] });
    await click(node.querySelector<HTMLButtonElement>('.er-pdf-bookmark-link')!);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: .9 });
    expect(node.querySelector<HTMLElement>('[data-page="4"]')!.getBoundingClientRect().top).toBeCloseTo(92 - .9 * pageHeight);
    await act(async () => { window.dispatchEvent(new Event('scroll')); await vi.runAllTimersAsync(); });
    expect(counter()).toBe('Страница 4 из 4'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: .9 });
  });

  it('restores saved zoom without writing it and emits only deliberate appearance changes', async () => {
    const changed = vi.fn(); await render(book(), { appearance: { kind: 'pdf', zoom: '1.25' }, onAppearanceChange: changed, persistenceMode: 'persistent' });
    expect(node.querySelector('select')!.value).toBe('1.25'); expect(changed).not.toHaveBeenCalled();
    await visible(1); expect(node.querySelector('canvas')!.width).toBe(750);
    await act(async () => { const select = node.querySelector('select')!; select.value = 'fit'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ kind: 'pdf', zoom: 'fit' });
    expect(node.querySelector('canvas')!.width).toBe(600);
    await render(book('other')); expect(node.querySelector('select')!.value).toBe('fit');
  });

  it('honors controlled bookmark callbacks, has a visible limit, and resets fallback state for a new document', async () => {
    const saved: ReaderBookmark[] = Array.from({ length: 200 }, (_, index) => ({ id: `b${index}`, kind: 'pdf', page: 2, offset: index / 200, label: `Bookmark ${index}`, createdAt: 1 }));
    const changed = vi.fn(); await render(book(), { bookmarks: saved, onBookmarksChange: changed });
    await click(findButton('Добавить текущее место'));
    expect(node.textContent).toContain('не больше 200 закладок'); expect(changed).not.toHaveBeenCalled();
    await click(node.querySelector<HTMLButtonElement>('[aria-label="Удалить закладку «Bookmark 0»"]')!);
    expect(changed.mock.lastCall?.[0]).toHaveLength(199);
    await render(book('other')); expect(node.querySelectorAll('.er-pdf-bookmarks li')).toHaveLength(0);
  });
});

describe('bounded local PDF search', () => {
  it('does not index on open or typing; explicit search shows snippets and jumps to the actual result page without mutating source text', async () => {
    const ready = vi.fn(); await render(book(), { onDocumentReady: ready });
    expect(getPage).not.toHaveBeenCalled();
    await input(searchInput(), 'needle'); await settle(); expect(getPage).not.toHaveBeenCalled();
    await visible(2); const span = node.querySelector('[data-page="2"] .textLayer span')!;
    const before = span.textContent;
    await search('needle'); await settle();
    expect(searchStatus()).toContain('Совпадений: 1'); expect(searchStatus()).toContain('Проверено страниц: 3 из 3');
    expect(node.querySelector('.er-pdf-search-results')?.textContent).toContain('A needle in the second page.');
    await click(node.querySelector<HTMLButtonElement>('.er-pdf-search-results button')!);
    expect(counter()).toBe('Страница 2 из 3'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 2, offset: 0 });
    expect(span.textContent).toBe(before); expect(node.querySelector('.textLayer mark')).toBeNull();
    const range = document.createRange(); range.selectNodeContents(span); document.getSelection()!.addRange(range);
    const source = (ready.mock.calls[0] as unknown as [Document, () => { page: number }])[1]; expect(source().page).toBe(2);
  });

  it('ignores navigation hotkeys while editing a search query and validates short queries', async () => {
    await render(); searchInput().focus();
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })));
    expect(counter()).toBe('Страница 1 из 3');
    const summary = node.querySelector<HTMLElement>('.er-pdf-search-panel summary')!; summary.focus();
    await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })));
    expect(counter()).toBe('Страница 1 из 3');
    await search(' '); expect(node.textContent).toContain('Введите минимум 2 знака.'); expect(getPage).not.toHaveBeenCalled();
  });

  it('uses original-text offsets for Unicode snippets and treats regex syntax literally', async () => {
    getPage.mockImplementation(async () => fakePage('İ'.repeat(1000) + 'needle [a+b] end'));
    await render(); await search('needle'); await settle();
    expect(node.querySelector('.er-pdf-search-results')?.textContent).toContain('needle');
    await search('[a+b]'); await settle();
    expect(searchStatus()).toContain('Совпадений: 3'); expect(node.querySelector('.er-pdf-search-results')?.textContent).toContain('[a+b]');
  });

  it('caps results honestly and never proceeds to another page after the cap', async () => {
    getPage.mockImplementation(async () => fakePage('needle '.repeat(220)));
    await render(); await search('needle'); await settle();
    expect(node.querySelectorAll('.er-pdf-search-results li')).toHaveLength(200);
    expect(searchStatus()).toContain('Совпадений: 200 (лимит)'); expect(searchStatus()).toContain('первые 200 совпадений');
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest queued query and bounds unresolved repeated search work to one page request', async () => {
    const pending = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementationOnce(() => pending.promise);
    await render(); await search('first'); await search('second'); await search('needle');
    expect(getPage).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(fakePage('first second old result'))); await settle();
    expect(searchStatus()).toContain('«needle»'); expect(searchStatus()).toContain('Совпадений: 1');
    expect(node.querySelector('.er-pdf-search-results')?.textContent).not.toContain('old result');
    expect(getPage).toHaveBeenCalledTimes(4);
  });

  it('cancels an in-flight text stream, discards late results and allows a fresh retry', async () => {
    const slow = fakePage(), read = deferred<{ done: boolean; value?: { items: { str: string }[] } }>();
    slow.reader.read.mockImplementationOnce(() => read.promise as ReturnType<typeof slow.reader.read>);
    slow.reader.cancel.mockImplementation(async () => { read.resolve({ done: true }); });
    getPage.mockImplementationOnce(async () => slow);
    await render(); await search('needle');
    await click(findButton('Остановить поиск')); await settle();
    expect(slow.reader.cancel).toHaveBeenCalled(); expect(slow.reader.releaseLock).toHaveBeenCalled();
    expect(searchStatus()).toContain('Поиск остановлен.'); expect(node.querySelectorAll('.er-pdf-search-results li')).toHaveLength(0);
    await search('needle'); await settle(); expect(searchStatus()).toContain('Совпадений: 1');
  });

  it('closing the search panel cancels work, and a new book is not updated by an old request', async () => {
    const pending = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementationOnce(() => pending.promise);
    await render(); await search('needle');
    await act(async () => { const panel = node.querySelector<HTMLDetailsElement>('.er-pdf-search-panel')!; panel.open = false; panel.dispatchEvent(new Event('toggle')); });
    expect(searchStatus()).toContain('Поиск остановлен.');
    await render(book('new')); await act(async () => pending.resolve(fakePage('needle from old book'))); await settle();
    expect(searchStatus()).toBeUndefined(); expect(node.querySelectorAll('.er-pdf-search-results li')).toHaveLength(0);
    expect(counter()).toBe('Страница 1 из 3');
  });

  it('bounds a hung page request and blocks retries rather than accumulating unresolved PDF work', async () => {
    const pending = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementationOnce(() => pending.promise);
    await render(); await search('first'); await click(findButton('Остановить поиск')); await search('needle');
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(node.textContent).toContain('PDF не отвечает на поиск. Закройте книгу');
    expect(findButton('Найти').disabled).toBe(true); expect(getPage).toHaveBeenCalledTimes(1);
    await search('again'); expect(getPage).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(fakePage('late needle'))); await settle();
    expect(node.querySelectorAll('.er-pdf-search-results li')).toHaveLength(0);
  });

  it('bounds a non-cooperative stream read even if its cancellation never settles', async () => {
    const slow = fakePage(), pending = deferred<Awaited<ReturnType<typeof slow.reader.read>>>();
    slow.reader.read.mockImplementationOnce(() => pending.promise);
    slow.reader.cancel.mockImplementation(() => new Promise(() => {}));
    getPage.mockImplementationOnce(async () => slow);
    await render(); await search('needle'); await click(findButton('Остановить поиск'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(node.textContent).toContain('PDF не отвечает на поиск.'); expect(slow.reader.releaseLock).toHaveBeenCalled();
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it('reports unreadable and scanned-only pages honestly and continues past a bad page', async () => {
    getPage.mockImplementation(async number => { if (number === 1) throw new Error('damaged'); return fakePage(number === 2 ? '' : 'needle'); });
    await render(); await search('needle'); await settle();
    expect(searchStatus()).toContain('Не удалось прочитать 1 стр.'); expect(searchStatus()).toContain('Без извлекаемого текста: 1 стр.');
    expect(searchStatus()).toContain('OCR не поддерживается'); expect(searchStatus()).toContain('Совпадений: 1');
    await click(node.querySelector<HTMLButtonElement>('.er-pdf-search-results button')!); expect(counter()).toBe('Страница 3 из 3');
  });

  it('stops at the total text budget without retaining or scanning the rest of a large book', async () => {
    pdf = { numPages: 50, getPage } as unknown as PDFDocumentProxy;
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
    getPage.mockImplementation(async () => fakePage('x'.repeat(250_000)));
    await render(); await search('missing'); await settle();
    expect(getPage).toHaveBeenCalledTimes(40);
    expect(searchStatus()).toContain('Достигнут лимит 10 млн знаков.');
    expect(searchStatus()).toContain('Проверено страниц: 40 из 50');
    expect(node.querySelectorAll('.er-pdf-search-results li')).toHaveLength(0);
  });

  it('bounds huge page text, cancels the stream and labels its incomplete coverage', async () => {
    const huge = fakePage('x'.repeat(250_100) + 'needle'); getPage.mockImplementation(async number => number === 1 ? huge : fakePage('normal'));
    await render(); await search('needle'); await settle();
    expect(searchStatus()).toContain('проверена только часть текста'); expect(searchStatus()).toContain('Совпадений: 0');
    expect(huge.reader.cancel).toHaveBeenCalled(); expect(huge.reader.releaseLock).toHaveBeenCalled();
  });
});
