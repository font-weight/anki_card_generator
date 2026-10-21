/** Detached sanitized text only; the real EPUB CFI implementation is used, no provider or browser. */
import {EpubCFI,type Book} from 'epubjs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {searchSafeEpubSpine,type EpubSearchState} from '../../apps/extension/src/readers/EpubReader';
import {sanitizeChapter} from '../../apps/extension/src/readers/epub-security';

const envelope=(body:string)=>`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Safe</title></head><body>${body}</body></html>`;
function fakeBook(xml:string){
 const section={url:'/OPS/one.xhtml',href:'one.xhtml',cfiFromRange:(range:Range)=>new EpubCFI(range,'/6/2').toString()};
 const archive={getText:vi.fn(async()=>xml)};
 return{instance:{archived:true,archive,spine:{each:(callback:(value:typeof section)=>void)=>callback(section)}} as unknown as Book,archive};
}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Independent EPUB tests permit no network');})));
afterEach(()=>vi.unstubAllGlobals());

describe('independent search CFI roundtrips to final HTML DOM',()=>{
 it.each([
  ['inline split and Unicode','<p>İ before <em>tar</em>get 😀 target</p>'],
  ['implicit table body','<table><tr><td>target</td></tr></table>'],
 ])('locates the actual rendered text for %s',async(_name,body)=>{
  const xml=sanitizeChapter(envelope(body),'OPS/one.xhtml',new Map());
  const {instance}=fakeBook(xml);const updates:EpubSearchState[]=[];
  await searchSafeEpubSpine(instance,'target',new AbortController().signal,value=>updates.push(value));
  const found=updates.at(-1)!;expect(found.running).toBe(false);expect(found.partial).toBe(false);expect(found.results.length).toBeGreaterThan(0);
  const rendered=new DOMParser().parseFromString(xml,'text/html');
  for(const result of found.results)expect(new EpubCFI(result.cfi).toRange(rendered).toString()).toBe('target');
  expect(fetch).not.toHaveBeenCalled();
 });
 it('cannot resurrect a stale search after an aborted local archive read finishes',async()=>{
  let resolve!:(value:string)=>void;const pending=new Promise<string>(yes=>{resolve=yes;});
  const {instance,archive}=fakeBook(envelope('<p>target</p>'));archive.getText.mockReturnValueOnce(pending);
  const updates:EpubSearchState[]=[],controller=new AbortController();const result=searchSafeEpubSpine(instance,'target',controller.signal,value=>updates.push(value));
  await new Promise<void>(yes=>setTimeout(yes,5));controller.abort();await expect(result).rejects.toMatchObject({name:'AbortError'});
  const count=updates.length;resolve(envelope('<p>target</p>'));await Promise.resolve();expect(updates).toHaveLength(count);expect(fetch).not.toHaveBeenCalled();
 });
});
