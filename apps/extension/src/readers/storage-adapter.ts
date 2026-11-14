import {storageOptions} from '../runtime/storage-config';
import {openReaderStorage,type ReaderStorage} from '@english-reader/storage';
import type {LibraryBook,LibraryStorage,ReadingProgress} from './types';
/** Direct trusted-page storage access. Blob data never traverses Chrome runtime RPC. */
export function adaptLibraryStorage(storage:ReaderStorage):LibraryStorage {
 type Metadata=Awaited<ReturnType<ReaderStorage['listBooks']>>[number];
 const timestamp=(value:string|number)=>typeof value==='number'?value:Date.parse(value);
 const metadata=(m:Metadata,progress?:ReadingProgress):LibraryBook=>({documentId:m.documentId,title:m.title,kind:m.kind,size:m.byteLength,addedAt:timestamp(m.createdAt),progress});
 const progress=async(id:string):Promise<ReadingProgress|undefined>=>{const p=await storage.getProgress(id);if(!p)return undefined;return p.kind==='pdf'?{page:p.page,offset:p.offset,updatedAt:timestamp(p.updatedAt)}:{cfi:p.cfi,chapter:p.chapter??undefined,updatedAt:timestamp(p.updatedAt)};};
 return {
  async listBooks(){return Promise.all((await storage.listBooks()).map(async m=>metadata(m,await progress(m.documentId))));},
  async getBook(id){const book=await storage.getBook(id);return book?{...metadata(book.metadata,await progress(id)),blob:book.blob}:undefined;},
  async putBook(book){const saved=await storage.saveBook({blob:book.blob,kind:book.kind,title:book.title.slice(0,500),mimeType:book.kind==='pdf'?'application/pdf':book.kind==='fb2'?'application/x-fictionbook+xml':'application/epub+zip'});if(saved.documentId!==book.documentId)throw new Error('Отпечаток книги не совпал с хранилищем');},
  deleteBook:id=>storage.deleteBook(id),
  async getReaderState(id){return (await storage.getReaderState(id))??undefined;},
  saveReaderState:(id,state)=>storage.saveReaderState(id,state),
  async saveProgress(documentId,p){if(p.page!==undefined)await storage.saveProgress({documentId,kind:'pdf',page:p.page,offset:p.offset??0,updatedAt:new Date(p.updatedAt).toISOString()});else if(p.cfi){const book=await storage.getBook(documentId);if(!book||book.metadata.kind==='pdf')throw new Error('Книга для сохранения позиции не найдена');await storage.saveProgress({documentId,kind:book.metadata.kind,chapter:p.chapter??null,cfi:p.cfi,updatedAt:new Date(p.updatedAt).toISOString()});}},
 };
}
export async function createLibraryStorage():Promise<LibraryStorage>{return adaptLibraryStorage(await openReaderStorage(storageOptions));}
