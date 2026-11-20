import type {ReaderQuote} from './types';

export interface PaintedQuote {quote:ReaderQuote;range:Range}

/** Use the rectangles of the actual saved range, in its own document. A
 * paragraph bounding box would also include unmarked words and line margins. */
export function savedQuoteAtClick(event:MouseEvent,marks:PaintedQuote[]){
 const target=event.target as Element|null;
 if(event.defaultPrevented||event.button!==0||event.detail>1||event.altKey||event.shiftKey||event.ctrlKey||event.metaKey||
    !target?.closest||target.closest('a,button,input,textarea,select,[role="link"],[contenteditable="true"]')||
    target.ownerDocument.getSelection()?.isCollapsed===false)return;
 const caret=target.ownerDocument.caretPositionFromPoint?.(event.clientX,event.clientY);
 let picked:{quote:ReaderQuote;rect:DOMRect}|undefined;
 for(const {quote,range} of marks){
  if(range.collapsed||!range.startContainer.isConnected||range.startContainer.ownerDocument!==target.ownerDocument||!range.intersectsNode(target))continue;
  if(caret?.offsetNode.nodeType===Node.TEXT_NODE&&!range.isPointInRange(caret.offsetNode,caret.offset))continue;
  // In overlapping passages the shortest one wins; both remain reachable in the list.
  if(picked&&picked.quote.text.length<=quote.text.length)continue;
  for(const rect of range.getClientRects()){
   if(event.clientX>=rect.left&&event.clientX<rect.right&&event.clientY>=rect.top&&event.clientY<rect.bottom){
    picked={quote,rect};break;
   }
  }
 }
 return picked;
}
