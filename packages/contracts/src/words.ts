/** Same English word segmentation as the reader extractor; never normalize target offsets. */
export function countEnglishWords(text:string):number {
 const segmenter=new Intl.Segmenter('en',{granularity:'word'});
 let count=0;for(const segment of segmenter.segment(text))if(segment.isWordLike)count++;
 return count;
}
