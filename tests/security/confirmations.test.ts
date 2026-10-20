import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const id='a'.repeat(32);
let create:ReturnType<typeof vi.fn>,remove:ReturnType<typeof vi.fn>;
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();create=vi.fn().mockResolvedValue({id:7});remove=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('chrome',{runtime:{id,getURL:(p:string)=>`chrome-extension://${id}/${p}`},windows:{create,remove}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const sender=(nonce:string)=>({id,url:`chrome-extension://${id}/confirm.html#${nonce}`,frameId:0});
async function setup(){const module=await import('../../apps/extension/src/runtime/confirmations');const result=module.askConfirmation('cloud_audio');const nonce=new URL(create.mock.calls[0]![0].url).hash.slice(1);await Promise.resolve();return {...module,result,nonce};}
describe('trusted confirmation host',()=>{
 it('requires exact extension page, top frame, matching nonce and boolean answer',async()=>{const {result,nonce,handleConfirmation}=await setup();
  for(const s of [{id,url:'https://evil.test/confirm.html#'+nonce},{...sender(nonce),frameId:2},{...sender(nonce),id:'other'}, {...sender(nonce),url:'invalid-url'}])expect(handleConfirmation({hostType:'confirmation.answer',nonce,accepted:true},s)).toEqual({error:'PERMISSION_DENIED'});
  expect(handleConfirmation({hostType:'confirmation.answer',nonce,accepted:'true'},sender(nonce))).toEqual({error:'INVALID_INPUT'});
  expect(handleConfirmation({hostType:'confirmation.answer',nonce:'wrong',accepted:true},sender(nonce))).toEqual({error:'EXPIRED'});
  expect(handleConfirmation({hostType:'confirmation.read',nonce},sender(nonce))).toMatchObject({kind:'cloud_audio'});
  expect(handleConfirmation({hostType:'confirmation.answer',nonce,accepted:false},sender(nonce))).toEqual({ok:true});expect(await result).toBe(false);
 });
 it('consumes accepted nonce once and closes its window',async()=>{const {result,nonce,handleConfirmation}=await setup();expect(handleConfirmation({hostType:'confirmation.answer',nonce,accepted:true},sender(nonce))).toEqual({ok:true});expect(await result).toBe(true);expect(remove).toHaveBeenCalledWith(7);expect(handleConfirmation({hostType:'confirmation.answer',nonce,accepted:true},sender(nonce))).toEqual({error:'EXPIRED'});});
 it('expires fail-closed without an answer',async()=>{const {result,nonce,handleConfirmation}=await setup();await vi.advanceTimersByTimeAsync(35001);expect(await result).toBe(false);expect(handleConfirmation({hostType:'confirmation.read',nonce},sender(nonce))).toEqual({error:'EXPIRED'});});
 it('fails closed if confirmation window cannot open',async()=>{create.mockRejectedValue(new Error('window denied'));const {result}=await setup();expect(await result).toBe(false);});
});
