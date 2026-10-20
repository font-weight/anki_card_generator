// @vitest-environment jsdom
import {describe,expect,it,vi} from 'vitest';
import {installActivation,shouldActivate} from '../../apps/extension/src/content/activation';
const shift={key:'Shift',isTrusted:true,repeat:false,isComposing:false,ctrlKey:false,altKey:false,metaKey:false};
describe('explicit trusted Shift activation',()=>{
  it('allows only a fresh trusted Shift without modifiers',()=>{
    expect(shouldActivate(shift)).toBe(true);
    for(const override of [{key:'A'},{isTrusted:false},{repeat:true},{isComposing:true},{ctrlKey:true},{altKey:true},{metaKey:true}]) expect(shouldActivate({...shift,...override})).toBe(false);
    expect(shouldActivate(shift,true)).toBe(false);expect(shouldActivate(shift,false,true)).toBe(false);
  });
  it('never invokes callbacks for movement or synthetic Shift',()=>{
    const onActivate=vi.fn(),onStatus=vi.fn();const dispose=installActivation({document,onActivate,onStatus});
    for(let i=0;i<100;i++) document.dispatchEvent(new MouseEvent('mousemove',{clientX:i,clientY:i}));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));
    expect(onActivate).not.toHaveBeenCalled();expect(onStatus).not.toHaveBeenCalled();dispose();
  });
  it('can install and remove listeners without leaking handlers',()=>{
    const add=vi.spyOn(document,'addEventListener'),remove=vi.spyOn(document,'removeEventListener');
    const dispose=installActivation({document,onActivate:vi.fn()});dispose();
    for(const [type,handler] of add.mock.calls) expect(remove.mock.calls.some(c=>c[0]===type&&c[1]===handler)).toBe(true);
    add.mockRestore();remove.mockRestore();
  });
});
