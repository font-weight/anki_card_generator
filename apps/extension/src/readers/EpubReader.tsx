import React,{useEffect,useId,useRef,useState} from 'react';
import ePub,{type Book,type Contents,type Location,type Rendition} from 'epubjs';
import {prepareSafeEpub,unpackEpub,type SafeEpub} from './epub-security';
import {convertFb2ToEpub} from './fb2';
import {READER_BOOKMARK_LIMIT,READER_BOOKMARK_LABEL_MAX,type DocumentReady,type ReadingProgress,type StoredBook,type ReaderAppearance,type ReaderBookmark} from './types';
import './epub-reader.css';

interface Props {book:StoredBook;onProgress:(progress:ReadingProgress)=>void;onDocumentReady?:DocumentReady;bookmarks?:ReaderBookmark[];onBookmarksChange?:(next:ReaderBookmark[])=>void;appearance?:ReaderAppearance;onAppearanceChange?:(next:ReaderAppearance)=>void;persistenceMode?:'persistent'|'session'}
type EpubAppearance=Extract<ReaderAppearance,{kind:'epub'|'fb2'}>;
interface TocItem {id:string;href:string;label:string;subitems?:TocItem[]}
interface TocEntry {key:string;href:string;label:string;depth:number}
interface Position {tocKey:string;chapter:string;page?:number;total?:number;atStart:boolean;atEnd:boolean}
interface Session {navigate:(target:'prev'|'next'|{href:string}|{cfi:string})=>boolean;refresh:()=>void;keydown:(event:KeyboardEvent)=>void;search:(query:string,signal:AbortSignal,update:(state:EpubSearchState)=>void)=>Promise<void>}
const emptyPosition:Position={tocKey:'',chapter:'',atStart:false,atEnd:false};
class RendererTimeoutError extends Error {}
const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);
function pathOf(href:string):string {
 const path=href.split('#')[0];
 try{return decodeURIComponent(path).replace(/^\.\//,'');}catch{return path;}
}
function flatten(items:TocItem[]):TocEntry[] {
 const result:TocEntry[]=[],stack=items.map(item=>({item,depth:0})).reverse();
 while(stack.length){const {item,depth}=stack.pop()!;if(typeof item.href==='string'&&item.href)result.push({key:String(result.length),href:item.href,label:item.label.trim()||'Без названия',depth});for(const child of [...(item.subitems||[])].reverse())stack.push({item:child,depth:depth+1});}
 return result;
}
function hasSelection(doc:Document):boolean {const selection=doc.getSelection();return !!selection&&!selection.isCollapsed;}
function blocksPaging(event:KeyboardEvent,documents:Iterable<Document>):boolean {
 if(event.defaultPrevented||event.isComposing||event.keyCode===229||event.repeat||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return true;
 const controls='input,textarea,select,button,summary,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="slider"],[role="dialog"],[data-english-reader-popup]';
 // Use nodeType, not instanceof Element: targets can belong to a sandbox iframe realm.
 if(event.composedPath().some(node=>(node as Element)?.nodeType===1&&(node as Element).closest(controls)))return true;
 for(const doc of documents)if(hasSelection(doc)||doc.querySelector('[data-english-reader-popup],[role="dialog"]:not([hidden])'))return true;
 return false;
}

const SEARCH_RESULT_LIMIT=100,SEARCH_SECTION_LIMIT=500,SEARCH_SECTION_CHARS=2_000_000,SEARCH_TOTAL_CHARS=12_000_000,SEARCH_NODE_LIMIT=50_000;
export interface EpubSearchResult {cfi:string;chapter:string;excerpt:string}
export interface EpubSearchState {results:EpubSearchResult[];scanned:number;total:number;running:boolean;capped:boolean;partial:boolean;error:string}
const emptySearch:EpubSearchState={results:[],scanned:0,total:0,running:false,capped:false,partial:false,error:''};
/** Conservative CFI grammar: never let a persisted/search target become a URL. */
export function isSafeEpubCfi(value:string):boolean {
 if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\u007f]/.test(value))return false;
 const step='/[1-9]\\d*(?:\\[[^\\[\\]!:(),]*\\])?',component=`(?:${step})+(?::\\d+)?`;
 const match=value.match(new RegExp(`^epubcfi\\(${step}/([1-9]\\d*)(?:\\[[^\\[\\]!:(),]*\\])?!${component}(?:,${component},${component})?\\)$`));
 return !!match&&Number.isSafeInteger(+match[1])&&+match[1]%2===0;
}
function abortSearch(signal:AbortSignal):void {if(signal.aborted)throw new DOMException('Поиск отменён','AbortError');}
function pauseSearch(signal:AbortSignal):Promise<void>{return searchWait(new Promise<void>(resolve=>setTimeout(resolve,0)),signal);}
function searchWait<T>(value:Promise<T>|T,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  let timer:ReturnType<typeof setTimeout>;
  const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);};
  const cancel=()=>{clean();reject(new DOMException('Поиск отменён','AbortError'));};
  if(signal.aborted){cancel();return;}
  signal.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>{clean();reject(new Error('Раздел не отвечает. Повторите поиск.'));},10000);
  Promise.resolve(value).then(result=>{clean();resolve(result);},error=>{clean();reject(error);});
 });
}
/** Read only the sanitized in-memory archive. No Section.load/network fallback,
 * retained index, renderer mutation or Section.find's unbounded synchronous loop. */
