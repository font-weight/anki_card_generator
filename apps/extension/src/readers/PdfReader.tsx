import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLocalPdfWorker, disposePdfLoading } from './pdf-worker';
import {watchBookSurfaceTaps,type PanelDismissRef} from './book-text-tap';
import { installReaderPaging, readerPagingControls } from './keyboard-paging';
import { READER_BOOKMARK_LIMIT, READER_BOOKMARK_LABEL_MAX, type DocumentReady, type PdfZoom, type ReaderAppearance, type ReaderBookmark, type ReadingProgress, type StoredBook } from './types';
import {ReaderChrome,ReaderChapters,ReaderQuoteList,ReaderSearch,ReaderBookmarkLink} from './ReaderChrome';
import {readerTheme,type ReaderTheme} from './reader-preferences';
import {QuoteSelectionTools} from './QuoteSelectionTools';
import {savedQuoteAtClick,type PaintedQuote} from './saved-quote-hit';
import {quoteRange,pdfSelection,type PdfQuote,type PdfQuoteSelection} from './pdf-quotes';
import { pdfSearchRange } from './pdf-search-range';
import {pdfChapters,type PdfChapter} from './pdf-outline';
import {displayBookTitle} from './book-presentation';
import {READER_QUOTE_LIMIT,READER_QUOTE_TEXT_MAX,type ReaderQuote,type ReaderBookInfo} from './types';
import './pdf-reader.css';

interface Props {
  onBack?:()=>void; onBookInfo?:(info:ReaderBookInfo)=>void;
  quotes?:ReaderQuote[]; onQuotesChange?:(quotes:ReaderQuote[])=>void;
  book: StoredBook; onProgress: (progress: ReadingProgress) => void; onDocumentReady?: DocumentReady;
  bookmarks?: ReaderBookmark[]; onBookmarksChange?: (next: ReaderBookmark[]) => void;
  appearance?: ReaderAppearance; onAppearanceChange?: (next: ReaderAppearance) => void;
  persistenceMode?: 'persistent' | 'session';
}
type Zoom = PdfZoom;
interface SearchHit { page: number; snippet: string; index: number; match: { start: number; end: number } }
interface SearchState {
  query: string; phase: 'idle' | 'running' | 'done' | 'cancelled'; hits: SearchHit[];
  scanned: number; unreadable: number; empty: number; truncated: number; limit: string; error: string;
}
// Only snippets survive each page. Streams, page text and result counts all have explicit bounds.
const SEARCH_PAGE_LIMIT = 2000, SEARCH_RESULT_LIMIT = 200, SEARCH_TEXT_LIMIT = 10_000_000;
const SEARCH_PAGE_TEXT_LIMIT = 250_000, SEARCH_PAGE_ITEM_LIMIT = 25_000;
const emptySearch = (): SearchState => ({ query: '', phase: 'idle', hits: [], scanned: 0, unreadable: 0, empty: 0, truncated: 0, limit: '', error: '' });
const yieldSearch = () => new Promise<void>(resolve => setTimeout(resolve, 0));
class PdfSearchTimeout extends Error {}
function boundedPdfRequest<T>(request: Promise<T>): Promise<T> {
  // PDF.js getPage has no cancellation API. On timeout this document's search is blocked,
  // not retried: its single underlying request remains owned by the document worker.
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new PdfSearchTimeout()), 15_000);
    request.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
}

