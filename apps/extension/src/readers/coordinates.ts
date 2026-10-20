/** Convert a same-origin reader Range into the top-level popup viewport.
 * Bounds are recomputed after scrolling; hidden/detached anchors close the popup.
 */
export function readerAnchor(range:Range,targetDocument:Document=document):DOMRect|null {
 if(range.collapsed||!range.startContainer.isConnected||!range.endContainer.isConnected)return null;
 let doc=range.startContainer.ownerDocument;if(!doc)return null;
 let rect=range.getBoundingClientRect();
 try {
  while(doc!==targetDocument){
   const view=doc.defaultView;if(!view||rect.bottom<=0||rect.right<=0||rect.top>=view.innerHeight||rect.left>=view.innerWidth)return null;
   const frame=view.frameElement as HTMLElement|null;if(!frame||!frame.isConnected)return null;
   const outer=frame.getBoundingClientRect(),sx=frame.offsetWidth?outer.width/frame.offsetWidth:1,sy=frame.offsetHeight?outer.height/frame.offsetHeight:1;
   rect=new DOMRect(outer.left+(frame.clientLeft+rect.left)*sx,outer.top+(frame.clientTop+rect.top)*sy,rect.width*sx,rect.height*sy);
   doc=frame.ownerDocument;
  }
  return rect;
 }catch{return null;}
}
