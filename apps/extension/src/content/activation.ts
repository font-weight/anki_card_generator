import { extractAtPoint, extractSelection, isEditable, type ExtractedText, type ExtractionResult } from './extraction';
import { createGrammarGesture, isCleanLeftAlt } from './grammar-gesture';
import { markReadingPosition, clearReadingPosition } from './reading-marker';
export interface ActivationOptions {
  document: Document;
  /** The popup may live in the parent document of a same-origin book frame. */
  popupDocument?: Document;
  /** Synchronous cached preferences; read only on explicit trusted activation. */
  getLocale?: () => string | undefined;
  getGrammarEnabled?: () => boolean;
  onReadingIntent?: () => void;
  onActivate: (value: ExtractedText, anchor: DOMRect) => void;
  onGrammarActivate?: (value: ExtractedText, anchor: DOMRect) => void;
  onStatus?: (failure: Extract<ExtractionResult,{ok:false}>) => void;
  /** Distinguish the popup from readable page text, including a composed Shadow DOM path. */
  isPopupEvent?: (event: Event) => boolean;
  /** The currently open source, not the last one that was dismissed. */
  getActiveSelection?: () => ExtractedText | null;
  getActiveKind?: () => 'lookup' | 'grammar' | null;
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
  return (!a.origin || !b.origin || a.origin === b.origin) && a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
    a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset &&
    a.expression === b.expression && a.context.sentence === b.context.sentence &&
    a.context.targetStart === b.context.targetStart && a.context.targetEnd === b.context.targetEnd;
}
const registrations = new WeakMap<Document, () => void>();
// A shared parent key event belongs to one book frame, even if epub.js retains
// multiple chapter documents. The last trusted hover, never focus alone, owns it.
const hoveredDocuments = new WeakMap<Document, Document>();
/** Only a trusted Shift or opted-in clean LeftAlt tap can activate. Pointer
 * tracking never calls extraction, preference RPC, or any network service. */
