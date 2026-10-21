import React,{useEffect,useId,useRef,useState} from 'react';
import ePub,{type Book,type Contents,type Location,type Rendition} from 'epubjs';
import {prepareSafeEpub,unpackEpub,type SafeEpub} from './epub-security';
import {convertFb2ToEpub} from './fb2';
import type {DocumentReady,ReadingProgress,StoredBook} from './types';
import './epub-reader.css';

interface Props {book:StoredBook;onProgress:(progress:ReadingProgress)=>void;onDocumentReady?:DocumentReady}
interface TocItem {id:string;href:string;label:string;subitems?:TocItem[]}
interface TocEntry {key:string;href:string;label:string;depth:number}
interface Position {tocKey:string;chapter:string;page?:number;total?:number;atStart:boolean;atEnd:boolean}
interface Session {navigate:(target:'prev'|'next'|{href:string})=>boolean;refresh:()=>void;keydown:(event:KeyboardEvent)=>void}
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
 const controls='input,textarea,select,a,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="slider"],[role="dialog"],[data-english-reader-popup]';
 // Use nodeType, not instanceof Element: targets can belong to a sandbox iframe realm.
 if(event.composedPath().some(node=>(node as Element)?.nodeType===1&&(node as Element).closest(controls)))return true;
 for(const doc of documents)if(hasSelection(doc)||doc.querySelector('[data-english-reader-popup],[role="dialog"]:not([hidden])'))return true;
 return false;
}

export function EpubReader({book,onProgress,onDocumentReady}:Props){
 const host=useRef<HTMLDivElement>(null),reader=useRef<HTMLElement>(null),session=useRef<Session|undefined>(undefined);
 const current=useRef({cfi:book.progress?.cfi||'',chapter:book.progress?.chapter||''});
 const progressRef=useRef(onProgress),readyRef=useRef(onDocumentReady);progressRef.current=onProgress;readyRef.current=onDocumentReady;
 const [toc,setToc]=useState<TocEntry[]>([]),[position,setPosition]=useState<Position>(emptyPosition),[error,setError]=useState('');
 const [loading,setLoading]=useState(true),[opened,setOpened]=useState(false),[startAtBeginningFor,setStartAtBeginningFor]=useState<string>(),[moving,setMoving]=useState(false),[warnings,setWarnings]=useState<string[]>([]),[retry,setRetry]=useState(0);
 const [font,setFont]=useState(20),[width,setWidth]=useState('comfortable'),[line,setLine]=useState(1.7),[theme,setTheme]=useState('light');
 const appearance=useRef({font,line,theme});appearance.current={font,line,theme};
 const helpId=useId(),viewportId=useId(),kind=book.kind==='fb2'?'FB2':'EPUB',ignoreSaved=startAtBeginningFor===book.documentId;

 useEffect(()=>{
  let cancelled=false,instance:Book|undefined,r:Rendition|undefined,safe:SafeEpub|undefined;
  let busy=true,ready=false,layoutPending=false,preservingCfi=false,lastLayout='';
  let failOperation:((error:unknown)=>void)|undefined,observer:ResizeObserver|undefined;
  let entries:TocEntry[]=[],lastPosition=emptyPosition;
  const anchors=new Map<string,string>(),documents=new Map<Document,()=>void>();
  current.current={cfi:ignoreSaved?'':book.progress?.cfi||'',chapter:ignoreSaved?'':book.progress?.chapter||''};
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
   if(typeof target!=='string'&&!entries.some(item=>item.href===target.href))return false;
   return run(()=>typeof target==='string'?r![target]():r!.display(target.href));
  };
  const keydown=(event:KeyboardEvent)=>{
   const direction=event.key==='ArrowLeft'||event.key==='PageUp'?'prev':event.key==='ArrowRight'||event.key==='PageDown'?'next':null;
   if(!direction||blocksPaging(event,[document,...documents.keys()]))return;
   if(navigate(direction))event.preventDefault();
  };
  const ownSession:Session={navigate,refresh,keydown};session.current=ownSession;
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
   cancelled=true;failOperation?.(new Error('Книга закрыта'));observer?.disconnect();window.removeEventListener('resize',resized);root.removeEventListener('keydown',keydown);
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
   <label>Шрифт <input aria-label="Размер шрифта" type="range" min="14" max="36" value={font} onChange={event=>setFont(+event.target.value)}/><output>{font} px</output></label>
   <label>Ширина <select value={width} onChange={event=>setWidth(event.target.value)}><option value="comfortable">Удобная</option><option value="wide">Широкая</option><option value="full">Во весь экран</option></select></label>
   <label>Интервал <select value={line} onChange={event=>setLine(+event.target.value)}>{[1.3,1.5,1.7,2].map(n=><option key={n}>{n}</option>)}</select></label>
   <label>Тема <select value={theme} onChange={event=>setTheme(event.target.value)}><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
  </div><p id={helpId}>Щёлкните по тексту книги или перейдите к нему клавишей Tab. Листайте ← → или Page Up / Page Down. При выделенном тексте, открытом переводе и в полях ввода клавиши не листают книгу. Экраны считаются внутри раздела файла, а не всей книги: их число меняется с размером окна и шрифтом. Позиция сохраняется по тексту.</p>{warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>
  {loading&&<p role="status">Безопасная обработка {kind}…</p>}
  {error&&<div role="alert"><p>Не удалось открыть или показать текст: {error}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>Повторить открытие</button>{book.progress?.cfi&&!ignoreSaved&&<button type="button" onClick={()=>setStartAtBeginningFor(book.documentId)}>Открыть с начала</button>}</div>}
  <div ref={host} id={viewportId} tabIndex={0} aria-label={`Текст книги ${kind}`} aria-describedby={helpId} aria-busy={loading||moving} className={`er-epub-viewport er-epub-width-${width} er-epub-theme-${theme}`}/>
 </section>;
}
