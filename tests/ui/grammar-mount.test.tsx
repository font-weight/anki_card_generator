import {exerciseTabReturn,openTestChat} from './card-tab-fixture';
import {act} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mountGrammarPopup,mountReadingPopup,getActiveReadingSelection,getActivePopupKind,type GrammarMountOptions} from '../../apps/extension/src/ui/mount';
import type {PopupOptions,UiRpc} from '../../apps/extension/src/ui/interfaces';
import * as userActions from '../../apps/extension/src/ui/user-actions';
const handles:{close():void}[]=[],frames=new Map<number,FrameRequestCallback>();let nextFrame=0;
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.spyOn(userActions,'isTrustedUiEvent').mockReturnValue(true);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++nextFrame,callback);return nextFrame;});vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));});
afterEach(async()=>{await act(async()=>handles.splice(0).forEach(handle=>handle.close()));document.body.replaceChildren();frames.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
const sentence='The bank is green.';
function opts(rpc:UiRpc,doc=document):GrammarMountOptions{
 const p=doc.createElement('p');p.textContent=sentence;doc.body.append(p);const range=doc.createRange();range.setStart(p.firstChild!,4);range.setEnd(p.firstChild!,8);range.getBoundingClientRect=()=>new DOMRect(10,10,50,20);
 return {rpc,selection:{range,expression:'bank',context:{sentence,targetStart:4,targetEnd:8}},selectionRange:range,anchor:()=>range.getBoundingClientRect(),source:{kind:'html',title:'Synthetic test',url:'https://example.test',documentId:null,page:null,chapter:null,cfi:null},payload:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:true}};
}
const result={grammarId:'11111111-1111-4111-8111-111111111111',sentence,construction:{text:'is green',targetStart:9,targetEnd:17},question:'Как выражен признак?',answer:'С помощью is и прилагательного.',rule:'Present Simple.',explanation:'Признак предмета.',translation:'Банк зелёный.'};
function rpcStub(extra:Record<string,(payload:any,options?:{signal?:AbortSignal})=>unknown>={}):UiRpc{return vi.fn(async(type:string,payload:any,options?:{signal?:AbortSignal})=>{
 if(extra[type])return extra[type](payload,options);
 if(type==='settings.getReader')return {grammarEnabled:true,defaultDeck:'Test'};
 if(type==='grammar.lookup')return result;
 if(type==='pronunciation.get')return {pronunciation:{ipa:'/bank/',dialect:'en-US',source:'generated',sourceUrl:null}};
 if(type==='lookup')return {lookupId:'lookup-bank',expression:'bank',lemma:'bank',partOfSpeech:'noun',recommendedSenseId:'sense',contextAmbiguous:false,senses:[{id:'sense',translations:['банк'],definition:'A building.'}],ipaCandidate:null};
 return {};
}) as UiRpc;}
async function grammar(options:GrammarMountOptions){await act(async()=>{handles.push(mountGrammarPopup(options));});}
async function reading(options:GrammarMountOptions){const value:PopupOptions={...options,lookupPayload:{expression:'bank',context:options.selection.context,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US'}};await act(async()=>{handles.push(mountReadingPopup(value));});}
const host=()=>document.querySelector<HTMLElement>('[data-english-reader-popup]')!;
const button=(text:string)=>[...host().shadowRoot!.querySelectorAll('button')].find(node=>node.textContent===text)!;
async function flushFrames(){await act(async()=>{for(const[id,callback]of[...frames]){frames.delete(id);callback(0);}});}
describe('shared reading and grammar popup lifecycle',()=>{
 it('does not generate on ordinary mount, close or reopen, and maintains one active source',async()=>{
  const rpc=rpcStub(),options=opts(rpc);await grammar(options);expect(vi.mocked(rpc).mock.calls.every(([type])=>type==='settings.getReader')).toBe(true);expect(getActivePopupKind()).toBe('grammar');expect(getActiveReadingSelection()?.context.sentence).toBe(sentence);
  const old=host();await grammar(options);expect(old.isConnected).toBe(false);expect(document.querySelectorAll('[data-english-reader-popup]')).toHaveLength(1);expect(vi.mocked(rpc).mock.calls.every(([type])=>type==='settings.getReader')).toBe(true);
  await act(async()=>handles.at(-1)!.close());expect(getActiveReadingSelection()).toBeNull();expect(getActivePopupKind()).toBeNull();
 });
 it('aborts a pending explicit grammar request on lexical replacement without accepting its late result',async()=>{
  let finish!:(value:unknown)=>void,signal!:AbortSignal;const rpc=rpcStub({'grammar.lookup':(_payload,options)=>new Promise(resolve=>{finish=resolve;signal=options!.signal!;})});
  const options=opts(rpc);await grammar({...options,autoGenerate:true});expect(signal.aborted).toBe(false);await reading(options);expect(signal.aborted).toBe(true);expect(getActivePopupKind()).toBe('lookup');
  await act(async()=>finish(result));expect(host().shadowRoot!.textContent).not.toContain('Как выражен признак?');expect(vi.mocked(rpc).mock.calls.filter(([type])=>type==='grammar.lookup')).toHaveLength(1);
 });
 it('keeps a dispatched grammar save identity alive through replacement and ignores the late UI result',async()=>{
  let finish!:(value:unknown)=>void;const rpc=rpcStub({'grammar.addNote':()=>new Promise(resolve=>{finish=resolve;})}),options=opts(rpc);await grammar({...options,autoGenerate:true});
  await act(async()=>button('Добавить в Anki').click());const sent=vi.mocked(rpc).mock.calls.find(([type])=>type==='grammar.addNote')!,snapshot=structuredClone(sent[1]);expect(sent[2]).toBeUndefined();await reading(options);
  await act(async()=>finish({operationId:snapshot?.operationId,status:'added',noteId:123}));expect(sent[1]).toEqual(snapshot);expect(vi.mocked(rpc).mock.calls.filter(([type])=>type==='grammar.addNote')).toHaveLength(1);expect(host().shadowRoot!.textContent).not.toContain('Добавлено в Anki');expect(getActivePopupKind()).toBe('lookup');
 });
 it.each(['lookup','grammar'] as const)('uses the actual EPUB reader theme for %s and updates open popups', async kind=>{
  const shell=document.createElement('section');shell.className='rc-shell';shell.dataset.readerTheme='cream';
  shell.style.setProperty('--rc-panel','#f6f0dc');shell.style.setProperty('--rc-ink','#373328');
  document.body.append(shell);const frame=document.createElement('iframe');shell.append(frame);
  const options={...opts(rpcStub(),frame.contentDocument!),trustedPage:true};
  if(kind==='lookup') await reading(options);else await grammar(options);
  expect(host().dataset.bookTheme).toBe('cream');
  expect(host().style.getPropertyValue('--surface')).toBe('#f6f0dc');
  await act(async()=>{shell.style.setProperty('--rc-panel','#3b3b3f');shell.style.setProperty('--rc-ink','#f6f5f8');shell.dataset.readerTheme='graphite';});
  expect(host().dataset.bookTheme).toBe('graphite');
  expect(host().style.getPropertyValue('--surface')).toBe('#3b3b3f');
  expect(host().style.getPropertyValue('--ink')).toBe('#f6f5f8');
  await act(async()=>{shell.style.setProperty('--rc-panel','#fafafe');shell.dataset.readerTheme='white';});
  expect(host().dataset.bookTheme).toBe('white');
  expect(host().style.getPropertyValue('--surface')).toBe('#fafafe');
 });
 it('uses the containing PDF reader and ignores website lookalikes',async()=>{
  const shell=document.createElement('section');shell.className='rc-shell';shell.dataset.readerTheme='cream';
  shell.style.setProperty('--rc-panel','#f6f0dc');document.body.append(shell);
  const options=opts(rpcStub()),range=options.selection.range,text=range.startContainer;shell.append(text.parentElement!);range.setStart(text,4);range.setEnd(text,8);
  await grammar({...options,trustedPage:true});expect(host().dataset.bookTheme).toBe('cream');
  await reading(options);expect(host().dataset.bookTheme).toBeUndefined();expect(host().style.getPropertyValue('--surface')).toBe('');
 });
 it.each(['visible','hidden'] as const)('closes a detached iframe in a %s tab even if its inner nodes still report connected',async visibility=>{
  const frame=document.createElement('iframe');document.body.append(frame);
  const options=opts(rpcStub(),frame.contentDocument!);await grammar(options);
  vi.spyOn(document,'visibilityState','get').mockReturnValue(visibility);
  frame.remove();await flushFrames();
  expect(getActivePopupKind()).toBeNull();
  expect(document.querySelector('[data-english-reader-popup]')).toBeNull();
 });
});

it.each(['textarea','header','page','iframe'] as const)('first Escape from %s returns to the analysis, the next one closes the actual popup',async location=>{
 const frame=location==='iframe'?document.createElement('iframe'):null;
 if(frame)document.body.append(frame);
 const options=opts(rpcStub(),frame?.contentDocument??document);
 await grammar({...options,autoGenerate:true});
 const shadow=host().shadowRoot!;
 await act(async()=>shadow.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!.click());
 const textarea=shadow.querySelector('textarea')!;
 expect(shadow.activeElement).toBe(textarea);
 const target=location==='textarea'?textarea:location==='header'?shadow.querySelector<HTMLElement>('.grammar-heading button')!
   :location==='iframe'?frame!.contentDocument!.body:document.body;
 target.setAttribute('tabindex','0');target.focus();
 await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true})));
 expect(getActivePopupKind()).toBe('grammar');
 expect(shadow.querySelector('.grammar-chat')).toBeNull();
 expect(shadow.activeElement?.getAttribute('aria-label')).toBe('Открыть языковой чат');
 await act(async()=>shadow.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true})));
 expect(getActivePopupKind()).toBeNull();
});

