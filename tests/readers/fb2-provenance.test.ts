// @vitest-environment node
import {afterEach, describe, it, expect} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage, type ReaderStorage} from '../../packages/storage/src/index';
import {validateNoteDraft, type Source} from '../../packages/contracts/src/index';
import {buildNoteFields} from '../../packages/note-templates/src/index';
import {adaptLibraryStorage} from '../../apps/extension/src/readers/storage-adapter';
import {legacyDraft, multilingualDraft, fullMeaningsDraft, operationId} from '../fixtures/full-meaning-drafts';
const databases: ReaderStorage[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
const source: Source = {kind:'fb2',title:'My book.fb2',url:null,documentId:'sha256:' + 'a'.repeat(64),page:null,chapter:'Глава 2',cfi:'epubcfi(/6/4!/4/2/1:10)'};
async function setup() {const db = await openReaderStorage({indexedDB:new IDBFactory()});databases.push(db);return {db,adapter:adaptLibraryStorage(db)};}

describe('FB2 original provenance, storage and card source contracts', () => {
 it('roundtrips original FB2 bytes, hash, MIME and chapter/CFI without converting the stored kind', async () => {
  const {db,adapter} = await setup();const original = new Blob(['<?xml version="1.0"?><FictionBook><body><p>Text.</p></body></FictionBook>'],{type:'application/x-fictionbook+xml'});
  const digest = await crypto.subtle.digest('SHA-256',await original.arrayBuffer());
  const documentId = 'sha256:' + Buffer.from(digest).toString('hex');
  await adapter.putBook({documentId,kind:'fb2',title:source.title,size:original.size,addedAt:Date.now(),blob:original});
  const progress = {chapter:source.chapter!,cfi:source.cfi!,updatedAt:Date.now()};
  await adapter.saveProgress(documentId,progress);
  expect((await db.getBook(documentId))?.metadata).toMatchObject({documentId,kind:'fb2',mimeType:'application/x-fictionbook+xml',byteLength:original.size});
  expect((await db.getProgress(documentId))?.kind).toBe('fb2');
  const loaded = (await adapter.getBook(documentId))!;
  expect(loaded.progress).toEqual(progress);expect(loaded.kind).toBe('fb2');expect(await loaded.blob.arrayBuffer()).toEqual(await original.arrayBuffer());
  await db.pruneCaches();expect(await adapter.listBooks()).toHaveLength(1);
 });
 it('rejects an EPUB MIME for FB2 and mismatched progress without overwriting original progress', async () => {
  const {db} = await setup();const blob = new Blob(['original fb2']);
  await expect(db.saveBook({blob,kind:'fb2',title:'FB2',mimeType:'application/epub+zip'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const book = await db.saveBook({blob,kind:'fb2',title:'FB2',mimeType:'application/x-fictionbook+xml'});
  const progress = {documentId:book.documentId,kind:'fb2' as const,chapter:'Chapter',cfi:'epubcfi(/6/2)',updatedAt:new Date().toISOString()};
  await db.saveProgress(progress);
  await expect(db.saveProgress({...progress,kind:'epub'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(db.saveProgress({...progress,cfi:''})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(db.saveBook({blob,kind:'epub',title:'EPUB',mimeType:'application/epub+zip'})).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
  expect(await db.getProgress(book.documentId)).toEqual(progress);
 });
 it.each([legacyDraft,multilingualDraft,fullMeaningsDraft])('validates FB2 source through all draft versions and identifies its format in the generated card', factory => {
  const draft = factory();draft.source = {...source};
  const snapshot = JSON.stringify(draft);
  expect(validateNoteDraft(draft)).toBe(draft);
  const fields = buildNoteFields(operationId,draft,{lexemeKey:'lexical',contentKey:'context'});
  expect(fields.SourceTitle).toBe('My book.fb2');expect(fields.SourceURL).toBe('');
  expect(fields.SourceLocation).toBe('FB2 · Глава 2 · epubcfi(/6/4!/4/2/1&#58;10)');
  expect(fields.SourceLocation).not.toContain('Страница');expect(JSON.stringify(draft)).toBe(snapshot);
 });
 it.each([{documentId:null},{page:1},{url:'https://example.com/book.fb2'},{cfi:''},{kind:'fb2.zip'}])('rejects invalid local FB2 source %o', patch => {
  const draft = {...fullMeaningsDraft(),source:{...source,...patch}};expect(() => validateNoteDraft(draft)).toThrow();
 });
 it('continues to accept old PDF/EPUB source snapshots and leaves their card fields byte-for-byte unchanged', () => {
  const legacy = legacyDraft();
  for (const [oldSource,location] of [[{...source,kind:'epub',title:'EPUB'},'Глава 2 · epubcfi(/6/4!/4/2/1&#58;10)'],[{...source,kind:'pdf',title:'PDF',page:3,chapter:null,cfi:null},'Страница 3']] as const) {
   legacy.source = {...oldSource};const before = JSON.stringify(legacy.source);
   expect(validateNoteDraft(legacy)).toBe(legacy);
   const fields = buildNoteFields(operationId,legacy,{lexemeKey:'lexical',contentKey:'context'});
   expect(fields.SourceLocation).toBe(location);expect(JSON.stringify(legacy.source)).toBe(before);
  }
 });
 it('deleting FB2 does not change queued drafts or older queue records', async () => {
  const {db,adapter} = await setup();const draft = {...fullMeaningsDraft(),source:{...source}};
  const book = await db.saveBook({blob:new Blob(['FB2 book']),kind:'fb2',title:'Book',mimeType:'application/x-fictionbook+xml'});
  const operation = {operationId,state:'pending' as const,revision:0,fingerprint:'unchanged',createdAt:new Date().toISOString(),draft};
  await db.createOperation(operation);await adapter.deleteBook(book.documentId);
  expect(await db.getOperation(operationId)).toEqual(operation);
 });
});
