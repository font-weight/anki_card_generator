import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {LibraryStorage, ReadingProgress, StoredBook} from '../../apps/extension/src/readers/types';

const tracker = vi.hoisted(() => ({props:new Map<string, {book:StoredBook;onProgress:(p:ReadingProgress)=>void}>(), final:new Map<string, ReadingProgress>()}));
vi.mock('../../apps/extension/src/readers/PdfReader', async () => {
 const React = await import('react');
 return {PdfReader:(props:{book:StoredBook;onProgress:(p:ReadingProgress)=>void}) => {
  tracker.props.set(props.book.documentId, props);
  React.useEffect(() => () => { const progress = tracker.final.get(props.book.documentId); if (progress) props.onProgress(progress); }, [props.book.documentId]);
  return React.createElement('div', {'data-test-reader':'pdf'}, props.book.title);
 }};
});
vi.mock('../../apps/extension/src/readers/EpubReader', async () => {
 const React = await import('react');
 return {EpubReader:(props:{book:StoredBook;onProgress:(p:ReadingProgress)=>void}) => {
  tracker.props.set(props.book.documentId, props);
  React.useEffect(() => () => { const progress = tracker.final.get(props.book.documentId); if (progress) props.onProgress(progress); }, [props.book.documentId]);
  return React.createElement('div', {'data-test-reader':props.book.kind}, props.book.title);
 }};
});
import {fingerprint, ReaderLibrary} from '../../apps/extension/src/readers/ReaderLibrary';

