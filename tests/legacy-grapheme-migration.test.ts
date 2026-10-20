import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage,type ReaderStorage,type StoredOperation} from '../packages/storage/src/index.ts';
import {createReaderServices,SecretVault} from '../packages/services/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';
import type {QueueRecord} from '../packages/services/src/queue.ts';
import type {RpcResponse,QueueItem} from '../packages/contracts/src/index.ts';

// Real durable rows captured through the unmodified c1 service, not reconstructed
// with the current validator. The first target ends before a combining accent;
// the second is a five-word expression only under historical compound rules.
const fixture=JSON.parse(readFileSync(new URL('../fixtures/legacy-c1-queued-intents.json',import.meta.url),'utf8')) as {provenance:{commit:string};operations:QueueRecord[]};
const extensionId='abcdefghijklmnopabcdefghijklmnop';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const timestamp=Date.parse('2026-10-20T12:01:00.000Z');
const request=(type:string,payload:unknown={})=>({v:1,requestId:crypto.randomUUID(),type,payload});
function area():SecretStorageArea{return{get:async()=>({}),set:async()=>{},remove:async()=>{},setAccessLevel:async()=>{}};}
function successful<T>(response:RpcResponse):T{if(!response.ok)assert.fail(JSON.stringify(response));return response.data as T;}
function appFor(storage:ReaderStorage){
 let calls=0;
 const app=createReaderServices({storage,secrets:new SecretVault({session:area(),local:area()}),now:()=>timestamp,fetch:async()=>{calls++;throw new Error('Migration list/cancel must not dispatch');},runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:()=>false}});
 return {app,calls:()=>calls};
}
async function seed(indexedDB:IDBFactory,quarantine=false){
 const storage=await openReaderStorage({indexedDB});
 for(const row of fixture.operations)await storage.putOperation(structuredClone(row) as unknown as StoredOperation);
 if(quarantine)await storage.setMetadata('preferences',{ankiEndpoint:'http://[::1]:8765'});
 storage.close();
}
function assertCancelled(actual:QueueRecord,original:QueueRecord){
 assert.deepEqual(actual,{...original,state:'cancelled',revision:original.revision+1,updatedAt:new Date(timestamp).toISOString(),nextAttemptAt:null,lease:null,lastError:null});
}

test('real c1 partial-grapheme and compound intents survive reopen, list and local cancellation unchanged',async()=>{
 assert.equal(fixture.provenance.commit,'c1b0c808bd521f423e5f46b8501f63d70910d9ec');
 assert.deepEqual(fixture.operations[0]!.draft.context,{sentence:'A café.',targetStart:2,targetEnd:6});
 const indexedDB=new IDBFactory();await seed(indexedDB);
 let storage=await openReaderStorage({indexedDB});let harness=appFor(storage);
 try{
  const visible=successful<{items:QueueItem[]}>(await harness.app.handleMessage(request('queue.list'),page));
  assert.equal(visible.items.length,fixture.operations.length);
  for(const original of fixture.operations){
   assert.deepEqual(visible.items.find(row=>row.operationId===original.operationId)?.draft,original.draft);
   assert.deepEqual(await storage.getOperation(original.operationId),original,'read must not migrate durable bytes');
   const cancelled=successful<{operation:QueueItem}>(await harness.app.handleMessage(request('queue.cancel',{operationId:original.operationId}),page));
   assert.equal(cancelled.operation.state,'cancelled');
   assertCancelled(await storage.getOperation(original.operationId) as unknown as QueueRecord,original);
  }
  assert.equal(harness.calls(),0);
 }finally{harness.app.close();}
 storage=await openReaderStorage({indexedDB});harness=appFor(storage);
 try{
  const visible=successful<{items:QueueItem[]}>(await harness.app.handleMessage(request('queue.list'),page));
  assert.ok(visible.items.every(row=>row.state==='cancelled'));
  for(const original of fixture.operations)assertCancelled(await storage.getOperation(original.operationId) as unknown as QueueRecord,original);
  assert.equal(harness.calls(),0);
 }finally{harness.app.close();}
});

for(const repair of [false,true])test(`real c1 partial-grapheme intent remains locally cancellable in ${repair?'repaired':'pending'} quarantine`,async()=>{
 const indexedDB=new IDBFactory();await seed(indexedDB,true);
 let storage=await openReaderStorage({indexedDB});let harness=appFor(storage);
 try{
  const settings=await harness.app.handleMessage(request('settings.getPublic'),page);
  successful(settings);if(settings.ok)assert.ok(settings.warnings.includes('SETTINGS_REPAIR_REQUIRED'));
  if(repair)successful(await harness.app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page));
  const visible=successful<{items:QueueItem[]}>(await harness.app.handleMessage(request('queue.list'),page));
  assert.equal(visible.items.length,fixture.operations.length);
  for(const original of fixture.operations){
   assert.deepEqual(await storage.getOperation(original.operationId),original);
   successful(await harness.app.handleMessage(request('queue.cancel',{operationId:original.operationId}),page));
   assertCancelled(await storage.getOperation(original.operationId) as unknown as QueueRecord,original);
  }
  const recovery=await storage.getMetadata<{pending:boolean;blockedOperationIds:string[]}>('preferences-recovery-v1');
  assert.equal(recovery?.pending,!repair);
  assert.deepEqual(new Set(recovery?.blockedOperationIds),new Set(fixture.operations.map(row=>row.operationId)));
  assert.equal(harness.calls(),0);
 }finally{harness.app.close();}
 storage=await openReaderStorage({indexedDB});harness=appFor(storage);
 try{
  successful(await harness.app.handleMessage(request('queue.list'),page));
  for(const original of fixture.operations){
   const replay=await harness.app.handleMessage(request('queue.retry',{operationId:original.operationId}),page);
   assert.equal(replay.ok,false);if(!replay.ok)assert.equal(replay.error.code,'OPERATION_CONFLICT');
   successful(await harness.app.handleMessage(request('queue.cancel',{operationId:original.operationId}),page));
   assertCancelled(await storage.getOperation(original.operationId) as unknown as QueueRecord,original);
  }
  assert.equal(harness.calls(),0);
 }finally{harness.app.close();}
});
