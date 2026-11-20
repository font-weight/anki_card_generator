import {safeArchivePath,ZIP_LIMITS} from './archive';
import {COVER_SOURCE_BYTES,COVER_XML_BYTES} from './cover-archive';
import {resolveInternal} from './epub-security';

type ReadEntry=(path:string,limit:number)=>Promise<Uint8Array|null>;
const elements=(node:Document|Element,name:string)=>Array.from(node.getElementsByTagNameNS('*',name));
function parseXml(bytes:Uint8Array|null) {
 if(!bytes)return null;
 let text:string;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
 // A plain XHTML/OPF doctype may identify a DTD. Discard it before parsing;
 // never resolve a public/system identifier or accept internal declarations.
 if(/<!\s*ENTITY\b|<!DOCTYPE[^>]*\[/i.test(text))return null;
 text=text.replace(/<!DOCTYPE[^>]*>/gi,'');
 const doc=new DOMParser().parseFromString(text,'application/xml');
 return elements(doc,'parsererror').length?null:doc;
}
const raster=new Set(['image/png','image/jpeg','image/gif','image/webp']);

/** Parse metadata in detached XML documents. Never render or navigate to book markup. */
export async function readEpubCover(read:ReadEntry):Promise<{bytes:Uint8Array;mime:string}|null> {
 const mime=await read('mimetype',64);
 if(!mime || new TextDecoder().decode(mime).trim()!=='application/epub+zip')return null;
 const container=parseXml(await read('META-INF/container.xml',COVER_XML_BYTES));
 const root=container && elements(container,'rootfile')[0]?.getAttribute('full-path');
 if(!root)return null;
 let rootPath:string;
 try{rootPath=safeArchivePath(root);}catch{return null;}
 const opf=parseXml(await read(rootPath,COVER_XML_BYTES));
 if(!opf || opf.documentElement.localName!=='package')return null;
 const manifest=elements(opf,'manifest')[0];
 if(!manifest)return null;
 const items=Array.from(manifest.children).filter(el=>el.localName==='item');
 const has=(el:Element,token:string)=>(el.getAttribute('properties')||'').split(/\s+/).includes(token);
 const legacy=elements(opf,'meta').find(el=>el.getAttribute('name')==='cover')?.getAttribute('content');
 const guide=elements(opf,'reference').find(el=>el.getAttribute('type')==='cover')?.getAttribute('href');
 const pathOf=(item:Element)=>resolveInternal(root,item.getAttribute('href')||'');
 let cover=items.find(item=>has(item,'cover-image')) || (legacy?items.find(item=>item.getAttribute('id')===legacy):undefined);
 if(!cover && guide){const path=resolveInternal(root,guide);if(path)cover=items.find(item=>pathOf(item)===path);}
 if(!cover || has(cover,'remote-resources'))return null;
 let path=pathOf(cover),type=cover.getAttribute('media-type');
 if(!path)return null;
 const encryption=await read('META-INF/encryption.xml',COVER_XML_BYTES);
 const encryptedPaths=new Set<string>();
 if(encryption){
  const doc=parseXml(encryption);
  if(!doc)return null;
  const methods=elements(doc,'EncryptionMethod');
  if(!methods.length || methods.some(el=>!['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(el.getAttribute('Algorithm')||'')))return null;
  for(const ref of elements(doc,'CipherReference')){
   const local=resolveInternal('',ref.getAttribute('URI')||'');
   if(!local)return null;
   encryptedPaths.add(local);
  }
 }
 if(encryptedPaths.has(path))return null;
 if(type==='application/xhtml+xml'){
  const wrapper=parseXml(await read(path,COVER_XML_BYTES));
  const image=wrapper && elements(wrapper,'img')[0]?.getAttribute('src');
  if(!image)return null;
  path=resolveInternal(path,image);
  if(!path || encryptedPaths.has(path))return null;
  cover=items.find(item=>pathOf(item)===path);
  if(!cover || has(cover,'remote-resources'))return null;
  type=cover.getAttribute('media-type');
 }
 if(!type || !raster.has(type))return null;
 const bytes=await read(path,COVER_SOURCE_BYTES);
 return bytes?{bytes,mime:type}:null;
}

export async function extractEpubCover(blob:Blob){
 if(!blob.size || blob.size>ZIP_LIMITS.archive)return null;
 let source:ArrayBuffer|undefined=await blob.arrayBuffer();
 const worker=new Worker(new URL('./cover-archive.worker.ts',import.meta.url),{type:'module'});
 let pending:((reason:Error)=>void)|undefined;
 const timeout=setTimeout(()=>{worker.terminate();pending?.(new Error('Cover processing timed out'));},15000);
 try{
  return await readEpubCover((path,limit)=>new Promise((resolve,reject)=>{
   pending=reject;
   worker.onmessage=event=>resolve(event.data.error?null:event.data.bytes);
   worker.onerror=()=>reject(new Error('Cover processing failed'));
   worker.postMessage({source,path,limit},source?[source]:[]);
   source=undefined;
  }));
 } finally {clearTimeout(timeout);worker.terminate();}
}
