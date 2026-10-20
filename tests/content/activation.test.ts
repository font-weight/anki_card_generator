// @vitest-environment jsdom
import {describe,expect,it,vi} from 'vitest';
import {installActivation,shouldActivate} from '../../apps/extension/src/content/activation';
import * as extraction from '../../apps/extension/src/content/extraction';
const shift={key:'Shift',isTrusted:true,repeat:false,isComposing:false,ctrlKey:false,altKey:false,metaKey:false};
describe('explicit trusted Shift activation',()=>{
  it('allows only a fresh trusted Shift without modifiers',()=>{
    expect(shouldActivate(shift)).toBe(true);
    for(const override of [{key:'A'},{isTrusted:false},{repeat:true},{isComposing:true},{ctrlKey:true},{altKey:true},{metaKey:true}]) expect(shouldActivate({...shift,...override})).toBe(false);
    expect(shouldActivate(shift,true)).toBe(false);expect(shouldActivate(shift,false,true)).toBe(false);
  });
  it('never invokes callbacks for movement or synthetic Shift',()=>{
    const onActivate=vi.fn(),onStatus=vi.fn(),getLocale=vi.fn(()=> 'ja-JP');const dispose=installActivation({document,onActivate,onStatus,getLocale});
    for(let i=0;i<100;i++) document.dispatchEvent(new MouseEvent('mousemove',{clientX:i,clientY:i}));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));
    expect(onActivate).not.toHaveBeenCalled();expect(onStatus).not.toHaveBeenCalled();expect(getLocale).not.toHaveBeenCalled();dispose();
  });
  it('reads the current cached locale only after a fresh trusted activation',()=>{
    const add=vi.spyOn(document,'addEventListener');
    const select=vi.spyOn(extraction,'extractSelection').mockReturnValue(null);
    let locale='ja-JP';const getLocale=vi.fn(()=>locale);
    const dispose=installActivation({document,getLocale,onActivate:vi.fn()});
    const listener=add.mock.calls.find(([type])=>type==='keydown')![1] as (event:KeyboardEvent)=>void;
    // Native isTrusted cannot be set by script. Exercise the captured listener
    // directly while the separate synthetic-event test verifies the DOM guard.
    const key={...shift,composedPath:()=>[]} as unknown as KeyboardEvent;
    try{
      expect(getLocale).not.toHaveBeenCalled();
      for(const override of [{key:'A'},{isTrusted:false},{repeat:true},{isComposing:true},{ctrlKey:true},{altKey:true},{metaKey:true}])listener({...key,...override});
      expect(getLocale).not.toHaveBeenCalled();
      listener(key);expect(select).toHaveBeenLastCalledWith(document,'ja-JP');
      locale='ar-SA';listener(key);expect(select).toHaveBeenLastCalledWith(document,'ar-SA');
      expect(getLocale).toHaveBeenCalledTimes(2);
    }finally{dispose();select.mockRestore();add.mockRestore();}
  });
  it('can install and remove listeners without leaking handlers',()=>{
    const add=vi.spyOn(document,'addEventListener'),remove=vi.spyOn(document,'removeEventListener');
    const dispose=installActivation({document,onActivate:vi.fn()});dispose();
    for(const [type,handler] of add.mock.calls) expect(remove.mock.calls.some(c=>c[0]===type&&c[1]===handler)).toBe(true);
    add.mockRestore();remove.mockRestore();
  });
});
