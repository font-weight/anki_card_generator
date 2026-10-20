// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openReaderStorage } from '../../packages/storage/src/index';
import { createReaderServices, SecretVault } from '../../packages/services/src/index';
import type { NoteDraft } from '../../packages/contracts/src/index';
const extensionId='abcdefghijklmnopabcdefghijklmnop';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const operationId='00000000-0000-4000-8000-000000000031';
const request=(type:string,payload:unknown={})=>({v:1,requestId:crypto.randomUUID(),type,payload});
const draft:NoteDraft={sourceLanguage:'en',targetLanguage:'ru',mode:'recognition',deckName:'Legacy test only',tags:[],expression:'bank',lemma:'bank',partOfSpeech:'noun',selectedSense:{id:'s1',translations:['берег'],definitionEn:'Land beside a river.'},context:{sentence:'The bank.',targetStart:4,targetEnd:8},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:null,source:{kind:'html',title:'Synthetic upgrade fixture',url:'https://example.test',documentId:null,page:null,chapter:null,cfi:null}};
const area=()=>({get:async()=>({}),set:async()=>{},remove:async()=>{},setAccessLevel:async()=>{}});
const apps:Array<ReturnType<typeof createReaderServices>>=[];
afterEach(()=>{apps.splice(0).forEach(app=>app.close());});
async function legacy(uncertainState?:'submitting'|'reconciling',overrides?:Record<string,unknown>){
 const indexedDB=new IDBFactory();const storage=await openReaderStorage({indexedDB});const fetch=vi.fn().mockRejectedValue(new Error('synthetic offline; network never used'));
 const make=(store:typeof storage,now?:()=>number)=>createReaderServices({storage:store,secrets:new SecretVault({session:area(),local:area()}),fetch,...now?{now}:{},runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:()=>false}});
 const old=make(storage);const added=await old.handleMessage(request('anki.addNote',{operationId,draft,includeAudio:false}),page);expect(added.ok).toBe(true);let original=await storage.getOperation(operationId);expect(original).not.toBeNull();if(uncertainState){await storage.putOperation({...original!,state:uncertainState,submissionUncertain:true,revision:original!.revision+1});original=await storage.getOperation(operationId);}
 if(overrides){await storage.putOperation({...original!,...overrides});original=await storage.getOperation(operationId);}
 // R4 accepted IPv6 and used the same generic production targetIdentity; seed that persisted state directly.
 await storage.setMetadata('preferences',{ankiEndpoint:'http://[::1]:8765',defaultDeck:'Legacy test only'});old.close();
 const reopened=await openReaderStorage({indexedDB});fetch.mockClear();const app=make(reopened,()=>Date.now()+86400000);apps.push(app);return{app,storage:reopened,fetch,original,indexedDB,make};
}
describe('R4 IPv6 preference upgrade recovery',()=>{
 it('keeps settings readable and preserves unsupported endpoint until explicit repair',async()=>{
  const{app,storage,fetch}=await legacy();const response=await app.handleMessage(request('settings.getPublic'),page);expect(response.ok).toBe(true);
  expect((await storage.getMetadata<Record<string,unknown>>('preferences'))?.ankiEndpoint).toBe('http://[::1]:8765');
  const status=await app.handleMessage(request('anki.status'),page);expect(status.ok).toBe(true);if(status.ok)expect((status.data as {available:boolean}).available).toBe(false);
  await app.resumeQueue().catch(()=>{});expect(fetch).not.toHaveBeenCalled();expect(await storage.getOperation(operationId)).not.toBeNull();
  const queue=await app.handleMessage(request('queue.list',{limit:20}),page);expect(queue.ok).toBe(true);if(queue.ok)expect((queue.data as {items:Array<{operationId:string;draft:NoteDraft}>}).items.find(item=>item.operationId===operationId)?.draft).toEqual(draft);
 });
 it('allows explicit settings repair but does not replay legacy IPv6 queue into IPv4',async()=>{
  const{app,storage,fetch,original}=await legacy();const result=await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page);expect(result.ok).toBe(true);
  expect((await storage.getMetadata<Record<string,unknown>>('preferences'))?.ankiEndpoint).toBe('http://127.0.0.1:8765');
  await app.resumeQueue().catch(()=>{});expect(fetch).not.toHaveBeenCalled();const retained=await storage.getOperation(operationId);expect(retained).not.toBeNull();expect(retained).toEqual(original);
  await app.handleMessage(request('queue.retry',{operationId}),page);expect(fetch).not.toHaveBeenCalled();
  const cancelled=await app.handleMessage(request('queue.cancel',{operationId}),page);expect(cancelled.ok).toBe(true);expect((await storage.getOperation(operationId))?.state).toBe('cancelled');expect(fetch).not.toHaveBeenCalled();
 });
 it('permits only a new explicit operation after repair while retaining the legacy draft',async()=>{
  const{app,storage,fetch}=await legacy();const repaired=await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page);expect(repaired.ok).toBe(true);expect(fetch).not.toHaveBeenCalled();
  const freshId='00000000-0000-4000-8000-000000000032';const result=await app.handleMessage(request('anki.addNote',{operationId:freshId,draft,includeAudio:false}),page);expect(result.ok).toBe(true);expect(fetch).toHaveBeenCalled();for(const call of fetch.mock.calls)expect(call[0]).toBe('http://127.0.0.1:8765/');
  expect((await storage.getOperation(operationId))?.draft).toEqual(draft);expect(await storage.getOperation(freshId)).not.toBeNull();
 });

 it('keeps the old operation quarantined after repaired settings and service restart',async()=>{
  const{app,storage,fetch,original,indexedDB,make}=await legacy();expect((await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page)).ok).toBe(true);app.close();
  const nextStore=await openReaderStorage({indexedDB});const next=make(nextStore,()=>Date.now()+172800000);apps.push(next);await next.resumeQueue().catch(()=>{});await next.handleMessage(request('queue.retry',{operationId}),page);expect(fetch).not.toHaveBeenCalled();expect(await nextStore.getOperation(operationId)).toEqual(original);
 });

 it.each(['submitting','reconciling'] as const)('does not cancel or inspect remote note for uncertain legacy %s',async state=>{
  const{app,storage,fetch,original}=await legacy(state);expect((await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page)).ok).toBe(true);
  const cancelled=await app.handleMessage(request('queue.cancel',{operationId}),page);expect(cancelled.ok).toBe(false);if(!cancelled.ok)expect(cancelled.error.code).toBe('OPERATION_CONFLICT');await app.resumeQueue().catch(()=>{});expect(fetch).not.toHaveBeenCalled();expect(await storage.getOperation(operationId)).toEqual(original);
 });
 it('allows safe local cancellation before endpoint repair without changing saved unsupported preference',async()=>{
  const{app,storage,fetch}=await legacy();const cancelled=await app.handleMessage(request('queue.cancel',{operationId}),page);expect(cancelled.ok).toBe(true);expect((await storage.getOperation(operationId))?.state).toBe('cancelled');expect((await storage.getMetadata<Record<string,unknown>>('preferences'))?.ankiEndpoint).toBe('http://[::1]:8765');expect(fetch).not.toHaveBeenCalled();
 });

 it.each([
  undefined,{},'invalid',[],{owner:'',expiresAt:'2020-01-01T00:00:00.000Z'},
  {owner:'not-an-owner',expiresAt:'2020-01-01T00:00:00.000Z'},
  {owner:operationId,expiresAt:'not-a-date'},
  {owner:operationId,expiresAt:'2020-01-01'},
  {owner:operationId,expiresAt:'2020-01-01T00:00:00Z'},
  {owner:operationId,expiresAt:0},
  {owner:operationId,expiresAt:'2020-01-01T00:00:00.000Z',uncertain:true},
  {owner:operationId,expiresAt:'2099-01-01T00:00:00.000Z'},
 ])('refuses malformed or live quarantined lease %# without any write',async lease=>{
  const{app,storage,fetch,original}=await legacy(undefined,{lease});const cas=vi.spyOn(storage,'compareAndSwap');const result=await app.handleMessage(request('queue.cancel',{operationId}),page);expect(result.ok).toBe(false);expect(cas).not.toHaveBeenCalled();expect(await storage.getOperation(operationId)).toEqual(original);expect(fetch).not.toHaveBeenCalled();
 });
 it.each(['pending','ready','failed','awaiting_audio_decision','awaiting_duplicate_decision'] as const)('cancels safe %s with expired canonical lease, immutable snapshot and barrier retained',async state=>{
  const{app,storage,fetch,original}=await legacy(undefined,{state,lease:{owner:operationId,expiresAt:'2020-01-01T00:00:00.000Z'}});const result=await app.handleMessage(request('queue.cancel',{operationId}),page);expect(result.ok).toBe(true);const next=await storage.getOperation(operationId);expect(next).toEqual({...original,state:'cancelled',revision:original!.revision+1,updatedAt:next!.updatedAt,nextAttemptAt:null,lease:null,lastError:null});
  expect((await storage.getMetadata<{blockedOperationIds:string[]}>('preferences-recovery-v1'))?.blockedOperationIds).toContain(operationId);const again=await app.handleMessage(request('queue.cancel',{operationId}),page);expect(again.ok).toBe(true);expect(await storage.getOperation(operationId)).toEqual(next);expect(fetch).not.toHaveBeenCalled();
 });
 it.each([{submissionUncertain:true},{submissionUncertain:undefined},{noteId:123},{noteId:undefined},{automaticRetries:NaN},{revision:-1},{updatedAt:'not-a-date'}])('refuses uncertain or malformed history %#',async overrides=>{
  const{app,storage,fetch,original}=await legacy(undefined,overrides);expect((await app.handleMessage(request('queue.cancel',{operationId}),page)).ok).toBe(false);expect(await storage.getOperation(operationId)).toEqual(original);expect(fetch).not.toHaveBeenCalled();
 });
 it('retries local CAS contention at most three times',async()=>{
  const{app,storage,fetch,original}=await legacy();const cas=vi.spyOn(storage,'compareAndSwap').mockResolvedValue(false);expect((await app.handleMessage(request('queue.cancel',{operationId}),page)).ok).toBe(false);expect(cas).toHaveBeenCalledTimes(3);expect(await storage.getOperation(operationId)).toEqual(original);expect(fetch).not.toHaveBeenCalled();
 });
 it('re-reads and refuses a newly uncertain record after lost CAS',async()=>{
  const{app,storage,fetch,original}=await legacy();const cas=vi.spyOn(storage,'compareAndSwap').mockImplementationOnce(async()=>{await storage.putOperation({...original!,state:'submitting',submissionUncertain:true,revision:original!.revision+1});return false;});expect((await app.handleMessage(request('queue.cancel',{operationId}),page)).ok).toBe(false);expect(cas).toHaveBeenCalledTimes(1);expect((await storage.getOperation(operationId))?.state).toBe('submitting');expect(fetch).not.toHaveBeenCalled();
 });

});
