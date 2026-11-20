import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {ReadingPopup} from '../../apps/extension/src/ui/ReadingPopup';
import * as consent from '../../apps/extension/src/runtime/grammar-consent';
import * as userActions from '../../apps/extension/src/ui/user-actions';
import {enumeratePhrasalCandidates} from '@english-reader/contracts';
import type {LookupData,LookupPayload,NoteDraftV3} from '@english-reader/contracts';
import type {UiRpc,PopupOptions} from '../../apps/extension/src/ui/interfaces';

const sentence='🌥️ The sky clouded over, then clouded over again.',start=sentence.lastIndexOf('clouded');
const context={sentence,targetStart:start,targetEnd:start+'clouded'.length};
const phrasalCandidates=enumeratePhrasalCandidates(context),candidate=phrasalCandidates[0]!;
const payload:LookupPayload={expression:'clouded',context,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US',phrasalCandidates};
const result:LookupData={lookupId:'55555555-5555-4555-8555-555555555555',expression:'clouded over',lemma:'cloud over',partOfSpeech:'phrasal verb',recommendedSenseId:'clouds',contextAmbiguous:false,senses:[{id:'clouds',translations:['затянуться облаками'],definition:'To become covered with clouds.'}],ipaCandidate:null,extraExample:null,resolvedTarget:{candidateId:candidate.id,targetStart:candidate.targetStart,targetEnd:candidate.targetEnd}};
const refined:LookupData={...result,lookupId:'66666666-6666-4666-8666-666666666666'};delete refined.resolvedTarget;
const source={kind:'html' as const,title:'Offline fixture',url:'https://reader.example',documentId:null,page:null,chapter:null,cfi:null};
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{vi.spyOn(userActions,'isTrustedUiEvent').mockReturnValue(true);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;node=document.createElement('div');document.body.append(node);root=createRoot(node);});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();});
const button=(text:string)=>[...node.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===text)!;
const rpc=(grammarEnabled=false)=>vi.fn(async(type:string)=>{
 if(type==='settings.getReader')return{defaultDeck:'Test',cloudAudioEnabled:true,grammarEnabled};
 if(type==='lookup')return structuredClone(result);
 if(type==='lookup.refine')return structuredClone(refined);
 if(type==='pronunciation.get')return{pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null}};
 if(type==='card.enrich')return{examples:[{text:'The sky clouded over.',translation:'Небо затянулось облаками.',source:'ai'}]};
 if(type==='audio.prepare')return{audioId:'77777777-7777-4777-8777-777777777777'};
 if(type==='anki.addNote')return{operationId:'88888888-8888-4888-8888-888888888888',status:'queued',noteId:null};
 return{};
}) as UiRpc;
const options=(call:UiRpc):PopupOptions=>({rpc:call,lookupPayload:payload,source,anchor:new DOMRect(0,0,10,10)});

it('one initial lookup propagates exact chosen inflected span into UI, refinement, examples, paid audio and saved Anki draft',async()=>{
 const call=rpc();await act(async()=>root.render(<ReadingPopup options={options(call)} close={()=>{}}/>));
 expect(vi.mocked(call).mock.calls.filter(([type])=>type==='lookup')).toHaveLength(1);
 expect(vi.mocked(call).mock.calls.filter(([type])=>['lookup.refine','card.enrich','audio.prepare'].includes(type))).toHaveLength(0);
 expect(node.querySelector('strong')!.textContent).toBe('clouded over');expect(node.querySelector('mark')!.textContent).toBe('clouded over');expect(node.querySelector('.sentence')!.textContent).toBe(sentence);
 expect(node.querySelector('mark')!.previousSibling?.textContent).toBe(sentence.slice(0,start));
 await act(async()=>button('Уточнить смысл — платный запрос').click());
 expect(node.querySelector('mark')!.textContent).toBe('clouded over');expect(node.querySelector('mark')!.previousSibling?.textContent).toBe(sentence.slice(0,start));
 await act(async()=>button('Получить до 3 примеров — платный запрос').click());
 const exampleCheckbox=node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!;await act(async()=>exampleCheckbox.click());
 const audioCheckbox=[...node.querySelectorAll('label')].find(label=>label.textContent?.includes('Создать аудиофайл (платный запрос)'))!.querySelector<HTMLInputElement>('input')!;
 await act(async()=>audioCheckbox.click());
 const audio=vi.mocked(call).mock.calls.find(([type])=>type==='audio.prepare')![1]!;const draft=audio.draft as NoteDraftV3;
 expect(draft.expression).toBe('clouded over');expect(draft.lemma).toBe('cloud over');expect(draft.context).toEqual({sentence,targetStart:candidate.targetStart,targetEnd:candidate.targetEnd});expect(draft.examples).toHaveLength(1);
 await act(async()=>button('Добавить в Anki').click());
 const saved=vi.mocked(call).mock.calls.find(([type])=>type==='anki.addNote')![1]!;expect(saved.draft).toEqual(draft);expect(saved.audioId).toBe('77777777-7777-4777-8777-777777777777');
 expect(vi.mocked(call).mock.calls.filter(([type])=>type==='lookup')).toHaveLength(1);
});

