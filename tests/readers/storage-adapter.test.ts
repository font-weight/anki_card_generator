// @vitest-environment node
import {afterEach,describe,it,expect} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage,type ReaderStorage} from '@english-reader/storage';
import {adaptLibraryStorage} from '../../apps/extension/src/readers/storage-adapter';
import type {StoredBook} from '../../apps/extension/src/readers/types';
const databases:ReaderStorage[]=[];
afterEach(()=>{databases.splice(0).forEach(db=>db.close());});
async function setup(quota=1e9){const db=await openReaderStorage({indexedDB:new IDBFactory(),quotaEstimator:async()=>({usage:0,quota})});databases.push(db);return{db,adapter:adaptLibraryStorage(db)};}
async function book(kind:'pdf'|'epub'):Promise<StoredBook>{const blob=new Blob([`local-${kind}`]);const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return{documentId:'sha256:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),kind,title:`Книга с пробелами.${kind}`,size:blob.size,addedAt:Date.now(),blob};}
describe('canonical library storage adapter',()=>{
 it('roundtrips book Blob and PDF fractional progress with ISO storage timestamps',async()=>{const{db,adapter}=await setup();const input=await book('pdf');await adapter.putBook(input);const updatedAt=Date.now();await adapter.saveProgress(input.documentId,{page:7,offset:.375,updatedAt});const loaded=(await adapter.getBook(input.documentId))!;expect(loaded.documentId).toBe(input.documentId);expect(await loaded.blob.text()).toBe('local-pdf');expect(loaded.progress).toEqual({page:7,offset:.375,updatedAt});expect((await db.getProgress(input.documentId))?.updatedAt).toBe(new Date(updatedAt).toISOString());expect((await adapter.listBooks())[0]?.title).toBe(input.title);});
 it('roundtrips EPUB chapter/CFI and preserves library through cache pruning',async()=>{const{db,adapter}=await setup();const input=await book('epub');await adapter.putBook(input);const progress={chapter:'Chapter Two',cfi:'epubcfi(/6/4!/4/2/1:10)',updatedAt:Date.now()};await adapter.saveProgress(input.documentId,progress);await db.pruneCaches();expect((await adapter.getBook(input.documentId))?.progress).toEqual(progress);});
 it('deletes book/progress only, preserving durable outbox',async()=>{const{db,adapter}=await setup();const input=await book('pdf');await adapter.putBook(input);await adapter.saveProgress(input.documentId,{page:1,updatedAt:Date.now()});await db.putOperation({operationId:'test-operation',state:'pending',revision:0,fingerprint:'fixed',createdAt:new Date().toISOString()});await adapter.deleteBook(input.documentId);expect(await adapter.getBook(input.documentId)).toBeUndefined();expect(await db.getProgress(input.documentId)).toBeNull();expect(await db.getOperation('test-operation')).not.toBeNull();});
 it('propagates quota failures for explicit session fallback',async()=>{const{adapter}=await setup(1);await expect(adapter.putBook(await book('epub'))).rejects.toMatchObject({code:'STORAGE_QUOTA'});expect(await adapter.listBooks()).toHaveLength(0);});
});
