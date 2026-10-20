import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReadingPopup } from './ReadingPopup';
import { uiCss } from './styles';
import type { PopupHandle, PopupOptions } from './interfaces';

/** Nonmodal isolated host; detached anchors close rather than floating over unrelated text. */
export function mountReadingPopup(initial: PopupOptions): PopupHandle {
  let options = initial;
  const previousFocus = document.activeElement as HTMLElement | null;
  const host = document.createElement('div');
  host.dataset.englishReaderPopup = '';
  host.dataset.englishReader = 'popup';
  Object.assign(host.style, { position: 'fixed', zIndex: '2147483647', left: '12px', top: '12px' });
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = uiCss; shadow.append(style);
  const content = document.createElement('div'); shadow.append(content);
  document.documentElement.append(host);
  const root = createRoot(content);
  let disposed = false;
  let frame = 0;
  let focusFrame = 0;
  function close() {
    if (disposed) return; disposed = true;
    const hadFocus = document.activeElement === host;
    cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
    resize.disconnect(); root.unmount(); host.remove();
    if (hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    options.onClose?.();
  }
  function position() {
    if (disposed) return;
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
  function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); close(); } }
  const resize = new ResizeObserver(schedule); resize.observe(content);
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
  window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  function render() { root.render(<ReadingPopup options={options} close={close} />); schedule(); }
  render();
  // Focus the panel only, without a focus trap; Tab still reaches the host page.
  focusFrame = requestAnimationFrame(() => { if (disposed) return; position(); shadow.querySelector<HTMLElement>('[role=dialog]')?.focus({ preventScroll: true }); });
  return { close, update(next) { if (disposed) return; options = next; render(); } };
}
