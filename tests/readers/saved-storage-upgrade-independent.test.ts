// @vitest-environment node
import {IDBFactory} from 'fake-indexeddb';
import {describe,expect,it} from 'vitest';
import {openReaderStorage,type ReaderSavedState} from '@english-reader/storage';

describe('independent pre-0.5 database compatibility',()=>{
 it('opens an already-populated raw v1 database and adds optional state without rewriting legacy bytes or records',async()=>{
  const factory=new IDBFactory(),name='independent-reader040-upgrade',id='sha256:'+'a'.repeat(64);
  const oldBlob=new Blob(['%PDF-original-0.4-bytes']);
  const metadata={documentId:id,kind:'pdf' as const,title:'Old.pdf',mimeType:'application/pdf',byteLength:oldBlob.size,createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z'};
  const progress={documentId:id,kind:'pdf',page:9,offset:.375,updatedAt:'2026-10-20T01:00:00.000Z'};
  const operation={operationId:'legacy-outbox',state:'pending',revision:4,fingerprint:'immutable',createdAt:'2026-10-20T01:01:00.000Z',draft:{version:1,source:{kind:'epub',documentId:'older-epub',cfi:'epubcfi(/6/2!/4/2)'}},unknownLegacyField:['preserve','exactly']};
  const seed=await new Promise<IDBDatabase>((resolve,reject)=>{
   const request=factory.open(name,1);request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);
   request.onupgradeneeded=()=>{for(const [store,key] of [['lookupCache','key'],['audioCache','audioId'],['outbox','operationId'],['libraryBooks','documentId'],['readingProgress','documentId'],['metadata','key']])request.result.createObjectStore(store,{keyPath:key});};
  });
  await new Promise<void>((resolve,reject)=>{
   const tx=seed.transaction(['libraryBooks','readingProgress','outbox','metadata'],'readwrite');tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
   tx.objectStore('libraryBooks').put({documentId:id,metadata,blob:oldBlob});tx.objectStore('readingProgress').put(progress);tx.objectStore('outbox').put(operation);tx.objectStore('metadata').put({key:'legacy-extra',value:{unchanged:true}});
  });seed.close();
  const state:ReaderSavedState={version:1,bookmarks:[{id:'mark',label:'Saved after upgrade',kind:'pdf',page:9,offset:.375,createdAt:1}],appearance:{kind:'pdf',zoom:'1.25'}};
  let storage=await openReaderStorage({indexedDB:factory,name});
  try{
   expect(await storage.getReaderState(id)).toBeNull();await storage.saveReaderState(id,state);storage.close();storage=await openReaderStorage({indexedDB:factory,name});
   expect(await storage.getReaderState(id)).toEqual(state);expect(await storage.getProgress(id)).toEqual(progress);expect(await storage.getOperation('legacy-outbox')).toEqual(operation);expect(await storage.getMetadata('legacy-extra')).toEqual({unchanged:true});
   const book=await storage.getBook(id);expect(book?.metadata).toEqual(metadata);expect(await book?.blob.text()).toBe(await oldBlob.text());
  }finally{storage.close();}
 });
});
