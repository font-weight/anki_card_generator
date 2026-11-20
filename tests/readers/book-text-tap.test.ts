import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {watchBookSurfaceTaps} from '../../apps/extension/src/readers/book-text-tap';

let owner:HTMLDivElement,frame:HTMLIFrameElement,doc:Document,paragraph:HTMLParagraphElement;
let close:ReturnType<typeof vi.fn<()=>void>>,action:{current:(()=>void)|null},watch:ReturnType<typeof watchBookSurfaceTaps>;
beforeEach(()=>{
  vi.useFakeTimers();
  owner=document.createElement('div');frame=document.createElement('iframe');owner.append(frame);document.body.append(owner);
  doc=frame.contentDocument!;paragraph=doc.createElement('p');paragraph.textContent='The light appeared.';doc.body.append(paragraph);
  close=vi.fn<()=>void>();action={current:close};watch=watchBookSurfaceTaps(owner,action);watch.addFrame(doc);
});
afterEach(()=>{watch.dispose();owner.remove();vi.useRealTimers();});
const tick=()=>vi.advanceTimersByTime(750);
function point(type:string,extra:PointerEventInit={},target:EventTarget=paragraph,timeStamp?:number) {
  const properties={bubbles:true,cancelable:true,composed:true,clientX:12,clientY:12,button:0,detail:1,
    pointerId:1,pointerType:'mouse',isPrimary:true,...extra};
  const event=type==='click'||type==='dblclick'?new MouseEvent(type,properties):new PointerEvent(type,properties);
  if(timeStamp!==undefined)Object.defineProperty(event,'timeStamp',{value:timeStamp});
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
}
function tap(extra:PointerEventInit={},target:EventTarget=paragraph){for(const type of ['pointerdown','pointerup','click'])point(type,extra,target);}
it.each(['mouse','touch','pen'])('dismisses once after a completed primary %s tap and never on down',pointerType=>{
  point('pointerdown',{pointerType});expect(close).not.toHaveBeenCalled();
  point('pointerup',{pointerType});expect(close).not.toHaveBeenCalled();
  point('click',{pointerType});expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('accepts positive-detail native clicks without a pointer sequence and ignores keyboard activation',()=>{
  point('click',{detail:0});expect(close).not.toHaveBeenCalled();
  point('click');expect(close).toHaveBeenCalledOnce();
  point('pointerdown',{pointerType:'touch'},paragraph,1000);point('pointerup',{pointerType:'touch'},paragraph,1050);
  point('click',{detail:0},paragraph,1400);expect(close).toHaveBeenCalledTimes(2);
});
it('leaves a drag, touch scroll and active text selection intact',()=>{
  point('pointerdown');point('pointermove',{clientX:40});point('pointerup');point('click');
  point('pointerdown',{pointerType:'touch'});doc.dispatchEvent(new Event('scroll'));point('pointerup');point('click');
  const range=doc.createRange();range.selectNodeContents(paragraph);doc.getSelection()!.addRange(range);
  tap();tick();expect(doc.getSelection()!.toString()).toBe(paragraph.textContent);expect(close).not.toHaveBeenCalled();
});
it('dismisses from an undecorated page, the iframe background and its outer gutter',()=>{
  for(const [index,target] of [doc.body,doc.documentElement,owner].entries()){
    tap({clientX:85,pointerType:'touch'},target);tick();
    expect(close).toHaveBeenCalledTimes(index+1);
  }
});
it('allows native link activation once and closes even if navigation replaces the originating frame',()=>{
  const link=doc.createElement('a');link.href=doc.URL+'#destination';link.textContent='Continue';doc.body.append(link);
  const navigated=vi.fn((e:Event)=>{
    expect(e.defaultPrevented).toBe(false);
    watch.relocated();
    frame.remove(); // epub.js may recycle the old chapter while following a link.
  });
  link.addEventListener('click',navigated);
  tap({},link);expect(navigated).toHaveBeenCalledOnce();tick();
  expect(close).toHaveBeenCalledOnce();
});
it('leaves modified clicks, active controls and a long press alone',()=>{
  for(const modifier of ['altKey','shiftKey','ctrlKey','metaKey']){tap({[modifier]:true});tick();}
  const input=doc.createElement('input');doc.body.append(input);tap({},input);tick();
  const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');doc.body.append(dialog);
  const link=doc.createElement('a');link.href=doc.URL+'#inside';dialog.append(link);tap({},link);tick();
  point('pointerdown',{pointerType:'touch'});paragraph.dispatchEvent(new Event('contextmenu',{bubbles:true}));
  point('pointerup',{pointerType:'touch'});point('click');tick();
  expect(close).not.toHaveBeenCalled();
});
it('keeps clicks in another popup local and accepts the next plain book click',()=>{
  const overlay=document.createElement('aside');overlay.setAttribute('data-english-reader-popup','');document.body.append(overlay);
  try{
    tap({},overlay);expect(close).not.toHaveBeenCalled();
    tap();expect(close).toHaveBeenCalledOnce();
    expect(overlay.isConnected).toBe(true);
  }finally{overlay.remove();}
});
it('an earlier press and the later part of a double click cannot dismiss a newly opened panel',()=>{
  point('pointerdown');const next=vi.fn();action.current=next;
  point('pointerup');point('click');expect(next).not.toHaveBeenCalled();
  tap();expect(next).toHaveBeenCalledOnce();
  action.current=close;tap({detail:2});point('dblclick',{detail:2});tick();
  expect(close).not.toHaveBeenCalled();expect(next).toHaveBeenCalledOnce();
  watch.dispose();tap();expect(close).not.toHaveBeenCalled();
});

it('keeps the original word on a second click after epub.js replaced the first chapter frame',()=>{
  watch.dispose();
  Object.defineProperty(doc,'caretPositionFromPoint',{value:()=>({offsetNode:paragraph.firstChild,offset:6})});
  const selected=vi.fn(),resolver=vi.fn<()=>Range|null>();
  const remember=vi.fn((range:Range)=>{
    expect(range.toString()).toBe('light');return {range:resolver,selected};
  });
  watch=watchBookSurfaceTaps(owner,action,remember);const detach=watch.addFrame(doc);
  close.mockImplementation(()=>{action.current=null;});
  tap();expect(close).toHaveBeenCalledOnce();expect(remember).toHaveBeenCalledOnce();
  detach();frame.remove();const replacement=document.createElement('iframe');owner.append(replacement);
  const newDoc=replacement.contentDocument!;
  newDoc.body.innerHTML='<p>The light appeared.</p><p>Elsewhere</p>';
  watch.addFrame(newDoc);
  const source=newDoc.querySelector('p')!.firstChild!;
  const range=newDoc.createRange();range.setStart(source,4);range.setEnd(source,9);resolver.mockReturnValue(range);
  tap({detail:1},newDoc.querySelectorAll('p')[1]);
  expect(newDoc.getSelection()?.toString()).toBe('light');expect(selected).toHaveBeenCalledOnce();
});
it('a recycled CFI cannot stop the first click closing the drawer',()=>{
  watch.dispose();
  Object.defineProperty(doc,'caretPositionFromPoint',{value:()=>({offsetNode:paragraph.firstChild,offset:4})});
  const remember=vi.fn(()=>{throw new Error('Chapter replaced');});
  watch=watchBookSurfaceTaps(owner,action,remember);watch.addFrame(doc);
  tap();expect(remember).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
});
