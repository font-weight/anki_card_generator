import{defaultLocale,isLanguageCode,localeMatchesLanguage,type Dialect,type LanguageCode}from'@english-reader/contracts';
export interface LocalSpeechRequest{text:string;sourceLanguage:LanguageCode;locale:Dialect;speed:number;voiceURI?:string}
/** Revalidate the frozen source locale in the extension-owned playback document. */
export function validateLocalSpeech(value:unknown):LocalSpeechRequest|null{
 if(!value||typeof value!=='object')return null;const input=value as Record<string,unknown>;
 const sourceLanguage=input.sourceLanguage===undefined?'en':input.sourceLanguage;if(!isLanguageCode(sourceLanguage))return null;
 const locale=input.locale!==undefined?input.locale:input.dialect!==undefined?input.dialect:defaultLocale(sourceLanguage),speed=input.speed===undefined?1:input.speed;
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)||!localeMatchesLanguage(locale,sourceLanguage)||typeof speed!=='number'||!Number.isFinite(speed)||speed<.25||speed>4)return null;
 if(input.locale!==undefined&&input.dialect!==undefined&&input.locale!==input.dialect)return null;
 if(input.voiceURI!==undefined&&(typeof input.voiceURI!=='string'||!input.voiceURI))return null;
 return{text:input.text,sourceLanguage,locale,speed,...(input.voiceURI!==undefined?{voiceURI:input.voiceURI as string}:{})};
}
export function matchingLocalVoice<T extends{localService:boolean;lang:string;voiceURI:string;default?:boolean}>(voices:readonly T[],request:LocalSpeechRequest):T|null{
 const exact=voices.filter(v=>v.localService===true&&v.lang.replaceAll('_','-').toLowerCase()===request.locale.toLowerCase()&&(!request.voiceURI||v.voiceURI===request.voiceURI));
 return exact.find(v=>v.default)??exact[0]??null;
}
