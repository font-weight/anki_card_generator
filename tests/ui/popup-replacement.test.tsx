import {act} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getActiveReadingSelection,mountReadingPopup} from '../../apps/extension/src/ui/mount';
import * as userActions from '../../apps/extension/src/ui/user-actions';
import type {PopupHandle,PopupOptions,UiRpc} from '../../apps/extension/src/ui/interfaces';
const handles:PopupHandle[]=[];
const frames=new Map<number,FrameRequestCallback>();let frameId=0;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.spyOn(userActions,'isTrustedUiEvent').mockReturnValue(true);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
});
afterEach(async()=>{await act(async()=>handles.splice(0).forEach(handle=>handle.close()));document.body.replaceChildren();frames.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
function lookup(word:string){return{lookupId:`lookup-${word}`,expression:word,lemma:word,partOfSpeech:'noun',recommendedSenseId:'sense',contextAmbiguous:false,senses:[{id:'sense',translations:[`перевод ${word}`],definition:'A test definition.'}],ipaCandidate:null};}
function options(rpc:UiRpc,word:string,doc=document):PopupOptions{
  const p=doc.createElement('p');p.textContent=`The ${word} is green.`;doc.body.append(p);
  const range=doc.createRange();range.setStart(p.firstChild!,4);range.setEnd(p.firstChild!,4+word.length);range.getBoundingClientRect=()=>new DOMRect(10,10,80,20);
  return{rpc,selectionRange:range,anchor:()=>range.getBoundingClientRect(),lookupPayload:{expression:word,context:{sentence:p.textContent,targetStart:4,targetEnd:4+word.length},sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US'},source:{kind:'html',title:'Test',url:'https://example.test',documentId:null,page:null,chapter:null,cfi:null}};
}
function fakeRpc(overrides:Record<string,(payload:any,options?:{signal?:AbortSignal})=>unknown>={}):UiRpc{
  return vi.fn(async(type:string,payload:any,opts?:{signal?:AbortSignal})=>{
    if(overrides[type])return overrides[type](payload,opts);
    if(type==='settings.getReader')return{defaultDeck:'Test',cloudAudioEnabled:true};
    if(type==='lookup')return lookup(payload.expression);
    if(type==='pronunciation.get')return{pronunciation:{ipa:'/NEW/',dialect:'en-US',source:'generated',sourceUrl:null}};
    return{};
  }) as UiRpc;
}
async function mount(opt:PopupOptions){let handle!:PopupHandle;await act(async()=>{handle=mountReadingPopup(opt);handles.push(handle);});return handle;}
const host=()=>document.querySelector<HTMLElement>('[data-english-reader-popup]')!;
const panel=()=>host().shadowRoot!;
const button=(text:string)=>[...panel().querySelectorAll('button')].find(button=>button.textContent===text)!;
async function flushFrames(){await act(async()=>{for(const[id,callback]of[...frames]){frames.delete(id);callback(0);}});}
describe('single popup replacement lifecycle',()=>{
  it('unmounts the old host, aborts its initial lookup and ignores its late result',async()=>{
    let finish!:(value:unknown)=>void;let signal!:AbortSignal;
    const rpc=fakeRpc({lookup:(payload,opts)=>payload.expression==='bank'?new Promise(resolve=>{finish=resolve;signal=opts!.signal!;}):lookup(payload.expression)});
    const first=await mount(options(rpc,'bank')),oldHost=host();
    expect(signal.aborted).toBe(false);
    const next=options(rpc,'shore');await mount(next);
    expect(signal.aborted).toBe(true);expect(oldHost.isConnected).toBe(false);expect(document.querySelectorAll('[data-english-reader-popup]')).toHaveLength(1);
    expect(getActiveReadingSelection()).toMatchObject({range:next.selectionRange,expression:'shore',context:next.lookupPayload.context});
    await act(async()=>{finish(lookup('bank'));first.close();});
    expect(panel().querySelector('strong')!.textContent).toBe('shore');expect(panel().textContent).not.toContain('перевод bank');
  });
  it('has one popup across different reader documents and old document teardown cannot close the successor',async()=>{
    const iframe=document.createElement('iframe');document.body.append(iframe);const rpc=fakeRpc();
    const first=await mount(options(rpc,'bank',iframe.contentDocument!));const next=options(rpc,'shore');await mount(next);
    await act(async()=>first.close());expect(document.querySelectorAll('[data-english-reader-popup]')).toHaveLength(1);expect(getActiveReadingSelection()?.range.startContainer.ownerDocument).toBe(document);
  });
  it('keeps dispatched save intent alive, does not resend it and never shows its old result in the replacement',async()=>{
    let finish!:(value:unknown)=>void;
    const rpc=fakeRpc({'anki.addNote':()=>new Promise(resolve=>{finish=resolve;})});await mount(options(rpc,'bank'));
    await act(async()=>button('Добавить в Anki').click());
    const save=vi.mocked(rpc).mock.calls.find(([type])=>type==='anki.addNote')!;
    expect(save[2]).toBeUndefined();const captured=structuredClone(save[1]);
    await mount(options(rpc,'shore'));
    expect(vi.mocked(rpc).mock.calls.filter(([type])=>type==='anki.addNote')).toHaveLength(1);
    expect(vi.mocked(rpc).mock.calls.some(([type])=>type==='queue.cancel'||type==='queue.retry')).toBe(false);
    await act(async()=>finish({operationId:captured?.operationId,status:'queued',noteId:null}));
    expect(save[1]).toEqual(captured);expect(panel().textContent).not.toContain('Сохранено в очередь — ещё не добавлено');
    expect(button('Добавить в Anki').disabled).toBe(false);expect(panel().querySelector('strong')!.textContent).toBe('shore');
  });
  it('discards unsaved manual edits only on explicit replacement, with visible guidance and no automatic save',async()=>{
    const rpc=fakeRpc();await mount(options(rpc,'bank'));
    expect(panel().textContent).toContain('Несохранённые правки теряются');
    await act(async()=>button('Редактировать').click());const input=panel().querySelector<HTMLInputElement>('fieldset input')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'МОЯ ПРАВКА');input.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(panel().querySelector('.translation')!.textContent).toBe('МОЯ ПРАВКА');
    await mount(options(rpc,'shore'));expect(panel().querySelector('.translation')!.textContent).toBe('перевод shore');
    expect(panel().textContent).not.toContain('МОЯ ПРАВКА');expect(vi.mocked(rpc).mock.calls.some(([type])=>type==='anki.addNote')).toBe(false);
  });
  it('ignores old IPA and prepared audio arriving after replacement without playing or attaching them',async()=>{
    let ipa!:(value:unknown)=>void,audio!:(value:unknown)=>void;
    const rpc=fakeRpc({'pronunciation.get':payload=>payload.lookupId==='lookup-bank'?new Promise(resolve=>{ipa=resolve;}):{pronunciation:{ipa:'/NEW/',dialect:'en-US',source:'generated',sourceUrl:null}},'audio.prepare':()=>new Promise(resolve=>{audio=resolve;})});
    await mount(options(rpc,'bank'));const checkbox=[...panel().querySelectorAll('label')].find(label=>label.textContent?.includes('Создать аудиофайл (платный запрос)'))!.querySelector<HTMLInputElement>('input')!;
    await act(async()=>checkbox.click());expect(vi.mocked(rpc).mock.calls.filter(([type])=>type==='audio.prepare')).toHaveLength(1);
    await mount(options(rpc,'shore'));
    await act(async()=>{ipa({pronunciation:{ipa:'/OLD/',dialect:'en-US',source:'generated',sourceUrl:null}});audio({audioId:'55555555-5555-4555-8555-555555555555'});});
    expect(panel().textContent).toContain('[NEW]');expect(panel().textContent).not.toContain('[OLD]');expect(panel().textContent).not.toContain('Аудиофайл готов.');
    expect(vi.mocked(rpc).mock.calls.some(([type])=>type==='audio.play'||type==='anki.addNote')).toBe(false);
  });
  it('closes detached anchors and tears down scheduled focus/position work',async()=>{
    const opt=options(fakeRpc(),'bank');await mount(opt);const old=host();
    opt.selectionRange!.startContainer.parentElement!.remove();await flushFrames();
    expect(old.isConnected).toBe(false);expect(getActiveReadingSelection()).toBeNull();expect(frames.size).toBe(0);
  });
  it('unmounts on pagehide or external host removal rather than retaining stale active selection',async()=>{
    await mount(options(fakeRpc(),'bank'));await act(async()=>window.dispatchEvent(new Event('pagehide')));expect(getActiveReadingSelection()).toBeNull();expect(document.querySelector('[data-english-reader-popup]')).toBeNull();
    await mount(options(fakeRpc(),'shore'));host().remove();await flushFrames();expect(getActiveReadingSelection()).toBeNull();
  });
  it('replacement preserves underlying focus instead of restoring a removed popup',async()=>{
    const original=document.createElement('button');document.body.append(original);original.focus();
    await mount(options(fakeRpc(),'bank'));await flushFrames();const old=host();expect(document.activeElement).toBe(old);
    const second=await mount(options(fakeRpc(),'shore'));await flushFrames();expect(document.activeElement).toBe(host());
    await act(async()=>second.close());expect(document.activeElement).toBe(original);expect(old.isConnected).toBe(false);
  });
});
