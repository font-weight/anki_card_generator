import {renderPreview} from '@english-reader/note-templates';
import {installActivation,isReadingPopupEvent} from './content/activation';
import {extractFromRange,type ExtractedText} from './content/extraction';
import {lookupPayloadFor,grammarPayloadFor} from './content/payloads';
import {mountReadingPopup,mountGrammarPopup,getActiveReadingSelection,getActivePopupKind} from './ui';
import {createReaderPreferenceCache} from './runtime/reader-preferences';
import type {PublicSettings,NoteDraft} from '@english-reader/contracts';
import {rpc} from './runtime/rpc-client';
const guard = '__englishReaderInstalled';
const state = globalThis as typeof globalThis & {__englishReaderInstalled?:boolean};
if (!state[guard]) {
 state[guard] = true;
 const preferences = createReaderPreferenceCache(() => rpc<Partial<PublicSettings>>('settings.getReader'));
 const refreshPreferences = () => { void preferences.refresh(); };
 refreshPreferences();
 window.addEventListener('focus',event=>{if(event.isTrusted)refreshPreferences();});
 const onStatus = (failure:{message:string}) => {
  const status=document.createElement('div');status.textContent=failure.message;status.setAttribute('role','status');
  status.style.cssText='position:fixed;bottom:20px;right:20px;background:#172132;color:white;padding:12px;z-index:2147483647;font:14px sans-serif';
  document.documentElement.append(status);setTimeout(()=>status.remove(),4000);
 };
 const source = ():NoteDraft['source'] => {
  const safe=new URL(location.href);safe.search='';safe.hash='';safe.username='';safe.password='';
  return {kind:'html',title:document.title.slice(0,500),url:safe.href,documentId:null,page:null,chapter:null,cfi:null};
 };
 const openSettings=async()=>{const result=await chrome.runtime.sendMessage({hostType:'settings.open'});if(!result?.ok)throw Error('Не удалось открыть настройки.');};
 const anchor=(value:ExtractedText)=>()=>value.range.startContainer.isConnected&&value.range.endContainer.isConnected&&!value.range.collapsed?value.range.getBoundingClientRect():null;
 const openGrammar=(value:ExtractedText,capturedSource:NoteDraft['source'],autoGenerate=false)=>{
  // The explicit button re-extracts the exact sentence, never a clipped lookup
  // context. Opening a preview is not permission to generate.
  const exact=extractFromRange(value.range,preferences.getSnapshot().dialect,'sentence');
  if(!exact.ok){onStatus(exact);return;}
  mountGrammarPopup({rpc,source:capturedSource,openSettings,selection:exact,selectionRange:exact.range,anchor:anchor(exact),
   payload:grammarPayloadFor(exact,preferences.getSnapshot(),preferences.getGrammarSnapshot()),autoGenerate});
 };
 installActivation({document,getLocale:()=>preferences.getSnapshot().dialect,
  getGrammarEnabled:()=>preferences.getGrammarSnapshot().enabled,getActiveKind:getActivePopupKind,
  isPopupEvent:isReadingPopupEvent,getActiveSelection:getActiveReadingSelection,onStatus,
  onGrammarActivate:value=>openGrammar(value,source(),true),
  onActivate:value=>{
   const capturedSource=source();
   mountReadingPopup({rpc,renderPreview,openSettings,selectionRange:value.range,selectionOrigin:value.origin,anchor:anchor(value),lookupPayload:lookupPayloadFor(value,preferences.getSnapshot()),
    source:capturedSource,openGrammar:()=>openGrammar(value,capturedSource)});
  }
 });
}
