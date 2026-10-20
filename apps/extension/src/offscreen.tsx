import {validateLocalSpeech,matchingLocalVoice} from './runtime/local-voice';
import {storageOptions} from './runtime/storage-config';
import { openReaderStorage } from '@english-reader/storage';
let localSpeechGeneration=0;
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(sender.id!==chrome.runtime.id||sender.tab!==undefined||sender.url!==chrome.runtime.getURL('background.js')||message?.target!=='offscreen')return;
 if(message.kind==='local_speech'&&(typeof message.text!=='string'||message.text.length<1||message.text.length>500))return;
 if(message.kind==='cached_audio'&&(typeof message.audioId!=='string'||! /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(message.audioId)))return;
 let answered=false;const respondOnce=(value:unknown)=>{if(!answered){answered=true;respond(value);}};
 if(message.kind==='list_voices'){const sendVoices=()=>respondOnce(speechSynthesis.getVoices().filter(v=>v.localService).map(v=>({voiceURI:v.voiceURI,lang:v.lang,localService:v.localService,default:v.default})));if(speechSynthesis.getVoices().length)sendVoices();else{speechSynthesis.addEventListener('voiceschanged',sendVoices,{once:true});setTimeout(()=>{speechSynthesis.removeEventListener('voiceschanged',sendVoices);sendVoices();},2000);}return true;}
 if(message.kind==='local_speech'){
  const input=validateLocalSpeech(message);if(!input){respondOnce({played:false,error:'Недопустимый язык или параметры локального голоса.'});return true;}
  const generation=++localSpeechGeneration;
  let started=false;
  const speak=()=>{if(started)return;started=true;
   if(generation!==localSpeechGeneration){respondOnce({played:false,error:'Прослушивание заменено более новым запросом.'});return;}
   const voice=matchingLocalVoice(speechSynthesis.getVoices(),input);
   if(!voice){respondOnce({played:false,error:'Локальный голос для выбранного языка и локали недоступен.'});return;}
   speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(input.text);utterance.voice=voice;utterance.lang=input.locale;utterance.rate=input.speed;
   const timeout=setTimeout(()=>respondOnce({played:false,error:'Локальный голос не начал воспроизведение.'}),5000);
   utterance.onstart=()=>{clearTimeout(timeout);respondOnce({played:true});};utterance.onerror=()=>{clearTimeout(timeout);respondOnce({played:false,error:'Не удалось воспроизвести речь.'});};
   try{speechSynthesis.speak(utterance);}catch{clearTimeout(timeout);respondOnce({played:false,error:'Не удалось воспроизвести речь.'});}
  };
  if(speechSynthesis.getVoices().length)speak();else {speechSynthesis.addEventListener('voiceschanged',speak,{once:true});setTimeout(()=>{speechSynthesis.removeEventListener('voiceschanged',speak);speak();},2000);}return true;
 }
 if(message.kind==='cached_audio'){
  void (async()=>{let store:Awaited<ReturnType<typeof openReaderStorage>>|undefined;try{store=await openReaderStorage(storageOptions);const audio=await store.getAudio(message.audioId);if(!audio)throw Error('Аудиофайл не найден.');const url=URL.createObjectURL(audio.blob);const player=new Audio(url);player.onended=()=>URL.revokeObjectURL(url);player.onerror=()=>URL.revokeObjectURL(url);try{await player.play();respondOnce({played:true});}catch(e){URL.revokeObjectURL(url);throw e;}}catch{respondOnce({played:false,error:'Аудио недоступно.'});}finally{store?.close();}})();return true;
 }
});
