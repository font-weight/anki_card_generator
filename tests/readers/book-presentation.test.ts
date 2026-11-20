import {describe,expect,it} from 'vitest';
import {displayBookTitle,chapterTitle} from '../../apps/extension/src/readers/book-presentation';

describe('book names retained from filename-based library records',()=>{
 it('removes technical prefixes while preserving meaningful How titles',()=>{
   expect(displayBookTitle('how_The_Quiet_Coast.epub')).toBe('The Quiet Coast');
   expect(displayBookTitle('how_how_to_learn.fb2')).toBe('How to learn');
   expect(displayBookTitle('how_to_learn.pdf')).toBe('How to learn');
   expect(displayBookTitle('how_To_Learn.pdf')).toBe('How To Learn');
   expect(displayBookTitle('How to Learn')).toBe('How to Learn');
 });
 it('uses readable fallbacks for internal document paths',()=>{
   expect(chapterTitle('OEBPS/Text/chapter_0003.xhtml#point')).toBe('Раздел 3');
   expect(chapterTitle('OEBPS/content.xhtml')).toBe('');
   expect(displayBookTitle('sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe('Книга без названия');
 });
});
