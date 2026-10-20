import test from 'node:test';
import assert from 'node:assert/strict';
import {createReaderServices,SecretVault,ServiceError} from '../packages/services/src/index.ts';
import type {RuntimeSender} from '../packages/services/src/index.ts';
import type {LookupPayload,RpcData,RpcResponse,Operation} from '../packages/contracts/src/index.ts';
import type {ReaderStorage,LookupCacheEntry} from '../packages/storage/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';

const extensionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const reader:RuntimeSender={id:extensionId,url:'https://reader.example/article',documentId:'document-a',frameId:0,tab:{id:3}};
const otherReader:RuntimeSender={...reader,documentId:'document-b',tab:{id:4}};
const page:RuntimeSender={id:extensionId,url:`chrome-extension://${extensionId}/popup.html`,documentId:'popup-document'};
const input:LookupPayload={
 expression:'bank',
 context:{sentence:'She sat on the bank.',targetStart:15,targetEnd:19,before:'A river ran through the village.',after:'The water was cold.'},
 sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-GB'
};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function area():SecretStorageArea{
 const data:Record<string,unknown>={};
 return {get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),set:async values=>{Object.assign(data,values);},remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete data[k];},setAccessLevel:async()=>{}};
}
function responseFor(body:any){
 const data=JSON.parse(body.input[0].content[0].text);
 const output=body.text.format.name==='english_reader_example_v1'?
  {textEn:'She rested by the river bank.',textRu:'Она отдыхала на берегу реки.',source:'ai'}:
  {lemma:data.expression,partOfSpeech:'noun',recommendedSenseId:'river',contextAmbiguous:false,
   senses:[{id:'river',translations:['берег'],definitionEn:'Land beside a river.'}],
   ipaCandidate:{ipa:'/bæŋk/',dialect:data.dialect},extraExample:null};
 return new Response(JSON.stringify({id:'resp_handler',status:'completed',model:body.model,
  output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output)}]}],
  usage:{input_tokens:20,output_tokens:30,total_tokens:50}
 }),{status:200});
}
async function setup(){
 const entries=new Map<string,LookupCacheEntry>();
 const controls={failWrites:false,failReads:false,closed:false};
 const storage={
  getMetadata:async()=>null,
  getLookup:async(key:string)=>{if(controls.failReads)throw new ServiceError('STORAGE_UNAVAILABLE');return entries.get(key)??null;},
  findLookup:async(id:string)=>{if(controls.failReads)throw new ServiceError('STORAGE_UNAVAILABLE');return [...entries.values()].find(e=>e.lookupId===id)??null;},
  putLookup:async(entry:LookupCacheEntry)=>{if(controls.failWrites)throw new ServiceError('STORAGE_QUOTA');entries.set(entry.key,structuredClone(entry));},
  close:()=>{controls.closed=true;}
 } as unknown as ReaderStorage;
 const secrets=new SecretVault({session:area(),local:area()});
 await secrets.setOpenAIKey('handler-test-credential-not-real');
 const calls:{body:any;signal:AbortSignal|undefined}[]=[];
 let responder:(body:any,signal?:AbortSignal)=>Promise<Response>=async body=>responseFor(body);
 const dependencies={
  storage,secrets,
  runtime:{extensionId,allowedPageUrls:[page.url!],isRegisteredReader:()=>true},
  fetch:async(_url:any,init?:RequestInit)=>{
   const body=JSON.parse(init?.body as string),signal=init?.signal??undefined;
   calls.push({body,signal});return responder(body,signal);
  }
 };
 const services=createReaderServices(dependencies);
 const send=(type:Operation,payload:unknown,sender=reader,requestId=crypto.randomUUID())=>
  services.handleMessage({v:1,requestId,type,payload},sender);
 return {services,send,calls,entries,controls,dependencies,setResponder:(next:typeof responder)=>{responder=next;}};
}
function success<T extends Operation>(response:RpcResponse):RpcData[T]{
 assert.equal(response.ok,true,JSON.stringify(response));
 return response.data as RpcData[T];
}
function failure(response:RpcResponse,code:string){
 assert.equal(response.ok,false,JSON.stringify(response));
 if(response.ok)throw new Error('Expected failure');
 assert.equal(response.error.code,code);
}

