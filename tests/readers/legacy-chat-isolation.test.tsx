import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {webcrypto} from 'node:crypto';
import {Blob as NodeBlob} from 'node:buffer';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {afterEach,expect,it,vi} from 'vitest';
import {openReaderStorage,type ReaderStorage} from '@english-reader/storage';
import {ReaderLibrary} from '../../apps/extension/src/readers/ReaderLibrary';
import {ReaderGrammarConsent} from '../../apps/extension/src/readers/ReaderChrome';
import {adaptLibraryStorage} from '../../apps/extension/src/readers/storage-adapter';

// Only the native PDF worker and page geometry need a stand-in for this reader route.
const {getDocument,rpc}=vi.hoisted(()=>({getDocument:vi.fn(()=>({promise:Promise.resolve({numPages:4})})),rpc:vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({getDocument,TextLayer:class {}}));
vi.mock('../../apps/extension/src/readers/pdf-worker',()=>({
 createLocalPdfWorker:()=>({worker:{},port:new EventTarget()}),disposePdfLoading:()=>{},
}));
vi.mock('../../apps/extension/src/runtime/rpc-client',()=>({rpc}));
vi.mock('../../apps/extension/src/readers/EpubReader',()=>({EpubReader:()=>null}));

let database:ReaderStorage,root:ReturnType<typeof createRoot>|undefined;
const host=document.createElement('div');
afterEach(async()=>{
 await act(async()=>root?.unmount());root=undefined;
 host.remove();database?.close();vi.unstubAllGlobals();
});

it('opens a saved book with its reading position while leaving all r2 transcript metadata unread and intact',async()=>{
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const broadcast=vi.fn();vi.stubGlobal('BroadcastChannel',broadcast);
 vi.stubGlobal('ResizeObserver',class {observe() {} disconnect() {}});
 vi.stubGlobal('IntersectionObserver',class {observe() {} disconnect() {}});
 const fetch=vi.fn(()=>{throw new Error('Unexpected network call');});vi.stubGlobal('fetch',fetch);
 const indexedDB=new IDBFactory();
 database=await openReaderStorage({indexedDB});
 const first=await database.saveBook({kind:'pdf',title:'Northern Line',mimeType:'application/pdf',blob:new Blob(['synthetic north'])});
 // Write the r2 record format directly without depending on a legacy API.
 const turn={turnId:crypto.randomUUID(),kind:'answer',question:'When is the train due?',answer:'It leaves on time.',language:'en'};
 const header={generation:crypto.randomUUID(),entries:[{id:turn.turnId,units:turn.question.length+turn.answer.length}]};
 const key='book-chat-v1:'+first.documentId;
 await database.setMetadata(key,header);
 await database.setMetadata(key+':'+turn.turnId,turn);
 await database.saveProgress({documentId:first.documentId,kind:'pdf',page:3,offset:.25,updatedAt:new Date().toISOString()});
 database.close();
 const get=vi.spyOn(IDBObjectStore.prototype,'get');
 const bulkReads=(['getAll','getAllKeys','openCursor','openKeyCursor'] as const).map(method=>vi.spyOn(IDBObjectStore.prototype,method));
 database=await openReaderStorage({indexedDB});
 const storage=adaptLibraryStorage(database),ready=vi.fn();
 expect(storage).not.toHaveProperty('bookChatHistory');
 document.body.append(host);root=createRoot(host);
 const render=(enabled:boolean)=>act(async()=>root!.render(<ReaderGrammarConsent.Provider value={enabled}><ReaderLibrary storage={storage} onDocumentReady={ready}/></ReaderGrammarConsent.Provider>));
 await render(false);
 function button(label:string){
  const item=[...host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent?.trim()===label);
  if(!item)throw new Error('Button not found: '+label);return item;
 }
 // IndexedDB completes transactions on separate tasks. Flush React commits
 // before checking another stage of the user journey.
 async function eventually(check:()=>void){
  await vi.waitFor(async()=>{await act(()=>new Promise<void>(done=>setTimeout(done,5)));check();});
 }
 async function click(label:string){await act(async()=>{button(label).click();await new Promise<void>(done=>setTimeout(done,5));});}
 await eventually(()=>expect(host.textContent).toContain('Продолжить чтение'));
 await click('Продолжить чтение');
 await eventually(()=>expect(host.textContent).toContain('Страница 3 из 4'));
 const canvas=host.querySelector('.er-pdf-reader');
 expect(ready.mock.calls[0]).toHaveLength(2);
 await click('Вид');
 expect(host.textContent).toContain('Выключено в настройках.');
 for(const enabled of [false,true]){
  await render(enabled);
  expect(host.textContent).toContain('Вид и подсказки');
  expect(host.textContent).not.toContain('История чата книги');
  expect(host.textContent).not.toContain(turn.answer);
 }
 await click('Закрыть панель');
 expect(document.activeElement).toBe(button('Вид'));
 expect(host.querySelector('.er-pdf-reader')).toBe(canvas);
 expect(host.textContent).toContain('Страница 3 из 4');
 expect(getDocument).toHaveBeenCalledTimes(1);
 await click('Библиотека');
 await eventually(()=>expect(host.textContent).toContain('Продолжить чтение'));
 expect(get).toHaveBeenCalledWith('reader-state:'+first.documentId);
 expect(get.mock.calls.some(([queried])=>String(queried).startsWith('book-chat-v1:'))).toBe(false);
 for(const bulk of bulkReads)expect(bulk.mock.contexts.some(store=>store instanceof IDBObjectStore&&store.name==='metadata')).toBe(false);
 expect(broadcast).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 expect(await database.getMetadata(key)).toEqual(header);
 expect(await database.getMetadata(key+':'+turn.turnId)).toEqual(turn);
});
