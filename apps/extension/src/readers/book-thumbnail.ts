import {extractEpubCover} from './epub-cover';
import {readFb2Cover} from './fb2';
import {COVER_SOURCE_BYTES} from './cover-archive';
import {isBookThumbnail} from '@english-reader/storage';

type ImageSize={width:number;height:number};
const at=(b:Uint8Array,start:number,length:number)=>String.fromCharCode(...b.subarray(start,start+length));
const allowedSize=({width,height}:ImageSize)=>width>0 && height>0 && width<=8192 && height<=8192 && width*height<=16_000_000;

function rasterDimensions(b:Uint8Array,mime:string):ImageSize|null{
 if(b.length<12 || b.length>COVER_SOURCE_BYTES)return null;
 const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
 if(mime==='image/png' && b.length>=33 && at(b,0,8)==='\x89PNG\r\n\x1a\n' && view.getUint32(8)===13 && at(b,12,4)==='IHDR'){
  return {width:view.getUint32(16),height:view.getUint32(20)};
 }
 if(mime==='image/gif' && /^GIF8[79]a$/.test(at(b,0,6)))return {width:view.getUint16(6,true),height:view.getUint16(8,true)};
 if(mime==='image/webp' && at(b,0,4)==='RIFF' && at(b,8,4)==='WEBP' && b.length>=30){
  const kind=at(b,12,4);
  if(kind==='VP8 ' && at(b,23,3)==='\x9d\x01\x2a')return {width:view.getUint16(26,true)&16383,height:view.getUint16(28,true)&16383};
  if(kind==='VP8L' && b[20]===47){const size=view.getUint32(21,true);return {width:1+(size&16383),height:1+((size>>>14)&16383)};}
  if(kind==='VP8X')return {width:1+b[24]+(b[25]<<8)+(b[26]<<16),height:1+b[27]+(b[28]<<8)+(b[29]<<16)};
 }
 if(mime==='image/jpeg' && b[0]===255 && b[1]===216){
  for(let offset=2;offset+4<b.length;){
   if(b[offset++]!==255)return null;
   while(b[offset]===255)offset++;
   const marker=b[offset++];
   if(marker===0xda || marker===0xd9 || offset+2>b.length)return null;
   const size=view.getUint16(offset);
   if(size<2 || offset+size>b.length)return null;
   if([0xc0,0xc1,0xc2].includes(marker) && size>=8)return {width:view.getUint16(offset+5),height:view.getUint16(offset+3)};
   offset+=size;
  }
 }
 return null;
}

/** Decode a bounded raster and re-encode a single small frame. Original bytes are never an img source. */
export async function makeThumbnail(source:{bytes:Uint8Array;mime:string}):Promise<string|null>{
 const dimensions=rasterDimensions(source.bytes,source.mime);
 if(!dimensions || !allowedSize(dimensions))return null;
 const blob=new Blob([source.bytes as BlobPart],{type:source.mime});
 let bitmap:ImageBitmap;
 try{bitmap=await createImageBitmap(blob);}catch{return null;}
 try{
  if(!allowedSize(bitmap))return null;
  const scale=Math.min(1,352/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)return null;
  context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  if(source.mime==='image/png'){
   const lossless=canvas.toDataURL('image/png');
   if(isBookThumbnail(lossless))return lossless;
  }
  const thumbnail=canvas.toDataURL('image/jpeg',.85);
  return isBookThumbnail(thumbnail)?thumbnail:null;
 } finally{bitmap.close();}
}

export async function extractBookThumbnail(kind:'epub'|'fb2'|'pdf',blob:Blob):Promise<string|null>{
 if(kind==='pdf')return null;
 const cover=kind==='epub'?await extractEpubCover(blob):await readFb2Cover(blob).catch(error=>{
  if(error instanceof DOMException && error.name==='NotReadableError')throw error;
  return null;
 });
 return cover?makeThumbnail(cover):null;
}
