import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installReaderPaging } from '../../apps/extension/src/readers/keyboard-paging';

let root: HTMLDivElement, calls: ReturnType<typeof vi.fn<(event: KeyboardEvent) => boolean>>;
const cleanups: (() => void)[] = [];
function install(element = root, onKey = calls) {
  const paging = installReaderPaging({ root: element, onKey }); cleanups.push(paging.dispose); return paging;
}
function key(target: EventTarget = document.body, value = 'PageDown', options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true, cancelable: true, ...options });
  target.dispatchEvent(event); return event;
}
function frame() {
  const frame = document.createElement('iframe'); root.append(frame);
  const doc = frame.contentDocument!; doc.body.innerHTML = '<p>Exact book text.</p>';
  return { frame, doc };
}
beforeEach(() => {
  root = document.createElement('div'); root.tabIndex = 0; document.body.append(root);
  calls = vi.fn(() => true);
});
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup()); document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
});

describe('active-reader document keyboard ownership', () => {
  it('handles each parent or iframe key once without stealing focus or changing text', () => {
    const paging = install(), { doc } = frame(); paging.addDocument(doc);
    const original = doc.body.innerHTML;
    for (const target of [document.body, root, doc.body]) {
      for (const value of ['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp']) expect(key(target, value).defaultPrevented).toBe(true);
    }
    expect(calls).toHaveBeenCalledTimes(12); expect(document.activeElement).toBe(document.body);
    expect(doc.body.innerHTML).toBe(original);
    for (const value of ['Shift', 'Alt', 'Enter', ' ', 'Home', 'End', 'a']) expect(key(document.body, value).defaultPrevented).toBe(false);
    expect(calls).toHaveBeenCalledTimes(12);
  });

  it('preserves modifiers, repeats, IME events and an already handled key', () => {
    install();
    for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(key(document.body, 'ArrowRight', options).defaultPrevented).toBe(false);
    }
    const event = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
    event.preventDefault(); document.body.dispatchEvent(event);
    expect(calls).not.toHaveBeenCalled();
    calls.mockReturnValueOnce(false); expect(key().defaultPrevented).toBe(false);
  });

  it('tracks composition in both documents even when key events lack the IME flag, and clears it on blur', () => {
    const paging = install(), { doc } = frame(); paging.addDocument(doc);
    for (const source of [document, doc]) {
      source.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      expect(key().defaultPrevented).toBe(false); expect(key(doc.body).defaultPrevented).toBe(false);
      source.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      expect(key().defaultPrevented).toBe(true);
      source.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      source.defaultView!.dispatchEvent(new Event('blur'));
      expect(key(doc.body).defaultPrevented).toBe(true);
    }
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it('leaves editable fields, native controls and accessible widgets alone in either realm', () => {
    const paging = install(), { doc } = frame(); paging.addDocument(doc);
    const markup = [
      '<input>', '<input type="search">', '<input type="range">', '<input type="file">', '<textarea></textarea>', '<select><option>A</option></select>',
      '<button>Button</button>', '<a href="#book">Link</a>', '<details><summary>Options</summary></details>', '<div contenteditable>Text</div>',
      ...['textbox', 'searchbox', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'checkbox', 'radio', 'radiogroup', 'switch', 'button', 'link',
        'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'tablist', 'tree', 'treeitem', 'grid', 'scrollbar', 'application']
        .map(role => `<div role="${role}" tabindex="0"><span>Widget</span></div>`),
      '<div aria-activedescendant="choice" tabindex="0"><span>Choice</span></div>',
    ];
    for (const source of [document, doc]) {
      for (const html of markup) {
        const container = source.createElement('div'); container.innerHTML = html; source.body.append(container);
        const target = container.querySelector('span,summary') || container.firstElementChild!;
        expect(key(target).defaultPrevented, html).toBe(false); container.remove();
      }
    }
    expect(calls).not.toHaveBeenCalled();
    const input = document.createElement('input'); document.body.append(input); input.focus();
    expect(key(document.body).defaultPrevented).toBe(false); expect(document.activeElement).toBe(input);
  });

  it('respects Shadow DOM control targets and focused controls behind event retargeting', () => {
    install(); const shadowHost = document.createElement('div'); root.append(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' }), input = document.createElement('input'); shadow.append(input); input.focus();
    expect(key(input).defaultPrevented).toBe(false); expect(key(shadowHost).defaultPrevented).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it('limits the retained library-opener exception to initial focus and four page keys', () => {
    const opener = document.createElement('button'); opener.dataset.readerPageOpener = ''; document.body.prepend(opener); opener.focus();
    install(); expect(key(opener).defaultPrevented).toBe(true); expect(key(opener, 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(opener);
    root.focus(); opener.focus(); expect(key(opener).defaultPrevented).toBe(false);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it.each(['Enter', ' ', 'Tab', 'Escape'])('preserves %j on the opener and ends its initial-focus exception', value => {
    const opener = document.createElement('button'); opener.dataset.readerPageOpener = ''; document.body.prepend(opener); opener.focus();
    install(); expect(key(opener, value).defaultPrevented).toBe(false); expect(key(opener).defaultPrevented).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it('does not grant opener privileges to a later-focused button or after a pointer interaction', () => {
    const opener = document.createElement('button'); opener.dataset.readerPageOpener = ''; document.body.prepend(opener);
    const paging = install(); opener.focus(); expect(key(opener).defaultPrevented).toBe(false); paging.dispose();
    install(); expect(key(opener).defaultPrevented).toBe(true);
    opener.dispatchEvent(new Event('pointerdown', { bubbles: true })); expect(key(opener).defaultPrevented).toBe(false);
  });

  it('blocks selection or an open popup/dialog in either document, but not dismissed dialogs', () => {
    const paging = install(), { doc } = frame(); paging.addDocument(doc);
    for (const source of [document, doc]) {
      const text = source.createElement('p'); text.textContent = 'Selected text'; source.body.append(text);
      const range = source.createRange(); range.selectNodeContents(text); source.getSelection()!.addRange(range);
      expect(key().defaultPrevented).toBe(false); expect(key(doc.body).defaultPrevented).toBe(false);
      source.getSelection()!.removeAllRanges(); text.remove();
      for (const html of ['<div data-english-reader-popup></div>', '<div role="dialog" aria-modal="false"></div>', '<div role="alertdialog"></div>', '<dialog open></dialog>']) {
        const container = source.createElement('div'); container.innerHTML = html; source.body.append(container);
        expect(key().defaultPrevented).toBe(false); expect(key(doc.body).defaultPrevented).toBe(false); container.remove();
      }
    }
    expect(calls).not.toHaveBeenCalled();
    const hidden = document.createElement('div'); hidden.hidden = true; hidden.innerHTML = '<div role="dialog"></div>'; document.body.append(hidden);
    expect(key().defaultPrevented).toBe(true);
  });

  it('rejects detached/replaced iframe events and prunes stale selections and composition before paging the current book', () => {
    const paging = install(), first = frame(); paging.addDocument(first.doc);
    const range = first.doc.createRange(); range.selectNodeContents(first.doc.body); first.doc.getSelection()!.addRange(range);
    first.doc.dispatchEvent(new CompositionEvent('compositionstart')); first.frame.remove();
    expect(key(first.doc.body).defaultPrevented).toBe(false); expect(key().defaultPrevented).toBe(true);
    const second = frame(); paging.addDocument(second.doc);
    Object.defineProperty(second.frame, 'contentDocument', { value: document.implementation.createHTMLDocument('new document') });
    expect(key(second.doc.body).defaultPrevented).toBe(false); expect(key().defaultPrevented).toBe(true);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('does not use the book shortcuts for another focused iframe or a detached reader', () => {
    install(); const other = document.createElement('iframe'); document.body.append(other); other.focus();
    expect(key().defaultPrevented).toBe(false); other.remove(); root.remove();
    expect(key().defaultPrevented).toBe(false); expect(calls).not.toHaveBeenCalled();
  });

  it('replaces duplicate frame registrations and active readers without double navigation or removing a newer handler', () => {
    const paging = install(), { doc } = frame(), oldFrameCleanup = paging.addDocument(doc);
    paging.addDocument(doc); oldFrameCleanup(); expect(key(doc.body).defaultPrevented).toBe(true); expect(calls).toHaveBeenCalledOnce();
    const newer = document.createElement('div'); document.body.append(newer); const next = vi.fn(() => true);
    const latest = install(newer, next); paging.dispose();
    expect(key(doc.body).defaultPrevented).toBe(false); expect(key().defaultPrevented).toBe(true);
    expect(calls).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce();
    latest.dispose(); expect(key().defaultPrevented).toBe(false); expect(next).toHaveBeenCalledOnce();
  });
});