export function installActivation(options: ActivationOptions): () => void {
  const doc = options.document;
  registrations.get(doc)?.();
  const parentDoc = options.popupDocument && options.popupDocument !== doc ? options.popupDocument : null;
  const ownerDoc = parentDoc ?? doc;
  const sourceFrame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
  const live = () => !disposed && (!sourceFrame || sourceFrame.isConnected && sourceFrame.contentDocument === doc);
  let point: {x:number;y:number}|null = null, composing = false, disposed = false;
  const grammar = createGrammarGesture<{value:ExtractedText; text:string}>();
  const popupEvent = options.isPopupEvent ?? isReadingPopupEvent;
  const clearPoint = () => { point = null; if (hoveredDocuments.get(ownerDoc) === doc) hoveredDocuments.delete(ownerDoc); };
  const cancel = () => grammar.cancel();
  const move = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (point && (point.x !== event.clientX || point.y !== event.clientY)) cancel();
    if (!live() || popupEvent(event)) { clearPoint(); cancel(); return; }
    point = {x:event.clientX,y:event.clientY}; hoveredDocuments.set(ownerDoc,doc);
  };
  const parentMove = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    // Movement over book text belongs to the child document. A parent event
    // targeting the iframe element itself is on its border, outside that text.
    clearPoint(); cancel();
  };
  const beginComposition = () => { composing = true; cancel(); };
  const endComposition = () => { composing = false; cancel(); };
  const leave = () => { clearPoint(); cancel(); };
  const blur = () => { composing = false; leave(); };
  const editable = (event: KeyboardEvent, parent = false) => event.composedPath().some(isEditable) || isEditable((parent ? parentDoc : doc)?.activeElement ?? null);
  const validResult = (value: ExtractedText) => live() && value.range.startContainer.ownerDocument === doc &&
    !isPopupNode(value.range.startContainer) && !isPopupNode(value.range.endContainer) &&
    value.range.startContainer.isConnected && value.range.endContainer.isConnected && !value.range.collapsed;
  function extract(event: KeyboardEvent, sentence = false): ExtractedText | null {
    const fromPopup = popupEvent(event), active = options.getActiveSelection?.();
    if (fromPopup && !active) return null;
    const locale = options.getLocale?.();
    const selection = sentence ? extractSelection(doc,locale,'sentence') : extractSelection(doc,locale);
    const result = selection ?? (point ? sentence ? extractAtPoint(doc,point.x,point.y,locale,'sentence') : extractAtPoint(doc,point.x,point.y,locale) : null);
    if (!result) return null;
    if (!result.ok) {
      // Caret hit-testing can snap an empty margin to the nearest text. Missing
      // the glyph leaves the reader in place; explicit selection errors still matter.
      if (!fromPopup && (selection !== null || result.code !== 'no_text')) options.onStatus?.(result);
      return null;
    }
    return validResult(result) ? result : null;
  }
  function key(event: KeyboardEvent, parent = false) {
    if (!live()) { cancel(); return; }
    const inEditable = editable(event,parent);
    // A repeat, second modifier, letter, IME event or synthetic event invalidates
    // an in-flight tap. Never intercept ordinary Alt shortcuts or AltGr typing.
    cancel();
    const alt = isCleanLeftAlt(event,composing,inEditable);
    const shift = shouldActivate(event,composing,inEditable);
    if (alt || shift || (event.isTrusted && event.key === 'Escape')) options.onReadingIntent?.();
    if (alt && options.onGrammarActivate && options.getGrammarEnabled?.() === true) {
      const value = extract(event,true);
      if (value) grammar.begin(event,{value,text:value.range.toString()},true,composing,inEditable);
      return;
    }
    if (!shift) return;
    const result = extract(event);
    if (!result) return;
    markReadingPosition(result.range, ownerDoc);
    const active = options.getActiveSelection?.();
    if (active && sameSelection(result,active) && (options.getActiveKind?.() ?? 'lookup') === 'lookup') return;
    options.onActivate(result,result.range.getBoundingClientRect());
  }
  function release(event: KeyboardEvent, parent = false) {
    const captured = grammar.release(event,options.getGrammarEnabled?.() === true,composing,editable(event,parent));
    if (!captured || !validResult(captured.value) || captured.value.range.toString() !== captured.text) return;
    // Re-extraction on release detects edits elsewhere in the source sentence,
    // moved selections and reflow/retargeting while the key was held.
    const current = extract(event,true);
    if (!current || !sameSelection(current,captured.value)) return;
    const active = options.getActiveSelection?.();
    if (active && sameSelection(current,active) && options.getActiveKind?.() === 'grammar') return;
    options.onGrammarActivate?.(current,current.range.getBoundingClientRect());
  }
  const keyboardTarget = doc.defaultView ?? doc;
  const parentTarget = parentDoc?.defaultView ?? parentDoc;
  const parentOwns = (event: KeyboardEvent) => {
    if (!live()) return false;
    const hovered = hoveredDocuments.get(ownerDoc);
    if (hovered) return hovered === doc;
    return popupEvent(event) && options.getActiveSelection?.()?.range.startContainer.ownerDocument === doc;
  };
  const localKey = (event:KeyboardEvent) => key(event);
  const localRelease = (event:KeyboardEvent) => release(event);
  const parentKey = (event:KeyboardEvent) => { if (parentOwns(event)) key(event,true); else cancel(); };
  const parentRelease = (event:KeyboardEvent) => { if (parentOwns(event)) release(event,true); else cancel(); };
  doc.addEventListener('mousemove',move,{passive:true});
  doc.addEventListener('pointermove',move,{passive:true});
  doc.addEventListener('mouseleave',leave);
  const involved = parentDoc ? [doc,parentDoc] : [doc];
  for (const document of involved) {
    document.addEventListener('compositionstart',beginComposition,true);
    document.addEventListener('compositionend',endComposition,true);
    document.addEventListener('pointerdown',cancel,true);
    document.addEventListener('wheel',leave,{passive:true});
    document.addEventListener('visibilitychange',blur);
  }
  parentDoc?.addEventListener('pointermove',parentMove,{passive:true});
  parentDoc?.addEventListener('mousemove',parentMove,{passive:true});
  keyboardTarget.addEventListener('keydown',localKey as EventListener,true);
  keyboardTarget.addEventListener('keyup',localRelease as EventListener,true);
  parentTarget?.addEventListener('keydown',parentKey as EventListener,true);
  parentTarget?.addEventListener('keyup',parentRelease as EventListener,true);
  doc.defaultView?.addEventListener('blur',blur);
  parentDoc?.defaultView?.addEventListener('blur',blur);
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearPoint(); cancel(); composing = false;
    clearReadingPosition(doc, ownerDoc);
    doc.removeEventListener('mousemove',move); doc.removeEventListener('pointermove',move); doc.removeEventListener('mouseleave',leave);
    for (const document of involved) {
      document.removeEventListener('compositionstart',beginComposition,true); document.removeEventListener('compositionend',endComposition,true);
      document.removeEventListener('pointerdown',cancel,true); document.removeEventListener('wheel',leave); document.removeEventListener('visibilitychange',blur);
    }
    parentDoc?.removeEventListener('pointermove',parentMove); parentDoc?.removeEventListener('mousemove',parentMove);
    keyboardTarget.removeEventListener('keydown',localKey as EventListener,true); keyboardTarget.removeEventListener('keyup',localRelease as EventListener,true);
    parentTarget?.removeEventListener('keydown',parentKey as EventListener,true); parentTarget?.removeEventListener('keyup',parentRelease as EventListener,true);
    doc.defaultView?.removeEventListener('blur',blur); parentDoc?.defaultView?.removeEventListener('blur',blur);
    if (registrations.get(doc) === dispose) registrations.delete(doc);
  };
  registrations.set(doc,dispose);
  return dispose;
}
