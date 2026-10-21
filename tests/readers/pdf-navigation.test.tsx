import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadingProgress, StoredBook } from '../../apps/extension/src/readers/types';
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), dispose: vi.fn(), worker: vi.fn(), textRender: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mocks.getDocument,
  TextLayer: class {
    constructor({ container }: { container: HTMLElement }) { const span = document.createElement('span'); span.textContent = 'A readable PDF sentence.'; container.append(span); }
    render() { mocks.textRender(); return Promise.resolve(); }
    cancel() {}
  },
}));
vi.mock('../../apps/extension/src/readers/pdf-worker', () => ({ createLocalPdfWorker: mocks.worker, disposePdfLoading: mocks.dispose }));
import { PdfReader } from '../../apps/extension/src/readers/PdfReader';
import { readFileSync } from 'node:fs';
const pdfStyles = readFileSync('apps/extension/src/readers/pdf-reader.css', 'utf8');

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
const book = (id = 'pdf-one', page = 1, offset = 0): StoredBook => ({ documentId: id, title: id + '.pdf', kind: 'pdf', size: 12,
  addedAt: 1, blob: { arrayBuffer: async () => new ArrayBuffer(12) } as Blob, progress: { page, offset, updatedAt: 1 } });
let node: HTMLDivElement, root: ReturnType<typeof createRoot>, pdf: PDFDocumentProxy, getPage: ReturnType<typeof vi.fn>;
let scrollY: number, progress: ReturnType<typeof vi.fn<(value: ReadingProgress) => void>>, width: number;
let intersections: Map<Element, IntersectionObserverCallback>, resized: ResizeObserverCallback[];
let frames: Map<number, FrameRequestCallback>, nextFrame: number;
function fakePage(number: number) {
  return { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(async () => ({ items: [{ str: `Page ${number}` }] })) };
}
const button = (name: string) => node.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const next = () => button('Следующая страница PDF');
const prev = () => button('Предыдущая страница PDF');
const counter = () => node.querySelector('.er-pdf-counter')!.textContent;
const reader = () => node.querySelector<HTMLElement>('.er-pdf-reader')!;
const input = () => node.querySelector<HTMLInputElement>('input[aria-label="Номер страницы PDF"]')!;
const pages = () => [...node.querySelectorAll<HTMLElement>('[data-page]')];
async function visible(number: number, value = true) {
  const element = pages()[number - 1]!;
  await act(async () => intersections.get(element)!([{ isIntersecting: value, target: element } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
}
async function render(value = book(), onDocumentReady?: React.ComponentProps<typeof PdfReader>['onDocumentReady']) {
  await act(async () => root.render(<PdfReader book={value} onProgress={progress} onDocumentReady={onDocumentReady} />));
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function jump(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function key(value: string, options: KeyboardEventInit = {}, target: HTMLElement = reader()) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function scrollToPage(number: number, offset = 0) {
  const element = pages()[number - 1]!;
  scrollY += element.getBoundingClientRect().top - 92 + offset * element.getBoundingClientRect().height;
  await act(async () => { window.dispatchEvent(new Event('scroll')); const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); scrollY = 0; width = 600; progress = vi.fn(); intersections = new Map(); resized = []; frames = new Map(); nextFrame = 0;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { intersections.set(element, this.callback); }
    disconnect() { for (const [element, callback] of intersections) if (callback === this.callback) intersections.delete(element); }
  });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resized.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('er-pdf-reader') ? width : 0; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.classList.contains('er-pdf-toolbar')) return new DOMRect(0, 0, 600, 80);
    if (this.dataset.page) {
      const elements = [...this.parentElement!.querySelectorAll<HTMLElement>('[data-page]')];
      const before = elements.slice(0, elements.indexOf(this)).reduce((sum, item) => sum + parseFloat(item.style.minHeight) + 16, 0);
      return new DOMRect(0, 300 + before - scrollY, parseFloat(this.style.width), parseFloat(this.style.minHeight));
    }
    return new DOMRect(0, 0, 600, 800);
  });
  vi.spyOn(window, 'scrollBy').mockImplementation(((x: number | ScrollToOptions, y?: number) => { scrollY += typeof x === 'number' ? y || 0 : x.top || 0; }) as typeof window.scrollBy);
  getPage = vi.fn(async (number: number) => fakePage(number));
  pdf = { numPages: 4, getPage } as unknown as PDFDocumentProxy;
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
  mocks.worker.mockReturnValue({ worker: {}, port: { addEventListener: vi.fn() }, destroy: vi.fn() });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); document.getSelection()?.removeAllRanges();
  document.querySelectorAll('[data-english-reader-popup],style[data-pdf-test]').forEach(element => element.remove());
  vi.unstubAllGlobals();
});

