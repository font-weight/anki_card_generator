import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import type {ReaderStorage} from '../packages/storage/src/index.ts';
import {createReaderServices,SecretVault,ServiceError} from '../packages/services/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';
import type {NoteDraft,RpcResponse} from '../packages/contracts/src/index.ts';
const extensionId='abcdefghijklmnopabcdefghijklmnop';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const reader={id:extensionId,url:'https://example.com/read',documentId:'doc1',tab:{id:1}};
const operationId='84340d08-9f93-4357-8549-e7611a509eae';
const newId='d60be195-7539-4ea8-aead-38c1f8e38f54';
const draft:NoteDraft={sourceLanguage:'en',targetLanguage:'ru',mode:'recognition',deckName:'Test',tags:[],expression:'book',lemma:'book',partOfSpeech:'noun',selectedSense:{id:'s1',translations:['книга'],definitionEn:'A written work.'},context:{sentence:'Read this book.',targetStart:10,targetEnd:14},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:null,source:{kind:'html',title:'Reading',url:'https://example.com/read',documentId:null,page:null,chapter:null,cfi:null}};
const request=(type:string,payload:unknown={})=>({v:1,requestId:crypto.randomUUID(),type,payload});
function area():SecretStorageArea{return{get:async()=>({}),set:async()=>{},remove:async()=>{},setAccessLevel:async()=>{}};}
function appFor(storage:ReaderStorage,fetcher:typeof fetch,isolated=false){return createReaderServices({storage,secrets:new SecretVault({session:area(),local:area()}),fetch:fetcher,...isolated?{isolatedAnkiTestMode:true as const}:{},runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:s=>s.documentId==='doc1'}});}
function rejected(result:RpcResponse,code:string){assert.equal(result.ok,false,JSON.stringify(result));if(!result.ok)assert.equal(result.error.code,code);}
async function seed(indexedDB:IDBFactory){const storage=await openReaderStorage({indexedDB});const app=appFor(storage,async()=>{throw new Error('offline');});const r=await app.handleMessage(request('anki.addNote',{operationId,draft,includeAudio:false}),reader);assert.ok(r.ok);const original=await storage.getOperation(operationId);assert.ok(original);await storage.putOperation({...original,state:'submitting',submissionUncertain:true});const frozen=await storage.getOperation(operationId);await storage.setMetadata('preferences',{ankiEndpoint:'http://[::1]:8765',dialect:'en-GB',defaultDeck:'Keep me'});app.close();return frozen;}

test('unsupported persisted endpoint permits repair form but no Anki dispatch or queue mutations',async()=>{
 const indexedDB=new IDBFactory(),original=await seed(indexedDB);const storage=await openReaderStorage({indexedDB});let calls=0;
 const app=appFor(storage,async()=>{calls++;throw new Error('unexpected');});
 const form=await app.handleMessage(request('settings.getPublic'),page);assert.ok(form.ok);if(form.ok){assert.ok(form.warnings.includes('SETTINGS_REPAIR_REQUIRED'));assert.ok(form.warnings.includes('ANKI_QUEUE_REVIEW_REQUIRED'));assert.equal((form.data as any).dialect,'en-GB');assert.equal((form.data as any).defaultDeck,'Keep me');assert.equal((form.data as any).ankiEndpoint,'http://127.0.0.1:8765');}
 await assert.rejects(app.getPublicSettings(),{code:'OPERATION_CONFLICT'});
 for(const [type,payload] of [['anki.decks',{}],['anki.addNote',{operationId:newId,draft,includeAudio:false}],['queue.retry',{operationId}],['queue.cancel',{operationId}],['queue.resolveAudio',{operationId,action:'retry'}]])rejected(await app.handleMessage(request(type as string,payload),page),'OPERATION_CONFLICT');
 const status=await app.handleMessage(request('anki.status'),reader);assert.ok(status.ok);if(status.ok)assert.equal((status.data as any).error.code,'OPERATION_CONFLICT');
 await assert.rejects(app.resumeQueue(),{code:'OPERATION_CONFLICT'});assert.equal(calls,0);assert.deepEqual(await storage.getOperation(operationId),original);assert.equal(await storage.getOperation(newId),null);
 rejected(await app.handleMessage(request('settings.update',{patch:{defaultMode:'cloze'}}),page),'OPERATION_CONFLICT');
 rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),reader),'PERMISSION_DENIED');
 rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://[::1]:8765'}}),page),'INVALID_INPUT');
 app.close();
});

