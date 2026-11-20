import type {ReaderQuote} from './types';
import type {QuoteSelection} from './QuoteSelectionTools';

export type PdfQuote = Extract<ReaderQuote,{kind:'pdf'}>;
export type PdfQuoteSelection = QuoteSelection & Pick<PdfQuote,'page'|'endPage'|'start'|'end'>;

function layerFor(node: Node) {
  return (node.nodeType===Node.ELEMENT_NODE?node as Element:node.parentElement)?.closest<HTMLElement>('.textLayer');
}
function textOffset(layer:HTMLElement,node:Node,offset:number) {
  const prefix=layer.ownerDocument.createRange();prefix.selectNodeContents(layer);prefix.setEnd(node,offset);
  return prefix.toString().length;
}
export function pdfSelection(host:HTMLElement,range:Range): PdfQuoteSelection|null {
  const first=layerFor(range.startContainer),last=layerFor(range.endContainer);
  if(range.collapsed || !first || !last || !host.contains(first) || !host.contains(last)) return null;
  const page=Number(first.closest<HTMLElement>('[data-page]')?.dataset.page);
  const endPage=Number(last.closest<HTMLElement>('[data-page]')?.dataset.page);
  if(!Number.isSafeInteger(page)||!Number.isSafeInteger(endPage)||page<1||endPage<page) return null;
  const start=textOffset(first,range.startContainer,range.startOffset),end=textOffset(last,range.endContainer,range.endOffset);
  const excerpts:string[]=[];
  for(let n=page;n<=endPage;n++){
    const layer=host.querySelector<HTMLElement>(`[data-page="${n}"][data-page-ready="true"] .textLayer`);
    if(!layer)return null;
    const value=layer.textContent||'';
    excerpts.push(value.slice(n===page?start:0,n===endPage?end:undefined));
  }
  const text=excerpts.join(' ').trim();if(!text)return null;
  const rect=range.getBoundingClientRect();
  return {page,...(endPage!==page?{endPage}:{}),start,end,text,rect};
}

/** Map UTF-16 offsets back into the PDF.js text layer. Its positioned nodes stay intact for Shift lookups. */
export function quoteRange(layer:HTMLElement,number:number,quote:Pick<PdfQuote,'page'|'endPage'|'start'|'end'|'text'>): Range|null {
  const last=quote.endPage??quote.page;
  if(number<quote.page||number>last)return null;
  const start=number===quote.page?quote.start:0,end=number===last?quote.end:(layer.textContent||'').length;
  if(end<=start)return null;
  const doc=layer.ownerDocument, walker=doc.createTreeWalker(layer,NodeFilter.SHOW_TEXT);
  let at=0,startNode:Node|null=null,startOffset=0;
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    const length=node.textContent?.length??0;
    if(!startNode&&start<at+length){startNode=node;startOffset=start-at;}
    if(startNode&&end<=at+length){
      const range=doc.createRange();range.setStart(startNode,startOffset);range.setEnd(node,end-at);
      const fragment=range.toString();
      // pdfSelection joins adjacent pages with a space, then trims the complete passage.
      if(quote.page===last)return fragment.trim()===quote.text?range:null;
      if(number===quote.page)return quote.text.startsWith(fragment.trimStart())?range:null;
      if(number===last)return quote.text.endsWith(fragment.trimEnd())?range:null;
      return quote.text.includes(fragment)?range:null;
    }
    at+=length;
  }
  return null;
}
