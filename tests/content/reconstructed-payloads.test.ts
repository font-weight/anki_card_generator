// @vitest-environment jsdom
import {afterEach,describe,expect,it} from 'vitest';
import {extractAtPoint,extractFromRange,extractSelection} from '../../apps/extension/src/content/extraction';
import {lookupPayloadFor,grammarPayloadFor} from '../../apps/extension/src/content/payloads';
import {grammarPreferences,lookupPreferences} from '../../apps/extension/src/runtime/reader-preferences';
import {readerActionTarget} from '../../apps/extension/src/runtime/action-state';
afterEach(()=>{document.body.replaceChildren();document.getSelection()?.removeAllRanges();delete (document as any).caretRangeFromPoint;});
function pointer(doc:Document,node:Node,offset:number){(doc as any).caretRangeFromPoint=()=>{const range=doc.createRange();range.setStart(node,offset);range.collapse(true);return range;};}
const preferences=lookupPreferences({});
describe('local phrasal candidate extraction adapters',()=>{
 it('proposes exact spans across inline HTML nodes without normalizing whitespace',()=>{
  document.body.innerHTML='<p>First. She watched him go <em>by</em> the window.</p>';
  pointer(document,document.querySelector('p')!.firstChild!,23);
  const extracted=extractAtPoint(document,10,10,'en-US');expect(extracted.ok).toBe(true);if(!extracted.ok)return;
  expect(extracted.origin).toBe('hover');expect(extracted.expression).toBe('go');
  const payload=lookupPayloadFor(extracted,preferences),candidate=payload.phrasalCandidates?.find(item=>item.expression==='go by');
  expect(candidate).toBeDefined();expect(payload.context.sentence.slice(candidate!.targetStart,candidate!.targetEnd)).toBe('go by');expect(payload.context.sentence).toBe('She watched him go by the window.');
 });
 it('handles a PDF-style text layer and same-origin EPUB frame without changing their DOM',()=>{
  const frame=document.createElement('iframe');document.body.append(frame);
  for(const doc of [document,frame.contentDocument!]){
   const layer=doc.createElement('div');layer.className='textLayer';layer.innerHTML='<span>The sky </span><span>clouded</span><span> over quickly.</span>';doc.body.append(layer);const before=layer.innerHTML;
   pointer(doc,layer.children[1].firstChild!,2);const extracted=extractAtPoint(doc,10,10,'en-US');expect(extracted.ok).toBe(true);if(!extracted.ok)continue;
   expect(lookupPayloadFor(extracted,preferences).phrasalCandidates).toContainEqual(expect.objectContaining({expression:'clouded over',targetStart:8,targetEnd:20,lemma:'cloud over'}));expect(layer.innerHTML).toBe(before);
  }
 });
 it('never expands any manual selection, including a selected single word',()=>{
  document.body.innerHTML='<p>The sky clouded over quickly.</p>';const text=document.querySelector('p')!.firstChild!,range=document.createRange();range.setStart(text,8);range.setEnd(text,15);document.getSelection()!.addRange(range);
  const extracted=extractSelection(document,'en-US');expect(extracted?.ok).toBe(true);if(!extracted?.ok)return;
  expect(extracted.origin).toBe('selection');expect(lookupPayloadFor(extracted,preferences)).not.toHaveProperty('phrasalCandidates');
  expect(lookupPayloadFor({...extracted,origin:'hover'},lookupPreferences({sourceLanguage:'fr'}))).not.toHaveProperty('phrasalCandidates');
  expect(lookupPayloadFor({...extracted,origin:undefined},preferences)).not.toHaveProperty('phrasalCandidates');
 });
});
describe('exact grammar sentence scope',()=>{
 function range(text:string,start:number,end:number){const p=document.createElement('p');p.textContent=text;document.body.append(p);const r=document.createRange();r.setStart(p.firstChild!,start);r.setEnd(p.firstChild!,end);return r;}
 it('allows a selected complete sentence longer than five words and excludes its neighbors',()=>{
  const text='Before. She has been reading this book for hours. After.',start=text.indexOf('She'),end=text.indexOf(' After.');
  const extracted=extractFromRange(range(text,start,end),'en-US','sentence');expect(extracted.ok).toBe(true);if(!extracted.ok)return;
  const payload=grammarPayloadFor(extracted,preferences,grammarPreferences({grammarIncludeExplanation:false,grammarExplanationLanguage:'fr'}));
  expect(payload.sentence).toBe('She has been reading this book for hours. ');expect(payload.includeExplanation).toBe(false);expect(payload.explanationLanguage).toBe('fr');expect(payload).not.toHaveProperty('expression');
 });
 it('rejects multiple sentences or a truncated oversized sentence instead of silently changing scope',()=>{
  expect(extractFromRange(range('First sentence. Second sentence.',0,31),'en-US','sentence')).toMatchObject({ok:false,code:'unsupported'});
  expect(extractFromRange(range('A '.repeat(800)+'word.',1600,1604),'en-US','sentence')).toMatchObject({ok:false,code:'too_long'});
 });
});
describe('compact action target',()=>{
 const library='chrome-extension://own/library.html';
 it('recognizes own library as already ready and rejects lookalike restricted pages',()=>{
  expect(readerActionTarget(library,library)).toBe('library');expect(readerActionTarget(library+'?book=1#chapter',library)).toBe('library');
  for(const url of [undefined,'chrome://settings','chrome-extension://other/library.html','chrome-extension://own/settings.html','file:///library.html','not a URL'])expect(readerActionTarget(url,library)).toBe('restricted');
  expect(readerActionTarget('https://example.test/library.html',library)).toBe('web');
 });
});
