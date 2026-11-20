import {afterEach,expect,it,vi} from 'vitest';
import {strToU8,zipSync} from 'fflate';
import {readFileSync} from 'node:fs';
import {Blob as NodeBlob} from 'node:buffer';
import {indexCoverArchive} from '../../apps/extension/src/readers/cover-archive';
import {readEpubCover} from '../../apps/extension/src/readers/epub-cover';
import {readFb2Cover} from '../../apps/extension/src/readers/fb2';
import {extractBookThumbnail,makeThumbnail} from '../../apps/extension/src/readers/book-thumbnail';

const png=new Uint8Array(readFileSync('tests/fixtures/quiet-coast-cover.png'));
const manifestItem='<item id="cover" href="../Art/Coast%20Cover.png" media-type="image/png"/>';
const legacyMetadata='<metadata><meta name="cover" content="cover"/></metadata>';
const titleCover='<coverpage><image l:href="#cover"/></coverpage>';
afterEach(()=>vi.unstubAllGlobals());

function archive(options:{manifest?:string;metadata?:string;guide?:string;extra?:Record<string,Uint8Array>}={}){
 const files={
  mimetype:strToU8('application/epub+zip'),
  'META-INF/container.xml':strToU8('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
  'OPS/book.opf':strToU8('<package>'+(options.metadata||'')+'<manifest>'+(options.manifest??manifestItem)+'</manifest>'+(options.guide||'')+'</package>'),
  'Art/Coast Cover.png':png,...options.extra,
 };
 const read=indexCoverArchive(zipSync(files).buffer as ArrayBuffer);
 return vi.fn(async(path:string,limit:number)=>read(path,limit));
}
const fb=(page=titleCover,mime='image/png')=>new NodeBlob(['<FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info>'+page+
 '</title-info></description><body><p>One.</p></body><binary id="cover" content-type="'+mime+'">'+Buffer.from(png).toString('base64')+'</binary></FictionBook>']) as unknown as Blob;

it('extracts only the declared EPUB 3 or EPUB 2 cover from a compressed archive',async()=>{
 for(const options of [{manifest:manifestItem.replace('id="cover"','properties="nav cover-image" id="cover"')},{metadata:legacyMetadata}]){
  const read=archive(options),result=await readEpubCover(read);
  expect(result?.bytes).toEqual(png);expect(result?.mime).toBe('image/png');
  expect(read.mock.calls.map(([path])=>path)).toEqual(['mimetype','META-INF/container.xml','OPS/book.opf','META-INF/encryption.xml','Art/Coast Cover.png']);
 }
});
it('resolves a local EPUB 2 guide wrapper without rendering book markup',async()=>{
 const read=archive({manifest:manifestItem+'<item href="front.xhtml" media-type="application/xhtml+xml"/>',guide:'<guide><reference type="cover" href="front.xhtml"/></guide>',
  extra:{'OPS/front.xhtml':strToU8('<!DOCTYPE html><html><body><img src="../Art/Coast%20Cover.png"/></body></html>')}});
 expect((await readEpubCover(read))?.bytes).toEqual(png);
});
it('uses fallback when the identified resource is missing, remote, SVG, traversal above root, or encrypted',async()=>{
 for(const manifest of [manifestItem,manifestItem.replace('image/png','image/svg+xml'),manifestItem.replace('../Art/Coast%20Cover.png','absent.jpg'),
  manifestItem.replace('../Art/Coast%20Cover.png','https://example.invalid/cover.png'),manifestItem.replace('../Art/Coast%20Cover.png','../../above.png')]){
  const read=archive({manifest,metadata:manifest===manifestItem?'':legacyMetadata});
  expect(await readEpubCover(read)).toBeNull();
  expect(read.mock.calls.every(([path])=>!path.includes('://')&&!path.includes('..'))).toBe(true);
 }
 const encrypted=archive({metadata:legacyMetadata,extra:{'META-INF/encryption.xml':strToU8('<encryption><EncryptionMethod Algorithm="unknown"/></encryption>')}});
 expect(await readEpubCover(encrypted)).toBeNull();
});
it('reads only a linked FB2 title cover; missing, remote and unsupported types stay out',async()=>{
 expect((await readFb2Cover(fb()))?.bytes).toEqual(png);
 expect(await readFb2Cover(fb(''))).toBeNull();
 expect(await readFb2Cover(fb(titleCover,'image/svg+xml'))).toBeNull();
 await expect(readFb2Cover(fb(titleCover.replace('#cover','https://example.invalid/cover')))).rejects.toThrow();
});
it('validates declared raster type and dimensions before decode, and requires successful decoding',async()=>{
 const bitmap=vi.fn().mockRejectedValue(new Error('invalid raster'));
 vi.stubGlobal('createImageBitmap',bitmap);
 const huge=png.slice();new DataView(huge.buffer).setUint32(16,65536);
 expect(await makeThumbnail({mime:'image/png',bytes:huge})).toBeNull();
 expect(await makeThumbnail({mime:'image/jpeg',bytes:png})).toBeNull();
 expect(await makeThumbnail({mime:'image/png',bytes:strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')})).toBeNull();
 expect(await extractBookThumbnail('pdf',fb())).toBeNull();
 expect(bitmap).not.toHaveBeenCalled();
 expect(await makeThumbnail({mime:'image/png',bytes:png})).toBeNull();
 expect(bitmap).toHaveBeenCalledOnce();
});
it('caps decoded dimensions again and closes every decoded bitmap',async()=>{
 const close=vi.fn();
 vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue({width:10000,height:10000,close}));
 expect(await makeThumbnail({mime:'image/png',bytes:png})).toBeNull();expect(close).toHaveBeenCalledOnce();
});