async function searchPageText(pdf: PDFDocumentProxy, number: number, signal: AbortSignal, budget: number) {
  const page = await boundedPdfRequest(pdf.getPage(number));
  if (signal.aborted) return null;
  const reader = page.streamTextContent().getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const parts: string[] = [];
  let length = 0, items = 0, truncated = false, complete = false;
  try {
    while (!signal.aborted) {
      const chunk = await boundedPdfRequest(reader.read());
      if (chunk.done) { complete = true; break; }
      for (const item of chunk.value.items) {
        if (!('str' in item)) continue;
        const available = budget - length;
        if (available <= 0 || items >= SEARCH_PAGE_ITEM_LIMIT) { truncated = true; break; }
        const value = item.str.slice(0, available);
        parts.push(value); length += value.length; items++;
        if (value.length < item.str.length) { truncated = true; break; }
        if (length < budget) { parts.push(' '); length++; }
      }
      if (truncated) break;
      // A malicious text layer with very many tiny spans must not monopolize the UI thread.
      await yieldSearch();
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
  return signal.aborted ? null : { text: parts.join('').replace(/\s+/g, ' '), length, truncated };
}

function usePdfSearch(pdf: PDFDocumentProxy | undefined) {
  const [state, setState] = useState<SearchState>(emptySearch);
  const runner = useRef<{ alive: boolean; running: boolean; blocked: boolean; active: AbortController | null; next: { query: string; controller: AbortController } | null }>({ alive: true, running: false, blocked: false, active: null, next: null });
  useEffect(() => {
    const task = runner.current; task.alive = true;
    return () => { task.alive = false; task.active?.abort(); task.next?.controller.abort(); task.next = null; };
  }, []);
  const cancel = () => {
    const task = runner.current; task.active?.abort(); task.next?.controller.abort(); task.next = null;
    setState(previous => previous.phase === 'running' ? { ...previous, phase: 'cancelled' } : previous);
  };
  const submit = (query: string) => {
    if (!pdf) return;
    const task = runner.current;
    if (task.blocked) return;
    task.active?.abort(); task.next?.controller.abort();
    task.next = { query, controller: new AbortController() };
    setState({ ...emptySearch(), query, phase: 'running' });
    if (task.running) return;
    // Repeated submissions replace one queued job rather than starting unbounded getPage requests.
    task.running = true;
    void (async () => {
      try {
        while (task.alive && task.next) {
          const request = task.next; task.next = null; task.active = request.controller;
          const signal = request.controller.signal, snapshot = { ...emptySearch(), query: request.query, phase: 'running' as SearchState['phase'] };
          const matcher = new RegExp(request.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
          let chars = 0;
          const update = () => { if (task.alive && !signal.aborted) setState({ ...snapshot, hits: [...snapshot.hits] }); };
          for (let number = 1; number <= Math.min(pdf.numPages, SEARCH_PAGE_LIMIT) && !signal.aborted; number++) {
            try {
              const content = await searchPageText(pdf, number, signal, Math.min(SEARCH_PAGE_TEXT_LIMIT, SEARCH_TEXT_LIMIT - chars));
              if (!content || signal.aborted) break;
              chars += content.length;
              if (content.truncated) snapshot.truncated++;
              if (!content.text.trim()) snapshot.empty++;
              matcher.lastIndex = 0;
              let match: RegExpExecArray | null;
              while (snapshot.hits.length < SEARCH_RESULT_LIMIT && (match = matcher.exec(content.text))) {
                const index = match.index, from = Math.max(0, index - 65), to = Math.min(content.text.length, index + match[0].length + 95);
                const start = index - from + (from ? 1 : 0);
                snapshot.hits.push({ page: number, index, match: { start, end: start + match[0].length }, snippet: `${from ? '…' : ''}${content.text.slice(from, to)}${to < content.text.length ? '…' : ''}` });
              }
            } catch (failure) {
              if (failure instanceof PdfSearchTimeout) {
                task.blocked = true; runner.current.next?.controller.abort(); task.next = null;
                if (task.alive) setState(previous => ({ ...previous, phase: 'done', error: 'PDF не отвечает на поиск. Закройте книгу и откройте исходный файл снова. Чтение можно продолжить.' }));
                request.controller.abort();
                break;
              }
              if (signal.aborted) break;
              snapshot.unreadable++;
            }
            if (signal.aborted) break;
            snapshot.scanned = number;
            if (snapshot.hits.length >= SEARCH_RESULT_LIMIT) snapshot.limit = `Показаны первые ${SEARCH_RESULT_LIMIT} совпадений. Уточните запрос.`;
            else if (chars >= SEARCH_TEXT_LIMIT) snapshot.limit = 'Достигнут лимит 10 млн знаков. Проверена только часть книги.';
            else if (number === SEARCH_PAGE_LIMIT && pdf.numPages > number) snapshot.limit = `Проверены только первые ${SEARCH_PAGE_LIMIT} страниц.`;
            update();
            if (snapshot.limit) break;
            await yieldSearch();
          }
          snapshot.phase = 'done'; update();
        }
      } finally { task.running = false; task.active = null; }
    })();
  };
  return { state, submit, cancel };
}
interface Position { page: number; offset: number }
const clampOffset = (value: number | undefined) => Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : 0;
const initialPage = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 ? value! : 1;

const emptyQuotes:ReaderQuote[]=[];
const Page = memo(function Page({ pdf, number, onReady, zoom, width, quotes, searchHit, onSearchRange, onEditQuote }: {
  pdf: PDFDocumentProxy; number: number; onReady: (number: number) => void; zoom: Zoom; width: number; quotes:ReaderQuote[];
  onEditQuote:(quote:PdfQuote,rect:DOMRect,returnFocus?:HTMLElement)=>void;
  searchHit: SearchHit | null; onSearchRange: (hit: SearchHit, range: Range) => void;
}) {
  const ref = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [empty, setEmpty] = useState(false), [error, setError] = useState('');
  const [renderedLayer, setRenderedLayer] = useState<TextLayer | null>(null), [size, setSize] = useState({ width: 612, height: 792 });
  const ready = renderedLayer !== null;
  const scale = zoom === 'fit' ? Math.min(1.5, width / size.width) : Number(zoom);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) setVisible(entry.isIntersecting);
    }, { rootMargin: '500px 0px' });
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    const c = canvas.current!, t = text.current!, node = ref.current!;
    setRenderedLayer(null); setEmpty(false); setError('');
    (async () => {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const pageScale = zoom === 'fit' ? Math.min(1.5, width / base.width) : Number(zoom);
      const viewport = page.getViewport({ scale: pageScale });
      setSize(previous => previous.width === base.width && previous.height === base.height ? previous : { width: base.width, height: base.height });
      c.width = viewport.width; c.height = viewport.height;
      node.style.minHeight = `${viewport.height}px`; node.style.width = `${viewport.width}px`;
      t.replaceChildren();
      t.style.setProperty('--scale-factor', String(pageScale));
      t.style.setProperty('--total-scale-factor', String(pageScale));
      t.style.width = `${viewport.width}px`; t.style.height = `${viewport.height}px`;
      render = page.render({ canvasContext: c.getContext('2d')!, canvas: c, viewport });
      // Text extraction may fail before the canvas promise is awaited.
      void render.promise.catch(() => {});
      const content = await page.getTextContent();
      if (cancelled) return;
      setEmpty(!content.items.some(item => 'str' in item && item.str.trim()));
      layer = new TextLayer({ textContentSource: content, container: t, viewport });
      await Promise.all([render.promise, layer.render()]);
      if (!cancelled) { setRenderedLayer(layer); onReady(number); }
    })().catch(error => {
      if (!cancelled) { setError(error instanceof Error ? error.message : String(error)); onReady(number); }
    });
    return () => {
      cancelled = true; render?.cancel(); layer?.cancel();
      c.width = 0; c.height = 0; t.replaceChildren();
    };
  }, [visible, pdf, number, onReady, zoom, width]);
  useEffect(() => {
    if (!searchHit || !visible || !renderedLayer || !globalThis.CSS?.highlights || !globalThis.Highlight) return;
    const range = pdfSearchRange(renderedLayer.textDivs, searchHit.index, searchHit.match.end - searchHit.match.start);
    if (!range) return;
    const name = 'reader-pdf-search', highlight = new Highlight(range), registry = CSS.highlights;
    registry.set(name, highlight);
    onSearchRange(searchHit, range);
    return () => { if (registry.get(name) === highlight) registry.delete(name); };
  }, [renderedLayer, visible, searchHit, onSearchRange]);
  const quoteRanges=useRef<PaintedQuote[]>([]);
  const [marks,setMarks] = useState<{x:number;y:number;width:number;height:number}[]>([]);
  useEffect(()=>{
    quoteRanges.current=[];
    if(!visible||!ready||!text.current||!quotes.length){setMarks(previous=>previous.length?[]:previous);return;}
    const layer=text.current,bounds=layer.getBoundingClientRect();
    const next=quotes.flatMap(quote=>{
      if(quote.kind!=='pdf')return [];
      const range=quoteRange(layer,number,quote);
      if(!range)return [];
      quoteRanges.current.push({quote,range});
      return Array.from(range.getClientRects()).filter(box=>box.width>0&&box.height>0)
        .map(box=>({x:box.left-bounds.left,y:box.top-bounds.top,width:box.width,height:box.height}));
    });
    setMarks(next);
  },[visible,renderedLayer,quotes,number,zoom,width]);
  return <section ref={ref} data-page={number} className="er-pdf-page" aria-label={`Страница ${number}`} aria-busy={visible && !ready && !error} data-page-ready={visible && (ready || !!error) ? 'true' : undefined}
    onClick={event=>{
      const target=event.target as Element;
      if(!target.closest('.textLayer'))return;
      const hit=savedQuoteAtClick(event.nativeEvent,quoteRanges.current);
      if(hit?.quote.kind==='pdf')onEditQuote(hit.quote,hit.rect,target.closest<HTMLElement>('.er-pdf-reader')??undefined);
    }} style={{ minHeight: size.height * scale, width: size.width * scale }}>
    <canvas ref={canvas} aria-hidden="true" /><div aria-hidden="true" className="er-pdf-marks">{marks.map((box,i)=><i key={i} style={{left:box.x,top:box.y,width:box.width,height:box.height}}/>)}</div><div className="textLayer" ref={text} />
    {visible && !ready && !error && <p className="er-pdf-page-message">Загрузка страницы {number}…</p>}
    {empty && <p className="er-pdf-page-message">Нет текстового слоя. OCR не поддерживается.</p>}
    {error && <p className="er-pdf-page-message" role="alert">Страница {number}: {error}</p>}
  </section>;
});

