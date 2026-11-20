/** Optional local reader state, kept independently of progress and vocabulary records. */
export const READER_BOOKMARK_LIMIT = 200;
export const READER_BOOKMARK_LABEL_MAX = 200;
export const READER_QUOTE_LIMIT = 200;
export const READER_QUOTE_TEXT_MAX = 4000;
export const READER_COMMENT_MAX = 2000;
export const READER_STATE_MAX_BYTES = 1024 * 1024;
export type ReaderKind = 'pdf' | 'epub' | 'fb2';
export type ReaderStoredTheme = 'light' | 'dark' | 'cream';
export type PdfZoom = 'fit' | '0.75' | '1' | '1.25' | '1.5';
type ReflowAnchor = {kind:'epub'|'fb2'; cfi:string; chapter:string};
export type ReaderBookmark = {id:string;label:string;createdAt:number} & (
 {kind:'pdf';page:number;offset:number} | ReflowAnchor
);
export type ReaderQuote = {id:string;text:string;comment?:string;createdAt:number} & (
 {kind:'pdf';page:number;endPage?:number;start:number;end:number} | ReflowAnchor
);
export type ReaderAppearance = {kind:'pdf';zoom:PdfZoom;theme?:ReaderStoredTheme} | {
 kind:'epub'|'fb2';fontSize:number;theme:ReaderStoredTheme;width?:'comfortable'|'wide'|'full';lineHeight:1.3|1.5|1.7|2;
 publisher?:boolean;spread?:'single'|'double';flow?:'paginated'|'scrolled'
};
export interface ReaderSavedState {version:1;bookmarks:ReaderBookmark[];appearance?:ReaderAppearance;quotes?:ReaderQuote[]}
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value:Record<string,unknown>, allowed:string[]) => Object.keys(value).every(key => allowed.includes(key));
const finite = (value:unknown):value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value:unknown, max:number, nonempty=false):value is string => typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim());
const safeInt = (value:unknown, min:number):value is number => typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const theme = (value:unknown):value is ReaderStoredTheme => value==='light'||value==='cream'||value==='dark';
function invalid():never {throw new Error('Некорректные сохранённые закладки, цитаты или оформление книги.');}
function reflowAnchor(row:Record<string,unknown>):ReflowAnchor {
 if((row.kind!=='epub'&&row.kind!=='fb2')||!string(row.cfi,2048,true)||!/^epubcfi\(.+\)$/.test(row.cfi)||!string(row.chapter,500))invalid();
 return {kind:row.kind,cfi:row.cfi,chapter:row.chapter};
}
function base(row:unknown,ids:Set<string>,kind?:ReaderKind){
 if(!record(row)||!string(row.id,128,true)||ids.has(row.id)||!finite(row.createdAt)||row.createdAt<0||row.createdAt>8640000000000000||(kind&&row.kind!==kind))invalid();
 ids.add(row.id);return {id:row.id,createdAt:row.createdAt};
}
export function validateReaderSavedState(value:unknown, kind?:ReaderKind):ReaderSavedState {
 if(!record(value)||value.version!==1||!keys(value,['version','bookmarks','appearance','quotes'])||!Array.isArray(value.bookmarks)||value.bookmarks.length>READER_BOOKMARK_LIMIT)invalid();
 const ids=new Set<string>();
 const bookmarks:ReaderBookmark[]=value.bookmarks.map((row:unknown)=>{
  const common=base(row,ids,kind);
  if(!record(row)||!string(row.label,READER_BOOKMARK_LABEL_MAX,true))invalid();
  if(row.kind==='pdf'){
   if(!keys(row,['id','label','createdAt','kind','page','offset'])||!safeInt(row.page,1)||!finite(row.offset)||row.offset<0||row.offset>1)invalid();
   return {...common,label:row.label,kind:'pdf',page:row.page,offset:row.offset};
  }
  if(!keys(row,['id','label','createdAt','kind','cfi','chapter']))invalid();
  return {...common,label:row.label,...reflowAnchor(row)};
 });
 let quotes:ReaderQuote[]|undefined;
 if(value.quotes!==undefined){
  if(!Array.isArray(value.quotes)||value.quotes.length>READER_QUOTE_LIMIT)invalid();
  const quoteIds=new Set<string>();
  quotes=value.quotes.map((row:unknown)=>{
   const identity=base(row,quoteIds,kind);
   if(!record(row)||!string(row.text,READER_QUOTE_TEXT_MAX,true)||(row.comment!==undefined&&!string(row.comment,READER_COMMENT_MAX)))invalid();
   const common={...identity,text:row.text,...(row.comment===undefined?{}:{comment:row.comment})};
   if(row.kind==='pdf'){
    if(!keys(row,['id','text','comment','createdAt','kind','page','endPage','start','end'])||!safeInt(row.page,1)||!safeInt(row.start,0)||!safeInt(row.end,0)||(row.endPage!==undefined&&!safeInt(row.endPage,row.page))||((row.endPage??row.page)===row.page&&row.end<=row.start))invalid();
    return {...common,kind:'pdf',page:row.page,...(row.endPage===undefined?{}:{endPage:row.endPage}),start:row.start,end:row.end};
   }
   if(!keys(row,['id','text','comment','createdAt','kind','cfi','chapter']))invalid();
   return {...common,...reflowAnchor(row)};
  });
 }
 let appearance:ReaderAppearance|undefined;
 if(value.appearance!==undefined){
  const a=value.appearance;
  if(!record(a)||(kind&&a.kind!==kind))invalid();
  if(a.kind==='pdf'){
   if(!keys(a,['kind','zoom','theme'])||!['fit','0.75','1','1.25','1.5'].includes(a.zoom as string)||(a.theme!==undefined&&!theme(a.theme)))invalid();
   appearance={kind:'pdf',zoom:a.zoom as PdfZoom,...(a.theme===undefined?{}:{theme:a.theme})};
  }else{
   if((a.kind!=='epub'&&a.kind!=='fb2')||!keys(a,['kind','fontSize','theme','width','lineHeight','publisher','flow','spread'])||!safeInt(a.fontSize,14)||a.fontSize>36||!theme(a.theme)||![1.3,1.5,1.7,2].includes(a.lineHeight as number)||
     (a.width!==undefined&&a.width!=='comfortable'&&a.width!=='wide'&&a.width!=='full')||
     (a.flow!==undefined&&a.flow!=='paginated'&&a.flow!=='scrolled')||(a.spread!==undefined&&a.spread!=='single'&&a.spread!=='double')||(a.publisher!==undefined&&typeof a.publisher!=='boolean'))invalid();
   appearance={kind:a.kind,fontSize:a.fontSize,theme:a.theme,lineHeight:a.lineHeight as 1.3|1.5|1.7|2,
    ...(a.width===undefined?{}:{width:a.width}),...(a.flow===undefined?{}:{flow:a.flow}),...(a.spread===undefined?{}:{spread:a.spread}),...(a.publisher===undefined?{}:{publisher:a.publisher})};
  }
 }
 const result:ReaderSavedState={version:1,bookmarks,...(appearance?{appearance}:{}),...(quotes?{quotes}:{})};
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>READER_STATE_MAX_BYTES)invalid();
 return result;
}
