import {renderPreview} from '@english-reader/note-templates';
import { installActivation } from './content/activation';
import { mountReadingPopup } from './ui';
import type { PopupHandle } from './ui';
import { rpc } from './runtime/rpc-client';
const guard = '__englishReaderInstalled';
const state = globalThis as typeof globalThis & { __englishReaderInstalled?: boolean };
if (!state[guard]) {
 state[guard] = true;
 let popup: PopupHandle | undefined;
 installActivation({document,
 isPopupEvent: event => event.composedPath().some(node => node instanceof HTMLElement && node.dataset.englishReader === 'popup'),
 onStatus: failure => { const status=document.createElement('div');status.textContent=failure.message;status.setAttribute('role','status');status.style.cssText='position:fixed;bottom:20px;right:20px;background:#172132;color:white;padding:12px;z-index:2147483647;font:14px sans-serif';document.documentElement.append(status);setTimeout(()=>status.remove(),4000); },
 onActivate: async (value) => {
   popup?.close();
   const safe = new URL(location.href); safe.search='';safe.hash='';safe.username='';safe.password='';
   const opts={rpc,renderPreview,anchor:()=>value.range.getBoundingClientRect(),lookupPayload:{expression:value.expression,context:value.context,sourceLanguage:'en' as const,targetLanguage:'ru' as const,learnerLevel:'B1' as const,dialect:'en-US' as const},source:{kind:'html' as const,title:document.title.slice(0,500),url:safe.href,documentId:null,page:null,chapter:null,cfi:null}};
   popup=mountReadingPopup(opts);
 }
 });
}