test('handler emits RPC schema version 1 and preserves complete request in context cache',async()=>{
 const h=await setup();
 const first=await h.send('lookup',input);
 const data=success<'lookup'>(first);
 assert.ok(first.ok);
 if(first.ok){assert.equal(first.meta?.schemaVersion,'1');assert.equal(first.meta?.model,'gpt-4.1-mini');assert.equal(first.meta?.usage?.totalTokens,50);}
 const stored=[...h.entries.values()][0]!;
 assert.deepEqual(stored.request,input);
 assert.equal(stored.request.dialect,'en-GB'); // Canonical key position 12.
 assert.equal(stored.data.lookupId,data.lookupId);
 const second=await h.send('lookup',input);
 success<'lookup'>(second);
 if(second.ok){assert.equal(second.meta?.cacheHit,true);assert.equal(second.meta?.usage,undefined);assert.ok(second.warnings.includes('IPA_GENERATED_APPROXIMATE'));}
 assert.equal(h.calls.length,1);
 h.services.close();
});

test('cache write failure leaves lookup usable for explicit enrichment and refinement',async()=>{
 const h=await setup();h.controls.failWrites=true;
 const first=await h.send('lookup',input),data=success<'lookup'>(first);
 if(first.ok)assert.ok(first.warnings.includes('LOOKUP_CACHE_UNAVAILABLE'));
 h.controls.failReads=true;
 const enriched=await h.send('card.enrich',{lookupId:data.lookupId,senseId:'river'});
 assert.equal(success<'card.enrich'>(enriched).extraExample.source,'ai');
 if(enriched.ok){assert.equal(enriched.meta?.promptVersion,'english-reader-enrich-v1');assert.equal(enriched.meta?.schemaVersion,'1');}
 const refined=await h.send('lookup.refine',{lookupId:data.lookupId});
 success<'lookup.refine'>(refined);
 assert.equal(h.calls[2]!.body.model,'gpt-4.1');
 assert.deepEqual(JSON.parse(h.calls[2]!.body.input[0].content[0].text),input);
 assert.equal(h.entries.size,0);
 h.services.close();
});

test('readers cannot use another document lookup, but trusted extension pages can',async()=>{
 const h=await setup();
 const data=success<'lookup'>(await h.send('lookup',input));
 failure(await h.send('card.enrich',{lookupId:data.lookupId,senseId:'river'},otherReader),'PERMISSION_DENIED');
 assert.equal(h.calls.length,1);
 success<'card.enrich'>(await h.send('card.enrich',{lookupId:data.lookupId,senseId:'river'},page));
 const sameTabNewDocument={...reader,documentId:'navigated-document'};
 failure(await h.send('lookup.refine',{lookupId:data.lookupId},sameTabNewDocument),'PERMISSION_DENIED');
 h.services.close();
});

test('invalid stored request/key association is ignored instead of serving a wrong-context cache hit',async()=>{
 const h=await setup();
 success<'lookup'>(await h.send('lookup',input));
 const entry=[...h.entries.values()][0]!;
 entry.request.context.before='Different context incorrectly stored under the original hash.';
 const restarted=createReaderServices(h.dependencies);
 const reply=await restarted.handleMessage({v:1,requestId:crypto.randomUUID(),type:'lookup',payload:input},reader);
 success<'lookup'>(reply);
 assert.equal(h.calls.length,2);
 if(reply.ok)assert.equal(reply.meta?.cacheHit,false);
 restarted.close();h.services.close();
});

test('same public requestId in two documents coalesces yet cancellation stays sender-specific',async()=>{
 const h=await setup(),done=deferred<Response>(),started=deferred<void>();
 h.setResponder(async()=>{started.resolve();return done.promise;});
 const requestId=crypto.randomUUID();
 const first=h.send('lookup',input,reader,requestId);
 const second=h.send('lookup',input,otherReader,requestId);
 await started.promise;await tick();
 const cancel=success<'lookup.cancel'>(await h.send('lookup.cancel',{requestId},reader));
 assert.equal(cancel.cancelled,true);
 failure(await first,'REQUEST_CANCELLED');
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0]!.signal?.aborted,false);
 done.resolve(responseFor(h.calls[0]!.body));
 success<'lookup'>(await second);
 h.services.close();
});

