/** Optional local reader state; kept separate from book bytes, progress and Anki records. */
export const READER_BOOKMARK_LIMIT = 200;
export const READER_BOOKMARK_LABEL_MAX = 200;
export const READER_STATE_MAX_BYTES = 1024 * 1024;
export type PdfZoom = 'fit' | '0.75' | '1' | '1.25' | '1.5';
export type ReaderBookmark = {id:string;label:string;createdAt:number} & (
 {kind:'pdf';page:number;offset:number} | {kind:'epub'|'fb2';cfi:string;chapter:string}
);
export type ReaderAppearance = {kind:'pdf';zoom:PdfZoom} | {
 kind:'epub'|'fb2';fontSize:number;theme:'light'|'dark';width:'comfortable'|'wide'|'full';lineHeight:1.3|1.5|1.7|2
};
export interface ReaderSavedState {version:1;bookmarks:ReaderBookmark[];appearance?:ReaderAppearance}
export type ReaderKind = 'pdf'|'epub'|'fb2';
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value:Record<string,unknown>, allowed:string[]) => Object.keys(value).every(key => allowed.includes(key));
const finite = (value:unknown):value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value:unknown, max:number, nonempty=false):value is string => typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim());
function invalid():never {throw new Error('Некорректные сохранённые закладки или оформление книги.');}
/** Validate untrusted IndexedDB values and return an independent, allow-listed copy. */
export function validateReaderSavedState(value:unknown, kind?:ReaderKind):ReaderSavedState {
 if(!record(value)||value.version!==1||!keys(value,['version','bookmarks','appearance'])||!Array.isArray(value.bookmarks)||value.bookmarks.length>READER_BOOKMARK_LIMIT)invalid();
 const ids=new Set<string>();
 const bookmarks:ReaderBookmark[]=value.bookmarks.map((bookmark:unknown)=>{
  if(!record(bookmark)||!string(bookmark.id,128,true)||ids.has(bookmark.id)||!string(bookmark.label,READER_BOOKMARK_LABEL_MAX,true)||!finite(bookmark.createdAt)||bookmark.createdAt<0||bookmark.createdAt>8640000000000000||kind&&bookmark.kind!==kind)invalid();
  ids.add(bookmark.id);
  const common={id:bookmark.id,label:bookmark.label,createdAt:bookmark.createdAt};
  if(bookmark.kind==='pdf'){
   if(!keys(bookmark,['id','label','createdAt','kind','page','offset'])||!Number.isSafeInteger(bookmark.page)||(bookmark.page as number)<1||!finite(bookmark.offset)||bookmark.offset<0||bookmark.offset>1)invalid();
   return {...common,kind:'pdf',page:bookmark.page as number,offset:bookmark.offset};
  }
  if((bookmark.kind!=='epub'&&bookmark.kind!=='fb2')||!keys(bookmark,['id','label','createdAt','kind','cfi','chapter'])||!string(bookmark.cfi,2048,true)||!/^epubcfi\(.+\)$/.test(bookmark.cfi)||!string(bookmark.chapter,500))invalid();
  return {...common,kind:bookmark.kind,cfi:bookmark.cfi,chapter:bookmark.chapter};
 });
 let appearance:ReaderAppearance|undefined;
 if(value.appearance!==undefined){
  const a=value.appearance;
  if(!record(a)||kind&&a.kind!==kind)invalid();
  if(a.kind==='pdf'){
   if(!keys(a,['kind','zoom'])||!['fit','0.75','1','1.25','1.5'].includes(a.zoom as string))invalid();
   appearance={kind:'pdf',zoom:a.zoom as PdfZoom};
  }else{
   if((a.kind!=='epub'&&a.kind!=='fb2')||!keys(a,['kind','fontSize','theme','width','lineHeight'])||!Number.isInteger(a.fontSize)||(a.fontSize as number)<14||(a.fontSize as number)>36||!['light','dark'].includes(a.theme as string)||!['comfortable','wide','full'].includes(a.width as string)||![1.3,1.5,1.7,2].includes(a.lineHeight as number))invalid();
   appearance={kind:a.kind,fontSize:a.fontSize as number,theme:a.theme as 'light'|'dark',width:a.width as 'comfortable'|'wide'|'full',lineHeight:a.lineHeight as 1.3|1.5|1.7|2};
  }
 }
 const result:ReaderSavedState={version:1,bookmarks,...(appearance?{appearance}:{})};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>READER_STATE_MAX_BYTES)invalid();
 return result;
}
