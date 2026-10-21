import {strToU8, zipSync} from 'fflate';

/** Plain FB2 only. Original bytes remain in storage; this is an ephemeral view. */
export const FB2_MAX_BYTES = 16 * 1024 * 1024;
export const FB2_LIMITS = {bytes: FB2_MAX_BYTES, depth: 96, elements: 100_000, nodes: 150_000, outputCharacters: 32 * 1024 * 1024, outputBytes: 32 * 1024 * 1024, metadataCharacters: 500, languageCharacters: 64, chapters: 2_000, attachmentCharacters: 2 * 1024 * 1024, totalAttachmentCharacters: 8 * 1024 * 1024} as const;
export interface ConvertedFb2 {blob: Blob; title: string; warnings: string[]}
/** Callers may lower, never raise, the complete generated UTF-8 budget. */
export interface Fb2ConversionOptions {maxOutputBytes?: number}
const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
// Used for text only; generated attributes never contain source strings.
const escapeXml = (value: string) => value.replace(/[&<>\r]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\r':'&#13;'}[c]!));
const element = (node: Node): node is Element => node.nodeType === 1;
const named = (parent: Element, name: string) => Array.from(parent.children).find(child => child.localName === name && child.namespaceURI === parent.namespaceURI);
const encodingName = (value: string) => ({'utf8':'utf-8','cp1251':'windows-1251'}[value.toLowerCase()] ?? value.toLowerCase());
function metadataText(value: string | null | undefined, limit: number = FB2_LIMITS.metadataCharacters): string {
 if (value && value.length > limit) throw new Error('Превышена безопасная длина метаданных FB2.');
 return value?.trim() ?? '';
}
/** Count before allocating encoded arrays. JS iteration preserves surrogate pairs. */
function utf8Length(value: string): number {
 let bytes = 0;
 for (const character of value) {const code = character.codePointAt(0)!;bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;}
 return bytes;
}


function decode(bytes: Uint8Array): string {
 if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 254 && bytes[3] === 255 || bytes[0] === 255 && bytes[1] === 254 && bytes[2] === 0 && bytes[3] === 0) throw new Error('Кодировка UTF-32 FB2 не поддерживается. Сохраните книгу в UTF-8.');
 const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? 'utf-8' : bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : null;
 const declaration = (text: string) => /^\s*<\?xml\s[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i.exec(text)?.[2];
 // Before decoding, read only ASCII declaration bytes; never silently guess a legacy encoding.
 const probe = String.fromCharCode(...bytes.subarray(0, 512));
 const declared = !bom ? declaration(probe) : undefined;
 const encoding = bom ?? (declared ? encodingName(declared) : 'utf-8');
 if (!['utf-8','windows-1251','utf-16le','utf-16be'].includes(encoding) || !bom && encoding.startsWith('utf-16')) throw new Error('Кодировка FB2 не поддерживается. Используйте UTF-8, Windows-1251 или UTF-16 с BOM.');
 if (!bom && (bytes[0] === 0 || bytes[1] === 0)) throw new Error('Для UTF-16 FB2 требуется BOM. Сохраните книгу в UTF-8.');
 let text: string;
 try { text = new TextDecoder(encoding, {fatal: true}).decode(bytes); } catch { throw new Error('Не удалось прочитать кодировку FB2. Сохраните книгу в UTF-8.'); }
 const actual = declaration(text);
 if (actual && encodingName(actual) !== encoding && !(encoding.startsWith('utf-16') && encodingName(actual) === 'utf-16')) throw new Error('BOM и объявленная кодировка FB2 не совпадают.');
 return text;
}

/** Bound nesting/node count BEFORE DOMParser allocates an XML tree. This is only
 * a resource preflight, not an XML parser; DOMParser still validates all syntax. */
function preflight(text: string): void {
 if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('DTD и объявления XML entities в FB2 запрещены.');
 let depth = 0, elements = 0, nodes = 0, index = 0, previousEnd = 0;
 while ((index = text.indexOf('<', index)) !== -1) {
  if (index > previousEnd) nodes++;
  if (text[index + 1] !== '/') nodes++;
  if (nodes > FB2_LIMITS.nodes) throw new Error('В FB2 слишком много XML узлов.');
  let end: number;
  if (text.startsWith('<!--', index)) {end = text.indexOf('-->', index + 4); if (end < 0) throw new Error('Повреждённый XML FB2.'); index = end + 3; previousEnd = index; continue;}
  if (text.startsWith('<![CDATA[', index)) {end = text.indexOf(']]>', index + 9); if (end < 0) throw new Error('Повреждённый XML FB2.'); index = end + 3; previousEnd = index; continue;}
  if (text.startsWith('<?', index)) {
   end = text.indexOf('?>', index + 2); if (end < 0) throw new Error('Повреждённый XML FB2.');
   if (!text.startsWith('<?xml ', index) && !text.startsWith('<?xml\n', index) && !text.startsWith('<?xml\r', index) && !text.startsWith('<?xml\t', index)) throw new Error('Инструкции обработки XML в FB2 запрещены.');
   index = end + 2; previousEnd = index; continue;
  }
  if (text.startsWith('<!', index)) throw new Error('Объявления XML в FB2 запрещены.');
  let quote = '';
  for (end = index + 1; end < text.length; end++) {
   const c = text[end];
   if (quote) {if (c === quote) quote = '';}
   else if (c === '"' || c === "'") quote = c;
   else if (c === '>') break;
  }
  if (end === text.length) throw new Error('Повреждённый XML FB2.');
  if (text[index + 1] === '/') depth--;
  else {
   if (++elements > FB2_LIMITS.elements) throw new Error('В FB2 слишком много XML элементов.');
   if (++depth > FB2_LIMITS.depth) throw new Error('Превышена безопасная глубина XML FB2.');
   if (text[end - 1] === '/') depth--;
  }
  if (depth < 0) throw new Error('Повреждённый XML FB2.');
  index = end + 1; previousEnd = index;
 }
 if (depth !== 0) throw new Error('Повреждённый XML FB2.');
}

export async function convertFb2ToEpub(input: Blob | ArrayBuffer, fallbackTitle = 'Книга FB2', options: Fb2ConversionOptions = {}): Promise<ConvertedFb2> {
 const maxOutputBytes = options.maxOutputBytes ?? FB2_LIMITS.outputBytes;
 if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > FB2_LIMITS.outputBytes) throw new Error('Некорректный предел размера FB2.');
 const fallback = metadataText(fallbackTitle);
 const isBuffer = Object.prototype.toString.call(input) === '[object ArrayBuffer]';
 const size = isBuffer ? (input as ArrayBuffer).byteLength : (input as Blob).size;
 if (!size || size > FB2_MAX_BYTES) throw new Error('FB2 должен быть непустым и не больше 16 MiB.');
 const bytes = new Uint8Array(isBuffer ? input as ArrayBuffer : await (input as Blob).arrayBuffer());
 const text = decode(bytes); preflight(text);
 const doc = new DOMParser().parseFromString(text, 'application/xml');
 if (doc.getElementsByTagName('parsererror').length || doc.getElementsByTagNameNS('*','parsererror').length) throw new Error('Повреждённый XML FB2.');
 const root = doc.documentElement;
 if (root.localName !== 'FictionBook' || root.namespaceURI !== FB2_NS && root.namespaceURI !== null) throw new Error('Это не книга FictionBook (FB2).');
 const warnings = new Set<string>();
 const ids = new Set<string>();
 let totalAttachmentCharacters = 0;
 for (const node of Array.from(doc.getElementsByTagName('*'))) {
  if (node.namespaceURI !== root.namespaceURI) throw new Error('Внешние XML пространства имён в FB2 не поддерживаются.');
  const id = node.getAttribute('id');
  if (id !== null) {if (!id || ids.has(id)) throw new Error('Повторяющийся или пустой идентификатор в FB2.'); ids.add(id);}
  for (const attr of Array.from(node.attributes)) {
   if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
   if (attr.localName === 'href' || attr.localName === 'src' || attr.localName === 'base' || attr.localName === 'schemaLocation' || attr.localName === 'noNamespaceSchemaLocation') {
    if (attr.localName !== 'href' || !['a','image'].includes(node.localName) || attr.namespaceURI !== null && attr.namespaceURI !== XLINK_NS || !/^#[^\s#]+$/u.test(attr.value)) throw new Error('Внешние ресурсы и ссылки в FB2 запрещены.');
   }
   // All other source attributes, including events and styles, are never copied.
  }
  if (node.localName === 'binary') {
   if (node.children.length) throw new Error('Некорректное вложение FB2.');
   const raw = node.textContent ?? '';
   if (raw.length > FB2_LIMITS.attachmentCharacters || (totalAttachmentCharacters += raw.length) > FB2_LIMITS.totalAttachmentCharacters) throw new Error('Превышен безопасный размер вложений FB2.');
   const base64 = raw.replace(/[\t\n\r ]/g, '');
   if (base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64) || !/^[^=]*={0,2}$/.test(base64)) throw new Error('Некорректное base64-вложение FB2.');
  }
  if (node.localName === 'image' || node.localName === 'binary') warnings.add('Изображения и вложения FB2 не отображаются: доступен безопасный текстовый режим.');
  if (node.localName === 'stylesheet' || node.hasAttribute('style')) warnings.add('Авторские стили FB2 отключены для безопасного чтения.');
 }
 const info = named(root, 'description');
 const titleInfo = info && named(info, 'title-info');
 const title = metadataText(titleInfo ? named(titleInfo, 'book-title')?.textContent : null) || fallback;
 const languageText = metadataText(titleInfo ? named(titleInfo, 'lang')?.textContent : null, FB2_LIMITS.languageCharacters);
 const language = languageText && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(languageText) ? languageText : 'und';
 const bodies = Array.from(root.children).filter(node => node.localName === 'body');
 if (!bodies.length || !bodies.some(body => body.textContent?.trim())) throw new Error('В FB2 нет доступного текста для чтения.');
 type Chapter = {nodes: Node[]; title: string; path: string};
 const chapters: Chapter[] = [];
 for (const body of bodies) {
  const bodyName = metadataText(body.getAttribute('name'));
  let current: Node[] = [];
  const push = () => {
   if (!current.length) return;
   const first = current.find(element);
   const heading = first && (first.localName === 'title' ? first : named(first, 'title'));
   chapters.push({nodes: current, title: metadataText(heading?.textContent) || bodyName || `Глава ${chapters.length + 1}`, path: `chapter-${chapters.length + 1}.xhtml`});
   current = [];
  };
  for (const node of Array.from(body.childNodes)) {
   if (element(node) && node.localName === 'section' && current.some(n => element(n) || n.textContent?.trim())) push();
   current.push(node);
  }
  push();
 }
 if (chapters.length > FB2_LIMITS.chapters) throw new Error('В FB2 слишком много глав.');
 const targets = new Map<string, string>(), nodeIds = new Map<Element, string>();
 for (const chapter of chapters) {
  const visit = (node: Node) => {
   if (!element(node)) return;
   const id = node.getAttribute('id');
   if (id) {const safeId = `fb2-id-${nodeIds.size + 1}`;nodeIds.set(node, safeId);targets.set(id, `${chapter.path}#${safeId}`);}
   node.childNodes.forEach(visit);
  };
  chapter.nodes.forEach(visit);
 }
 const tags: Record<string,string> = {section:'section',p:'p',subtitle:'h3',strong:'strong',emphasis:'em',strikethrough:'s',sub:'sub',sup:'sup',code:'code',cite:'blockquote',epigraph:'blockquote',poem:'blockquote',stanza:'div',v:'p','text-author':'p',date:'p',annotation:'aside',table:'table',tr:'tr',td:'td',th:'th',style:'span',title:'header'};
 const omitted = new Set(['image','binary','stylesheet','script','iframe','object','embed']);
 type Append = (fragment: string) => void;
 // Each complete output file shares one budget. Append checks every fragment before
 // retaining it; only after all files fit do we join/encode them and allocate ZIP.
 const generated = new Map<string, string[]>();
 let outputBytes = 0;
 const file = (path: string, write: (append: Append) => void) => {
  const fragments: string[] = [];
  const append: Append = fragment => {
   const size = utf8Length(fragment);
   if (size > maxOutputBytes - outputBytes) throw new Error('Превышен безопасный размер результата FB2.');
   outputBytes += size;fragments.push(fragment);
  };
  write(append);generated.set(path, fragments);
 };
 const render = (node: Node, append: Append): void => {
  if (node.nodeType === 3 || node.nodeType === 4) {append(escapeXml(node.nodeValue ?? ''));return;}
  if (!element(node) || omitted.has(node.localName)) return;
  const id = nodeIds.get(node);
  const attributes = id ? ` id="${id}"` : '';
  if (node.localName === 'empty-line') {append(`<br${attributes}/>`);return;}
  let tag: string, href = '';
  if (node.localName === 'a') {
   const originalHref = node.getAttributeNS(XLINK_NS, 'href') ?? node.getAttribute('href');
   const target = originalHref && targets.get(originalHref.slice(1));
   if (originalHref && !target) warnings.add('Часть внутренних ссылок FB2 не имеет доступной текстовой цели.');
   tag = target ? 'a' : 'span';href = target ? ` href="${target}"` : '';
  } else {
   const mapped = node.localName === 'p' && node.parentElement?.localName === 'title' ? 'h2' : Object.hasOwn(tags, node.localName) ? tags[node.localName] : undefined;
   if (!mapped) warnings.add('Неподдерживаемая разметка FB2 показана как обычный текст.');
   tag = mapped ?? 'span';
  }
  // Never normalize body text or copy source HTML/CSS/URLs/attributes.
  append(`<${tag}${attributes}${href}>`);
  node.childNodes.forEach(child => render(child, append));
  append(`</${tag}>`);
 };
 file('mimetype', append => append('application/epub+zip'));
 file('META-INF/container.xml', append => append('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'));
 for (const chapter of chapters) file(`OPS/${chapter.path}`, append => {
  append(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}"><head><title>${escapeXml(chapter.title)}</title></head><body>`);
  chapter.nodes.forEach(node => render(node, append));
  append('</body></html>');
 });
 file('OPS/nav.xhtml', append => {
  append('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Оглавление</title></head><body><nav epub:type="toc"><h1>Оглавление</h1><ol>');
  for (const chapter of chapters) append(`<li><a href="${chapter.path}">${escapeXml(chapter.title)}</a></li>`);
  append('</ol></nav></body></html>');
 });
 file('OPS/book.opf', append => {
  append(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">local-fb2-text-v1</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:language>${language}</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  for (const [i, chapter] of chapters.entries()) append(`<item id="c${i + 1}" href="${chapter.path}" media-type="application/xhtml+xml"/>`);
  append('</manifest><spine>');
  for (const [i] of chapters.entries()) append(`<itemref idref="c${i + 1}"/>`);
  append('</spine></package>');
 });
 const files: Record<string, Uint8Array> = {};
 for (const [path, fragments] of generated) files[path] = strToU8(fragments.join(''));
 // Fixed ZIP timestamps and insertion order keep chapter CFIs reproducible after reopen.
 const zipped = zipSync(files, {level: 0, mtime: new Date(2000, 0, 1, 0, 0, 0)});
 return {blob: new Blob([zipped as BlobPart], {type: 'application/epub+zip'}), title, warnings: [...warnings]};
}
