// @vitest-environment jsdom
/** Independent reader0.4 regression probes. No real providers or browser trust bypass. */
import {Blob as NodeBlob} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {strFromU8} from 'fflate';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {openReaderStorage, type ReaderStorage} from '@english-reader/storage';
import {validateNoteDraft} from '@english-reader/contracts';
import {buildNoteFields, escapeAnkiText} from '@english-reader/note-templates';
import {convertFb2ToEpub, FB2_LIMITS} from '../../apps/extension/src/readers/fb2';
import {extractBounded} from '../../apps/extension/src/readers/archive';
import {prepareSafeEpub} from '../../apps/extension/src/readers/epub-security';
import {adaptLibraryStorage} from '../../apps/extension/src/readers/storage-adapter';
import {fullMeaningsDraft, legacyDraft, multilingualDraft, operationId} from '../fixtures/full-meaning-drafts';

const databases:ReaderStorage[] = [];
beforeEach(() => {
 vi.stubGlobal('Blob', NodeBlob);
 vi.stubGlobal('crypto', webcrypto);
 vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network permitted during local reader audit'); }));
});
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); });
const xml = (text:string) => new DOMParser().parseFromString(text, 'application/xml');
const envelope = (body:string) => `<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">${body}</FictionBook>`;
async function converted(source:string) {
 const result = await convertFb2ToEpub(new Blob([source]));
 const bytes = new Uint8Array(await result.blob.arrayBuffer());
 return {...result, bytes, files:extractBounded(bytes)};
}

describe('independent reader upgrade audit', () => {
 it('retains cross-body note links and exact multi-script parsed text through both sanitizers', async () => {
  const source = envelope('<body><section id="chapter"><title><p>Chapter</p></title><p>  read\tread e\u0301 😀 العربية 中文 \u2067אב\u2069 &amp; &#160;<emphasis> tail </emphasis></p><p><a l:href="#note">[1]</a></p></section></body><body name="notes"><section id="note"><p>Original note.</p></section></body>');
  const expected = xml(source).querySelector('section > p')!.textContent;
  const {files} = await converted(source);
  const safe = prepareSafeEpub(files);
  try {
   const cleaned = extractBounded(new Uint8Array(safe.data));
   const chapter = xml(strFromU8(cleaned['OPS/chapter-1.xhtml']));
   expect(chapter.querySelector('section > p')?.textContent).toBe(expected);
   const link = chapter.querySelector('a')!.getAttribute('href')!;
   const [path, id] = link.split('#');
   expect(xml(strFromU8(cleaned[`OPS/${path}`])).getElementById(id)?.textContent).toBe('Original note.');
   expect(fetch).not.toHaveBeenCalled();
  } finally { safe.dispose(); }
 });

 it('rejects DTD in BOM UTF-16 and cumulative attachments before any network', async () => {
  const hostile = '<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "file:///private/test">]>' + envelope('<body><p>&x;</p></body>');
  const utf16 = new Uint8Array(hostile.length * 2 + 2), view = new DataView(utf16.buffer);
  view.setUint16(0, 0xfeff, true);
  for (let i = 0; i < hostile.length; i++) view.setUint16(i * 2 + 2, hostile.charCodeAt(i), true);
  await expect(convertFb2ToEpub(utf16.buffer)).rejects.toThrow(/DTD|entities/);
  const attachment = 'A'.repeat(FB2_LIMITS.attachmentCharacters);
  await expect(convertFb2ToEpub(new Blob([envelope('<body><p>Text.</p></body>' + Array.from({length:5}, (_, i) => `<binary id="b${i}">${attachment}</binary>`).join(''))]))).rejects.toThrow(/размер вложений/);
  expect(fetch).not.toHaveBeenCalled();
 });

 it('uses the original FB2 bytes and kind as durable identity, not the ephemeral EPUB bytes', async () => {
  const source = envelope('<body><section id="a"><p>Read original bytes.</p></section></body>');
  const blob = new Blob([source], {type:'application/x-fictionbook+xml'});
  const db = await openReaderStorage({indexedDB:new IDBFactory()}); databases.push(db);
  const metadata = await db.saveBook({blob, kind:'fb2', title:'Book.fb2', mimeType:blob.type});
  const adapter = adaptLibraryStorage(db);
  const progress = {cfi:'epubcfi(/6/2!/4/2/1:5)', chapter:'Chapter', updatedAt:Date.now()};
  await adapter.saveProgress(metadata.documentId, progress);
  const first = await converted(source), second = await converted(source);
  expect(first.bytes).toEqual(second.bytes);
  const originalHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', await blob.arrayBuffer())).toString('hex');
  const convertedHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', first.bytes)).toString('hex');
  expect(metadata.documentId).toBe(`sha256:${originalHash}`);
  expect(metadata.documentId).not.toBe(`sha256:${convertedHash}`);
  const loaded = (await adapter.getBook(metadata.documentId))!;
  expect(loaded.kind).toBe('fb2'); expect(await loaded.blob.text()).toBe(source);
  expect(loaded.progress).toEqual(progress);
  expect(await db.getProgress(metadata.documentId)).toMatchObject({kind:'fb2', cfi:progress.cfi});
  expect((await adapter.listBooks())[0].kind).toBe('fb2');
  expect(fetch).not.toHaveBeenCalled();
 });

 it('does not mutate v1/v2 draft serialization or old EPUB source field presentation', () => {
  for (const draft of [legacyDraft(), multilingualDraft()]) {
   draft.source = {kind:'epub', title:'Original', url:null, documentId:'sha256:' + 'a'.repeat(64), page:null, chapter:'Chapter 2', cfi:'epubcfi(/6/4!/4/2/1:2)'};
   const serialized = JSON.stringify(draft);
   expect(validateNoteDraft(draft)).toBe(draft);
   const fields = buildNoteFields(operationId, draft, {lexemeKey:'lexeme', contentKey:'content'});
   expect(fields.SourceLocation).toBe(`Chapter 2 · ${escapeAnkiText(draft.source.cfi!)}`);
   expect(fields.SourceLocation).not.toContain('FB2');
   expect(JSON.stringify(draft)).toBe(serialized);
  }
 });

 it('marks FB2 notes as original-local provenance and rejects URLs without changing legacy validation', () => {
  const draft = fullMeaningsDraft();
  draft.source = {kind:'fb2', title:'Original.fb2', url:null, documentId:'sha256:' + 'b'.repeat(64), page:null, chapter:'Notes', cfi:'epubcfi(/6/2!/4/2/1:8)'};
  expect(validateNoteDraft(draft)).toBe(draft);
  expect(buildNoteFields(operationId, draft, {lexemeKey:'lexeme', contentKey:'content'}).SourceLocation).toBe(`FB2 · Notes · ${escapeAnkiText(draft.source.cfi!)}`);
  expect(() => validateNoteDraft({...draft, source:{...draft.source, url:'https://example.com/book'}})).toThrow();
  expect(() => validateNoteDraft({...draft, source:{...draft.source, page:1}})).toThrow();
 });
});