export async function searchSafeEpubSpine(instance:Book,query:string,signal:AbortSignal,update:(state:EpubSearchState)=>void):Promise<void>{
 const literal=query.trim().slice(0,200);if(!literal)return;
 if(!instance.archived||!instance.archive?.getText)throw new Error('Локальный архив книги недоступен');
 const sections:ReturnType<Book['spine']['get']>[]=[],results:EpubSearchResult[]=[];let sectionCount=0,scanned=0,characters=0,candidates=0,partial=false,capped=false;
 instance.spine.each((section:ReturnType<Book['spine']['get']>)=>{sectionCount++;if(sections.length<SEARCH_SECTION_LIMIT)sections.push(section);});
 partial=sectionCount>SEARCH_SECTION_LIMIT;
 const report=(running:boolean)=>{abortSearch(signal);update({results:[...results],scanned,total:sectionCount,running,capped,partial,error:''});};
 const pattern=new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');
 report(true);
 for(const section of sections){
  abortSearch(signal);await pauseSearch(signal);
  try{
   // archive.getText performs a ZIP entry lookup only. Reject URL-shaped targets
   // even though the archive itself cannot issue an external request.
   if(!section.url?.startsWith('/')||section.url.startsWith('//')||/[\\\u0000-\u001f]/.test(section.url)||/^[a-z][a-z\d+.-]*:/i.test(section.href)){partial=true;continue;}
   const xml=await searchWait(instance.archive.getText(section.url),signal);abortSearch(signal);
   if(typeof xml!=='string'||xml.length>SEARCH_SECTION_CHARS){partial=true;continue;}
   characters+=xml.length;if(characters>SEARCH_TOTAL_CHARS){partial=true;break;}
   // Match the renderer's final iframe HTML parse, including automatic tbody
   // insertion. Section content hooks alter only head; body offsets stay exact.
   const doc=new DOMParser().parseFromString(xml,'text/html'),body=doc.querySelector('body');
   if(!body||doc.querySelector('parsererror')){partial=true;continue;}
   const walker=doc.createTreeWalker(body,NodeFilter.SHOW_TEXT),segments:{node:Text;start:number;end:number}[]=[];let text='',node:Node|null,count=0,lastBlock:Element|null=null;
   while((node=walker.nextNode())){
    if(++count>SEARCH_NODE_LIMIT){partial=true;break;}
    const block=node.parentElement?.closest('p,div,li,blockquote,pre,h1,h2,h3,h4,h5,h6,td,th,section,article')||body;
    if(lastBlock&&block!==lastBlock)text+='\n';lastBlock=block;
    const value=node.textContent||'',start=text.length;text+=value;segments.push({node:node as Text,start,end:text.length});
    if(count%200===0)await pauseSearch(signal);
   }
   pattern.lastIndex=0;let match:RegExpExecArray|null,segmentIndex=0;
   while((match=pattern.exec(text))){
    abortSearch(signal);if(++candidates>1000){partial=true;break;}if(candidates%20===0)await pauseSearch(signal);
    const start=match.index,end=start+match[0].length;
    while(segmentIndex<segments.length&&segments[segmentIndex].end<=start)segmentIndex++;
    const first=segments[segmentIndex];let endIndex=segmentIndex;while(endIndex<segments.length&&segments[endIndex].end<end)endIndex++;
    const last=segments[endIndex];if(!first||!last||start<first.start)continue;
    const range=doc.createRange();range.setStart(first.node,start-first.start);range.setEnd(last.node,end-last.start);
    const cfi=section.cfiFromRange(range);if(!isSafeEpubCfi(cfi)){partial=true;continue;}
    results.push({cfi,chapter:section.href,excerpt:(start>65?'…':'')+text.slice(Math.max(0,start-65),Math.min(text.length,end+95)).replace(/\s+/g,' ')+(end+95<text.length?'…':'')});
    if(results.length>=SEARCH_RESULT_LIMIT){capped=true;break;}
    if(results.length%20===0)await pauseSearch(signal);
   }
  }catch(reason){if(signal.aborted)throw reason;partial=true;}
  finally{scanned++;if(!signal.aborted)report(true);}
  if(capped||candidates>1000)break;
 }
 report(false);
}

