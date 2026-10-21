import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {PdfReader} from './PdfReader';
import {EpubReader} from './EpubReader';
import {ZIP_LIMITS} from './archive';
import {FB2_MAX_BYTES} from './fb2';
import type {DocumentReady, LibraryBook, LibraryStorage, ReadingProgress, StoredBook} from './types';
import './readers.css';
import './library.css';

interface Props {storage:LibraryStorage; onDocumentReady?:DocumentReady}
export async function fingerprint(blob:Blob):Promise<string> {
 const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
 return 'sha256:' + Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
const message = (error:unknown) => error instanceof Error ? error.message : String(error);
const readingPlace = (book:LibraryBook) => book.progress?.page ? `Страница ${book.progress.page}`
 : book.progress?.chapter ? `Раздел: ${book.progress.chapter}` : book.progress?.cfi ? 'Сохранённое место' : 'Ещё не читали';
const fileSize = (size:number) => size < 1024 * 1024 ? `${Math.max(1, Math.ceil(size / 1024))} КБ` : `${(size / 1024 / 1024).toFixed(1)} МиБ`;

export function ReaderLibrary({storage, onDocumentReady}:Props) {
 const [books, setBooks] = useState<LibraryBook[]>([]), [active, setActive] = useState<StoredBook>();
 const [pending, setPending] = useState<StoredBook>(), [status, setStatus] = useState(''), [error, setError] = useState('');
 const [busy, setBusy] = useState(false), [listing, setListing] = useState(true), [session, setSession] = useState(false);
 const [dragging, setDragging] = useState(false), [removing, setRemoving] = useState<string>();
 const fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true), requestId = useRef(0), listRequest = useRef(0);
 const saveTimer = useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 // Keep each book's final unmount update: switching books must not overwrite another book's pending save.
 const pendingProgress = useRef(new Map<string, ReadingProgress>()), latestProgress = useRef(new Map<string, ReadingProgress>());
 const saves = useRef<Promise<void>>(Promise.resolve());
 const deleting = useRef<string|undefined>(undefined);
 const withProgress = useCallback(<T extends LibraryBook>(book:T):T => {
  const progress = latestProgress.current.get(book.documentId);
  return progress && progress.updatedAt >= (book.progress?.updatedAt ?? 0) ? {...book, progress} : book;
 }, []);
 const refresh = useCallback(async () => {
  const request = ++listRequest.current;
  try {
   const list = await storage.listBooks();
   if (mounted.current && request === listRequest.current) setBooks(list.map(withProgress));
  } catch (failure) {
   if (mounted.current && request === listRequest.current) setError(`Не удалось обновить библиотеку: ${message(failure)}`);
  } finally { if (mounted.current && request === listRequest.current) setListing(false); }
 }, [storage, withProgress]);
 const flush = useCallback(():Promise<void> => {
  clearTimeout(saveTimer.current);
  const entries = [...pendingProgress.current];
  pendingProgress.current.clear();
  if (entries.length) saves.current = saves.current.then(async () => {
   for (const [id, progress] of entries) {
    try { await storage.saveProgress(id, progress); }
    catch (failure) { if (mounted.current) setError(`Не удалось сохранить позицию: ${message(failure)}`); }
   }
  });
  return saves.current;
 }, [storage]);
 useEffect(() => {
  mounted.current = true;
  void refresh();
  const save = () => { void flush(); };
  window.addEventListener('pagehide', save);
  return () => { mounted.current = false; requestId.current++; listRequest.current++; void flush(); window.removeEventListener('pagehide', save); };
 }, [refresh, flush]);
 const progress = useCallback((value:ReadingProgress) => {
  if (!active || session) return;
  latestProgress.current.set(active.documentId, value);
  pendingProgress.current.set(active.documentId, value);
  clearTimeout(saveTimer.current);
  if (!mounted.current) { void flush(); return; }
  saveTimer.current = setTimeout(() => { void flush(); }, 400);
 }, [active, session, flush]);
 const isCurrent = (request:number) => mounted.current && request === requestId.current;
 function beginOpen() {
  const request = ++requestId.current;
  setBusy(true); setStatus(''); setError(''); setPending(undefined);
  return request;
 }
 function activate(book:StoredBook, sessionOnly=false) {
  // A previous reader can deliver its final position during unmount; the per-book queue above preserves it.
  void flush();
  setSession(sessionOnly); setActive(withProgress(book));
 }
 async function openBook(id:string) {
  if (deleting.current === id) return;
  const request = beginOpen();
  try {
   await flush();
   if (!isCurrent(request)) return;
   const book = await storage.getBook(id);
   if (!isCurrent(request)) return;
   if (!book) throw new Error('Книга не найдена. Попробуйте открыть исходный файл снова.');
   activate(book);
  } catch (failure) { if (isCurrent(request)) setError(message(failure)); }
  finally { if (isCurrent(request)) setBusy(false); }
 }
 async function importFile(file:File) {
  const request = beginOpen();
  try {
   const kind = /\.pdf$/i.test(file.name) ? 'pdf' : /\.epub$/i.test(file.name) ? 'epub' : /\.fb2$/i.test(file.name) ? 'fb2' : null;
   if (!kind) throw new Error('Выберите PDF, EPUB без DRM или обычный FB2. Архивы .fb2.zip не поддерживаются.');
   if (!file.size) throw new Error('Файл пуст. Выберите другую книгу.');
   if (kind === 'fb2' && file.size > FB2_MAX_BYTES) throw new Error('Максимальный размер FB2 — 16 МиБ.');
   if (file.size > ZIP_LIMITS.archive) throw new Error('Максимальный размер PDF или EPUB — 100 МиБ.');
   if (kind === 'pdf') {
    const signature = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
    if (!signature.includes('%PDF-')) throw new Error('Файл не содержит заголовок PDF.');
   }
   if (!isCurrent(request)) return;
   const documentId = await fingerprint(file);
   if (!isCurrent(request)) return;
   // A duplicate import must not reopen a record that an earlier deletion is
   // about to remove. The original file can be explicitly imported again after it finishes.
   if (deleting.current === documentId) throw new Error('Эта книга сейчас удаляется. Дождитесь завершения и откройте файл снова.');
   const book:StoredBook = {documentId, title:file.name, kind, size:file.size, addedAt:Date.now(), blob:file};
   await flush();
   if (!isCurrent(request)) return;
   const existing = await storage.getBook(documentId);
   if (!isCurrent(request)) return;
   if (deleting.current === documentId) throw new Error('Эта книга сейчас удаляется. Дождитесь завершения и откройте файл снова.');
   if (existing) { activate(existing); setStatus('Открыто сохранённое место. Повторная копия не создана.'); return; }
   const quota = await navigator.storage?.estimate?.();
   if (!isCurrent(request)) return;
   if (quota?.quota !== undefined && (quota.usage || 0) + file.size * 1.15 > quota.quota) {
    setPending(book); setStatus('Недостаточно места для сохранения книги.'); return;
   }
   try { await storage.putBook(book); }
   catch (failure) {
    if (isCurrent(request)) { setPending(book); setStatus(`Книга не сохранена: ${message(failure)}`); }
    return;
   }
   if (!isCurrent(request)) return;
   activate(book); setStatus('Книга сохранена локально в этом браузере.');
   void refresh();
  } catch (failure) { if (isCurrent(request)) setError(message(failure)); }
  finally { if (isCurrent(request)) setBusy(false); }
 }
 function cancelOpen() {
  requestId.current++; setPending(undefined); setBusy(false); setStatus(''); setError('');
 }
 function backToLibrary() {
  cancelOpen(); void flush(); setActive(undefined); setSession(false); void refresh();
 }
 async function deleteBook(book:LibraryBook) {
  if (deleting.current || !window.confirm(`Удалить «${book.title}» и позицию чтения? Очередь Anki останется.`)) return;
  deleting.current = book.documentId; setRemoving(book.documentId);
  const request = requestId.current;
  try {
   await flush(); await storage.deleteBook(book.documentId);
   latestProgress.current.delete(book.documentId); pendingProgress.current.delete(book.documentId);
   await refresh();
   if (isCurrent(request)) setStatus('Книга и её позиция удалены. Очередь Anki не изменена.');
  } catch (failure) { if (isCurrent(request)) setError(`Не удалось удалить книгу: ${message(failure)}`); }
  finally { deleting.current = undefined; if (mounted.current) setRemoving(undefined); }
 }
 const ordered = useMemo(() => [...books].sort((a, b) => (b.progress?.updatedAt ?? b.addedAt) - (a.progress?.updatedAt ?? a.addedAt)), [books]);
 const recent = ordered.find(book => book.progress);
 const hasFiles = (event:React.DragEvent) => Array.from(event.dataTransfer.types || []).includes('Files');
 return <main className={`er-reader er-library${dragging ? ' er-library-dragging' : ''}`}
  onDragOver={event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
  onDragEnter={event => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } }}
  onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
  onDrop={event => {
   if (!event.dataTransfer.files.length) return;
   event.preventDefault(); setDragging(false);
   if (event.dataTransfer.files.length !== 1) { cancelOpen(); setError('Откройте одну книгу за раз: выберите один PDF, EPUB или FB2.'); return; }
   void importFile(event.dataTransfer.files[0]!);
  }}>
  <header className="er-library-heading">
   <div><p className="er-library-eyebrow">ЧИТАТЬ И ЗАПОМИНАТЬ</p><h1>Language Reader — локальная библиотека</h1></div>
   <button type="button" className="er-library-primary" onClick={() => fileInput.current?.click()}>{active ? 'Открыть другую книгу' : 'Открыть книгу'}</button>
   <input ref={fileInput} className="er-library-file-input" type="file" aria-label="Открыть PDF, EPUB или FB2" tabIndex={-1}
    accept=".pdf,.epub,.fb2,application/pdf,application/epub+zip,application/x-fictionbook+xml"
    onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }}/>
  </header>
  {busy && <div className="er-library-notice"><p role="status">Открываем книгу… Можно выбрать другую, не дожидаясь завершения.</p><button type="button" onClick={cancelOpen}>Отменить открытие</button></div>}
  {status && <p className="er-library-status" role="status">{status}</p>}
  {error && <p role="alert">{error}</p>}
  {pending && <section className="er-library-session-choice" aria-label="Открыть без сохранения">
   <p><strong>{pending.title}</strong></p><p>Можно читать только в этой вкладке. Книга и новое место чтения не сохранятся.</p>
   <button type="button" className="er-library-primary" onClick={() => { const book = pending; cancelOpen(); activate(book, true); }}>Открыть только на текущую сессию</button>
   <button type="button" onClick={cancelOpen}>Отмена</button>
  </section>}
  {active ? <>
   <div className="er-library-book-heading"><button type="button" onClick={backToLibrary}>← Библиотека</button><div><p className="er-library-eyebrow">{active.kind.toUpperCase()} · {fileSize(active.size)}</p><h2>{active.title}</h2></div></div>
   {session && <aside className="er-library-session-warning" role="note"><strong>Только эта сессия.</strong> Книга и место чтения не сохраняются. После закрытия вкладки откройте исходный файл снова.</aside>}
   {active.kind === 'pdf' ? <PdfReader key={active.documentId} book={active} onProgress={progress} onDocumentReady={onDocumentReady}/>
    : <EpubReader key={active.documentId} book={active} onProgress={progress} onDocumentReady={onDocumentReady}/>}
  </> : <>
   <section className="er-library-dropzone" aria-label="Импорт локальной книги"><strong>{dragging ? 'Отпустите файл, чтобы открыть книгу' : 'Перетащите книгу сюда или нажмите «Открыть книгу»'}</strong><p>PDF / EPUB без DRM — до 100 МиБ · FB2 — до 16 МиБ</p><p className="er-library-privacy">Файлы хранятся только в этом браузере и не отправляются в облако. Сохраните оригиналы отдельно.</p></section>
   {listing ? <p role="status">Загрузка библиотеки…</p> : !ordered.length ? <section className="er-library-empty"><h2>Здесь будут ваши книги</h2><p>Откройте первую книгу — в следующий раз сможете продолжить с сохранённого места.</p><p>PDF нужен текстовый слой. Для EPUB и FB2 сохраняется место в тексте, а не постоянный номер страницы.</p></section> : <>
    {recent && <section className="er-library-recent" aria-label="Продолжить чтение"><div><p className="er-library-eyebrow">ПРОДОЛЖИТЬ ЧТЕНИЕ</p><h2>{recent.title}</h2><p>{readingPlace(recent)}</p></div><button type="button" className="er-library-primary" disabled={removing === recent.documentId} onClick={() => void openBook(recent.documentId)}>Продолжить чтение</button></section>}
    <h2 className="er-library-list-title">Ваши книги <span>{ordered.length}</span></h2>
    <ul className="er-library-list">{ordered.map(book => <li key={book.documentId} className="er-library-book">
     <div className="er-library-book-info"><span className="er-library-format">{book.kind.toUpperCase()}</span><div><h3><button type="button" disabled={removing === book.documentId} onClick={() => void openBook(book.documentId)}>{book.title}</button></h3><p>{fileSize(book.size)} · {readingPlace(book)}</p></div></div>
     <button type="button" className="er-library-delete" aria-label={`Удалить ${book.title}`} disabled={busy || !!removing} onClick={() => void deleteBook(book)}>{removing === book.documentId ? 'Удаляем…' : 'Удалить'}</button>
    </li>)}</ul>
   </>}
  </>}
  {dragging && active && <div className="er-library-drop-hint" aria-hidden="true">Отпустите файл, чтобы открыть другую книгу</div>}
 </main>;
}
