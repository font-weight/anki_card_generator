import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createLocalPdfWorker, disposePdfLoading } from './pdf-worker';
import type { DocumentReady, ReadingProgress, StoredBook } from './types';
import './pdf-reader.css';

interface Props { book: StoredBook; onProgress: (progress: ReadingProgress) => void; onDocumentReady?: DocumentReady }
type Zoom = 'fit' | '0.75' | '1' | '1.25' | '1.5';
interface Position { page: number; offset: number }
const clampOffset = (value: number | undefined) => Number.isFinite(value) ? Math.min(1, Math.max(0, value!)) : 0;
const initialPage = (value: number | undefined) => Number.isSafeInteger(value) && value! > 0 ? value! : 1;
const editable = 'input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"]';

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
function PdfSession({ book, onProgress, onDocumentReady }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState('');
  const [currentPage, setCurrentPage] = useState(initialPage(book.progress?.page));
  const [jump, setJump] = useState(String(currentPage)), [jumpError, setJumpError] = useState('');
  const [zoom, setZoom] = useState<Zoom>('fit'), [width, setWidth] = useState(Math.max(240, window.innerWidth - 64));
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

  const navigate = (number: number) => {
    if (!pdf || error || number < 1 || number > pdf.numPages) return;
    hoverPage.current = null; jumpDirty.current = false; setJumpError('');
    const target = { page: number, offset: 0 };
    pending.current = target; persist(target); scrollTo(target);
    // Already rendered pages will not emit another ready event just for scrolling.
    if (elementFor(number)?.dataset.pageReady === 'true') pending.current = null;
  };
  const changeZoom = (value: Zoom) => {
    if (value === zoom) return;
    pending.current = pending.current || position(); setZoom(value);
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
      </div>
      <p className="er-pdf-help">Нажмите на страницу, чтобы листать клавишами ← / → или Page Up / Page Down. Текст можно выделять как обычно.</p>
      <details className="er-pdf-note"><summary>О тексте и безопасности PDF</summary><p>Если текст извлечён неточно, выделите выражение вручную и исправьте его перед сохранением. JavaScript и внешние действия PDF не выполняются.</p></details>
      <div className="er-pdf-pages">{Array.from({ length: pdf.numPages }, (_, i) => <Page key={i} pdf={pdf} number={i + 1} onReady={onReady} zoom={zoom} width={zoom === 'fit' ? width : 0} />)}</div>
    </>}
  </div>;
}