test('explicit repair enables new intents but old IDs remain unchanged and quarantined through restart',async()=>{
 const indexedDB=new IDBFactory(),original=await seed(indexedDB);let storage=await openReaderStorage({indexedDB}),calls=0;
 const fetcher:typeof fetch=async url=>{calls++;assert.equal(String(url),'http://127.0.0.1:8765/');throw new Error('offline');};let app=appFor(storage,fetcher);
 const repair=await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://localhost:8765'}}),page);assert.ok(repair.ok);if(repair.ok){assert.ok(!repair.warnings.includes('SETTINGS_REPAIR_REQUIRED'));assert.ok(repair.warnings.includes('ANKI_QUEUE_REVIEW_REQUIRED'));}
 for(const [type,payload] of [['anki.addNote',{operationId,draft,includeAudio:false}],['queue.retry',{operationId}],['queue.cancel',{operationId}],['queue.resolveAudio',{operationId,action:'save_without_audio'}]])rejected(await app.handleMessage(request(type as string,payload),page),'OPERATION_CONFLICT');
 await app.resumeQueue();assert.equal(calls,0);assert.deepEqual(await storage.getOperation(operationId),original);
 const visible=await app.handleMessage(request('queue.list'),page);assert.ok(visible.ok);if(visible.ok)assert.equal((visible.data as any).items[0].operationId,operationId);
 app.close();storage=await openReaderStorage({indexedDB});app=appFor(storage,fetcher);await app.resumeQueue();assert.equal(calls,0);rejected(await app.handleMessage(request('queue.retry',{operationId}),page),'OPERATION_CONFLICT');
 const newIntent=await app.handleMessage(request('anki.addNote',{operationId:newId,draft,includeAudio:false}),reader);assert.ok(newIntent.ok);assert.equal(calls,1);assert.deepEqual(await storage.getOperation(operationId),original);assert.equal((await storage.getOperation(newId))?.targetIdentity,'anki:loopback:8765');app.close();
});

test('barrier write failure cannot commit endpoint or poison subsequent initialization',async()=>{
 const indexedDB=new IDBFactory(),original=await seed(indexedDB),storage=await openReaderStorage({indexedDB});const set=storage.setMetadata.bind(storage);let fail=true;
 storage.setMetadata=async(key,value)=>{if(key==='preferences-recovery-v1'&&fail){fail=false;throw new ServiceError('STORAGE_QUOTA');}return set(key,value);};let calls=0;const app=appFor(storage,async()=>{calls++;throw new Error('unexpected');});
 rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page),'STORAGE_QUOTA');assert.equal((await storage.getMetadata<any>('preferences')).ankiEndpoint,'http://[::1]:8765');
 const retry=await app.handleMessage(request('settings.getPublic'),page);assert.ok(retry.ok);if(retry.ok)assert.ok(retry.warnings.includes('SETTINGS_REPAIR_REQUIRED'));assert.equal(calls,0);assert.deepEqual(await storage.getOperation(operationId),original);app.close();
});

test('crash after endpoint commit but before clearing barrier remains blocked after restart',async()=>{
 const indexedDB=new IDBFactory(),original=await seed(indexedDB);let storage=await openReaderStorage({indexedDB});const set=storage.setMetadata.bind(storage);let failed=false;
 storage.setMetadata=async(key,value)=>{if(key==='preferences-recovery-v1'&&(value as any).pending===false&&!failed){failed=true;throw new ServiceError('STORAGE_UNAVAILABLE');}return set(key,value);};let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw new Error('unexpected');};let app=appFor(storage,fetcher);
 rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page),'STORAGE_UNAVAILABLE');assert.equal((await storage.getMetadata<any>('preferences')).ankiEndpoint,'http://127.0.0.1:8765');await assert.rejects(app.resumeQueue(),{code:'OPERATION_CONFLICT'});app.close();
 storage=await openReaderStorage({indexedDB});app=appFor(storage,fetcher);await assert.rejects(app.resumeQueue(),{code:'OPERATION_CONFLICT'});const form=await app.handleMessage(request('settings.getPublic'),page);assert.ok(form.ok);if(form.ok)assert.ok(form.warnings.includes('SETTINGS_REPAIR_REQUIRED'));
 assert.ok((await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://localhost:8765'}}),page)).ok);await app.resumeQueue();assert.equal(calls,0);assert.deepEqual(await storage.getOperation(operationId),original);app.close();
});

test('transient preference read is retryable in same service without silently dispatching',async()=>{
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});const get=storage.getMetadata.bind(storage);let fail=true;
 storage.getMetadata=async<T>(key:string):Promise<T|null>=>{if(key==='preferences'&&fail){fail=false;throw new ServiceError('STORAGE_UNAVAILABLE');}return get<T>(key);};let calls=0;const app=appFor(storage,async()=>{calls++;throw new Error('unexpected');});
 rejected(await app.handleMessage(request('settings.getPublic'),page),'STORAGE_UNAVAILABLE');assert.ok((await app.handleMessage(request('settings.getPublic'),page)).ok);assert.equal(calls,0);app.close();
});