describe('PDF continuous-page navigation', () => {
  it('keeps a sticky compact toolbar and true page boundaries, without loading every page', async () => {
    const style = document.createElement('style'); style.dataset.pdfTest = ''; style.textContent = pdfStyles; document.head.append(style);
    await render();
    expect(getComputedStyle(node.querySelector('.er-pdf-toolbar')!).position).toBe('sticky');
    expect(getComputedStyle(node.querySelector('.er-pdf-toolbar')!).top).toBe('0px');
    expect(counter()).toBe('Страница 1 из 4'); expect(prev().disabled).toBe(true); expect(next().disabled).toBe(false);
    expect(pages()).toHaveLength(4); expect(getPage).not.toHaveBeenCalled();
    await visible(1); await click(next()); expect(counter()).toBe('Страница 2 из 4');
    await jump('4'); expect(counter()).toBe('Страница 4 из 4'); expect(next().disabled).toBe(true);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: 0 });
    await click(prev()); expect(counter()).toBe('Страница 3 из 4');
  });

  it.each(['', '0', '5', '-1', '1.5', '2e0', 'hello'])('rejects invalid jump %j without scrolling', async value => {
    await render(); await visible(1); const calls = vi.mocked(window.scrollBy).mock.calls.length;
    await jump(value);
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Введите целую страницу от 1 до 4.');
    expect(input().getAttribute('aria-invalid')).toBe('true'); expect(document.activeElement).toBe(input());
    expect(counter()).toBe('Страница 1 из 4'); expect(window.scrollBy).toHaveBeenCalledTimes(calls);
    await jump(' 3 '); expect(counter()).toBe('Страница 3 из 4'); expect(node.querySelector('[role="alert"]')).toBeNull();
  });

  it('tracks manual scrolling, persists page offsets, and does not rerender text layers on scroll', async () => {
    await render(); await visible(1); await visible(2);
    window.dispatchEvent(new Event('wheel'));
    await scrollToPage(2, .3);
    expect(counter()).toBe('Страница 2 из 4'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 2, offset: .3 });
    const requests = getPage.mock.calls.length, layers = mocks.textRender.mock.calls.length;
    await scrollToPage(2, .4); await scrollToPage(2, .4); await render();
    expect(getPage).toHaveBeenCalledTimes(requests); expect(mocks.textRender).toHaveBeenCalledTimes(layers);
    expect(node.querySelector('[data-page="2"] .textLayer span')?.textContent).toBe('A readable PDF sentence.');
  });

  it('restores the saved page and within-page position only after the target is ready', async () => {
    await render(book('restore', 3, .45)); expect(counter()).toBe('Страница 3 из 4'); expect(progress).not.toHaveBeenCalled();
    await visible(2); expect(progress).not.toHaveBeenCalled();
    await visible(3);
    expect(pages()[2]!.getBoundingClientRect().top).toBeCloseTo(92 - 800 * .45);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 3, offset: .45 });
  });

  it('waits for a newly visited page rather than mistaking an empty canvas for rendered content', async () => {
    await render(); await visible(1); await jump('3');
    const calls = vi.mocked(window.scrollBy).mock.calls.length;
    await visible(3); expect(window.scrollBy).toHaveBeenCalledTimes(calls + 1);
    const requests = getPage.mock.calls.length;
    await jump('3'); expect(getPage).toHaveBeenCalledTimes(requests);
    await scrollToPage(3, .25); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 3, offset: .25 });
  });

  it('does not let a late restore completion override a newer jump', async () => {
    const slow = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementation(async n => n === 2 ? slow.promise : fakePage(n));
    await render(book('race', 2, .5)); await visible(2); await jump('4'); await visible(4);
    const calls = vi.mocked(window.scrollBy).mock.calls.length;
    await act(async () => slow.resolve(fakePage(2)));
    expect(counter()).toBe('Страница 4 из 4'); expect(window.scrollBy).toHaveBeenCalledTimes(calls);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: 0 });
  });

  it('lets manual scrolling cancel an in-flight restore', async () => {
    const slow = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementation(async n => n === 3 ? slow.promise : fakePage(n));
    await render(book('manual', 3, .5)); await visible(3); window.dispatchEvent(new Event('wheel')); await scrollToPage(1, .2);
    const calls = vi.mocked(window.scrollBy).mock.calls.length;
    await act(async () => slow.resolve(fakePage(3)));
    expect(counter()).toBe('Страница 1 из 4'); expect(window.scrollBy).toHaveBeenCalledTimes(calls);
  });

  it('changes scale for both canvas and exact-selection text layer, retaining position', async () => {
    await render(); await visible(1); window.dispatchEvent(new Event('wheel')); await scrollToPage(1, .25);
    await act(async () => { const select = node.querySelector('select')!; select.value = '1.25'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    const page = pages()[0]!, layer = page.querySelector<HTMLElement>('.textLayer')!;
    expect(page.style.width).toBe('750px'); expect(layer.style.width).toBe('750px'); expect(layer.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    expect(page.querySelector('canvas')!.width).toBe(750); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 1, offset: .25 });
    const calls = getPage.mock.calls.length;
    await act(async () => { width = 400; resized.forEach(callback => callback([], {} as ResizeObserver)); });
    expect(getPage).toHaveBeenCalledTimes(calls);
  });

  it('fits pages to available width and keeps the current offset across resize', async () => {
    await render(); await visible(1); window.dispatchEvent(new Event('wheel')); await scrollToPage(1, .4);
    await act(async () => { width = 300; resized.forEach(callback => callback([], {} as ResizeObserver)); });
    expect(pages()[0]!.style.width).toBe('300px'); expect(pages()[0]!.querySelector('canvas')!.width).toBe(300);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 1, offset: .4 });
  });

  it('scopes keyboard paging to focused reader content and suppresses modified, repeated, IME, selection and popup keys', async () => {
    await render(); await visible(1);
    expect((await key('PageDown')).defaultPrevented).toBe(false); expect(counter()).toBe('Страница 1 из 4');
    reader().focus(); expect((await key('PageDown')).defaultPrevented).toBe(true); expect(counter()).toBe('Страница 2 из 4');
    await key('Home'); expect(counter()).toBe('Страница 1 из 4');
    for (const options of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect((await key('ArrowRight', options)).defaultPrevented).toBe(false);
    }
    expect(counter()).toBe('Страница 1 из 4');
    input().focus(); expect((await key('PageDown', {}, input())).defaultPrevented).toBe(false);
    reader().focus(); const range = document.createRange(); range.selectNodeContents(node.querySelector('.textLayer span')!); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    expect((await key('PageDown')).defaultPrevented).toBe(false); document.getSelection()!.removeAllRanges();
    const popup = document.createElement('div'); popup.dataset.englishReaderPopup = ''; document.body.append(popup);
    expect((await key('PageDown')).defaultPrevented).toBe(false); popup.remove();
    await key('End'); expect(counter()).toBe('Страница 4 из 4'); await key('ArrowLeft'); expect(counter()).toBe('Страница 3 из 4');
  });

  it('resets navigation when switching documents and ignores a cancelled old load', async () => {
    const first = deferred<PDFDocumentProxy>(); mocks.getDocument.mockReturnValueOnce({ promise: first.promise, destroy: vi.fn() });
    await render(book('old', 4)); expect(node.textContent).toContain('Загрузка PDF');
    await render(book('new', 1)); expect(counter()).toBe('Страница 1 из 4');
    await act(async () => first.resolve({ ...pdf, numPages: 99 } as unknown as PDFDocumentProxy));
    expect(counter()).toBe('Страница 1 из 4'); expect(mocks.dispose).toHaveBeenCalled();
  });

  it('clamps stale saved page positions and gives a recoverable page-level error', async () => {
    getPage.mockRejectedValue(new Error('Page damaged'));
    await render(book('clamp', 99, 3)); expect(counter()).toBe('Страница 4 из 4'); await visible(4);
    expect(node.querySelector('[role="alert"]')?.textContent).toBe('Страница 4: Page damaged'); expect(prev().disabled).toBe(false);
    await click(prev()); expect(counter()).toBe('Страница 3 из 4');
  });

  it('shows document loading errors without an active toolbar', async () => {
    mocks.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('Invalid PDF')), destroy: vi.fn() });
    await render(); expect(node.querySelector('[role="alert"]')?.textContent).toContain('Invalid PDF');
    expect(node.querySelector('.er-pdf-toolbar')).toBeNull(); expect(mocks.dispose).toHaveBeenCalled();
  });

  it('uses the selected PDF page for source metadata and cleans the document hook on close', async () => {
    const cleanup = vi.fn(), ready = vi.fn(() => cleanup); await render(book(), ready); await visible(1); await visible(3);
    const hovered = node.querySelector('[data-page="3"] .textLayer span')!;
    hovered.dispatchEvent(new Event('pointermove', { bubbles: true }));
    const hoverSource = (ready.mock.calls[0] as unknown as [Document, () => { page: number }])[1];
    expect(counter()).toBe('Страница 1 из 4'); expect(hoverSource().page).toBe(3);
    const span = node.querySelector('[data-page="1"] .textLayer span')!, range = document.createRange(); range.selectNodeContents(span); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    const getSource = (ready.mock.calls[0] as unknown as [Document, () => { page: number }])[1];
    expect(getSource().page).toBe(1); await act(async () => root.render(null)); expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
