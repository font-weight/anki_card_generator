import type { LanguageCode } from './languages.ts';
export interface LexicalSegment { start:number; end:number; text:string }
/** Original UTF-16 boundaries; null means safe segmentation is unavailable. */
export function sourceGraphemeBoundaries(text:string,locale:string='und'):Set<number>|null {
 const Constructor=(Intl as unknown as {Segmenter?:typeof Intl.Segmenter}).Segmenter;
 if(!Constructor)return null;
 let segmenter:Intl.Segmenter;
 try{segmenter=new Constructor(locale,{granularity:'grapheme'});}
 catch{try{segmenter=new Constructor('und',{granularity:'grapheme'});}catch{return null;}}
 const boundaries=new Set<number>();
 for(const part of segmenter.segment(text))boundaries.add(part.index);
 boundaries.add(text.length);
 return boundaries;
}
/** Browser ICU lexical units; preserve original UTF-16 offsets and supported compounds. */
export function segmentSourceWords(text:string,locale:string='und'):LexicalSegment[]|null {
 const Constructor=(Intl as unknown as {Segmenter?:typeof Intl.Segmenter}).Segmenter;
 if(!Constructor)return null;
 let segmenter:Intl.Segmenter;
 try{segmenter=new Constructor(locale,{granularity:'word'});}
 catch{try{segmenter=new Constructor('und',{granularity:'word'});}catch{return null;}}
 const result:LexicalSegment[]=[];
 for(const part of segmenter.segment(text)){
  if(!part.isWordLike)continue;
  const previous=result.at(-1);
  if(previous&&/^[-'’\u2010\u2011]$/u.test(text.slice(previous.end,part.index))){
   previous.end=part.index+part.segment.length;previous.text=text.slice(previous.start,previous.end);
  }else result.push({start:part.index,end:part.index+part.segment.length,text:part.segment});
 }
 return result;
}
/** No whitespace fallback: missing ICU support cannot silently admit arbitrary CJK ranges. */
export function countSourceWords(text:string,language:LanguageCode='en'):number {
 const words=segmentSourceWords(text,language);
 if(!words)throw Object.assign(new Error('Определение границ слов недоступно. Обновите Chrome.'),{code:'INVALID_INPUT',retryable:false});
 return words.length;
}
/** Frozen v1 English counter: persisted drafts keep their original validation rules. */
export function countEnglishWords(text:string):number {
 const segmenter=new Intl.Segmenter('en',{granularity:'word'});
 let count=0,previousWordEnd=-1;
 for(const segment of segmenter.segment(text)){
  if(!segment.isWordLike)continue;
  const joiner=previousWordEnd<0?'':text.slice(previousWordEnd,segment.index);
  if(previousWordEnd<0||!/^[-'’\u2010\u2011]$/u.test(joiner))count++;
  previousWordEnd=segment.index+segment.segment.length;
 }
 return count;
}
