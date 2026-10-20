// @vitest-environment jsdom
import {beforeEach, describe, expect, it} from 'vitest';
import {extractAtPoint,extractFromRange,extractSelection,isEditable} from '../../apps/extension/src/content/extraction';
beforeEach(() => { document.body.innerHTML=''; document.getSelection()?.removeAllRanges(); });
function textRange(html:string,start:number,end:number) {
  document.body.innerHTML=html;
  const walker=document.createTreeWalker(document.body,4), nodes:Text[]=[];
  let n:Node|null; while ((n=walker.nextNode())) nodes.push(n as Text);
  const r=document.createRange(); let at=0;
  for (const node of nodes) { if(start>=at && start<at+node.length) r.setStart(node,start-at); if(end>at && end<=at+node.length) r.setEnd(node,end-at); at+=node.length; }
  return r;
}
function assertExact(r:ReturnType<typeof extractFromRange>, expected:string) {
  expect(r.ok).toBe(true); if(!r.ok) throw Error(r.message);
  expect(r.expression).toBe(expected);
  expect(r.context.sentence.slice(r.context.targetStart,r.context.targetEnd)).toBe(expected);
  expect(r.context.sentence.length).toBeLessThanOrEqual(1500);
  return r;
}
describe('DOM extraction',()=>{
  it('retains original UTF-16 offsets including emoji and repeated words',()=>{
    const r=assertExact(extractFromRange(textRange('<p>😀 The bank is near another bank.</p>',28,32)),'bank');
    expect(r.context.targetStart).toBe(28);
  });
  it('uses the enclosing sentence, not the whole paragraph',()=>{
    const r=assertExact(extractFromRange(textRange('<p>First sentence. The bank closed. Last sentence.</p>',20,24)),'bank');
    expect(r.context.sentence).toBe('The bank closed. '); expect(r.context.targetStart).toBe(4);
  });
  it('keeps a phrase across inline nodes',()=>{
    assertExact(extractFromRange(textRange('<p>I <b>put up</b> with this.</p>',2,13)),'put up with');
  });
  it('selects one whole apostrophe/hyphen word across nodes using caret API',()=>{
    document.body.innerHTML='<p>A well-<b>known</b> writer doesn’t mind.</p>';
    (document as any).caretRangeFromPoint=()=>{const r=document.createRange();r.setStart(document.querySelector('b')!.firstChild!,2);r.collapse(true);return r;};
    assertExact(extractAtPoint(document,20,20),'well-known');
    (document as any).caretRangeFromPoint=()=>{const r=document.createRange();r.setStart(document.querySelector('p')!.lastChild!,12);r.collapse(true);return r;};
    assertExact(extractAtPoint(document,20,20),'doesn’t');
    delete (document as any).caretRangeFromPoint;
  });
  it('rejects six words, but accepts five and put up with',()=>{
    expect(extractFromRange(textRange('<p>one two three four five six</p>',0,27))).toMatchObject({ok:false,code:'too_many_words'});
    assertExact(extractFromRange(textRange('<p>one two three four five</p>',0,23)),'one two three four five');
  });
  it('trims selection whitespace without normalizing internal whitespace',()=>{
    assertExact(extractFromRange(textRange('<p> I put  up\nwith this. </p>',2,15)),'put  up\nwith');
  });
  it('clips oversized sentence without losing target or original offsets',()=>{
    const prefix='🙂 '.repeat(600), text=prefix+'bank '+'tail '.repeat(600);
    const r=assertExact(extractFromRange(textRange(`<p>${text}</p>`,prefix.length,prefix.length+4)),'bank');
    expect(text.includes(r.context.sentence)).toBe(true);
  });
  it('handles element child-boundary selection',()=>{
    document.body.innerHTML='<p>I <b>put</b> <i>up with</i> this.</p>';
    const r=document.createRange();r.setStart(document.querySelector('p')!,1);r.setEnd(document.querySelector('p')!,4);
    assertExact(extractFromRange(r),'put up with');
  });
  it('does not extract editable selection',()=>{
    expect(extractFromRange(textRange('<p contenteditable>secret text</p>',0,6))).toMatchObject({ok:false,code:'editable'});
  });
  it('recognizes inherited editing and explicit false islands',()=>{
    document.body.innerHTML='<div contenteditable><span id="yes">a</span><span contenteditable="false" id="no">b</span></div><input type="password">';
    expect(isEditable(document.querySelector('#yes'))).toBe(true);
    expect(isEditable(document.querySelector('#no'))).toBe(false);
    expect(isEditable(document.querySelector('input'))).toBe(true);
  });
  it('preserves line breaks without merging adjacent words',()=>{
    document.body.innerHTML='<p>put<br>up with</p>';
    const r=document.createRange();r.selectNodeContents(document.querySelector('p')!);
    assertExact(extractFromRange(r),'put\nup with');
  });
  it('does not include CSS-hidden ancestor text in context',()=>{
    document.body.innerHTML='<p>the <span style="display:none"><b>private</b></span>bank</p>';
    const r=document.createRange();r.selectNodeContents(document.querySelector('p')!.lastChild!);
    const result=assertExact(extractFromRange(r),'bank');expect(result.context.sentence).toBe('the bank');
  });
  it('returns null for absent selection',()=>expect(extractSelection(document)).toBeNull());
});
