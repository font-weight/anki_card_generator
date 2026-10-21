// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {strFromU8} from 'fflate';
import {convertFb2ToEpub, FB2_LIMITS} from '../../apps/extension/src/readers/fb2';
import {extractBounded} from '../../apps/extension/src/readers/archive';
const source = (language = 'en-US', title = 'A small book', heading = 'Chapter') => `<FictionBook><description><title-info><book-title>${title}</book-title><lang>${language}</lang></title-info></description><body><section><title><p>${heading}</p></title><p>Hello café 😀.</p></section><section><p>Next.</p></section></body></FictionBook>`;
const buffer = (text: string) => new TextEncoder().encode(text).buffer;
const bytes = (blob: Blob) => new Promise<ArrayBuffer>((resolve,reject) => {const reader = new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=reject;reader.readAsArrayBuffer(blob);});

describe('FB2 complete output budget using small ordinary documents', () => {
 it('rejects overlength metadata before any output generation', async () => {
  const cases = [source('a'.repeat(FB2_LIMITS.languageCharacters + 1)),source('en-US','t'.repeat(FB2_LIMITS.metadataCharacters + 1)),source('en-US','Book','h'.repeat(FB2_LIMITS.metadataCharacters + 1)),source().replace('<body>','<body name="'+'n'.repeat(FB2_LIMITS.metadataCharacters + 1)+'">')];
  for (const text of cases) await expect(convertFb2ToEpub(buffer(text),'Book',{maxOutputBytes:1})).rejects.toThrow(/метаданных/);
 });
 it('retains ordinary language metadata and deterministic output at the exact UTF-8 boundary', async () => {
  const input = buffer(source());const normal = await convertFb2ToEpub(input);
  const normalBytes = await bytes(normal.blob);const files = extractBounded(new Uint8Array(normalBytes));
  const total = Object.values(files).reduce((sum,file) => sum + file.byteLength,0);
  expect(strFromU8(files['OPS/chapter-1.xhtml'])).toContain('xml:lang="en-US"');
  const exact = await convertFb2ToEpub(input,'Book',{maxOutputBytes:total});
  expect(await bytes(exact.blob)).toEqual(normalBytes);
  await expect(convertFb2ToEpub(input,'Book',{maxOutputBytes:total-1})).rejects.toThrow(/размер результата/);
 });
 it('accounts for every wrapper, navigation, package, container and MIME byte, not only body text', async () => {
  const input = buffer(source());const normal = await convertFb2ToEpub(input);const files = extractBounded(new Uint8Array(await bytes(normal.blob)));
  const total = Object.values(files).reduce((sum,file) => sum+file.byteLength,0);
  for (const path of ['mimetype','META-INF/container.xml','OPS/nav.xhtml','OPS/book.opf']) {
   await expect(convertFb2ToEpub(input,'Book',{maxOutputBytes:total-files[path].byteLength})).rejects.toThrow(/размер результата/);
  }
  const visibleTextBytes = new TextEncoder().encode('ChapterHello café 😀.Next.').byteLength;
  await expect(convertFb2ToEpub(input,'Book',{maxOutputBytes:visibleTextBytes})).rejects.toThrow(/размер результата/);
 });
 it('allows only a lowered positive finite output budget', async () => {
  for (const maxOutputBytes of [0,-1,1.5,Infinity,FB2_LIMITS.outputBytes+1]) await expect(convertFb2ToEpub(buffer(source()),'Book',{maxOutputBytes})).rejects.toThrow(/предел размера/);
 });
});
