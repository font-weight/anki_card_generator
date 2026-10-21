import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {EpubCFI} from 'epubjs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EpubReader} from '../../apps/extension/src/readers/EpubReader';
import type {ReaderAppearance,ReaderBookmark,ReadingProgress,StoredBook} from '../../apps/extension/src/readers/types';
const mocks=vi.hoisted(()=>({epub:vi.fn(),unpack:vi.fn(),prepare:vi.fn(),convert:vi.fn()}));
vi.mock('epubjs',async importOriginal=>({...await importOriginal<typeof import('epubjs')>(),default:mocks.epub}));
vi.mock('../../apps/extension/src/readers/epub-security',()=>({unpackEpub:mocks.unpack,prepareSafeEpub:mocks.prepare}));
vi.mock('../../apps/extension/src/readers/fb2',()=>({convertFb2ToEpub:mocks.convert}));
const point=(offset=0)=>`epubcfi(/6/2[one]!/4/2/1:${offset})`;
const xml='<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>İ😀 Exact bank text. Another BANK.</p></body></html>';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function engine(){
 const handlers=new Map<string,Set<(...args:any[])=>void>>();let current={start:{href:'one.xhtml',cfi:point(),displayed:{page:1,total:4}},end:{href:'one.xhtml',cfi:point(),displayed:{page:1,total:4}},atStart:true,atEnd:false};
 const section={href:'one.xhtml',url:'/OPS/one.xhtml',cfiFromRange:(range:Range)=>new EpubCFI(range,'/6/2[one]').toString()};
 const r={hooks:{content:{register:vi.fn()}},themes:{default:vi.fn(),fontSize:vi.fn(),override:vi.fn()},epubcfi:new EpubCFI(),
  display:vi.fn(async(target?:string)=>{if(target?.startsWith('epubcfi('))current={...current,start:{...current.start,cfi:target}};}),next:vi.fn(async()=>{}),prev:vi.fn(async()=>{}),resize:vi.fn(),currentLocation:vi.fn(()=>current),
  on:(name:string,fn:(...args:any[])=>void)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name)!.add(fn);},off:(name:string,fn:(...args:any[])=>void)=>handlers.get(name)?.delete(fn)};
 const book={archived:true,archive:{getText:vi.fn(async()=>xml)},ready:Promise.resolve(),loaded:{navigation:Promise.resolve({toc:[{id:'one',href:'one.xhtml',label:'Глава один'}]})},spine:{hooks:{serialize:{register:vi.fn()}},each:(fn:(section:unknown)=>void)=>fn(section),get:(target:string|number)=>{if(typeof target==='string'&&target.startsWith('epubcfi(')&&new EpubCFI(target).spinePos!==0)return null;return section;}},renderTo:vi.fn(()=>r),destroy:vi.fn()};
 return {book,r,relocate:(cfi:string)=>{current={...current,start:{...current.start,cfi}};handlers.get('relocated')?.forEach(fn=>fn(current));}};
}
let node:HTMLDivElement,root:ReturnType<typeof createRoot>,active:ReturnType<typeof engine>,book:StoredBook,onProgress:ReturnType<typeof vi.fn<(value:ReadingProgress)=>void>>,onBookmarksChange:ReturnType<typeof vi.fn<(value:ReaderBookmark[])=>void>>,onAppearanceChange:ReturnType<typeof vi.fn<(value:ReaderAppearance)=>void>>;
async function render(props:{book?:StoredBook;bookmarks?:ReaderBookmark[];appearance?:ReaderAppearance;persistenceMode?:'persistent'|'session'}={}){await act(async()=>root.render(<EpubReader book={book} onProgress={onProgress} onBookmarksChange={onBookmarksChange} onAppearanceChange={onAppearanceChange} {...props}/>));}
function button(text:string){return [...node.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===text)!;}
async function click(text:string){await act(async()=>button(text).click());}
async function input(label:string,value:string){const field=node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});return field;}
async function select(label:string,value:string){const field=[...node.querySelectorAll<HTMLLabelElement>('label')].find(item=>item.textContent?.startsWith(label))!.querySelector('select')!;await act(async()=>{field.value=value;field.dispatchEvent(new Event('change',{bubbles:true}));});}
async function search(query='bank'){await input('Поиск по книге',query);await click('Найти');}
async function done(){await act(async()=>vi.waitFor(()=>expect(node.textContent).toContain('Найдено: 2.')));}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;node=document.createElement('div');document.body.append(node);root=createRoot(node);vi.clearAllMocks();
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(400);vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600);
 mocks.unpack.mockResolvedValue({});mocks.prepare.mockReturnValue({data:new ArrayBuffer(2),warnings:[],dispose:vi.fn()});active=engine();mocks.epub.mockReturnValue(active.book);
 book={documentId:'sha256:first',title:'One',kind:'epub',size:2,addedAt:0,blob:{arrayBuffer:async()=>new ArrayBuffer(2)} as Blob};onProgress=vi.fn();onBookmarksChange=vi.fn();onAppearanceChange=vi.fn();
});
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.unstubAllGlobals();vi.useRealTimers();});

