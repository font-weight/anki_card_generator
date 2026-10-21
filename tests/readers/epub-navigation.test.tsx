import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EpubReader} from '../../apps/extension/src/readers/EpubReader';
import type {DocumentReady,ReadingProgress,StoredBook} from '../../apps/extension/src/readers/types';

const mocks=vi.hoisted(()=>({epub:vi.fn(),unpack:vi.fn(),prepare:vi.fn(),convert:vi.fn()}));
vi.mock('epubjs',()=>({default:mocks.epub}));
vi.mock('../../apps/extension/src/readers/epub-security',()=>({unpackEpub:mocks.unpack,prepareSafeEpub:mocks.prepare}));
vi.mock('../../apps/extension/src/readers/fb2',()=>({convertFb2ToEpub:mocks.convert}));
const nav={toc:[{id:'one',href:'one.xhtml',label:'Глава 1',subitems:[{id:'nested',href:'one.xhtml#nested',label:'Подраздел'}]},{id:'two',href:'two.xhtml',label:'Глава 2'}]};
const position=(page=1,options:Record<string,unknown>={})=>({start:{href:'one.xhtml',cfi:`cfi-${page}`,index:0,displayed:{page,total:4}},end:{href:'one.xhtml',cfi:`cfi-${page}`,index:0,displayed:{page,total:4}},atStart:page===1,atEnd:false,...options});
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function engine(options:{ready?:Promise<void>;navigation?:Promise<typeof nav>}={}){
 const events=new Map<string,Set<(...args:any[])=>void>>(),hooks:{content:((contents:any)=>void)[];serialize:((output:string,section:{output:string})=>void)[]}={content:[],serialize:[]};
 let location=position();
 const r={
  hooks:{content:{register:(callback:(contents:any)=>void)=>hooks.content.push(callback)}},
  themes:{default:vi.fn(),fontSize:vi.fn(),override:vi.fn()},epubcfi:{compare:(a:string,b:string)=>Number(a.split('-')[1])-Number(b.split('-')[1])},
  on:(name:string,callback:(...args:any[])=>void)=>{if(!events.has(name))events.set(name,new Set());events.get(name)!.add(callback);},
  off:(name:string,callback:(...args:any[])=>void)=>events.get(name)?.delete(callback),
  display:vi.fn(async(target?:string)=>{if(target==='two.xhtml')location=position(1,{start:{href:'two.xhtml',cfi:'cfi-10',index:1,displayed:{page:1,total:3}},atStart:false});}),
  next:vi.fn(async()=>{location=position(location.start.displayed.page+1);}),prev:vi.fn(async()=>{location=position(location.start.displayed.page-1);}),
  currentLocation:vi.fn(()=>location),resize:vi.fn(),destroy:vi.fn(),
 };
 const book={ready:options.ready||Promise.resolve(),loaded:{navigation:options.navigation||Promise.resolve(nav)},spine:{hooks:{serialize:{register:(callback:(output:string,section:{output:string})=>void)=>hooks.serialize.push(callback)}},get:(target:string|number)=>({href:target===1||String(target).startsWith('two')?'two.xhtml':'one.xhtml'})},renderTo:vi.fn(()=>r),destroy:vi.fn(()=>r.destroy())};
 return {book,r,hooks,emit:(name:string,value:any)=>{if(name==='relocated')location=value;events.get(name)?.forEach(callback=>callback(value));}};
}
let node:HTMLDivElement,root:ReturnType<typeof createRoot>,safeDispose:ReturnType<typeof vi.fn>,size:{width:number;height:number},observers:(()=>void)[];
let active:ReturnType<typeof engine>,book:StoredBook,onProgress:ReturnType<typeof vi.fn<(progress:ReadingProgress)=>void>>,onDocumentReady:DocumentReady|undefined;
const bytes=new ArrayBuffer(8),safeBytes=new ArrayBuffer(3);
async function render(value=book){await act(async()=>{root.render(<EpubReader book={value} onProgress={onProgress} onDocumentReady={onDocumentReady}/>);});}
function button(label:string){return node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;}
function surface(){return node.querySelector<HTMLDivElement>('.er-epub-viewport')!;}
async function key(target:EventTarget,key:string,options:KeyboardEventInit={}){let event!:KeyboardEvent;await act(async()=>{event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);});return event;}
async function change(select:HTMLSelectElement,value:string){await act(async()=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));});}
function content(){
 const frame=document.createElement('iframe');surface().append(frame);frame.setAttribute('sandbox','allow-same-origin');Object.defineProperty(frame,'sandbox',{value:{contains:()=>false}});
 const doc=frame.contentDocument!;doc.body.innerHTML='<p id="first">The bank was green.</p><h2 id="nested">Subsection</h2><p>Second exact sentence.</p>';
 const contents={window:frame.contentWindow!,document:doc,sectionIndex:0,cfiFromNode:(node:Element)=>node.id==='nested'?'cfi-3':'cfi-1'};
 active.hooks.content[0](contents);return {frame,doc,contents};
}
beforeEach(()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;node=document.createElement('div');document.body.append(node);root=createRoot(node);
 vi.clearAllMocks();safeDispose=vi.fn();size={width:390,height:600};observers=[];
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('er-epub-viewport')?size.width:0;});
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockImplementation(function(this:HTMLElement){return this.classList.contains('er-epub-viewport')?size.height:0;});
 vi.stubGlobal('ResizeObserver',class {constructor(callback:()=>void){observers.push(callback);}observe(){}disconnect(){}});
 mocks.unpack.mockResolvedValue({mimetype:new Uint8Array()});mocks.prepare.mockImplementation(()=>({data:safeBytes,dispose:safeDispose,warnings:['Безопасное чтение']}));
 active=engine();mocks.epub.mockReturnValue(active.book);onProgress=vi.fn();onDocumentReady=undefined;
 book={documentId:'sha256:first',kind:'epub',title:'Книга',addedAt:0,size:8,blob:{arrayBuffer:async()=>bytes} as Blob};
});
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.unstubAllGlobals();vi.useRealTimers();});

