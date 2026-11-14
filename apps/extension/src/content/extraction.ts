import { segmentSourceWords, sourceGraphemeBoundaries, type LexicalSegment } from '../../../../packages/contracts/src/words';
export type { LexicalSegment } from '../../../../packages/contracts/src/words';
/** All indices are UTF-16 offsets into the original, non-normalized sentence. */
export interface ExtractedText {
  expression: string;
  /** Manual selection always takes precedence over automatic nearby candidates. */
  origin?: 'selection' | 'hover';
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
interface TextIndex {
  text: string;
  nodes: Array<{node:Text; start:number; end:number}>;
  /** Structural block boundaries must not be confused with source line wrapping. */
  blockBreaks: number[];
}
function indexText(root: Node): TextIndex {
  const doc = root.ownerDocument!;
  const walk = doc.createTreeWalker(root, 5);
  const nodes: TextIndex['nodes'] = [];
  const blockBreaks: number[] = [];
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
    if (nodes.length && priorBlock !== block) {
      if (!text.endsWith('\n')) text += '\n';
      blockBreaks.push(text.length);
    }
    const start = text.length;
    text += node.nodeValue ?? '';
    nodes.push({node:node as Text,start,end:text.length});
    priorBlock = block;
  }
  return {text,nodes,blockBreaks};
}

interface SentenceRange { start:number; end:number }
function sentenceRanges(index: TextIndex, sentences: SegmenterInstance, locale: string): SentenceRange[] {
  // ICU treats every source newline as a sentence ending, including a newline
  // used merely to wrap an EPUB paragraph or an inline BR in a PDF text layer.
  // Segment a same-length view instead: every offset still addresses the exact
  // original UTF-16 source. Never use this view as the expression or payload.
  const view = index.text.replace(/[\r\n\u0085\u2028]/gu, ' ');
  const parts: SentenceRange[] = [];
  let blockStart = 0;
  for (const blockEnd of [...new Set([...index.blockBreaks, view.length])]) {
    let previous: SentenceRange | undefined;
    for (const part of sentences.segment(view.slice(blockStart, blockEnd))) {
      const start = blockStart + part.index, end = start + part.segment.length;
      // ICU also splits English honorifics before names ("Mr. Boffin"). Keep
      // this narrow: never guess that every period/initial is an abbreviation,
      // and never merge across a structural or explicit paragraph boundary.
      const titleContinues = previous && /^(?:en(?:-|$)|und$)/i.test(locale) &&
        /(?:^|[^\p{L}\p{N}])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev)\.\s*$/u.test(view.slice(previous.start, previous.end)) &&
        !view.slice(previous.start, previous.end).includes('\u2029') && /^\p{Lu}/u.test(part.segment);
      if (titleContinues) previous!.end = end;
      else { previous = {start,end}; parts.push(previous); }
    }
    blockStart = blockEnd;
  }
  return parts;
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
function makeResult(index: TextIndex, start: number, end: number, doc: Document, locale: string, mode?: 'sentence'): ExtractionResult {
  while (start < end && /\s/u.test(index.text[start]!)) start++;
  while (end > start && /\s/u.test(index.text[end-1]!)) end--;
  const expression = index.text.slice(start,end);
  const words = segmentLexicalWords(expression,locale);
  const boundaries = sourceGraphemeBoundaries(index.text,locale);
  const sentences = segmenter('sentence',locale);
  if (!words || !boundaries || !sentences) return segmentationUnavailable();
  if (!boundaries.has(start) || !boundaries.has(end)) return fail('no_text','Выделите символ целиком, включая диакритические знаки.');
  if (!words.length) return fail('no_text','Выберите слово или выражение.');
  if (mode !== 'sentence' && words.length > 5) return fail('too_many_words','Выберите выражение не длиннее пяти слов.');
  if (expression.length > 1500) return fail('too_long','Выбранный текст слишком длинный.');
  let sentenceStart = 0, sentenceEnd = index.text.length;
  // Keep punctuation and source whitespace, but not accidental inline wrapping
  // boundaries. DOM scope is unchanged: only the enclosing block is indexed.
  const parts = sentenceRanges(index,sentences,locale);
  sentenceStart = parts.find(p => p.start <= start && p.end > start)?.start ?? 0;
  const last = parts.find(p => p.start < end && p.end >= end);
  sentenceEnd = last?.end ?? index.text.length;
  if (mode === 'sentence' && last?.start !== sentenceStart) return fail('unsupported','Для грамматики выберите текст внутри одного предложения.');
  if (mode === 'sentence' && sentenceEnd-sentenceStart > 1500) return fail('too_long','Предложение слишком длинное для разбора (максимум 1500 знаков).');
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
export function extractFromRange(range: Range, locale?: string, mode?: 'sentence'): ExtractionResult {
  if (range.collapsed) return fail('no_text','Нет выделенного текста.');
  if (isEditable(range.startContainer) || isEditable(range.endContainer)) return fail('editable','Перевод в редактируемых полях отключён.');
  const root = blockFor(range.commonAncestorContainer) ?? range.commonAncestorContainer.parentElement;
  if (!root) return fail('unsupported','Текст этого документа недоступен.');
  const index = indexText(root);
  const start = offsetOf(index,range.startContainer,range.startOffset);
  const end = offsetOf(index,range.endContainer,range.endOffset);
  if (start === null || end === null || end <= start) return fail('no_text','Не удалось извлечь выделение.');
  return makeResult(index,start,end,root.ownerDocument,localeFor(range.startContainer,locale),mode);
}
export function extractSelection(doc: Document, locale?: string, mode?: 'sentence'): ExtractionResult | null {
  const selection = doc.getSelection();
  const result = selection && selection.rangeCount && !selection.isCollapsed ? extractFromRange(selection.getRangeAt(0),locale,mode) : null;
  return result?.ok ? {...result,origin:'selection'} : result;
}
export function extractAtPoint(doc: Document, x: number, y: number, locale?: string, mode?: 'sentence'): ExtractionResult {
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
  const result = makeResult(index,word.start,word.end,doc,sourceLocale,mode);
  if (result.ok && typeof result.range.getClientRects === 'function') {
    const rects = [...result.range.getClientRects()];
    if (rects.length && !rects.some(r => x >= r.left-1 && x <= r.right+1 && y >= r.top && y <= r.bottom)) return fail('no_text','Наведите курсор на слово.');
  }
  return result.ok ? {...result,origin:'hover'} : result;
}
