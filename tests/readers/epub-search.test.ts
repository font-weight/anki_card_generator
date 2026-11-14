import {afterEach,describe,expect,it,vi} from 'vitest';
import ePub,{EpubCFI,type Book} from 'epubjs';
import {strToU8} from 'fflate';
import {isSafeEpubCfi,searchSafeEpubSpine,type EpubSearchState} from '../../apps/extension/src/readers/EpubReader';
import {prepareSafeEpub,sanitizeChapter} from '../../apps/extension/src/readers/epub-security';

const wrap=(body:string)=>`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Not indexed title</title></head><body>${body}</body></html>`;
function local(body:string,options:{count?:number;getText?:(url:string)=>Promise<string>}={}){
 const xml=sanitizeChapter(wrap(body),'OPS/ch.xhtml',new Map()),ranges:Range[]=[],sections=Array.from({length:options.count||1},(_,i)=>({href:`ch-${i}.xhtml`,url:`/OPS/ch-${i}.xhtml`,cfiFromRange:(range:Range)=>{ranges.push(range);return new EpubCFI(range,`/6/${(i+1)*2}[chapter${i}]`).toString();}}));
 const getText=vi.fn(options.getText||(()=>Promise.resolve(xml))),request=vi.fn(()=>{throw new Error('Network is forbidden');}),load=vi.fn(()=>{throw new Error('Renderer section load forbidden');});
 const book={archived:true,archive:{getText},request,load,spine:{each:(fn:(value:unknown)=>void)=>sections.forEach(fn)}} as unknown as Book;
 return {book,getText,request,load,ranges,xml};
}
async function run(book:Book,query:string){const states:EpubSearchState[]=[];await searchSafeEpubSpine(book,query,new AbortController().signal,value=>states.push(value));return {states,last:states.at(-1)!};}
afterEach(()=>vi.useRealTimers());