describe('EPUB / FB2 navigation',()=>{
 it('opens only sanitized bytes, uses real section screens and true boundaries, and controls hierarchical TOC',async()=>{
  await render();
  expect(mocks.unpack).toHaveBeenCalledWith(bytes);expect(mocks.epub).toHaveBeenCalledWith(safeBytes,{replacements:'none'});
  expect(active.book.renderTo).toHaveBeenCalledWith(surface(),expect.objectContaining({width:'100%',allowScriptedContent:false,spread:'none'}));
  expect(node.textContent).toContain('Экран 1 из 4');expect(node.textContent).toContain('в разделе файла');expect(node.textContent).toContain('Начало книги');expect(node.textContent).not.toMatch(/\d+%/);
  expect(button('Предыдущий экран').disabled).toBe(true);expect(button('Следующий экран').disabled).toBe(false);
  const toc=node.querySelector<HTMLSelectElement>('[aria-label="Раздел оглавления"]')!;expect(toc.value).toBe('0');expect(toc.options[2].textContent).toContain('↳ Подраздел');
  await change(toc,'2');expect(active.r.display).toHaveBeenLastCalledWith('two.xhtml');expect(toc.value).toBe('2');expect(node.textContent).toContain('Экран 1 из 3');
  await act(async()=>active.emit('relocated',position(4,{atStart:false,atEnd:true})));
  expect(button('Следующий экран').disabled).toBe(true);expect(node.textContent).toContain('Конец книги');
  await key(surface(),'ArrowRight');expect(active.r.next).not.toHaveBeenCalled();
 });
 it('never invents screen totals when epub.js has not supplied valid displayed locations',async()=>{
  await render();await act(async()=>active.emit('relocated',position(1,{start:{href:'one.xhtml',cfi:'cfi-1',displayed:{page:1,total:0}}})));
  expect(node.textContent).toContain('Положение уточняется');expect(node.textContent).not.toContain('Экран 1 из 0');
 });
 it('uses section anchor CFIs for the current nested entry without rewriting the text or selection',async()=>{
  const cleanup=vi.fn(),callback=vi.fn(()=>cleanup);onDocumentReady=callback;await render();
  const {doc,frame}=content();const original=doc.body.innerHTML,range=doc.createRange();range.setStart(doc.querySelector('p')!.firstChild!,4);range.setEnd(doc.querySelector('p')!.firstChild!,8);doc.getSelection()!.addRange(range);
  await act(async()=>active.emit('relocated',position(3)));
  expect(node.querySelector<HTMLSelectElement>('[aria-label="Раздел оглавления"]')!.value).toBe('1');
  expect(doc.body.innerHTML).toBe(original);expect(doc.getSelection()?.toString()).toBe('bank');expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
  const source=(callback.mock.calls[0] as unknown as [Document,()=>unknown])[1]();expect(source).toEqual(expect.objectContaining({kind:'epub',chapter:'Подраздел',cfi:'cfi-3',page:null,documentId:book.documentId}));
  frame.remove();await act(async()=>active.emit('relocated',position(4)));expect(cleanup).toHaveBeenCalledOnce();
 });
 it('serializes rapid buttons/keys and leaves navigation enabled after completion or a rejected move',async()=>{
  await render();const pending=deferred();active.r.next.mockImplementationOnce(()=>pending.promise);
  await act(async()=>{button('Следующий экран').click();button('Следующий экран').click();surface().dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true,cancelable:true}));});
  expect(active.r.next).toHaveBeenCalledOnce();expect(button('Следующий экран').disabled).toBe(true);
  await act(async()=>pending.resolve());expect(button('Следующий экран').disabled).toBe(false);
  active.r.next.mockRejectedValueOnce(new Error('broken section'));await act(async()=>button('Следующий экран').click());expect(node.querySelector('[role="alert"]')?.textContent).toContain('broken section');expect(button('Следующий экран').disabled).toBe(false);
  await act(async()=>button('Следующий экран').click());expect(node.querySelector('[role="alert"]')).toBeNull();
 });
 it('pages from the focused book and its iframe but not from typing, select/range, IME, modifiers, repeat, selection or popup',async()=>{
  await render();
  const {doc}=content();
  const first=await key(surface(),'ArrowRight');expect(first.defaultPrevented).toBe(true);expect(active.r.next).toHaveBeenCalledTimes(1);
  await key(doc.body,'PageDown');expect(active.r.next).toHaveBeenCalledTimes(2);
  for(const options of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},{isComposing:true},{keyCode:229},{repeat:true}])await key(doc.body,'ArrowRight',options);
  for(const tag of ['input','select','textarea','button']){
   const field=document.createElement(tag);if(tag==='input')field.setAttribute('type','range');if(tag==='button')field.setAttribute('role','slider');doc.body.append(field);await key(field,'ArrowRight');
  }
  const editable=doc.createElement('div');editable.setAttribute('contenteditable','true');doc.body.append(editable);await key(editable,'ArrowRight');
  await key(node.querySelector('input[type="range"]')!,'ArrowRight');await key(node.querySelector('select')!,'ArrowRight');
  const range=doc.createRange();range.selectNodeContents(doc.querySelector('p')!);doc.getSelection()!.addRange(range);await key(surface(),'ArrowRight');doc.getSelection()!.removeAllRanges();
  const popup=document.createElement('div');popup.dataset.englishReaderPopup='';document.body.append(popup);await key(doc.body,'PageDown');popup.remove();
  await key(document.body,'PageDown');expect(active.r.next).toHaveBeenCalledTimes(2);
  await key(doc.body,'PageUp');expect(active.r.prev).toHaveBeenCalledOnce();
 });
 it('measures responsive width and restores the current CFI after font and resize changes',async()=>{
  await render();await act(async()=>active.emit('relocated',position(3)));
  expect(active.r.resize).toHaveBeenCalledWith(390,600,'cfi-1');
  const range=node.querySelector<HTMLInputElement>('[aria-label="Размер шрифта"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(range,'24');range.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(active.r.themes.fontSize).toHaveBeenLastCalledWith('24px');expect(active.r.display).toHaveBeenLastCalledWith('cfi-3');
  size={width:310,height:420};await act(async()=>observers.forEach(callback=>callback()));
  expect(active.r.resize).toHaveBeenLastCalledWith(310,420,'cfi-3');expect(active.r.display).toHaveBeenLastCalledWith('cfi-3');expect(surface().style.maxWidth).toBe('');
 });
 it('defers layout changes during a move and preserves the new, not stale, CFI',async()=>{
  await render();const pending=deferred();active.r.next.mockImplementationOnce(()=>pending.promise);
  await act(async()=>button('Следующий экран').click());size.width=320;await act(async()=>observers.forEach(callback=>callback()));
  await act(async()=>{active.emit('relocated',position(2));pending.resolve();});
  expect(active.r.resize).toHaveBeenLastCalledWith(320,600,'cfi-2');expect(active.r.display).toHaveBeenLastCalledWith('cfi-2');
 });
 it('does not create a stale rendition after navigating away while navigation data is pending',async()=>{
  const oldNav=deferred<typeof nav>();const old=engine({navigation:oldNav.promise});mocks.epub.mockReturnValueOnce(old.book).mockReturnValue(active.book);
  await render();expect(old.book.renderTo).not.toHaveBeenCalled();
  await render({...book,documentId:'sha256:new',title:'Новая книга'});expect(active.book.renderTo).toHaveBeenCalledOnce();
  await act(async()=>oldNav.resolve(nav));expect(old.book.renderTo).not.toHaveBeenCalled();expect(old.book.destroy).toHaveBeenCalledOnce();expect(active.book.destroy).not.toHaveBeenCalled();
 });
 it('ignores a pending old move and destroys only its own resources after a book switch',async()=>{
  await render();const old=active,pending=deferred();old.r.next.mockImplementationOnce(()=>pending.promise);await act(async()=>button('Следующий экран').click());
  active=engine();mocks.epub.mockReturnValue(active.book);await render({...book,documentId:'sha256:new'});onProgress.mockClear();
  await act(async()=>{old.emit('relocated',position(4));pending.reject(new Error('old navigation failed'));});
  expect(node.textContent).not.toContain('old navigation failed');expect(node.textContent).toContain('Экран 1 из 4');expect(onProgress).not.toHaveBeenCalled();expect(old.book.destroy).toHaveBeenCalledOnce();expect(active.book.destroy).not.toHaveBeenCalled();
 });
 it('cleans iframe activation and keyboard handlers when closed, including during a pending move',async()=>{
  const cleanup=vi.fn();onDocumentReady=()=>cleanup;await render();const {doc}=content();const pending=deferred();active.r.next.mockImplementationOnce(()=>pending.promise);await key(doc.body,'PageDown');
  await act(async()=>root.render(<div>Closed</div>));expect(cleanup).toHaveBeenCalledOnce();expect(safeDispose).toHaveBeenCalledOnce();
  await key(doc.body,'PageDown');expect(active.r.next).toHaveBeenCalledOnce();await act(async()=>pending.resolve());expect(node.textContent).toBe('Closed');
 });
 it('bounds a hung display and provides a retry without reopening the old session',async()=>{
  vi.useFakeTimers();active.r.display.mockImplementationOnce(()=>new Promise(()=>{}));await render();
  await act(async()=>vi.advanceTimersByTime(30001));expect(node.querySelector('[role="alert"]')?.textContent).toContain('Повторите открытие');
  const old=active;active=engine();mocks.epub.mockReturnValue(active.book);await act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent==='Повторить открытие')!.click());
  expect(old.book.destroy).toHaveBeenCalledOnce();expect(node.textContent).toContain('Экран 1 из 4');
 });
 it('handles displayError without waiting for a never-rejecting epub.js display promise',async()=>{
  const pending=deferred();active.r.display.mockImplementationOnce(()=>pending.promise);await render();
  await act(async()=>active.emit('displayError',new Error('invalid CFI')));
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('invalid CFI');expect(button('Следующий экран').disabled).toBe(true);
  await act(async()=>pending.resolve());expect(node.textContent).not.toContain('Экран 1 из 4');
 });
 it('allows explicit recovery from an invalid saved CFI without discarding another book’s saved position',async()=>{
  active.r.display.mockRejectedValueOnce(new Error('invalid saved CFI'));const stored={...book,progress:{cfi:'missing-cfi',chapter:'Old',updatedAt:0}};await render(stored);
  expect(active.r.display).toHaveBeenCalledWith('missing-cfi');expect(button('Следующий экран').disabled).toBe(true);
  active=engine();mocks.epub.mockReturnValue(active.book);await act(async()=>[...node.querySelectorAll('button')].find(button=>button.textContent==='Открыть с начала')!.click());
  expect(active.r.display.mock.calls[0]).toEqual([undefined]);expect(node.textContent).toContain('Экран 1 из 4');
  active=engine();mocks.epub.mockReturnValue(active.book);await render({...stored,documentId:'sha256:other',progress:{cfi:'other-cfi',updatedAt:0}});
  expect(active.r.display.mock.calls[0]).toEqual(['other-cfi']);
 });
 it('preserves CR text through epub.js final XML serialization before the iframe HTML parse',async()=>{
  await render();const parsed=new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>Exact&#13;bank&#10;text</p></body></html>','application/xml');
  const section={output:new XMLSerializer().serializeToString(parsed)};expect(section.output).toContain('\r');
  expect(active.hooks.serialize).toHaveLength(1);active.hooks.serialize[0](section.output,section);
  const iframeDocument=new DOMParser().parseFromString(section.output,'text/html');expect(iframeDocument.querySelector('p')?.textContent).toBe('Exact\rbank\ntext');
 });
 it('does not construct a renderer or sanitizer after a closed book finishes local conversion',async()=>{
  const pending=deferred<{blob:Blob;title:string;warnings:string[]}>();mocks.convert.mockReturnValueOnce(pending.promise);await render({...book,kind:'fb2'});
  await act(async()=>root.render(<div>Closed</div>));await act(async()=>pending.resolve({blob:book.blob,title:'Late',warnings:[]}));
  expect(mocks.unpack).not.toHaveBeenCalled();expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.epub).not.toHaveBeenCalled();expect(node.textContent).toBe('Closed');
 });
 it('converts FB2 locally before the same sanitizer and retains original source identity and warnings',async()=>{
  const convertedBytes=new ArrayBuffer(11);mocks.convert.mockResolvedValue({blob:{arrayBuffer:async()=>convertedBytes},title:'Конвертированная',warnings:['Изображения пропущены']});
  const callback=vi.fn();onDocumentReady=callback;await render({...book,kind:'fb2'});content();
  expect(mocks.convert).toHaveBeenCalledWith(book.blob,book.title);expect(mocks.unpack).toHaveBeenCalledWith(convertedBytes);expect(mocks.epub).toHaveBeenCalledWith(safeBytes,{replacements:'none'});expect(node.textContent).toContain('Изображения пропущены');
  expect((callback.mock.calls[0] as unknown as [Document,()=>unknown])[1]()).toEqual(expect.objectContaining({kind:'fb2',documentId:book.documentId,title:book.title,url:null,page:null}));
 });
});
