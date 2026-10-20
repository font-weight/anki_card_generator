import { segmentSourceWords, sourceGraphemeBoundaries, type LexicalSegment } from '../../../../packages/contracts/src/words';
export type { LexicalSegment } from '../../../../packages/contracts/src/words';
/** All indices are UTF-16 offsets into the original, non-normalized sentence. */
export interface ExtractedText {
  expression: string;
  context: { sentence: string; targetStart: number; targetEnd: number };
  range: Range;
}
export type ExtractionResult = ({ ok: true } & ExtractedText) | {
  ok: false; code: 'no_text' | 'too_many_words' | 'too_long' | 'editable' | 'unsupported'; message: string;
};
interface Segment { index: number; segment: string; isWordLike?: boolean }
interface SegmenterInstance { segment(text: string): Iterable<Segment> }
type SegmenterConstructor = new (locale: string, options: {granularity: 'word'|'sentence'|'grapheme'}) => SegmenterInstance;
function segmenter(granularity: 'word'|'sentence'|'grapheme', locale = 'und'): SegmenterInstance | null {
  const Constructor = (Intl as unknown as {Segmenter?: SegmenterConstructor}).Segmenter;
  if (!Constructor) return null;
  try { return new Constructor(locale, {granularity}); }
  catch { try { return new Constructor('und', {granularity}); } catch { return null; } }
}
/** Unicode segmentation, not language identification. Never normalize the source. */
export function segmentLexicalWords(text: string, locale = 'und'): LexicalSegment[] | null {
  return segmentSourceWords(text,locale);
}
function localeFor(node: Node, explicit?: string): string {
  if (explicit) return explicit;
  const el = node.nodeType === 1 ? node as Element : node.parentElement;
  return el?.closest('[lang]')?.getAttribute('lang') || node.ownerDocument?.documentElement.lang || 'und';
}
const segmentationUnavailable = (): ExtractionResult => ({ok:false,code:'unsupported',message:'В браузере недоступно безопасное определение границ слов. Обновите Chrome.'});
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BODY|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TD|TH|UL)$/;
const EXCLUDED = 'script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden="true"]';
export function isEditable(node: EventTarget | Node | null): boolean {
  let el = node && 'nodeType' in node ? ((node as Node).nodeType === 1 ? node as Element : (node as Node).parentElement) : null;
  while (el) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    const contentEditable = el.getAttribute('contenteditable');
    if (contentEditable !== null) return contentEditable.toLowerCase() !== 'false';
    el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null);
  }
  return false;
}
const fail = (code: Extract<ExtractionResult, {ok:false}>['code'], message: string): ExtractionResult => ({ok:false,code,message});
function blockFor(node: Node): Element | null {
  let el = node.nodeType === 1 ? node as Element : node.parentElement;
  while (el && !BLOCK.test(el.tagName)) el = el.parentElement;
  return el;
}
interface TextIndex { text: string; nodes: Array<{node:Text; start:number; end:number}> }
function indexText(root: Node): TextIndex {
  const doc = root.ownerDocument!;
  const walk = doc.createTreeWalker(root, 5);
  const nodes: TextIndex['nodes'] = [];
  let text = '', priorBlock: Element | null = null, node: Node | null;
  while ((node = walk.nextNode())) {
    const parent = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!parent || parent.closest(EXCLUDED) || isEditable(parent)) continue;
    let invisible = false;
    for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
      const style = doc.defaultView?.getComputedStyle(ancestor);
      if (style?.display === 'none' || style?.visibility === 'hidden') { invisible = true; break; }
    }
    if (invisible) continue;
    if (node.nodeType === 1) {
      if ((node as Element).tagName === 'BR') text += '\n';
      continue;
    }
    const block = blockFor(node);
    if (nodes.length && priorBlock !== block && !text.endsWith('\n')) text += '\n';
    const start = text.length;
    text += node.nodeValue ?? '';
    nodes.push({node:node as Text,start,end:text.length});
    priorBlock = block;
  }
  return {text,nodes};
}
function offsetOf(index: TextIndex, container: Node, offset: number): number | null {
  const direct = index.nodes.find(n => n.node === container);
  if (direct) return direct.start + offset;
  if (container.nodeType !== 1) return null;
  // Element range offsets denote child boundaries, not character offsets.
  const child = container.childNodes[offset];
  if (child) {
    const next = index.nodes.find(n => child === n.node || child.contains(n.node));
    if (next) return next.start;
    const following = index.nodes.find(n => !!(child.compareDocumentPosition(n.node) & 4));
    return following?.start ?? null;
  }
  const descendants = index.nodes.filter(n => container.contains(n.node));
  return descendants.at(-1)?.end ?? null;
}
function rangeFor(index: TextIndex, start: number, end: number, doc: Document): Range {
  const first = index.nodes.find(n => n.end > start)!;
  const last = [...index.nodes].reverse().find(n => n.start < end)!;
  const range = doc.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}
