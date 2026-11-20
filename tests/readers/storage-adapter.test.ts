// @vitest-environment node
import {afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
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
 it('backfills absent cover metadata without touching the source, progress, or bookmarks and deletes it with the book',async()=>{
  const {db,adapter}=await setup(),input=await book('epub');
  await adapter.putBook(input);
  await db.updateBookInfo(input.documentId,{title:'Previous title',author:'Previous author'});
  await adapter.saveProgress(input.documentId,{chapter:'Chapter 2',cfi:'epubcfi(/6/4)',percent:45,updatedAt:1000});
  await db.saveReaderState(input.documentId,{version:1,bookmarks:[]});
  const initial=await db.getBook(input.documentId),progress=await db.getProgress(input.documentId),state=await db.getReaderState(input.documentId);
  const cover='data:image/png;base64,'+readFileSync('tests/fixtures/quiet-coast-cover.png').toString('base64');
  expect(await db.getBookThumbnail(input.documentId)).toBeUndefined();
  await db.saveBookThumbnail(input.documentId,cover);
  expect(await adapter.loadBookThumbnail!(input.documentId,new AbortController().signal)).toBe(cover);
  const now=await db.getBook(input.documentId);
  expect(now!.metadata).toEqual(initial!.metadata);expect(await now!.blob.text()).toBe(await initial!.blob.text());
  expect(await db.getProgress(input.documentId)).toEqual(progress);expect(await db.getReaderState(input.documentId)).toEqual(state);
  await expect(db.saveBookThumbnail(input.documentId,'https://example.invalid/cover')).rejects.toThrow();
  await adapter.deleteBook(input.documentId);await db.saveBookThumbnail(input.documentId,cover);
  expect(await db.getBookThumbnail(input.documentId)).toBeUndefined();
 });
 it('skips cancelled backfill jobs and records completed checks with no image',async()=>{
  const {db,adapter}=await setup(),input=await book('epub');
  await adapter.putBook(input);const signal=AbortSignal.abort();
  expect(await adapter.loadBookThumbnail!(input.documentId,signal)).toBeNull();
  expect(await db.getBookThumbnail(input.documentId)).toBeUndefined();
  await db.saveBookThumbnail(input.documentId,null);
  expect(await adapter.loadBookThumbnail!(input.documentId,new AbortController().signal)).toBeNull();
  expect(await db.getBookThumbnail(input.documentId)).toBeNull();
 });
 it('propagates quota failures for explicit session fallback',async()=>{const{adapter}=await setup(1);await expect(adapter.putBook(await book('epub'))).rejects.toMatchObject({code:'STORAGE_QUOTA'});expect(await adapter.listBooks()).toHaveLength(0);});
});


it('starts only one backfill job at once and drops a queued offscreen book before any storage read',async()=>{
 const {db,adapter}=await setup();
 let release!:(cover:null)=>void;
 const reading=new Promise<null>(resolve=>{release=resolve;});
 const read=vi.spyOn(db,'getBookThumbnail').mockImplementationOnce(()=>reading).mockResolvedValue(null);
 const first=adapter.loadBookThumbnail!('visible',new AbortController().signal);
 const controller=new AbortController();
 const second=adapter.loadBookThumbnail!('scrolled-away',controller.signal);
 const third=adapter.loadBookThumbnail!('next-visible',new AbortController().signal);
 await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));controller.abort();release(null);
 await Promise.all([first,second,third]);
 expect(read.mock.calls).toEqual([['visible'],['next-visible']]);
});
