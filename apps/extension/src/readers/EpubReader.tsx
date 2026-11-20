import React,{useEffect,useId,useRef,useState} from 'react';
import ePub,{type Book,type Contents,type Location,Rendition} from 'epubjs';
import type {default as View, ViewSettings} from 'epubjs/types/managers/view';
import type Section from 'epubjs/types/section';
import {prepareSafeEpub,unpackEpub,type SafeEpub} from './epub-security';
import {convertFb2ToEpub} from './fb2';
import {isBookPanelSurfacePress,watchBookSurfaceTaps,type PanelDismissRef} from './book-text-tap';
import {installReaderPaging} from './keyboard-paging';
import {READER_BOOKMARK_LIMIT,READER_BOOKMARK_LABEL_MAX,type DocumentReady,type ReadingProgress,type StoredBook,type ReaderAppearance,type ReaderBookmark} from './types';
import './epub-reader.css';

import {ReaderChrome, ReaderChapters, ReaderSearch, ReaderQuoteList, ReflowControls} from './ReaderChrome';
import {readerTheme} from './reader-preferences';
import {formatBookContents, paintQuotes, paintSearchHit, pageColors, type EpubAppearance, type EpubSearchHit} from './epub-format';
import {alignScrollEdge,directionalPercent,scrollEdges,type MeasuredProgress,type SpineEdges} from './epub-scroll-edges';
import {indexBookProgress,type BookProgressIndex} from './epub-progress';
import {readerAnchor,readerRect} from './coordinates';
import {savedQuoteAtClick,type PaintedQuote} from './saved-quote-hit';
import {displayBookTitle,chapterTitle} from './book-presentation';
import {EpubBookmarks} from './EpubBookmarks';
import {QuoteSelectionTools,type QuoteSelection} from './QuoteSelectionTools';
import {READER_QUOTE_LIMIT,READER_QUOTE_TEXT_MAX,type ReaderQuote,type ReaderBookInfo} from './types';
// The continuous manager normally leaves an odd final column unpaired, but
// epub.js counts full spreads. Restore the iframe's normal paginated padding
// so that its last reported page and the physical right edge agree.
const IframeView = Rendition.prototype.requireView('iframe') as typeof View;
class BookPageView extends IframeView {
 constructor(section:Section,settings:ViewSettings){
  super(section,{...settings,forceEvenPages:settings.flow==='paginated'});
 }
}

interface Props {
 book:StoredBook;onProgress:(progress:ReadingProgress)=>void;onDocumentReady?:DocumentReady;
 onBack?:()=>void;onBookInfo?:(info:ReaderBookInfo)=>void;bookmarks?:ReaderBookmark[];onBookmarksChange?:(next:ReaderBookmark[])=>void;
 appearance?:ReaderAppearance;onAppearanceChange?:(next:ReaderAppearance)=>void;quotes?:ReaderQuote[];onQuotesChange?:(next:ReaderQuote[])=>void;persistenceMode?:'persistent'|'session'
}
interface SelectedQuote extends QuoteSelection {cfi:string;chapter:string;doc:Document}
interface TocItem {id:string;href:string;label:string;subitems?:TocItem[]}
interface TocEntry {key:string;href:string;label:string;depth:number;chapterNumber:number}
interface Position {percent?:number;tocKey:string;chapter:string;page?:number;total?:number;atStart:boolean;atEnd:boolean}
interface Session {seek:(percent:number)=>void;paint:()=>void;navigate:(target:'prev'|'next'|{href:string}|{cfi:string;searchText?:string;edge?:'first'|'last'})=>boolean;clearSearchHit:()=>void;refresh:()=>void;search:(query:string,signal:AbortSignal,update:(state:EpubSearchState)=>void)=>Promise<void>}
const emptyPosition:Position={tocKey:'',chapter:'',atStart:false,atEnd:false};
class RendererTimeoutError extends Error {}
const errorMessage=(error:unknown)=>error instanceof Error?error.message:String(error);
function pathOf(href:string):string {
 const path=href.split('#')[0];
 try{return decodeURIComponent(path).replace(/^\.\//,'');}catch{return path;}
}
function flatten(items:TocItem[]):TocEntry[] {
 const result:TocEntry[]=[],sections=new Map<string,number>(),stack=items.map(item=>({item,depth:0})).reverse();
 while(stack.length){
  const {item,depth}=stack.pop()!;
  if(typeof item.href==='string'&&item.href){
   const section=pathOf(item.href);if(!sections.has(section))sections.set(section,sections.size+1);
   const rawLabel=item.label.trim(),label=rawLabel.includes('_')||/\.x?html?$/i.test(rawLabel)?displayBookTitle(rawLabel):rawLabel||'Без названия';
   const explicit=Number(/^(?:chapter|глава)\s+(\d+)(?:\s|[.:·–—-]|$)/iu.exec(label)?.[1]);
   result.push({key:String(result.length),href:item.href,label:label.slice(0,500),depth,chapterNumber:Number.isSafeInteger(explicit)&&explicit>0?explicit:sections.get(section)!});
  }
  for(const child of [...(item.subitems||[])].reverse())stack.push({item:child,depth:depth+1});
 }
 return result;
}
const SEARCH_RESULT_LIMIT=100,SEARCH_SECTION_LIMIT=500,SEARCH_SECTION_CHARS=2_000_000,SEARCH_TOTAL_CHARS=12_000_000,SEARCH_NODE_LIMIT=50_000;
export interface EpubSearchResult {cfi:string;chapter:string;text:string;excerpt:string;match:{start:number;end:number}}
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
    const before=(start>65?'…':'')+text.slice(Math.max(0,start-65),start).replace(/\s+/g,' ');
    const matched=match[0].replace(/\s+/g,' ');
    const after=text.slice(end,end+95).replace(/\s+/g,' ')+(end+95<text.length?'…':'');
    results.push({cfi,chapter:section.href,text:range.toString(),excerpt:before+matched+after,match:{start:before.length,end:before.length+matched.length}});
    if(results.length>=SEARCH_RESULT_LIMIT){capped=true;break;}
    if(results.length%20===0)await pauseSearch(signal);
   }
  }catch(reason){if(signal.aborted)throw reason;partial=true;}
  finally{scanned++;if(!signal.aborted)report(true);}
  if(capped||candidates>1000)break;
 }
 report(false);
}