it('explicit grammar fallback opens only preview callback; synthetic actions cannot invoke it',async()=>{
 const call=rpc(true),openGrammar=vi.fn();await act(async()=>root.render(<ReadingPopup options={{...options(call),openGrammar}} close={()=>{}}/>));
 expect(openGrammar).not.toHaveBeenCalled();await act(async()=>button('Разбор предложения по левому Alt').click());expect(openGrammar).toHaveBeenCalledOnce();
 vi.mocked(userActions.isTrustedUiEvent).mockReturnValue(false);await act(async()=>button('Разбор предложения по левому Alt').click());expect(openGrammar).toHaveBeenCalledOnce();
 expect(vi.mocked(call).mock.calls.some(([type])=>type.startsWith('grammar.'))).toBe(false);
});

it('changing configured source language after extraction cannot carry English candidates into another language request',async()=>{
 const call=vi.fn(async(type:string)=>{
 if(type==='settings.getReader')return{sourceLanguage:'fr',targetLanguage:'ru',dialect:'fr-FR',defaultDeck:'Test'};
 if(type==='lookup')throw Error('Stop after capturing the input');return{};
 }) as UiRpc;
 await act(async()=>root.render(<ReadingPopup options={options(call)} close={()=>{}}/>));
 const request=vi.mocked(call).mock.calls.find(([type])=>type==='lookup')![1]!;expect(request.sourceLanguage).toBe('fr');expect(request.phrasalCandidates).toBeUndefined();expect(request.expression).toBe('clouded');
});

it('hides the grammar entry while grammar is disabled and keeps Shift translation available',async()=>{
 const call=rpc(),openGrammar=vi.fn();
 await act(async()=>root.render(<ReadingPopup options={{...options(call),openGrammar}} close={()=>{}}/>));
 expect(button('Разбор предложения по левому Alt')).toBeUndefined();
 expect(node.querySelector('.translation')?.textContent).toBe('затянуться облаками');
 expect(vi.mocked(call).mock.calls.some(([type])=>type.startsWith('grammar.'))).toBe(false);
});

it('removes the grammar button on a worker signal even if an older lookup settings reply still says on',async()=>{
 let changed!:()=>void,finish!:(settings:object)=>void,first=true;
 vi.spyOn(consent,'subscribeGrammarConsentChange').mockImplementation(callback=>{changed=callback;return ()=>{};});
 const lookup=rpc(true);
 const call=vi.fn(async(type:string,body?:Record<string,unknown>,options?:{signal?:AbortSignal})=>{
  if(type==='settings.getReader'){
    if(first){first=false;return new Promise(resolve=>{finish=resolve;});}
    return {grammarEnabled:false};
  }
  return lookup(type,body,options);
 }) as UiRpc;
 await act(async()=>root.render(<ReadingPopup options={{...options(call),openGrammar:vi.fn()}} close={()=>{}}/>));
 await act(async()=>changed());
 await act(async()=>finish({defaultDeck:'Test',grammarEnabled:true}));
 expect(button('Разбор предложения по левому Alt')).toBeUndefined();
 expect(node.querySelector('.translation')?.textContent).toBe('затянуться облаками');
 expect(vi.mocked(call).mock.calls.filter(([type])=>type==='lookup')).toHaveLength(1);
});

it('removes an already visible grammar entry immediately while its new consent check is pending',async()=>{
 let changed!:()=>void,finish!:(settings:object)=>void,changedSettings=false;
 const unsubscribe=vi.fn();
 vi.spyOn(consent,'subscribeGrammarConsentChange').mockImplementation(callback=>{changed=callback;return unsubscribe;});
 const lookup=rpc(true);
 const call=vi.fn(async(type:string,body?:Record<string,unknown>,options?:{signal?:AbortSignal})=>{
  if(type==='settings.getReader'&&changedSettings)return new Promise(resolve=>{finish=resolve;});
  return lookup(type,body,options);
 }) as UiRpc;
 await act(async()=>root.render(<ReadingPopup options={{...options(call),openGrammar:vi.fn()}} close={()=>{}}/>));
 expect(button('Разбор предложения по левому Alt')).toBeDefined();
 changedSettings=true;await act(async()=>changed());
 expect(button('Разбор предложения по левому Alt')).toBeUndefined();
 await act(async()=>finish({grammarEnabled:false}));
 expect(button('Разбор предложения по левому Alt')).toBeUndefined();
 expect(vi.mocked(call).mock.calls.filter(([type])=>type==='lookup')).toHaveLength(1);
 await act(async()=>root.render(null));expect(unsubscribe).toHaveBeenCalledOnce();
});
