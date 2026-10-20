import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const storage=vi.hoisted(()=>({open:vi.fn()}));
vi.mock('@english-reader/storage',()=>({openReaderStorage:storage.open}));
let listener:(message:unknown,sender:chrome.runtime.MessageSender,respond:(data:unknown)=>void)=>unknown;
let speak:ReturnType<typeof vi.fn>;const id='a'.repeat(32);const background={id,url:`chrome-extension://${id}/background.js`};
beforeEach(async()=>{vi.resetModules();vi.useFakeTimers();storage.open.mockReset();vi.stubGlobal('chrome',{runtime:{id,getURL:(p:string)=>`chrome-extension://${id}/${p}`,onMessage:{addListener:(f:typeof listener)=>{listener=f;}}}});speak=vi.fn();vi.stubGlobal('speechSynthesis',{getVoices:()=>[{localService:true,lang:'en-US'}],speak,cancel:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('SpeechSynthesisUtterance',class {voice:unknown;lang='';onstart?:()=>void;onerror?:()=>void;constructor(public text:string){}});await import('../../apps/extension/src/offscreen');});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('offscreen caller boundary',()=>{
 it('denies direct content and extension-page callers',()=>{for(const sender of [{id,url:'https://example.org',tab:{id:1} as chrome.tabs.Tab},{id,url:`chrome-extension://${id}/settings.html`},{...background,tab:{id:1} as chrome.tabs.Tab},{...background,id:'other'}]){const reply=vi.fn();expect(listener({target:'offscreen',kind:'local_speech',text:'bank'},sender,reply)).toBeUndefined();expect(reply).not.toHaveBeenCalled();}expect(speak).not.toHaveBeenCalled();expect(storage.open).not.toHaveBeenCalled();});
 it('rejects unbounded text and malformed audio IDs before side effects',()=>{for(const message of [{kind:'local_speech',text:'x'.repeat(501)},{kind:'local_speech',text:{}},{kind:'cached_audio',audioId:'../../private'}])listener({target:'offscreen',...message},background,vi.fn());expect(speak).not.toHaveBeenCalled();expect(storage.open).not.toHaveBeenCalled();});
 it('uses only local voice and responds once after start then error',()=>{const reply=vi.fn();expect(listener({target:'offscreen',kind:'local_speech',text:'bank',dialect:'en-US'},background,reply)).toBe(true);expect(speak).toHaveBeenCalledTimes(1);const utterance=speak.mock.calls[0]![0];expect(utterance.voice.localService).toBe(true);utterance.onstart();utterance.onerror();expect(reply).toHaveBeenCalledTimes(1);});
 it('releases cached audio URL and closes storage after playback rejection',async()=>{
  const close=vi.fn();storage.open.mockResolvedValue({getAudio:vi.fn().mockResolvedValue({blob:new Blob(['audio'])}),close});
  const revoke=vi.fn();vi.stubGlobal('URL',Object.assign(URL,{createObjectURL:vi.fn().mockReturnValue('blob:owned-audio'),revokeObjectURL:revoke}));
  vi.stubGlobal('Audio',class {onended?:()=>void;onerror?:()=>void;play(){return Promise.reject(new Error('autoplay denied'));}});
  const reply=vi.fn();listener({target:'offscreen',kind:'cached_audio',audioId:'00000000-0000-4000-8000-000000000000'},background,reply);await vi.advanceTimersByTimeAsync(0);
  expect(reply).toHaveBeenCalledExactlyOnceWith({played:false,error:'Аудио недоступно.'});expect(revoke).toHaveBeenCalledWith('blob:owned-audio');expect(close).toHaveBeenCalledOnce();
 });
 it('responds with a failure when storage cannot open',async()=>{
  storage.open.mockRejectedValue(new Error('storage unavailable'));const reply=vi.fn();listener({target:'offscreen',kind:'cached_audio',audioId:'00000000-0000-4000-8000-000000000000'},background,reply);await vi.advanceTimersByTimeAsync(0);expect(reply).toHaveBeenCalledExactlyOnceWith({played:false,error:'Аудио недоступно.'});
 });

 it('reports unavailable local voice after bounded wait without using remote fallback',async()=>{
  vi.stubGlobal('speechSynthesis',{getVoices:()=>[],speak,cancel:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()});const reply=vi.fn();listener({target:'offscreen',kind:'local_speech',text:'bank'},background,reply);await vi.advanceTimersByTimeAsync(2001);expect(reply).toHaveBeenCalledTimes(1);expect(reply.mock.calls[0]![0].played).toBe(false);expect(speak).not.toHaveBeenCalled();
 });

 it('lists only local voices and honors local requested voice URI',()=>{
  const voices=[{voiceURI:'cloud',lang:'en-US',localService:false,default:true},{voiceURI:'local',lang:'en-US',localService:true,default:false}];vi.stubGlobal('speechSynthesis',{getVoices:()=>voices,speak,cancel:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const reply=vi.fn();listener({target:'offscreen',kind:'list_voices'},background,reply);expect(reply).toHaveBeenCalledExactlyOnceWith([voices[1]]);
  listener({target:'offscreen',kind:'local_speech',text:'bank',voiceURI:'cloud'},background,vi.fn());expect(speak).not.toHaveBeenCalled();
  listener({target:'offscreen',kind:'local_speech',text:'bank',voiceURI:'local',speed:1.25},background,vi.fn());expect(speak.mock.calls[0]![0].voice.voiceURI).toBe('local');expect(speak.mock.calls[0]![0].rate).toBe(1.25);
 });

});
