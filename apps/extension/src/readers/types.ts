import type {ReaderSavedState} from '@english-reader/storage';
export {READER_BOOKMARK_LIMIT,READER_BOOKMARK_LABEL_MAX,validateReaderSavedState} from '@english-reader/storage';
export type {PdfZoom,ReaderBookmark,ReaderAppearance,ReaderSavedState} from '@english-reader/storage';
export interface ReadingProgress { page?:number; offset?:number; cfi?:string; chapter?:string; updatedAt:number }
export interface LibraryBook { documentId:string; title:string; kind:'pdf'|'epub'|'fb2'; size:number; addedAt:number; progress?:ReadingProgress }
export interface StoredBook extends LibraryBook { blob:Blob }
/** Implement with the common storage layer, never runtime messages containing book bytes. */
export interface LibraryStorage {
 listBooks():Promise<LibraryBook[]>; getBook(id:string):Promise<StoredBook|undefined>;
 putBook(book:StoredBook):Promise<void>; deleteBook(id:string):Promise<void>;
 saveProgress(id:string,progress:ReadingProgress):Promise<void>;
 /** Optional for older integrations; missing methods mean session-only reader features. */
 getReaderState?(id:string):Promise<ReaderSavedState|undefined>;
 saveReaderState?(id:string,state:ReaderSavedState):Promise<void>;
}
export interface ReaderSource { kind:'pdf'|'epub'|'fb2';title:string;url:null;documentId:string;page:number|null;chapter:string|null;cfi:string|null }
export type DocumentReady=(document:Document,source:()=>ReaderSource)=>void|(()=>void);
