import {renderPreview} from '@english-reader/note-templates';
import { installActivation, isReadingPopupEvent } from './content/activation';
import { mountReadingPopup, getActiveReadingSelection } from './ui';
import type { PopupHandle } from './ui';
import {createReaderPreferenceCache} from './runtime/reader-preferences';
import type {PublicSettings} from '@english-reader/contracts';
import { rpc } from './runtime/rpc-client';
const guard = '__englishReaderInstalled';
const state = globalThis as typeof globalThis & { __englishReaderInstalled?: boolean };
if (!state[guard]) {
 state[guard] = true;
 let popup: PopupHandle | undefined;
 const preferences = createReaderPreferenceCache(() => rpc<Partial<PublicSettings>>('settings.getReader'));
 const refreshPreferences = () => { void preferences.refresh(); };
 refreshPreferences();
 window.addEventListener('focus', event => { if (event.isTrusted) refreshPreferences(); });
 installActivation({document,getLocale:()=>preferences.getSnapshot().dialect,
 isPopupEvent: isReadingPopupEvent, getActiveSelection: getActiveReadingSelection,
 onStatus: failure => { const status=document.createElement('div');status.textContent=failure.message;status.setAttribute('role','status');status.style.cssText='position:fixed;bottom:20px;right:20px;background:#172132;color:white;padding:12px;z-index:2147483647;font:14px sans-serif';document.documentElement.append(status);setTimeout(()=>status.remove(),4000); },
 onActivate: (value) => {
   popup?.close();
   const safe = new URL(location.href); safe.search='';safe.hash='';safe.username='';safe.password='';
   const opts={rpc,renderPreview,openSettings:async()=>{const r=await chrome.runtime.sendMessage({hostType:'settings.open'});if(!r?.ok)throw Error('Не удалось открыть настройки.');},selectionRange:value.range,anchor:()=>value.range.startContainer.isConnected&&value.range.endContainer.isConnected&&!value.range.collapsed?value.range.getBoundingClientRect():null,lookupPayload:{expression:value.expression,context:value.context,...preferences.getSnapshot()},source:{kind:'html' as const,title:document.title.slice(0,500),url:safe.href,documentId:null,page:null,chapter:null,cfi:null}};
   popup=mountReadingPopup(opts);
 }
 });
}
