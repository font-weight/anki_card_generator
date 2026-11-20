import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {isBookThumbnail} from '@english-reader/storage';
import {PdfReader} from './PdfReader';
import {EpubReader} from './EpubReader';
import {ZIP_LIMITS} from './archive';
import {FB2_MAX_BYTES} from './fb2';
import {validateReaderSavedState, type DocumentReady, type LibraryBook, type LibraryStorage, type ReadingProgress, type StoredBook, type ReaderSavedState, type ReaderBookmark, type ReaderAppearance, type ReaderQuote, type ReaderBookInfo} from './types';
import {chapterTitle, displayBookPercent, displayBookTitle} from './book-presentation';
import './readers.css';
import './library.css';

type BookInfo = Pick<LibraryBook, 'title' | 'author'>;
interface Props {storage:LibraryStorage; onDocumentReady?:DocumentReady}
export async function fingerprint(blob:Blob):Promise<string> {
 const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
 return 'sha256:' + Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}
const message = (error:unknown) => error instanceof Error ? error.message : String(error);
function readingPlace(book:LibraryBook) {
 if (book.kind === 'pdf' && book.progress?.page) return `Страница ${book.progress.page}`;
 const title=chapterTitle(book.progress?.chapter || '');
 if (book.progress?.chapterNumber) return `Глава ${book.progress.chapterNumber}${title ? ' · '+title : ''}`;
 return title || (book.progress?.cfi ? 'Сохранённое место' : 'Ещё не читали');
}
function LibraryIcon({name}:{name:'book'|'device'|'import'}) {
 const paths={book:'M3 4c3-1 6-.4 9 1 3-1.4 6-2 9-1v14c-3-1-6-.4-9 1-3-1.4-6-2-9-1V4zm9 1v14',device:'M3 3h18v13H3zM12 16v4m-5 0h10',import:'M4 2h10l5 5v5m-5-10v5h5M4 2v20h7m6-1v-8m-4 4 4-4 4 4'};
 return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d={paths[name]}/></svg>;
}
function BookCover({book,storage,eager=false}:{book:LibraryBook;storage:LibraryStorage;eager?:boolean}) {
 const host=useRef<HTMLDivElement>(null);
 const [thumbnail,setThumbnail]=useState<{id:string;source:string}>();
 useEffect(()=>{
  if(book.kind==='pdf' || !storage.loadBookThumbnail || !host.current)return;
  let controller:AbortController|undefined;
  function load(){
   if(controller)return;
   const request=new AbortController();
   controller=request;
   void storage.loadBookThumbnail!(book.documentId,request.signal).then(source=>{
    if(isBookThumbnail(source) && !request.signal.aborted)setThumbnail({id:book.documentId,source});
   }).catch(()=>{});
  }
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
   if(entries.some(entry=>entry.isIntersecting)){load();}
   else{controller?.abort();controller=undefined;}
  }):undefined;
  if(observer)observer.observe(host.current);
  else if(eager)load();
  return ()=>{controller?.abort();observer?.disconnect();};
 },[book.documentId,book.kind,eager,storage]);
 const source=thumbnail?.id===book.documentId?thumbnail.source:undefined;
 return <div ref={host} aria-hidden="true" className={`er-lib-cover cover-${book.kind}${source?' embedded-cover':''}`}>{source?
  <img src={source} alt="" onError={()=>setThumbnail(undefined)}/>:
  <><span>{displayBookTitle(book.title)}</span>
  <svg viewBox="0 0 130 108" preserveAspectRatio="none"><g fill="none" stroke="currentColor" strokeWidth="1">{Array.from({length:13},(_,i)=><path key={i} d={book.kind==='epub'?`M-10 ${24+4*i} Q32 ${43+4*i} 64 ${21+4*i} T145 ${3+4*i}`:book.kind==='fb2'?`M${13+7*i} 103 Q${8+5*i} 62 ${35+7*i} ${20+2*(i%4)}`:`M${3+6*i} 102 V68 Q${16+6*i} ${34-i} ${34+6*i} 68 V102`}/>)}</g></svg>
  {book.author&&<small>{book.author}</small>}</>}</div>;
}

