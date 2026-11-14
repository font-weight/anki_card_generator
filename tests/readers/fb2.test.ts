// @vitest-environment jsdom
import {Blob as NodeBlob} from 'node:buffer';
import {describe, it, expect, vi} from 'vitest';
import {strFromU8} from 'fflate';
import {convertFb2ToEpub, FB2_LIMITS, FB2_MAX_BYTES} from '../../apps/extension/src/readers/fb2';
import {extractBounded} from '../../apps/extension/src/readers/archive';
import {prepareSafeEpub} from '../../apps/extension/src/readers/epub-security';
const envelope = (body: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>Книга &amp; книга</book-title><lang>ru</lang></title-info></description><body>${body}</body>${extra}</FictionBook>`;
const buffer = (text: string) => new TextEncoder().encode(text).buffer;
const convert = (text: string) => convertFb2ToEpub(buffer(text));
async function blobBytes(blob: Blob) {return new Promise<ArrayBuffer>((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob);});}
async function unpack(text: string) {const result = await convert(text);return {...result, files: extractBounded(new Uint8Array(await blobBytes(result.blob)))};}
function xml(bytes: Uint8Array) {return new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');}

describe('local bounded FB2 text conversion', () => {
 it('preserves exact parsed UTF-16 text, inline emphasis and whitespace; produces safe chapter navigation', async () => {
  const text = '  café\t & < >  😀 e\u0301\n末尾  ';
  const input = envelope(`<section id="one"><title><p>Глава один</p></title><p>${text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}<emphasis>  bold\t </emphasis> tail</p><p><![CDATA["<literal>" & text]]></p><p><a l:href="#two">Далее</a></p></section><section id="two"><title><p>Глава два</p></title><p>Second.</p></section>`);
  const {title, files, warnings} = await unpack(input);
  expect(title).toBe('Книга & книга'); expect(warnings).toEqual([]);
  const first = xml(files['OPS/chapter-1.xhtml']);
  expect(first.querySelector('p')?.textContent).toBe(text + '  bold\t  tail');
  expect(first.querySelector('em')?.textContent).toBe('  bold\t ');
  expect(first.querySelector('h2')?.textContent).toBe('Глава один');
  expect(first.querySelectorAll('p')[1].textContent).toBe('"<literal>" & text');
  expect(first.querySelector('a')?.getAttribute('href')).toMatch(/^chapter-2.xhtml#fb2-id-/);
  expect(xml(files['OPS/nav.xhtml']).querySelectorAll('nav a')).toHaveLength(2);
  const safe = prepareSafeEpub(files);
  const sanitized = extractBounded(new Uint8Array(safe.data));
  expect(xml(sanitized['OPS/chapter-1.xhtml']).querySelector('p')?.textContent).toBe(text + '  bold\t  tail');
  safe.dispose();
 });
 it('preserves numeric carriage-return references, tabs and newlines through conversion', async () => {
  const {files} = await unpack(envelope('<p>A&#13;B&#x9;C&#10;D</p>'));
  expect(xml(files['OPS/chapter-1.xhtml']).querySelector('p')?.textContent).toBe('A\rB\tC\nD');
 });
 it('produces byte-for-byte deterministic EPUBs and stable generated IDs', async () => {
  const source = envelope('<section id="x"><p>A test.</p></section>');
  const first = await convert(source);const firstBytes = new Uint8Array(await blobBytes(first.blob));
  vi.useFakeTimers();vi.setSystemTime(new Date('2030-10-12T13:56:44Z'));
  try {const second = await convert(source);vi.useRealTimers();expect(new Uint8Array(await blobBytes(second.blob))).toEqual(firstBytes);} finally {vi.useRealTimers();}
 });
 it('accepts a Blob without changing its original contents', async () => {
  const source = envelope('<p>Original text.</p>'); const original = new NodeBlob([source], {type:'application/x-fictionbook+xml'});
  const result = await convertFb2ToEpub(original as Blob);
  expect(result.blob.type).toBe('application/epub+zip');expect(await original.text()).toBe(source);
 });
 it('explicitly supports declared Windows-1251 and BOM UTF-16', async () => {
  const prefix = envelope('<p>TEXT</p>').replace('UTF-8','windows-1251').replace('Книга &amp; книга','Book');
  const cp = Uint8Array.from([...prefix.replace('TEXT','Привет')].map(c => c.charCodeAt(0) >= 0x410 && c.charCodeAt(0) <= 0x44f ? c.charCodeAt(0) - 0x350 : c.charCodeAt(0)));
  const result = await convertFb2ToEpub(cp.buffer);const files = extractBounded(new Uint8Array(await blobBytes(result.blob)));
  expect(xml(files['OPS/chapter-1.xhtml']).querySelector('p')?.textContent).toBe('Привет');
  const utf16 = envelope('<p>Привет 😀</p>').replace('UTF-8','UTF-16');
  for (const littleEndian of [true,false]) {
   const bytes = new Uint8Array(utf16.length * 2 + 2); const view = new DataView(bytes.buffer);view.setUint16(0, 0xfeff, littleEndian);
   for (let i=0;i<utf16.length;i++) view.setUint16(i*2+2, utf16.charCodeAt(i), littleEndian);
   const converted = await convertFb2ToEpub(bytes.buffer);const unpacked = extractBounded(new Uint8Array(await blobBytes(converted.blob)));
   expect(xml(unpacked['OPS/chapter-1.xhtml']).querySelector('p')?.textContent).toBe('Привет 😀');
  }
 });
 it('rejects unsupported, malformed, or contradictory encodings rather than corrupting text', async () => {
  await expect(convert(envelope('<p>text</p>').replace('UTF-8','KOI8-R'))).rejects.toThrow(/Кодировка/);
  await expect(convertFb2ToEpub(Uint8Array.from([0xff,0x61]).buffer)).rejects.toThrow(/кодировк/);
  const mismatch = new Uint8Array([0xef,0xbb,0xbf,...new TextEncoder().encode(envelope('<p>text</p>').replace('UTF-8','windows-1251'))]);
  await expect(convertFb2ToEpub(mismatch.buffer)).rejects.toThrow(/не совпадают/);
 });
 it.each([
  '<!DOCTYPE FictionBook SYSTEM "https://evil.example/book.dtd">',
  '<!DOCTYPE FictionBook [<!ENTITY local SYSTEM "file:///etc/passwd">]>',
  '<!ENTITY bomb "ha">',
  '<?xml-stylesheet href="https://evil.example/style.xsl"?>',
 ])('rejects DTD/entities and processing instructions before XML parsing: %s', async hostile => {
  await expect(convert(hostile + envelope('<p>text</p>'))).rejects.toThrow(/DTD|entities|Инструкции/);
 });
 it.each([
  '<image l:href="https://evil.example/pixel.png"/>',
  '<a l:href="file:///private/book">secret</a>',
  '<a l:href="javascript:alert(1)">x</a>',
  '<p xml:base="https://evil.example/">text</p>',
  '<include xmlns="http://www.w3.org/2001/XInclude" href="file:///etc/passwd"/>',
  '<image href="//evil.example/image"/>',
 ])('rejects external resources and foreign namespaces: %s', async hostile => {
  await expect(convert(envelope('<p>text</p>' + hostile))).rejects.toThrow(/Внешние/);
 });
 it('emits only controlled markup; omits styles and images with an explicit warning and never decodes attachments', async () => {
  const {files,warnings} = await unpack(envelope('<section id="x"><p onclick="evil()" style="background:url(https://bad)">Safe <strong>bold</strong></p><image l:href="#image"/><script>bad()</script><p><a l:href="#missing">Note</a></p></section>', '<binary id="image" content-type="image/svg+xml">PHN2Zy8+</binary><stylesheet>body{background:url(https://bad)}</stylesheet>'));
  const chapter = strFromU8(files['OPS/chapter-1.xhtml']);
  expect(chapter).not.toMatch(/onclick|style=|https:|<img|<script|bad\(\)/);expect(chapter).toContain('<strong>bold</strong>');
  expect(warnings.join(' ')).toMatch(/Изображения и вложения/);expect(warnings.join(' ')).toMatch(/стили/);expect(warnings.join(' ')).toMatch(/внутренних ссылок/);
 });
 it('does not resolve inherited object property names as markup tags', async () => {
  const {files,warnings} = await unpack(envelope('<constructor>one</constructor><toString>two</toString><__proto__>three</__proto__>'));
  const chapter = xml(files['OPS/chapter-1.xhtml']);
  expect(chapter.querySelector('parsererror')).toBeNull();expect(chapter.querySelector('body')?.textContent).toBe('onetwothree');
  expect(warnings.join(' ')).toMatch(/Неподдерживаемая разметка/);
 });
 it('rejects invalid XML, wrong roots, duplicate IDs, empty bodies and malformed attachments', async () => {
  for (const source of ['<FictionBook><body><p>text</body></FictionBook>','<html><body>text</body></html>',envelope(' '),envelope('<p id="x">A</p><p id="x">B</p>'),envelope('<p>text</p>','<binary>abc</binary>')]) await expect(convert(source)).rejects.toThrow();
 });
 it('bounds input, nesting, elements, chapters and attachment size before expensive work', async () => {
  await expect(convertFb2ToEpub(new ArrayBuffer(FB2_MAX_BYTES + 1))).rejects.toThrow(/16 MiB/);
  await expect(convert(envelope('<section>'.repeat(FB2_LIMITS.depth) + '<p>text</p>' + '</section>'.repeat(FB2_LIMITS.depth)))).rejects.toThrow(/глубина/);
  await expect(convert(envelope('<p/>'.repeat(FB2_LIMITS.elements)))).rejects.toThrow(/элементов/);
  await expect(convert(envelope('<!-- -->'.repeat(FB2_LIMITS.nodes)))).rejects.toThrow(/узлов/);
  await expect(convert(envelope('<![CDATA[x]]>'.repeat(FB2_LIMITS.nodes)))).rejects.toThrow(/узлов/);
  await expect(convert(envelope('<section><p>text</p></section>'.repeat(FB2_LIMITS.chapters + 1)))).rejects.toThrow(/много глав/);
  await expect(convert(envelope('<p>text</p>','<binary>' + 'A'.repeat(FB2_LIMITS.attachmentCharacters + 4) + '</binary>'))).rejects.toThrow(/размер вложений/);
 });
 it('treats angle brackets inside CDATA/comments/quoted attributes as text during depth preflight', async () => {
  const {files} = await unpack(envelope('<p data-note="&lt;section>"><![CDATA[<section>literal</section>]]><!-- <section> --></p>'));
  expect(xml(files['OPS/chapter-1.xhtml']).querySelector('p')?.textContent).toBe('<section>literal</section>');
 });
});
