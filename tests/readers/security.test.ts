// @vitest-environment jsdom
import {describe,it,expect} from 'vitest';
import {zipSync,strToU8 as rawStrToU8} from 'fflate';
import {extractBounded,safeArchivePath} from '../../apps/extension/src/readers/archive';
import {resolveInternal,sanitizeChapter,prepareSafeEpub} from '../../apps/extension/src/readers/epub-security';
const strToU8=(text:string)=>new Uint8Array(rawStrToU8(text));
describe('bounded EPUB archive',()=>{
 it('supports Unicode/spaces and exact bytes',()=>{const input={'Книга с пробелами/chapter.xhtml':strToU8('<p>Hello bank</p>')};expect(Object.entries(extractBounded(zipSync(input)))).toEqual(Object.entries(input));});
 it.each(['../secret','a/../../secret','/root','C:/file','a\\b','a/./b','a//b'])('rejects traversal %s',name=>expect(()=>safeArchivePath(name)).toThrow());
 it('rejects duplicate normalized names',()=>expect(()=>extractBounded(zipSync({'A.xhtml':strToU8('x'),'a.xhtml':strToU8('y')}))).toThrow(/конфликт/));
 it('enforces actual decompression ratio',()=>expect(()=>extractBounded(zipSync({'bomb':new Uint8Array(1000000)},{level:9}))).toThrow(/предел/));
 it('rejects conflicting file/directory paths',()=>expect(()=>extractBounded(zipSync({'a':strToU8('x'),'a/b':strToU8('y')}))).toThrow(/Конфликт/));
 it('does not recursively expand nested archives',()=>{const nested=zipSync({'hello':strToU8('hello')});expect(extractBounded(zipSync({'nested.zip':nested}))['nested.zip']).toEqual(nested);});
});
describe('EPUB sanitizer',()=>{
 it('removes script, handlers, CSS, SVG, forms and network resources',()=>{const output=sanitizeChapter(`<html xmlns="http://www.w3.org/1999/xhtml"><head><style>@import 'https://bad';</style><meta http-equiv="refresh" content="0;url=https://bad"/></head><body onload="fetch('https://bad')"><script>alert(1)</script><iframe src="https://bad"/><form><input/></form><svg xmlns="http://www.w3.org/2000/svg"><image href="https://bad"/></svg><p style="background:url(https://bad)">Hello <b>bank</b></p><img src="https://bad"/><a href="javascript:alert(1)">bad</a><a href="https://example.com">external</a></body></html>`,'OPS/ch.xhtml',new Map());const doc=new DOMParser().parseFromString(output,'application/xml');expect(doc.querySelector('script,style,svg,iframe,form,input')).toBeNull();expect(doc.querySelector('[onload],[style],img[src],a[href]')).toBeNull();expect(doc.querySelector('a[data-external-link]')?.getAttribute('data-external-link')).toBe('https://example.com');expect(output).toContain("default-src 'none'");expect(doc.querySelector('b')?.textContent).toBe('bank');});
 it('preserves exact XML carriage-return references across repeated sanitizer/parser boundaries',()=>{
  const input='<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>Before&#13;bank&#xD;&#10;after é</p></body></html>';
  const expected='Before\rbank\r\nafter é';
  const first=sanitizeChapter(input,'OPS/ch.xhtml',new Map());
  expect(first).toContain('Before&#13;bank&#13;');expect(first).not.toContain('\r');
  const second=sanitizeChapter(first,'OPS/ch.xhtml',new Map());
  expect(new DOMParser().parseFromString(first,'application/xml').querySelector('p')?.textContent).toBe(expected);
  expect(new DOMParser().parseFromString(second,'application/xml').querySelector('p')?.textContent).toBe(expected);
 });
 it('preserves EPUB navigation semantics',()=>expect(sanitizeChapter('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head/><body><nav epub:type="toc"><a href="chapter.xhtml">Chapter</a></nav></body></html>','OPS/nav.xhtml',new Map())).toContain('epub:type="toc"'));
 it('rejects entity declarations',()=>expect(()=>sanitizeChapter('<!DOCTYPE html [<!ENTITY bomb "abc">]><html/>','x',new Map())).toThrow(/entities/));
 it('rewrites only authorized internal raster resources',()=>{expect(sanitizeChapter('<html><head/><body><img src="../img/a.png"/></body></html>','OPS/text/ch.xhtml',new Map([['OPS/img/a.png','blob:owned']]))).toContain('src="blob:owned"');});
 it.each(['//host/x','https://host/x','../../escape','C:\\file'])('rejects external/path escape %s',path=>expect(resolveInternal('OPS/ch.xhtml',path)).toBeNull());
 it('distinguishes font obfuscation from DRM',()=>{const files={'mimetype':strToU8('application/epub+zip'),'META-INF/container.xml':strToU8('<container><rootfile full-path="book.opf"/></container>'),'book.opf':strToU8('<package><manifest><item id="c" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>'),'ch.xhtml':strToU8('<html><head/><body>Hello</body></html>'),'META-INF/encryption.xml':strToU8('<encryption><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></encryption>')};const safe=prepareSafeEpub(files);expect(safe.warnings.join(' ')).toContain('Обфусцированные');safe.dispose();files['META-INF/encryption.xml']=strToU8('<encryption><EncryptionMethod Algorithm="AES"/></encryption>');expect(()=>prepareSafeEpub(files)).toThrow(/DRM/);});
});
