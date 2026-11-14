// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractBounded, safeArchivePath } from '../../apps/extension/src/readers/archive';

describe('untrusted EPUB archive boundary', () => {
  it.each(['../outside', '/absolute', 'C:/Windows/a', 'a\\b', 'a/../b', 'a/./b', 'a//b', 'a\u0000b'])('rejects %j', path => {
    expect(() => safeArchivePath(path)).toThrow();
  });
  it('preserves Cyrillic and spaces and returns exact actual bytes', () => {
    const content = strToU8('A quiet river bank.');
    const files = extractBounded(zipSync({'Книга с пробелами/chapter.xhtml':content}));
    expect(Array.from(files['Книга с пробелами/chapter.xhtml']!)).toEqual(Array.from(content));
  });
  it('rejects case-conflicting names', () => {
    expect(() => extractBounded(zipSync({'Chapter.xhtml':strToU8('one'),'chapter.xhtml':strToU8('two')}))).toThrow();
  });
  it('rejects Unicode normalization conflicts', () => {
    expect(() => extractBounded(zipSync({'café.xhtml':strToU8('one'),'cafe\u0301.xhtml':strToU8('two')}))).toThrow();
  });
  it('rejects high-ratio payload from actual inflation', () => {
    expect(() => extractBounded(zipSync({'bomb.txt':new Uint8Array(1024*1024)}, {level:9}))).toThrow();
  });
  it('rejects an archive containing traversal rather than trusting caller', () => {
    expect(() => extractBounded(zipSync({'../escape':strToU8('bad')}))).toThrow();
  });
  it('rejects empty/non-zip bytes', () => expect(() => extractBounded(new Uint8Array())).toThrow());
});

