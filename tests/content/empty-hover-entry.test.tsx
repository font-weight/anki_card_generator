// @vitest-environment jsdom
import React, {act} from 'react';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ReaderChrome} from '../../apps/extension/src/readers/ReaderChrome';
import {applyBookStyle} from '../../apps/extension/src/readers/epub-format';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {clearReadingPosition} from '../../apps/extension/src/content/reading-marker';
import type {DocumentReady} from '../../apps/extension/src/readers/types';

const stubs = vi.hoisted(() => ({
  documentReady: undefined as DocumentReady | undefined,
  rpc: vi.fn(async () => ({grammarEnabled:true})),
  lookup: vi.fn(() => ({close:vi.fn()})),
  grammar: vi.fn(() => ({close:vi.fn()})),
}));
vi.mock('../../apps/extension/src/runtime/rpc-client', () => ({rpc:stubs.rpc}));
vi.mock('../../apps/extension/src/ui', () => ({
  mountReadingPopup:stubs.lookup, mountGrammarPopup:stubs.grammar,
  getActiveReadingSelection:() => null, getActivePopupKind:() => null, uiCss:'',
}));
vi.mock('../../apps/extension/src/readers', () => ({
  createLibraryStorage:async () => ({}),
  ReaderLibrary:({onDocumentReady}:{onDocumentReady:DocumentReady}) => {
    stubs.documentReady = onDocumentReady;
    const noop=()=>{};
    return <main><ReaderChrome className="er-epub-reader" theme="white" onThemeChange={noop} title="Coastal Review" onBack={noop}
      chapter={{label:'Глава 1',title:'The First Crossing',previous:noop,next:noop}} page={{label:'Страница 3 из 49',previous:noop,next:noop}}
      progress={5} onSeek={noop} bookmarked={false} onBookmark={noop} search={null} chapters={null} quotes={null}>
      <section className="er-epub-viewport"><iframe title="Synthetic book"/></section>
    </ReaderChrome></main>;
  },
}));

// jsdom cannot generate trusted keyboard events or lay out glyphs. Exercise the
// listeners registered by the real entries, stubbing just those browser inputs.
function registered(target:EventTarget) {
  const listeners = new Map<string, EventListenerOrEventListenerObject | null>();
  const add = target.addEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.set(type, listener);
    add(type, listener, options);
  });
  return (type:string, event:object) => {
    const listener = listeners.get(type);
    if (typeof listener !== 'function') throw Error('Missing listener for ' + type);
    listener.call(target, event as Event);
  };
}
function page(doc:Document) {
  const paragraph = doc.createElement('p');
  paragraph.textContent = 'They were sailing across the quiet harbour.';
  doc.body.append(paragraph);
  const rect = new DOMRect(10, 10, 28, 16);
  const prototype = doc.defaultView!.Range.prototype;
  Object.defineProperty(prototype, 'getBoundingClientRect', {configurable:true, value:() => rect});
  Object.defineProperty(prototype, 'getClientRects', {configurable:true, value:() => [rect]});
  // Chromium may snap a caret in the empty right margin back to nearby text.
  Object.defineProperty(doc, 'caretPositionFromPoint', {configurable:true, value:() => ({offsetNode:paragraph.firstChild,offset:1})});
  return paragraph;
}
const pointer = (x:number, target:Node) => ({isTrusted:true, clientX:x, clientY:13, composedPath:() => [target]});
const key = (name:'Shift'|'Alt', target:Node, repeat=false) => ({
  isTrusted:true, key:name, code:name+'Left', repeat, composedPath:() => [target],
});
const source = {kind:'epub', title:'Test', url:null, documentId:'fixture', page:null, chapter:null, cfi:null} as const;

