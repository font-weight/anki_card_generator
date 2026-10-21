import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLocalPdfWorker, disposePdfLoading } from './pdf-worker';
import { READER_BOOKMARK_LIMIT, READER_BOOKMARK_LABEL_MAX, type DocumentReady, type PdfZoom, type ReaderAppearance, type ReaderBookmark, type ReadingProgress, type StoredBook } from './types';
import './pdf-reader.css';

interface Props {
  book: StoredBook; onProgress: (progress: ReadingProgress) => void; onDocumentReady?: DocumentReady;
  bookmarks?: ReaderBookmark[]; onBookmarksChange?: (next: ReaderBookmark[]) => void;
  appearance?: ReaderAppearance; onAppearanceChange?: (next: ReaderAppearance) => void;
  persistenceMode?: 'persistent' | 'session';
}
type Zoom = PdfZoom;
interface SearchHit { page: number; snippet: string; index: number }
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
                snapshot.hits.push({ page: number, index, snippet: `${from ? '…' : ''}${content.text.slice(from, to)}${to < content.text.length ? '…' : ''}` });
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
const editable = 'input,textarea,select,button,a,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"]';

const Page = memo(function Page({ pdf, number, onReady, zoom, width }: {
  pdf: PDFDocumentProxy; number: number; onReady: (number: number) => void; zoom: Zoom; width: number;
}) {
  const ref = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [empty, setEmpty] = useState(false), [error, setError] = useState('');
  const [ready, setReady] = useState(false), [size, setSize] = useState({ width: 612, height: 792 });
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
    setReady(false); setEmpty(false); setError('');
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
      if (!cancelled) { setReady(true); onReady(number); }
    })().catch(error => {
      if (!cancelled) { setError(error instanceof Error ? error.message : String(error)); onReady(number); }
    });
    return () => {
      cancelled = true; render?.cancel(); layer?.cancel();
      c.width = 0; c.height = 0; t.replaceChildren();
    };
  }, [visible, pdf, number, onReady, zoom, width]);
  return <section ref={ref} data-page={number} className="er-pdf-page" aria-label={`Страница ${number}`} aria-busy={visible && !ready && !error} data-page-ready={visible && (ready || !!error) ? 'true' : undefined}
    style={{ minHeight: size.height * scale, width: size.width * scale }}>
    <canvas ref={canvas} aria-hidden="true" /><div className="textLayer" ref={text} />
    {visible && !ready && !error && <p className="er-pdf-page-message">Загрузка страницы {number}…</p>}
    {empty && <p className="er-pdf-page-message">Нет текстового слоя. OCR не поддерживается.</p>}
    {error && <p className="er-pdf-page-message" role="alert">Страница {number}: {error}</p>}
  </section>;
});

