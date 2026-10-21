import { extractAtPoint, extractSelection, isEditable, type ExtractedText, type ExtractionResult } from './extraction';
export interface ActivationOptions {
  document: Document;
  /** The popup may live in the parent document of a same-origin book frame. */
  popupDocument?: Document;
  /** Synchronous cached preference; read only on explicit trusted activation. */
  getLocale?: () => string | undefined;
  onActivate: (value: ExtractedText, anchor: DOMRect) => void;
  onStatus?: (failure: Extract<ExtractionResult,{ok:false}>) => void;
  /** Distinguish the popup from readable page text, including a composed Shadow DOM path. */
  isPopupEvent?: (event: Event) => boolean;
  /** The currently open lookup, not the last one that was dismissed. */
  getActiveSelection?: () => ExtractedText | null;
}
/** Cross-realm friendly: EPUB frame nodes do not share the parent's HTMLElement. */
function isPopupNode(target: EventTarget | Node | null): boolean {
  let node = target && 'nodeType' in target ? target as Node : null;
  while (node) {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (element?.closest('[data-english-reader-popup]')) return true;
    node = (node.getRootNode() as ShadowRoot).host ?? null;
  }
  return false;
}
export function isReadingPopupEvent(event: Event): boolean { return event.composedPath().some(isPopupNode); }
/** Pure guard for testing. The installed listener passes the native event unmodified. */
export function shouldActivate(event: Pick<KeyboardEvent,'key'|'isTrusted'|'repeat'|'isComposing'|'ctrlKey'|'altKey'|'metaKey'> & Partial<Pick<KeyboardEvent,'keyCode'>>, composing=false, editable=false): boolean {
  return event.key === 'Shift' && event.isTrusted && !event.repeat && !event.isComposing && event.keyCode !== 229 && !composing && !editable && !event.ctrlKey && !event.altKey && !event.metaKey;
}
function sameSelection(a: ExtractedText, b: ExtractedText): boolean {
  return a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
    a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset &&
    a.expression === b.expression && a.context.sentence === b.context.sentence &&
    a.context.targetStart === b.context.targetStart && a.context.targetEnd === b.context.targetEnd;
}
const registrations = new WeakMap<Document, () => void>();
/** Only fresh keydown can activate. Pointer tracking never calls extraction or a service. */
export function installActivation(options: ActivationOptions): () => void {
  const doc = options.document;
  // A rerender/re-registration must not leave two paid activation listeners behind.
  registrations.get(doc)?.();
  let point: {x:number;y:number}|null = null, composing = false, disposed = false;
  const popupEvent = options.isPopupEvent ?? isReadingPopupEvent;
  const move = (event: MouseEvent) => {
    if (event.isTrusted) point = popupEvent(event) ? null : {x:event.clientX,y:event.clientY};
  };
  const beginComposition = () => { composing = true; };
  const endComposition = () => { composing = false; };
  const leave = () => { point = null; };
  const blur = () => { composing = false; point = null; };
  const key = (event: KeyboardEvent) => {
    if (disposed) return;
    const fromPopup = popupEvent(event);
    const editable = event.composedPath().some(isEditable) || isEditable(doc.activeElement);
    if (!shouldActivate(event,composing,editable)) return;
    const active = options.getActiveSelection?.();
    // Popup text and its controls are never a source. A new external selection
    // may replace it, even while the nonmodal panel still owns keyboard focus.
    if (fromPopup && !active) return;
    const locale = options.getLocale?.();
    const selection = extractSelection(doc,locale);
    const result = selection ?? (point ? extractAtPoint(doc,point.x,point.y,locale) : null);
    if (!result) return;
    if (!result.ok) { if (!fromPopup) options.onStatus?.(result); return; }
    if (isPopupNode(result.range.startContainer) || isPopupNode(result.range.endContainer) ||
        !result.range.startContainer.isConnected || !result.range.endContainer.isConnected || result.range.collapsed) return;
    if (active && sameSelection(result,active)) return;
    const anchor = result.range.getBoundingClientRect();
    options.onActivate(result,anchor);
  };
  // Window capture gets the event before ordinary page/document key handlers.
  // Browser shortcuts, protected pages and earlier capture handlers remain outside our control.
  const keyboardTarget = doc.defaultView ?? doc;
  const parentDoc = options.popupDocument && options.popupDocument !== doc ? options.popupDocument : null;
  const parentTarget = parentDoc?.defaultView ?? parentDoc;
  const parentKey = (event: KeyboardEvent) => {
    if (!popupEvent(event) || options.getActiveSelection?.()?.range.startContainer.ownerDocument !== doc) return;
    key(event);
  };
  doc.addEventListener('mousemove',move,{passive:true});
  doc.addEventListener('pointermove',move,{passive:true});
  doc.addEventListener('mouseleave',leave);
  doc.addEventListener('compositionstart',beginComposition,true);
  doc.addEventListener('compositionend',endComposition,true);
  keyboardTarget.addEventListener('keydown',key as EventListener,true);
  parentTarget?.addEventListener('keydown',parentKey as EventListener,true);
  doc.defaultView?.addEventListener('blur',blur);
  const dispose = () => {
    if (disposed) return;
    disposed = true; point = null; composing = false;
    doc.removeEventListener('mousemove',move);
    doc.removeEventListener('pointermove',move);
    doc.removeEventListener('mouseleave',leave);
    doc.removeEventListener('compositionstart',beginComposition,true);
    doc.removeEventListener('compositionend',endComposition,true);
    keyboardTarget.removeEventListener('keydown',key as EventListener,true);
    parentTarget?.removeEventListener('keydown',parentKey as EventListener,true);
    doc.defaultView?.removeEventListener('blur',blur);
    if (registrations.get(doc) === dispose) registrations.delete(doc);
  };
  registrations.set(doc,dispose);
  return dispose;
}
