import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {LibraryStorage,ReaderAppearance,ReaderBookmark,ReaderSavedState,ReadingProgress,StoredBook} from '../../apps/extension/src/readers/types';
type ReaderProps={book:StoredBook;onProgress:(value:ReadingProgress)=>void;bookmarks:ReaderBookmark[];appearance?:ReaderAppearance;onBookmarksChange:(next:ReaderBookmark[])=>void;onAppearanceChange:(next:ReaderAppearance)=>void;persistenceMode:'persistent'|'session'};
const tracker=vi.hoisted(()=>({props:new Map<string,ReaderProps>(),final:new Map<string,ReadingProgress>(),mounts:new Map<string,number>()}));
vi.mock('../../apps/extension/src/readers/PdfReader',async()=>({PdfReader:(props:ReaderProps)=>{tracker.props.set(props.book.documentId,props);React.useEffect(()=>{tracker.mounts.set(props.book.documentId,(tracker.mounts.get(props.book.documentId)||0)+1);return()=>{const final=tracker.final.get(props.book.documentId);if(final)props.onProgress(final);};},[props.book.documentId]);return React.createElement('div',{'data-test-reader':props.book.documentId},props.book.title,React.createElement('input',{'data-test-draft':'',defaultValue:''}));}}));
vi.mock('../../apps/extension/src/readers/EpubReader',async()=>({EpubReader:(props:ReaderProps)=>{tracker.props.set(props.book.documentId,props);React.useEffect(()=>{tracker.mounts.set(props.book.documentId,(tracker.mounts.get(props.book.documentId)||0)+1);return()=>{const final=tracker.final.get(props.book.documentId);if(final)props.onProgress(final);};},[props.book.documentId]);return React.createElement('div',{'data-test-reader':props.book.documentId},props.book.title,React.createElement('input',{'data-test-draft':'',defaultValue:''}));}}));
import {ReaderLibrary} from '../../apps/extension/src/readers/ReaderLibrary';
let node:HTMLDivElement,root:ReturnType<typeof createRoot>,storage:LibraryStorage,books:Map<string,StoredBook>,saved:Map<string,ReaderSavedState>;
const book=(id:string):StoredBook=>({documentId:id,title:`${id}.pdf`,kind:'pdf',size:20,addedAt:1,blob:new Blob(['%PDF-test'])});
const bookmark=(id='one'):ReaderBookmark=>({id,label:`Bookmark ${id}`,createdAt:100,kind:'pdf',page:2,offset:.2});
const state=():ReaderSavedState=>({version:1,bookmarks:[bookmark()],appearance:{kind:'pdf',zoom:'1.25'}});
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;tracker.props.clear();tracker.final.clear();tracker.mounts.clear();books=new Map([['A',book('A')],['B',book('B')]]);saved=new Map();
 storage={listBooks:vi.fn(async()=>[...books.values()]),getBook:vi.fn(async id=>books.get(id)),putBook:vi.fn(async value=>{books.set(value.documentId,value);}),deleteBook:vi.fn(async id=>{books.delete(id);saved.delete(id);}),saveProgress:vi.fn(async()=>{}),getReaderState:vi.fn(async id=>saved.get(id)),saveReaderState:vi.fn(async(id,state)=>{saved.set(id,state);})};
 node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function render(){await act(async()=>root.render(<ReaderLibrary storage={storage}/>));}
const props=(id='A')=>tracker.props.get(id)!;
function button(text:string){const found=[...node.querySelectorAll('button')].find(button=>button.textContent===text);if(!found)throw new Error(`Missing button: ${text}`);return found;}
async function click(text:string){await act(async()=>button(text).click());}
async function importEpub(name='session.epub'){
 const text=name.endsWith('.pdf')?'%PDF-test':'epub';const file=new File([text],name);Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode(text).buffer});Object.defineProperty(file,'slice',{value:()=>({arrayBuffer:async()=>new TextEncoder().encode(text).buffer})});
 const input=node.querySelector('input[type=file]')!;Object.defineProperty(input,'files',{configurable:true,value:[file]});
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
}

