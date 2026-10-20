import {storageOptions} from './runtime/storage-config';
import { openReaderStorage } from '@english-reader/storage';
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(sender.id!==chrome.runtime.id||sender.tab!==undefined||sender.url!==chrome.runtime.getURL('background.js')||message?.target!=='offscreen')return;
 if(message.kind==='local_speech'&&(typeof message.text!=='string'||message.text.length<1||message.text.length>500))return;
 if(message.kind==='cached_audio'&&(typeof message.audioId!=='string'||! /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(message.audioId)))return;
 let answered=false;const respondOnce=(value:unknown)=>{if(!answered){answered=true;respond(value);}};
 if(message.kind==='list_voices'){const sendVoices=()=>respondOnce(speechSynthesis.getVoices().filter(v=>v.localService).map(v=>({voiceURI:v.voiceURI,lang:v.lang,localService:v.localService,default:v.default})));if(speechSynthesis.getVoices().length)sendVoices();else{speechSynthesis.addEventListener('voiceschanged',sendVoices,{once:true});setTimeout(()=>{speechSynthesis.removeEventListener('voiceschanged',sendVoices);sendVoices();},2000);}return true;}
 if(message.kind==='local_speech'){
  const text=String(message.text??'').slice(0,500);const dialect=message.dialect==='en-GB'?'en-GB':'en-US';
  const speak=()=>{const voices=speechSynthesis.getVoices();const voice=typeof message.voiceURI==='string'?voices.find(v=>v.localService&&v.voiceURI===message.voiceURI):(voices.find(v=>v.localService&&v.lang===dialect)||voices.find(v=>v.localService&&v.lang.startsWith('en')));
   if(!voice){respondOnce({played:false,error:'Локальный английский голос недоступен.'});return;}
   speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.voice=voice;utterance.lang=voice.lang;utterance.rate=typeof message.speed==='number'&&message.speed>=0.25&&message.speed<=4?message.speed:1;utterance.onstart=()=>respondOnce({played:true});utterance.onerror=()=>respondOnce({played:false,error:'Не удалось воспроизвести речь.'});speechSynthesis.speak(utterance);};
  if(speechSynthesis.getVoices().length)speak();else {speechSynthesis.addEventListener('voiceschanged',speak,{once:true});setTimeout(()=>{speechSynthesis.removeEventListener('voiceschanged',speak);if(!speechSynthesis.getVoices().length)respondOnce({played:false,error:'Локальный голос недоступен.'});},2000);}return true;
 }
 if(message.kind==='cached_audio'){
  void (async()=>{let store:Awaited<ReturnType<typeof openReaderStorage>>|undefined;try{store=await openReaderStorage(storageOptions);const audio=await store.getAudio(message.audioId);if(!audio)throw Error('Аудиофайл не найден.');const url=URL.createObjectURL(audio.blob);const player=new Audio(url);player.onended=()=>URL.revokeObjectURL(url);player.onerror=()=>URL.revokeObjectURL(url);try{await player.play();respondOnce({played:true});}catch(e){URL.revokeObjectURL(url);throw e;}}catch{respondOnce({played:false,error:'Аудио недоступно.'});}finally{store?.close();}})();return true;
 }
});
