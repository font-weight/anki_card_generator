import { zipSync, strFromU8, strToU8 } from 'fflate';
import { safeArchivePath } from './archive';
const allowed=new Set('html head title body p div span br hr h1 h2 h3 h4 h5 h6 blockquote pre code em strong b i u s sub sup ul ol li dl dt dd table thead tbody tfoot tr th td caption a img figure figcaption section article aside nav header footer main ruby rt rp'.split(' '));
const decoder=(x:Uint8Array)=>strFromU8(x);
export function resolveInternal(base:string,value:string):string|null {
 if(!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/') || value.includes('\\'))return null;
 try { const path=decodeURIComponent(value.split(/[?#]/)[0]);const parts=base.split('/').slice(0,-1);for(const p of path.split('/')){if(p==='..'){if(!parts.length)return null;parts.pop();}else if(p&&p!=='.')parts.push(p);}return safeArchivePath(parts.join('/')); }catch{return null;}
}
function xml(text:string):Document { if(/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text))throw new Error('Пользовательские XML entities запрещены');text=text.replace(/<!DOCTYPE[^>]*>/gi,''); const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Повреждённый XML EPUB');return doc; }
export function sanitizeChapter(text:string,path:string,images:Map<string,string>):string {
 // Parse inert XML, never insert unsanitized nodes into a live document.
 const doc=xml(text);
 for(const element of Array.from(doc.querySelectorAll('*'))){
  const tag=element.localName.toLowerCase();
  if(!allowed.has(tag)){element.remove();continue;}
  for(const attr of Array.from(element.attributes)){
   const name=attr.name.toLowerCase(),value=attr.value;
   if(['id','title','lang','xml:lang','dir','colspan','rowspan'].includes(name))continue;
   if(name==='xmlns'&&value==='http://www.w3.org/1999/xhtml')continue;
   if(name==='xmlns:epub'&&value==='http://www.idpf.org/2007/ops')continue;
   if(name==='epub:type'&&/^[a-z -]+$/.test(value))continue;
   if(tag==='a'&&name==='href'){
    if(value.startsWith('#'))continue;
    const internal=resolveInternal(path,value);if(internal){continue;}
    // External links are not navigable; trusted parent offers confirmation.
    if(/^https?:\/\//i.test(value)){element.setAttribute('data-external-link',value);}
   }
   if(tag==='img'&&name==='src'){ const resource=resolveInternal(path,value);const url=resource&&images.get(resource);if(url){element.setAttribute('src',url);continue;} }
   element.removeAttribute(attr.name);
  }
  if(tag==='a'&&element.hasAttribute('data-external-link')){element.setAttribute('role','link');element.setAttribute('tabindex','0');}
 }
 const head=doc.querySelector('head');
 const policy=doc.createElementNS('http://www.w3.org/1999/xhtml','meta');policy.setAttribute('http-equiv','Content-Security-Policy');policy.setAttribute('content',"default-src 'none'; img-src blob:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'");head?.prepend(policy);
 return new XMLSerializer().serializeToString(doc);
}
function imageMime(data:Uint8Array):string|null{
 if(data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71)return 'image/png';
 if(data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
 if(String.fromCharCode(...data.slice(0,6)).match(/^GIF8[79]a$/))return 'image/gif';
 if(String.fromCharCode(...data.slice(0,4))==='RIFF'&&String.fromCharCode(...data.slice(8,12))==='WEBP')return 'image/webp';return null;
}
export interface SafeEpub { data:ArrayBuffer; dispose():void; warnings:string[] }
export function prepareSafeEpub(files:Record<string,Uint8Array>):SafeEpub {
 const warnings=['Стили, SVG, встроенные шрифты и интерактивность книги отключены для безопасного чтения.'];
 const mimetype=files.mimetype&&decoder(files.mimetype).trim();if(mimetype!=='application/epub+zip')throw new Error('Это не EPUB');
 const container=files['META-INF/container.xml'];if(!container)throw new Error('Нет контейнера EPUB');
 const root=xml(decoder(container)).querySelector('rootfile')?.getAttribute('full-path');if(!root||!files[safeArchivePath(root)])throw new Error('Нет пакета EPUB');
 const packageDoc=xml(decoder(files[root]));
 if(Array.from(packageDoc.querySelectorAll('meta')).some(m=>m.getAttribute('property')==='rendition:layout'&&m.textContent?.trim()==='pre-paginated'))throw new Error('Fixed-layout EPUB не поддерживается');
 if(Array.from(packageDoc.querySelectorAll('[properties]')).some(n=>(n.getAttribute('properties')||'').includes('rendition:layout-pre-paginated')))throw new Error('Fixed-layout EPUB не поддерживается');
 const encryption=files['META-INF/encryption.xml'];if(encryption){
  const methods=Array.from(xml(decoder(encryption)).getElementsByTagNameNS('*','EncryptionMethod'));
  if(methods.some(m=>!['http://www.idpf.org/2008/embedding','http://ns.adobe.com/pdf/enc#RC'].includes(m.getAttribute('Algorithm')||'')))throw new Error('EPUB с DRM/шифрованием не поддерживается');
  warnings.push('Обфусцированные шрифты заменены системным шрифтом.');
 }
 const images=new Map<string,string>(),urls:string[]=[];
 try {
  for(const [path,bytes] of Object.entries(files)){const mime=imageMime(bytes);if(mime){const url=URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime}));images.set(path,url);urls.push(url);}}
  const clean:Record<string,Uint8Array>={mimetype:strToU8('application/epub+zip'),'META-INF/container.xml':container};
  for(const item of Array.from(packageDoc.getElementsByTagNameNS('*','item'))){
   const href=item.getAttribute('href')||'',path=resolveInternal(root,href),mime=item.getAttribute('media-type');
   if(!path||!files[path])throw new Error('Внешний или отсутствующий ресурс в манифесте EPUB');
   const properties=item.getAttribute('properties')||'';
   if(properties.split(/\s+/).includes('remote-resources'))throw new Error('Внешние ресурсы EPUB запрещены');
   item.removeAttribute('fallback');item.removeAttribute('media-overlay');
   if(mime==='application/xhtml+xml'||mime==='text/html'){clean[path]=strToU8(sanitizeChapter(decoder(files[path]),path,images));}
   else if(mime==='application/x-dtbncx+xml'){const ncx=xml(decoder(files[path]));for(const content of Array.from(ncx.getElementsByTagNameNS('*','content'))){if(!resolveInternal(path,content.getAttribute('src')||''))content.removeAttribute('src');}clean[path]=strToU8(new XMLSerializer().serializeToString(ncx));}
   else { item.remove(); }
  }
  // Remove bindings and non-content package links; no extension execution hooks.
  for(const node of Array.from(packageDoc.querySelectorAll('bindings, link')))node.remove();
  clean[root]=strToU8(new XMLSerializer().serializeToString(packageDoc));
  const zipped=zipSync(clean,{level:0});return {data:zipped.buffer as ArrayBuffer,dispose:()=>urls.forEach(URL.revokeObjectURL),warnings};
 }catch(error){urls.forEach(URL.revokeObjectURL);throw error;}
}
export function unpackEpub(data:ArrayBuffer):Promise<Record<string,Uint8Array>>{
 return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./archive.worker.ts',import.meta.url),{type:'module'});const timeout=setTimeout(()=>{worker.terminate();reject(new Error('Превышено время распаковки EPUB'));},30000);worker.onmessage=e=>{clearTimeout(timeout);worker.terminate();e.data.ok?resolve(e.data.files):reject(new Error(e.data.error));};worker.onerror=()=>{clearTimeout(timeout);worker.terminate();reject(new Error('Ошибка обработки EPUB'));};worker.postMessage(data,[data]);});
}
