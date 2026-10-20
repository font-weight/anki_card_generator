// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {extractAtPoint,extractFromRange,segmentLexicalWords} from '../../apps/extension/src/content/extraction';
import {countSourceWords,defaultLocale,validateRequest,type LanguageCode} from '../../packages/contracts/src/index';
import {sourceGraphemeBoundaries} from '../../packages/contracts/src/words';
beforeEach(()=>{document.body.innerHTML='';document.documentElement.lang='';});
afterEach(()=>{delete (document as any).caretRangeFromPoint;document.documentElement.lang='';});
function select(text:string,expression:string,locale:string){
 document.body.innerHTML='<p></p>';document.querySelector('p')!.textContent=text;document.querySelector('p')!.lang=locale;
 const at=text.indexOf(expression),r=document.createRange();r.setStart(document.querySelector('p')!.firstChild!,at);r.setEnd(document.querySelector('p')!.firstChild!,at+expression.length);return extractFromRange(r);
}
describe('multilingual Unicode extraction without normalization',()=>{
 it.each([
  ['fr','😀 Je lis un livre au café.','café'],
  ['ru','😀 Я читаю книгу.','книгу'],
  ['ar','😀 أنا أقرأ كتابًا.','كتابًا'],
  ['hi','😀 मैं किताब पढ़ता हूँ।','पढ़ता'],
  ['zh','😀 我喜欢阅读中文书籍。','阅读'],
  ['ja','😀 私は日本語の本を読みます。','日本語'],
  ['ko','😀 나는 한국어 책을 읽습니다.','한국어'],
 ])('preserves %s script target and original UTF16 boundaries',(locale,text,expression)=>{
  const result=select(text,expression,locale);expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.expression).toBe(expression);expect(result.context.sentence.slice(result.context.targetStart,result.context.targetEnd)).toBe(expression);expect(result.range.toString()).toBe(expression);
 });
 it.each([
  ['ru','Я читаю книгу.','читаю'],['ar','أنا أقرأ كتابًا.','كتابًا'],['hi','मैं किताब पढ़ता हूँ।','पढ़ता'],['zh','我喜欢阅读中文书籍。','阅读'],['ja','私は日本語の本を読みます。','日本語'],
 ])('hover extracts a bounded %s lexical segment',(locale,text,expression)=>{
  document.body.innerHTML='<p></p>';const p=document.querySelector('p')!;p.lang=locale;p.textContent=text;
  (document as any).caretRangeFromPoint=()=>{const r=document.createRange();r.setStart(p.firstChild!,text.indexOf(expression)+1);r.collapse(true);return r;};
  const result=extractAtPoint(document,10,10);expect(result.ok).toBe(true);if(result.ok)expect(result.expression).toBe(expression);
 });
 it('segments CJK rather than taking an entire unspaced sentence as one word',()=>{
  const five='我喜欢阅读中文书籍',six='我喜欢阅读中文书籍每天';
  expect(segmentLexicalWords(five,'zh')).toHaveLength(5);
  expect(select(five,five,'zh').ok).toBe(true);
  expect(select(six,six,'zh')).toMatchObject({ok:false,code:'too_many_words'});
 });
 it('counts Japanese lexical segments, including particles, conservatively',()=>{
  const text='私は日本語の本を読みます';expect(select(text,text,'ja')).toMatchObject({ok:false,code:'too_many_words'});
 });
 it('retains Arabic diacritics and Hindi combining marks across DOM nodes',()=>{
  document.body.innerHTML='<p lang="hi">मैं <b>प</b>ढ़ता हूँ।</p>';const p=document.querySelector('p')!;
  const r=document.createRange();r.setStart(p.querySelector('b')!.firstChild!,0);r.setEnd(p.childNodes[2]!,4);
  const result=extractFromRange(r);expect(result.ok).toBe(true);if(result.ok){expect(result.expression).toBe('पढ़ता');expect(result.range.toString()).toBe('पढ़ता');}
 });
 it('rejects selection that splits a grapheme, even when UTF16 slice itself matches',()=>{
  expect(select('café','cafe','fr')).toMatchObject({ok:false,code:'no_text'});
  expect(select('😀 word','\ud83d','en')).toMatchObject({ok:false,code:'no_text'});
 });
 it('missing Intl.Segmenter yields explicit unsupported rather than whole-text fallback',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(Intl,'Segmenter')!;
  try{Object.defineProperty(Intl,'Segmenter',{...descriptor,value:undefined});expect(segmentLexicalWords('中文文本','zh')).toBeNull();expect(select('中文文本','中文','zh')).toMatchObject({ok:false,code:'unsupported'});}
  finally{Object.defineProperty(Intl,'Segmenter',descriptor);}
 });
 it('ignores malformed lang hint safely, retaining bounded segmentation',()=>{
  const result=select('Read this book.','book','not a valid locale');expect(result.ok).toBe(true);
 });
 it('preserves supported compounds but does not merge whitespace or punctuation runs',()=>{
  expect(segmentLexicalWords("well-known doesn’t l’amour",'fr')).toHaveLength(3);
  expect(segmentLexicalWords('one--two three, four','en')).toHaveLength(4);
 });
 it.each([
  ['zh','我喜欢阅读中文书籍',5],['zh','我喜欢阅读中文书籍每天',6],
  ['ja','私は日本語の本を読みます',8],
  ['ar','أَنَا أَقْرَأُ كِتَابًا فِي الْبَيْتِ',5],['ar','أَنَا أَقْرَأُ كِتَابًا فِي الْبَيْتِ يَوْمِيًّا',6],
  ['hi','मैं यह किताब हर दिन',5],['hi','मैं यह किताब हर दिन पढ़ता',6],
  ['fr',"un deux trois quatre l’amour",5],
 ] as const)('uses the same %s lexical limit in extraction and the RPC boundary',(language,text,count)=>{
  expect(segmentLexicalWords(text,defaultLocale(language))).toHaveLength(count);
  expect(countSourceWords(text,language)).toBe(count);
  const result=select(text,text,defaultLocale(language));
  const lookup=()=>validateRequest({v:1,requestId:'3fbc6d2e-806b-4cae-8878-6b11c46b6901',type:'lookup',payload:{expression:text,context:{sentence:text,targetStart:0,targetEnd:text.length},sourceLanguage:language,targetLanguage:'en',learnerLevel:'A2',dialect:defaultLocale(language)}});
  if(count<=5){expect(result.ok).toBe(true);expect(lookup).not.toThrow();}
  else{expect(result).toMatchObject({ok:false,code:'too_many_words'});expect(lookup).toThrow();}
 });
 it.each([
  ['fr','á'],['ar','بَ'],['hi','कि'],['en','👩🏽‍🚀'],
 ] as const)('clips long %s context only at complete grapheme boundaries',(language,cluster)=>{
  const text=cluster.repeat(900)+' book '+cluster.repeat(900);
  const result=select(text,'book',language);expect(result.ok).toBe(true);if(!result.ok)return;
  const contextStart=text.indexOf(result.context.sentence),boundaries=sourceGraphemeBoundaries(text,language)!;
  expect(contextStart).toBeGreaterThan(0);expect(result.context.sentence.length).toBeLessThanOrEqual(1500);
  expect(boundaries.has(contextStart)).toBe(true);expect(boundaries.has(contextStart+result.context.sentence.length)).toBe(true);
  expect(result.context.sentence.slice(result.context.targetStart,result.context.targetEnd)).toBe('book');
  expect(()=>validateRequest({v:1,requestId:'3fbc6d2e-806b-4cae-8878-6b11c46b6901',type:'lookup',payload:{expression:result.expression,context:result.context,sourceLanguage:language as LanguageCode,targetLanguage:'en',learnerLevel:'A2',dialect:defaultLocale(language)}})).not.toThrow();
 });
});