/** A new document always owns a fresh worker, navigation state and restore request. */
export function PdfReader(props: Props) { return <PdfSession key={props.book.documentId} {...props} />; }
function PdfSession({ book, onBack, onBookInfo, quotes, onQuotesChange, onProgress, onDocumentReady, bookmarks, onBookmarksChange, appearance, onAppearanceChange, persistenceMode = 'session' }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(initialPage(book.progress?.page));
  const [jump, setJump] = useState(String(currentPage)), [jumpError, setJumpError] = useState('');
  const [zoom, setZoom] = useState<Zoom>(appearance?.kind === 'pdf' ? appearance.zoom : 'fit'), [width, setWidth] = useState(Math.max(240, window.innerWidth - 64));
  const [localBookmarks, setLocalBookmarks] = useState<ReaderBookmark[]>([]), [bookmarkLabel, setBookmarkLabel] = useState('');
  const [bookmarkMessage, setBookmarkMessage] = useState(''), [bookmarkError, setBookmarkError] = useState('');
  const [searchHit, setSearchHit] = useState<SearchHit | null>(null);
  const searchDestination = useRef<SearchHit | null>(null);
  const [query, setQuery] = useState(''), [queryError, setQueryError] = useState('');
  const [localQuotes,setLocalQuotes]=useState<ReaderQuote[]>(emptyQuotes), savedQuotes=quotes??localQuotes;
  const [selection,setSelection]=useState<PdfQuoteSelection|null>(null), [quoteError,setQuoteError]=useState('');
  const [quoteStatus,setQuoteStatus]=useState('');
  const [chapters,setChapters]=useState<PdfChapter[]>([]), [outlineError,setOutlineError]=useState(false);
  const [theme,setTheme]=useState(()=>readerTheme(appearance?.kind==='pdf'?appearance.theme:undefined));
  const [jumpOpen,setJumpOpen]=useState(false);
  const jumpId=React.useId(),jumpButton=useRef<HTMLButtonElement>(null);
  const info=useRef(onBookInfo);info.current=onBookInfo;
  const quoteDestination=useRef<PdfQuote|null>(null);
  const savedBookmarks = bookmarks ?? localBookmarks;
  const bookmarksRef = useRef(savedBookmarks); bookmarksRef.current = savedBookmarks;
  const search = usePdfSearch(pdf);
  const host = useRef<HTMLDivElement>(null), jumpInput = useRef<HTMLInputElement>(null);
  const textTapDismiss=useRef<PanelDismissRef['current']>(null),textTaps=useRef<ReturnType<typeof watchBookSurfaceTaps>|null>(null);
  useEffect(()=>{
    if(!host.current||!pdf)return;
    const bookSurface=host.current.closest<HTMLElement>('.rc-book-view')!;
    const watch=watchBookSurfaceTaps(bookSurface,textTapDismiss,range=>{
      const anchor=pdfSelection(host.current!,range);if(!anchor)return;
      return {range:()=>{
        const layer=host.current?.querySelector<HTMLElement>(`[data-page="${anchor.page}"] .textLayer`);
        return layer?quoteRange(layer,anchor.page,anchor):null;
      },selected:fresh=>{const value=pdfSelection(host.current!,fresh);if(value)setSelection(value);}};
    });
    textTaps.current=watch;
    return ()=>{watch.dispose();textTaps.current=null;};
  },[pdf]);
  const hoverPage = useRef<number | null>(null);
  const page = useRef(currentPage), documentRef = useRef(pdf), widthRef = useRef(width), zoomRef = useRef(zoom), jumpDirty = useRef(false);
  const pending = useRef<Position | null>({ page: currentPage, offset: clampOffset(book.progress?.offset) });
  const saveRef = useRef(onProgress), readyRef = useRef(onDocumentReady), lastSaved = useRef<Position | null>(null);
  saveRef.current = onProgress; readyRef.current = onDocumentReady; documentRef.current = pdf; zoomRef.current = zoom;

  const showPage = useCallback((number: number) => {
    page.current = number; setCurrentPage(number);
    if (!jumpDirty.current) setJump(String(number));
  }, []);
  const elementFor = useCallback((number: number) => host.current?.querySelector<HTMLElement>(`[data-page="${number}"]`), []);
  const readingTop = useCallback(() => (host.current?.getBoundingClientRect().top || 0) + 12, []);
  const position = useCallback((): Position | null => {
    const line = readingTop();
    const pages = host.current?.querySelectorAll<HTMLElement>('[data-page]');
    if (!pages?.length) return null;
    const current = Array.from(pages).find(node => node.getBoundingClientRect().bottom > line) || pages[pages.length - 1]!;
    const rect = current.getBoundingClientRect();
    return { page: Number(current.dataset.page), offset: clampOffset((line - rect.top) / Math.max(1, rect.height)) };
  }, [readingTop]);
  const persist = useCallback((value: Position) => {
    showPage(value.page);
    const previous = lastSaved.current;
    if (previous?.page === value.page && Math.abs(previous.offset - value.offset) < 0.001) return;
    lastSaved.current = value;
    const count=documentRef.current?.numPages;
    saveRef.current({ ...value, ...(count?{percent:count===1?0:(value.page-1)*100/(count-1)}:{}), updatedAt: Date.now() });
  }, [showPage]);
  const scrollTo = useCallback((value: Position) => {
    const element = elementFor(value.page);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if(host.current) host.current.scrollTop += rect.top - readingTop() + value.offset * rect.height;
  }, [elementFor, readingTop]);
  const revealSearch = useCallback((hit: SearchHit, range: Range) => {
    const viewport = host.current;
    if (!viewport || searchDestination.current !== hit) return;
    searchDestination.current = null;
    const bounds = viewport.getBoundingClientRect(), match = range.getBoundingClientRect();
    if (match.top < bounds.top + 12 || match.bottom > bounds.bottom - 12)
      viewport.scrollTop += match.top - bounds.top - Math.min(64, bounds.height / 4);
    if (match.left < bounds.left || match.right > bounds.right)
      viewport.scrollLeft += match.left - bounds.left - 12;
  }, []);
  const revealQuote = useCallback((number:number) => {
    const q=quoteDestination.current;if(!q||q.page!==number)return;
    const item=elementFor(number),layer=item?.querySelector<HTMLElement>('.textLayer');
    if(!host.current||!layer)return;
    const range=quoteRange(layer,number,q);
    if(!range)return;
    host.current.scrollTop+=range.getBoundingClientRect().top-readingTop()-14;
    quoteDestination.current=null;
  },[elementFor,readingTop]);
  const onReady = useCallback((number: number) => {
    const target = pending.current;
    if (!target || target.page !== number) return;
    // A slower page must never pull the reader back after a newer jump or manual scroll.
    scrollTo(target); pending.current = null; persist(target); revealQuote(number);
  }, [persist, scrollTo, revealQuote]);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined, owned: ReturnType<typeof createLocalPdfWorker> | undefined;
    (async () => {
      const data = await book.blob.arrayBuffer();
      if (cancelled) return;
      owned = createLocalPdfWorker();
      owned.port.addEventListener('error', () => {
        if (!cancelled) setError('Не удалось запустить локальный PDF worker. Проверьте сборку расширения.');
        disposePdfLoading(task, owned);
      }, { once: true });
      task = getDocument({ data, worker: owned.worker, useWasm: false, cMapUrl: new URL('pdfjs/cmaps/', location.href).href, cMapPacked: true,
        standardFontDataUrl: new URL('pdfjs/standard_fonts/', location.href).href, wasmUrl: new URL('pdfjs/wasm/', location.href).href, enableXfa: false });
      const doc = await task.promise;
      if (cancelled) { disposePdfLoading(task, owned); return; }
      const number = Math.min(page.current, doc.numPages);
      showPage(number); if (pending.current) pending.current.page = number;
      setPdf(doc);
      if(typeof doc.getMetadata==='function') void doc.getMetadata().then(({info:raw})=>{
        if(cancelled||!raw||typeof raw!=='object')return;
        const metadata=raw as Record<string,unknown>;
        info.current?.({title:typeof metadata.Title==='string'?metadata.Title:undefined,author:typeof metadata.Author==='string'?metadata.Author:undefined});
      }).catch(()=>{});
      if(typeof doc.getOutline==='function') void pdfChapters(doc,()=>!cancelled).then(rows=>{if(!cancelled)setChapters(rows);}).catch(()=>{if(!cancelled)setOutlineError(true);});
    })().catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      disposePdfLoading(task, owned);
    });
    return () => { cancelled = true; disposePdfLoading(task, owned); };
  }, [book.documentId, showPage]);

  useEffect(() => {
    if (!pdf) return;
    return readyRef.current?.(document, range => {
      const selection = document.getSelection();
      const sourceNode = range?.startContainer ?? (selection?.isCollapsed === false ? selection.anchorNode : null);
      const sourceElement = sourceNode?.nodeType === 1 ? sourceNode as Element : sourceNode?.parentElement;
      const selected = sourceElement?.closest<HTMLElement>('[data-page]') ?? null;
      return { kind: 'pdf', title: displayBookTitle(book.title), url: null, documentId: book.documentId,
        page: selected && host.current?.contains(selected) ? Number(selected.dataset.page) : hoverPage.current || page.current, chapter: null, cfi: null };
    });
  }, [pdf, book.documentId, book.title]);
  useEffect(() => {
    if (pdf && pending.current) scrollTo(pending.current);
  }, [pdf, zoom, width, scrollTo]);
  useEffect(() => {
    const node = host.current;
    if(!node)return;
    const measure = () => {
      const next = Math.max(1, Math.floor((node.clientWidth || window.innerWidth - 64) - 24));
      if (Math.abs(next - widthRef.current) < 2) return;
      if (documentRef.current && zoomRef.current === 'fit' && !pending.current) pending.current = position();
      widthRef.current = next; setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [pdf, position]);
  useEffect(() => {
    if (!pdf || error) return;
    let frame = 0;
    const save = () => { if (!pending.current) { const value = position(); if (value) persist(value); } };
    const schedule = () => { if(!bookEditorOpen())setSelection(null); hoverPage.current = null; if (!frame) frame = requestAnimationFrame(() => { frame = 0; save(); }); };
    const interrupt = () => { pending.current = null; quoteDestination.current=null; };
    const manualScroll = (event: Event) => {
      interrupt();
      if (event.target instanceof Node && host.current?.contains(event.target)) searchDestination.current = null;
    };
    const outsidePointer = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) interrupt(); };
    const viewport=host.current;
    viewport?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('wheel', manualScroll, { passive: true });
    window.addEventListener('touchstart', manualScroll, { passive: true });
    window.addEventListener('pointerdown', outsidePointer, { passive: true });
    window.addEventListener('pagehide', save);
    return () => {
      cancelAnimationFrame(frame); save(); viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('wheel', manualScroll); window.removeEventListener('touchstart', manualScroll); window.removeEventListener('pointerdown', outsidePointer); window.removeEventListener('pagehide', save);
    };
  }, [pdf, error, persist, position]);

  const navigate = useCallback((number: number, offset = 0) => {
    if (!pdf || error || number < 1 || number > pdf.numPages) return;
    textTaps.current?.relocated();
    searchDestination.current = null; setSearchHit(null);
    quoteDestination.current=null;setSelection(null);setJumpOpen(false);hoverPage.current = null; jumpDirty.current = false; setJumpError('');
    const target = { page: number, offset: clampOffset(offset) };
    pending.current = target; persist(target); scrollTo(target);
    // Already rendered pages will not emit another ready event just for scrolling.
    if (elementFor(number)?.dataset.pageReady === 'true') pending.current = null;
  }, [pdf, error, persist, scrollTo, elementFor]);
  const changeZoom = (value: Zoom) => {
    if (value === zoom) return;
    pending.current = pending.current || position(); setZoom(value);
    onAppearanceChange?.({ kind: 'pdf', zoom: value, ...(theme!=='white'||appearance?.kind==='pdf'&&appearance.theme?{theme:theme==='graphite'?'dark':theme==='cream'?'cream':'light'}:{}) });
  };
  const changeBookmarks = (next: ReaderBookmark[]) => {
    bookmarksRef.current = next;
    if (bookmarks === undefined) setLocalBookmarks(next);
    onBookmarksChange?.(next);
  };
  const addBookmark = () => {
    if (!pdf || error) return;
    const value = pending.current || position() || { page: page.current, offset: 0 };
    const existing = bookmarksRef.current;
    if (bookmarkLabel.trim().length > READER_BOOKMARK_LABEL_MAX) { setBookmarkError(`Название — не больше ${READER_BOOKMARK_LABEL_MAX} знаков.`); return; }
    if (existing.length >= READER_BOOKMARK_LIMIT) { setBookmarkError(`Можно добавить не больше ${READER_BOOKMARK_LIMIT} закладок. Удалите ненужную.`); return; }
    if (existing.some(item => item.kind === 'pdf' && item.page === value.page && Math.abs(item.offset - value.offset) < .005)) {
      setBookmarkError('Это место уже есть в закладках.'); return;
    }
    changeBookmarks([...existing, { id: crypto.randomUUID(), kind: 'pdf', label: bookmarkLabel.trim() || `Страница ${value.page}`,
      page: value.page, offset: clampOffset(value.offset), createdAt: Date.now() }]);
    setBookmarkLabel(''); setBookmarkError(''); setBookmarkMessage('Закладка добавлена.');
  };
  useEffect(() => {
    if (!pdf || error) return;
    return installReaderPaging({ root: host.current!, keys: ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' '], onKey: event => {
      const next = ['PageDown', 'ArrowRight'].includes(event.key) ? page.current + 1 : ['PageUp', 'ArrowLeft'].includes(event.key) ? page.current - 1 :
        event.key === 'Home' ? 1 : event.key === 'End' ? pdf.numPages : null;
      if (next !== null) { navigate(next); return true; }
      pending.current = null; // Native scrolling must cancel an older restore.
      return false;
    } }).dispose;
  }, [pdf, error, navigate]);
  const title=displayBookTitle(book.title);
  const selectedChapter=chapters.reduce((best,row)=>row.page<=currentPage&&(!best||row.page>=best.page)?row:best,undefined as PdfChapter|undefined);
  const chapterIndex=selectedChapter?chapters.indexOf(selectedChapter):-1;
  const pageLabelForBookmark=`Страница ${currentPage}`;
  const currentBookmark=savedBookmarks.find(item=>item.kind==='pdf'&&item.page===currentPage&&item.label===pageLabelForBookmark&&item.offset===0);
  const togglePageBookmark=()=>{
    if(currentBookmark){changeBookmarks(savedBookmarks.filter(b=>b.id!==currentBookmark.id));setBookmarkError('');return;}
    if(savedBookmarks.length>=READER_BOOKMARK_LIMIT){setBookmarkError(`Можно добавить не больше ${READER_BOOKMARK_LIMIT} закладок.`);return;}
    changeBookmarks([...savedBookmarks,{id:crypto.randomUUID(),kind:'pdf',label:pageLabelForBookmark,page:currentPage,offset:0,createdAt:Date.now()}]);
    setBookmarkError('');
  };
  const editSavedQuote=useCallback((quote:PdfQuote,rect:DOMRect,returnFocus?:HTMLElement,confirmDelete=false)=>{
    setQuoteError('');setQuoteStatus('');setSelection({...quote,saved:quote,rect,returnFocus,confirmDelete});
  },[]);
  const bookEditorOpen=()=>!!host.current?.closest('.rc-shell')?.querySelector('.er-quote-editor');
  const captureSelection=()=>{
    if(textTapDismiss.current&&bookEditorOpen())return;
    const selected=document.getSelection();
    if(!selected||!selected.rangeCount||selected.isCollapsed||!host.current){setSelection(null);return;}
    const value=pdfSelection(host.current,selected.getRangeAt(0));
    if(value && value.text.length>READER_QUOTE_TEXT_MAX){
      setSelection(null);setQuoteError(`Цитата может содержать до ${READER_QUOTE_TEXT_MAX} знаков.`);return;
    }
    setQuoteError('');setSelection(value);
  };
  const changeQuotes=(next:ReaderQuote[])=>{if(quotes===undefined)setLocalQuotes(next);onQuotesChange?.(next);};
  const removeQuote=(id:string)=>{
    if(selection?.saved?.id!==id)return;
    const next=savedQuotes.filter(q=>q.kind!=='pdf'||q.id!==id);
    if(next.length!==savedQuotes.length){changeQuotes(next);setQuoteStatus('Цитата удалена.');}
    setSelection(null);
  };
  const saveQuote=(comment?:string)=>{
    if(!selection)return;
    const same=savedQuotes.find(q=>q.kind==='pdf' && (selection.saved?q.id===selection.saved.id:
      q.page===selection.page&&(q.endPage??q.page)===(selection.endPage??selection.page)&&q.start===selection.start&&q.end===selection.end));
    if(selection.saved&&!same){setSelection(null);return;}
    if(!same&&savedQuotes.length>=READER_QUOTE_LIMIT){setQuoteError(`Можно сохранить до ${READER_QUOTE_LIMIT} цитат.`);return;}
    const {page,start,end,endPage,text}=selection;
    const q:ReaderQuote=same?{...same,...(comment?{comment}:{})}:{id:crypto.randomUUID(),kind:'pdf',page,start,end,...(endPage?{endPage}:{}),text,createdAt:Date.now(),...(comment?{comment}:{})};
    const next=same?savedQuotes.map(item=>item.id===same.id?q:item):[...savedQuotes,q];
    changeQuotes(next);setSelection(null);if(!selection.saved)document.getSelection()?.removeAllRanges();
  };
  const changeTheme=(value:ReaderTheme)=>{
    setTheme(value);setSelection(null);
    onAppearanceChange?.({kind:'pdf',zoom,theme:value==='graphite'?'dark':value==='cream'?'cream':'light'});
  };
  const openSearchHit = (hit: SearchHit) => {
    navigate(hit.page);
    const selected = { ...hit };
    searchDestination.current = selected;
    setSearchHit(selected);
  };
  const clearSearchHit = () => { searchDestination.current = null; setSearchHit(null); };
  const submitSearch=()=>{
    clearSearchHit();
    const value=query.trim().replace(/\s+/g,' ');
    if(value.length<2||value.length>200){setQueryError('Введите от 2 до 200 знаков.');return;}
    setQueryError('');search.submit(value);
  };
  const pageLabel=`Страница ${currentPage} из ${pdf?.numPages??'…'}`;
  return <ReaderChrome title={title} onBack={onBack} theme={theme} onThemeChange={changeTheme}
    chapter={selectedChapter?{label:selectedChapter.title,previous:chapterIndex>0?()=>navigate(chapters[chapterIndex-1]!.page):undefined,next:chapterIndex+1<chapters.length?()=>navigate(chapters[chapterIndex+1]!.page):undefined}:undefined}
    page={{label:pageLabel,previous:pdf&&currentPage>1?()=>navigate(currentPage-1):undefined,next:pdf&&currentPage<pdf.numPages?()=>navigate(currentPage+1):undefined}}
    pageControl={pdf&&<div className="er-pdf-pager">
      <button ref={jumpButton} className="er-pdf-counter" type="button" title="Перейти к странице"
        aria-controls={jumpOpen?jumpId:undefined} aria-expanded={jumpOpen}
        onClick={()=>{setJumpOpen(!jumpOpen);setJump(String(currentPage));setJumpError('');jumpDirty.current=false;}}>{pageLabel}</button>
      {jumpOpen&&<form id={jumpId} className="er-pdf-jump" aria-label="Переход к странице PDF" noValidate
        onKeyDown={event=>{
          if(event.key==='Escape'){
            event.preventDefault();event.stopPropagation();setJumpOpen(false);jumpButton.current?.focus();
          }
        }} onSubmit={event => {
          event.preventDefault();
          const number = /^\d+$/.test(jump.trim()) ? Number(jump.trim()) : NaN;
          if (!Number.isSafeInteger(number) || number < 1 || number > pdf.numPages) {
            setJumpError(`Введите целую страницу от 1 до ${pdf.numPages}.`); jumpInput.current?.focus(); return;
          }
          navigate(number);jumpButton.current?.focus();
        }}>
          <label>К странице<input ref={jumpInput} autoFocus aria-label="Номер страницы PDF" inputMode="numeric" value={jump} aria-invalid={!!jumpError}
            aria-describedby={jumpError?jumpId+'-error':undefined} onChange={event => { jumpDirty.current = true; setJump(event.target.value); setJumpError(''); }} /></label>
          <button type="submit">Перейти</button>
          {jumpError&&<p id={jumpId+'-error'} className="er-pdf-jump-error" role="alert">{jumpError}</p>}
        </form>}</div>}
    pageProgress={pdf?{current:currentPage,total:pdf.numPages,seek:navigate}:undefined}
    bookmarked={!!currentBookmark} onBookmark={pdf?togglePageBookmark:undefined}
    textTapDismiss={textTapDismiss} onPanelChange={(panel,fromPage)=>{if(!fromPage||!bookEditorOpen())setSelection(null);if(panel!=='search'&&search.state.phase==='running')search.cancel();}}
    search={<><ReaderSearch label="Поиск в PDF" query={query} onQuery={v=>{clearSearchHit();setQuery(v);setQueryError('');}} onSubmit={submitSearch}
      onCancel={search.state.phase==='running'?search.cancel:undefined} disabled={!!search.state.error||!pdf}
      items={search.state.hits.map(hit=>({id:`${hit.page}:${hit.index}`,title:`Страница ${hit.page}`,excerpt:hit.snippet,match:hit.match,onOpen:()=>openSearchHit(hit)}))}/>
      {queryError&&<p role="alert">{queryError}</p>}{search.state.error&&<p role="alert">{search.state.error}</p>}
      {pdf&&<>{search.state.phase !== 'idle' && <div className="er-pdf-search-status" role="status" aria-live="polite">
              <p>{search.state.error ? 'Поиск прерван.' : search.state.phase === 'running' ? 'Поиск…' : search.state.phase === 'cancelled' ? 'Поиск остановлен.' : 'Поиск завершён.'} «{search.state.query}» · Совпадений: {search.state.hits.length}{search.state.limit && search.state.hits.length >= SEARCH_RESULT_LIMIT ? ' (лимит)' : ''} · Проверено страниц: {search.state.scanned} из {pdf.numPages}.</p>
              {search.state.limit && <p>{search.state.limit}</p>}
              {search.state.truncated > 0 && <p>На {search.state.truncated} стр. проверена только часть текста (лимит 250 000 знаков или 25 000 фрагментов на страницу).</p>}
              {search.state.unreadable > 0 && <p>Не удалось прочитать {search.state.unreadable} стр. Попробуйте открыть исходный PDF заново.</p>}
              {search.state.empty > 0 && <p>Без извлекаемого текста: {search.state.empty} стр. OCR не поддерживается.</p>}
            </div>}</>}</>}
    chapters={outlineError?<p>Не удалось прочитать оглавление этого PDF.</p>:<ReaderChapters selected={selectedChapter?.id} items={chapters.map(item=>({...item,onOpen:()=>navigate(item.page)}))}/>}
    bookmarks={pdf&&<div className="er-pdf-bookmark-details">
        <form className="er-pdf-bookmark-form" onSubmit={event => { event.preventDefault(); addBookmark(); }}>
              <label>Название закладки<input aria-label="Название закладки PDF" maxLength={READER_BOOKMARK_LABEL_MAX} value={bookmarkLabel}
                placeholder={`Страница ${currentPage}`} onChange={event => { setBookmarkLabel(event.target.value); setBookmarkError(''); setBookmarkMessage(''); }} /></label>
              <button type="submit">Добавить текущее место</button>
            </form>
            {bookmarkError && <p role="alert">{bookmarkError}</p>}
            <p className="er-pdf-tool-note" role="status">{bookmarkMessage}</p>
            {!savedBookmarks.length&&<p className="rc-empty">Пока нет закладок.</p>}
            <ul className="er-pdf-bookmarks">{savedBookmarks.filter((item): item is Extract<ReaderBookmark, { kind: 'pdf' }> => item.kind === 'pdf').map(item => <li key={item.id}>
              <ReaderBookmarkLink className="er-pdf-bookmark-link" disabled={item.page > pdf.numPages} onOpen={() => navigate(item.page, item.offset)}>
                <span>{item.label}</span><small>Страница {item.page}{item.page > pdf.numPages ? ' — недоступна' : ''}</small>
              </ReaderBookmarkLink>
              <button type="button" aria-label={`Удалить закладку «${item.label}»`} onClick={() => {
                changeBookmarks(bookmarksRef.current.filter(bookmark => bookmark.id !== item.id)); setBookmarkError(''); setBookmarkMessage('Закладка удалена.');
              }}>Удалить</button>
            </li>)}</ul>
          </div>}
    quotes={<ReaderQuoteList title={title} items={savedQuotes.filter((q):q is PdfQuote=>q.kind==='pdf').map(q=>({id:q.id,text:q.text,comment:q.comment,onEdit:trigger=>editSavedQuote(q,trigger.getBoundingClientRect(),trigger),
      onRequestDelete:trigger=>editSavedQuote(q,trigger.getBoundingClientRect(),trigger,true),location:`Страница ${q.page}`,onOpen:()=>{
      navigate(q.page);quoteDestination.current=q;
      if(elementFor(q.page)?.dataset.pageReady==='true')revealQuote(q.page);
    }}))}/>}
    appearance={<><label className="rc-setting-row">Масштаб PDF<select value={zoom} onChange={e=>changeZoom(e.target.value as Zoom)}>
      <option value="fit">По ширине</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label>
      <p className="rc-subtle">{persistenceMode==='session'?'Только в этой сессии: закладки и масштаб не сохраняются после закрытия.':'PDF сохраняет исходную вёрстку страницы.'}</p></>}
    notices={error?<p role="alert">Не удалось открыть PDF: {error}</p>:quoteError||bookmarkError?<p role="alert">{quoteError||bookmarkError}</p>:undefined}>
          <div ref={host} className="er-pdf-reader" tabIndex={0} role="region" aria-label="Чтение PDF"
    onPointerUp={e=>{if(!e.altKey&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey)captureSelection();else setSelection(null);}}
    onKeyDown={e=>{if(e.key==='Alt'||e.key==='Shift'||e.key==='Escape')setSelection(null);}}
    onKeyUp={e=>{if(e.shiftKey&&/^(Arrow|Home|End)/.test(e.key))captureSelection();}}
    onPointerMove={event => {
      const target = (event.target as Element).closest<HTMLElement>('[data-page]');
      hoverPage.current = target ? Number(target.dataset.page) : null;
    }}
    onPointerDown={event => {
      if (!(event.target as Element).closest('.er-pdf-pages') || (event.target as Element).closest(readerPagingControls)) return;
      pending.current = null; searchDestination.current = null;
    }}>

      {!pdf&&!error&&<p role="status">Загрузка PDF…</p>}
      {pdf&&<div className="er-pdf-pages">{Array.from({length:pdf.numPages},(_,i)=><Page key={i} pdf={pdf} number={i+1} onReady={onReady} zoom={zoom} width={zoom==='fit'?width:0} quotes={savedQuotes} onEditQuote={editSavedQuote} searchHit={searchHit?.page===i+1?searchHit:null} onSearchRange={revealSearch}/>)}</div>}
    </div>
    <span role="status" className="er-reader-status">{quoteStatus}</span>
    <QuoteSelectionTools selection={selection} onSave={saveQuote} onDelete={removeQuote} onCancel={()=>setSelection(null)}/>
  </ReaderChrome>;
}
