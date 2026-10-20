import {renderPreview} from '@english-reader/note-templates';
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReaderLibrary,createLibraryStorage} from './readers';
import type {LibraryStorage} from './readers/types';
import {readerAnchor} from './readers/coordinates';
import {installActivation} from './content/activation';
import {mountReadingPopup,uiCss} from './ui';
import {createReaderPreferenceCache} from './runtime/reader-preferences';
import type {PublicSettings} from '@english-reader/contracts';
import {rpc} from './runtime/rpc-client';
function Library(){
 const [storage,setStorage]=useState<LibraryStorage>(),[error,setError]=useState(''),[status,setStatus]=useState('');
 const preferencesRef=useRef(createReaderPreferenceCache(()=>rpc<Partial<PublicSettings>>('settings.getReader',{})));
 useEffect(()=>{let alive=true;createLibraryStorage().then(value=>{if(alive)setStorage(value);}).catch(()=>{if(alive)setError('Локальная библиотека недоступна. Проверьте свободное место и разрешения браузера.');});const refresh=()=>{void preferencesRef.current.refresh();};refresh();const focus=(event:FocusEvent)=>{if(event.isTrusted)refresh();};window.addEventListener('focus',focus);return()=>{alive=false;preferencesRef.current.invalidate();window.removeEventListener('focus',focus);};},[]);
 if(error)return <p role="alert">{error}</p>;if(!storage)return <p role="status">Открытие локальной библиотеки…</p>;
 return <>{status&&<p role="status">{status}</p>}<ReaderLibrary storage={storage} onDocumentReady={(readerDocument,getSource)=>{
  let close:(()=>void)|undefined;
  const closePopup=()=>{close?.();close=undefined;};
  const stop=installActivation({document:readerDocument,getLocale:()=>preferencesRef.current.getSnapshot().dialect,isPopupEvent:event=>event.composedPath().some(node=>node instanceof HTMLElement&&node.hasAttribute('data-english-reader-popup')),onStatus:failure=>setStatus(failure.message),onActivate:value=>{
   const source=getSource();
   // The PDF document also contains library controls; only its text layer is readable content.
   if(source.kind==='pdf'){const node=value.range.commonAncestorContainer;const element=node.nodeType===1?node as Element:node.parentElement;if(!element?.closest('.textLayer'))return;}
   closePopup();setStatus('');
   const handle=mountReadingPopup({rpc,renderPreview,trustedPage:true,openSettings:()=>chrome.runtime.openOptionsPage(),anchor:()=>readerAnchor(value.range),lookupPayload:{expression:value.expression,context:value.context,...preferencesRef.current.getSnapshot()},source});close=handle.close;
  }});
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')closePopup();};
  const scroll=()=>window.dispatchEvent(new Event('scroll'));
  if(readerDocument!==document){readerDocument.addEventListener('pointerdown',closePopup,true);readerDocument.addEventListener('keydown',key,true);readerDocument.defaultView?.addEventListener('scroll',scroll,true);}
  return()=>{stop();closePopup();readerDocument.removeEventListener('pointerdown',closePopup,true);readerDocument.removeEventListener('keydown',key,true);readerDocument.defaultView?.removeEventListener('scroll',scroll,true);};
 }}/></>;
}
// This is an extension-owned page, not an injected web page. A light-DOM reader
// keeps PDF caret APIs and bundled CSS reliable; the lookup popup is still isolated.
const style=document.createElement('style');style.textContent=uiCss;document.head.append(style);
createRoot(document.getElementById('root')!).render(<Library/>);
