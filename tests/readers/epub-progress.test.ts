import {describe,expect,it,vi} from 'vitest';
import {EpubCFI,type Book,type Rendition} from 'epubjs';
import {indexBookProgress} from '../../apps/extension/src/readers/epub-progress';
import {applyBookStyle} from '../../apps/extension/src/readers/epub-format';
import {sanitizeChapter} from '../../apps/extension/src/readers/epub-security';

const text=(value:string)=>'<html><head></head><body><p>'+value+'</p></body></html>';
function fixture(documents=[text('a'.repeat(20)),text('b'.repeat(80)),text(' ')]){
 const sections=documents.map((_,i)=>({url:'/c'+i,linear:true,cfiFromRange:(range:Range)=>new EpubCFI(range,'/6/'+(i*2+2)).toString(),unload:vi.fn()}));
 const getText=vi.fn(async(url:string)=>documents[Number(url.slice(2))]);
 const book={archived:true,spine:{each:(fn:(section:unknown)=>void)=>sections.forEach(fn)},archive:{getText}} as unknown as Book;
 return {book,sections,getText,rendition:{epubcfi:new EpubCFI()} as Rendition};
}
describe('whole-book EPUB progress',()=>{
 it('weights actual text lengths, seeks between characters, and tolerates a trailing empty section',async()=>{
  const {book,rendition,sections,getText}=fixture(),index=await indexBookProgress(book,rendition,new AbortController().signal);
  expect(index).toBeDefined();
  for(const percent of [0,7,19,20,36,78,99,100]){
   const target=index!.target(percent),position=new EpubCFI(target);
   expect(position.spinePos).toBe(percent<20?0:1);
   expect(/:(\d+)\)$/.exec(target)?.[1]).toBe(String(percent<20?percent:percent-20));
   expect(index!.percent(target)).toBe(percent);
  }
  expect(getText).toHaveBeenCalledTimes(3);
  expect(sections.every(section=>!section.unload.mock.calls.length)).toBe(true);
 });
 it('seeks to FF:0 at 50% in a twenty-character book, with stable half-open boundaries and end stops',async()=>{
  const words=['AA','BB','CC','DD','EE','FF','GG','HH','II','JJ'];
  const xml='<html><body>'+words.map(w=>'<p>'+w+'</p>').join('')+'</body></html>';
  const {book,rendition}=fixture([xml]),index=(await indexBookProgress(book,rendition,new AbortController().signal))!;
  expect(index.characterCount).toBe(20);
  const doc=new DOMParser().parseFromString(xml,'text/html');
  for(let n=0;n<=20;n++){
   const target=index.target(n*5),range=new EpubCFI(target).toRange(doc);
   expect(range.startContainer.textContent).toBe(words[Math.min(9,Math.floor(n/2))]);
   expect(range.startOffset).toBe(n===20?2:n%2);
   expect(index.percent(target)).toBe(n*5);
   expect(index.target(index.percent(target))).toBe(target);
  }
  expect(index.target(-Infinity)).toBe(index.target(0));expect(index.target(Infinity)).toBe(index.target(100));
  expect(index.target(-2)).toBe(index.target(0));expect(index.target(102)).toBe(index.target(100));
  expect(index.target(NaN)).toBe(index.target(0));
 });
 it('resolves every side of a packed-block boundary in mixed inline text and accepts renderer ranges with ID assertions',async()=>{
  const xml='<html><body><section id="book">'+Array.from({length:700},(_,i)=>'<p id="p'+i+'"><i>x</i><b>y</b>z</p>').join('')+'</section></body></html>';
  const {book,rendition}=fixture([xml]),index=(await indexBookProgress(book,rendition,new AbortController().signal))!;
  const doc=new DOMParser().parseFromString(xml,'text/html'),ps=doc.querySelectorAll('p');
  expect(index.characterCount).toBe(2100);
  for(const n of [0,1,126,127,128,129,130,255,256,257,1049,1050,1051,2099]){
   const p=ps[Math.floor(n/3)],node=n%3===2?p.lastChild!:p.children[n%3].firstChild!;
   const ratio=n*100/2100,target=new EpubCFI(index.target(ratio)).toRange(doc);
   expect(target.startContainer).toBe(node);expect(target.startOffset).toBe(0);
   const range=doc.createRange();range.selectNodeContents(node);
   expect(index.percent(new EpubCFI(range,'/6/2[section]').toString())).toBeCloseTo(ratio,12);
  }
 });
 it('does not count whitespace-only text or nonlinear sections, including an empty spine entry between chapters',async()=>{
  const {book,sections,rendition}=fixture([text('a'),text('  '),text('skip this'),text('b')]);
  sections[2].linear=false;
  const index=(await indexBookProgress(book,rendition,new AbortController().signal))!;
  expect(index.characterCount).toBe(2);
  expect(index.percent('epubcfi(/6/4!/4/2/1:1)')).toBe(50);
  expect(new EpubCFI(index.target(50)).spinePos).toBe(3);
 });
 it('counts readable sections cumulatively, including a short chapter and an image-only page, independently of presentation',async()=>{
  const {book,rendition}=fixture([text('x'.repeat(2048)),text(''),'<html><body><img src="blob:cover"></body></html>',text('z'.repeat(1025))]);
  const index=(await indexBookProgress(book,rendition,new AbortController().signal))!;
  const at=(i:number,n:number)=>index.location('epubcfi(/6/'+(2*i+2)+'!/4/2/1:'+n+')');
  expect(at(0,0)).toMatchObject({page:1,total:5});expect(at(0,1023).page).toBe(1);
  expect(at(0,1024).page).toBe(2);expect(at(0,2048).page).toBe(2);
  expect(at(1,0).page).toBe(2);expect(at(2,0).page).toBe(3);
  expect(at(3,0).page).toBe(4);expect(at(3,1025)).toEqual({page:5,total:5,percent:100});
  expect(index.location(index.target(100))).toEqual(at(3,1025));
 });
 it('counts a purely illustrated book without creating text offsets',async()=>{
  const {book,rendition}=fixture(Array(3).fill('<html><body><img src="blob:image"></body></html>'));
  const index=(await indexBookProgress(book,rendition,new AbortController().signal))!;
  expect(index.characterCount).toBe(0);expect(index.location(index.target(50))).toEqual({page:2,total:3,percent:50});
 });
 it('includes covers at the actual book endpoints without adding characters to textual progress',async()=>{
  const image='<html><body><img src="blob:cover"></body></html>';
  const {book,rendition}=fixture([image,text('abc'),image]);
  const index=(await indexBookProgress(book,rendition,new AbortController().signal))!;
  expect(index.characterCount).toBe(3);expect(index.pageCount).toBe(3);
  expect(index.location(index.target(0))).toEqual({page:1,total:3,percent:0});
  expect(index.location(index.target(100))).toEqual({page:3,total:3,percent:100});
 });
 it('aborts without reading the next archive section',async()=>{
  const {book,getText,rendition}=fixture(),controller=new AbortController();
  getText.mockImplementationOnce(async()=>{controller.abort();return text('hello');});
  expect(await indexBookProgress(book,rendition,controller.signal)).toBeUndefined();
  expect(getText).toHaveBeenCalledOnce();
 });
});
it('only enables safe, recognized publisher text settings, with intact semantic hierarchy in each theme',()=>{
 const safe=sanitizeChapter('<html><head/><body><h1>Part One</h1><h2>Chapter 3</h2><h3>Arrival</h3><blockquote>Epigraph</blockquote><p style="background:url(x); text-align: right; font-style:italic" data-reader-weight="bold">Chapter text.</p></body></html>','c',new Map());
 const doc=new DOMParser().parseFromString(safe,'text/html'),paragraph=doc.querySelector('p')!;
 expect(paragraph.getAttribute('style')).toBeNull();expect(paragraph.getAttribute('data-reader-align')).toBe('right');expect(paragraph.hasAttribute('data-reader-weight')).toBe(false);
 const before=doc.body.innerHTML;
 for(const theme of ['light','cream','dark'] as const)for(const publisher of [false,true]){
  applyBookStyle(doc,{kind:'epub',fontSize:20,lineHeight:1.7,theme,publisher});
  const style=doc.querySelector('style[data-reader-format]')!.textContent!;
  expect(style.includes('[data-reader-align=right]')).toBe(publisher);
  expect(style).toContain(theme==='dark'?'#363636':theme==='cream'?'#fbf5df':'#ffffff');
  expect(doc.body.innerHTML).toBe(before);expect(doc.querySelectorAll('h1,h2,h3,blockquote,p')).toHaveLength(5);
 }
});
