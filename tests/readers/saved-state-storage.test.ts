// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {DATABASE_VERSION,openReaderStorage,READER_BOOKMARK_LIMIT,READER_STATE_MAX_BYTES,validateReaderSavedState,type ReaderSavedState,type ReaderStorage} from '@english-reader/storage';
import {adaptLibraryStorage} from '../../apps/extension/src/readers/storage-adapter';
const opened:ReaderStorage[]=[];
afterEach(()=>{opened.splice(0).forEach(db=>db.close());});
async function setup(kind:'pdf'|'epub'|'fb2'='pdf',factory=new IDBFactory()){
 const db=await openReaderStorage({indexedDB:factory,name:'reader-state-test'});opened.push(db);
 const blob=new Blob([`original-${kind}`]);
 const book=await db.saveBook({blob,kind,title:`Book.${kind}`,mimeType:kind==='pdf'?'application/pdf':kind==='epub'?'application/epub+zip':'application/x-fictionbook+xml'});
 return {db,book,factory,adapter:adaptLibraryStorage(db)};
}
const state=():ReaderSavedState=>({version:1,bookmarks:[{id:'bookmark-1',label:'Remember here',createdAt:100,kind:'pdf',page:3,offset:.375}],appearance:{kind:'pdf',zoom:'1.25'}});

