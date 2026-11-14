/** Keyboard paging belongs to the open book, not to whichever surface was last
 * clicked. One owner listens to the library document and its live book frames;
 * iframe key events do not bubble into the parent document. No focus is moved. */
const owners = new WeakMap<Document, () => void>();
export const readerPagingControls = 'input,textarea,select,button,a,area,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="option"],[role="slider"],[role="spinbutton"],[role="checkbox"],[role="radio"],[role="radiogroup"],[role="switch"],[role="button"],[role="link"],[role="menu"],[role="menubar"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="tablist"],[role="tree"],[role="treeitem"],[role="grid"],[role="scrollbar"],[role="application"],[role="dialog"],[role="alertdialog"],[aria-activedescendant],[data-english-reader-popup]';
const pageKeys = ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'];
const asElement = (node: EventTarget | null): Element | null => (node as Node | null)?.nodeType === 1 ? node as Element : null;

export function installReaderPaging({ root, onKey, keys = pageKeys }: {
  root: HTMLElement;
  /** Return true only when the reader owns the key's default action. */
  onKey: (event: KeyboardEvent) => boolean;
  keys?: readonly string[];
}): { addDocument: (doc: Document) => () => void; dispose: () => void } {
  const owner = root.ownerDocument;
  owners.get(owner)?.();
  let disposed = false;
  // The persistent library import button can retain focus after the file dialog.
  // Only this explicit opener, focused at mount, gets page keys. Enter/Space and
  // all later control interactions keep their normal meaning.
  let opener = owner.activeElement?.matches('button[data-reader-page-opener]') ? owner.activeElement : null;
  const composing = new Set<Document>();
  const documents = new Map<Document, { live: () => boolean; dispose: () => void }>();
  const blockedControl = (element: Element | null, event: KeyboardEvent) => {
    if (!element) return false;
    if (opener && element === opener && pageKeys.includes(event.key)) return false;
    return !!element.closest(readerPagingControls);
  };
  const blocked = (event: KeyboardEvent, doc: Document) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || composing.size ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.getModifierState('AltGraph')) return true;
    if (event.composedPath().some(node => blockedControl(asElement(node), event))) return true;
    // Check active controls too: retargeted Shadow DOM events and body/window
    // dispatch must not make typing or an accessible widget turn a book page.
    let active = doc.activeElement;
    while (active) {
      if (blockedControl(active, event)) return true;
      if (active.localName === 'iframe' && ![...documents.keys()].some(value => value.defaultView?.frameElement === active)) return true;
      active = active.shadowRoot?.activeElement ?? null;
    }
    for (const candidate of documents.keys()) {
      if (candidate.getSelection()?.isCollapsed === false) return true;
      if ([...candidate.querySelectorAll('[data-english-reader-popup],[role="dialog"],[role="alertdialog"],dialog[open]')]
        .some(element => !element.closest('[hidden],[aria-hidden="true"],[inert]'))) return true;
    }
    return false;
  };
  const addDocument = (doc: Document): (() => void) => {
    if (disposed) return () => {};
    documents.get(doc)?.dispose();
    const frame = doc === owner ? null : doc.defaultView?.frameElement as HTMLIFrameElement | null;
    const live = () => !disposed && root.isConnected && (doc === owner || !!frame && frame.isConnected && root.contains(frame) && frame.contentDocument === doc);
    const begin = () => { composing.add(doc); };
    const end = () => { composing.delete(doc); };
    const releaseOpener = () => { opener = null; };
    const focus = (event: FocusEvent) => { if (event.target !== opener) releaseOpener(); };
    const keydown = (event: KeyboardEvent) => {
      if (['Enter', ' ', 'Tab', 'Escape'].includes(event.key)) releaseOpener();
      if (!keys.includes(event.key)) return;
      for (const entry of [...documents.values()]) if (!entry.live()) entry.dispose();
      if (!live() || root.closest('[hidden],[inert],[aria-hidden="true"]') || blocked(event, doc)) return;
      if (onKey(event)) event.preventDefault();
    };
    const dispose = () => {
      doc.removeEventListener('keydown', keydown);
      doc.removeEventListener('compositionstart', begin, true); doc.removeEventListener('compositionend', end, true);
      doc.removeEventListener('focusin', focus, true); doc.removeEventListener('pointerdown', releaseOpener, true);
      doc.removeEventListener('visibilitychange', end); doc.defaultView?.removeEventListener('blur', end);
      composing.delete(doc);
      if (documents.get(doc)?.dispose === dispose) documents.delete(doc);
    };
    documents.set(doc, { live, dispose });
    doc.addEventListener('keydown', keydown);
    doc.addEventListener('compositionstart', begin, true); doc.addEventListener('compositionend', end, true);
    doc.addEventListener('focusin', focus, true); doc.addEventListener('pointerdown', releaseOpener, true);
    doc.addEventListener('visibilitychange', end); doc.defaultView?.addEventListener('blur', end);
    return dispose;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; opener = null;
    for (const entry of [...documents.values()]) entry.dispose();
    if (owners.get(owner) === dispose) owners.delete(owner);
  };
  owners.set(owner, dispose); addDocument(owner);
  return { addDocument, dispose };
}