function makeResult(index: TextIndex, start: number, end: number, doc: Document, locale: string): ExtractionResult {
  while (start < end && /\s/u.test(index.text[start]!)) start++;
  while (end > start && /\s/u.test(index.text[end-1]!)) end--;
  const expression = index.text.slice(start,end);
  const words = segmentLexicalWords(expression,locale);
  const boundaries = sourceGraphemeBoundaries(index.text,locale);
  const sentences = segmenter('sentence',locale);
  if (!words || !boundaries || !sentences) return segmentationUnavailable();
  if (!boundaries.has(start) || !boundaries.has(end)) return fail('no_text','Выделите символ целиком, включая диакритические знаки.');
  if (!words.length) return fail('no_text','Выберите слово или выражение.');
  if (words.length > 5) return fail('too_many_words','Выберите выражение не длиннее пяти слов.');
  if (expression.length > 1500) return fail('too_long','Выбранный текст слишком длинный.');
  let sentenceStart = 0, sentenceEnd = index.text.length;
  // Segmenter retains punctuation and original whitespace; no normalization occurs.
  const parts = [...sentences.segment(index.text)];
  sentenceStart = parts.find(p => p.index <= start && p.index+p.segment.length > start)?.index ?? 0;
  const last = parts.find(p => p.index < end && p.index+p.segment.length >= end);
  sentenceEnd = last ? last.index+last.segment.length : index.text.length;
  // Oversized sentences are clipped around the target, never altering the target.
  if (sentenceEnd - sentenceStart > 1500) {
    const spare = 1500 - (end-start);
    sentenceStart = Math.max(sentenceStart, start - Math.floor(spare/2));
    sentenceEnd = Math.min(sentenceEnd, sentenceStart+1500);
    sentenceStart = Math.max(0, Math.min(sentenceStart, sentenceEnd-1500));
    // Clip inward to complete graphemes, preserving marks and emoji sequences.
    while (!boundaries.has(sentenceStart)) sentenceStart++;
    while (!boundaries.has(sentenceEnd)) sentenceEnd--;
  }
  const sentence = index.text.slice(sentenceStart,sentenceEnd);
  return {ok:true,expression,context:{sentence,targetStart:start-sentenceStart,targetEnd:end-sentenceStart},range:rangeFor(index,start,end,doc)};
}
export function extractFromRange(range: Range, locale?: string): ExtractionResult {
  if (range.collapsed) return fail('no_text','Нет выделенного текста.');
  if (isEditable(range.startContainer) || isEditable(range.endContainer)) return fail('editable','Перевод в редактируемых полях отключён.');
  const root = blockFor(range.commonAncestorContainer) ?? range.commonAncestorContainer.parentElement;
  if (!root) return fail('unsupported','Текст этого документа недоступен.');
  const index = indexText(root);
  const start = offsetOf(index,range.startContainer,range.startOffset);
  const end = offsetOf(index,range.endContainer,range.endOffset);
  if (start === null || end === null || end <= start) return fail('no_text','Не удалось извлечь выделение.');
  return makeResult(index,start,end,root.ownerDocument,localeFor(range.startContainer,locale));
}
export function extractSelection(doc: Document, locale?: string): ExtractionResult | null {
  const selection = doc.getSelection();
  return selection && selection.rangeCount && !selection.isCollapsed ? extractFromRange(selection.getRangeAt(0),locale) : null;
}
export function extractAtPoint(doc: Document, x: number, y: number, locale?: string): ExtractionResult {
  const api = doc as Document & {
    caretPositionFromPoint?: (x:number,y:number) => {offsetNode:Node;offset:number}|null;
    caretRangeFromPoint?: (x:number,y:number) => Range|null;
  };
  const pos = api.caretPositionFromPoint?.(x,y);
  const caret = pos ? null : api.caretRangeFromPoint?.(x,y);
  const node = pos?.offsetNode ?? caret?.startContainer;
  const offset = pos?.offset ?? caret?.startOffset;
  if (!node || offset === undefined) return fail('no_text','Наведите курсор на доступный текст.');
  if (isEditable(node)) return fail('editable','Перевод в редактируемых полях отключён.');
  const root = blockFor(node) ?? node.parentElement;
  if (!root) return fail('unsupported','Текст этого документа недоступен.');
  const index = indexText(root), at = offsetOf(index,node,offset);
  if (at === null) return fail('no_text','Текст недоступен.');
  const sourceLocale = localeFor(node,locale);
  const matches = segmentLexicalWords(index.text,sourceLocale);
  if (!matches) return segmentationUnavailable();
  const word = matches.find(m => m.start <= at && m.end > at) ?? matches.find(m => m.end === at);
  if (!word) return fail('no_text','Наведите курсор на слово.');
  const result = makeResult(index,word.start,word.end,doc,sourceLocale);
  if (result.ok && typeof result.range.getClientRects === 'function') {
    const rects = [...result.range.getClientRects()];
    if (rects.length && !rects.some(r => x >= r.left-1 && x <= r.right+1 && y >= r.top && y <= r.bottom)) return fail('no_text','Наведите курсор на слово.');
  }
  return result;
}
