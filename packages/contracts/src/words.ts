/** English lexical words: Intl segmentation with apostrophe/hyphen compounds kept whole. */
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
