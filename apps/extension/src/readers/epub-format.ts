import type {Contents} from 'epubjs';
import type {PaintedQuote} from './saved-quote-hit';
import type {ReaderAppearance,ReaderQuote} from './types';
export type EpubAppearance = Extract<ReaderAppearance,{kind:'epub'|'fb2'}>;
export const pageColors = {
 light:{paper:'#ffffff',text:'#2c2c36',muted:'#606171',accent:'#5146a1',highlight:'#dedbff'},
 cream:{paper:'#fbf5df',text:'#362f26',muted:'#696051',accent:'#54478e',highlight:'#e5dcf7'},
 dark:{paper:'#363636',text:'#f1f0ef',muted:'#c5c2c7',accent:'#b8b0ff',highlight:'#595476'}
};
export function applyBookStyle(doc:Document,style:EpubAppearance):boolean{
 const c=pageColors[style.theme];
 // Trusted reader CSS only. Do not restore discarded EPUB styles, resources or scripts.
 let sheet=doc.head.querySelector<HTMLStyleElement>('style[data-reader-format]');
 if(!sheet){sheet=doc.createElement('style');sheet.dataset.readerFormat='';doc.head.append(sheet);}
 const headingStyle=style.publisher!==false ?
  'h1,h2,h3,header{text-align:center;font-family:inherit}'+
  'h2,header h2{font-size:1.5em;font-weight:650}h3{font-weight:600;font-style:italic}'+
  'p+p{text-indent:1.15em}blockquote{border:0;text-align:center;margin:.85em 1.5em}blockquote p{text-indent:0}'+
  '[data-reader-align=center]{text-align:center}[data-reader-align=right]{text-align:right}[data-reader-align=left]{text-align:left}[data-reader-align=justify]{text-align:justify}'+
  '[data-reader-emphasis=italic]{font-style:italic}[data-reader-weight=bold]{font-weight:bold}'+
  '[data-reader-heading]{text-align:center;text-indent:0;line-height:1.2;break-after:avoid;max-inline-size:32em;margin-inline:auto}'+
  '[data-reader-heading=label]{font-size:.92em;font-style:italic;font-weight:500;color:'+c.muted+';margin-block:.65em .7em}'+
  '[data-reader-heading=title],[data-reader-heading=line]{font-size:1.46em;font-weight:600;font-style:normal;margin-block:0 .9em}'+
  '[data-reader-heading=subtitle]{font-size:1.16em;font-weight:550;margin-block:.3em .8em}':
  'h1,h2,h3,h4,h5,h6{text-align:start;font-style:normal;font-weight:600}'+
  'h1{font-size:1.35em}h2,header h2{font-size:1.2em}h3{font-size:1.08em}'+
  '[data-reader-heading]{text-align:start;text-indent:0;line-height:1.3;break-after:avoid;font-size:1em;font-weight:inherit;font-style:normal;margin-block:.35em .55em}'+
  '[data-reader-heading=label] :is(i,em){font-style:inherit}'+
  '[data-reader-heading=line]{margin-top:0}';
 // epub.js measures a section's text range and expands its iframe to that height.
 // Keep the measure on the text, not on the native scrolling stage. Long TOC labels
 // and preformatted lines must wrap before the iframe reports its dimensions.
 const scrollingStyle=style.flow==='scrolled'?
  'html{overflow:clip!important}'+
  'body{box-sizing:border-box!important;width:100%!important;max-width:880px;height:auto!important;'+
  'margin-inline:auto!important;padding-inline:clamp(48px,6vw,72px)!important;overflow-wrap:anywhere}'+
  'pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;table-layout:fixed}'+
  'figure,blockquote{margin-inline:min(1.2em,5%)!important}ol,ul{padding-inline-start:min(2em,12%)}':'';
 const css='html,body{color:'+c.text+'!important;background:'+c.paper+'!important;font-family:system-ui,sans-serif!important;}'+
 'body{font-size:'+style.fontSize+'px!important;line-height:'+style.lineHeight+'!important;overflow-wrap:break-word;transition:color .18s,background-color .18s}'+
 'a{color:'+c.accent+'!important}img{max-width:100%;object-fit:contain}'+
 'h1,h2,h3,h4,h5,h6{line-height:1.22;break-after:avoid;overflow-wrap:anywhere}'+
 'h1{font-size:1.9em;margin:.5em 0 .6em}h2,header h2{font-size:1.46em;margin:.6em 0 .5em}h3{font-size:1.18em;margin:1em 0 .4em}'+
 'h4,h5,h6{font-size:1em;margin:.85em 0 .4em}p{margin:.45em 0 .75em}section,header,article{margin-block:.3em}'+
 'blockquote{margin:.8em 0 1em;padding:.2em 0 .2em 1em;border-inline-start:.15em solid '+c.accent+';font-style:italic}'+
 'blockquote p{margin:.2em 0}blockquote cite,blockquote footer{font-size:.8em;color:'+c.muted+'}'+
 '::selection{background:'+c.highlight+';color:'+c.text+'}::highlight(reader-quotes){background:'+c.highlight+';color:'+c.text+'}'+
 '::highlight(reader-search-hit){background-color:'+c.accent+';color:'+c.paper+';text-decoration:underline}'+
 headingStyle+scrollingStyle+
 '[data-reader-heading][data-reader-heading-more]{margin-block-end:0}[data-reader-heading-gap]{display:none}'+
 '@media(prefers-reduced-motion:reduce){body{transition:none}}';
 if(sheet.textContent===css)return false;
 sheet.textContent=css;return true;
}
export function formatBookContents(contents:Contents,style:EpubAppearance):void{
 // The initial iframe height is measured before the rendition content hook.
 // Remeasure the actual wrapped text before the continuous manager positions its neighbours.
 if(applyBookStyle(contents.document,style)&&style.flow==='scrolled')contents.emit('expand');
}
type HighlightWindow = Window & {Highlight?:new(...ranges:Range[])=>{priority:number};CSS?:{highlights?:Map<string,unknown>}};
export interface EpubSearchHit {cfi:string;text:string;section:number}
export function paintSearchHit(contents:Contents,hit?:EpubSearchHit):void{
 const win=contents.window as HighlightWindow,registry=win.CSS?.highlights;
 if(!registry)return;
 const name='reader-search-hit';
 if(hit?.section===contents.sectionIndex&&win.Highlight){
  try{
   const range=contents.range(hit.cfi);
   if(range&&!range.collapsed&&range.toString()===hit.text){
    const highlight=new win.Highlight(range);
    highlight.priority=1;
    registry.set(name,highlight);return;
   }
  }catch{/* A detached frame or stale CFI cannot identify a result on this page. */}
 }
 registry.delete(name);
}
export function paintQuotes(contents:Contents,quotes:ReaderQuote[],belongs:(cfi:string)=>boolean):PaintedQuote[]{
 const win=contents.window as HighlightWindow,registry=win.CSS?.highlights;
 if(!registry||!win.Highlight)return [];
 const marks:PaintedQuote[]=[];
 for(const quote of quotes){
  if(quote.kind==='pdf')continue;
  try{if(!belongs(quote.cfi))continue;const range=contents.range(quote.cfi);if(range&&!range.collapsed&&range.toString()===quote.text)marks.push({quote,range});}catch{/* A stale anchor must not prevent reading the chapter. */}
 }
 if(marks.length)registry.set('reader-quotes',new win.Highlight(...marks.map(mark=>mark.range)));
 else registry.delete('reader-quotes');
 return marks;
}