test('other invalid saved preferences are salvaged only field-by-field and require explicit repair',async()=>{
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});await storage.setMetadata('preferences',{ankiEndpoint:'http://localhost:8765',dialect:'en-GB',cloudAudioEnabled:'true',audioSpeed:99,defaultDeck:'Retained',constructor:'untrusted'});let calls=0;const app=appFor(storage,async()=>{calls++;throw new Error('unexpected');});
 const form=await app.handleMessage(request('settings.getPublic'),page);assert.ok(form.ok);if(form.ok){const data=form.data as any;assert.equal(data.cloudAudioEnabled,false);assert.equal(data.audioSpeed,1);assert.equal(data.dialect,'en-GB');assert.equal(data.defaultDeck,'Retained');assert.ok(form.warnings.includes('SETTINGS_REPAIR_REQUIRED'));}await assert.rejects(app.resumeQueue(),{code:'OPERATION_CONFLICT'});assert.equal(calls,0);app.close();
});

test('malformed quarantine metadata fails closed and is never overwritten',async()=>{
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});const malformed={v:1,pending:false,blockedOperationIds:['not-a-uuid']};await storage.setMetadata('preferences-recovery-v1',malformed);let calls=0;const app=appFor(storage,async()=>{calls++;throw new Error('unexpected');});rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page),'STORAGE_UNAVAILABLE');assert.deepEqual(await storage.getMetadata('preferences-recovery-v1'),malformed);assert.equal(calls,0);app.close();
});

test('isolated fixed target recovery never enables production endpoint selection',async()=>{
 const storage=await openReaderStorage({indexedDB:new IDBFactory(),name:'english-reader-isolated-anki-test-v1'});await storage.setMetadata('preferences',{ankiEndpoint:'http://[::1]:8765',audioSpeed:99});const urls:string[]=[];const app=appFor(storage,async url=>{urls.push(String(url));return Response.json({result:6,error:null});},true);
 await assert.rejects(app.resumeQueue(),{code:'OPERATION_CONFLICT'});rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page),'PERMISSION_DENIED');const repair=await app.handleMessage(request('settings.update',{patch:{audioSpeed:1}}),page);assert.ok(repair.ok);if(repair.ok)assert.equal((repair.data as any).ankiEndpoint,'http://127.0.0.1:18765');assert.ok((await app.handleMessage(request('anki.status'),page)).ok);assert.deepEqual(urls,['http://127.0.0.1:18765/']);app.close();
});

test('failed preference repair write keeps old endpoint and durable replay barrier intact',async()=>{
 const indexedDB=new IDBFactory(),original=await seed(indexedDB),storage=await openReaderStorage({indexedDB});const set=storage.setMetadata.bind(storage);storage.setMetadata=async(key,value)=>{if(key==='preferences')throw new ServiceError('STORAGE_QUOTA');return set(key,value);};let calls=0;const app=appFor(storage,async()=>{calls++;throw new Error('unexpected');});
 rejected(await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page),'STORAGE_QUOTA');assert.equal((await storage.getMetadata<any>('preferences')).ankiEndpoint,'http://[::1]:8765');assert.deepEqual(await storage.getMetadata('preferences-recovery-v1'),{v:1,pending:true,blockedOperationIds:[operationId]});await assert.rejects(app.resumeQueue(),{code:'OPERATION_CONFLICT'});assert.equal(calls,0);assert.deepEqual(await storage.getOperation(operationId),original);app.close();
});

test('a later invalid-preference recovery unions existing quarantine and never rewrites rows',async()=>{
 const indexedDB=new IDBFactory();const original=await seed(indexedDB);let storage=await openReaderStorage({indexedDB});let app=appFor(storage,async()=>{throw new Error('offline');});assert.ok((await app.handleMessage(request('settings.update',{patch:{ankiEndpoint:'http://127.0.0.1:8765'}}),page)).ok);assert.ok((await app.handleMessage(request('anki.addNote',{operationId:newId,draft,includeAudio:false}),reader)).ok);const newer=await storage.getOperation(newId);await storage.setMetadata('preferences',{audioSpeed:0});app.close();
 storage=await openReaderStorage({indexedDB});app=appFor(storage,async()=>{throw new Error('must not dispatch');});assert.ok((await app.handleMessage(request('settings.getPublic'),page)).ok);const recovery=await storage.getMetadata<{blockedOperationIds:string[]}>('preferences-recovery-v1');assert.deepEqual(new Set(recovery?.blockedOperationIds),new Set([operationId,newId]));assert.deepEqual(await storage.getOperation(operationId),original);assert.deepEqual(await storage.getOperation(newId),newer);app.close();
});
