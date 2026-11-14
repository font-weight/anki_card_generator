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
  const rpc=rpcStub(),options=opts(rpc);await grammar(options);expect(vi.mocked(rpc)).not.toHaveBeenCalled();expect(getActivePopupKind()).toBe('grammar');expect(getActiveReadingSelection()?.context.sentence).toBe(sentence);
  const old=host();await grammar(options);expect(old.isConnected).toBe(false);expect(document.querySelectorAll('[data-english-reader-popup]')).toHaveLength(1);expect(vi.mocked(rpc)).not.toHaveBeenCalled();
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
 it('closes a detached iframe source even if its inner nodes still report connected',async()=>{
  const frame=document.createElement('iframe');document.body.append(frame);const options=opts(rpcStub(),frame.contentDocument!);await grammar(options);frame.remove();await flushFrames();expect(getActivePopupKind()).toBeNull();expect(document.querySelector('[data-english-reader-popup]')).toBeNull();
 });
});
