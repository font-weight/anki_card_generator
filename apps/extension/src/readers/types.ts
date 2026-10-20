export interface ReadingProgress { page?:number; offset?:number; cfi?:string; chapter?:string; updatedAt:number }
export interface LibraryBook { documentId:string; title:string; kind:'pdf'|'epub'; size:number; addedAt:number; progress?:ReadingProgress }
export interface StoredBook extends LibraryBook { blob:Blob }
/** Implement with the common storage layer, never runtime messages containing book bytes. */
export interface LibraryStorage {
 listBooks():Promise<LibraryBook[]>; getBook(id:string):Promise<StoredBook|undefined>;
 putBook(book:StoredBook):Promise<void>; deleteBook(id:string):Promise<void>;
 saveProgress(id:string,progress:ReadingProgress):Promise<void>;
}
export interface ReaderSource { kind:'pdf'|'epub';title:string;url:null;documentId:string;page:number|null;chapter:string|null;cfi:string|null }
export type DocumentReady=(document:Document,source:()=>ReaderSource)=>void|(()=>void);
