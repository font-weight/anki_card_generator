import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReadingPopup } from './ReadingPopup';
import { GrammarPopup, type GrammarPopupOptions } from './GrammarPopup';
import { uiCss } from './styles';
import { isTrustedUiEvent } from './user-actions';
import type { PopupHandle, PopupOptions } from './interfaces';
import { isBookPanelSurfacePress } from '../readers/book-text-tap';
import type { ExtractedText } from '../content/extraction';

// One popup per host document, including book lookups originating in multiple frames.
let activePopup: { close: () => void; selection: () => ExtractedText | null; kind:'lookup'|'grammar' } | undefined;
export function getActiveReadingSelection(): ExtractedText | null { return activePopup?.selection() ?? null; }
export function getActivePopupKind(): 'lookup'|'grammar'|null { return activePopup?.kind ?? null; }

interface PositionedPopup {trustedPage?:boolean;anchor:DOMRect|(()=>DOMRect|null);selectionRange?:Range;onClose?:()=>void}
export type GrammarMountOptions = GrammarPopupOptions & PositionedPopup & {selection:ExtractedText};
export function mountGrammarPopup(options:GrammarMountOptions): Pick<PopupHandle,'close'> {
  return mountPopup(options,'grammar',value=>value.selection,(value,close,registerChatBack)=><GrammarPopup options={value} close={close} registerChatBack={registerChatBack}/>);
}

