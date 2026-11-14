// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {rpc} from '../../apps/extension/src/runtime/rpc-client';
const success=(message:any,data:unknown={})=>({v:1,requestId:message.requestId,ok:true,data});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('popup RPC request cancellation',()=>{
  it.each(['lookup','lookup.refine','card.enrich'])('cancels pending %s by its exact request ID, once',async type=>{
    let finish!:(value:unknown)=>void;
    const send=vi.fn((message:any)=>message.type==='lookup.cancel'?Promise.resolve(success(message,{cancelled:true})):new Promise(resolve=>{finish=resolve;}));
    vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    const controller=new AbortController(),pending=rpc(type,{expression:'bank'},{signal:controller.signal});
    const result=expect(pending).rejects.toMatchObject({name:'AbortError'});
    controller.abort();controller.abort();await result;
    expect(send).toHaveBeenCalledTimes(2);
    const original=send.mock.calls[0][0],cancel=send.mock.calls[1][0];
    expect(cancel).toMatchObject({v:1,type:'lookup.cancel',payload:{requestId:original.requestId}});
    expect(cancel.requestId).not.toBe(original.requestId);expect(cancel.payload).not.toHaveProperty('operationId');
    finish(success(original,{stale:true}));await Promise.resolve();expect(send).toHaveBeenCalledTimes(2);
  });
  it('never dispatches a lookup when its popup closed before lookup start',async()=>{
    const send=vi.fn();vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    const controller=new AbortController();controller.abort();
    await expect(rpc('lookup',{}, {signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});expect(send).not.toHaveBeenCalled();
  });
  it('removes abort listeners after success instead of canceling a completed or newer lookup',async()=>{
    const send=vi.fn(async(message:any)=>success(message,{lookupId:'done'}));vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    const controller=new AbortController();await expect(rpc('lookup',{}, {signal:controller.signal})).resolves.toEqual({lookupId:'done'});
    controller.abort();expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(['anki.addNote','grammar.addNote','queue.retry','audio.prepare','audio.play'])('does not abort dispatched %s when a popup closes',async type=>{
    let finish!:(value:unknown)=>void;const send=vi.fn((_message:any)=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    const controller=new AbortController();const result=rpc(type,{operationId:'keep-same-intent'},{signal:controller.signal});controller.abort();
    expect(send).toHaveBeenCalledTimes(1);finish(success(send.mock.calls[0][0],{status:'queued'}));await expect(result).resolves.toEqual({status:'queued'});
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('best-effort cancellation tolerates a disconnected worker without resending a lookup',async()=>{
    const send=vi.fn((message:any)=>{if(message.type==='lookup.cancel')throw new Error('worker disconnected');return new Promise(()=>{});});
    vi.stubGlobal('chrome',{runtime:{sendMessage:send}});const controller=new AbortController();
    const result=expect(rpc('lookup',{}, {signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});controller.abort();await result;expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(['lookup','anki.addNote'])('times out %s without cancelling any save',async type=>{
    vi.useFakeTimers();const send=vi.fn((message:any)=>message.type==='lookup.cancel'?Promise.resolve(success(message)):new Promise(()=>{}));vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    const result=expect(rpc(type,{})).rejects.toThrow('Превышено время ожидания');await vi.advanceTimersByTimeAsync(45000);await result;
    expect(send.mock.calls.map(([message])=>message.type)).toEqual(type==='lookup'?['lookup','lookup.cancel']:['anki.addNote']);
  });
});

describe('actionable public RPC errors',()=>{
  it.each(['INVALID_MODEL_OUTPUT','ANKI_SCHEMA_MISMATCH','MODEL_INCOMPLETE','NETWORK_TIMEOUT'])('preserves only the %s public code and message',async code=>{
    const send=vi.fn(async(message:any)=>({v:1,requestId:message.requestId,ok:false,error:{code,message:'Public safe message',retryable:true,details:'PRIVATE PROVIDER BODY',apiKey:'PRIVATE KEY'}}));
    vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    let caught:unknown;try{await rpc('lookup',{});}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(Error);expect(caught).toMatchObject({code,message:'Public safe message'});
    expect(Object.keys(caught as object)).toEqual(['code']);
    expect(JSON.stringify(caught)).not.toMatch(/PRIVATE|details|apiKey|retryable/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not forward unknown error codes or non-string messages',async()=>{
    const send=vi.fn(async(message:any)=>({v:1,requestId:message.requestId,ok:false,error:{code:'UNKNOWN PRIVATE CODE',message:{raw:'PRIVATE'},details:'PRIVATE'}}));
    vi.stubGlobal('chrome',{runtime:{sendMessage:send}});
    let caught:unknown;try{await rpc('lookup',{});}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(Error);expect(caught).toHaveProperty('message','Не удалось выполнить операцию.');
    expect(caught).not.toHaveProperty('code');expect(JSON.stringify(caught)).not.toContain('PRIVATE');
  });
});


describe('bounded lookup diagnostic transport', () => {
  it('preserves the allowlisted stage and reason without raw provider details', async () => {
    const send = vi.fn(async (message: any) => ({v: 1, requestId: message.requestId, ok: false, error: {
      code: 'INVALID_MODEL_OUTPUT', message: 'Public message', retryable: false,
      diagnostics: {stage: 'validation', reason: 'translation_language'}, raw: 'SECRET BODY', requestId: 'PRIVATE',
    }}));
    vi.stubGlobal('chrome', {runtime: {sendMessage: send}});
    let caught: unknown; try { await rpc('lookup', {}); } catch (error) { caught = error; }
    expect(caught).toMatchObject({code: 'INVALID_MODEL_OUTPUT', diagnostics: {stage: 'validation', reason: 'translation_language'}});
    expect(Object.keys(caught as object).sort()).toEqual(['code', 'diagnostics']);
    expect(JSON.stringify(caught)).not.toMatch(/SECRET|PRIVATE|raw|requestId/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    {stage: 'validation', reason: 'PRIVATE-CONTEXT'},
    {stage: 'PRIVATE-KEY', reason: 'lookup_shape'},
    {stage: 'validation', reason: 'lookup_shape', raw: 'PRIVATE-RESPONSE'},
    {stage: 'validation'},
    ['validation', 'lookup_shape'],
    null,
  ])('drops malformed diagnostic object %# without losing its public code', async diagnostics => {
    const send = vi.fn(async (message: any) => ({v: 1, requestId: message.requestId, ok: false, error: {
      code: 'OPENAI_REQUEST_REJECTED', message: 'Public message', retryable: false, diagnostics,
    }}));
    vi.stubGlobal('chrome', {runtime: {sendMessage: send}});
    let caught: unknown; try { await rpc('lookup', {}); } catch (error) { caught = error; }
    expect(caught).toHaveProperty('code', 'OPENAI_REQUEST_REJECTED');
    expect(caught).not.toHaveProperty('diagnostics');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
