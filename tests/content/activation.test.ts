// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {installActivation,isReadingPopupEvent,shouldActivate,type ActivationOptions} from '../../apps/extension/src/content/activation';
import * as extraction from '../../apps/extension/src/content/extraction';
const shift={key:'Shift',isTrusted:true,repeat:false,isComposing:false,ctrlKey:false,altKey:false,metaKey:false};
const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(dispose=>dispose());vi.restoreAllMocks();document.body.replaceChildren();document.getSelection()?.removeAllRanges();});
function key(path:EventTarget[]=[] ,override:Record<string,unknown>={}):KeyboardEvent{return{...shift,composedPath:()=>path,...override} as unknown as KeyboardEvent;}
function install(options:Partial<ActivationOptions>={}){
  const doc=options.document??document,target=doc.defaultView??doc;
  const add=vi.spyOn(target,'addEventListener');
  const onActivate=vi.fn(),onStatus=vi.fn();
  const dispose=installActivation({document:doc,onActivate,onStatus,...options});cleanup.push(dispose);
  const listener=add.mock.calls.filter(([type])=>type==='keydown').at(-1)![1] as (event:KeyboardEvent)=>void;
  return{listener,onActivate,onStatus,dispose};
}
function selection(doc=document,word='bank'):extraction.ExtractedText&{ok:true}{
  const p=doc.createElement('p');p.textContent=`The ${word} is green.`;doc.body.append(p);
  const range=doc.createRange();range.setStart(p.firstChild!,4);range.setEnd(p.firstChild!,4+word.length);
  range.getBoundingClientRect=()=>new DOMRect(4,8,word.length*8,20);
  return{ok:true,range,expression:word,context:{sentence:p.textContent,targetStart:4,targetEnd:4+word.length}};
}
describe('explicit trusted Shift activation',()=>{
  it('allows only a fresh trusted Shift without modifiers or IME legacy keycode',()=>{
    expect(shouldActivate(shift)).toBe(true);
    for(const override of [{key:'A'},{isTrusted:false},{repeat:true},{isComposing:true},{keyCode:229},{ctrlKey:true},{altKey:true},{metaKey:true}])expect(shouldActivate({...shift,...override})).toBe(false);
    expect(shouldActivate(shift,true)).toBe(false);expect(shouldActivate(shift,false,true)).toBe(false);
  });
  it('never invokes callbacks or preferences for movement or synthetic Shift',()=>{
    const getLocale=vi.fn(()=> 'ja-JP');const {onActivate,onStatus}=install({getLocale});
    for(let i=0;i<100;i++)document.dispatchEvent(new MouseEvent('mousemove',{clientX:i,clientY:i}));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));
    expect(onActivate).not.toHaveBeenCalled();expect(onStatus).not.toHaveBeenCalled();expect(getLocale).not.toHaveBeenCalled();
  });
  it('reads the current cached locale only after a fresh trusted activation',()=>{
    const select=vi.spyOn(extraction,'extractSelection').mockReturnValue(null);
    let locale='ja-JP';const getLocale=vi.fn(()=>locale),{listener}=install({getLocale});
    for(const override of [{key:'A'},{isTrusted:false},{repeat:true},{isComposing:true},{keyCode:229},{ctrlKey:true},{altKey:true},{metaKey:true}])listener(key([],override));
    expect(getLocale).not.toHaveBeenCalled();
    listener(key());expect(select).toHaveBeenLastCalledWith(document,'ja-JP');
    locale='ar-SA';listener(key());expect(select).toHaveBeenLastCalledWith(document,'ar-SA');expect(getLocale).toHaveBeenCalledTimes(2);
  });
  it('replaces a new selected range while the old noneditable popup is focused, not the same open selection',()=>{
    const first=selection(),next=selection(document,'shore');let active:extraction.ExtractedText|null=first;
    const select=vi.spyOn(extraction,'extractSelection').mockReturnValue(first);
    const {listener,onActivate}=install({getActiveSelection:()=>active,isPopupEvent:()=>true});
    listener(key());listener(key());expect(onActivate).not.toHaveBeenCalled();
    select.mockReturnValue(next);listener(key());
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(next,next.range.getBoundingClientRect());
    active=next;listener(key());expect(onActivate).toHaveBeenCalledTimes(1);
    active=null;listener(key());expect(onActivate).toHaveBeenCalledTimes(1);
  });
  it('allows a dismissed selection again and identical words at a different position',()=>{
    const first=selection(),next=selection();let active:extraction.ExtractedText|null=first;
    const select=vi.spyOn(extraction,'extractSelection').mockReturnValue(first);
    const {listener,onActivate}=install({getActiveSelection:()=>active});
    listener(key());expect(onActivate).not.toHaveBeenCalled();
    active=null;listener(key());expect(onActivate).toHaveBeenLastCalledWith(first,first.range.getBoundingClientRect());
    active=first;select.mockReturnValue(next);listener(key());expect(onActivate).toHaveBeenCalledTimes(2);
  });
  it('preserves the exact selection object, sentence offsets and range rather than re-extracting under the cursor',()=>{
    const selected=selection(document,'e\u0301cole');
    vi.spyOn(extraction,'extractSelection').mockReturnValue(selected);
    const point=vi.spyOn(extraction,'extractAtPoint');const {listener,onActivate}=install();listener(key());
    expect(onActivate.mock.calls[0][0]).toBe(selected);expect(onActivate.mock.calls[0][0].expression).toBe('e\u0301cole');
    expect(onActivate.mock.calls[0][0].context.sentence.slice(4,10)).toBe('e\u0301cole');expect(point).not.toHaveBeenCalled();
  });
  it('never turns editable page fields or popup shadow fields into lookups',()=>{
    vi.spyOn(extraction,'extractSelection').mockReturnValue(selection());
    const {listener,onActivate}=install();
    for(const tag of ['input','textarea','select']){const field=document.createElement(tag);document.body.append(field);listener(key([field]));field.focus();listener(key());field.remove();}
    const host=document.createElement('div');host.dataset.englishReaderPopup='';document.body.append(host);
    const shadow=host.attachShadow({mode:'open'});const input=document.createElement('input');shadow.append(input);
    listener(key([input,shadow,host]));
    const editable=document.createElement('div');editable.contentEditable='true';editable.setAttribute('contenteditable','true');listener(key([editable]));
    expect(onActivate).not.toHaveBeenCalled();
  });
  it('suppresses composition until compositionend and recovers after window blur',()=>{
    vi.spyOn(extraction,'extractSelection').mockReturnValue(selection());const {listener,onActivate}=install();
    document.dispatchEvent(new CompositionEvent('compositionstart'));listener(key());expect(onActivate).not.toHaveBeenCalled();
    document.dispatchEvent(new CompositionEvent('compositionend'));listener(key());expect(onActivate).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new CompositionEvent('compositionstart'));window.dispatchEvent(new FocusEvent('blur'));listener(key());expect(onActivate).toHaveBeenCalledTimes(2);
  });
  it('tracks trusted pointer coordinates but never performs a hover lookup or reuses a popup hover',()=>{
    const add=vi.spyOn(document,'addEventListener');const select=vi.spyOn(extraction,'extractSelection').mockReturnValue(null);
    const result=selection(),point=vi.spyOn(extraction,'extractAtPoint').mockReturnValue(result);
    const {listener,onActivate}=install();
    const move=add.mock.calls.find(([type])=>type==='mousemove')![1] as (e:MouseEvent)=>void;
    move({isTrusted:true,clientX:20,clientY:30,composedPath:()=>[]} as unknown as MouseEvent);
    expect(select).not.toHaveBeenCalled();expect(point).not.toHaveBeenCalled();listener(key());expect(point).toHaveBeenCalledWith(document,20,30,undefined);
    const host=document.createElement('div');host.dataset.englishReaderPopup='';
    move({isTrusted:true,clientX:80,clientY:90,composedPath:()=>[host]} as unknown as MouseEvent);listener(key());expect(onActivate).toHaveBeenCalledTimes(1);
    move({isTrusted:true,clientX:20,clientY:30,composedPath:()=>[]} as unknown as MouseEvent);window.dispatchEvent(new FocusEvent('blur'));listener(key());expect(onActivate).toHaveBeenCalledTimes(1);
  });
  it('recognizes shadow popup paths without depending on parent-realm HTMLElement',()=>{
    const frame=document.createElement('iframe');document.body.append(frame);const doc=frame.contentDocument!;
    const host=doc.createElement('div');host.dataset.englishReaderPopup='';doc.body.append(host);
    const shadow=host.attachShadow({mode:'open'}),button=doc.createElement('button');shadow.append(button);
    expect(isReadingPopupEvent({composedPath:()=>[button,shadow,host]} as unknown as Event)).toBe(true);
  });
  it('forwards parent popup Shift only to its active source document and detaches both listeners',()=>{
    const frames=[document.createElement('iframe'),document.createElement('iframe')];frames.forEach(frame=>document.body.append(frame));
    const docs=frames.map(frame=>frame.contentDocument!),old=selection(docs[0]),next=selection(docs[0],'shore'),other=selection(docs[1],'river');
    vi.spyOn(extraction,'extractSelection').mockImplementation(doc=>doc===docs[0]?next:other);
    const add=vi.spyOn(window,'addEventListener'),remove=vi.spyOn(window,'removeEventListener');
    const first=install({document:docs[0],popupDocument:document,getActiveSelection:()=>old,isPopupEvent:()=>true});
    const second=install({document:docs[1],popupDocument:document,getActiveSelection:()=>old,isPopupEvent:()=>true});
    const listeners=add.mock.calls.filter(([type])=>type==='keydown').map(([,fn])=>fn as (e:KeyboardEvent)=>void);
    listeners.forEach(fn=>fn(key()));expect(first.onActivate).toHaveBeenCalledExactlyOnceWith(next,next.range.getBoundingClientRect());expect(second.onActivate).not.toHaveBeenCalled();
    first.dispose();second.dispose();listeners.forEach(fn=>fn(key()));expect(first.onActivate).toHaveBeenCalledTimes(1);
    for(const listener of listeners)expect(remove.mock.calls.some(([type,fn])=>type==='keydown'&&fn===listener)).toBe(true);
  });
  it('one registration per document prevents duplicate calls and old teardown does not remove its successor',()=>{
    vi.spyOn(extraction,'extractSelection').mockReturnValue(selection());const first=install(),second=install();
    first.listener(key());expect(first.onActivate).not.toHaveBeenCalled();first.dispose();second.listener(key());expect(second.onActivate).toHaveBeenCalledTimes(1);
    second.dispose();second.listener(key());expect(second.onActivate).toHaveBeenCalledTimes(1);
  });
  it('rejects detached source ranges and selected text in the popup',()=>{
    const detached=selection();detached.range.startContainer.parentElement!.remove();const select=vi.spyOn(extraction,'extractSelection').mockReturnValue(detached);
    const {listener,onActivate}=install();listener(key());expect(onActivate).not.toHaveBeenCalled();
    const inside=selection();inside.range.startContainer.parentElement!.dataset.englishReaderPopup='';select.mockReturnValue(inside);listener(key());expect(onActivate).not.toHaveBeenCalled();
  });
  it('can install and remove document and window listeners without leaking handlers',()=>{
    const add=vi.spyOn(document,'addEventListener'),remove=vi.spyOn(document,'removeEventListener'),windowAdd=vi.spyOn(window,'addEventListener'),windowRemove=vi.spyOn(window,'removeEventListener');
    const dispose=installActivation({document,onActivate:vi.fn()});dispose();dispose();
    for(const [type,handler] of add.mock.calls)expect(remove.mock.calls.some(c=>c[0]===type&&c[1]===handler)).toBe(true);
    for(const [type,handler] of windowAdd.mock.calls)expect(windowRemove.mock.calls.some(c=>c[0]===type&&c[1]===handler)).toBe(true);
  });
});
