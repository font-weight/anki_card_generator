import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReaderBookmark, StoredBook } from '../../apps/extension/src/readers/types';
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), dispose: vi.fn(), worker: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mocks.getDocument,
  TextLayer: class {
    textDivs: HTMLElement[];
    constructor({ container, textContentSource }: { container: HTMLElement; textContentSource: { items: { str: string }[] } }) {
      this.textDivs = textContentSource.items.map(({str}) => {
        const span = document.createElement('span');
        span.textContent = str;
        if (str) container.append(span);
        return span;
      });
    }
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
function fakePage(text: string | string[] = 'Needle on this page.') {
  const items = (Array.isArray(text) ? text : [text]).map(str => ({ str }));
  let read = false;
  const reader = { read: vi.fn(async () => read ? { done: true, value: undefined } : (read = true, { done: false, value: { items } })), cancel: vi.fn(async () => {}), releaseLock: vi.fn() };
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    getTextContent: vi.fn(async () => ({ items })),
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
const findButton = (text: string) => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text || button.getAttribute('aria-label') === text)!;
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
async function openPanel(name:string) {
  const trigger=node.querySelector<HTMLButtonElement>('.rc-rail-'+name)!;
  if(trigger.getAttribute('aria-expanded')!=='true')await click(trigger);
}
async function bookmarksPanel(){await openPanel('bookmarks');}
async function search(query: string) {
  await openPanel('search');
  await input(searchInput(), query);
  await act(async () => node.querySelector('.rc-search form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
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
    if (this.classList.contains('er-pdf-reader')) return new DOMRect(0,80,600,800);
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
    await openPanel('chapters');
    expect(node.querySelector('.er-pdf-bookmarks')).toBeNull();
    await bookmarksPanel();expect(node.querySelector('.rc-panel')?.textContent).toContain('Пока нет закладок.');
    await bookmarksPanel();await input(node.querySelector<HTMLInputElement>('[aria-label="Название закладки PDF"]')!, 'My useful passage');
    await bookmarksPanel(); await click(findButton('Добавить текущее место'));
    expect(node.querySelector('.er-pdf-bookmarks')?.textContent).toContain('My useful passage');
    await bookmarksPanel(); await click(findButton('Добавить текущее место'));
    expect(node.querySelectorAll('.er-pdf-bookmarks li')).toHaveLength(1);
    expect(node.textContent).toContain('Это место уже есть в закладках.');
    await click(node.querySelector<HTMLButtonElement>('[aria-label="Следующий экран"]')!);
    expect(counter()).toBe('Страница 3 из 3');
    await bookmarksPanel();await click(node.querySelector<HTMLButtonElement>('.er-pdf-bookmark-link')!);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 2, offset: .45 });
    await openPanel('appearance');expect(node.textContent).toContain('Только в этой сессии');await bookmarksPanel();
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
      if (this.classList.contains('er-pdf-reader')) return new DOMRect(0,80,600,800);
      if (this.dataset.page) return new DOMRect(0, 300 + (Number(this.dataset.page) - 1) * (pageHeight + gap) - scrollY, 600, pageHeight);
      return new DOMRect(0, 0, 600, viewport);
    });
    const styles = readFileSync('apps/extension/src/readers/pdf-reader.css', 'utf8');
    expect(styles).toContain('calc(100cqh - 12px)');
    vi.spyOn(Element.prototype,'scrollTop','get').mockImplementation(()=>scrollY);
    vi.spyOn(Element.prototype,'scrollTop','set').mockImplementation((value:number)=>{
      const maximum=300 + 4*(pageHeight+gap) + viewport-12 - viewport;
      scrollY=Math.min(maximum,Math.max(0,value));
    });
    await render(); await visible(4);
    await click(node.querySelector<HTMLButtonElement>('.er-pdf-counter')!);
    const jump = node.querySelector<HTMLInputElement>('[aria-label="Номер страницы PDF"]')!;
    await input(jump, '4');
    await act(async () => node.querySelector('.er-pdf-jump')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => { reader().dispatchEvent(new Event('scroll')); await vi.runAllTimersAsync(); });
    expect(counter()).toBe('Страница 4 из 4'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: 0 });
    await render(book(), { bookmarks: [{ id: 'end', kind: 'pdf', page: 4, offset: .9, label: 'End', createdAt: 1 }] });
    await bookmarksPanel();await click(node.querySelector<HTMLButtonElement>('.er-pdf-bookmark-link')!);
    expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: .9 });
    expect(node.querySelector<HTMLElement>('[data-page="4"]')!.getBoundingClientRect().top).toBeCloseTo(92 - .9 * pageHeight);
    await act(async () => { reader().dispatchEvent(new Event('scroll')); await vi.runAllTimersAsync(); });
    expect(counter()).toBe('Страница 4 из 4'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 4, offset: .9 });
  });

  it('restores saved zoom without writing it and emits only deliberate appearance changes', async () => {
    const changed = vi.fn(); await render(book(), { appearance: { kind: 'pdf', zoom: '1.25' }, onAppearanceChange: changed, persistenceMode: 'persistent' });
    await openPanel('appearance'); expect(node.querySelector('select')!.value).toBe('1.25'); expect(changed).not.toHaveBeenCalled();
    await visible(1); expect(node.querySelector('canvas')!.width).toBe(750);
    await act(async () => { const select = node.querySelector('select')!; select.value = 'fit'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ kind: 'pdf', zoom: 'fit' });
    expect(node.querySelector('canvas')!.width).toBe(576);
    await render(book('other')); await openPanel('appearance');expect(node.querySelector('select')!.value).toBe('fit');
  });

  it('honors controlled bookmark callbacks, has a visible limit, and resets fallback state for a new document', async () => {
    const saved: ReaderBookmark[] = Array.from({ length: 200 }, (_, index) => ({ id: `b${index}`, kind: 'pdf', page: 2, offset: index / 200, label: `Bookmark ${index}`, createdAt: 1 }));
    const changed = vi.fn(); await render(book(), { bookmarks: saved, onBookmarksChange: changed });
    await bookmarksPanel(); await click(findButton('Добавить текущее место'));
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
    await openPanel('search');await input(searchInput(), 'needle'); await settle(); expect(getPage).not.toHaveBeenCalled();
    await visible(2); const span = node.querySelector('[data-page="2"] .textLayer span')!;
    const before = span.textContent;
    await search('needle'); await settle();
    expect(searchStatus()).toContain('Совпадений: 1'); expect(searchStatus()).toContain('Проверено страниц: 3 из 3');
    expect(node.querySelector('.rc-results')?.textContent).toContain('A needle in the second page.');
    await click(node.querySelector<HTMLButtonElement>('.rc-results button')!);
    expect(counter()).toBe('Страница 2 из 3'); expect(progress.mock.lastCall?.[0]).toMatchObject({ page: 2, offset: 0 });
    expect(span.textContent).toBe(before); expect(node.querySelector('.textLayer mark')).toBeNull();
    const range = document.createRange(); range.selectNodeContents(span); document.getSelection()!.addRange(range);
    const source = (ready.mock.calls[0] as unknown as [Document, () => { page: number }])[1]; expect(source().page).toBe(2);
  });

  it('marks the chosen duplicate across real text nodes, waits for the target page and never saves the search as a quote', async () => {
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal('CSS', { ...globalThis.CSS, highlights });
    vi.stubGlobal('Highlight', class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
    const rangeBounds = vi.fn(() => new DOMRect(32, 1100, 90, 25));
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable:true, value:rangeBounds });
    const words = ['   😀' + 'z'.repeat(80), '  NEEDLE', '  one  and needle', 'one.'];
    const changes = vi.fn(), active = () => [...(highlights.get('reader-pdf-search') ?? [])][0];
    const results = () => [...node.querySelectorAll<HTMLButtonElement>('.rc-results button')];
    const openResult = async (index: number) => { await openPanel('search'); await click(results()[index]!); };
    try {
      getPage.mockImplementation(async (page: number) => fakePage(page === 1 ? words : page === 3 ? 'needle one then needle one' : 'other'));
      await render(book(), { onQuotesChange:changes }); await visible(1);
      await search('NeEdLe   one'); await settle();
      expect(results()).toHaveLength(4);
      expect(results()[1]!.querySelector('mark')?.previousSibling?.textContent).toMatch(/^….*NEEDLE one and $/u);
      await openResult(0);
      expect(active()?.startContainer.textContent).toBe(words[1]);
      expect(active()?.startOffset).toBe(2); expect(active()?.endOffset).toBe(5);
      await openResult(1);
      const second = active()!;
      expect(second.startContainer.textContent).toBe(words[2]); expect(second.startOffset).toBe(words[2]!.indexOf('needle'));
      expect(second.endContainer.textContent).toBe('one.'); expect(second.endOffset).toBe(3);
      await openResult(3);
      expect(counter()).toBe('Страница 3 из 3'); expect(active()).toBeUndefined();
      await visible(2); expect(active()).toBeUndefined();
      await visible(3);
      const third = active()!;
      expect(third.startContainer.parentElement?.closest('[data-page]')?.getAttribute('data-page')).toBe('3');
      expect(third.toString()).toBe('needle one'); expect(third.startOffset).toBe(16);
      expect(rangeBounds).toHaveBeenCalled(); expect(reader().scrollTop).toBeGreaterThan(0);
      await openPanel('search'); await click(findButton('Закрыть панель')); expect(active()).toBe(third);
      await openPanel('search'); await input(searchInput(), 'different'); expect(active()).toBeUndefined();
      await search('needle one'); await settle(); await openResult(3); expect(active()?.startOffset).toBe(16);
      await click(findButton('Предыдущий экран')); expect(active()).toBeUndefined();
      const page3 = node.querySelector('[data-page="3"]')!;
      await act(async () => intersections.get(page3)!([{ isIntersecting:false, target:page3 } as IntersectionObserverEntry], {} as IntersectionObserver));
      await openResult(3);
      await act(async () => reader().dispatchEvent(new Event('wheel', { bubbles:true })));
      rangeBounds.mockClear(); await visible(3);
      expect(active()?.startOffset).toBe(16); expect(rangeBounds).not.toHaveBeenCalled();
      await openResult(0); expect(active()).toBeDefined();
      await render(book('other')); expect(active()).toBeUndefined();
      expect(changes).not.toHaveBeenCalled(); expect(document.getSelection()?.isCollapsed).toBe(true);
    } finally { Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect'); }
  });

  it('ignores navigation hotkeys while editing a search query and validates short queries', async () => {
    await render(); await openPanel('search');searchInput().focus();
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })));
    expect(counter()).toBe('Страница 1 из 3');
    const summary = node.querySelector<HTMLElement>('.rc-tabs button')!; summary.focus();
    await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })));
    expect(counter()).toBe('Страница 1 из 3');
    await search('x'); expect(node.textContent).toContain('Введите от 2 до 200 знаков.'); expect(getPage).not.toHaveBeenCalled();
  });

  it('uses original-text offsets for Unicode snippets and treats regex syntax literally', async () => {
    getPage.mockImplementation(async () => fakePage('İ'.repeat(1000) + 'needle [a+b] end'));
    await render(); await search('needle'); await settle();
    expect(node.querySelector('.rc-results')?.textContent).toContain('needle');
    await search('[a+b]'); await settle();
    expect(searchStatus()).toContain('Совпадений: 3'); expect(node.querySelector('.rc-results')?.textContent).toContain('[a+b]');
  });

  it('caps results honestly and never proceeds to another page after the cap', async () => {
    getPage.mockImplementation(async () => fakePage('needle '.repeat(220)));
    await render(); await search('needle'); await settle();
    expect(node.querySelectorAll('.rc-results li')).toHaveLength(200);
    expect(searchStatus()).toContain('Совпадений: 200 (лимит)'); expect(searchStatus()).toContain('первые 200 совпадений');
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest queued query and bounds unresolved repeated search work to one page request', async () => {
    const pending = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementationOnce(() => pending.promise);
    await render(); await search('first'); await search('second'); await search('needle');
    expect(getPage).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(fakePage('first second old result'))); await settle();
    expect(searchStatus()).toContain('«needle»'); expect(searchStatus()).toContain('Совпадений: 1');
    expect(node.querySelector('.rc-results')?.textContent).not.toContain('old result');
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
    expect(searchStatus()).toContain('Поиск остановлен.'); expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);
    await search('needle'); await settle(); expect(searchStatus()).toContain('Совпадений: 1');
  });

  it('closing the search panel cancels work, and a new book is not updated by an old request', async () => {
    const pending = deferred<ReturnType<typeof fakePage>>(); getPage.mockImplementationOnce(() => pending.promise);
    await render(); await search('needle');
    await click(findButton('Закрыть панель'));await openPanel('search');
    expect(searchStatus()).toContain('Поиск остановлен.');
    await render(book('new')); await act(async () => pending.resolve(fakePage('needle from old book'))); await settle();
    expect(searchStatus()).toBeUndefined(); expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);
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
    expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);
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
    await click(node.querySelector<HTMLButtonElement>('.rc-results button')!); expect(counter()).toBe('Страница 3 из 3');
  });

  it('stops at the total text budget without retaining or scanning the rest of a large book', async () => {
    pdf = { numPages: 50, getPage } as unknown as PDFDocumentProxy;
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
    getPage.mockImplementation(async () => fakePage('x'.repeat(250_000)));
    await render(); await search('missing'); await settle();
    expect(getPage).toHaveBeenCalledTimes(40);
    expect(searchStatus()).toContain('Достигнут лимит 10 млн знаков.');
    expect(searchStatus()).toContain('Проверено страниц: 40 из 50');
    expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);
  });

  it('bounds huge page text, cancels the stream and labels its incomplete coverage', async () => {
    const huge = fakePage('x'.repeat(250_100) + 'needle'); getPage.mockImplementation(async number => number === 1 ? huge : fakePage('normal'));
    await render(); await search('needle'); await settle();
    expect(searchStatus()).toContain('проверена только часть текста'); expect(searchStatus()).toContain('Совпадений: 0');
    expect(huge.reader.cancel).toHaveBeenCalled(); expect(huge.reader.releaseLock).toHaveBeenCalled();
  });
});