/** Nonmodal isolated host; detached anchors close rather than floating over unrelated text. */
export function mountReadingPopup(initial: PopupOptions): PopupHandle {
  return mountPopup(initial,'lookup',options=>options.selectionRange ? {range:options.selectionRange,expression:options.lookupPayload.expression,context:options.lookupPayload.context,origin:options.selectionOrigin} : null,(options,close)=><ReadingPopup options={options} close={close}/>);
}
function mountPopup<T extends PositionedPopup>(initial:T,kind:'lookup'|'grammar',selection:(value:T)=>ExtractedText|null,renderPanel:(value:T,close:()=>void,registerChatBack:(back:(()=>void)|null)=>void)=>React.ReactNode): {close:()=>void;update:(value:T)=>void} {
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
  let backToGrammar: (() => void) | null = null;
  const registerChatBack = (back: (() => void) | null) => {
    backToGrammar = back;
    if (!disposed) schedule();
  };
  let disposed = false;
  let frame = 0;
  let focusFrame = 0;
  let bookShell: HTMLElement | null = null;
  let sourceDocument:Document|null|undefined;
  let sourceFrame:HTMLIFrameElement|null|undefined;
  function close() {
    if (disposed) return; disposed = true;
    const hadFocus = document.activeElement === host;
    cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); window.removeEventListener('pagehide', close);
    if (sourceDocument && sourceDocument !== document) sourceDocument.removeEventListener('keydown', escape, true);
    document.removeEventListener('visibilitychange', repositionWhenVisible);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
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
    // Hidden tabs can temporarily report no geometry for a live source.
    if (document.visibilityState === 'hidden') return;
    const anchor = typeof options.anchor === 'function' ? options.anchor() : options.anchor;
    if (!anchor || anchor.bottom < 0 || anchor.top > innerHeight || anchor.right < 0 || anchor.left > innerWidth) { close(); return; }
    // A software keyboard or pinch zoom can leave only part of the layout viewport visible.
    const viewport = backToGrammar ? window.visualViewport : null;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    if (backToGrammar) {
      host.style.setProperty('--grammar-chat-viewport-width', width + 'px');
      host.style.setProperty('--grammar-chat-viewport-height', height + 'px');
    } else {
      host.style.removeProperty('--grammar-chat-viewport-width');
      host.style.removeProperty('--grammar-chat-viewport-height');
    }
    const rect = host.getBoundingClientRect();
    const below = anchor.bottom + 10;
    const bottom = topEdge + height - 12;
    const preferredTop = below + rect.height <= bottom ? below : anchor.top - rect.height - 10;
    host.style.top = Math.max(topEdge + 12, Math.min(preferredTop, bottom - rect.height)) + 'px';
    host.style.left = Math.max(leftEdge + 12, Math.min(anchor.left, leftEdge + width - rect.width - 12)) + 'px';
  }
  function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }
  function repositionWhenVisible() {
    if (document.visibilityState === 'visible') schedule();
  }
  function outside(event: PointerEvent) {
    if (event.composedPath().includes(host)) return;
    if (options.trustedPage && isBookPanelSurfacePress(event)) return;
    close();
  }
  function escape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !isTrustedUiEvent(event) || event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); event.stopPropagation();
    if (backToGrammar) backToGrammar();
    else close();
  }
  const resize = new ResizeObserver(schedule); resize.observe(content);
  // Removed text/frame anchors must not leave a popup over unrelated content.
  const bookColors: Record<string, string> = {
    '--surface': '--rc-panel', '--ink': '--rc-ink', '--muted': '--rc-secondary', '--line': '--rc-line',
    '--accent': '--rc-accent', '--soft': '--rc-tint', '--tint': '--rc-highlight', '--focus': '--rc-focus',
    '--lavender': '--rc-lavender',
  };
  function syncBookTheme() {
    const theme = bookShell?.dataset.readerTheme;
    const themed = bookShell && (theme === 'white' || theme === 'cream' || theme === 'graphite');
    if (themed) host.dataset.bookTheme = theme;
    else delete host.dataset.bookTheme;
    const colors = bookShell && themed ? getComputedStyle(bookShell) : null;
    for (const [popupToken, readerToken] of Object.entries(bookColors)) {
      const value = colors?.getPropertyValue(readerToken).trim();
      if (value) host.style.setProperty(popupToken, value);
      else host.style.removeProperty(popupToken);
    }
  }
  const mutations = new MutationObserver(records => {
    if (bookShell && records.some(record => record.type === 'attributes' && record.target === bookShell)) syncBookTheme();
    if (records.some(record => record.target !== host && !host.contains(record.target))) schedule();
  });
  function observeAnchors() {
    mutations.disconnect();
    mutations.observe(document.documentElement, { childList: true, subtree: true });
    if (sourceDocument && sourceDocument !== document) sourceDocument.removeEventListener('keydown', escape, true);
    sourceDocument = options.selectionRange?.startContainer.ownerDocument;
    sourceFrame = sourceDocument?.defaultView?.frameElement as HTMLIFrameElement|null|undefined;
    // A PDF source is in the host document; EPUB text lives inside its chapter frame.
    const node = options.selectionRange?.startContainer;
    const anchorElement = sourceFrame ?? (node?.nodeType === 1 ? node as Element : node?.parentElement);
    bookShell = options.trustedPage === true ? anchorElement?.closest<HTMLElement>('.rc-shell[data-reader-theme]') ?? null : null;
    if (bookShell) mutations.observe(bookShell, { attributes: true, attributeFilter: ['data-reader-theme'] });
    syncBookTheme();
    if (sourceDocument && sourceDocument !== document) {
      mutations.observe(sourceDocument.documentElement, { childList: true, subtree: true });
      sourceDocument.addEventListener('keydown', escape, true);
    }
  }
  observeAnchors();
  const currentPopup = { close, kind, selection: (): ExtractedText | null => selection(options) };
  activePopup = currentPopup;
  document.addEventListener('visibilitychange', repositionWhenVisible);
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); window.addEventListener('pagehide', close);
  if (kind === 'grammar') {
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
  }
  function render() { root.render(renderPanel(options,close,registerChatBack)); schedule(); }
  render();
  // Focus the panel only, without a focus trap; Tab still reaches the host page.
  focusFrame = requestAnimationFrame(() => { if (disposed) return; position(); if (disposed || document.visibilityState === 'hidden') return; shadow.querySelector<HTMLElement>('[role=dialog]')?.focus({ preventScroll: true }); });
  return { close, update(next) { if (disposed) return; options = next; observeAnchors(); render(); } };
}
