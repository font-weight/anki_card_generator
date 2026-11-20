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
 const section={index:0,linear:false,href:'one.xhtml',url:'/OPS/one.xhtml',cfiFromRange:(range:Range)=>new EpubCFI(range,'/6/2[one]').toString()};
 const r={hooks:{content:{register:vi.fn()}},themes:{default:vi.fn(),fontSize:vi.fn(),override:vi.fn()},epubcfi:new EpubCFI(),
  display:vi.fn(async(target?:string)=>{if(target?.startsWith('epubcfi('))current={...current,start:{...current.start,cfi:target}};}),next:vi.fn(async()=>{}),prev:vi.fn(async()=>{}),resize:vi.fn(),currentLocation:vi.fn(()=>current),
  on:(name:string,fn:(...args:any[])=>void)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name)!.add(fn);},off:(name:string,fn:(...args:any[])=>void)=>handlers.get(name)?.delete(fn)};
 const book={archived:true,archive:{getText:vi.fn(async()=>xml)},ready:Promise.resolve(),loaded:{navigation:Promise.resolve({toc:[{id:'one',href:'one.xhtml',label:'Глава один'}]})},spine:{hooks:{serialize:{register:vi.fn()}},each:(fn:(section:unknown)=>void)=>fn(section),get:(target:string|number)=>{if(typeof target==='string'&&target.startsWith('epubcfi(')&&new EpubCFI(target).spinePos!==0)return null;return section;}},renderTo:vi.fn(()=>r),destroy:vi.fn()};
 return {book,r,relocate:(cfi:string)=>{current={...current,start:{...current.start,cfi}};handlers.get('relocated')?.forEach(fn=>fn(current));}};
}
let node:HTMLDivElement,root:ReturnType<typeof createRoot>,active:ReturnType<typeof engine>,book:StoredBook,onProgress:ReturnType<typeof vi.fn<(value:ReadingProgress)=>void>>,onBookmarksChange:ReturnType<typeof vi.fn<(value:ReaderBookmark[])=>void>>,onAppearanceChange:ReturnType<typeof vi.fn<(value:ReaderAppearance)=>void>>;
async function render(props:{book?:StoredBook;bookmarks?:ReaderBookmark[];appearance?:ReaderAppearance;persistenceMode?:'persistent'|'session'}={}){await act(async()=>root.render(<EpubReader book={book} onProgress={onProgress} onBookmarksChange={onBookmarksChange} onAppearanceChange={onAppearanceChange} {...props}/>));}
function button(text:string){return [...node.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===text||button.getAttribute('aria-label')===text)!;}
async function panel(label:string){const rail=button(label);if(rail.getAttribute('aria-expanded')!=='true')await act(async()=>rail.click());}
async function click(text:string){if(text==='Добавить закладку')await panel('Закладки');await act(async()=>button(text).click());}
async function input(label:string,value:string){await panel(label==='Название закладки'?'Закладки':'Поиск');const field=node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});return field;}
function fontSize(){return Number.parseInt(node.querySelector('[aria-label="Размер шрифта"] output')!.textContent!);}
async function setFont(value:number){await panel('Вид');const previous=fontSize();for(let i=0;i<Math.abs(value-previous);i++)await click((value>previous?'Увеличить':'Уменьшить')+': Размер шрифта');}
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
 it.each(['epub','fb2'] as const)('enables publisher styling by default and preserves explicit settings for %s',async kind=>{
  if(kind==='fb2')mocks.convert.mockResolvedValue({blob:book.blob,warnings:[]});
  const appearance={kind,theme:'cream' as const,fontSize:23,lineHeight:1.5 as const};
  for(const [i,saved] of [undefined,appearance,{...appearance,publisher:false},{...appearance,publisher:true}].entries()){
   active=engine();mocks.epub.mockReturnValue(active.book);
   await render({book:{...book,kind,documentId:'publisher-test-'+i},appearance:saved});
   await panel('Вид');
   const toggle=button('Оформление издателя'),enabled=!(saved&&'publisher'in saved&&saved.publisher===false);
   expect(toggle.getAttribute('aria-checked')).toBe(String(enabled));
   expect(onAppearanceChange).not.toHaveBeenCalled();
   await click('Оформление издателя');
   expect(onAppearanceChange.mock.lastCall?.[0]).toMatchObject({kind,publisher:!enabled});
   onAppearanceChange.mockClear();
  }
 });
 it('adds a labelled exact-CFI bookmark, rejects duplicate, jumps and explicitly removes',async()=>{
  await render();await act(async()=>active.relocate(point(7)));await input('Название закладки','  Мой bank  ');await click('Добавить закладку');
  const [mark]=onBookmarksChange.mock.lastCall![0] as ReaderBookmark[];expect(mark).toMatchObject({kind:'epub',label:'Мой bank',cfi:point(7),chapter:'Глава один'});expect(mark.id).toBeTruthy();expect(node.querySelector('.er-epub-bookmarks')!.textContent).toContain('Мой bank');
  await click('Добавить закладку');expect(onBookmarksChange).toHaveBeenCalledOnce();expect(node.textContent).toContain('Это место уже есть');
  await act(async()=>active.relocate(point(20)));await act(async()=>node.querySelector<HTMLButtonElement>('.er-epub-bookmarks li>button')!.click());expect(active.r.display).toHaveBeenLastCalledWith(point(7));
  expect(node.querySelector('.rc-panel')).toBeNull();await panel('Закладки');
  await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="Удалить закладку «Мой bank»"]')!.click());expect(onBookmarksChange.mock.lastCall![0]).toEqual([]);expect(node.textContent).toContain('Пока нет закладок.');
 });
 it('restores all appearance controls and persists changes without losing current CFI',async()=>{
  await render({appearance:{kind:'epub',fontSize:26,width:'wide',lineHeight:2,theme:'dark'},persistenceMode:'persistent'});
  await panel('Вид');expect(fontSize()).toBe(26);expect(node.querySelector('.rc-shell')?.getAttribute('data-reader-theme')).toBe('graphite');expect(active.r.themes.override).toHaveBeenCalledWith('background','#363636');expect(node.querySelector('select')).toBeNull();
  await act(async()=>active.relocate(point(10)));await setFont(24);await click('Уменьшить: Интервал строк');await click('Уменьшить: Интервал строк');await click('Белая');
  expect(onAppearanceChange.mock.lastCall![0]).toEqual({kind:'epub',fontSize:24,width:'wide',lineHeight:1.5,theme:'light'});expect(active.r.display).toHaveBeenLastCalledWith(point(10));expect(node.textContent).not.toContain('О чтении книги');
 });
 it('clears fallback bookmarks and appearance between session books',async()=>{
  await render({persistenceMode:'session'});await click('Добавить закладку');await setFont(28);expect(fontSize()).toBe(28);
  active=engine();mocks.epub.mockReturnValue(active.book);await render({book:{...book,documentId:'sha256:second'}});
  await panel('Закладки');expect(node.textContent).toContain('Пока нет закладок.');await panel('Вид');expect(fontSize()).toBe(20);
 });
 it('never navigates invalid or outside-spine persisted bookmark targets',async()=>{
  const entries:ReaderBookmark[]=[{id:'external',label:'External',createdAt:0,kind:'epub',cfi:'https://evil.invalid',chapter:'Bad'},{id:'other',label:'Other',createdAt:0,kind:'epub',cfi:'epubcfi(/6/100!/4/2/1:0)',chapter:'Missing'}];
  await render({bookmarks:entries});await panel('Закладки');active.r.display.mockClear();const targets=node.querySelectorAll<HTMLButtonElement>('.er-epub-bookmarks li>button:first-child');expect(targets[0].disabled).toBe(true);await act(async()=>targets[1].click());expect(active.r.display).not.toHaveBeenCalled();
 });
 it('runs foldaway local search, renders escaped snippets and navigates the exact generated CFI',async()=>{
  await render();expect(button('Поиск').getAttribute('aria-expanded')).toBe('false');await search();await done();
  expect(node.querySelectorAll('.rc-results li')).toHaveLength(2);const result=node.querySelector<HTMLButtonElement>('.rc-results button')!;expect(result.textContent).toContain('Глава один');expect(result.textContent).toContain('Exact bank');
  await act(async()=>result.click());const target=active.r.display.mock.lastCall![0]!;expect(new EpubCFI(target).toRange(new DOMParser().parseFromString(xml,'text/html')).toString()).toBe('bank');
 });
 it('does not page when typing or using Shift in either new input',async()=>{
  await render();for(const label of ['Поиск по книге','Название закладки']){const field=await input(label,'bank');await act(async()=>field.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));}
  await act(async()=>node.querySelector('.er-epub-viewport')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true,cancelable:true})));await act(async()=>button('Добавить закладку').dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true,cancelable:true})));expect(active.r.next).not.toHaveBeenCalled();
 });
 it('cancels pending search on query change and suppresses its late results',async()=>{
  const old=deferred<string>();active.book.archive.getText.mockReturnValueOnce(old.promise);await render();await search();await vi.waitFor(()=>expect(active.book.archive.getText).toHaveBeenCalledOnce());
  await input('Поиск по книге','absent');await act(async()=>old.resolve(xml));expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);expect(node.textContent).not.toContain('Найдено: 2');await click('Найти');await act(async()=>vi.waitFor(()=>expect(node.textContent).toContain('Найдено: 0.')));
 });
 it('cancels old-book search and cannot route late results into the new book',async()=>{
  const old=deferred<string>(),oldEngine=active;active.book.archive.getText.mockReturnValueOnce(old.promise);await render();await search();await vi.waitFor(()=>expect(oldEngine.book.archive.getText).toHaveBeenCalledOnce());
  active=engine();mocks.epub.mockReturnValue(active.book);await render({book:{...book,documentId:'sha256:new'}});await act(async()=>old.resolve(xml));
  await panel('Поиск');expect(node.querySelector<HTMLInputElement>('input[aria-label="Поиск по книге"]')!.value).toBe('');expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);expect(oldEngine.book.destroy).toHaveBeenCalledOnce();await search();await done();expect(active.book.archive.getText).toHaveBeenCalledOnce();
 });
 it('stops an in-flight search explicitly and can retry without reopening the book',async()=>{
  const pending=deferred<string>();active.book.archive.getText.mockReturnValueOnce(pending.promise);await render();await search();await vi.waitFor(()=>expect(active.book.archive.getText).toHaveBeenCalledOnce());
  await click('Остановить поиск');expect(node.textContent).toContain('Поиск частичный');await act(async()=>pending.resolve(xml));expect(node.querySelectorAll('.rc-results li')).toHaveLength(0);await click('Найти');await done();expect(active.book.renderTo).toHaveBeenCalledOnce();
 });
 it('keeps FB2 provenance in saved bookmarks and appearance',async()=>{
  mocks.convert.mockResolvedValue({blob:book.blob,warnings:[]});await render({book:{...book,kind:'fb2'},appearance:{kind:'fb2',fontSize:22,lineHeight:1.3,width:'wide',theme:'light'}});await click('Добавить закладку');expect(onBookmarksChange.mock.lastCall![0][0]).toMatchObject({kind:'fb2',cfi:point()});await setFont(24);expect(onAppearanceChange.mock.lastCall![0]).toMatchObject({kind:'fb2',fontSize:24});
 });
});

