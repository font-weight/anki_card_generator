import type {Dialect,LanguageCode} from '@english-reader/contracts';
let creation:Promise<void>|undefined;
async function ensureOffscreen(){
 if(await chrome.offscreen.hasDocument())return;
 if(!creation)creation=chrome.offscreen.createDocument({url:'offscreen.html',reasons:[chrome.offscreen.Reason.AUDIO_PLAYBACK],justification:'Воспроизведение выбранного слова локальным голосом или сохранённого аудиофайла по действию пользователя.'}).finally(()=>{creation=undefined;});await creation;
}
export async function playLocal(text:string,dialect:string){await ensureOffscreen();return chrome.runtime.sendMessage({target:'offscreen',kind:'local_speech',text,dialect});}
export async function playCached(audioId:string){await ensureOffscreen();return chrome.runtime.sendMessage({target:'offscreen',kind:'cached_audio',audioId});}

export async function listVoices(){await ensureOffscreen();return chrome.runtime.sendMessage({target:'offscreen',kind:'list_voices'});}
export async function speakLocal(input:{text:string;dialect:Dialect;locale?:Dialect;sourceLanguage?:LanguageCode;speed:number;voiceURI:string}){await ensureOffscreen();const response=await chrome.runtime.sendMessage({target:'offscreen',kind:'local_speech',...input});if(!response?.played)throw Error(response?.error||'Локальный голос недоступен.');}