describe('reader saved-state library integration',()=>{
 it('loads state before mounting and never writes defaults over an existing record',async()=>{
  saved.set('A',state());await render();await click('A.pdf');
  expect(props().bookmarks).toEqual(state().bookmarks);expect(props().appearance).toEqual(state().appearance);expect(props().persistenceMode).toBe('persistent');expect(storage.saveReaderState).not.toHaveBeenCalled();
 });
 it('merges rapid bookmark and appearance edits without dropping either, in write order',async()=>{
  await render();await click('A.pdf');const before=props();
  await act(async()=>{before.onBookmarksChange([bookmark()]);before.onAppearanceChange({kind:'pdf',zoom:'1.5'});});
  expect(saved.get('A')).toEqual({version:1,bookmarks:[bookmark()],appearance:{kind:'pdf',zoom:'1.5'}});
  expect(storage.saveReaderState).toHaveBeenCalledTimes(2);expect(storage.saveProgress).not.toHaveBeenCalled();expect(storage.putBook).not.toHaveBeenCalled();
 });
 it('keeps per-document state isolated and ignores callbacks retained from a closed reader',async()=>{
  saved.set('A',state());await render();await click('A.pdf');const old=props();await click('← Библиотека');await click('B.pdf');
  await act(async()=>{old.onBookmarksChange([bookmark('stale')]);old.onAppearanceChange({kind:'pdf',zoom:'0.75'});});
  expect(props('B').bookmarks).toEqual([]);expect(props('B').appearance).toBeUndefined();expect(saved.get('A')).toEqual(state());expect(storage.saveReaderState).not.toHaveBeenCalled();
  await act(async()=>props('B').onBookmarksChange([bookmark('B')]));expect(saved.get('B')?.bookmarks[0]?.id).toBe('B');expect(saved.get('A')).toEqual(state());
 });
 it('ignores stale hydration success and error after a newer book opened',async()=>{
  const first=deferred<ReaderSavedState|undefined>();storage.getReaderState=vi.fn(id=>id==='A'?first.promise:Promise.resolve(state()));
  await render();await click('A.pdf');await click('B.pdf');expect(node.querySelector('[data-test-reader]')?.textContent).toBe('B.pdf');
  await act(async()=>first.reject(new Error('stale failure')));expect(node.querySelector('[data-test-reader]')?.textContent).toBe('B.pdf');expect(node.querySelector('[role=alert]')).toBeNull();
 });
 it('opens the book after state-read failure, reports it and never overwrites unreadable stored state',async()=>{
  storage.getReaderState=vi.fn(async()=>{throw new Error('corrupt optional record');});await render();await click('A.pdf');
  expect(node.querySelector('[data-test-reader]')?.textContent).toBe('A.pdf');expect(node.querySelector('[role=alert]')?.textContent).toContain('Не удалось загрузить закладки');expect(props().persistenceMode).toBe('session');
  await act(async()=>{props().onBookmarksChange([bookmark()]);props().onAppearanceChange({kind:'pdf',zoom:'1'});});
  expect(props().bookmarks).toHaveLength(1);expect(storage.saveReaderState).not.toHaveBeenCalled();
 });
 it('shows a failed save, keeps changes in the tab, and supports an explicit successful retry',async()=>{
  storage.saveReaderState=vi.fn().mockRejectedValueOnce(new Error('quota')).mockImplementation(async(id:string,state:ReaderSavedState)=>{saved.set(id,state);});
  await render();await click('A.pdf');await act(async()=>props().onBookmarksChange([bookmark()]));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Не удалось сохранить');expect(props().bookmarks).toHaveLength(1);
  await click('Повторить сохранение закладок и оформления');expect(node.querySelector('[role=alert]')).toBeNull();expect(saved.get('A')?.bookmarks).toEqual([bookmark()]);
 });
 it('retains a failed write across reopening instead of silently reverting to disk state',async()=>{
  storage.saveReaderState=vi.fn(async()=>{throw new Error('disk unavailable');});await render();await click('A.pdf');await act(async()=>props().onBookmarksChange([bookmark()]));await click('← Библиотека');await click('A.pdf');
  expect(props().bookmarks).toEqual([bookmark()]);expect(node.querySelector('[role=alert]')?.textContent).toContain('пока не сохранены');expect(button('Повторить сохранение закладок и оформления')).toBeTruthy();
 });
 it('does not persist or hydrate any saved-state records in an explicitly session-only book',async()=>{
  vi.stubGlobal('crypto',{subtle:{digest:vi.fn(async()=>new Uint8Array(32).buffer)}});
  storage.putBook=vi.fn(async()=>{throw new Error('quota');});await render();await importEpub();await click('Открыть только на текущую сессию');
  const current=[...tracker.props.values()].at(-1)!;expect(current.persistenceMode).toBe('session');
  await act(async()=>{current.onBookmarksChange([{id:'cfi',label:'Chapter',createdAt:10,kind:'epub',chapter:'One',cfi:'epubcfi(/6/2!/4/2)'}]);current.onAppearanceChange({kind:'epub',fontSize:24,theme:'dark',width:'full',lineHeight:2});});
  expect(storage.getReaderState).not.toHaveBeenCalled();expect(storage.saveReaderState).not.toHaveBeenCalled();expect(node.querySelector('[role=note]')?.textContent).toContain('закладки и оформление не сохраняются');
 });
 it('waits for pending state writes before deletion and prevents an old callback resurrecting data',async()=>{
  const write=deferred<void>();storage.saveReaderState=vi.fn(async(id,next)=>{await write.promise;saved.set(id,next);});vi.spyOn(window,'confirm').mockReturnValue(true);
  await render();await click('A.pdf');const old=props();await act(async()=>old.onBookmarksChange([bookmark()]));await click('← Библиотека');
  const deleteA=node.querySelector<HTMLButtonElement>('[aria-label="Удалить A.pdf"]')!;await act(async()=>deleteA.click());expect(storage.deleteBook).not.toHaveBeenCalled();
  await act(async()=>write.resolve());expect(storage.deleteBook).toHaveBeenCalledWith('A');expect(saved.has('A')).toBe(false);
  await act(async()=>old.onBookmarksChange([bookmark('late')]));expect(storage.saveReaderState).toHaveBeenCalledTimes(1);expect(saved.has('A')).toBe(false);
 });
 it('keeps the existing renderer on an active duplicate import instead of restoring behind its final position',async()=>{
  vi.stubGlobal('crypto',{subtle:{digest:vi.fn(async()=>new Uint8Array(32).buffer)}});
  const active={...book('A'),progress:{page:7,offset:.1,updatedAt:100}};books.set('A',active);storage.getBook=vi.fn(async()=>active);
  storage.saveReaderState=vi.fn(async()=>{throw new Error('quota');});
  await render();await click('A.pdf');tracker.final.set('A',{page:8,offset:.4,updatedAt:200});
  await act(async()=>{props().onBookmarksChange([bookmark()]);props().onAppearanceChange({kind:'pdf',zoom:'1.5'});});
  const draft=node.querySelector<HTMLInputElement>('[data-test-draft]')!;draft.value='unfinished search';
  await importEpub('duplicate.pdf');
  expect(tracker.mounts.get('A')).toBe(1);expect(storage.getReaderState).toHaveBeenCalledTimes(1);
  expect(node.querySelector('[data-test-draft]')).toBe(draft);expect(draft.value).toBe('unfinished search');
  expect(props().bookmarks).toEqual([bookmark()]);expect(props().appearance).toEqual({kind:'pdf',zoom:'1.5'});
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Не удалось сохранить');expect(button('Повторить сохранение закладок и оформления')).toBeTruthy();
 });
 it('still upgrades a same-document session-only reader when a persistent copy becomes available',async()=>{
  vi.stubGlobal('crypto',{subtle:{digest:vi.fn(async()=>new Uint8Array(32).buffer)}});
  storage.putBook=vi.fn(async()=>{throw new Error('quota');});await render();await importEpub();await click('Открыть только на текущую сессию');
  const current=[...tracker.props.values()].at(-1)!;expect(current.persistenceMode).toBe('session');
  books.set(current.book.documentId,current.book);await importEpub();
  expect(tracker.mounts.get(current.book.documentId)).toBe(2);expect(tracker.props.get(current.book.documentId)?.persistenceMode).toBe('persistent');expect(storage.getReaderState).toHaveBeenCalledWith(current.book.documentId);expect(node.querySelector('[role=note]')).toBeNull();
 });
 it('rejects malformed/cross-document-kind edits visibly before any persistence',async()=>{
  await render();await click('A.pdf');await act(async()=>props().onBookmarksChange([{id:'bad',label:'Wrong format',createdAt:1,kind:'epub',cfi:'epubcfi(/6/2)',chapter:'Wrong'}]));
  expect(node.querySelector('[role=alert]')?.textContent).toContain('Не удалось изменить');expect(storage.saveReaderState).not.toHaveBeenCalled();expect(props().bookmarks).toEqual([]);
 });
});
