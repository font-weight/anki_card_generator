import { zipSync, strFromU8, strToU8 } from 'fflate';
import { safeArchivePath } from './archive';
const allowed=new Set('html head title body p div span br hr h1 h2 h3 h4 h5 h6 blockquote pre code em strong b i u s sub sup ul ol li dl dt dd table thead tbody tfoot tr th td caption a img figure figcaption section article aside nav header footer main ruby rt rp'.split(' '));
const decoder=(x:Uint8Array)=>strFromU8(x);
export function resolveInternal(base:string,value:string):string|null {
 if(!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('/') || value.includes('\\'))return null;
 try { const path=decodeURIComponent(value.split(/[?#]/)[0]);const parts=base.split('/').slice(0,-1);for(const p of path.split('/')){if(p==='..'){if(!parts.length)return null;parts.pop();}else if(p&&p!=='.')parts.push(p);}return safeArchivePath(parts.join('/')); }catch{return null;}
}
function xml(text:string):Document { if(/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text))throw new Error('Пользовательские XML entities запрещены');text=text.replace(/<!DOCTYPE[^>]*>/gi,''); const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('Повреждённый XML EPUB');return doc; }
type HeadingHint = 'label' | 'title' | 'subtitle' | 'larger';
const headingBlocks = 'p,div,h1,h2,h3,h4,h5,h6';
const inlineHeadingChild = new Set('span br em strong b i u s sub sup a ruby rt rp'.split(' '));
const labelClass = /^(?:kicker|eyebrow|(?:chapter|chap|part)[-_]?(?:label|number|num)|preface-label)$/;
const titleClass = /^(?:title|heading|(?:book|chapter|chap|part|section)[-_]?(?:title|heading|head)|h[12]|heading[12])$/;
const subtitleClass = /^(?:sub[-_]?title|sub[-_]?head(?:ing)?|h3|heading3)$/;
const headingSizeBounds:Record<string,readonly [number,number]>={em:[1.1,3],'%':[110,300],pt:[14,36],px:[19,48]};
function headingHint(element:Element,rules:string[]):HeadingHint|undefined {
 const tokens=(element.getAttribute('class')||'').toLowerCase().split(/\s+/);
 if(tokens.some(token=>labelClass.test(token)))return 'label';
 if(tokens.some(token=>subtitleClass.test(token)))return 'subtitle';
 if(tokens.some(token=>titleClass.test(token)))return 'title';
 for(const rule of rules){
  if(/^font-size\s*:\s*(?:large|x-large|xx-large)$/.test(rule))return 'larger';
  const size=/^font-size\s*:\s*(\d{1,3}(?:\.\d{1,2})?)\s*(em|%|pt|px)$/.exec(rule);
  if(!size)continue;
  const value=Number(size[1]);
  const [minimum,maximum]=headingSizeBounds[size[2]];
  if(value>=minimum && value<=maximum)return 'larger';
 }
}
function plainHeadingBlock(element:Element):boolean {
 return !element.closest('nav,blockquote,table,figure,aside,li,pre') &&
  Array.from(element.children).every(child=>inlineHeadingChild.has(child.localName));
}
// Old conversions often split a chapter opener into identically tagged paragraphs.
// Only recognize an unmarked title line in the small opening group following a known book label.
const openingLabel = /^(?:preface|foreword|prologue|epilogue|introduction|предисловие|введение|пролог|эпилог|(?:part|chapter|часть|глава)\s+(?:[ivxlcdm]+|[0-9]{1,4}|one|two|three|four|five|six|seven|eight|nine|ten))$/iu;
function annotateHeadings(doc:Document,hints:Map<Element,HeadingHint>):void {
 for(const [source,hint] of hints){
  const block=source.closest(headingBlocks);
  if(!block || !plainHeadingBlock(block) || (block!==source && block.textContent?.trim()!==source.textContent?.trim()))continue;
  if(hint==='larger' && !source.closest('[data-reader-align=center],[data-reader-weight=bold],strong,b') &&
   !block.querySelector('strong,b,[data-reader-weight=bold]'))continue;
  const text=block.textContent?.trim();
  if(text && text.length<=180 && !block.hasAttribute('data-reader-heading'))block.setAttribute('data-reader-heading',hint==='larger'?'title':hint);
 }
 const body=doc.getElementsByTagName('body')[0];
 if(!body)return;
 let label:Element|undefined,title:Element|undefined,lines=0;
 const gaps:Element[]=[];
 const walker=doc.createTreeWalker(body,NodeFilter.SHOW_ELEMENT);
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const block=node as Element;
  if(!block.matches(headingBlocks)||!plainHeadingBlock(block))continue;
  const text=(block.textContent||'').trim();
  if(!text){
   if((label||title) && !block.hasAttribute('id') && !block.querySelector('[id],a,img'))gaps.push(block);
   continue;
  }
  const hint=block.getAttribute('data-reader-heading');
  if(!label && !title && (hint==='label'||openingLabel.test(text))){
   block.setAttribute('data-reader-heading','label');label=block;continue;
  }
  if(label && !title && openingLabel.test(text)){
   // A part heading followed by a chapter heading keeps its original semantic levels.
   if(/^h[1-6]$/.test(label.localName))label.removeAttribute('data-reader-heading');
   break;
  }
  const shortLine=text.length<=76 && text.split(/\s+/).length<=12 && !/[.!?;:…。！？]$/u.test(text);
  if(!hint && !(label && (shortLine || /^h[1-3]$/.test(block.localName) && text.length<=180)))break;
  if(hint==='subtitle' || hint==='label' || lines>=2 || (title && title.localName!==block.localName))break;
  if(title)title.setAttribute('data-reader-heading-more','');
  block.setAttribute('data-reader-heading',title?'line':'title');
  title=block;lines++;
  for(const gap of gaps)gap.setAttribute('data-reader-heading-gap','');
  gaps.length=0;
 }
 // Empty layout paragraphs add no content between an opener and its first paragraph.
 if(title)for(const gap of gaps)gap.setAttribute('data-reader-heading-gap','');
}
export function sanitizeChapter(text:string,path:string,images:Map<string,string>):string {
 // Parse inert XML, never insert unsanitized nodes into a live document.
 const doc=xml(text),headingHints=new Map<Element,HeadingHint>();
 for(const element of Array.from(doc.querySelectorAll('*'))){
  const tag=element.localName.toLowerCase();
  if(!allowed.has(tag)){element.remove();continue;}
  const typography=(element.getAttribute('style')||'').split(';').map(rule=>rule.trim().toLowerCase());
  const align=element.getAttribute('align')?.trim().toLowerCase();
  const hint=headingHint(element,typography);
  if(hint)headingHints.set(element,hint);
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
  // Translate a few literal typographic intentions into inert, known attributes.
  // No CSS declaration, URL, font or selector supplied by the book is retained.
  if(align && /^(center|left|right|justify)$/.test(align))element.setAttribute('data-reader-align',align);
  for(const rule of typography){
   const align=/^text-align\s*:\s*(center|left|right|justify)$/.exec(rule);
   if(align)element.setAttribute('data-reader-align',align[1]);
   if(/^font-style\s*:\s*italic$/.test(rule))element.setAttribute('data-reader-emphasis','italic');
   if(/^font-weight\s*:\s*(bold|700)$/.test(rule))element.setAttribute('data-reader-weight','bold');
  }
  if(tag==='a'&&element.hasAttribute('data-external-link')){element.setAttribute('role','link');element.setAttribute('tabindex','0');}
 }
 annotateHeadings(doc,headingHints);
 const head=doc.querySelector('head');
 const policy=doc.createElementNS('http://www.w3.org/1999/xhtml','meta');policy.setAttribute('http-equiv','Content-Security-Policy');policy.setAttribute('content',"default-src 'none'; img-src blob:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'");head?.prepend(policy);
 // XMLSerializer emits CR text literally; another XML/HTML parse would turn it
 // into LF. Keep numeric references so selected text/context remains exact.
 return new XMLSerializer().serializeToString(doc).replace(/\r/g,'&#13;');
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