let node:HTMLDivElement, root:ReturnType<typeof createRoot>;
let storage:LibraryStorage, books:Map<string, StoredBook>;
beforeEach(() => {
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 vi.stubGlobal('crypto', {subtle:{digest:vi.fn(async (_algorithm:string, data:ArrayBuffer) => { const result = new Uint8Array(32); new Uint8Array(data).forEach((byte, index) => { result[index % 32] = (result[index % 32]! + byte) % 256; }); return result.buffer; })}});
 tracker.props.clear(); tracker.final.clear();
 books = new Map();
 storage = {
  listBooks:vi.fn(async () => [...books.values()]),
  getBook:vi.fn(async id => books.get(id)),
  putBook:vi.fn(async book => { books.set(book.documentId, book); }),
  saveProgress:vi.fn(async (id, progress) => { const book = books.get(id); if (book) books.set(id, {...book, progress}); }),
  deleteBook:vi.fn(async id => { books.delete(id); }),
 };
 Object.defineProperty(navigator, 'storage', {configurable:true, value:{estimate:vi.fn(async () => ({usage:0, quota:1e9}))}});
 node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
 await act(async () => root.unmount()); node.remove();
 vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function stored(id:string, progress?:ReadingProgress):StoredBook {
 return {documentId:id, title:`${id}.pdf`, kind:'pdf', size:10, addedAt:10, blob:new Blob(['%PDF-test']), progress};
}
async function render() { await act(async () => root.render(<ReaderLibrary storage={storage}/>)); }
function button(text:string) { const value = [...node.querySelectorAll('button')].find(button => button.textContent === text); if (!value) throw new Error(`Button not found: ${text}`); return value; }
async function click(text:string) { await act(async () => button(text).click()); }
function reader() { return node.querySelector('[data-test-reader]'); }
function deferred<T>() { let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void; const promise = new Promise<T>((r, j) => { resolve=r; reject=j; }); return {promise, resolve, reject}; }
function file(name:string, text='content'):File {
 const value = new File([text], name), bytes = new TextEncoder().encode(text);
 Object.defineProperty(value, 'arrayBuffer', {configurable:true, value:async () => bytes.slice().buffer});
 Object.defineProperty(value, 'slice', {value:(start=0, end=bytes.length) => ({arrayBuffer:async () => bytes.slice(start, end).buffer})});
 return value;
}
async function importFile(value:File) {
 const input = node.querySelector<HTMLInputElement>('input[type=file]')!;
 Object.defineProperty(input, 'files', {configurable:true, value:[value]});
 await act(async () => { input.dispatchEvent(new Event('change', {bubbles:true})); });
}

describe('local library shell', () => {
 it('offers accessible local-only open/drop and an explicit empty state', async () => {
  await render();
  expect(button('Открыть книгу')).toBeTruthy();
  expect(node.textContent).toContain('Здесь будут ваши книги');
  expect(node.textContent).toContain('не отправляются в облако');
  expect(node.querySelector('input')?.accept).toContain('.fb2');
  expect(node.querySelector('input')?.accept).not.toContain('.zip');
  expect(storage.putBook).not.toHaveBeenCalled();
 });
 it('sorts by last reading position and offers a continue action without inventing reflow pages', async () => {
  books.set('older', stored('older', {page:4, updatedAt:20}));
  books.set('recent', {...stored('recent', {chapter:'Вторая глава', cfi:'epubcfi(test)', updatedAt:30}), kind:'epub', title:'recent.epub'});
  await render();
  expect(node.querySelector('.er-library-recent')?.textContent).toContain('Вторая глава');
  expect(node.querySelector('.er-library-recent')?.textContent).not.toContain('Страница');
  await click('Продолжить чтение');
  expect(reader()?.getAttribute('data-test-reader')).toBe('epub');
  expect(tracker.props.get('recent')?.book.progress?.cfi).toBe('epubcfi(test)');
  expect(button('Открыть другую книгу')).toBeTruthy();
 });
 it('only activates the latest requested library book when reads finish out of order', async () => {
  books.set('first', stored('first')); books.set('second', stored('second'));
  const first = deferred<StoredBook|undefined>(), second = deferred<StoredBook|undefined>();
  storage.getBook = vi.fn(id => id === 'first' ? first.promise : second.promise);
  await render(); await click('first.pdf'); await click('second.pdf');
  await act(async () => second.resolve(stored('second')));
  expect(reader()?.textContent).toBe('second.pdf');
  await act(async () => first.resolve(stored('first')));
  expect(reader()?.textContent).toBe('second.pdf');
 });
 it('cancels pending opening and ignores a late read result', async () => {
  books.set('first', stored('first')); const first = deferred<StoredBook|undefined>(); storage.getBook = vi.fn(() => first.promise);
  await render(); await click('first.pdf'); await click('Отменить открытие');
  await act(async () => first.resolve(stored('first')));
  expect(reader()).toBeNull(); expect(node.textContent).not.toContain('Открываем книгу…');
 });
 it('flushes pending progress before reopening and preserves the previous reader final update', async () => {
  books.set('first', stored('first')); books.set('second', stored('second'));
  await render(); await click('first.pdf');
  await act(async () => tracker.props.get('first')!.onProgress({page:7, offset:.25, updatedAt:100}));
  tracker.final.set('first', {page:8, offset:.5, updatedAt:101});
  await click('← Библиотека'); await click('second.pdf');
  await act(async () => tracker.props.get('second')!.onProgress({page:2, offset:.1, updatedAt:102}));
  await click('← Библиотека'); await click('first.pdf');
  expect(tracker.props.get('first')?.book.progress).toEqual({page:8, offset:.5, updatedAt:101});
  expect(books.get('second')?.progress?.page).toBe(2);
  expect(storage.saveProgress).toHaveBeenCalledWith('first', {page:8, offset:.5, updatedAt:101});
 });
 it('persists the session-only warning and never saves its progress', async () => {
  storage.putBook = vi.fn(async () => { throw new Error('quota'); });
  await render(); await importFile(file('session.epub'));
  await click('Открыть только на текущую сессию');
  expect(reader()?.textContent).toBe('session.epub');
  expect(node.querySelector('[role=note]')?.textContent).toContain('не сохраняются');
  const props = [...tracker.props.values()][0]!;
  await act(async () => props.onProgress({cfi:'epubcfi(test)', chapter:'One', updatedAt:100}));
  await click('← Библиотека');
  expect(storage.saveProgress).not.toHaveBeenCalled();
 });
 it('clears a stale unsaved candidate when another file opens successfully', async () => {
  storage.putBook = vi.fn().mockRejectedValueOnce(new Error('quota')).mockImplementation(async (book:StoredBook) => { books.set(book.documentId, book); });
  await render(); await importFile(file('first.epub', 'first'));
  expect(node.textContent).toContain('Открыть только на текущую сессию');
  await importFile(file('second.fb2', '<FictionBook/>'));
  expect(reader()?.getAttribute('data-test-reader')).toBe('fb2');
  expect(reader()?.textContent).toBe('second.fb2');
  expect(node.textContent).not.toContain('Открыть только на текущую сессию');
  expect(node.querySelector('[role=note]')).toBeNull();
 });
 it('does not activate a stale import after a newer file succeeds', async () => {
  const first = file('first.epub', 'first'), bytes = deferred<ArrayBuffer>();
  Object.defineProperty(first, 'arrayBuffer', {value:() => bytes.promise});
  await render(); await importFile(first); await importFile(file('second.epub', 'second'));
  expect(reader()?.textContent).toBe('second.epub');
  await act(async () => bytes.resolve(new TextEncoder().encode('first').buffer));
  expect(reader()?.textContent).toBe('second.epub');
  expect(storage.putBook).toHaveBeenCalledTimes(1);
 });
 it('rejects unsupported FB2 archives and empty files before storage', async () => {
  await render(); await importFile(file('book.fb2.zip'));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('.fb2.zip не поддерживаются');
  await importFile(file('empty.epub', ''));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Файл пуст');
  expect(storage.putBook).not.toHaveBeenCalled();
 });
 it('imports one dropped file and gives explicit feedback for multiple files', async () => {
  await render();
  const drop = (files:File[]) => { const event = new Event('drop', {bubbles:true, cancelable:true}); Object.defineProperty(event, 'dataTransfer', {value:{files, types:['Files']}}); node.querySelector('main')!.dispatchEvent(event); };
  await act(async () => drop([file('one.epub'), file('two.epub')]));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('одну книгу за раз');
  expect(storage.putBook).not.toHaveBeenCalled();
  await act(async () => drop([file('one.epub')]));
  expect(reader()?.textContent).toBe('one.epub');
 });
 it('rejects oversized FB2 before hashing or storage and states its actual limit', async () => {
  await render(); const large = file('large.fb2'); Object.defineProperty(large, 'size', {value:16 * 1024 * 1024 + 1});
  await importFile(large);
  expect(node.querySelector('[role=alert]')?.textContent).toContain('16 МиБ');
  expect(crypto.subtle.digest).not.toHaveBeenCalled(); expect(storage.putBook).not.toHaveBeenCalled();
 });
 it('ignores a failed older request after the newer request is active', async () => {
  books.set('first', stored('first')); books.set('second', stored('second'));
  const first = deferred<StoredBook|undefined>(); storage.getBook = vi.fn(id => id === 'first' ? first.promise : Promise.resolve(stored('second')));
  await render(); await click('first.pdf'); await click('second.pdf');
  await act(async () => first.reject(new Error('old failure')));
  expect(reader()?.textContent).toBe('second.pdf'); expect(node.querySelector('[role=alert]')).toBeNull();
 });
 it('does not jump to an older import when its already-started storage write completes', async () => {
  const write = deferred<void>(); storage.putBook = vi.fn().mockImplementationOnce(() => write.promise).mockResolvedValue(undefined);
  await render(); await importFile(file('first.epub', 'first')); await importFile(file('second.epub', 'second'));
  expect(reader()?.textContent).toBe('second.epub');
  await act(async () => write.resolve());
  expect(reader()?.textContent).toBe('second.epub');
 });
 it('reuses a duplicate file and retains saved progress without another write', async () => {
  const existing = {...stored('existing'), kind:'epub' as const, title:'Saved.epub', progress:{cfi:'epubcfi(saved)', updatedAt:50}};
  storage.getBook = vi.fn(async () => existing);
  await render(); await importFile(file('same.epub'));
  expect(reader()?.textContent).toBe('Saved.epub');
  expect(tracker.props.get('existing')?.book.progress?.cfi).toBe('epubcfi(saved)');
  expect(storage.putBook).not.toHaveBeenCalled();
 });
 it('does not reopen a duplicate import during deletion and permits explicit reimport afterward', async () => {
  const original = file('same.epub', 'original bytes'), documentId = await fingerprint(original);
  books.set(documentId, {documentId, title:'same.epub', kind:'epub', size:original.size, addedAt:1, blob:original, progress:{cfi:'epubcfi(old)', updatedAt:10}});
  const deletion = deferred<void>();
  storage.deleteBook = vi.fn(async id => { await deletion.promise; books.delete(id); });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await render(); await click('Удалить');
  expect(storage.deleteBook).toHaveBeenCalledWith(documentId);
  await importFile(original);
  expect(reader()).toBeNull();
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Эта книга сейчас удаляется');
  expect(storage.putBook).not.toHaveBeenCalled();
  await act(async () => deletion.resolve());
  expect(books.has(documentId)).toBe(false); expect(reader()).toBeNull();
  await importFile(original);
  expect(reader()?.textContent).toBe('same.epub');
  expect(books.get(documentId)?.blob).toBe(original);
  expect(tracker.props.get(documentId)?.book.progress).toBeUndefined();
  expect(storage.putBook).toHaveBeenCalledTimes(1);
  expect(node.querySelector('[role=alert]')).toBeNull();
 });
});
