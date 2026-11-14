/** Local, document-lifetime reading position. Never wraps or rewrites source text. */
const HIGHLIGHT_NAME = 'english-reader-reading-position';
type HighlightRegistry = { set(name: string, value: unknown): unknown; delete(name: string): boolean };
type HighlightWindow = Window & {
  CSS?: { highlights?: HighlightRegistry };
  Highlight?: new (...ranges: Range[]) => unknown;
};
const activeMarkers = new WeakMap<Document, { document: Document; clear: () => void }>();

/** One marker per reading surface (shared across EPUB chapter frames). */
export function markReadingPosition(range: Range, ownerDocument: Document = range.startContainer.ownerDocument!): void {
  const doc = range.startContainer.ownerDocument;
  if (!doc || range.endContainer.ownerDocument !== doc || range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
  activeMarkers.get(ownerDocument)?.clear();
  const saved = range.cloneRange();
  const win = doc.defaultView as HighlightWindow | null;
  const registry = win?.CSS?.highlights;
  const native = !!(registry && win?.Highlight);
  const element = doc.createElement(native ? 'style' : 'div');
  element.setAttribute('data-english-reader-reading-marker', '');
  let cleared = false;
  const update = () => {
    if (!saved.startContainer.isConnected || !saved.endContainer.isConnected || saved.collapsed) { clear(); return; }
    if (native) return;
    element.replaceChildren();
    for (const rect of Array.from(saved.getClientRects?.() ?? [])) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const fragment = doc.createElement('span');
      Object.assign(fragment.style, { position: 'fixed', pointerEvents: 'none', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: 'rgba(255,193,7,.28)', borderBottom: '2px solid #d99a00', boxSizing: 'border-box' });
      element.append(fragment);
    }
  };
  const clear = () => {
    if (cleared) return;
    cleared = true;
    if (native) registry!.delete(HIGHLIGHT_NAME);
    element.remove();
    observer?.disconnect();
    doc.removeEventListener('scroll', update, true);
    win?.removeEventListener('resize', update);
    win?.removeEventListener('pagehide', clear);
    if (activeMarkers.get(ownerDocument)?.clear === clear) activeMarkers.delete(ownerDocument);
  };
  // Text edits/removal invalidate the old position instead of highlighting unrelated text.
  const observer = win && 'MutationObserver' in win ? new (win as Window & typeof globalThis).MutationObserver(records => {
    if (records.some(record => record.type === 'characterData' && saved.intersectsNode(record.target))) { clear(); return; }
    if (!saved.startContainer.isConnected || !saved.endContainer.isConnected || saved.collapsed) clear();
    else if (!native && records.some(record => record.target !== element && !element.contains(record.target))) update();
  }) : null;
  if (native) {
    element.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: #ffe08a; color: #172132; text-decoration: underline; text-decoration-color: #986800; }`;
    registry!.set(HIGHLIGHT_NAME, new win!.Highlight!(saved));
  } else {
    element.setAttribute('aria-hidden', 'true');
    element.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;';
    doc.addEventListener('scroll', update, true);
    win?.addEventListener('resize', update);
  }
  (native ? doc.head ?? doc.documentElement : doc.documentElement).append(element);
  activeMarkers.set(ownerDocument, { document: doc, clear });
  observer?.observe(doc.body ?? doc.documentElement, { subtree: true, childList: true, characterData: true });
  win?.addEventListener('pagehide', clear);
  update();
}

/** Do not clear a newer marker belonging to another retained EPUB chapter. */
export function clearReadingPosition(document: Document, ownerDocument: Document = document): void {
  const active = activeMarkers.get(ownerDocument);
  if (active?.document === document) active.clear();
}
