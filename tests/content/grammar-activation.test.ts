// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {installActivation,type ActivationOptions} from '../../apps/extension/src/content/activation';
import {createGrammarGesture,GRAMMAR_GESTURE_MAX_MS,isCleanLeftAlt} from '../../apps/extension/src/content/grammar-gesture';
import * as extraction from '../../apps/extension/src/content/extraction';
const disposals:(()=>void)[]=[];
afterEach(()=>{disposals.splice(0).reverse().forEach(dispose=>dispose());vi.restoreAllMocks();document.getSelection()?.removeAllRanges();document.body.replaceChildren();});
const alt={key:'Alt',code:'AltLeft',isTrusted:true,repeat:false,isComposing:false,ctrlKey:false,shiftKey:false,altKey:true,metaKey:false};
const key=(overrides:Record<string,unknown>={},path:EventTarget[]=[])=>({...alt,composedPath:()=>path,getModifierState:()=>false,...overrides}) as unknown as KeyboardEvent;
function selected(doc=document,word='bank'):extraction.ExtractedText&{ok:true}{
 const p=doc.createElement('p');p.textContent=`The ${word} is green.`;doc.body.append(p);
 const range=doc.createRange();range.setStart(p.firstChild!,4);range.setEnd(p.firstChild!,4+word.length);range.getBoundingClientRect=()=>new DOMRect(8,8,50,20);
 return {ok:true,range,expression:word,origin:'selection',context:{sentence:p.textContent,targetStart:4,targetEnd:4+word.length}};
}
function setup(options:Partial<ActivationOptions>={}){
 const doc=options.document??document,target=doc.defaultView??doc;
 const add=vi.spyOn(target,'addEventListener'),docAdd=vi.spyOn(doc,'addEventListener');
 const onActivate=vi.fn(),onGrammarActivate=vi.fn(),onStatus=vi.fn();
 const dispose=installActivation({document:doc,onActivate,onGrammarActivate,onStatus,getGrammarEnabled:()=>true,...options});disposals.push(dispose);
 const listener=(type:string)=>add.mock.calls.filter(([kind])=>kind===type).at(-1)![1] as (event:KeyboardEvent)=>void;
 const move=docAdd.mock.calls.filter(([kind])=>kind==='mousemove').at(-1)![1] as (event:MouseEvent)=>void;
 return {down:listener('keydown'),up:listener('keyup'),move,onActivate,onGrammarActivate,onStatus,dispose};
}
function hover(move:(event:MouseEvent)=>void,x=20,y=30){move({isTrusted:true,clientX:x,clientY:y,composedPath:()=>[]} as unknown as MouseEvent);}
describe('clean LeftAlt grammar gesture',()=>{
 it('requires a physical trusted LeftAlt without chords, composition or editing',()=>{
  expect(isCleanLeftAlt(key())).toBe(true);
  for(const override of [{isTrusted:false},{repeat:true},{code:'AltRight'},{key:'AltGraph'},{shiftKey:true},{ctrlKey:true},{metaKey:true},{isComposing:true},{keyCode:229},{getModifierState:()=>true}])expect(isCleanLeftAlt(key(override))).toBe(false);
  expect(isCleanLeftAlt(key(),true)).toBe(false);expect(isCleanLeftAlt(key(),false,true)).toBe(false);
 });
 it('consumes one fresh down/up and rejects stale releases or clock rollback',()=>{
  let now=100;const gesture=createGrammarGesture<string>(()=>now);
  expect(gesture.release(key(),true)).toBeNull();gesture.begin(key(),'sentence',true);expect(gesture.release(key({altKey:false}),true)).toBe('sentence');expect(gesture.release(key(),true)).toBeNull();
  gesture.begin(key(),'old',true);now+=GRAMMAR_GESTURE_MAX_MS+1;expect(gesture.release(key(),true)).toBeNull();
  gesture.begin(key(),'future',true);now--;expect(gesture.release(key(),true)).toBeNull();
 });
 it('defaults OFF and performs no extraction when disabled or before a release',()=>{
  const value=selected(),extract=vi.spyOn(extraction,'extractSelection').mockReturnValue(value);
  const disabled=setup({getGrammarEnabled:undefined});disabled.down(key());disabled.up(key({altKey:false}));expect(extract).not.toHaveBeenCalled();
  const enabled=setup();enabled.down(key());expect(enabled.onGrammarActivate).not.toHaveBeenCalled();enabled.up(key({altKey:false}));
  expect(enabled.onGrammarActivate).toHaveBeenCalledExactlyOnceWith(value,value.range.getBoundingClientRect());expect(enabled.onActivate).not.toHaveBeenCalled();
 });
 it('cancels every chord/repeat/IME interruption rather than generating on Alt release',()=>{
  vi.spyOn(extraction,'extractSelection').mockReturnValue(selected());const own=setup();
  for(const interrupt of [{key:'a',code:'KeyA'},{key:'Control',code:'ControlLeft',ctrlKey:true},{key:'Shift',code:'ShiftLeft',shiftKey:true},{repeat:true},{isTrusted:false},{isComposing:true},{keyCode:229}]){
   own.down(key());own.down(key(interrupt));own.up(key({altKey:false}));
  }
  expect(own.onGrammarActivate).not.toHaveBeenCalled();expect(own.onActivate).not.toHaveBeenCalled();
  own.down(key());document.dispatchEvent(new CompositionEvent('compositionstart'));document.dispatchEvent(new CompositionEvent('compositionend'));own.up(key({altKey:false}));expect(own.onGrammarActivate).not.toHaveBeenCalled();
 });
 it('preserves Shift lookup while rejecting edit fields and source changes during Alt',()=>{
  const first=selected(),second=selected(document,'shore'),select=vi.spyOn(extraction,'extractSelection').mockReturnValue(first),own=setup();
  own.down(key({key:'Shift',code:'ShiftLeft',altKey:false}));expect(own.onActivate).toHaveBeenCalledOnce();
  own.down(key());select.mockReturnValue(second);own.up(key({altKey:false}));expect(own.onGrammarActivate).not.toHaveBeenCalled();
  const input=document.createElement('input');document.body.append(input);input.focus();own.down(key());own.up(key({altKey:false}));expect(own.onGrammarActivate).not.toHaveBeenCalled();
 });
 it('cancels on blur, pointer movement, pointerdown, scroll gesture and revoked opt-in',()=>{
  let enabled=true;vi.spyOn(extraction,'extractSelection').mockReturnValue(selected());const own=setup({getGrammarEnabled:()=>enabled});
  for(const cancel of [()=>window.dispatchEvent(new FocusEvent('blur')),()=>document.dispatchEvent(new Event('pointerdown')),()=>document.dispatchEvent(new WheelEvent('wheel')),()=>{hover(own.move);hover(own.move,21,30);},()=>{enabled=false;}]){
   enabled=true;own.down(key());cancel();own.up(key({altKey:false}));
  }
  expect(own.onGrammarActivate).not.toHaveBeenCalled();
 });
 it('never extracts, generates or looks up on trusted hover alone',()=>{
  const select=vi.spyOn(extraction,'extractSelection'),point=vi.spyOn(extraction,'extractAtPoint'),own=setup();
  for(let i=0;i<50;i++)hover(own.move,i,i);
  expect(select).not.toHaveBeenCalled();expect(point).not.toHaveBeenCalled();expect(own.onGrammarActivate).not.toHaveBeenCalled();expect(own.onActivate).not.toHaveBeenCalled();
 });
 it('cannot use a pending source after its frame is detached or replaced',()=>{
  const frame=document.createElement('iframe');document.body.append(frame);const doc=frame.contentDocument!,value=selected(doc);
  vi.spyOn(extraction,'extractSelection').mockReturnValue(value);const own=setup({document:doc,popupDocument:document});own.down(key());frame.remove();own.up(key({altKey:false}));own.down(key({key:'Shift',altKey:false}));expect(own.onGrammarActivate).not.toHaveBeenCalled();expect(own.onActivate).not.toHaveBeenCalled();
 });
 it('suppresses same grammar source without preventing a Shift lookup of that source',()=>{
  const value=selected();vi.spyOn(extraction,'extractSelection').mockReturnValue(value);const own=setup({getActiveSelection:()=>value,getActiveKind:()=> 'grammar'});
  own.down(key());own.up(key({altKey:false}));expect(own.onGrammarActivate).not.toHaveBeenCalled();own.down(key({key:'Shift',altKey:false}));expect(own.onActivate).toHaveBeenCalledOnce();
 });
});
describe('book frame hover with keyboard focus outside iframe',()=>{
 function frames(){const frames=[document.createElement('iframe'),document.createElement('iframe')];frames.forEach(frame=>document.body.append(frame));return frames;}
 it('routes parent Shift and clean Alt only to the current hovered frame',()=>{
  const docs=frames().map(frame=>frame.contentDocument!),values=docs.map(doc=>selected(doc));
  vi.spyOn(extraction,'extractSelection').mockReturnValue(null);vi.spyOn(extraction,'extractAtPoint').mockImplementation(doc=>values[docs.indexOf(doc)]);
  const add=vi.spyOn(window,'addEventListener');const first=setup({document:docs[0],popupDocument:document}),second=setup({document:docs[1],popupDocument:document});
  const invoke=(type:string,event:KeyboardEvent)=>add.mock.calls.filter(([kind])=>kind===type).forEach(([,listener])=>(listener as (event:KeyboardEvent)=>void)(event));
  const toolbar=document.createElement('button');document.body.append(toolbar);toolbar.focus();hover(first.move);hover(second.move);
  invoke('keydown',key({key:'Shift',altKey:false},[toolbar]));expect(first.onActivate).not.toHaveBeenCalled();expect(second.onActivate).toHaveBeenCalledExactlyOnceWith(values[1],values[1].range.getBoundingClientRect());
  invoke('keydown',key({},[toolbar]));invoke('keyup',key({altKey:false},[toolbar]));expect(first.onGrammarActivate).not.toHaveBeenCalled();expect(second.onGrammarActivate).toHaveBeenCalledOnce();
 });
 it('does not route through a focused editable parent control or a stale hover',()=>{
  const doc=frames()[0].contentDocument!,value=selected(doc);vi.spyOn(extraction,'extractSelection').mockReturnValue(null);vi.spyOn(extraction,'extractAtPoint').mockReturnValue(value);
  const add=vi.spyOn(window,'addEventListener'),docAdd=vi.spyOn(document,'addEventListener'),own=setup({document:doc,popupDocument:document});
  const parent=add.mock.calls.filter(([kind])=>kind==='keydown').at(-1)![1] as (event:KeyboardEvent)=>void;
  const input=document.createElement('input');document.body.append(input);input.focus();hover(own.move);parent(key({key:'Shift',altKey:false},[input]));expect(own.onActivate).not.toHaveBeenCalled();input.blur();
  const parentMove=docAdd.mock.calls.filter(([kind])=>kind==='pointermove').at(-1)![1] as (event:MouseEvent)=>void;parentMove({isTrusted:true,composedPath:()=>[document.body]} as unknown as MouseEvent);
  parent(key({key:'Shift',altKey:false}));expect(own.onActivate).not.toHaveBeenCalled();
 });
 it('replaces an automatic hover lookup when the same token is then selected manually',()=>{
  const value=selected(),active={...value,origin:'hover' as const};vi.spyOn(extraction,'extractSelection').mockReturnValue(value);
  const own=setup({getActiveSelection:()=>active,getActiveKind:()=> 'lookup'});own.down(key({key:'Shift',altKey:false}));expect(own.onActivate).toHaveBeenCalledExactlyOnceWith(value,value.range.getBoundingClientRect());
 });
 it('never activates both retained frames from old selections',()=>{
  const docs=frames().map(frame=>frame.contentDocument!),values=docs.map(doc=>selected(doc));vi.spyOn(extraction,'extractSelection').mockImplementation(doc=>values[docs.indexOf(doc)]);
  const add=vi.spyOn(window,'addEventListener'),a=setup({document:docs[0],popupDocument:document}),b=setup({document:docs[1],popupDocument:document});
  const parent=()=>add.mock.calls.filter(([kind])=>kind==='keydown').forEach(([,listener])=>(listener as (event:KeyboardEvent)=>void)(key({key:'Shift',altKey:false})));
  parent();expect(a.onActivate).not.toHaveBeenCalled();expect(b.onActivate).not.toHaveBeenCalled();hover(a.move);parent();expect(a.onActivate).toHaveBeenCalledOnce();expect(b.onActivate).not.toHaveBeenCalled();
 });
});
