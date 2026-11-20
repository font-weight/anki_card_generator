import {readerPagingControls} from './keyboard-paging';

export type PanelDismissRef = {current: (()=>void) | null};
type RestoreWord=(range:Range)=>{range:()=>Range|null;selected:(range:Range)=>void}|undefined;
const longPressMs=650,travel=8;

function wordAt(doc:Document,x:number,y:number):Range|undefined{
 const caret=doc.caretPositionFromPoint?.(x,y);
 const legacy=caret?null:(doc as Document&{caretRangeFromPoint?:(x:number,y:number)=>Range|null}).caretRangeFromPoint?.(x,y);
 const node=caret?.offsetNode??legacy?.startContainer,offset=caret?.offset??legacy?.startOffset;
 if(node?.nodeType!==Node.TEXT_NODE||offset===undefined)return;
 const text=(node as Text).data;
 // Find just the touched word. A click in the margin of a long chapter
 // must not extract or segment its entire sentence or text layer.
 const parts=new Intl.Segmenter(doc.documentElement.lang||'und',{granularity:'word'}).segment(text);
 const part=parts.containing(offset);
 const word=part?.isWordLike?part:offset>0?parts.containing(offset-1):undefined;
 if(!word?.isWordLike)return;
 const range=doc.createRange();range.setStart(node,word.index);range.setEnd(node,word.index+word.segment.length);
 const rects=range.getClientRects?.();
 if(rects?.length&&![...rects].some(r=>r.left-1<=x&&x<=r.right+1&&r.top<=y&&y<=r.bottom))return;
 return range;
}
function surfaceHit(event:MouseEvent,surface:HTMLElement){
 const raw=event.target as Node|null;
 const target=raw?.nodeType===1?raw as Element:raw?.parentElement;
 if(!target||!surface.contains(target))return;
 // Native scrollbar clicks target the scrolling element, not its descendants.
 const scroller=target as HTMLElement;
 if(scroller.offsetWidth>scroller.clientWidth&&scroller.scrollHeight>scroller.clientHeight){
  const x=event.clientX-scroller.getBoundingClientRect().left;
  if(x<scroller.clientLeft||x>=scroller.clientLeft+scroller.clientWidth)return;
 }
 const link=target.closest('a,area'),control=target.closest(readerPagingControls+',.er-quote-tools');
 if(control&&(control!==link||control.matches('[role]:not([role="link"])')||control.parentElement?.closest(readerPagingControls)))return;
 return {target,link:!!link?.matches('[href],[data-external-link]')};
}
function plain(e:MouseEvent){return e.button===0&&!e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey;}

/** True for primary presses on the book or its paper while the reader drawer is open. */
export function isBookPanelSurfacePress(event:PointerEvent):boolean{
 const node=event.target as Node|null,doc=node?.ownerDocument;
 if(!doc||!plain(event)||event.isPrimary===false)return false;
 const frame=doc.defaultView?.frameElement;
 const outer=frame?.closest('.er-epub-viewport')?frame.ownerDocument:doc;
 const area=outer.querySelector<HTMLElement>('.rc-shell:has(.rc-panel) .rc-book-view');
 return !!area&&(doc===outer?!!surfaceHit(event,area):
  !!frame&&area.contains(frame)&&!!surfaceHit(event,doc.documentElement));
}

