import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {Blob as NodeBlob, File as NodeFile} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {openReaderStorage, type ReaderStorage} from '@english-reader/storage';
import {adaptLibraryStorage} from '../../apps/extension/src/readers/storage-adapter';
import {ReaderLibrary} from '../../apps/extension/src/readers/ReaderLibrary';
import type {ReaderBookInfo} from '../../apps/extension/src/readers/types';

type ReaderProps = {onBookInfo:(info:ReaderBookInfo)=>void; onBack:()=>void};
const state = vi.hoisted(() => ({reader:undefined as ReaderProps|undefined}));
// Supply metadata at the reader's callback boundary. Import, hashing, the
// adapter, validation, transactions and library listing all run normally.
vi.mock('../../apps/extension/src/readers/EpubReader', () => ({EpubReader:(props:ReaderProps) => {state.reader=props; return null;}}));
vi.mock('../../apps/extension/src/readers/PdfReader', () => ({PdfReader:(props:ReaderProps) => {state.reader=props; return null;}}));
let host:HTMLDivElement, root:ReturnType<typeof createRoot>, db:ReaderStorage, adapter:ReturnType<typeof adaptLibraryStorage>;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('crypto', webcrypto);
  db=await openReaderStorage({indexedDB:new IDBFactory()});
  adapter=adaptLibraryStorage(db);
  host=document.createElement('div'); document.body.append(host); root=createRoot(host); state.reader=undefined;
  await act(async () => root.render(<ReaderLibrary storage={adapter}/>));
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); db.close(); vi.unstubAllGlobals();});

async function importBook(kind:'epub'|'pdf') {
  const path = kind === 'epub' ? 'Книга с пробелами.epub' : 'Текст PDF.pdf';
  const bytes = await readFile('tests/readers/fixtures/'+path);
  const file = new NodeFile([bytes], 'imported.'+kind, {type:kind === 'epub' ? 'application/epub+zip' : 'application/pdf'});
  const input=host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async () => {input.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async () => {
    await vi.waitFor(async () => expect(await db.listBooks()).toHaveLength(1));
  });
  // act flushes the render that follows the IndexedDB hydration.
  await vi.waitFor(() => expect(state.reader).toBeDefined());
  return (await db.listBooks())[0]!.documentId;
}
const report = (info:ReaderBookInfo) => act(async () => state.reader!.onBookInfo(info));

it.each(['epub','pdf'] as const)('imports a title-only %s and preserves authors on subsequent title changes', async kind => {
  const id=await importBook(kind);
  const write=vi.spyOn(adapter,'updateBookInfo');
  await report({title:'The Real Title',author:undefined});
  await vi.waitFor(async () => expect((await db.getBook(id))?.metadata.title).toBe('The Real Title'));
  expect((await db.getBook(id))?.metadata).not.toHaveProperty('author');
  expect(write).toHaveBeenCalledWith(id,{title:'The Real Title'});
  await report({title:'The Real Title'});
  expect(write).toHaveBeenCalledTimes(1);
  await report({author:'Eleanor Vale'});
  await vi.waitFor(async () => expect((await db.getBook(id))?.metadata.author).toBe('Eleanor Vale'));
  await report({title:'A New Title',author:' '});
  await vi.waitFor(async () => expect((await db.getBook(id))?.metadata).toMatchObject({title:'A New Title',author:'Eleanor Vale'}));
  expect(write).toHaveBeenLastCalledWith(id,{title:'A New Title'});
  await act(async () => state.reader!.onBack());
  await act(async () => {await vi.waitFor(() => expect(host.textContent).toContain('Eleanor Vale'));});
  expect(host.textContent).toContain('A New Title'); expect(host.querySelector('[role=alert]')).toBeNull();
});

it('retries identical metadata after a failed persistence attempt without clearing an author from another tab',async () => {
  const id=await importBook('epub');
  await db.updateBookInfo(id,{author:'Previously saved'});
  const write=vi.spyOn(adapter,'updateBookInfo').mockRejectedValueOnce(new Error('temporary write failure'));
  await report({title:'Recovered Title'});
  expect(host.querySelector('[role=alert]')?.textContent).toContain('temporary write failure');
  await report({title:'Recovered Title'});
  await act(async () => {
    await vi.waitFor(async () => expect((await db.getBook(id))?.metadata).toMatchObject({title:'Recovered Title',author:'Previously saved'}));
  });
  expect(write).toHaveBeenCalledTimes(2); expect(host.querySelector('[role=alert]')).toBeNull();
});
