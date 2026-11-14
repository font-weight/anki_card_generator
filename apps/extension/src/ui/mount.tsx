import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReadingPopup } from './ReadingPopup';
import { GrammarPopup, type GrammarPopupOptions } from './GrammarPopup';
import { uiCss } from './styles';
import { isTrustedUiEvent } from './user-actions';
import type { PopupHandle, PopupOptions } from './interfaces';
import type { ExtractedText } from '../content/extraction';

// One popup per host document, including book lookups originating in multiple frames.
let activePopup: { close: () => void; selection: () => ExtractedText | null; kind:'lookup'|'grammar' } | undefined;
export function getActiveReadingSelection(): ExtractedText | null { return activePopup?.selection() ?? null; }
export function getActivePopupKind(): 'lookup'|'grammar'|null { return activePopup?.kind ?? null; }

interface PositionedPopup {anchor:DOMRect|(()=>DOMRect|null);selectionRange?:Range;onClose?:()=>void}
export type GrammarMountOptions = GrammarPopupOptions & PositionedPopup & {selection:ExtractedText};
export function mountGrammarPopup(options:GrammarMountOptions): Pick<PopupHandle,'close'> {
  return mountPopup(options,'grammar',value=>value.selection,(value,close)=><GrammarPopup options={value} close={close}/>);
}

/** Nonmodal isolated host; detached anchors close rather than floating over unrelated text. */
export function mountReadingPopup(initial: PopupOptions): PopupHandle {
  return mountPopup(initial,'lookup',options=>options.selectionRange ? {range:options.selectionRange,expression:options.lookupPayload.expression,context:options.lookupPayload.context,origin:options.selectionOrigin} : null,(options,close)=><ReadingPopup options={options} close={close}/>);
}
function mountPopup<T extends PositionedPopup>(initial:T,kind:'lookup'|'grammar',selection:(value:T)=>ExtractedText|null,renderPanel:(value:T,close:()=>void)=>React.ReactNode): {close:()=>void;update:(value:T)=>void} {
  activePopup?.close();
  let options = initial;
  const previousFocus = document.activeElement as HTMLElement | null;
  const host = document.createElement('div');
  host.dataset.englishReaderPopup = '';
  host.dataset.englishReader = 'popup';
  host.dataset.popupKind = kind;
  Object.assign(host.style, { position: 'fixed', zIndex: '2147483647', left: '12px', top: '12px' });
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = uiCss; shadow.append(style);
  const content = document.createElement('div'); shadow.append(content);
  document.documentElement.append(host);
  const root = createRoot(content);
  let disposed = false;
  let frame = 0;
  let focusFrame = 0;
  let sourceDocument:Document|null|undefined;
  let sourceFrame:HTMLIFrameElement|null|undefined;
  function close() {
    if (disposed) return; disposed = true;
    const hadFocus = document.activeElement === host;
    cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); window.removeEventListener('pagehide', close);
    resize.disconnect(); mutations.disconnect(); root.unmount(); host.remove();
    if (activePopup === currentPopup) activePopup = undefined;
    if (hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    options.onClose?.();
  }
  function position() {
    if (disposed) return;
    if (!host.isConnected) { close(); return; }
    if (sourceDocument && sourceDocument !== document && (!sourceFrame?.isConnected || sourceFrame.contentDocument !== sourceDocument)) { close(); return; }
    const range = options.selectionRange;
    if (range && (range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected)) { close(); return; }
    const anchor = typeof options.anchor === 'function' ? options.anchor() : options.anchor;
    if (!anchor || anchor.bottom < 0 || anchor.top > innerHeight || anchor.right < 0 || anchor.left > innerWidth) { close(); return; }
    const rect = host.getBoundingClientRect();
    const below = anchor.bottom + 10;
    const top = below + rect.height <= innerHeight - 12 ? below : Math.max(12, anchor.top - rect.height - 10);
    host.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12))}px`;
    host.style.top = `${Math.min(top, Math.max(12, innerHeight - rect.height - 12))}px`;
  }
  function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }
  function outside(event: PointerEvent) { if (!event.composedPath().includes(host)) close(); }
  function escape(event: KeyboardEvent) { if (event.key === 'Escape' && isTrustedUiEvent(event) && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); close(); } }
  const resize = new ResizeObserver(schedule); resize.observe(content);
  // Removed text/frame anchors must not leave a popup over unrelated content.
  const mutations = new MutationObserver(records => {
    if (records.some(record => record.target !== host && !host.contains(record.target))) schedule();
  });
  function observeAnchors() {
    mutations.disconnect();
    mutations.observe(document.documentElement, { childList: true, subtree: true });
    sourceDocument = options.selectionRange?.startContainer.ownerDocument;
    sourceFrame = sourceDocument?.defaultView?.frameElement as HTMLIFrameElement|null|undefined;
    if (sourceDocument && sourceDocument !== document) mutations.observe(sourceDocument.documentElement, { childList: true, subtree: true });
  }
  observeAnchors();
  const currentPopup = { close, kind, selection: (): ExtractedText | null => selection(options) };
  activePopup = currentPopup;
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); window.addEventListener('pagehide', close);
  function render() { root.render(renderPanel(options,close)); schedule(); }
  render();
  // Focus the panel only, without a focus trap; Tab still reaches the host page.
  focusFrame = requestAnimationFrame(() => { if (disposed) return; position(); if (disposed) return; shadow.querySelector<HTMLElement>('[role=dialog]')?.focus({ preventScroll: true }); });
  return { close, update(next) { if (disposed) return; options = next; observeAnchors(); render(); } };
}