export function ReaderLibrary({storage, onDocumentReady}:Props) {
 const [books, setBooks] = useState<LibraryBook[]>([]), [active, setActive] = useState<StoredBook>();
 const [pending, setPending] = useState<StoredBook>(), [status, setStatus] = useState(''), [error, setError] = useState('');
 const [busy, setBusy] = useState(false), [listing, setListing] = useState(true), [session, setSession] = useState(false);
 const [dragging, setDragging] = useState(false), [removing, setRemoving] = useState<string>();
 const [readerState, setReaderState] = useState<ReaderSavedState>({version:1,bookmarks:[]});
 const bookInfoRef=useRef<{shown: BookInfo; saved: BookInfo} | undefined>(undefined);
 const [readerToken, setReaderToken] = useState(0), [readerStateError, setReaderStateError] = useState('');
 const stateRef = useRef<ReaderSavedState>(readerState), stateToken = useRef(0);
 const readerOwner = useRef<{documentId:string;token:number;kind:StoredBook['kind'];writable:boolean}|undefined>(undefined);
 const readerSaves = useRef<Promise<void>>(Promise.resolve());
 // Retain failed writes in this tab so retry/reopening does not silently discard the user's changes.
 const unsavedReaderStates = useRef(new Map<string,ReaderSavedState>());
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
  return Promise.all([saves.current,readerSaves.current]).then(() => {});
 }, [storage]);
 useEffect(() => {
  mounted.current = true;
  void refresh();
  const save = () => { void flush(); };
  window.addEventListener('pagehide', save);
  return () => { mounted.current = false; readerOwner.current=undefined; stateToken.current++; requestId.current++; listRequest.current++; void flush(); window.removeEventListener('pagehide', save); };
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
 async function activate(book:StoredBook, request:number, sessionOnly=false) {
  const localAtStart=stateRef.current, ownerAtStart=readerOwner.current?.token;
  let saved:ReaderSavedState={version:1,bookmarks:[]}, failure='';
  let writable=!sessionOnly&&!!storage.getReaderState&&!!storage.saveReaderState;
  if(!sessionOnly&&storage.getReaderState){
   try { const value=await storage.getReaderState(book.documentId); if(value)saved=validateReaderSavedState(value,book.kind); }
   catch(error){writable=false;failure=`Не удалось загрузить закладки и оформление: ${message(error)} Изменения доступны только в этой вкладке; сохранённые данные не перезаписываются.`;}
  }
  if(!isCurrent(request))return;
  // The old reader stays usable during hydration. A newer local edit wins even if
  // its write already succeeded and disappeared from the failed/pending-save map.
  if(!sessionOnly&&readerOwner.current?.documentId===book.documentId&&readerOwner.current.token===ownerAtStart&&stateRef.current!==localAtStart)saved=stateRef.current;
  const unsaved=!sessionOnly&&unsavedReaderStates.current.get(book.documentId);
  if(unsaved){saved=unsaved;if(writable)failure='Изменения закладок и оформления пока не сохранены. Можно повторить сохранение.';}
  // A previous reader can deliver its final progress during unmount; that per-book queue remains independent.
  void flush();
  const token=++stateToken.current;
  readerOwner.current={documentId:book.documentId,token,kind:book.kind,writable};
  const info={title:book.title,author:book.author};
  bookInfoRef.current={shown:info,saved:info};
  stateRef.current=saved;setReaderState(saved);setReaderToken(token);setReaderStateError(failure);
  setSession(sessionOnly); setActive(withProgress(book));
 }
 function saveReaderState(documentId:string,token:number,next:ReaderSavedState){
  const owner=readerOwner.current;
  if(!owner||owner.documentId!==documentId||owner.token!==token||!owner.writable||!storage.saveReaderState)return;
  unsavedReaderStates.current.set(documentId,next);
  readerSaves.current=readerSaves.current.then(async()=>{
   try{
    await storage.saveReaderState!(documentId,next);
    if(unsavedReaderStates.current.get(documentId)===next)unsavedReaderStates.current.delete(documentId);
    if(mounted.current&&readerOwner.current?.token===token&&!unsavedReaderStates.current.has(documentId))setReaderStateError('');
   }catch(error){if(mounted.current&&readerOwner.current?.token===token)setReaderStateError(`Не удалось сохранить закладки и оформление: ${message(error)} Изменения пока доступны только в этой вкладке.`);}
  });
 }
 function updateBookInfo(id:string,token:number,info:ReaderBookInfo) {
  if(!mounted.current || readerOwner.current?.token!==token || !bookInfoRef.current) return;
  const record=bookInfoRef.current;
  const previous=record.shown;
  const next={title:info.title?.trim().slice(0,500)||previous.title,author:info.author?.trim().slice(0,500)||previous.author};
  if(next.title!==previous.title || next.author!==previous.author){
   record.shown=next;
   setActive(book=>book?.documentId===id?{...book,...next}:book);
   if(!session)setBooks(list=>list.map(book=>book.documentId===id?{...book,...next}:book));
  }
  if(session || !storage.updateBookInfo)return;
  readerSaves.current=readerSaves.current.then(async()=>{
   // Diff against the last successful write, including earlier queued reports.
   // Omitting a missing author also preserves metadata written by another tab.
   const patch:ReaderBookInfo={};
   if(next.title!==record.saved.title)patch.title=next.title;
   if(next.author && next.author!==record.saved.author)patch.author=next.author;
   if(!Object.keys(patch).length)return;
   try {
    await storage.updateBookInfo!(id,patch);
    record.saved=next;
    if(mounted.current&&readerOwner.current?.token===token)setError(current=>current.startsWith('Не удалось сохранить сведения о книге:')?'':current);
   } catch(failure){if(mounted.current&&readerOwner.current?.token===token)setError(`Не удалось сохранить сведения о книге: ${message(failure)}`);}
  });
 }
 function changeReaderState(documentId:string,token:number,patch:{bookmarks?:ReaderBookmark[];appearance?:ReaderAppearance;quotes?:ReaderQuote[]}){
  const owner=readerOwner.current;
  if(!mounted.current||!owner||owner.documentId!==documentId||owner.token!==token)return;
  try{
   const next=validateReaderSavedState({...stateRef.current,...patch},owner.kind);
   stateRef.current=next;setReaderState(next);saveReaderState(documentId,token,next);
  }catch(error){setReaderStateError(`Не удалось изменить закладки или оформление: ${message(error)}`);}
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
   await activate(book,request);
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
   if (existing) {
    // Reimporting the book already being read is a no-op, as in 0.4: keep its
    // renderer, live position, search draft and unsaved/error state intact.
    // A session-only reader must still be able to transition to a saved book.
    if(active?.documentId!==existing.documentId||session)await activate(existing,request);
    if(isCurrent(request))setStatus('Открыто сохранённое место. Повторная копия не создана.');return;
   }
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
   await activate(book,request); if(!isCurrent(request))return; setStatus('Книга сохранена локально в этом браузере.');
   void refresh();
  } catch (failure) { if (isCurrent(request)) setError(message(failure)); }
  finally { if (isCurrent(request)) setBusy(false); }
 }
 function cancelOpen() {
  requestId.current++; setPending(undefined); setBusy(false); setStatus(''); setError('');
 }
 function backToLibrary() {
  cancelOpen(); readerOwner.current=undefined;stateToken.current++;setReaderStateError('');void flush(); setActive(undefined); setSession(false); void refresh();
 }
 async function deleteBook(book:LibraryBook) {
  if (deleting.current || !window.confirm(`Удалить «${displayBookTitle(book.title)}», позицию чтения, цитаты, закладки и оформление? База слов сохранится.`)) return;
  deleting.current = book.documentId; setRemoving(book.documentId);
  const request = requestId.current;
  try {
   await flush(); await storage.deleteBook(book.documentId);
   latestProgress.current.delete(book.documentId); pendingProgress.current.delete(book.documentId); unsavedReaderStates.current.delete(book.documentId);
   await refresh();
   if (isCurrent(request)) setStatus('Книга, её позиция, цитаты, закладки и оформление удалены. База слов сохранена.');
  } catch (failure) { if (isCurrent(request)) setError(`Не удалось удалить книгу: ${message(failure)}`); }
  finally { deleting.current = undefined; if (mounted.current) setRemoving(undefined); }
 }
 const ordered = useMemo(() => [...books].sort((a, b) => (b.progress?.updatedAt ?? b.addedAt) - (a.progress?.updatedAt ?? a.addedAt)), [books]);
 const recent = ordered.find(book => book.progress);
 const hasFiles = (event:React.DragEvent) => Array.from(event.dataTransfer.types || []).includes('Files');
 return <main className={`er-reader er-library${active ? ' er-library-reading' : ''}${dragging ? ' er-library-dragging' : ''}`}
  onDragOver={event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
  onDragEnter={event => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } }}
  onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
  onDrop={event => {
   if (!event.dataTransfer.files.length) return;
   event.preventDefault(); setDragging(false);
   if (event.dataTransfer.files.length !== 1) { cancelOpen(); setError('Откройте одну книгу за раз: выберите один PDF, EPUB или FB2.'); return; }
   void importFile(event.dataTransfer.files[0]!);
  }}>
  {!active&&<div className="er-library-brand"><strong>Language Reader for Anki</strong><span><LibraryIcon name="device"/>На этом устройстве</span></div>}
  <header className={active?'er-library-reader-shortcuts':'er-library-heading'}>
   {!active&&<h1>Библиотека</h1>}
   <button type="button" data-reader-page-opener className="er-library-opener" onClick={() => fileInput.current?.click()}>{active ? 'Открыть другую книгу' : 'Открыть книгу'}</button>
   <input ref={fileInput} className="er-library-file-input" type="file" aria-label="Открыть PDF, EPUB или FB2" tabIndex={-1}
    accept=".pdf,.epub,.fb2,application/pdf,application/epub+zip,application/x-fictionbook+xml"
    onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }}/>
  </header>
  {busy && <div className="er-library-notice"><p role="status">Открываем книгу… Можно выбрать другую, не дожидаясь завершения.</p><button type="button" onClick={cancelOpen}>Отменить открытие</button></div>}
  {status && (!active || busy || pending) && <p className="er-library-status" role="status">{status}</p>}
  {error && <p role="alert">{error}</p>}
  {pending && <section className="er-library-session-choice" aria-label="Открыть без сохранения">
   <p><strong>{displayBookTitle(pending.title)}</strong></p><p>Можно читать только в этой вкладке. Книга, новое место чтения, закладки и оформление не сохранятся.</p>
   <button type="button" className="er-library-primary" onClick={() => { const book = pending; cancelOpen(); void activate(book,requestId.current,true); }}>Открыть только на текущую сессию</button>
   <button type="button" onClick={cancelOpen}>Отмена</button>
  </section>}
  {active ? <>
   {session && <aside className="er-library-session-warning" role="note"><strong>Только эта сессия.</strong> Книга, место чтения, закладки и оформление не сохраняются. После закрытия вкладки откройте исходный файл снова.</aside>}
   {readerStateError&&<div role="alert"><p>{readerStateError}</p>{readerOwner.current?.writable&&unsavedReaderStates.current.has(active.documentId)&&<button type="button" onClick={()=>saveReaderState(active.documentId,readerToken,stateRef.current)}>Повторить сохранение закладок и оформления</button>}</div>}
   {active.kind === 'pdf' ? <PdfReader key={`${active.documentId}:${readerToken}`} book={active} onBack={backToLibrary} onBookInfo={info=>updateBookInfo(active.documentId,readerToken,info)} quotes={readerState.quotes} onQuotesChange={quotes=>changeReaderState(active.documentId,readerToken,{quotes})} onProgress={progress} onDocumentReady={onDocumentReady}
    bookmarks={readerState.bookmarks} appearance={readerState.appearance} onBookmarksChange={bookmarks=>changeReaderState(active.documentId,readerToken,{bookmarks})} onAppearanceChange={appearance=>changeReaderState(active.documentId,readerToken,{appearance})} persistenceMode={readerOwner.current?.writable?'persistent':'session'}/>
    : <EpubReader key={`${active.documentId}:${readerToken}`} book={active} onBack={backToLibrary} onBookInfo={info=>updateBookInfo(active.documentId,readerToken,info)} quotes={readerState.quotes} onQuotesChange={quotes=>changeReaderState(active.documentId,readerToken,{quotes})} onProgress={progress} onDocumentReady={onDocumentReady}
    bookmarks={readerState.bookmarks} appearance={readerState.appearance} onBookmarksChange={bookmarks=>changeReaderState(active.documentId,readerToken,{bookmarks})} onAppearanceChange={appearance=>changeReaderState(active.documentId,readerToken,{appearance})} persistenceMode={readerOwner.current?.writable?'persistent':'session'}/>}
  </> : <>
   {listing ? <p role="status">Загрузка библиотеки…</p> : !ordered.length ? <section className="er-library-empty"><h2>Здесь будут ваши книги</h2><p>Откройте первую книгу, чтобы начать чтение.</p></section> : <>
    {recent && <section className="er-library-recent" aria-label="Продолжить чтение">
      <div className="er-library-coverstage"><BookCover book={recent} storage={storage} eager/></div>
      <div className="er-library-recent-body"><strong className="er-library-caption"><LibraryIcon name="book"/>Последняя открытая книга</strong>
       <h2>{displayBookTitle(recent.title)}</h2><p>{[recent.author,recent.kind.toUpperCase()].filter(Boolean).join(' · ')}</p>
       <div className="er-library-continue"><div><strong>{readingPlace(recent)}</strong>
        {recent.progress?.percent!==undefined&&<div className="er-library-progress"><progress max={100} value={recent.progress.percent}/>Прочитано {recent.kind==='pdf'?Math.round(recent.progress.percent):displayBookPercent(recent.progress.percent)}%</div>}</div>
        <button type="button" className="er-library-primary" disabled={removing===recent.documentId} onClick={()=>void openBook(recent.documentId)}>Продолжить чтение</button></div>
      </div>
    </section>}
    <h2 className="er-library-list-title">Ваши книги <span>{ordered.length}</span></h2>
    <ul className="er-library-list">{ordered.map((book,index)=><li key={book.documentId} className="er-library-book">
      <BookCover book={book} storage={storage} eager={index<4}/><div className="er-library-book-info"><h3><button type="button" title={displayBookTitle(book.title)} disabled={removing===book.documentId} onClick={()=>void openBook(book.documentId)}>{displayBookTitle(book.title)}</button></h3>
       {book.author&&<p>{book.author}</p>}
       <div className="er-library-meta"><span className="er-library-format">{book.kind.toUpperCase()}</span>
        <span>{book.kind!=='pdf'&&book.progress?.percent!==undefined?`Прочитано ${displayBookPercent(book.progress.percent)}%`:readingPlace(book)}</span></div></div>
      <details className="er-library-actions"><summary aria-label={`Действия с книгой «${displayBookTitle(book.title)}»`}>⋯</summary>
        <button type="button" aria-label={`Удалить ${displayBookTitle(book.title)}`} disabled={busy||!!removing} onClick={()=>void deleteBook(book)}>{removing===book.documentId?'Удаляем…':'Удалить'}</button></details>
    </li>)}</ul>
   </>}
   <section className="er-library-dropzone" aria-label="Импорт локальной книги"><span aria-hidden="true" className="er-library-upload"><LibraryIcon name="import"/></span><div><strong>{dragging?'Отпустите файл, чтобы открыть книгу':'Перетащите книгу сюда'}</strong>
    <p>PDF и EPUB без DRM — до 100 МиБ, FB2 — до 16 МиБ</p></div>
    <p className="er-library-privacy">Файлы и место чтения сохраняются в этом браузере и не отправляются в облако.</p></section>
  </>}
  {dragging && active && <div className="er-library-drop-hint" aria-hidden="true">Отпустите файл, чтобы открыть другую книгу</div>}
 </main>;
}
