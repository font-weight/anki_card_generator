import type {Location} from 'epubjs';

export interface SpineEdges {first?:number; last?:number}
const EDGE_TOLERANCE=2;

function liveSection(stage:HTMLElement,index:number|undefined){
 if(index===undefined)return;
 const view=stage.querySelector<HTMLElement>(`:scope > .epub-view[ref="${index}"]`);
 // Continuous keeps sized placeholders after unloading their iframes.
 const frame=view?.querySelector<HTMLIFrameElement>(':scope > iframe');
 if(!view||!frame||frame.getBoundingClientRect().height<=0)return;
 const rect=view.getBoundingClientRect();
 return rect.height>0?rect:undefined;
}

export function alignScrollEdge(host:HTMLElement|null,index:number|undefined,edge:'first'|'last'){
 const stage=host?.querySelector<HTMLElement>(':scope > .epub-container');
 if(!stage||!stage.clientHeight)return;
 const view=liveSection(stage,index);
 if(!view)return;
 const top=stage.getBoundingClientRect().top+stage.clientTop;
 stage.scrollTop+=edge==='first'?view.top-top:view.bottom-top-stage.clientHeight;
}

interface ScrollSample {section:number;offset:number;height:number;width:number;viewportHeight:number}
export function directionalPercent(previous:(ScrollSample&{percent:number})|undefined,here:ScrollSample,percent:number){
 if(!previous||previous.section!==here.section||previous.height!==here.height||
    previous.width!==here.width||previous.viewportHeight!==here.viewportHeight)return percent;
 // Mapping.page can fall back to a paragraph's first word as its last line
 // crosses the viewport. Only stabilize the readout. Its returned CFI stays exact.
 if(here.offset===previous.offset)return previous.percent;
 return here.offset>previous.offset?Math.max(previous.percent,percent):Math.min(previous.percent,percent);
}
export type MeasuredProgress=ScrollSample&{percent:number};

export function scrollEdges(host:HTMLElement|null,spine:SpineEdges,location:Location){
 const stage=host?.querySelector<HTMLElement>(':scope > .epub-container');
 if(!stage||stage.clientHeight<=0||stage.scrollHeight<=0)return {atStart:false,atTop:false,atEnd:false,sample:undefined};
 const top=stage.getBoundingClientRect().top+stage.clientTop,bottom=top+stage.clientHeight;
 // epub.js rounds the section's displayed page to whole screens. A partly
 // visible final screen can already report atEnd while it still has unread lines.
 const visible=liveSection(stage,location.start.index);
 const sample=visible?{section:location.start.index,offset:top-visible.top,height:visible.height,
  width:stage.clientWidth,viewportHeight:stage.clientHeight}:undefined;
 const first=stage.scrollTop<=EDGE_TOLERANCE&&location.start.index===spine.first?visible:undefined;
 const remaining=stage.scrollHeight-stage.clientHeight-stage.scrollTop;
 const last=remaining<=EDGE_TOLERANCE&&location.end?.index===spine.last?liveSection(stage,spine.last):undefined;
 const atStart=!!first&&first.top>=top-EDGE_TOLERANCE&&first.top<bottom;
 return {atStart,atTop:atStart&&stage.scrollTop<=0,sample,
  atEnd:!!last&&last.bottom<=bottom+EDGE_TOLERANCE&&last.bottom>top};
}
