import {extractBookThumbnail} from './book-thumbnail';
import {storageOptions} from '../runtime/storage-config';
import {openReaderStorage,type ReaderStorage} from '@english-reader/storage';
import type {LibraryBook,LibraryStorage,ReadingProgress} from './types';
/** Direct trusted-page storage access. Blob data never traverses Chrome runtime RPC. */
export function adaptLibraryStorage(storage:ReaderStorage):LibraryStorage {
 type Metadata=Awaited<ReturnType<ReaderStorage['listBooks']>>[number];
 const timestamp=(value:string|number)=>typeof value==='number'?value:Date.parse(value);
 const metadata=(m:Metadata,progress?:ReadingProgress):LibraryBook=>({documentId:m.documentId,title:m.title,...(m.author?{author:m.author}:{}),kind:m.kind,size:m.byteLength,addedAt:timestamp(m.createdAt),progress});
 const progress=async(id:string):Promise<ReadingProgress|undefined>=>{const p=await storage.getProgress(id);if(!p)return undefined;const extra={...(p.percent===undefined?{}:{percent:p.percent}),...(p.chapterNumber===undefined?{}:{chapterNumber:p.chapterNumber})};return p.kind==='pdf'?{...extra,page:p.page,offset:p.offset,updatedAt:timestamp(p.updatedAt)}:{...extra,cfi:p.cfi,chapter:p.chapter??undefined,updatedAt:timestamp(p.updatedAt)};};
 // One source archive is inspected at a time. Scrolling away cancels queued jobs.
 let previous:Promise<unknown>=Promise.resolve();
 return {
  loadBookThumbnail(id,signal){
   const task=previous.then(async()=>{
    if(signal.aborted)return null;
    const cached=await storage.getBookThumbnail(id);
    if(cached!==undefined)return cached;
    const book=await storage.getBook(id);
    if(!book || book.metadata.kind==='pdf' || signal.aborted)return null;
    let thumbnail:string|null;
    try{thumbnail=await extractBookThumbnail(book.metadata.kind,book.blob);}catch{return null;}
    // Cover persistence is best-effort. Quota/closing the database must never block reading.
    try{await storage.saveBookThumbnail(id,thumbnail);}catch{}
    return thumbnail;
   });
   previous=task.catch(()=>{});
   return task;
  },
  async listBooks(){return Promise.all((await storage.listBooks()).map(async m=>metadata(m,await progress(m.documentId))));},
  async getBook(id){const book=await storage.getBook(id);return book?{...metadata(book.metadata,await progress(id)),blob:book.blob}:undefined;},
  async putBook(book){const saved=await storage.saveBook({blob:book.blob,kind:book.kind,title:book.title.slice(0,500),mimeType:book.kind==='pdf'?'application/pdf':book.kind==='fb2'?'application/x-fictionbook+xml':'application/epub+zip'});if(saved.documentId!==book.documentId)throw new Error('Отпечаток книги не совпал с хранилищем');},
  updateBookInfo:(id,info)=>storage.updateBookInfo(id,info),
  deleteBook:id=>storage.deleteBook(id),
  async getReaderState(id){return (await storage.getReaderState(id))??undefined;},
  saveReaderState:(id,state)=>storage.saveReaderState(id,state),
  async saveProgress(documentId,p){const extra=p.percent===undefined?{}:{percent:p.percent};if(p.page!==undefined)await storage.saveProgress({...extra,documentId,kind:'pdf',page:p.page,offset:p.offset??0,updatedAt:new Date(p.updatedAt).toISOString()});else if(p.cfi){const book=await storage.getBook(documentId);if(!book||book.metadata.kind==='pdf')throw new Error('Книга для сохранения позиции не найдена');await storage.saveProgress({...extra,...(p.chapterNumber===undefined?{}:{chapterNumber:p.chapterNumber}),documentId,kind:book.metadata.kind,chapter:p.chapter??null,cfi:p.cfi,updatedAt:new Date(p.updatedAt).toISOString()});}},
 };
}
export async function createLibraryStorage():Promise<LibraryStorage>{return adaptLibraryStorage(await openReaderStorage(storageOptions));}
