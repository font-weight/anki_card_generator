import { extractAtPoint, extractSelection, isEditable, type ExtractedText, type ExtractionResult } from './extraction';
export interface ActivationOptions {
  document: Document;
  onActivate: (value: ExtractedText, anchor: DOMRect) => void;
  onStatus?: (failure: Extract<ExtractionResult,{ok:false}>) => void;
  /** Ignore events from the reader popup, including its composed Shadow DOM path. */
  isPopupEvent?: (event: Event) => boolean;
}
/** Pure guard for testing. The installed listener passes the native event unmodified. */
export function shouldActivate(event: Pick<KeyboardEvent,'key'|'isTrusted'|'repeat'|'isComposing'|'ctrlKey'|'altKey'|'metaKey'>, composing=false, editable=false): boolean {
  return event.key === 'Shift' && event.isTrusted && !event.repeat && !event.isComposing && !composing && !editable && !event.ctrlKey && !event.altKey && !event.metaKey;
}
/** Only keydown can activate. Mouse movement never calls an extraction/service callback. */
export function installActivation(options: ActivationOptions): () => void {
  const doc = options.document;
  let point: {x:number;y:number}|null = null, composing = false;
  const move = (event: MouseEvent) => { if (event.isTrusted) point = {x:event.clientX,y:event.clientY}; };
  const beginComposition = () => { composing = true; };
  const endComposition = () => { composing = false; };
  const leave = () => { point = null; };
  const key = (event: KeyboardEvent) => {
    if (options.isPopupEvent?.(event)) return;
    const editable = event.composedPath().some(isEditable) || isEditable(doc.activeElement);
    if (!shouldActivate(event,composing,editable)) return;
    const selection = extractSelection(doc);
    const result = selection ?? (point ? extractAtPoint(doc,point.x,point.y) : null);
    if (!result) return;
    if (!result.ok) { options.onStatus?.(result); return; }
    const anchor = result.range.getBoundingClientRect();
    options.onActivate(result,anchor);
  };
  doc.addEventListener('mousemove',move,{passive:true});
  doc.addEventListener('mouseleave',leave);
  doc.addEventListener('compositionstart',beginComposition,true);
  doc.addEventListener('compositionend',endComposition,true);
  doc.addEventListener('keydown',key,true);
  doc.defaultView?.addEventListener('blur',endComposition);
  return () => {
    doc.removeEventListener('mousemove',move);
    doc.removeEventListener('mouseleave',leave);
    doc.removeEventListener('compositionstart',beginComposition,true);
    doc.removeEventListener('compositionend',endComposition,true);
    doc.removeEventListener('keydown',key,true);
    doc.defaultView?.removeEventListener('blur',endComposition);
  };
}
