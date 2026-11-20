import {Unzip, UnzipInflate, type UnzipFile} from 'fflate';
import {safeArchivePath, ZIP_LIMITS} from './archive';

export const COVER_SOURCE_BYTES=8*1024*1024;
export const COVER_XML_BYTES=512*1024;

/** Index compressed entries once; inflate only the specific metadata and raster the OPF identifies. */
export function indexCoverArchive(buffer:ArrayBuffer) {
 const source=new Uint8Array(buffer), entries=new Map<string,UnzipFile>(), names=new Set<string>();
 if(!source.length || source.length>ZIP_LIMITS.archive)throw new Error('Invalid archive size');
 const unzip=new Unzip(file=>{
  const path=safeArchivePath(file.name), key=path.toLowerCase().replace(/\/$/,'');
  if(names.has(key) || names.size>=ZIP_LIMITS.entries)throw new Error('Invalid archive index');
  names.add(key);
  if(!path.endsWith('/'))entries.set(path,file);
 });
 unzip.register(UnzipInflate);
 for(let i=0;i<source.length;i+=4096)unzip.push(source.subarray(i,i+4096),i+4096>=source.length);
 return (path:string,limit:number):Uint8Array|null=>{
  const file=entries.get(path);
  if(!file)return null;
  if(limit<1 || limit>COVER_SOURCE_BYTES || file.originalSize!==undefined && file.originalSize>limit)throw new Error('Cover entry exceeds limit');
  const chunks:Uint8Array[]=[];
  let size=0,complete=false;
  file.ondata=(error,chunk,final)=>{
   if(error)throw error;
   size+=chunk.length;
   if(size>limit || size>Math.max(1,file.size??source.length)*ZIP_LIMITS.ratio)throw new Error('Cover entry exceeds limit');
   chunks.push(chunk);complete=final;
  };
  file.start();
  if(!complete)throw new Error('Incomplete cover entry');
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return bytes;
 };
}