it('saves an iframe text range and comment, paints without changing source text, and dismisses actions for Shift lookup',async()=>{
 const onQuotesChange=vi.fn();
 await act(async()=>root.render(<EpubReader book={book} onProgress={onProgress} onQuotesChange={onQuotesChange}/>));
 const frame=document.createElement('iframe');node.querySelector('.er-epub-viewport')!.append(frame);
 Object.defineProperty(frame,'sandbox',{value:{contains:()=>false}});
 const doc=frame.contentDocument!,win=frame.contentWindow!,registry=new Map();
 doc.body.innerHTML='<p>She put off the trip until Monday.</p>';
 Object.defineProperty(win,'CSS',{value:{highlights:registry}});
 Object.defineProperty(win,'Highlight',{value:class{constructor(readonly range:Range){}}});
 const range=doc.createRange();range.setStart(doc.querySelector('p')!.firstChild!,4);range.setEnd(range.startContainer,11);
 range.getBoundingClientRect=()=>new DOMRect(25,34,50,20);
 const contents={window:win,document:doc,sectionIndex:0,cfiFromRange:(r:Range)=>new EpubCFI(r,'/6/2[one]').toString(),range:(cfi:string)=>new EpubCFI(cfi).toRange(doc)};
 const hook=active.r.hooks.content.register.mock.calls[0][0] as (c:typeof contents)=>void;hook(contents);const before=doc.body.innerHTML;
 async function selectWords(){doc.getSelection()!.removeAllRanges();doc.getSelection()!.addRange(range);await act(async()=>doc.dispatchEvent(new Event('pointerup')));}
 await selectWords();expect([...node.querySelectorAll('[role="toolbar"] button')].map(b=>b.textContent)).toEqual(['Выделить','Комментарий']);
 await act(async()=>doc.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift'})));expect(node.querySelector('[role="toolbar"]')).toBeNull();
 await selectWords();await click('Комментарий');
 const textarea=node.querySelector('textarea')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Перенести на потом');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 await click('Сохранить');const saved=onQuotesChange.mock.lastCall![0][0];
 expect(saved).toMatchObject({kind:'epub',text:'put off',comment:'Перенести на потом',chapter:'Глава один',cfi:contents.cfiFromRange(range)});
 expect(registry.get('reader-quotes').range.toString()).toBe('put off');expect(doc.body.innerHTML).toBe(before);
 await panel('Цитаты');expect(node.querySelector('.rc-quotes')?.textContent).toContain('Перенести на потом');
 await act(async()=>node.querySelector<HTMLButtonElement>('.rc-quotes button')!.click());expect(active.r.display).toHaveBeenLastCalledWith(saved.cfi);
});

it.each(['epub','fb2'] as const)('paints only the selected %s occurrence in the rendered iframe, independently of saved quotes',async kind=>{
 const body='<p>İ😀   The <em>ba</em>nk was open. The <em>ba</em>nk was closed.</p>';
 const archive='<html xmlns="http://www.w3.org/1999/xhtml"><head/><body>'+body+'</body></html>';
 active.book.archive.getText.mockResolvedValue(archive);
 mocks.convert.mockResolvedValue({blob:book.blob,warnings:[]});
 const onQuotesChange=vi.fn();
 const savedDoc=new DOMParser().parseFromString(archive,'text/html'),savedRange=savedDoc.createRange();
 savedRange.selectNodeContents(savedDoc.querySelector('em')!.firstChild!);
 const saved={kind,id:'quote',chapter:'Глава один',text:'ba',cfi:new EpubCFI(savedRange,'/6/2[one]').toString(),createdAt:1};
 await act(async()=>root.render(<EpubReader book={{...book,kind}} onProgress={onProgress} quotes={[saved]} onQuotesChange={onQuotesChange}/>));
 await search();await done();
 const results=()=>Array.from(node.querySelectorAll<HTMLButtonElement>('.rc-results button'));
 const matchNodes=results().map(result=>result.querySelector('mark')!);
 expect(matchNodes.map(mark=>mark.textContent)).toEqual(['bank','bank']);
 expect(matchNodes[0].previousSibling?.textContent).toBe('İ😀 The ');
 expect(matchNodes[1].previousSibling?.textContent).toBe('İ😀 The bank was open. The ');
 await act(async()=>results()[1].click());
 const secondCfi=active.r.display.mock.lastCall![0];
 function attachFrame(bodyHtml=body,sectionIndex=0){
  const frame=document.createElement('iframe');node.querySelector('.er-epub-viewport')!.append(frame);
  Object.defineProperty(frame,'sandbox',{value:{contains:()=>false}});
  const doc=frame.contentDocument!,win=frame.contentWindow!,registry=new Map<string,{range:Range}>();
  doc.body.innerHTML=bodyHtml;
  Object.defineProperty(win,'CSS',{value:{highlights:registry}});
  Object.defineProperty(win,'Highlight',{value:class{constructor(readonly range:Range){}}});
  const contents={window:win,document:doc,sectionIndex,range:(cfi:string)=>new EpubCFI(cfi).toRange(doc)};
  const hook=active.r.hooks.content.register.mock.calls[0][0] as (c:typeof contents)=>void;
  hook(contents);
  return {doc,frame,registry};
 }
 // The display promise can resolve before the destination frame is attached.
 const unrelated=attachFrame(body,1);expect(unrelated.registry.has('reader-search-hit')).toBe(false);
 const stale=attachFrame(body.replaceAll('ba</em>nk','po</em>rt'));expect(stale.registry.has('reader-search-hit')).toBe(false);
 const first=attachFrame();
 const exact=first.registry.get('reader-search-hit')!.range;
 expect(exact.startContainer).toBe(first.doc.querySelectorAll('em')[1].firstChild);
 expect(exact.endContainer).toBe(first.doc.querySelectorAll('em')[1].nextSibling);
 expect(exact.toString()).toBe('bank');expect(first.registry.get('reader-quotes')?.range.toString()).toBe('ba');
 expect(first.doc.getSelection()?.rangeCount).toBe(0);
 // Render the chapter again and verify the current range is resolved in its new DOM.
 first.frame.remove();const redrawn=attachFrame();
 expect(first.registry.has('reader-search-hit')).toBe(false);
 expect(redrawn.registry.get('reader-search-hit')?.range.startContainer).toBe(redrawn.doc.querySelectorAll('em')[1].firstChild);
 await panel('Поиск');await act(async()=>results()[0].click());
 expect(active.r.display.mock.lastCall![0]).not.toBe(secondCfi);
 expect(redrawn.registry.get('reader-search-hit')?.range.startContainer).toBe(redrawn.doc.querySelector('em')!.firstChild);
 await panel('Поиск');await click('Закрыть панель');expect(redrawn.registry.has('reader-search-hit')).toBe(true);
 await click('Следующий экран');
 expect(redrawn.registry.has('reader-search-hit')).toBe(false);expect(redrawn.registry.has('reader-quotes')).toBe(true);
 await panel('Поиск');await act(async()=>results()[1].click());
 await act(async()=>active.relocate(point(999)));
 expect(redrawn.registry.has('reader-search-hit')).toBe(false);
 await panel('Поиск');await act(async()=>results()[1].click());await input('Поиск по книге','new');
 expect(redrawn.registry.has('reader-search-hit')).toBe(false);expect(redrawn.doc.body.innerHTML).toBe(body);
 expect(attachFrame().registry.has('reader-search-hit')).toBe(false);
 await search();await done();await act(async()=>results()[1].click());
 expect(redrawn.registry.has('reader-search-hit')).toBe(true);
 await act(async()=>root.render(null));
 expect(redrawn.registry.has('reader-search-hit')).toBe(false);
 expect(onQuotesChange).not.toHaveBeenCalled();
});

it.each(['epub','fb2'] as const)('edits the entire clicked saved passage in a %s iframe by ID, preserving repeats and cancel',async kind=>{
 const onQuotesChange=vi.fn(),html='<p>Montreal <em>General</em> Hospital, Montreal <em>General</em> Hospital, Elsewhere.</p>';
 const sample=new DOMParser().parseFromString(html,'text/html');
 const makeRange=(doc:Document,second:boolean)=>{
  const p=doc.querySelector('p')!,range=doc.createRange(),index=second?2:0;
  range.setStart(p.childNodes[index],second?11:0);
  range.setEnd(p.childNodes[index+2],10);
  return range;
 };
 const quotes=[false,true].map((second,i)=>{
  const range=makeRange(sample,second);
  return {kind,id:'saved-'+i,chapter:'One',text:range.toString(),cfi:new EpubCFI(range,'/6/2[one]').toString(),createdAt:9+i,...(second?{comment:'Исходная заметка'}:{})};
 });
 expect(quotes.map(q=>q.text)).toEqual(['Montreal General Hospital,','Montreal General Hospital,']);
 mocks.convert.mockResolvedValue({blob:book.blob,warnings:[]});
 await act(async()=>root.render(<EpubReader book={{...book,kind}} onProgress={onProgress} quotes={quotes} onQuotesChange={onQuotesChange}/>));
 const frame=document.createElement('iframe');node.querySelector('.er-epub-viewport')!.append(frame);
 Object.defineProperty(frame,'sandbox',{value:{contains:()=>false}});
 const doc=frame.contentDocument!,win=frame.contentWindow!,registry=new Map();doc.body.innerHTML=html;
 Object.defineProperty(win,'CSS',{value:{highlights:registry}});
 Object.defineProperty(win,'Highlight',{value:class{ranges:Range[];constructor(...ranges:Range[]){this.ranges=ranges;}}});
 const contents={window:win,document:doc,sectionIndex:0,range:(cfi:string)=>{
  const range=new EpubCFI(cfi).toRange(doc);
  Object.defineProperty(range,'getClientRects',{value:()=>[new DOMRect(cfi===quotes[0].cfi?20:240,80,165,20)]});
  return range;
 }};
 (active.r.hooks.content.register.mock.calls[0][0] as (c:typeof contents)=>void)(contents);
 const target=doc.querySelectorAll('em')[1];
 async function hit(x:number,init:MouseEventInit={},el:Element=target){await act(async()=>el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:90,...init})));}
 const dialog=()=>node.querySelector<HTMLElement>('[role="dialog"][data-quote-tools]');
 registry.set('reader-search-hit',{});
 // Some wrapped ranges share line geometry; the native caret must still be in the saved range.
 Object.defineProperty(doc,'caretPositionFromPoint',{configurable:true,value:()=>({offsetNode:doc.querySelector('em')!.firstChild!,offset:2})});
 await hit(260);expect(dialog()).toBeNull();Reflect.deleteProperty(doc,'caretPositionFromPoint');
 await hit(420);await hit(260,{altKey:true});await hit(260,{shiftKey:true});expect(dialog()).toBeNull();
 const ordinarySelection=makeRange(doc,true);doc.getSelection()!.addRange(ordinarySelection);
 await hit(260);expect(dialog()).toBeNull();doc.getSelection()!.removeAllRanges();
 const link=doc.createElement('a');target.append(link);await hit(260,{},link);expect(dialog()).toBeNull();link.remove();
 await hit(260);
 expect(dialog()?.querySelector('blockquote')?.textContent).toBe(quotes[1].text);
 const field=dialog()!.querySelector('textarea')!;expect(field.value).toBe('Исходная заметка');expect(document.activeElement).toBe(field);
 async function type(field:HTMLTextAreaElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});}
 await type(field,'Отменить');await click('Отмена');expect(onQuotesChange).not.toHaveBeenCalled();expect(doc.body.innerHTML).toBe(html);
 await hit(260);expect(dialog()!.querySelector('textarea')!.value).toBe('Исходная заметка');
 await type(dialog()!.querySelector('textarea')!,'Новая заметка');await click('Сохранить');
 expect(onQuotesChange).toHaveBeenCalledOnce();expect(onQuotesChange.mock.lastCall?.[0]).toEqual([quotes[0],{...quotes[1],comment:'Новая заметка'}]);
 await panel('Цитаты');const edit=button('Добавить комментарий');edit.focus();await act(async()=>edit.click());
 expect(dialog()!.querySelector('textarea')!.value).toBe('');
 await act(async()=>dialog()!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 expect(document.activeElement).toBe(edit);expect(onQuotesChange).toHaveBeenCalledOnce();
 const targetRow=node.querySelectorAll('.rc-quotes li')[1];
 const remove=Array.from(targetRow.querySelectorAll('button')).find(b=>b.textContent==='Удалить цитату')!;
 await act(async()=>remove.click());
 const confirm=()=>node.querySelector<HTMLElement>('[role="alertdialog"]')!;
 expect(confirm().querySelector('blockquote')!.textContent).toBe(quotes[1].text);expect(document.activeElement?.textContent).toBe('Оставить');
 await act(async()=>confirm().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 expect(document.activeElement).toBe(remove);expect(onQuotesChange).toHaveBeenCalledOnce();
 await act(async()=>remove.click());await act(async()=>confirm().querySelector<HTMLButtonElement>('.er-quote-danger')!.click());
 const remaining=onQuotesChange.mock.lastCall![0];expect(remaining).toEqual([quotes[0]]);expect(document.activeElement).toBe(node.querySelector('.rc-panel'));
 await act(async()=>root.render(<EpubReader book={{...book,kind}} onProgress={onProgress} quotes={remaining} onQuotesChange={onQuotesChange}/>));
 const ranges:Range[]=registry.get('reader-quotes').ranges;expect(ranges).toHaveLength(1);
 expect(ranges[0].startContainer).toBe(doc.querySelector('p')!.firstChild);expect(registry.has('reader-search-hit')).toBe(true);
 expect(node.querySelectorAll('.rc-quotes li')).toHaveLength(1);await hit(260);expect(dialog()).toBeNull();
});