/** A new document always owns a fresh worker, navigation state and restore request. */
export function PdfReader(props: Props) { return <PdfSession key={props.book.documentId} {...props} />; }
function PdfSession({ book, onProgress, onDocumentReady, bookmarks, onBookmarksChange, appearance, onAppearanceChange, persistenceMode = 'session' }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(initialPage(book.progress?.page));
  const [jump, setJump] = useState(String(currentPage)), [jumpError, setJumpError] = useState('');
  const [zoom, setZoom] = useState<Zoom>(appearance?.kind === 'pdf' ? appearance.zoom : 'fit'), [width, setWidth] = useState(Math.max(240, window.innerWidth - 64));
  const [localBookmarks, setLocalBookmarks] = useState<ReaderBookmark[]>([]), [bookmarkLabel, setBookmarkLabel] = useState('');
  const [bookmarkMessage, setBookmarkMessage] = useState(''), [bookmarkError, setBookmarkError] = useState('');
  const [query, setQuery] = useState(''), [queryError, setQueryError] = useState('');
  const savedBookmarks = bookmarks ?? localBookmarks;
  const bookmarksRef = useRef(savedBookmarks); bookmarksRef.current = savedBookmarks;
  const search = usePdfSearch(pdf);
  const host = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null), jumpInput = useRef<HTMLInputElement>(null);
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
  const readingTop = useCallback(() => (toolbar.current?.getBoundingClientRect().height || 0) + 12, []);
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
    lastSaved.current = value; saveRef.current({ ...value, updatedAt: Date.now() });
  }, [showPage]);
  const scrollTo = useCallback((value: Position) => {
    const element = elementFor(value.page);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    window.scrollBy({ top: rect.top - readingTop() + value.offset * rect.height, behavior: 'instant' });
  }, [elementFor, readingTop]);
  const onReady = useCallback((number: number) => {
    const target = pending.current;
    if (!target || target.page !== number) return;
    // A slower page must never pull the reader back after a newer jump or manual scroll.
    scrollTo(target); pending.current = null; persist(target);
  }, [persist, scrollTo]);

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
    })().catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      disposePdfLoading(task, owned);
    });
    return () => { cancelled = true; disposePdfLoading(task, owned); };
  }, [book.documentId, showPage]);

  useEffect(() => {
    if (!pdf) return;
    return readyRef.current?.(document, () => {
      const selection = document.getSelection();
      const selected = selection?.isCollapsed === false ? selection.anchorNode?.parentElement?.closest<HTMLElement>('[data-page]') : null;
      return { kind: 'pdf', title: book.title, url: null, documentId: book.documentId,
        page: selected && host.current?.contains(selected) ? Number(selected.dataset.page) : hoverPage.current || page.current, chapter: null, cfi: null };
    });
  }, [pdf, book.documentId, book.title]);
  useEffect(() => {
    if (pdf && pending.current) scrollTo(pending.current);
  }, [pdf, zoom, width, scrollTo]);
  useEffect(() => {
    const node = host.current!;
    const measure = () => {
      const next = Math.max(1, Math.floor(node.clientWidth || window.innerWidth - 64));
      if (Math.abs(next - widthRef.current) < 2) return;
      if (documentRef.current && zoomRef.current === 'fit' && !pending.current) pending.current = position();
      widthRef.current = next; setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [position]);
  useEffect(() => {
    if (!pdf || !toolbar.current) return;
    // Even a short final page (or an offset near its end) must reach the reading line.
    // Re-measure foldaway panels so the browser never clamps a requested last-page jump.
    const measure = () => host.current?.style.setProperty('--er-pdf-reading-top', `${readingTop()}px`);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(toolbar.current);
    return () => observer.disconnect();
  }, [pdf, readingTop]);
  useEffect(() => {
    if (!pdf || error) return;
    let frame = 0;
    const save = () => { if (!pending.current) { const value = position(); if (value) persist(value); } };
    const schedule = () => { hoverPage.current = null; if (!frame) frame = requestAnimationFrame(() => { frame = 0; save(); }); };
    const interrupt = () => { pending.current = null; };
    const outsidePointer = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) interrupt(); };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('wheel', interrupt, { passive: true });
    window.addEventListener('touchstart', interrupt, { passive: true });
    window.addEventListener('pointerdown', outsidePointer, { passive: true });
    window.addEventListener('pagehide', save);
    return () => {
      cancelAnimationFrame(frame); save(); window.removeEventListener('scroll', schedule);
      window.removeEventListener('wheel', interrupt); window.removeEventListener('touchstart', interrupt); window.removeEventListener('pointerdown', outsidePointer); window.removeEventListener('pagehide', save);
    };
  }, [pdf, error, persist, position]);

  const navigate = (number: number, offset = 0) => {
    if (!pdf || error || number < 1 || number > pdf.numPages) return;
    hoverPage.current = null; jumpDirty.current = false; setJumpError('');
    const target = { page: number, offset: clampOffset(offset) };
    pending.current = target; persist(target); scrollTo(target);
    // Already rendered pages will not emit another ready event just for scrolling.
    if (elementFor(number)?.dataset.pageReady === 'true') pending.current = null;
  };
  const changeZoom = (value: Zoom) => {
    if (value === zoom) return;
    pending.current = pending.current || position(); setZoom(value);
    onAppearanceChange?.({ kind: 'pdf', zoom: value });
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
  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!pdf || error || !host.current?.contains(document.activeElement) || target.closest(editable) || event.defaultPrevented || event.repeat ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229 ||
      (document.getSelection()?.isCollapsed === false) || document.querySelector('[data-english-reader-popup], [role="dialog"][aria-modal="true"]')) return;
    const next = ['PageDown', 'ArrowRight'].includes(event.key) ? page.current + 1 : ['PageUp', 'ArrowLeft'].includes(event.key) ? page.current - 1 :
      event.key === 'Home' ? 1 : event.key === 'End' ? pdf.numPages : null;
    if (next !== null) { event.preventDefault(); navigate(next); }
    else if (['ArrowDown', 'ArrowUp', ' '].includes(event.key)) pending.current = null;
  };
  return <div ref={host} className="er-pdf-reader" tabIndex={0} role="region" aria-label="Чтение PDF" onKeyDown={keyboard}
    onPointerMove={event => {
      const target = (event.target as Element).closest<HTMLElement>('[data-page]');
      hoverPage.current = target ? Number(target.dataset.page) : null;
    }}
    onPointerDown={event => {
      if (!(event.target as Element).closest('.er-pdf-pages') || (event.target as Element).closest(editable)) return;
      pending.current = null; host.current?.focus({ preventScroll: true });
    }}>
    {error ? <p role="alert">Не удалось открыть PDF: {error}</p> : !pdf ? <p role="status">Загрузка PDF…</p> : <>
      <div ref={toolbar} className="er-pdf-toolbar" role="group" aria-label="Навигация по PDF">
        <div className="er-pdf-steps">
          <button type="button" aria-label="Предыдущая страница PDF" title="Предыдущая страница (Page Up / ←)" disabled={currentPage <= 1} onClick={() => navigate(page.current - 1)}>← Назад</button>
          <span className="er-pdf-counter" aria-live="polite" aria-atomic="true">Страница {currentPage} из {pdf.numPages}</span>
          <button type="button" aria-label="Следующая страница PDF" title="Следующая страница (Page Down / →)" disabled={currentPage >= pdf.numPages} onClick={() => navigate(page.current + 1)}>Далее →</button>
        </div>
        <form className="er-pdf-jump" noValidate onSubmit={event => {
          event.preventDefault();
          const number = /^\d+$/.test(jump.trim()) ? Number(jump.trim()) : NaN;
          if (!Number.isSafeInteger(number) || number < 1 || number > pdf.numPages) {
            setJumpError(`Введите целую страницу от 1 до ${pdf.numPages}.`); jumpInput.current?.focus(); return;
          }
          navigate(number);
        }}>
          <label>К странице<input ref={jumpInput} aria-label="Номер страницы PDF" inputMode="numeric" value={jump} aria-invalid={!!jumpError}
            aria-describedby={jumpError ? 'er-pdf-jump-error' : undefined} onChange={event => { jumpDirty.current = true; setJump(event.target.value); setJumpError(''); }} /></label>
          <button type="submit">Перейти</button>
        </form>
        <label className="er-pdf-zoom">Масштаб<select value={zoom} onChange={event => changeZoom(event.target.value as Zoom)}>
          <option value="fit">По ширине</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
        </select></label>
        {jumpError && <p id="er-pdf-jump-error" className="er-pdf-jump-error" role="alert">{jumpError}</p>}
        <div className="er-pdf-tools">
          <details className="er-pdf-panel">
            <summary>Закладки ({savedBookmarks.filter(item => item.kind === 'pdf').length})</summary>
            <p className="er-pdf-tool-note">{persistenceMode === 'session' ? 'Только в этой сессии: закладки и масштаб не сохраняются после закрытия.' : 'Закладки и масштаб сохраняются локально для этой книги.'}</p>
            <form className="er-pdf-bookmark-form" onSubmit={event => { event.preventDefault(); addBookmark(); }}>
              <label>Название закладки<input aria-label="Название закладки PDF" maxLength={READER_BOOKMARK_LABEL_MAX} value={bookmarkLabel}
                placeholder={`Страница ${currentPage}`} onChange={event => { setBookmarkLabel(event.target.value); setBookmarkError(''); setBookmarkMessage(''); }} /></label>
              <button type="submit">Добавить текущее место</button>
            </form>
            {bookmarkError && <p role="alert">{bookmarkError}</p>}
            <p className="er-pdf-tool-note" role="status">{bookmarkMessage}</p>
            <ul className="er-pdf-bookmarks">{savedBookmarks.filter((item): item is Extract<ReaderBookmark, { kind: 'pdf' }> => item.kind === 'pdf').map(item => <li key={item.id}>
              <button type="button" className="er-pdf-bookmark-link" disabled={item.page > pdf.numPages} onClick={() => navigate(item.page, item.offset)}>
                <span>{item.label}</span><small>Страница {item.page}{item.page > pdf.numPages ? ' — недоступна' : ''}</small>
              </button>
              <button type="button" aria-label={`Удалить закладку «${item.label}»`} onClick={() => {
                changeBookmarks(bookmarksRef.current.filter(bookmark => bookmark.id !== item.id)); setBookmarkError(''); setBookmarkMessage('Закладка удалена.');
              }}>Удалить</button>
            </li>)}</ul>
          </details>
          <details className="er-pdf-panel er-pdf-search-panel" onToggle={event => { if (!event.currentTarget.open) search.cancel(); }}>
            <summary>Поиск по книге</summary>
            <p className="er-pdf-tool-note">Локально, только по текстовому слою — без OCR. Результат открывает страницу, не изменяя выделяемый текст.</p>
            <form className="er-pdf-search-form" onSubmit={event => {
              event.preventDefault(); const value = query.trim().replace(/\s+/g, ' ');
              if (value.length < 2) { setQueryError('Введите минимум 2 знака.'); return; }
              if (value.length > 200) { setQueryError('Запрос — не больше 200 знаков.'); return; }
              setQueryError(''); search.submit(value);
            }}>
              <label>Найти в PDF<input type="search" aria-label="Поиск в PDF" value={query} maxLength={200} aria-invalid={!!queryError}
                onChange={event => { setQuery(event.target.value); setQueryError(''); }} /></label>
              <button type="submit" disabled={!!search.state.error}>Найти</button>
              {search.state.phase === 'running' && <button type="button" onClick={search.cancel}>Остановить поиск</button>}
            </form>
            {queryError && <p role="alert">{queryError}</p>}
            {search.state.error && <p role="alert">{search.state.error}</p>}
            {search.state.phase !== 'idle' && <div className="er-pdf-search-status" role="status" aria-live="polite">
              <p>{search.state.error ? 'Поиск прерван.' : search.state.phase === 'running' ? 'Поиск…' : search.state.phase === 'cancelled' ? 'Поиск остановлен.' : 'Поиск завершён.'} «{search.state.query}» · Совпадений: {search.state.hits.length}{search.state.limit && search.state.hits.length >= SEARCH_RESULT_LIMIT ? ' (лимит)' : ''} · Проверено страниц: {search.state.scanned} из {pdf.numPages}.</p>
              {search.state.limit && <p>{search.state.limit}</p>}
              {search.state.truncated > 0 && <p>На {search.state.truncated} стр. проверена только часть текста (лимит 250 000 знаков или 25 000 фрагментов на страницу).</p>}
              {search.state.unreadable > 0 && <p>Не удалось прочитать {search.state.unreadable} стр. Попробуйте открыть исходный PDF заново.</p>}
              {search.state.empty > 0 && <p>Без извлекаемого текста: {search.state.empty} стр. OCR не поддерживается.</p>}
            </div>}
            <ol className="er-pdf-search-results">{search.state.hits.map(hit => <li key={`${hit.page}:${hit.index}`}>
              <button type="button" onClick={() => navigate(hit.page)}><strong>Страница {hit.page}</strong><span>{hit.snippet}</span></button>
            </li>)}</ol>
          </details>
        </div>
      </div>
      <p className="er-pdf-help">Нажмите на страницу, чтобы листать клавишами ← / → или Page Up / Page Down. Текст можно выделять как обычно.</p>
      <details className="er-pdf-note"><summary>О тексте и безопасности PDF</summary><p>Если текст извлечён неточно, выделите выражение вручную и исправьте его перед сохранением. JavaScript и внешние действия PDF не выполняются.</p></details>
      <div className="er-pdf-pages">{Array.from({ length: pdf.numPages }, (_, i) => <Page key={i} pdf={pdf} number={i + 1} onReady={onReady} zoom={zoom} width={zoom === 'fit' ? width : 0} />)}</div>
    </>}
  </div>;
}