export function EpubReader({book,onProgress,onDocumentReady,onBack,onBookInfo,quotes:savedQuotes,onQuotesChange,bookmarks:savedBookmarks,onBookmarksChange,appearance:savedAppearance,onAppearanceChange}:Props){
 const host=useRef<HTMLDivElement>(null),reader=useRef<HTMLElement>(null),session=useRef<Session|undefined>(undefined);
 const textTapDismiss=useRef<PanelDismissRef['current']>(null);
 const current=useRef({cfi:book.progress?.cfi||'',chapter:book.progress?.chapter||''});
 const progressRef=useRef(onProgress),readyRef=useRef(onDocumentReady);progressRef.current=onProgress;readyRef.current=onDocumentReady;
 const [toc,setToc]=useState<TocEntry[]>([]),[position,setPosition]=useState<Position>(emptyPosition),[error,setError]=useState('');
 const [loading,setLoading]=useState(true),[opened,setOpened]=useState(false),[startAtBeginningFor,setStartAtBeginningFor]=useState<string>(),[moving,setMoving]=useState(false),[warnings,setWarnings]=useState<string[]>([]),[retry,setRetry]=useState(0);
 const initialAppearance: EpubAppearance=savedAppearance?.kind===book.kind&&savedAppearance.kind!=='pdf'?savedAppearance:{kind:book.kind==='fb2'?'fb2':'epub',fontSize:20,width:'comfortable',lineHeight:1.7,theme:'light'};
 const [style,setStyle]=useState<EpubAppearance>(initialAppearance),[localBookmarks,setLocalBookmarks]=useState<ReaderBookmark[]>(savedBookmarks||[]),[bookmarkLabel,setBookmarkLabel]=useState(''),[bookmarkNotice,setBookmarkNotice]=useState('');
 const [query,setQuery]=useState(''),[search,setSearch]=useState<EpubSearchState>(emptySearch),searchControl=useRef<AbortController|undefined>(undefined);
 const {fontSize:font,lineHeight:line,theme}=style,bookmarks=(savedBookmarks||localBookmarks).filter((mark):mark is Extract<ReaderBookmark,{kind:'epub'|'fb2'}>=>mark.kind===book.kind&&mark.kind!=='pdf');
 const appearance=useRef(style);appearance.current=style;
 const infoRef=useRef(onBookInfo);infoRef.current=onBookInfo;
 const [localQuotes,setLocalQuotes]=useState<ReaderQuote[]>(savedQuotes||[]),[selection,setSelection]=useState<SelectedQuote|null>(null);
 const [seekIntervals,setSeekIntervals]=useState<number|null>(null),[indexWarning,setIndexWarning]=useState('');
 const quotes=savedQuotes??localQuotes,quoteRef=useRef(quotes);quoteRef.current=quotes;
 const resetSelection=()=>setSelection(null);
 const editSavedQuote=(quote:ReaderQuote,rect:DOMRect,doc:Document,returnFocus?:HTMLElement,confirmDelete=false)=>{
  if(quote.kind!=='pdf')setSelection({saved:quote,doc,cfi:quote.cfi,chapter:quote.chapter,text:quote.text,rect,returnFocus,confirmDelete});
 };
 const changeQuotes=(next:ReaderQuote[])=>{setLocalQuotes(next);onQuotesChange?.(next);};
 const removeQuote=(id:string)=>{
  if(selection?.saved?.id!==id)return;
  const next=quotes.filter(q=>q.kind!==book.kind||q.id!==id);
  if(next.length!==quotes.length){changeQuotes(next);setBookmarkNotice('Цитата удалена.');}
  resetSelection();
 };
 const saveQuote=(comment?:string)=>{
  if(!selection||(!selection.saved&&!selection.doc.defaultView?.frameElement?.isConnected))return;
  const same=quotes.find(q=>q.kind===book.kind&&q.kind!=='pdf'&&(selection.saved?q.id===selection.saved.id:q.cfi===selection.cfi));
  if(selection.saved&&!same){resetSelection();return;}
  if(!same&&quotes.length>=READER_QUOTE_LIMIT){setBookmarkNotice('Достигнут предел цитат в этой книге.');resetSelection();return;}
  const entry:ReaderQuote=same?{...same,...(comment?{comment}:{})}:{kind:book.kind==='fb2'?'fb2':'epub',id:crypto.randomUUID(),createdAt:Date.now(),text:selection.text,
   chapter:selection.chapter,cfi:selection.cfi,...(comment?{comment}:{})};
  const next=same?quotes.map(q=>q.id===same.id?entry:q):[...quotes,entry];
  changeQuotes(next);if(!selection.saved)selection.doc.getSelection()?.removeAllRanges();resetSelection();setBookmarkNotice(comment?'Комментарий сохранён.':'Выделение сохранено.');
 };
 useEffect(()=>{session.current?.paint();},[quotes]);

 useEffect(()=>{setStyle(initialAppearance);setLocalBookmarks(savedBookmarks||[]);setLocalQuotes(savedQuotes||[]);resetSelection();setBookmarkLabel('');setBookmarkNotice('');},[book.documentId]);
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
  session.current?.clearSearchHit();searchControl.current?.abort();const controller=new AbortController();searchControl.current=controller;const own=session.current;
  if(!query.trim()||!own){setSearch(emptySearch);return;}
  setSearch({...emptySearch,running:true});
  void own.search(query,controller.signal,value=>{if(!controller.signal.aborted&&session.current===own)setSearch(value);}).catch(reason=>{if(!controller.signal.aborted&&session.current===own)setSearch(value=>({...value,running:false,error:errorMessage(reason)}));});
 };
 const cancelSearch=()=>{session.current?.clearSearchHit();searchControl.current?.abort();setSearch(value=>({...value,running:false,partial:value.running||value.partial}));};
 const viewportId=useId(),kind=book.kind==='fb2'?'FB2':'EPUB',ignoreSaved=startAtBeginningFor===book.documentId;

 useEffect(()=>{
  let cancelled=false,instance:Book|undefined,r:Rendition|undefined,safe:SafeEpub|undefined;
  let busy=true,ready=false,layoutPending=false,preservingCfi=false,lastLayout='',visibleCfi='';
  let pendingSeek:number|undefined,linkFrame=0,linkTicket=0,followingLink=false;
  let spineEdges:SpineEdges={},lastMeasured:MeasuredProgress|undefined;
  let failOperation:((error:unknown)=>void)|undefined,observer:ResizeObserver|undefined;
  let entries:TocEntry[]=[],lastPosition=emptyPosition,sourceTitle=displayBookTitle(book.title);
  let index:BookProgressIndex|undefined,layoutAnchor:string|undefined,layoutPage:string|undefined;
  let appliedFlow=appearance.current.flow||'paginated',appliedSpread=appearance.current.spread||'single';
  const indexing=new AbortController(),frames=new Map<Document,Contents>();
  setSeekIntervals(null);setIndexWarning('');resetSelection();
  let searchHit:EpubSearchHit|undefined;
  const showSearchHit=(next?:EpubSearchHit)=>{
   if(!next&&!searchHit)return;
   searchHit=next;
   for(const contents of frames.values())paintSearchHit(contents,next);
  };
  const anchors=new Map<string,string>(),documents=new Map<Document,()=>void>();
  current.current={cfi:ignoreSaved?'':book.progress?.cfi||'',chapter:ignoreSaved?'':book.progress?.chapter||''};
  if(isSafeEpubCfi(current.current.cfi))layoutAnchor=current.current.cfi;
  searchControl.current?.abort();setQuery('');setSearch(emptySearch);
  setOpened(false);setLoading(true);setMoving(false);setError('');setWarnings([]);setToc([]);setPosition(emptyPosition);
  const pruneDocuments=()=>{for(const [doc,cleanup] of documents){const frame=doc.defaultView?.frameElement as HTMLIFrameElement|null;if(!frame?.isConnected||!host.current?.contains(frame)||frame.contentDocument!==doc){cleanup();documents.delete(doc);}}};
  const entryAt=(href:string,cfi?:string|null)=>{
   const matching=entries.filter(item=>pathOf(item.href)===pathOf(href));
   let selected=matching.find(item=>!item.href.includes('#'));
   if(cfi)for(const item of matching){
    const anchor=anchors.get(item.key);if(!anchor)continue;
    try{if(r!.epubcfi.compare(anchor,cfi)<=0)selected=item;}catch{/* Ignore a malformed TOC fragment. */}
   }
   return selected||matching[0];
  };
  const located=(location:Location,layoutSample=false)=>{
   if(cancelled||preservingCfi||pendingSeek!==undefined||!location?.start?.cfi)return;
   if(visibleCfi && visibleCfi!==location.start.cfi)textTaps.relocated();
   visibleCfi=location.start.cfi;
   if(layoutSample)layoutPage=location.start.cfi;
   else if(layoutPage&&location.start.cfi!==layoutPage)layoutAnchor=undefined;
   pruneDocuments();
   // Explicit navigation clears the hit in navigate(). Also catch internal links
   // and scrolling, while allowing the renderer to settle during a search jump.
   if(searchHit&&!layoutAnchor&&!busy&&!layoutSample&&location.end?.cfi){
    const compare=r!.epubcfi;
    if(compare.compare(searchHit.cfi,location.start.cfi)<0||compare.compare(searchHit.cfi,location.end.cfi)>0)showSearchHit();
   }
   const cfi=layoutAnchor||location.start.cfi;
   let href=location.start.href;
   if(layoutAnchor&&isSafeEpubCfi(layoutAnchor))try{href=instance?.spine.get(layoutAnchor)?.href||href;}catch{/* Use the live renderer's section. */}
   const selected=entryAt(href,cfi);
   const chapter=selected?.label||chapterTitle(href)||'Раздел '+(Number(location.start.index||0)+1);
   // A restored CFI can sit anywhere inside the visible screen. Keep it for
   // persistence, but display the page at the leading edge of the reading surface.
   const visible=index?.location(location.start.cfi);
   const scroll=appliedFlow==='scrolled'?scrollEdges(host.current,spineEdges,location):undefined;
   const {atStart,atEnd}=scroll??location;
   let percent=visible?.percent;
   if(index && layoutAnchor && layoutAnchor!==location.start.cfi)percent=index.percent(layoutAnchor);
   else if(!scroll && visible && !layoutAnchor)percent=atStart?0:atEnd?100:visible.percent;
   else if(!visible && book.progress?.cfi===cfi)percent=book.progress.percent;
   if(scroll){
    if(index&&scroll.sample&&percent!==undefined&&!layoutAnchor){
     percent=directionalPercent(lastMeasured,scroll.sample,percent);
    }
    if(atEnd&&!atStart)percent=100;
    else if(scroll.atTop&&!atEnd)percent=0;
    // Preserve a requested CFI in a book that fits on one screen. A final
    // character can precede trailing artwork, so reserve exact 100 for a visible end.
    else if(!atEnd&&percent===100)percent=100-100*Number.EPSILON;
    lastMeasured=index&&scroll.sample&&percent!==undefined?{...scroll.sample,percent}:undefined;
   }
   lastPosition={percent,tocKey:selected?.key||'',chapter,page:visible?.page,total:visible?.total,atStart:atStart===true,atEnd:atEnd===true};
   current.current={cfi,chapter};setPosition(lastPosition);
   progressRef.current({...current.current,...(percent===undefined?{}:{percent}),...(selected?{chapterNumber:selected.chapterNumber}:{}),updatedAt:Date.now()});
  };
  // epub.js 0.3.93 emits displayError without reliably rejecting display(). Bound
  // every renderer operation, and reject it on teardown rather than leaving busy UI.
  const bounded=async<T,>(operation:()=>Promise<T>|T):Promise<T>=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{failOperation=reject;timer=setTimeout(()=>reject(new RendererTimeoutError('Чтение не отвечает. Повторите открытие книги.')),30000);})]);}
   finally{clearTimeout(timer);failOperation=undefined;}
  };
  const sampleLocation=async(layoutSample=false)=>{
   // Runtime returns a Location; the bundled 0.3.93 declaration incorrectly says DisplayedLocation.
   const location=await (r!.currentLocation() as unknown as Location|Promise<Location>);located(location,layoutSample);
  };
  const run=(operation:()=>Promise<unknown>|unknown,layoutSample=false):boolean=>{
   if(cancelled||busy||!ready)return false;
   busy=true;setMoving(true);setError('');
   void bounded(operation).then(async()=>{if(!cancelled)await sampleLocation(layoutSample);}).catch(reason=>{if(!cancelled){pendingSeek=undefined;preservingCfi=false;showSearchHit();setError(errorMessage(reason));if(reason instanceof RendererTimeoutError){ready=false;setOpened(false);}}}).finally(()=>{
    if(cancelled)return;
    busy=false;setMoving(false);
    if(pendingSeek!==undefined){
     const next=pendingSeek;pendingSeek=undefined;seek(next);
    }else if(layoutPending)refresh();
   });return true;
  };
  const refresh=()=>{
   layoutPending=true;if(cancelled||busy||followingLink||!ready||!host.current)return;
   const style=appearance.current,{fontSize:font,lineHeight:line,theme}=style,w=Math.floor(host.current.clientWidth),h=Math.floor(host.current.clientHeight);
   const signature=[font,line,theme,style.spread,style.flow,style.publisher,w,h].join(':');layoutPending=false;if(signature===lastLayout)return;lastLayout=signature;
   run(async()=>{
    lastMeasured=undefined;
    const cfi=layoutAnchor||current.current.cfi;layoutAnchor=cfi;layoutPage=undefined;preservingCfi=true;resetSelection();
    try{
     const flow=style.flow??'paginated',spread=style.spread??'single';
     if(flow!==appliedFlow){r!.flow(flow);appliedFlow=flow;}
     if(spread!==appliedSpread){r!.spread(spread==='double'?'auto':'none',560);appliedSpread=spread;}
     for(const contents of frames.values())formatBookContents(contents,style);
     r!.themes.fontSize(`${font}px`);r!.themes.override('line-height',String(line));r!.themes.override('background',pageColors[theme].paper);r!.themes.override('color',pageColors[theme].text);
     // Fit the measured host, never a fixed 800px viewport. The optional CFI is
     // supported by the runtime but missing from its bundled resize declaration.
     if(w>0&&h>0)(r!.resize as (w:number,h:number,cfi?:string)=>void)(w,h,cfi||undefined);
     if(cfi)await r!.display(cfi);
    }finally{preservingCfi=false;}
   },true);
  };
  const navigate:Session['navigate']=target=>{
   textTaps.relocated();
   let hit:EpubSearchHit|undefined;
   if(typeof target==='string'&&((target==='prev'&&lastPosition.atStart)||(target==='next'&&lastPosition.atEnd)))return false;
   if(typeof target!=='string'){
    if('href' in target&&!entries.some(item=>item.href===target.href))return false;
    if('cfi' in target){
     if(!isSafeEpubCfi(target.cfi))return false;
     try{
      const section=instance?.spine.get(target.cfi);if(!section)return false;
      if(target.searchText)hit={cfi:target.cfi,text:target.searchText,section:section.index};
     }catch{return false;}
    }
   }
   const exact=typeof target==='object'&&'cfi' in target?target.cfi:undefined;
   const started=run(async()=>{
    layoutAnchor=exact;layoutPage=undefined;preservingCfi=!!exact;resetSelection();
    try{
     if(typeof target==='string')return await r![target]();
     lastMeasured=undefined;
     await r!.display('href' in target?target.href:target.cfi);
     // End seeks to the actual last screen even when unindexed artwork follows the final word.
     if('edge' in target&&target.edge&&appliedFlow==='scrolled')alignScrollEdge(host.current,spineEdges[target.edge],target.edge);
    }
    finally{preservingCfi=false;}
   },!!exact);
   if(started)showSearchHit(hit);
   return started;
  };
  const seek=(percent:number)=>{
   if(cancelled||!ready||!index||!Number.isFinite(percent))return;
   // A held arrow can outrun rendition.display(). Complete the current
   // operation, then display the most recently requested text position.
   if(busy){pendingSeek=percent;return;}
   navigate({cfi:index.target(percent),edge:percent<=0?'first':percent>=100?'last':undefined});
  };
  const paging=installReaderPaging({root:reader.current!,onKey:event=>{
   const direction=event.key==='ArrowLeft'||event.key==='PageUp'?'prev':event.key==='ArrowRight'||event.key==='PageDown'?'next':null;
   return !!direction&&navigate(direction);
  }});
  const paintedQuotes=new WeakMap<Document,PaintedQuote[]>();
  const drawQuotes=(contents:Contents)=>paintedQuotes.set(contents.document,paintQuotes(contents,quoteRef.current.filter(q=>q.kind===book.kind),
   cfi=>isSafeEpubCfi(cfi)&&instance?.spine.get(cfi)?.index===contents.sectionIndex));
  const ownSession:Session={navigate,refresh,clearSearchHit:()=>showSearchHit(),paint:()=>{for(const contents of frames.values())drawQuotes(contents);},seek,search:async(query,signal,update)=>{if(cancelled||!ready||!instance)return;await searchSafeEpubSpine(instance,query,signal,value=>update({...value,results:value.results.map(result=>({...result,chapter:entries.find(item=>pathOf(item.href)===pathOf(result.chapter))?.label||chapterTitle(result.chapter)||'Раздел книги'}))}));}};session.current=ownSession;
  const releaseAnchor=()=>{layoutAnchor=undefined;resetSelection();};
  const root=reader.current!,bookSurface=host.current!.closest<HTMLElement>('.rc-book-view')!;
  const textTaps=watchBookSurfaceTaps(bookSurface,textTapDismiss,range=>{
   const original=frames.get(range.startContainer.ownerDocument!);
   if(!original)return;
   const cfi=original.cfiFromRange(range),text=range.toString(),sectionIndex=original.sectionIndex;
   return {range:()=>{
    for(const contents of frames.values()){
     if(contents.sectionIndex!==sectionIndex||!contents.window.frameElement?.isConnected)continue;
     const fresh=contents.range(cfi);if(fresh?.toString()===text)return fresh;
    }
    return null;
   },selected:fresh=>{
    const rect=readerAnchor(fresh);
    if(rect)setSelection({cfi,text,rect,doc:fresh.startContainer.ownerDocument!,chapter:current.current.chapter.slice(0,500)});
   }};
  });root.addEventListener('wheel',releaseAnchor,{passive:true});root.addEventListener('touchmove',releaseAnchor,{passive:true});
  const resized=()=>refresh();window.addEventListener('resize',resized);
  if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(resized);observer.observe(host.current!);}

  (async()=>{
   const converted=book.kind==='fb2'?await convertFb2ToEpub(book.blob,book.title):undefined;
   if(cancelled)return;
   const data=await (converted?.blob||book.blob).arrayBuffer();if(cancelled)return;
   const files=await unpackEpub(data);if(cancelled)return;
   safe=prepareSafeEpub(files);setWarnings([...(converted?.warnings||[]),...safe.warnings]);
   instance=ePub(safe.data,{replacements:'none'});await bounded(()=>instance!.ready);if(cancelled)return;
   spineEdges={first:instance.spine.first?.()?.index,last:instance.spine.last?.()?.index};
   const metadata=instance.packaging?.metadata;
   if(metadata){const title=metadata.title?.trim().slice(0,500),author=metadata.creator?.trim().slice(0,500);
    if(title)sourceTitle=displayBookTitle(title);
    if(title||author)infoRef.current?.({...title?{title}:{},...author?{author}:{}});
   }
   const nav=await bounded(()=>instance!.loaded.navigation);if(cancelled)return;
   entries=flatten(nav.toc).filter(item=>{try{return !!instance!.spine.get(item.href);}catch{return false;}});setToc(entries);
   // Section.render serializes sanitized XML once more before iframe loading.
   // Preserve CR character references across that final parser boundary too.
   instance.spine.hooks.serialize.register((output:string,section:{output:string})=>{section.output=output.replace(/\r/g,'&#13;');});
   // The default epub.js manager stops at the current spine item in scrolling mode.
   // Keep one rendition/CFI space across both flows and let its stage load neighbouring sections.
   r=instance.renderTo(host.current!,{manager:'continuous',view:BookPageView,width:'100%',height:'100%',flow:appliedFlow,spread:appliedSpread==='double'?'auto':'none',minSpreadWidth:560,allowScriptedContent:false});
   r.on('relocated',located);r.on('displayError',(reason:unknown)=>{
    failOperation?.(reason);
    if(followingLink){linkTicket++;followingLink=false;if(layoutPending)refresh();}
   });
   r.hooks.content.register((contents:Contents)=>{
    if(cancelled)return;
    const frame=contents.window.frameElement as HTMLIFrameElement|null;
    // Keep executable book content disabled and keep the original text DOM intact.
    if(!frame||frame.sandbox.contains('allow-scripts'))throw new Error('Небезопасная конфигурация iframe EPUB');
    frame.setAttribute('sandbox','allow-same-origin');frame.setAttribute('title',`Текст ${kind}`);
    pruneDocuments();documents.get(contents.document)?.();
    const section=instance!.spine.get(contents.sectionIndex);
    frames.set(contents.document,contents);formatBookContents(contents,appearance.current);drawQuotes(contents);paintSearchHit(contents,searchHit);
    for(const item of entries.filter(item=>pathOf(item.href)===pathOf(section.href))){
     const hash=item.href.indexOf('#');if(hash<0)continue;
     try{const anchor=contents.document.getElementById(decodeURIComponent(item.href.slice(hash+1)));if(anchor)anchors.set(item.key,contents.cfiFromNode(anchor));}catch{/* Invalid fragment: still allow its parent section to be read. */}
    }
    const cleanup=readyRef.current?.(contents.document,range=>{
     let cfi=current.current.cfi||null;
     if(range?.startContainer.ownerDocument===contents.document){try{const exact=contents.cfiFromRange(range);if(isSafeEpubCfi(exact))cfi=exact;}catch{/* Keep the last valid location if the renderer cannot map this range. */}}
     const selected=entryAt(section.href,cfi);
     const chapter=range?(selected?.label||chapterTitle(section.href)||current.current.chapter):current.current.chapter;
     return {kind:book.kind==='fb2'?'fb2':'epub',title:sourceTitle,url:null,documentId:book.documentId,page:null,chapter,cfi};
    });
    const links=(event:Event)=>{
     if(event.type==='keydown'&&(event as KeyboardEvent).key!=='Enter')return;
     const target=event.target as Element|null,link=target?.nodeType===1?target.closest('a'):null;
     if(link?.hasAttribute('href')){
      lastMeasured=undefined;layoutAnchor=undefined;
      if(event.type==='click'&&r?.q){
       // The anchor's own handler queues rendition.display(). Closing the drawer
       // may resize this frame before it finishes. Fit the destination, not the old CFI.
       const ticket=++linkTicket;followingLink=true;cancelAnimationFrame(linkFrame);
       linkFrame=requestAnimationFrame(async()=>{
        if(cancelled||ticket!==linkTicket)return;
        try{await r!.q.enqueue(()=>{});if(!cancelled&&ticket===linkTicket)await sampleLocation();}
        catch{/* A failed link keeps the currently displayed section. */}
        finally{if(!cancelled&&ticket===linkTicket){followingLink=false;if(layoutPending)refresh();}}
       });
      }
     }
     const anchor=link?.closest('a[data-external-link]');if(!anchor)return;
     event.preventDefault();event.stopImmediatePropagation();const href=anchor.getAttribute('data-external-link');if(event.isTrusted&&href&&window.confirm(`Открыть внешнюю ссылку?\n${href}`))window.open(href,'_blank','noopener,noreferrer');
    };
    const doc=contents.document;
    const openSaved=(event:MouseEvent)=>{
     const hit=savedQuoteAtClick(event,paintedQuotes.get(doc)??[]);
     if(hit){const rect=readerRect(hit.rect,doc);if(rect)editSavedQuote(hit.quote,rect,doc,frame);}
    };
    const readSelection=(event?:Event)=>{
     if(cancelled||textTapDismiss.current&&root.querySelector('.er-quote-editor'))return;
     if(event&&('altKey' in event||'shiftKey' in event)){
      const key=event as MouseEvent;if(key.altKey||key.shiftKey||key.ctrlKey||key.metaKey){resetSelection();return;}
     }
     const raw=doc.getSelection();if(!raw||raw.isCollapsed||!raw.rangeCount){resetSelection();return;}
     const range=raw.getRangeAt(0),text=range.toString();if(!text.trim()||text.length>READER_QUOTE_TEXT_MAX||!doc.body.contains(range.commonAncestorContainer)){resetSelection();return;}
     try{const cfi=contents.cfiFromRange(range),rect=readerAnchor(range);
      if(!isSafeEpubCfi(cfi)||!rect){resetSelection();return;}
      const chapter=entryAt(section.href,cfi)?.label||current.current.chapter;
      setSelection({doc,cfi,chapter:chapter.slice(0,500),rect,text});
     }catch{resetSelection();}
    };
    const selectionKeys=(event:KeyboardEvent)=>{
     if(event.key==='Shift'||event.key==='Alt'||event.key==='Escape'){resetSelection();return;}
     if(event.shiftKey&&/^(Arrow|Home|End)/.test(event.key))readSelection();
    };
    const clearSelectionKey=(event:KeyboardEvent)=>{if(['Shift','Alt','Escape'].includes(event.key))resetSelection();};
    doc.addEventListener('click',openSaved);doc.addEventListener('pointerup',readSelection);doc.addEventListener('dblclick',readSelection);doc.addEventListener('keyup',selectionKeys);
    const pressText=(e:PointerEvent)=>{if(isBookPanelSurfacePress(e)&&root.querySelector('.er-quote-editor'))return;
     if(textTapDismiss.current)resetSelection();else releaseAnchor();};
    doc.addEventListener('pointerdown',pressText);doc.addEventListener('keydown',clearSelectionKey);
    doc.addEventListener('wheel',releaseAnchor,{passive:true});doc.addEventListener('touchmove',releaseAnchor,{passive:true});
    const stopPaging=paging.addDocument(contents.document),stopTaps=textTaps.addFrame(doc);
    contents.document.addEventListener('click',links,true);contents.document.addEventListener('keydown',links,true);
    documents.set(contents.document,()=>{paintSearchHit(contents);frames.delete(doc);doc.removeEventListener('click',openSaved);doc.removeEventListener('pointerup',readSelection);doc.removeEventListener('dblclick',readSelection);doc.removeEventListener('keyup',selectionKeys);doc.removeEventListener('keydown',clearSelectionKey);doc.removeEventListener('pointerdown',pressText);doc.removeEventListener('wheel',releaseAnchor);doc.removeEventListener('touchmove',releaseAnchor);cleanup?.();stopPaging();stopTaps();contents.document.removeEventListener('click',links,true);contents.document.removeEventListener('keydown',links,true);});
   });
   r.themes.default({'body':{'font-family':'system-ui, sans-serif','line-height':String(appearance.current.lineHeight),'color':pageColors[appearance.current.theme].text,'background':pageColors[appearance.current.theme].paper},'a':{'color':'#075cb2'}});
   r.themes.fontSize(`${appearance.current.fontSize}px`);
   await bounded(()=>r!.display(ignoreSaved?undefined:book.progress?.cfi||undefined));if(cancelled)return;
   await sampleLocation();if(cancelled)return;
   ready=true;busy=false;setOpened(true);setLoading(false);refresh();
   void indexBookProgress(instance,r,indexing.signal).then(async result=>{
    if(cancelled)return;index=result;setSeekIntervals(result?(result.characterCount||result.pageCount-1):0);if(result&&!busy)await sampleLocation();
   }).catch(()=>{if(!cancelled){setSeekIntervals(0);setIndexWarning('Не удалось рассчитать прогресс всей книги.');}});
  })().catch(reason=>{if(!cancelled){setError(errorMessage(reason));setLoading(false);}});
  return()=>{
   cancelled=true;cancelAnimationFrame(linkFrame);indexing.abort();root.removeEventListener('wheel',releaseAnchor);root.removeEventListener('touchmove',releaseAnchor);searchControl.current?.abort();failOperation?.(new Error('Книга закрыта'));observer?.disconnect();window.removeEventListener('resize',resized);paging.dispose();textTaps.dispose();
   for(const cleanup of documents.values())cleanup();documents.clear();
   if(session.current===ownSession)session.current=undefined;
   r?.off('relocated',located);instance?.destroy();safe?.dispose();
  };
 },[book.documentId,retry,ignoreSaved]);
 useEffect(()=>{session.current?.refresh();},[font,line,theme,style.flow,style.spread,style.publisher]);

 const index=toc.findIndex(item=>item.key===position.tocKey),disabled=loading||moving||!opened;
 const move=(direction:'prev'|'next')=>session.current?.navigate(direction);
 const jump=(item:TocEntry|undefined)=>{if(item)session.current?.navigate({href:item.href});};
 const marked=bookmarks.find(mark=>mark.cfi===current.current.cfi);
 const removeBookmark=(id:string)=>{changeBookmarks(bookmarks.filter(mark=>mark.id!==id));setBookmarkNotice('Закладка удалена.');};
 const searchStatus=search.error?'Не удалось выполнить поиск: '+search.error:
  search.running?'Поиск: проверено разделов '+search.scanned+' из '+search.total+'. Найдено: '+search.results.length+'.':
  search.total?(search.capped?'Найдено не менее: ':'Найдено: ')+search.results.length+'.'+(search.partial?' Поиск частичный.':'')+(search.capped?' Показаны первые 100 совпадений.':''):'';
 const canMark=!disabled&&isSafeEpubCfi(current.current.cfi);
 const canAdd=canMark&&bookmarks.length<READER_BOOKMARK_LIMIT;
 const title=displayBookTitle(book.title);
 const chapterName=position.chapter,chapterLabel=index<0?(chapterName||'Раздел'):'Глава '+toc[index].chapterNumber;
 return <ReaderChrome key={book.documentId} ref={reader} className={style.flow==='scrolled'?'er-epub-reader er-epub-scrolled':'er-epub-reader'} title={title} onBack={onBack}
  theme={readerTheme(theme)} onThemeChange={next=>changeAppearance({theme:next==='graphite'?'dark':next==='cream'?'cream':'light'})}
  chapter={{label:chapterLabel,title:chapterName===chapterLabel?undefined:chapterName,
    previous:!disabled&&index>0?()=>jump(toc[index-1]):undefined,next:!disabled&&index>=0&&index<toc.length-1?()=>jump(toc[index+1]):undefined}}
  page={{label:position.page&&position.total?'Страница '+position.page+' из '+position.total:loading?'Открытие книги…':seekIntervals===null?'Считаем страницы…':'Страницы не определены',
    previous:!disabled&&!position.atStart?()=>move('prev'):undefined,next:!disabled&&!position.atEnd?()=>move('next'):undefined}}
  progress={position.percent} scrollEndVisible={style.flow==='scrolled'?position.atEnd:undefined} minimumSeekStep={seekIntervals?Math.max(1,100/seekIntervals):1}
  onSeek={!loading&&opened&&seekIntervals!==null&&seekIntervals>0?percent=>session.current?.seek(percent):undefined}
  bookmarked={!!marked} onBookmark={canMark&&(marked||canAdd)?()=>marked?removeBookmark(marked.id):addBookmark():undefined}
  textTapDismiss={textTapDismiss} onPanelChange={(_panel,fromPage)=>{if(!fromPage||!reader.current?.querySelector('.er-quote-editor'))resetSelection();}}
  appearance={<><ReflowControls fontSize={font} lineHeight={line} publisher={style.publisher!==false} spread={style.spread==='double'} scrolling={style.flow==='scrolled'}
    onFontSize={fontSize=>changeAppearance({fontSize})} onLineHeight={lineHeight=>changeAppearance({lineHeight})} onPublisher={publisher=>changeAppearance({publisher})}
    onSpread={double=>changeAppearance({spread:double?'double':'single'})} onScrolling={scroll=>changeAppearance({flow:scroll?'scrolled':'paginated'})}/>
    {warnings.map((warning,i)=><p className="rc-subtle" key={i}>{warning}</p>)}{indexWarning&&<p className="rc-subtle" role="status">{indexWarning}</p>}</>}
  search={<ReaderSearch query={query} onQuery={value=>{session.current?.clearSearchHit();searchControl.current?.abort();setQuery(value);setSearch(emptySearch);}}
    onSubmit={startSearch} onCancel={search.running?cancelSearch:undefined} status={searchStatus} disabled={loading||!opened}
    items={search.results.map((result,i)=>({id:result.cfi+':'+i,title:result.chapter,excerpt:result.excerpt,match:result.match,onOpen:()=>session.current?.navigate({cfi:result.cfi,searchText:result.text}),disabled}))}/>}
  chapters={<ReaderChapters selected={position.tocKey} items={toc.map(item=>({id:item.key,title:item.label,level:item.depth,disabled,onOpen:()=>jump(item)}))}/>}
  bookmarks={<EpubBookmarks bookmarks={bookmarks} label={bookmarkLabel} onLabel={setBookmarkLabel} onAdd={addBookmark} onOpen={cfi=>session.current?.navigate({cfi})}
    onRemove={removeBookmark} canAdd={canAdd} disabled={disabled} valid={isSafeEpubCfi}/>}
  quotes={<ReaderQuoteList title={title} items={quotes.filter((q):q is Extract<ReaderQuote,{kind:'epub'|'fb2'}>=>q.kind===book.kind&&q.kind!=='pdf').map(q=>({
    id:q.id,text:q.text,comment:q.comment,location:q.chapter,onEdit:trigger=>editSavedQuote(q,trigger.getBoundingClientRect(),document,trigger),
    onRequestDelete:trigger=>editSavedQuote(q,trigger.getBoundingClientRect(),document,trigger,true),onOpen:()=>session.current?.navigate({cfi:q.cfi})}))}/>}
  notices={error?<div role="alert" className="er-epub-error"><p>Не удалось открыть или показать текст: {error}</p>
   <button type="button" onClick={()=>setRetry(value=>value+1)}>Повторить открытие</button>
   {book.progress?.cfi&&!ignoreSaved&&<button type="button" onClick={()=>setStartAtBeginningFor(book.documentId)}>Открыть с начала</button>}</div>
   :loading?<p role="status">Открытие книги…</p>:undefined}>
  <div ref={host} id={viewportId} tabIndex={0} aria-label={'Текст книги '+kind} aria-busy={loading||moving}
   className={'er-epub-viewport'+(style.spread==='double'&&style.flow!=='scrolled'?' er-spread':'')}/>
  <span role="status" className="er-reader-status">{bookmarkNotice}</span>
  <QuoteSelectionTools selection={selection} onSave={saveQuote} onDelete={removeQuote} onCancel={resetSelection}/>
 </ReaderChrome>;
}