describe('bounded local sanitized EPUB / FB2 search',()=>{
 it('escapes regex input and reads sanitized archive text, never a network/Section.load fallback',async()=>{
  const sample=local('<script>hidden-bank</script><p onclick="fetch()">A.b [bank] <strong>tail</strong></p><img src="https://host.invalid/a.png"/>');
  const {last}=await run(sample.book,'[BANK]');expect(last.results).toHaveLength(1);expect(sample.ranges[0].toString()).toBe('[bank]');
  expect(last.results[0].excerpt).toBe('A.b [bank] tail');expect(last.partial).toBe(false);expect(last.running).toBe(false);
  expect(sample.getText).toHaveBeenCalledWith('/OPS/ch-0.xhtml');expect(sample.request).not.toHaveBeenCalled();expect(sample.load).not.toHaveBeenCalled();
  expect((await run(sample.book,'hidden-bank')).last.results).toHaveLength(0);expect((await run(sample.book,'Not indexed title')).last.results).toHaveLength(0);
  await expect(run({...sample.book,archived:false} as Book,'bank')).rejects.toThrow(/архив/);expect(sample.request).not.toHaveBeenCalled();
 });
 it('matches across inline nodes and keeps CR, surrogate pairs and casefold-expanding characters at exact original offsets',async()=>{
  const sample=local('<p>İ😀&#13;Before <em>bank</em> tail İ BANK é.</p>');
  const original=sample.xml,{last}=await run(sample.book,'BANK');expect(last.results).toHaveLength(2);expect(sample.ranges.map(range=>range.toString())).toEqual(['bank','BANK']);
  for(let i=0;i<last.results.length;i++){const doc=sample.ranges[i].startContainer.ownerDocument!;expect(new EpubCFI(last.results[i].cfi).toRange(doc).toString()).toBe(sample.ranges[i].toString());expect(doc.querySelector('p')!.textContent).toBe('İ😀\rBefore bank tail İ BANK é.');}
  expect((await run(sample.book,'Before bank tail')).last.results).toHaveLength(1);expect(sample.ranges.at(-1)!.toString()).toBe('Before bank tail');expect(sample.xml).toBe(original);
 });
 it('caps results honestly, stops further sections, and reports progressive real section counts',async()=>{
  const sample=local(`<p>${'bank '.repeat(150)}</p>`,{count:3}),{states,last}=await run(sample.book,'bank');
  expect(last.results).toHaveLength(100);expect(last.capped).toBe(true);expect(last.total).toBe(3);expect(last.scanned).toBe(1);expect(last.running).toBe(false);expect(sample.getText).toHaveBeenCalledTimes(1);expect(states[0]).toMatchObject({running:true,scanned:0,total:3});
 });
 it('skips oversized/unavailable chapters without pretending the search was exhaustive',async()=>{
  const sample=local('<p>bank</p>',{count:3,getText:async url=>url.includes('-0.')?'x'.repeat(2_000_001):url.includes('-1.')?Promise.reject(new Error('bad section')):wrap('<p>bank</p>')}),{last}=await run(sample.book,'bank');
  expect(last.partial).toBe(true);expect(last.scanned).toBe(3);expect(last.results).toHaveLength(1);expect(last.running).toBe(false);
 });
 it('rejects a cancelled pending load and never publishes its late result or reads the next section',async()=>{
  let resolve!:(value:string)=>void;const pending=new Promise<string>(yes=>{resolve=yes;}),sample=local('<p>bank</p>',{count:3,getText:()=>pending}),controller=new AbortController(),states:EpubSearchState[]=[];
  const search=searchSafeEpubSpine(sample.book,'bank',controller.signal,value=>states.push(value));const rejection=expect(search).rejects.toMatchObject({name:'AbortError'});
  await vi.waitFor(()=>expect(sample.getText).toHaveBeenCalledOnce());controller.abort();await rejection;const count=states.length;resolve(wrap('<p>bank</p>'));await Promise.resolve();
  expect(states).toHaveLength(count);expect(states.at(-1)!.results).toHaveLength(0);expect(sample.getText).toHaveBeenCalledOnce();
 });
 it('bounds a never-settling local section and continues with honest partial status',async()=>{
  vi.useFakeTimers();const sample=local('<p>bank</p>',{getText:()=>new Promise(()=>{})}),states:EpubSearchState[]=[];
  const search=searchSafeEpubSpine(sample.book,'bank',new AbortController().signal,value=>states.push(value));await vi.advanceTimersByTimeAsync(10002);await search;
  expect(states.at(-1)).toMatchObject({running:false,partial:true,results:[],scanned:1});
 });
 it('uses real installed epub.js spine CFIs that round-trip in its serialized iframe DOM, including auto tbody and CR',async()=>{
  const files={mimetype:strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),'OPS/book.opf':strToU8('<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">search-test</dc:identifier><dc:title>Local test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="ch.xhtml" media-type="application/xhtml+xml"/><item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c"/></spine></package>'),'OPS/ch.xhtml':strToU8(wrap('<p>İ😀&#13;prefix <em>bank</em> tail</p><table><tr><td>Second BANK</td></tr></table>')),'OPS/nav.xhtml':strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head/><body><nav epub:type="toc"><ol><li><a href="ch.xhtml">Chapter</a></li></ol></nav></body></html>')};
  const safe=prepareSafeEpub(files),book=ePub(safe.data,{replacements:'none'});
  try{
   await book.ready;book.spine.hooks.serialize.register((output:string,section:{output:string})=>{section.output=output.replace(/\r/g,'&#13;');});
   const {last}=await run(book,'bank'),section=book.spine.get(0),rendered=await section.render(book.load.bind(book));
   const frameDocument=new DOMParser().parseFromString(rendered,'text/html');expect(frameDocument.querySelector('tbody')).not.toBeNull();
   expect(last.results).toHaveLength(2);expect(last.results.map(result=>new EpubCFI(result.cfi).toRange(frameDocument).toString())).toEqual(['bank','BANK']);
   expect(frameDocument.querySelector('p')!.textContent).toBe('İ😀\rprefix bank tail');for(const result of last.results)expect(book.spine.get(result.cfi)).toBe(section);
  }finally{book.destroy();safe.dispose();}
 });
});

describe('EPUB bookmark/search CFI boundary',()=>{
 it.each(['https://host/chapter','javascript:alert(1)','epubcfi(https://host)','epubcfi(/6/3!/4/2/1:0)','epubcfi(/6/2!/4/2/1:-1)','epubcfi(/6/2!/4/2/1:0)\n','epubcfi(/6/2!http://host)'])('rejects non-CFI or malformed target %s',value=>expect(isSafeEpubCfi(value)).toBe(false));
 it('accepts precise generated point/range CFIs with chapter assertions',()=>{expect(isSafeEpubCfi('epubcfi(/6/2[chapter]!/4/2/1:9)')).toBe(true);expect(isSafeEpubCfi('epubcfi(/6/2[chapter]!/4/2,/1:9,/3:4)')).toBe(true);});
});