it('keeps the same library card and pending chat in its chapter frame when tabs change',async()=>{
  const listeners=new Set<(info:chrome.tabs.OnActivatedInfo)=>void>();
  vi.stubGlobal('chrome',{tabs:{getCurrent:async()=>({id:31,windowId:7,active:true}),
    onActivated:{addListener:(fn:(info:chrome.tabs.OnActivatedInfo)=>void)=>listeners.add(fn),
      removeListener:(fn:(info:chrome.tabs.OnActivatedInfo)=>void)=>listeners.delete(fn)}}});
  const frame=document.createElement('iframe');document.body.append(frame);
  const visible=vi.spyOn(document,'visibilityState','get'),hidden=vi.spyOn(document,'hidden','get');
  let anchor:DOMRect|null=new DOMRect(24,24,40,18);
  const card=await openTestChat(frame.contentDocument!,'bank',()=>anchor);
  try {
    await exerciseTabReturn(card,away=>{
      anchor=away?null:new DOMRect(160,90,40,18);
      for(const notify of listeners)notify({tabId:away?32:31,windowId:7});
      visible.mockReturnValue(away?'hidden':'visible');hidden.mockReturnValue(away);
      frame.contentWindow?.dispatchEvent(new Event(away?'blur':'focus'));
      window.dispatchEvent(new Event(away?'blur':'focus'));document.dispatchEvent(new Event('visibilitychange'));
      if(away)window.dispatchEvent(new Event('resize'));
      for(const [id,callback] of [...frames]){frames.delete(id);callback(0);}
    });
    expect(card.host.style.left).toBe('160px');
  } finally { await card.close(); }
});


it.each([320,390])('fits the open chat in a %ipx visual viewport after a keyboard resize',async width=>{
 const viewport=Object.assign(new EventTarget(),{width,height:285,offsetLeft:30,offsetTop:55});
 vi.stubGlobal('visualViewport',viewport);
 const card=await openTestChat(document,'bank',()=>new DOMRect(300,205,40,20));
 try {
  vi.spyOn(card.host,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,width-24,245));
  await flushFrames();
  expect(card.host.style.left).toBe('42px');
  expect(card.host.style.top).toBe('67px');
  expect(card.host.style.getPropertyValue('--grammar-chat-viewport-width')).toBe(width+'px');
  Object.assign(viewport,{height:240,offsetTop:84});viewport.dispatchEvent(new Event('resize'));
  await flushFrames();
  expect(card.host.style.top).toBe('96px');
  expect(card.host.style.getPropertyValue('--grammar-chat-viewport-height')).toBe('240px');
 } finally { await card.close(); }
});
