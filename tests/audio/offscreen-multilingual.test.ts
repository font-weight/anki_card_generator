import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {LANGUAGES} from '../../packages/contracts/src/index.ts';

vi.mock('@english-reader/storage',()=>({openReaderStorage:vi.fn()}));
const id='a'.repeat(32),background={id,url:`chrome-extension://${id}/background.js`};
let listener:(message:unknown,sender:chrome.runtime.MessageSender,reply:(data:any)=>void)=>unknown;
let voices:{voiceURI:string;lang:string;localService:boolean;default?:boolean}[];
let speak:ReturnType<typeof vi.fn>,voiceEvents:EventTarget;
beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();voices=[];voiceEvents=new EventTarget();
 speak=vi.fn(utterance=>utterance.onstart?.());
 vi.stubGlobal('chrome',{runtime:{id,getURL:(path:string)=>`chrome-extension://${id}/${path}`,onMessage:{addListener:(callback:typeof listener)=>{listener=callback;}}}});
 vi.stubGlobal('speechSynthesis',{getVoices:()=>voices,speak,cancel:vi.fn(),addEventListener:voiceEvents.addEventListener.bind(voiceEvents),removeEventListener:voiceEvents.removeEventListener.bind(voiceEvents)});
 vi.stubGlobal('SpeechSynthesisUtterance',class{voice:unknown;lang='';rate=1;onstart?:()=>void;onerror?:()=>void;constructor(public text:string){}});
 await import('../../apps/extension/src/offscreen');
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

describe('offscreen multilingual playback boundary',()=>{
 for(const language of LANGUAGES)it(`speaks ${language.code} only with the exact local source voice`,()=>{
  const selected={voiceURI:`local-${language.code}`,lang:language.locale.replaceAll('-','_'),localService:true};
  voices=[{voiceURI:'cloud',lang:language.locale,localService:false,default:true},{voiceURI:'english',lang:'en-US',localService:true,default:true},selected];
  const reply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'same',sourceLanguage:language.code,locale:language.locale,dialect:language.locale,voiceURI:selected.voiceURI,speed:.85},background,reply);
  expect(speak).toHaveBeenCalledOnce();const utterance=speak.mock.calls[0]![0];expect(utterance.voice).toBe(selected);expect(utterance.lang).toBe(language.locale);expect(utterance.rate).toBe(.85);expect(reply).toHaveBeenCalledExactlyOnceWith({played:true});
 });
 it('rejects a selected URI that now belongs to another locale or remote voice',()=>{
  for(const invalid of [{voiceURI:'chosen',lang:'en-US',localService:true},{voiceURI:'chosen',lang:'fr-FR',localService:false},{voiceURI:'replacement',lang:'fr-FR',localService:true}]){
   voices=[invalid];const reply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'bonjour',sourceLanguage:'fr',locale:'fr-FR',voiceURI:'chosen'},background,reply);expect(reply).toHaveBeenCalledOnce();expect(reply.mock.calls[0]![0].played).toBe(false);
  }
  expect(speak).not.toHaveBeenCalled();
 });
 it('waits for voice enumeration without an English fallback or duplicate playback',async()=>{
  const reply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'bonjour',sourceLanguage:'fr',locale:'fr-FR',voiceURI:'fr'},background,reply);
  expect(speak).not.toHaveBeenCalled();voices=[{voiceURI:'en',lang:'en-US',localService:true},{voiceURI:'fr',lang:'fr-FR',localService:true}];
  voiceEvents.dispatchEvent(new Event('voiceschanged'));voiceEvents.dispatchEvent(new Event('voiceschanged'));await vi.advanceTimersByTimeAsync(3000);
  expect(speak).toHaveBeenCalledOnce();expect(reply).toHaveBeenCalledExactlyOnceWith({played:true});
 });
 it('reports unavailable after bounded enumeration and ignores a later installed voice',async()=>{
  const reply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'bonjour',sourceLanguage:'fr',locale:'fr-FR',voiceURI:'fr'},background,reply);
  await vi.advanceTimersByTimeAsync(2001);expect(reply).toHaveBeenCalledOnce();expect(reply.mock.calls[0]![0].played).toBe(false);
  voices=[{voiceURI:'fr',lang:'fr-FR',localService:true}];voiceEvents.dispatchEvent(new Event('voiceschanged'));expect(speak).not.toHaveBeenCalled();
 });
 it('does not let an older pending voice request interrupt a newer language preview',()=>{
  const oldReply=vi.fn(),newReply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'bonjour',sourceLanguage:'fr',locale:'fr-FR',voiceURI:'fr'},background,oldReply);
  voices=[{voiceURI:'de',lang:'de-DE',localService:true}];listener({target:'offscreen',kind:'local_speech',text:'hallo',sourceLanguage:'de',locale:'de-DE',voiceURI:'de'},background,newReply);
  expect(newReply).toHaveBeenCalledExactlyOnceWith({played:true});
  voices.push({voiceURI:'fr',lang:'fr-FR',localService:true});voiceEvents.dispatchEvent(new Event('voiceschanged'));
  expect(speak).toHaveBeenCalledOnce();expect(speak.mock.calls[0]![0].text).toBe('hallo');expect(oldReply).toHaveBeenCalledOnce();expect(oldReply.mock.calls[0]![0].played).toBe(false);
 });
 it('never reaches speech synthesis for invalid source, mismatched locale, or invalid parameters',()=>{
  voices=[{voiceURI:'en',lang:'en-US',localService:true}];
  for(const patch of [{sourceLanguage:'fr',locale:'en-US'},{sourceLanguage:null},{locale:null},{speed:null},{text:'\u0000'},{sourceLanguage:'xx'}]){
   const reply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'same',...patch},background,reply);expect(reply).toHaveBeenCalledOnce();expect(reply.mock.calls[0]![0].played).toBe(false);
  }
  expect(speak).not.toHaveBeenCalled();
 });
});