/** The native click commits a completed gesture. No timer, focus change or simulated click. */
export function watchBookSurfaceTaps(owner:HTMLElement,dismiss:PanelDismissRef,remember?:RestoreWord){
 const outer=owner.ownerDocument,documents=new Map<Document,()=>void>();
 type Press={doc:Document;id:number;x:number;y:number;time:number;close:(()=>void)|null;released:boolean;blocked:boolean;editorRange?:Range};
 let press:Press|undefined;
 const clock=()=>outer.defaultView!.performance.now();
 type Word={doc:Document;node:Node;x:number;y:number;at:number;range:()=>Range|null;selected:(r:Range)=>void};
 let word:Word|undefined,releaseEditorLayout:(()=>void)|undefined;
 function keepEditorAnchor(){
  const editor=outer.querySelector('[data-english-reader-popup],.er-quote-editor');
  const page=owner.querySelector<HTMLElement>('.rc-page');
  if(!editor||!page||releaseEditorLayout)return;
  // A live editor holds a range in this exact iframe or PDF text layer.
  // Let the drawer disappear now without destroying its source and draft.
  const rect=page.getBoundingClientRect();if(!rect.width||!rect.height)return;
  const vars={'--rc-editor-x':rect.left,'--rc-editor-y':rect.top,'--rc-editor-w':rect.width,'--rc-editor-h':rect.height};
  for(const [key,value] of Object.entries(vars))page.style.setProperty(key,value+'px');
  page.setAttribute('data-editor-anchor','');
  const observer=new MutationObserver(()=>{if(!editor.isConnected)releaseEditorLayout?.();});
  observer.observe(outer.documentElement,{childList:true,subtree:true});
  releaseEditorLayout=()=>{
   observer.disconnect();page.removeAttribute('data-editor-anchor');
   for(const key of Object.keys(vars))page.style.removeProperty(key);
   releaseEditorLayout=undefined;
  };
 }
 const reset=()=>{press=undefined;word=undefined;};
 const relocated=()=>{if(press&&!press.released)press.blocked=true;};
 const add=(doc:Document,surface:HTMLElement)=>{
  const near=(e:MouseEvent,p:Press)=>doc===p.doc&&Math.hypot(p.x-e.clientX,p.y-e.clientY)<=travel;
  const point=(e:MouseEvent)=>{const frame=doc===outer?null:doc.defaultView?.frameElement?.getBoundingClientRect();
   return {x:e.clientX+(frame?.left??0),y:e.clientY+(frame?.top??0)};};
  const cancel=()=>{if(press)press.blocked=true;word=undefined;};
  const down=(e:PointerEvent)=>{
   const hit=surfaceHit(e,surface),valid=!!hit&&plain(e)&&e.isPrimary!==false;
   if(!valid||dismiss.current)word=undefined;
   const selection=doc.getSelection();
   const editorRange=valid&&selection?.rangeCount&&!selection.isCollapsed&&outer.querySelector('[data-english-reader-popup],.er-quote-editor')?
    selection.getRangeAt(0).cloneRange():undefined;
   press={editorRange,doc,id:e.pointerId,x:e.clientX,y:e.clientY,time:e.timeStamp,close:dismiss.current,released:false,blocked:!valid};
  };
  const move=(e:PointerEvent)=>{
   if(press&&press.id===e.pointerId&&!near(e,press))cancel();
   if(word){const p=point(e);if(Math.hypot(word.x-p.x,word.y-p.y)>travel)word=undefined;}
  };
  const up=(e:PointerEvent)=>{
   if(!press)return;
   if(press.id!==e.pointerId||!near(e,press)||!plain(e)||e.timeStamp-press.time>longPressMs)cancel();
   press.released=true;
  };
  const click=(e:MouseEvent)=>{
   const p=press;press=undefined;
   const hit=surfaceHit(e,surface);
   if(!hit||!plain(e)||(!hit.link&&e.defaultPrevented)||p&&(p.blocked||!near(e,p)||p.close!==dismiss.current))return;
   // detail=0 with no physical press is an accessibility/keyboard activation.
   if(!p?.released&&e.detail===0)return;
   const xy=point(e);
   if(!dismiss.current&&word){
    const original=word;word=undefined;
    // A resized EPUB can replace its iframe between both presses. Such a second
    // click has detail=1 in the new document even though the physical point is identical.
    if(hit.link||Math.hypot(xy.x-original.x,xy.y-original.y)>travel||
       (e.detail<2&&(clock()-original.at>500||doc===original.doc&&original.node.isConnected)))return;
    try{
     const range=original.range();if(!range)return;
     const current=range.startContainer.ownerDocument!,selection=current.getSelection();
     if(!selection)return;
     if(current===doc&&selection.toString().trim()===range.toString()&&selection.containsNode(range.startContainer,true))return;
     selection.removeAllRanges();selection.addRange(range);original.selected(range);
    }catch{/* The book or PDF layer can disappear while resolving the original word. */}
    return;
   }
   const selection=doc.getSelection();
   if(!dismiss.current||e.detail>1||!owner.isConnected||!hit.target.isConnected)return;
   const selected=selection?.rangeCount&&!selection.isCollapsed?selection.getRangeAt(0):null;
   const held=p?.editorRange;
   if(selected&&surface.contains(selected.commonAncestorContainer)&&!(held&&
      selected.compareBoundaryPoints(Range.START_TO_START,held)===0&&selected.compareBoundaryPoints(Range.END_TO_END,held)===0))return;
   if(!selected&&held&&selection&&held.startContainer.isConnected){
    selection.removeAllRanges();selection.addRange(held);
   }
   if(remember&&!hit.link){
    try{
     const range=wordAt(doc,e.clientX,e.clientY),anchor=range&&remember(range);
     if(range&&anchor)word={...anchor,node:range.startContainer,doc,...xy,at:clock()};
    }catch{/* Remembering the optional double-click target must never delay or cancel dismissal. */}
   }
   keepEditorAnchor();dismiss.current();
  };
  const events=new (doc.defaultView?.AbortController??AbortController)();
  const capture={capture:true,passive:true,signal:events.signal};
  doc.addEventListener('pointerdown',down,capture);doc.addEventListener('pointermove',move,capture);
  doc.addEventListener('pointerup',up,capture);doc.addEventListener('pointercancel',cancel,capture);
  doc.addEventListener('click',click,capture);
  doc.addEventListener('contextmenu',cancel,capture);doc.addEventListener('dragstart',cancel,capture);
  doc.addEventListener('wheel',cancel,capture);doc.addEventListener('scroll',relocated,capture);
  (doc.defaultView??doc).addEventListener('keydown',cancel,capture);
  const remove=()=>{events.abort();if(press?.doc===doc)press=undefined;documents.delete(doc);};
  documents.set(doc,remove);return remove;
 };
 add(outer,owner);
 return {addFrame:(doc:Document)=>add(doc,doc.documentElement),relocated,dispose:()=>{reset();releaseEditorLayout?.();for(const remove of documents.values())remove();}};
}