export function EpubReader({book,onProgress,onDocumentReady,bookmarks:savedBookmarks,onBookmarksChange,appearance:savedAppearance,onAppearanceChange,persistenceMode='session'}:Props){
 const host=useRef<HTMLDivElement>(null),reader=useRef<HTMLElement>(null),session=useRef<Session|undefined>(undefined);
 const current=useRef({cfi:book.progress?.cfi||'',chapter:book.progress?.chapter||''});
 const progressRef=useRef(onProgress),readyRef=useRef(onDocumentReady);progressRef.current=onProgress;readyRef.current=onDocumentReady;
 const [toc,setToc]=useState<TocEntry[]>([]),[position,setPosition]=useState<Position>(emptyPosition),[error,setError]=useState('');
 const [loading,setLoading]=useState(true),[opened,setOpened]=useState(false),[startAtBeginningFor,setStartAtBeginningFor]=useState<string>(),[moving,setMoving]=useState(false),[warnings,setWarnings]=useState<string[]>([]),[retry,setRetry]=useState(0);
 const initialAppearance: EpubAppearance=savedAppearance?.kind===book.kind&&savedAppearance.kind!=='pdf'?savedAppearance:{kind:book.kind==='fb2'?'fb2':'epub',fontSize:20,width:'comfortable',lineHeight:1.7,theme:'light'};
 const [style,setStyle]=useState<EpubAppearance>(initialAppearance),[localBookmarks,setLocalBookmarks]=useState<ReaderBookmark[]>(savedBookmarks||[]),[bookmarkLabel,setBookmarkLabel]=useState(''),[bookmarkNotice,setBookmarkNotice]=useState('');
 const [query,setQuery]=useState(''),[search,setSearch]=useState<EpubSearchState>(emptySearch),searchControl=useRef<AbortController|undefined>(undefined);
 const {fontSize:font,width,lineHeight:line,theme}=style,bookmarks=(savedBookmarks||localBookmarks).filter((mark):mark is Extract<ReaderBookmark,{kind:'epub'|'fb2'}>=>mark.kind===book.kind&&mark.kind!=='pdf');
 const appearance=useRef({font,line,theme});appearance.current={font,line,theme};
 useEffect(()=>{setStyle(initialAppearance);setLocalBookmarks(savedBookmarks||[]);setBookmarkLabel('');setBookmarkNotice('');},[book.documentId]);
 useEffect(()=>{if(savedAppearance&&savedAppearance.kind===book.kind&&savedAppearance.kind!=='pdf')setStyle(savedAppearance);},[savedAppearance]);
 const changeAppearance=(next:Partial<EpubAppearance>)=>{const value={...style,...next};setStyle(value);onAppearanceChange?.(value);};
 const changeBookmarks=(next:ReaderBookmark[])=>{setLocalBookmarks(next);onBookmarksChange?.(next);};
 const addBookmark=()=>{
  if(!isSafeEpubCfi(current.current.cfi))return;
  if(bookmarks.some(mark=>mark.cfi===current.current.cfi)){setBookmarkNotice('Это место уже есть в закладках.');return;}
  if(bookmarks.length>=READER_BOOKMARK_LIMIT){setBookmarkNotice(`Можно сохранить до ${READER_BOOKMARK_LIMIT} закладок. Удалите ненужную.`);return;}
  changeBookmarks([...bookmarks,{id:crypto.randomUUID(),kind:book.kind==='fb2'?'fb2':'epub',label:(bookmarkLabel.trim()||current.current.chapter||'Закладка').slice(0,READER_BOOKMARK_LABEL_MAX),cfi:current.current.cfi,chapter:current.current.chapter.slice(0,500),createdAt:Date.now()}]);setBookmarkLabel('');setBookmarkNotice('Закладка добавлена.');
 };
 const startSearch=()=>{
  searchControl.current?.abort();const controller=new AbortController();searchControl.current=controller;const own=session.current;
  if(!query.trim()||!own){setSearch(emptySearch);return;}
  setSearch({...emptySearch,running:true});
  void own.search(query,controller.signal,value=>{if(!controller.signal.aborted&&session.current===own)setSearch(value);}).catch(reason=>{if(!controller.signal.aborted&&session.current===own)setSearch(value=>({...value,running:false,error:errorMessage(reason)}));});
 };
 const cancelSearch=()=>{searchControl.current?.abort();setSearch(value=>({...value,running:false,partial:value.running||value.partial}));};
 const helpId=useId(),viewportId=useId(),kind=book.kind==='fb2'?'FB2':'EPUB',ignoreSaved=startAtBeginningFor===book.documentId;

 useEffect(()=>{
  let cancelled=false,instance:Book|undefined,r:Rendition|undefined,safe:SafeEpub|undefined;
  let busy=true,ready=false,layoutPending=false,preservingCfi=false,lastLayout='';
  let failOperation:((error:unknown)=>void)|undefined,observer:ResizeObserver|undefined;
  let entries:TocEntry[]=[],lastPosition=emptyPosition;
  const anchors=new Map<string,string>(),documents=new Map<Document,()=>void>();
  current.current={cfi:ignoreSaved?'':book.progress?.cfi||'',chapter:ignoreSaved?'':book.progress?.chapter||''};
  searchControl.current?.abort();setQuery('');setSearch(emptySearch);
  setOpened(false);setLoading(true);setMoving(false);setError('');setWarnings([]);setToc([]);setPosition(emptyPosition);
  const pruneDocuments=()=>{for(const [doc,cleanup] of documents)if(!doc.defaultView?.frameElement?.isConnected){cleanup();documents.delete(doc);}};
  const located=(location:Location)=>{
   if(cancelled||preservingCfi||!location?.start?.cfi)return;
   pruneDocuments();
   const matching=entries.filter(item=>pathOf(item.href)===pathOf(location.start.href));
   let selected=matching.find(item=>!item.href.includes('#'));
   for(const item of matching){const cfi=anchors.get(item.key);if(cfi){try{if(r!.epubcfi.compare(cfi,location.start.cfi)<=0)selected=item;}catch{/* A malformed TOC anchor must not break reading. */}}}
   const chapter=selected?.label||location.start.href;
   const displayed=location.start.displayed;
   const valid=Number.isInteger(displayed?.page)&&Number.isInteger(displayed?.total)&&displayed.page>=1&&displayed.total>=displayed.page;
   lastPosition={tocKey:selected?.key||'',chapter,page:valid?displayed.page:undefined,total:valid?displayed.total:undefined,atStart:location.atStart===true,atEnd:location.atEnd===true};
   current.current={cfi:location.start.cfi,chapter};setPosition(lastPosition);
   progressRef.current({...current.current,updatedAt:Date.now()});
  };
  // epub.js 0.3.93 emits displayError without reliably rejecting display(). Bound
  // every renderer operation, and reject it on teardown rather than leaving busy UI.
  const bounded=async<T,>(operation:()=>Promise<T>|T):Promise<T>=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{failOperation=reject;timer=setTimeout(()=>reject(new RendererTimeoutError('Чтение не отвечает. Повторите открытие книги.')),30000);})]);}
   finally{clearTimeout(timer);failOperation=undefined;}
  };
  const sampleLocation=async()=>{
   // Runtime returns a Location; the bundled 0.3.93 declaration incorrectly says DisplayedLocation.
   const location=await (r!.currentLocation() as unknown as Location|Promise<Location>);located(location);
  };
  const run=(operation:()=>Promise<unknown>|unknown):boolean=>{
   if(cancelled||busy||!ready)return false;
   busy=true;setMoving(true);setError('');
   void bounded(operation).then(async()=>{if(!cancelled)await sampleLocation();}).catch(reason=>{if(!cancelled){preservingCfi=false;setError(errorMessage(reason));if(reason instanceof RendererTimeoutError){ready=false;setOpened(false);}}}).finally(()=>{
    if(cancelled)return;busy=false;setMoving(false);if(layoutPending)refresh();
   });return true;
  };
  const refresh=()=>{
   layoutPending=true;if(cancelled||busy||!ready||!host.current)return;
   const {font,line,theme}=appearance.current,w=Math.floor(host.current.clientWidth),h=Math.floor(host.current.clientHeight);
   const signature=[font,line,theme,w,h].join(':');layoutPending=false;if(signature===lastLayout)return;lastLayout=signature;
   run(async()=>{
    const cfi=current.current.cfi;preservingCfi=true;
    try{
     r!.themes.fontSize(`${font}px`);r!.themes.override('line-height',String(line));r!.themes.override('background',theme==='dark'?'#17212b':'#fff');r!.themes.override('color',theme==='dark'?'#f1f5f9':'#17212b');
     // Fit the measured host, never a fixed 800px viewport. The optional CFI is
     // supported by the runtime but missing from its bundled resize declaration.
     if(w>0&&h>0)(r!.resize as (w:number,h:number,cfi?:string)=>void)(w,h,cfi||undefined);
     if(cfi)await r!.display(cfi);
    }finally{preservingCfi=false;}
   });
  };
  const navigate:Session['navigate']=target=>{
   if(typeof target==='string'&&((target==='prev'&&lastPosition.atStart)||(target==='next'&&lastPosition.atEnd)))return false;
   if(typeof target!=='string'){
    if('href' in target&&!entries.some(item=>item.href===target.href))return false;
    if('cfi' in target){try{if(!isSafeEpubCfi(target.cfi)||!instance?.spine.get(target.cfi))return false;}catch{return false;}}
   }
   return run(()=>typeof target==='string'?r![target]():r!.display('href' in target?target.href:target.cfi));
  };
  const keydown=(event:KeyboardEvent)=>{
   const direction=event.key==='ArrowLeft'||event.key==='PageUp'?'prev':event.key==='ArrowRight'||event.key==='PageDown'?'next':null;
   if(!direction||blocksPaging(event,[document,...documents.keys()]))return;
   if(navigate(direction))event.preventDefault();
  };
  const ownSession:Session={navigate,refresh,keydown,search:async(query,signal,update)=>{if(cancelled||!ready||!instance)return;await searchSafeEpubSpine(instance,query,signal,value=>update({...value,results:value.results.map(result=>({...result,chapter:entries.find(item=>pathOf(item.href)===pathOf(result.chapter))?.label||result.chapter}))}));}};session.current=ownSession;
  const root=reader.current!;root.addEventListener('keydown',keydown);
  const resized=()=>refresh();window.addEventListener('resize',resized);
  if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(resized);observer.observe(host.current!);}

  (async()=>{
   const converted=book.kind==='fb2'?await convertFb2ToEpub(book.blob,book.title):undefined;
   if(cancelled)return;
   const data=await (converted?.blob||book.blob).arrayBuffer();if(cancelled)return;
   const files=await unpackEpub(data);if(cancelled)return;
   safe=prepareSafeEpub(files);setWarnings([...(converted?.warnings||[]),...safe.warnings]);
   instance=ePub(safe.data,{replacements:'none'});await bounded(()=>instance!.ready);if(cancelled)return;
   const nav=await bounded(()=>instance!.loaded.navigation);if(cancelled)return;
   entries=flatten(nav.toc).filter(item=>{try{return !!instance!.spine.get(item.href);}catch{return false;}});setToc(entries);
   // Section.render serializes sanitized XML once more before iframe loading.
   // Preserve CR character references across that final parser boundary too.
   instance.spine.hooks.serialize.register((output:string,section:{output:string})=>{section.output=output.replace(/\r/g,'&#13;');});
   r=instance.renderTo(host.current!,{width:'100%',height:'100%',flow:'paginated',spread:'none',allowScriptedContent:false});
   r.on('relocated',located);r.on('displayError',(reason:unknown)=>failOperation?.(reason));
   r.hooks.content.register((contents:Contents)=>{
    if(cancelled)return;
    const frame=contents.window.frameElement as HTMLIFrameElement|null;
    // Keep executable book content disabled and keep the original text DOM intact.
    if(!frame||frame.sandbox.contains('allow-scripts'))throw new Error('Небезопасная конфигурация iframe EPUB');
    frame.setAttribute('sandbox','allow-same-origin');frame.setAttribute('title',`Текст ${kind}`);
    pruneDocuments();documents.get(contents.document)?.();
    const section=instance!.spine.get(contents.sectionIndex);
    for(const item of entries.filter(item=>pathOf(item.href)===pathOf(section.href))){
     const hash=item.href.indexOf('#');if(hash<0)continue;
     try{const anchor=contents.document.getElementById(decodeURIComponent(item.href.slice(hash+1)));if(anchor)anchors.set(item.key,contents.cfiFromNode(anchor));}catch{/* Invalid fragment: still allow its parent section to be read. */}
    }
    const cleanup=readyRef.current?.(contents.document,()=>({kind:book.kind==='fb2'?'fb2':'epub',title:book.title,url:null,documentId:book.documentId,page:null,chapter:current.current.chapter,cfi:current.current.cfi||null}));
    const links=(event:Event)=>{
     if(event.type==='keydown'&&(event as KeyboardEvent).key!=='Enter')return;
     const target=event.target as Element|null,anchor=target?.nodeType===1?target.closest('a[data-external-link]'):null;if(!anchor)return;
     event.preventDefault();event.stopImmediatePropagation();const href=anchor.getAttribute('data-external-link');if(event.isTrusted&&href&&window.confirm(`Открыть внешнюю ссылку?\n${href}`))window.open(href,'_blank','noopener,noreferrer');
    };
    contents.document.addEventListener('click',links,true);contents.document.addEventListener('keydown',links,true);contents.document.addEventListener('keydown',keydown);
    documents.set(contents.document,()=>{cleanup?.();contents.document.removeEventListener('click',links,true);contents.document.removeEventListener('keydown',links,true);contents.document.removeEventListener('keydown',keydown);});
   });
   r.themes.default({'body':{'font-family':'system-ui, sans-serif','line-height':String(appearance.current.line),'color':'#17212b','background':'#fff'},'a':{'color':'#075cb2'}});
   r.themes.fontSize(`${appearance.current.font}px`);
   await bounded(()=>r!.display(ignoreSaved?undefined:book.progress?.cfi||undefined));if(cancelled)return;
   await sampleLocation();if(cancelled)return;
   ready=true;busy=false;setOpened(true);setLoading(false);refresh();
   // Don't steal focus from a control the user is still using while loading.
   if(document.activeElement===document.body)host.current?.focus({preventScroll:true});
  })().catch(reason=>{if(!cancelled){setError(errorMessage(reason));setLoading(false);}});
  return()=>{
   cancelled=true;searchControl.current?.abort();failOperation?.(new Error('Книга закрыта'));observer?.disconnect();window.removeEventListener('resize',resized);root.removeEventListener('keydown',keydown);
   for(const cleanup of documents.values())cleanup();documents.clear();
   if(session.current===ownSession)session.current=undefined;
   r?.off('relocated',located);instance?.destroy();safe?.dispose();
  };
 },[book.documentId,retry,ignoreSaved]);
 useEffect(()=>{session.current?.refresh();},[font,width,line,theme]);

 const index=toc.findIndex(item=>item.key===position.tocKey),disabled=loading||moving||!opened;
 const move=(direction:'prev'|'next')=>session.current?.navigate(direction);
 const jump=(item:TocEntry|undefined)=>{if(item)session.current?.navigate({href:item.href});};
 return <section ref={reader} className="er-epub-reader" aria-label={`Чтение ${kind}`}>
  <div className="er-epub-navigation" role="group" aria-label="Навигация книги" aria-controls={viewportId}>
   <div className="er-epub-paging">
    <button type="button" aria-label="Предыдущий экран" title="Предыдущий экран (← / Page Up)" disabled={disabled||position.atStart} onClick={()=>move('prev')}>← Назад</button>
    <div className="er-epub-position" role="status" aria-live="polite" aria-atomic="true">
     <strong>{loading?'Открытие книги…':moving?'Переход…':position.page&&position.total?`Экран ${position.page} из ${position.total}`:'Положение уточняется'}</strong>
     <span>{position.page?'в разделе файла':' '}{position.atStart?' · Начало книги':''}{position.atEnd?' · Конец книги':''}</span>
    </div>
    <button type="button" aria-label="Следующий экран" title="Следующий экран (→ / Page Down)" disabled={disabled||position.atEnd} onClick={()=>move('next')}>Далее →</button>
   </div>
   <div className="er-epub-toc-row">
    <button type="button" aria-label="Предыдущий раздел оглавления" title="Предыдущий раздел оглавления" disabled={disabled||index<=0} onClick={()=>jump(toc[index-1])}>‹</button>
    <label className="er-epub-toc">Оглавление<select aria-label="Раздел оглавления" disabled={disabled||!toc.length} value={position.tocKey} onChange={event=>jump(toc.find(item=>item.key===event.target.value))}>
     <option value="" disabled>{toc.length?'Текущий раздел вне оглавления':'Нет оглавления'}</option>
     {toc.map(item=><option key={item.key} value={item.key}>{`${'　'.repeat(Math.min(item.depth,8))}${item.depth?'↳ ':''}${item.label}`}</option>)}
    </select></label>
    <button type="button" aria-label="Следующий раздел оглавления" title="Следующий раздел оглавления" disabled={disabled||index<0||index>=toc.length-1} onClick={()=>jump(toc[index+1])}>›</button>
   </div>
   <p className="er-epub-current" title={position.chapter}>{position.chapter||'Локальная книга'}<span className="er-epub-shortcuts">← → / Page Up · Page Down</span></p>
  </div>
  <details className="er-epub-options"><summary>Вид и подсказки</summary><div className="er-epub-settings">
   <label>Шрифт <input aria-label="Размер шрифта" type="range" min="14" max="36" value={font} onChange={event=>changeAppearance({fontSize:+event.target.value})}/><output>{font} px</output></label>
   <label>Ширина <select value={width} onChange={event=>changeAppearance({width:event.target.value as EpubAppearance['width']})}><option value="comfortable">Удобная</option><option value="wide">Широкая</option><option value="full">Во весь экран</option></select></label>
   <label>Интервал <select value={line} onChange={event=>changeAppearance({lineHeight:+event.target.value as EpubAppearance['lineHeight']})}>{[1.3,1.5,1.7,2].map(n=><option key={n}>{n}</option>)}</select></label>
   <label>Тема <select value={theme} onChange={event=>changeAppearance({theme:event.target.value as EpubAppearance['theme']})}><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
  </div><p id={helpId}>Щёлкните по тексту книги или перейдите к нему клавишей Tab. Листайте ← → или Page Up / Page Down. При выделенном тексте, открытом переводе и в полях ввода клавиши не листают книгу. Экраны считаются внутри раздела файла, а не всей книги: их число меняется с размером окна и шрифтом. Позиция сохраняется по тексту.</p>{warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>
  <details className="er-epub-tools"><summary>Поиск и закладки{bookmarks.length?` · ${bookmarks.length}`:''}</summary>
   <div className="er-epub-tool-grid">
    <section aria-label="Поиск по книге"><h3>Поиск по книге</h3>
     <form className="er-epub-tool-form" onSubmit={event=>{event.preventDefault();startSearch();}}>
      <label>Слово или фраза<input type="search" aria-label="Поиск по книге" maxLength={200} value={query} onChange={event=>{searchControl.current?.abort();setQuery(event.target.value);setSearch(emptySearch);}}/></label>
      <button type="submit" disabled={loading||!opened||!query.trim()}>Найти</button>{search.running&&<button type="button" onClick={cancelSearch}>Остановить поиск</button>}
     </form>
     <p className="er-epub-tool-hint">Локально, без отправки текста. Регистр не учитывается. До 100 результатов; большие книги проверяются частично.</p>
     <p role="status" aria-live="polite">{search.running?`Поиск: проверено разделов ${search.scanned} из ${search.total}. Найдено: ${search.results.length}.`:search.total?`${search.capped?'Найдено не менее':'Найдено'}: ${search.results.length}.${search.capped?' Показаны первые 100 совпадений.':''}${search.partial?' Поиск частичный: некоторые разделы не проверены или поиск остановлен.':''}`:''}</p>
     {search.error&&<p role="alert">Поиск не выполнен: {search.error}</p>}
     {!!search.results.length&&<ol className="er-epub-results">{search.results.map((result,i)=><li key={`${result.cfi}:${i}`}><button type="button" disabled={disabled} onClick={()=>session.current?.navigate({cfi:result.cfi})}><strong>{result.chapter}</strong><span>{result.excerpt}</span></button></li>)}</ol>}
    </section>
    <section aria-label="Закладки книги"><h3>Закладки</h3>
     <form className="er-epub-tool-form" onSubmit={event=>{event.preventDefault();addBookmark();}}>
      <label>Название закладки<input aria-label="Название закладки" maxLength={READER_BOOKMARK_LABEL_MAX} placeholder={position.chapter||'Текущее место'} value={bookmarkLabel} onChange={event=>setBookmarkLabel(event.target.value)}/></label>
      <button type="submit" disabled={disabled||!isSafeEpubCfi(current.current.cfi)||bookmarks.length>=READER_BOOKMARK_LIMIT}>Добавить закладку</button>
     </form>
     <p className="er-epub-tool-hint">{persistenceMode==='session'?'Закладки и оформление — только до закрытия этой книги.':'Закладки и оформление сохраняются локально для этой книги.'}</p>
     <p role="status">{bookmarkNotice}</p>
     {bookmarks.length?<ul className="er-epub-bookmarks">{bookmarks.map(mark=><li key={mark.id}><button type="button" disabled={disabled||!isSafeEpubCfi(mark.cfi)} onClick={()=>session.current?.navigate({cfi:mark.cfi})}><strong>{mark.label}</strong><span>{mark.chapter}</span></button><button type="button" aria-label={`Удалить закладку «${mark.label}»`} onClick={()=>{changeBookmarks(bookmarks.filter(item=>item.id!==mark.id));setBookmarkNotice('Закладка удалена.');}}>Удалить</button></li>)}</ul>:<p>Пока нет закладок.</p>}
    </section>
   </div>
  </details>
  {loading&&<p role="status">Безопасная обработка {kind}…</p>}
  {error&&<div role="alert"><p>Не удалось открыть или показать текст: {error}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Повторить открытие</button>{book.progress?.cfi&&!ignoreSaved&&<button type="button" onClick={()=>setStartAtBeginningFor(book.documentId)}>Открыть с начала</button>}</div>}
  <div ref={host} id={viewportId} tabIndex={0} aria-label={`Текст книги ${kind}`} aria-describedby={helpId} aria-busy={loading||moving} className={`er-epub-viewport er-epub-width-${width} er-epub-theme-${theme}`}/>
 </section>;
}