describe('bounded, backwards-compatible local reader state',()=>{
 it('keeps DB v1 unchanged and leaves optional state absent until an explicit change',async()=>{
  const {db,book,adapter}=await setup();
  expect(DATABASE_VERSION).toBe(1);expect(await db.getReaderState(book.documentId)).toBeNull();
  expect(await adapter.getReaderState!(book.documentId)).toBeUndefined();
  expect((await adapter.getBook(book.documentId))?.title).toBe('Book.pdf');
  expect(await db.getMetadata('reader-state:'+book.documentId)).toBeNull();
 });
 it('roundtrips independent snapshots through the adapter and durable reopen',async()=>{
  const {db,book,adapter,factory}=await setup();const input=state();
  await adapter.saveReaderState!(book.documentId,input);input.bookmarks[0]!.label='Changed caller data';
  const loaded=(await adapter.getReaderState!(book.documentId))!;expect(loaded).toEqual(state());
  loaded.bookmarks.length=0;expect(await db.getReaderState(book.documentId)).toEqual(state());
  db.close();const reopened=await openReaderStorage({indexedDB:factory,name:'reader-state-test'});opened.push(reopened);
  expect(await reopened.getReaderState(book.documentId)).toEqual(state());
 });
 it.each(['epub','fb2'] as const)('uses original %s document identity, CFI and existing appearance values',async kind=>{
  const {db,book}=await setup(kind);
  const value:ReaderSavedState={version:1,bookmarks:[{id:'cfi-1',label:'第二章',createdAt:125,kind,cfi:'epubcfi(/6/4!/4/2/1:5)',chapter:'第二章'}],appearance:{kind,fontSize:24,theme:'dark',width:'wide',lineHeight:1.5}};
  await db.saveReaderState(book.documentId,value);expect(await db.getReaderState(book.documentId)).toEqual(value);
  expect(await (await db.getBook(book.documentId))!.blob.text()).toBe(`original-${kind}`);
 });
 it('never rewrites book bytes/metadata, reading progress or Anki records when changing reader state',async()=>{
  const {db,book}=await setup();
  const progress={documentId:book.documentId,kind:'pdf' as const,page:7,offset:.8,updatedAt:'2026-10-21T00:00:00.000Z'};
  const operation={operationId:'anki-pending',state:'pending' as const,revision:3,fingerprint:'old-fingerprint',createdAt:'2026-10-20T00:00:00.000Z',draft:{version:1,source:{page:1}}};
  await db.saveProgress(progress);await db.putOperation(operation);const original=await db.getBook(book.documentId);
  await db.saveReaderState(book.documentId,state());await db.pruneCaches();
  expect(await db.getProgress(book.documentId)).toEqual(progress);expect(await db.getOperation(operation.operationId)).toEqual(operation);
  expect((await db.getBook(book.documentId))?.metadata).toEqual(original?.metadata);
  expect(await (await db.getBook(book.documentId))!.blob.text()).toBe('original-pdf');
  expect(await db.getReaderState(book.documentId)).toEqual(state());
 });
 it('deletes all reader state atomically without touching another document or Anki',async()=>{
  const {db,book}=await setup();const other=await db.saveBook({blob:new Blob(['other']),kind:'pdf',title:'Other',mimeType:'application/pdf'});
  await db.saveReaderState(book.documentId,state());await db.saveReaderState(other.documentId,state());
  await db.saveProgress({documentId:book.documentId,kind:'pdf',page:1,offset:0,updatedAt:'2026-10-21T00:00:00Z'});
  await db.putOperation({operationId:'keep',state:'pending',revision:0,fingerprint:'same',createdAt:'today'});
  await db.deleteBook(book.documentId);
  expect(await db.getBook(book.documentId)).toBeNull();expect(await db.getProgress(book.documentId)).toBeNull();
  expect(await db.getMetadata('reader-state:'+book.documentId)).toBeNull();expect(await db.getReaderState(other.documentId)).toEqual(state());expect(await db.getOperation('keep')).not.toBeNull();
 });
 it('serializes a pending saved-state write before deletion, and rejects late orphan writes',async()=>{
  const {db,book}=await setup();
  await Promise.all([db.saveReaderState(book.documentId,state()),db.deleteBook(book.documentId)]);
  expect(await db.getMetadata('reader-state:'+book.documentId)).toBeNull();
  await expect(db.saveReaderState(book.documentId,state())).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(await db.getMetadata('reader-state:'+book.documentId)).toBeNull();
 });
 it('rejects a save queued after deletion before it can resurrect metadata',async()=>{
  const {db,book}=await setup();
  const results=await Promise.allSettled([db.deleteBook(book.documentId),db.saveReaderState(book.documentId,state())]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
  expect(await db.getMetadata('reader-state:'+book.documentId)).toBeNull();
 });
 it('rejects invalid state without replacing the previous good state',async()=>{
  const {db,book}=await setup();await db.saveReaderState(book.documentId,state());
  const invalid:unknown[]=[
   {...state(),version:2}, {...state(),unexpected:'never store'}, {...state(),bookmarks:Array.from({length:READER_BOOKMARK_LIMIT+1},(_,i)=>({...state().bookmarks[0],id:String(i)}))},
   {...state(),bookmarks:[state().bookmarks[0],state().bookmarks[0]]},
   ...[-1,NaN,Infinity,8640000000000001].map(createdAt=>({...state(),bookmarks:[{...state().bookmarks[0],createdAt}]})),
   ...[0,-1,1.5,Infinity].map(page=>({...state(),bookmarks:[{...state().bookmarks[0],page}]})),
   ...[-.1,1.1,NaN].map(offset=>({...state(),bookmarks:[{...state().bookmarks[0],offset}]})),
   {...state(),bookmarks:[{...state().bookmarks[0],id:'x'.repeat(129)}]}, {...state(),bookmarks:[{...state().bookmarks[0],label:' '.repeat(2)}]},
   {...state(),bookmarks:[{...state().bookmarks[0],label:'x'.repeat(201)}]}, {...state(),appearance:{kind:'pdf',zoom:'javascript:evil'}},
   {...state(),appearance:{kind:'epub',fontSize:20,theme:'light',width:'wide',lineHeight:1.5}},
  ];
  for(const value of invalid){await expect(db.saveReaderState(book.documentId,value as ReaderSavedState)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(await db.getReaderState(book.documentId)).toEqual(state());}
 });
 it('bounds per-record bytes in addition to item/string lengths and blocks URLs as CFI',()=>{
  const value:ReaderSavedState={version:1,bookmarks:Array.from({length:200},(_,i)=>({id:String(i),label:'記'.repeat(200),createdAt:0,kind:'epub',cfi:'epubcfi('+'文'.repeat(2000)+')',chapter:'章'.repeat(500)}))};
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(READER_STATE_MAX_BYTES);
  expect(()=>validateReaderSavedState(value,'epub')).toThrow();
  expect(()=>validateReaderSavedState({...value,bookmarks:[{...value.bookmarks[0],cfi:'https://example.com/chapter'}]},'epub')).toThrow();
 });
 it('reports corrupt optional state rather than silently rewriting it or breaking ordinary book reads',async()=>{
  const {db,book,adapter}=await setup();const corrupt={version:99,bookmarks:'unknown future format'};
  await db.setMetadata('reader-state:'+book.documentId,corrupt);
  await expect(adapter.getReaderState!(book.documentId)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect((await adapter.getBook(book.documentId))?.documentId).toBe(book.documentId);expect(await db.getMetadata('reader-state:'+book.documentId)).toEqual(corrupt);
 });
});