describe('EPUB / FB2 saved reader controls',()=>{
 it('adds a labelled exact-CFI bookmark, rejects duplicate, jumps and explicitly removes',async()=>{
  await render();await act(async()=>active.relocate(point(7)));await input('Название закладки','  Мой bank  ');await click('Добавить закладку');
  const [mark]=onBookmarksChange.mock.lastCall![0] as ReaderBookmark[];expect(mark).toMatchObject({kind:'epub',label:'Мой bank',cfi:point(7),chapter:'Глава один'});expect(mark.id).toBeTruthy();expect(node.querySelector('.er-epub-bookmarks')!.textContent).toContain('Мой bank');
  await click('Добавить закладку');expect(onBookmarksChange).toHaveBeenCalledOnce();expect(node.textContent).toContain('Это место уже есть');
  await act(async()=>active.relocate(point(20)));await act(async()=>node.querySelector<HTMLButtonElement>('.er-epub-bookmarks li>button')!.click());expect(active.r.display).toHaveBeenLastCalledWith(point(7));
  await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="Удалить закладку «Мой bank»"]')!.click());expect(onBookmarksChange.mock.lastCall![0]).toEqual([]);expect(node.textContent).toContain('Пока нет закладок.');
 });
 it('restores all appearance controls and persists changes without losing current CFI',async()=>{
  await render({appearance:{kind:'epub',fontSize:26,width:'wide',lineHeight:2,theme:'dark'},persistenceMode:'persistent'});
  expect(node.querySelector<HTMLInputElement>('[aria-label="Размер шрифта"]')!.value).toBe('26');expect(node.querySelector('.er-epub-viewport')!.className).toContain('er-epub-width-wide');expect(active.r.themes.override).toHaveBeenCalledWith('background','#17212b');
  await act(async()=>active.relocate(point(10)));await input('Размер шрифта','24');await select('Ширина','full');await select('Интервал','1.5');await select('Тема','light');
  expect(onAppearanceChange.mock.lastCall![0]).toEqual({kind:'epub',fontSize:24,width:'full',lineHeight:1.5,theme:'light'});expect(active.r.display).toHaveBeenLastCalledWith(point(10));expect(node.textContent).toContain('сохраняются локально');
 });
 it('clears fallback bookmarks and appearance between books and labels session scope honestly',async()=>{
  await render({persistenceMode:'session'});await click('Добавить закладку');await input('Размер шрифта','28');expect(node.textContent).toContain('только до закрытия этой книги');
  active=engine();mocks.epub.mockReturnValue(active.book);await render({book:{...book,documentId:'sha256:second'}});
  expect(node.textContent).toContain('Пока нет закладок.');expect(node.querySelector<HTMLInputElement>('[aria-label="Размер шрифта"]')!.value).toBe('20');
 });
 it('never navigates invalid or outside-spine persisted bookmark targets',async()=>{
  const entries:ReaderBookmark[]=[{id:'external',label:'External',createdAt:0,kind:'epub',cfi:'https://evil.invalid',chapter:'Bad'},{id:'other',label:'Other',createdAt:0,kind:'epub',cfi:'epubcfi(/6/100!/4/2/1:0)',chapter:'Missing'}];
  await render({bookmarks:entries});active.r.display.mockClear();const targets=node.querySelectorAll<HTMLButtonElement>('.er-epub-bookmarks li>button:first-child');expect(targets[0].disabled).toBe(true);await act(async()=>targets[1].click());expect(active.r.display).not.toHaveBeenCalled();
 });
 it('runs foldaway local search, renders escaped snippets and navigates the exact generated CFI',async()=>{
  await render();expect(node.querySelector<HTMLDetailsElement>('.er-epub-tools')!.open).toBe(false);await search();await done();
  expect(node.querySelectorAll('.er-epub-results li')).toHaveLength(2);const result=node.querySelector<HTMLButtonElement>('.er-epub-results button')!;expect(result.textContent).toContain('Глава один');expect(result.textContent).toContain('Exact bank');
  await act(async()=>result.click());const target=active.r.display.mock.lastCall![0]!;expect(new EpubCFI(target).toRange(new DOMParser().parseFromString(xml,'text/html')).toString()).toBe('bank');
 });
 it('does not page when typing or using Shift in either new input',async()=>{
  await render();for(const label of ['Поиск по книге','Название закладки']){const field=await input(label,'bank');await act(async()=>field.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));}
  await act(async()=>node.querySelector('.er-epub-viewport')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true})));await act(async()=>button('Добавить закладку').dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true,cancelable:true})));expect(active.r.next).not.toHaveBeenCalled();
 });
 it('cancels pending search on query change and suppresses its late results',async()=>{
  const old=deferred<string>();active.book.archive.getText.mockReturnValueOnce(old.promise);await render();await search();await vi.waitFor(()=>expect(active.book.archive.getText).toHaveBeenCalledOnce());
  await input('Поиск по книге','absent');await act(async()=>old.resolve(xml));expect(node.querySelector('.er-epub-results')).toBeNull();expect(node.textContent).not.toContain('Найдено: 2');await click('Найти');await act(async()=>vi.waitFor(()=>expect(node.textContent).toContain('Найдено: 0.')));
 });
 it('cancels old-book search and cannot route late results into the new book',async()=>{
  const old=deferred<string>(),oldEngine=active;active.book.archive.getText.mockReturnValueOnce(old.promise);await render();await search();await vi.waitFor(()=>expect(oldEngine.book.archive.getText).toHaveBeenCalledOnce());
  active=engine();mocks.epub.mockReturnValue(active.book);await render({book:{...book,documentId:'sha256:new'}});await act(async()=>old.resolve(xml));
  expect(node.querySelector<HTMLInputElement>('input[aria-label="Поиск по книге"]')!.value).toBe('');expect(node.querySelector('.er-epub-results')).toBeNull();expect(oldEngine.book.destroy).toHaveBeenCalledOnce();await search();await done();expect(active.book.archive.getText).toHaveBeenCalledOnce();
 });
 it('stops an in-flight search explicitly and can retry without reopening the book',async()=>{
  const pending=deferred<string>();active.book.archive.getText.mockReturnValueOnce(pending.promise);await render();await search();await vi.waitFor(()=>expect(active.book.archive.getText).toHaveBeenCalledOnce());
  await click('Остановить поиск');expect(node.textContent).toContain('Поиск частичный');await act(async()=>pending.resolve(xml));expect(node.querySelector('.er-epub-results')).toBeNull();await click('Найти');await done();expect(active.book.renderTo).toHaveBeenCalledOnce();
 });
 it('keeps FB2 provenance in saved bookmarks and appearance',async()=>{
  mocks.convert.mockResolvedValue({blob:book.blob,warnings:[]});await render({book:{...book,kind:'fb2'},appearance:{kind:'fb2',fontSize:22,lineHeight:1.3,width:'wide',theme:'light'}});await click('Добавить закладку');expect(onBookmarksChange.mock.lastCall![0][0]).toMatchObject({kind:'fb2',cfi:point()});await input('Размер шрифта','24');expect(onAppearanceChange.mock.lastCall![0]).toMatchObject({kind:'fb2',fontSize:24});
 });
});
