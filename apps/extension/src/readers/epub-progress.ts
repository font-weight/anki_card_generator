import type {Book, Rendition} from 'epubjs';

export interface BookLocation {percent:number; page:number; total:number}
export interface BookProgressIndex {
 location:(cfi:string)=>BookLocation;
 characterCount:number;
 pageCount:number;
 percent:(cfi:string)=>number;
 target:(percent:number)=>string;
}

// Text-node paths in the same chapter usually differ by only a few digits.
// Pack short suffixes in small blocks and keep one cumulative UTF-16 offset per
// node. Unlike character sampling this covers every paragraph and inline span.
const BLOCK_SIZE=128;
// Logical (not printed) pages are layout-independent. Start each readable spine
// section on a new page and never divide a chapter by the visible viewport size.
const CHARACTERS_PER_PAGE=1024;
interface NodeBlock {prefix:string; suffixes:string; starts:Uint32Array; end:number}
interface ChapterIndex {bodyCfi:string;firstPage:number; pages:number;start:number; end:number; blocks:NodeBlock[]}
interface Point {path:string; offset:number}
function point(cfi:string):Point {
 const parts=cfi.slice(8,-1).replace(/\[[^\]]*\]/g,'').split(',');
 const start=parts[0]+(parts[1]||'');
 const terminal=/:(\d+)$/.exec(start);
 return {path:terminal?start.slice(0,terminal.index):start,offset:terminal?Number(terminal[1]):0};
}
function cfi(path:string,offset:number){return 'epubcfi('+path+':'+offset+')';}

function pack(paths:string[],starts:number[],end:number):NodeBlock {
 let prefix=paths[0];
 for(const path of paths){
  let n=0;while(n<prefix.length&&prefix[n]===path[n])n++;
  prefix=prefix.slice(0,n);
 }
 return {prefix,suffixes:'\n'+paths.map(path=>path.slice(prefix.length)).join('\n')+'\n',starts:Uint32Array.from(starts),end};
}

// Right bias is intentional: the end of a paragraph and the beginning of the
// next share one character offset. Seeking to that boundary selects the latter.
function floorIndex(length:number,accept:(i:number)=>boolean){
 let lo=0,hi=length;
 while(lo<hi){const mid=(lo+hi)>>>1;if(accept(mid))lo=mid+1;else hi=mid;}
 return Math.max(0,lo-1);
}
function nodePath(block:NodeBlock,row:number){
 return block.prefix+block.suffixes.split('\n')[row+1];
}
function lookup(block:NodeBlock,path:string){
 if(!path.startsWith(block.prefix))return -1;
 const at=block.suffixes.indexOf('\n'+path.slice(block.prefix.length)+'\n');
 if(at<0)return -1;
 let row=0;for(let i=0;i<at;i++)if(block.suffixes.charCodeAt(i)===10)row++;
 return row;
}

/** Read detached copies of sanitized, linear sections. No Section.load/unload,
 * renderer mutation, chapter DOM or book text is retained by the progress index. */