describe('reader and web entry handling when the cursor misses text', () => {
  let host:HTMLElement, doc:Document, frame:HTMLIFrameElement, paragraph:HTMLElement;
  let parentPointer:ReturnType<typeof registered>, parentKey:ReturnType<typeof registered>;
  let bookPointer:ReturnType<typeof registered>, bookKey:ReturnType<typeof registered>, stop:void|(() => void);
  beforeAll(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div'); host.id = 'root'; document.body.append(host);
    await act(async () => { await import('../../apps/extension/src/library'); });
    frame = host.querySelector('iframe')!; doc = frame.contentDocument!; paragraph = page(doc);
    parentPointer = registered(document); parentKey = registered(window);
    bookPointer = registered(doc); bookKey = registered(doc.defaultView!);
    stop = stubs.documentReady!(doc, () => source);
  });
  beforeEach(() => {
    doc.getSelection()!.removeAllRanges();
    stubs.lookup.mockClear(); stubs.grammar.mockClear(); stubs.rpc.mockClear();
  });
  afterAll(() => { stop?.(); clearReadingPosition(document); vi.unstubAllGlobals(); host.remove(); });

  it('ignores fresh and held Shift and clean Alt in empty book space without a root status or layout change', async () => {
    const capture=(name:string)=>{
      const directory=process.env.LR_REVIEW_DOM;
      if(!directory)return;
      const clone=host.cloneNode(true) as HTMLElement,proof=doc.cloneNode(true) as Document;
      applyBookStyle(proof,{kind:'epub',fontSize:20,lineHeight:1.7,width:'comfortable',theme:'light',publisher:true});
      clone.querySelector('iframe')!.dataset.previewHtml=proof.documentElement.outerHTML;
      mkdirSync(directory,{recursive:true});
      writeFileSync(path.join(directory,name+'.html'),clone.outerHTML);
    };
    capture('reader-blank-before');
    bookPointer('pointermove', pointer(200, paragraph));
    await act(async () => {
      bookKey('keydown', key('Shift', paragraph)); bookKey('keydown', key('Shift', paragraph, true));
      bookKey('keydown', key('Shift', paragraph));
      bookKey('keydown', key('Alt', paragraph)); bookKey('keyup', key('Alt', paragraph));
    });
    expect(host.textContent).not.toContain('Наведите курсор на слово.');
    expect(host.querySelector(':scope > [role="status"]')).toBeNull();
    expect(host.firstElementChild?.tagName).toBe('MAIN');
    capture('reader-blank-after');
    expect(stubs.lookup).not.toHaveBeenCalled(); expect(stubs.grammar).not.toHaveBeenCalled();
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it('clears the last glyph when the parent reports a pointer on the iframe border and recovers on re-entry', async () => {
    bookPointer('pointermove', pointer(15, paragraph));
    parentPointer('pointermove', pointer(15, frame));
    await act(async () => {
      parentKey('keydown', key('Shift', frame));
      bookKey('keydown', key('Shift', paragraph)); // keyboard focus can still belong to the frame
      parentKey('keydown', key('Alt', frame)); parentKey('keyup', key('Alt', frame));
    });
    expect(stubs.lookup).not.toHaveBeenCalled(); expect(stubs.grammar).not.toHaveBeenCalled();
    expect(stubs.rpc).not.toHaveBeenCalled();
    bookPointer('pointermove', pointer(15, paragraph));
    await act(async () => {
      bookKey('keydown', key('Shift', paragraph));
      bookKey('keydown', key('Alt', paragraph)); bookKey('keyup', key('Alt', paragraph));
    });
    expect(stubs.lookup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({lookupPayload:expect.objectContaining({expression:'They'})}));
    expect(stubs.grammar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({autoGenerate:true, payload:expect.objectContaining({sentence:paragraph.textContent})}));
  });

  it('does not close the Alt window on frame pointerdown while a drawer is waiting for its click', async () => {
    const toggle=host.querySelector<HTMLButtonElement>('[aria-label="Вид"]')!;
    await act(async()=>toggle.click());
    expect(host.querySelector('.rc-panel')).toBeTruthy();
    bookPointer('pointermove',pointer(15,paragraph));
    await act(async()=>{bookKey('keydown',key('Alt',paragraph));bookKey('keyup',key('Alt',paragraph));});
    const popup=stubs.grammar.mock.results.at(-1)!.value;
    const press=()=>paragraph.dispatchEvent(new doc.defaultView!.PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true}));
    press();
    expect(popup.close).not.toHaveBeenCalled();
    await act(async()=>toggle.click());
    press();
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('retains actionable feedback for a deliberate invalid selection', async () => {
    const range = doc.createRange(); range.selectNodeContents(paragraph); doc.getSelection()!.addRange(range);
    await act(async () => { bookKey('keydown', key('Shift', paragraph)); });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Выберите выражение не длиннее пяти слов.');
    expect(stubs.lookup).not.toHaveBeenCalled();
  });

  it('also leaves an ordinary web page untouched on repeated empty Shift and activates over a word', async () => {
    const webText = page(document);
    const webPointer = registered(document), webKey = registered(window);
    await import('../../apps/extension/src/content');
    webPointer('pointermove', pointer(200, webText));
    webKey('keydown', key('Shift', webText)); webKey('keydown', key('Shift', webText));
    expect(document.documentElement.querySelectorAll(':scope > [role="status"]')).toHaveLength(0);
    expect(stubs.lookup).not.toHaveBeenCalled();
    webPointer('pointermove', pointer(15, webText)); webKey('keydown', key('Shift', webText));
    expect(stubs.lookup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({source:expect.objectContaining({kind:'html'})}));
  });
});
