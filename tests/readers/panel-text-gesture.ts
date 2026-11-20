import {act} from 'react';
import {expect, vi} from 'vitest';

/** Exercise the same physical gesture in the PDF text layer and an EPUB/FB2 iframe. */
export async function checkPageClickDismissal(text: HTMLElement, opener: HTMLButtonElement) {
  const doc = text.ownerDocument;
  const win = doc.defaultView!;
  const shell = opener.closest('.rc-shell')!;
  const selection = doc.getSelection()!;
  const createRange = doc.createRange.bind(doc);
  const rect = new DOMRect(0, 0, 80, 24);
  // Only the quote-selection UI needs layout in jsdom. A plain canvas click
  // must work even when the browser does not report a text caret.
  const ranges = vi.spyOn(doc, 'createRange').mockImplementation(() => Object.assign(createRange(), {
    getBoundingClientRect: () => rect,
    getClientRects: () => [rect],
  }));
  const pointer = (target: Element, type: string, x = 6, detail = 1, modified = false) => {
    const view = target.ownerDocument.defaultView!;
    target.dispatchEvent(new view.PointerEvent(type, {
      button: 0, detail, clientX: x, clientY: 6, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      bubbles: true, cancelable: true, altKey: modified,
    }));
  };
  const tap = (target: Element, detail = 1, x = 6, modified = false) => {
    for (const type of ['pointerdown', 'pointerup', 'click']) pointer(target, type, x, detail, modified);
  };
  const tick = async (milliseconds = 750) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  };
  const isOpen = () => {
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(shell.querySelector('.rc-panel')).toBeTruthy();
  };

  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  try {
    await act(async () => opener.click());
    isOpen();
    const panelHeading = shell.querySelector('.rc-panel h2')!;
    await act(async () => tap(panelHeading));
    await tick(); isOpen();

    const handle = shell.querySelector('[role=separator]')!;
    await act(async () => {
      pointer(handle, 'pointerdown');
      pointer(handle, 'pointermove', 30);
      pointer(handle, 'pointerup', 30);
      pointer(handle, 'click', 30);
    });
    await tick(); isOpen();

    await act(async () => {
      pointer(text, 'pointerdown');
      pointer(text, 'pointermove', 40);
      pointer(text, 'pointerup', 40);
      pointer(text, 'click', 40);
    });
    await tick(); isOpen();
    await act(async () => tap(text, 1, 6, true));
    await tick(); isOpen();

    await act(async () => {
      const range = doc.createRange();
      range.selectNodeContents(text);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(selection.toString()).toBe(text.textContent);
      doc.dispatchEvent(new win.Event('selectionchange'));
      tap(text);
    });
    await tick(); isOpen();
    expect(selection.toString()).toBe(text.textContent);
    await act(async () => {
      selection.removeAllRanges();
      doc.dispatchEvent(new win.Event('selectionchange'));
      pointer(text, 'pointerup');
    });
    await tick();

    await act(async () => tap(text));
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      tap(text, 2);
      pointer(text, 'dblclick', 6, 2);
    });
    expect(shell.querySelector('.rc-panel')).toBeNull();
    await act(async () => opener.click()); isOpen();

    const blank = doc === shell.ownerDocument ? shell.querySelector('.er-pdf-pages canvas')! : doc.documentElement;
    const gutter = shell.querySelector('.rc-book-view')!;
    for (const target of [text, blank, gutter]) {
      await act(async () => tap(target, 1, 160));

      expect(opener.getAttribute('aria-expanded')).toBe('false');
      expect(shell.querySelector('.rc-panel')).toBeNull();
      await act(async () => opener.click());
      await tick(800); isOpen();
    }

    const link = doc.createElement('a');
    const originalUrl = doc.URL;
    const destination = new URL(originalUrl);
    destination.hash = 'page-gesture-destination';
    link.href = destination.href;
    link.textContent = 'Continue reading';
    text.after(link);
    const activated = vi.fn((event: Event) => expect(event.defaultPrevented).toBe(false));
    link.addEventListener('click', activated);
    await act(async () => tap(link));
    await tick();
    expect(activated).toHaveBeenCalledOnce();
    expect(win.location.hash).toBe(destination.hash);
    if (doc === shell.ownerDocument) win.history.replaceState(win.history.state, '', originalUrl);
    expect(shell.querySelector('.rc-panel')).toBeNull();
    link.remove();
    for(const control of shell.querySelectorAll<HTMLButtonElement>('.rc-rail button[aria-expanded]')){
      await act(async()=>control.click());
      expect(control.getAttribute('aria-expanded')).toBe('true');
      await act(async()=>tap(gutter));
      expect(control.getAttribute('aria-expanded')).toBe('false');
      expect(shell.querySelector('.rc-panel')).toBeNull();
      expect(control.isConnected).toBe(true);
    }
    await act(async () => opener.click());
    isOpen();
  } finally {
    selection.removeAllRanges();
    ranges.mockRestore();
    vi.useRealTimers();
  }
}