it('reopens all pages of a PDF highlight from its second page and updates only its original record',async()=>{
 const values=[['Intro. ', 'The blue station.'],['A blue ticket. ', 'A blue ticket.'],['Next.']];
 getPage.mockImplementation(async number=>fakePage(values[number-1]));
 const first={kind:'pdf' as const,id:'across',createdAt:123,page:1,start:7,endPage:2,end:13,text:'The blue station. A blue ticket',comment:'Старая заметка'};
 const other={kind:'pdf' as const,id:'again',createdAt:124,page:2,start:15,end:28,text:'A blue ticket'};
 const onQuotesChange=vi.fn();
 const descriptor=Object.getOwnPropertyDescriptor(Range.prototype,'getClientRects');
 Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:function(this:Range){
  const layer=this.startContainer.parentElement!.closest<HTMLElement>('.textLayer')!;
  const before=document.createRange();before.selectNodeContents(layer);before.setEnd(this.startContainer,this.startOffset);
  const page=Number(layer.closest<HTMLElement>('[data-page]')!.dataset.page);
  return [new DOMRect(10+before.toString().length*7,100*page,this.toString().length*7,20)];
 }});
 try{
  await render(book(),{quotes:[first,other],onQuotesChange});await visible(1);await visible(2);
  const spans=node.querySelectorAll<HTMLElement>('[data-page="2"] .textLayer span');
  const dialog=()=>node.querySelector<HTMLElement>('[role="dialog"][data-quote-tools]');
  async function hit(which:number,x:number,init:MouseEventInit={}){
   await act(async()=>spans[which].dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:210,...init})));
  }
  async function draft(value:string){const field=dialog()!.querySelector('textarea')!;await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);
   field.dispatchEvent(new Event('input',{bubbles:true}));});
  }
  await hit(0,62,{altKey:true});await hit(0,62,{shiftKey:true});await hit(0,108);
  expect(dialog()).toBeNull();
  await hit(0,62);
  expect(dialog()!.querySelector('blockquote')!.textContent).toBe(first.text);
  expect(dialog()!.querySelector('textarea')!.value).toBe(first.comment);
  await draft('Отменить');await click(findButton('Отмена'));expect(onQuotesChange).not.toHaveBeenCalled();
  await hit(1,150);expect(dialog()!.querySelector('blockquote')!.textContent).toBe(other.text);
  expect(dialog()!.querySelector('textarea')!.value).toBe('');
  await draft('Второе вхождение');await click(findButton('Сохранить'));
  expect(onQuotesChange.mock.lastCall?.[0]).toEqual([first,{...other,comment:'Второе вхождение'}]);
  await hit(0,62);await draft('Исправленный комментарий');await click(findButton('Сохранить'));
  expect(onQuotesChange.mock.lastCall?.[0]).toEqual([{...first,comment:'Исправленный комментарий'},other]);
  expect([...spans].map(span=>span.textContent)).toEqual(values[1]);
  await hit(0,62);await draft('Не терять черновик');
  const request=()=>dialog()!.querySelector<HTMLButtonElement>('.er-quote-delete-request')!;
  const confirm=()=>node.querySelector<HTMLElement>('[role="alertdialog"]')!;
  await click(request());expect(confirm().querySelector('blockquote')!.textContent).toBe(first.text);
  expect(document.activeElement?.textContent).toBe('Оставить');await click(document.activeElement as HTMLElement);
  expect(dialog()!.querySelector('textarea')!.value).toBe('Не терять черновик');expect(document.activeElement).toBe(request());
  await click(request());await click(confirm().querySelector<HTMLButtonElement>('.er-quote-danger')!);
  const remaining=onQuotesChange.mock.lastCall![0];expect(remaining).toEqual([other]);
  await render(book(),{quotes:remaining,onQuotesChange});
  expect(node.querySelectorAll('[data-page="1"] .er-pdf-marks i')).toHaveLength(0);
  expect(node.querySelectorAll('[data-page="2"] .er-pdf-marks i')).toHaveLength(1);
  await hit(0,62);expect(dialog()).toBeNull();await hit(1,150);expect(dialog()!.querySelector('blockquote')!.textContent).toBe(other.text);
  await openPanel('quotes');expect(node.querySelectorAll('.rc-quotes li')).toHaveLength(1);
 }finally{if(descriptor)Object.defineProperty(Range.prototype,'getClientRects',descriptor);else Reflect.deleteProperty(Range.prototype,'getClientRects');}
});
