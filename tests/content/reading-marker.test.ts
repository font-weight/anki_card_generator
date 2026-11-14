// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearReadingPosition, markReadingPosition } from '../../apps/extension/src/content/reading-marker';
import { installActivation } from '../../apps/extension/src/content/activation';
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(fn => fn());
  clearReadingPosition(document);
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function textRange(doc = document) {
  const p = doc.createElement('p'); p.textContent = 'Read another word.'; doc.body.append(p);
  const range = doc.createRange(); range.setStart(p.firstChild!, 0); range.setEnd(p.firstChild!, 4);
  return {p, range};
}
function nativeHighlights(doc = document) {
  const win = doc.defaultView!;
  const css = Object.getOwnPropertyDescriptor(win, 'CSS');
  const highlight = Object.getOwnPropertyDescriptor(win, 'Highlight');
  const registry = new Map<string, any>();
  Object.defineProperty(win, 'CSS', { configurable: true, value: {highlights: registry} });
  Object.defineProperty(win, 'Highlight', { configurable: true, value: class {constructor(public range: Range) {}} });
  cleanups.push(() => {
    clearReadingPosition(doc);
    if (css) Object.defineProperty(win, 'CSS', css); else delete (win as any).CSS;
    if (highlight) Object.defineProperty(win, 'Highlight', highlight); else delete (win as any).Highlight;
  });
  return registry;
}
it('marks a cloned source range without changing text, elements or user selection; replaces previous position', () => {
  const registry = nativeHighlights(); const {p,range} = textRange();
  document.getSelection()!.addRange(range);
  markReadingPosition(range);
  expect(registry.size).toBe(1);
  expect([...registry.values()][0].range).not.toBe(range);
  expect([...registry.values()][0].range.toString()).toBe('Read');
  expect(p.innerHTML).toBe('Read another word.');
  expect(document.getSelection()!.toString()).toBe('Read');
  // Dismissing native selection (as on popup close) is independent of marker.
  document.getSelection()!.removeAllRanges();
  expect(registry.size).toBe(1);
  range.setStart(p.firstChild!, 5); range.setEnd(p.firstChild!, 12);
  markReadingPosition(range);
  expect(registry.size).toBe(1);
  expect([...registry.values()][0].range.toString()).toBe('another');
  expect(document.querySelectorAll('[data-english-reader-reading-marker]')).toHaveLength(1);
});
it('invalid or disconnected ranges do not replace a valid marker; teardown clears it', () => {
  const registry = nativeHighlights(); const {range} = textRange(); markReadingPosition(range);
  const detached = document.createRange(); const text = document.createTextNode('missing');
  detached.selectNodeContents(text); markReadingPosition(detached);
  expect(registry.size).toBe(1);
  clearReadingPosition(document); expect(registry.size).toBe(0);
  expect(document.querySelector('[data-english-reader-reading-marker]')).toBeNull();
});
it('clears a marker when its text is edited or removed', async () => {
  const registry = nativeHighlights(); const {p,range} = textRange(); markReadingPosition(range);
  p.firstChild!.textContent = 'Changed';
  await Promise.resolve(); expect(registry.size).toBe(0);
  const next = textRange(); markReadingPosition(next.range); next.p.remove();
  await Promise.resolve(); expect(registry.size).toBe(0);
});
it('shares one position across EPUB frames and old frame teardown cannot erase new position', () => {
  const frames = [document.createElement('iframe'), document.createElement('iframe')];
  frames.forEach(frame => document.body.append(frame));
  const [a,b] = frames.map(frame => frame.contentDocument!);
  const first = nativeHighlights(a), second = nativeHighlights(b);
  markReadingPosition(textRange(a).range, document);
  expect(first.size).toBe(1);
  markReadingPosition(textRange(b).range, document);
  expect(first.size).toBe(0); expect(second.size).toBe(1);
  clearReadingPosition(a, document); expect(second.size).toBe(1);
  clearReadingPosition(b, document); expect(second.size).toBe(0);
});
it('has a non-interactive range overlay fallback, which follows scroll and clears on pagehide', () => {
  const {p,range} = textRange(); let left = 10;
  const prototype = Object.getPrototypeOf(range);
  Object.defineProperty(prototype, 'getClientRects', {configurable:true, value:() => [{left,top:20,width:30,height:18}]});
  cleanups.push(() => { delete prototype.getClientRects; });
  markReadingPosition(range);
  const layer = document.querySelector<HTMLElement>('[data-english-reader-reading-marker]')!;
  expect(layer.style.pointerEvents).toBe('none');
  expect(layer.getAttribute('aria-hidden')).toBe('true');
  expect((layer.firstChild as HTMLElement).style.left).toBe('10px');
  left = 25; document.dispatchEvent(new Event('scroll'));
  expect((layer.firstChild as HTMLElement).style.left).toBe('25px');
  expect(p.innerHTML).toBe('Read another word.');
  window.dispatchEvent(new Event('pagehide')); expect(layer.isConnected).toBe(false);
});
it('only trusted Shift marks text, including selection phrases, without a second lookup on same active selection', () => {
  const registry = nativeHighlights(); const {p,range} = textRange(); range.setEnd(p.firstChild!, 12);
  document.getSelection()!.addRange(range);
  const prototype = Object.getPrototypeOf(range);
  Object.defineProperty(prototype, 'getBoundingClientRect', {configurable:true, value:() => ({left:0,top:0,width:30,height:18})});
  cleanups.push(() => { delete prototype.getBoundingClientRect; });
  const spy = vi.spyOn(window, 'addEventListener'); let active: any = null;
  const onActivate = vi.fn(value => {active = value;});
  const dispose = installActivation({document, onActivate, getActiveSelection:()=>active}); cleanups.push(dispose);
  const key = spy.mock.calls.find(([name]) => name === 'keydown')![1] as (event: KeyboardEvent) => void;
  const event = {key:'Shift', isTrusted:true,repeat:false,isComposing:false,ctrlKey:false,altKey:false,metaKey:false,composedPath:()=>[p]};
  key({...event,isTrusted:false} as any); expect(registry.size).toBe(0);
  key({...event,key:'Alt'} as any); expect(registry.size).toBe(0);
  key(event as any); expect(registry.size).toBe(1); expect(onActivate).toHaveBeenCalledTimes(1);
  expect([...registry.values()][0].range.toString()).toBe('Read another');
  key(event as any); expect(onActivate).toHaveBeenCalledTimes(1);
  dispose(); expect(registry.size).toBe(0);
});