export async function indexBookProgress(book:Book,rendition:Rendition,signal:AbortSignal):Promise<BookProgressIndex|undefined> {
 if(!book.archived||!book.archive?.getText||!book.spine.each)return;
 const sections:ReturnType<Book['spine']['get']>[]=[];
 book.spine.each((section:ReturnType<Book['spine']['get']>)=>{if(section.linear!==false)sections.push(section);});
 const all:NodeBlock[]=[],chapters=new Map<string,ChapterIndex>(),pages:ChapterIndex[]=[];
 const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
 let count=0,work=0,pageCount=0;
 for(const section of sections){
  await pause();if(signal.aborted)return;
  if(!section.url?.startsWith('/')||section.url.startsWith('//'))return;
  const xml=await book.archive.getText(section.url);
  if(signal.aborted||typeof xml!=='string')return;
  const doc=new DOMParser().parseFromString(xml,'text/html');
  const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT),range=doc.createRange();
  // A collapsed CFI on an element has a synthetic final /1 text step in epub.js.
  // Take the spine and body prefix from the actual Section. Count its descendants
  // once in document order; calling cfiFromRange on every sibling is quadratic.
  range.setStart(doc.body,0);range.collapse(true);
  const bodyPath=point(section.cfiFromRange(range)).path.replace(/\/1$/,'');
  const ancestors=[{element:doc.body as Element,path:bodyPath,elementCount:0,textCount:0}];
  const chapter:ChapterIndex={bodyCfi:'epubcfi('+bodyPath+')',firstPage:pageCount+1,pages:0,start:count,end:count,blocks:[]};
  let paths:string[]=[],starts:number[]=[],node:Node|null;
  const flush=()=>{
   if(!paths.length)return;
   const block=pack(paths,starts,count);all.push(block);chapter.blocks.push(block);paths=[];starts=[];
  };
  while((node=walker.nextNode())){
   if(++work%512===0){await pause();if(signal.aborted)return;}
   while(ancestors[ancestors.length-1].element!==node.parentNode)ancestors.pop();
   const parent=ancestors[ancestors.length-1];
   if(node.nodeType===Node.ELEMENT_NODE){
    const step=2*++parent.elementCount;
    ancestors.push({element:node as Element,path:parent.path+'/'+step,elementCount:0,textCount:0});continue;
   }
   const step=2*parent.textCount+1,text=(node as Text).data;parent.textCount++;
   if(!text.trim())continue;
   const path=parent.path+'/'+step;
   paths.push(path);starts.push(count);count+=text.length;
   if(paths.length===BLOCK_SIZE)flush();
  }
  flush();chapter.end=count;
  if(count>chapter.start||doc.body.querySelector('img[src]')){
   chapter.pages=Math.max(1,Math.ceil((count-chapter.start)/CHARACTERS_PER_PAGE));
   pageCount+=chapter.pages;pages.push(chapter);chapters.set(bodyPath.split('!')[0],chapter);
  }
 }
 if(signal.aborted||!pages.length)return;
 const offsetInChapter=(chapter:ChapterIndex,location:Point,value:string):number=>{
   for(const block of chapter.blocks){
    const row=lookup(block,location.path);if(row<0)continue;
    const start=block.starts[row],end=block.starts[row+1]??block.end;
    return Math.min(end,start+location.offset);
   }
   // A renderer can report a container, empty text or inter-paragraph whitespace.
   // For containers choose the first actual character; for gaps use the prior end.
   let previous=chapter.start;
   for(const block of chapter.blocks){
    const suffixes=block.suffixes.split('\n');
    for(let row=0;row<block.starts.length;row++){
     const path=block.prefix+suffixes[row+1];
     if(path.startsWith(location.path+'/'))return block.starts[row];
     if(rendition.epubcfi.compare(cfi(path,0),value)>0)return previous;
     previous=block.starts[row+1]??block.end;
    }
   }
   return chapter.end;
 };
 const locate=(value:string):BookLocation=>{
  const position=point(value),chapter=chapters.get(position.path.split('!')[0]);
  let offset:number,page:number;
  if(chapter){
   offset=offsetInChapter(chapter,position,value);
   const within=Math.floor((offset-chapter.start)/CHARACTERS_PER_PAGE);
   page=chapter.firstPage+Math.min(chapter.pages-1,within);
  }else if(rendition.epubcfi.compare(value,pages[0].bodyCfi)<0){
   offset=0;page=1;
  }else{
   // Empty/nonlinear sections carry neither indexed text nor extra pages.
   const previous=pages[floorIndex(pages.length,i=>rendition.epubcfi.compare(pages[i].bodyCfi,value)<=0)];
   offset=previous.end;page=previous.firstPage+previous.pages-1;
  }
  const percent=count?offset*100/count:pageCount>1?(page-1)*100/(pageCount-1):0;
  return {percent,page,total:pageCount};
 };
 return {
  characterCount:count,pageCount,location:locate,percent:value=>locate(value).percent,
  target(percent){
   const bounded=Number.isNaN(percent)?0:Math.max(0,Math.min(100,percent));
   if(!all.length)return pages[Math.round(bounded*(pages.length-1)/100)].bodyCfi;
   if(bounded===0&&!pages[0].blocks.length)return pages[0].bodyCfi;
   if(bounded===100&&!pages[pages.length-1].blocks.length)return pages[pages.length-1].bodyCfi;
   const desired=Math.round(count*bounded/100);
   const block=all[floorIndex(all.length,i=>all[i].starts[0]<=desired)];
   const row=floorIndex(block.starts.length,i=>block.starts[i]<=desired);
   return cfi(nodePath(block,row),desired-block.starts[row]);
  }
 };
}
