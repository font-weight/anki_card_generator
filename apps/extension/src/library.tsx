import {renderPreview} from '@english-reader/note-templates';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReaderLibrary,createLibraryStorage} from './readers';
import type {DocumentReady,LibraryStorage} from './readers/types';
import {readerAnchor} from './readers/coordinates';
import {installActivation,isReadingPopupEvent} from './content/activation';
import {extractFromRange,type ExtractedText} from './content/extraction';
import {lookupPayloadFor,grammarPayloadFor} from './content/payloads';
import {mountReadingPopup,mountGrammarPopup,getActiveReadingSelection,getActivePopupKind,uiCss} from './ui';
import {createReaderPreferenceCache} from './runtime/reader-preferences';
import type {PublicSettings,NoteDraft} from '@english-reader/contracts';
import {rpc} from './runtime/rpc-client';
function Library(){
 const [storage,setStorage]=useState<LibraryStorage>(),[error,setError]=useState(''),[status,setStatus]=useState('');
 const preferencesRef=useRef(createReaderPreferenceCache(()=>rpc<Partial<PublicSettings>>('settings.getReader',{})));
 useEffect(()=>{let alive=true;createLibraryStorage().then(value=>{if(alive)setStorage(value);}).catch(()=>{if(alive)setError('Локальная библиотека недоступна. Проверьте свободное место и разрешения браузера.');});const refresh=()=>{void preferencesRef.current.refresh();};refresh();const focus=(event:FocusEvent)=>{if(event.isTrusted)refresh();};window.addEventListener('focus',focus);return()=>{alive=false;preferencesRef.current.invalidate();window.removeEventListener('focus',focus);};},[]);
 const onDocumentReady=useCallback<DocumentReady>((readerDocument,getSource)=>{
  let close:(()=>void)|undefined;
  const closePopup=()=>{close?.();close=undefined;};
  const validSource=(value:ExtractedText,source:NoteDraft['source'])=>{
   // PDF shares the library document; neither toolbar nor surrounding UI is text.
   if(source.kind!=='pdf')return true;
   const node=value.range.commonAncestorContainer,element=node.nodeType===1?node as Element:node.parentElement;
   return !!element?.closest('.textLayer');
  };
  const openSettings=()=>chrome.runtime.openOptionsPage();
  const openGrammar=(value:ExtractedText,capturedSource:NoteDraft['source'],autoGenerate=false)=>{
   if(!validSource(value,capturedSource))return;
   const exact=extractFromRange(value.range,preferencesRef.current.getSnapshot().dialect,'sentence');
   if(!exact.ok){setStatus(exact.message);return;}
   closePopup();setStatus('');
   close=mountGrammarPopup({rpc,trustedPage:true,openSettings,selection:exact,selectionRange:exact.range,anchor:()=>readerAnchor(exact.range),source:capturedSource,
    payload:grammarPayloadFor(exact,preferencesRef.current.getSnapshot(),preferencesRef.current.getGrammarSnapshot()),autoGenerate}).close;
  };
  const stop=installActivation({document:readerDocument,popupDocument:document,getActiveSelection:getActiveReadingSelection,getActiveKind:getActivePopupKind,
   getLocale:()=>preferencesRef.current.getSnapshot().dialect,getGrammarEnabled:()=>preferencesRef.current.getGrammarSnapshot().enabled,
   isPopupEvent:isReadingPopupEvent,onStatus:failure=>setStatus(failure.message),onGrammarActivate:value=>openGrammar(value,getSource(value.range),true),onActivate:value=>{
    const source=getSource(value.range);if(!validSource(value,source))return;
    closePopup();setStatus('');
    close=mountReadingPopup({rpc,renderPreview,trustedPage:true,openSettings,selectionRange:value.range,selectionOrigin:value.origin,anchor:()=>readerAnchor(value.range),
     lookupPayload:lookupPayloadFor(value,preferencesRef.current.getSnapshot()),source,openGrammar:()=>openGrammar(value,source)}).close;
   }});
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&event.isTrusted&&!event.isComposing&&event.keyCode!==229)closePopup();};
  const scroll=()=>window.dispatchEvent(new Event('scroll'));
  if(readerDocument!==document){readerDocument.addEventListener('pointerdown',closePopup,true);readerDocument.addEventListener('keydown',key,true);readerDocument.defaultView?.addEventListener('scroll',scroll,true);}
  return()=>{stop();closePopup();readerDocument.removeEventListener('pointerdown',closePopup,true);readerDocument.removeEventListener('keydown',key,true);readerDocument.defaultView?.removeEventListener('scroll',scroll,true);};
 },[]);
 if(error)return <p role="alert">{error}</p>;if(!storage)return <p role="status">Открытие локальной библиотеки…</p>;
 return <>{status&&<p role="status">{status}</p>}<ReaderLibrary storage={storage} onDocumentReady={onDocumentReady}/></>;
}
// This is an extension-owned page, not an injected web page. A light-DOM reader
// keeps PDF caret APIs and bundled CSS reliable; the lookup popup is still isolated.
const style=document.createElement('style');style.textContent=uiCss;document.head.append(style);
createRoot(document.getElementById('root')!).render(<Library/>);