test('lookupId cancellation finds refinement by its original lookupId, not its new eventual id',async()=>{
 const h=await setup();
 const original=success<'lookup'>(await h.send('lookup',input));
 const done=deferred<Response>(),started=deferred<void>();
 h.setResponder(async()=>{started.resolve();return done.promise;});
 const refining=h.send('lookup.refine',{lookupId:original.lookupId});
 await started.promise;
 const denied=success<'lookup.cancel'>(await h.send('lookup.cancel',{lookupId:original.lookupId},otherReader));
 assert.equal(denied.cancelled,false);
 const cancelled=success<'lookup.cancel'>(await h.send('lookup.cancel',{lookupId:original.lookupId}));
 assert.equal(cancelled.cancelled,true);
 failure(await refining,'REQUEST_CANCELLED');
 assert.equal(h.calls[1]!.signal?.aborted,true);
 const again=success<'lookup.cancel'>(await h.send('lookup.cancel',{lookupId:original.lookupId}));
 assert.equal(again.cancelled,false);
 h.services.close();
});

test('completed stale requestId cannot cancel a later refinement',async()=>{
 const h=await setup(),oldId=crypto.randomUUID();
 const original=success<'lookup'>(await h.send('lookup',input,reader,oldId));
 const done=deferred<Response>(),started=deferred<void>();
 h.setResponder(async()=>{started.resolve();return done.promise;});
 const refining=h.send('lookup.refine',{lookupId:original.lookupId});
 await started.promise;
 const stale=success<'lookup.cancel'>(await h.send('lookup.cancel',{requestId:oldId}));
 assert.equal(stale.cancelled,false);
 assert.equal(h.calls[1]!.signal?.aborted,false);
 done.resolve(responseFor(h.calls[1]!.body));
 success<'lookup.refine'>(await refining);
 h.services.close();
});

test('lookup.cancel and service close also abort explicit enrichment without leaking keys',async()=>{
 const h=await setup();
 const original=success<'lookup'>(await h.send('lookup',input));
 const started=deferred<void>();
 h.setResponder(async()=>{started.resolve();return new Promise<Response>(()=>{});});
 const enriching=h.send('card.enrich',{lookupId:original.lookupId,senseId:'river'});
 await started.promise;
 h.services.close();
 const cancelled=await enriching;
 failure(cancelled,'REQUEST_CANCELLED');
 assert.doesNotMatch(JSON.stringify(cancelled),/handler-test-credential/);
 assert.equal(h.calls[1]!.signal?.aborted,true);
 assert.equal(h.controls.closed,true);
});

test('unknown or wrong sense is rejected before any enrichment call',async()=>{
 const h=await setup();
 const original=success<'lookup'>(await h.send('lookup',input));
 failure(await h.send('card.enrich',{lookupId:original.lookupId,senseId:'nonexistent'}),'INVALID_INPUT');
 failure(await h.send('card.enrich',{lookupId:crypto.randomUUID(),senseId:'river'},page),'LOOKUP_EXPIRED');
 assert.equal(h.calls.length,1);
 h.services.close();
});

test('fallback snapshots stay bounded to 128 even when durable cache is unavailable',async()=>{
 const h=await setup();h.controls.failWrites=true;
 let firstId='',lastId='';
 for(let i=0;i<129;i++){
  const request={...input,context:{...input.context,after:`Scene ${i}.`}};
  const data=success<'lookup'>(await h.send('lookup',request));
  if(i===0)firstId=data.lookupId;
  lastId=data.lookupId;
 }
 assert.equal(h.entries.size,0);
 failure(await h.send('card.enrich',{lookupId:firstId,senseId:'river'},page),'LOOKUP_EXPIRED');
 success<'card.enrich'>(await h.send('card.enrich',{lookupId:lastId,senseId:'river'}));
 h.services.close();
});
