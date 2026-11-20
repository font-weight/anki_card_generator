import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import {createReaderServices,SecretVault} from '../packages/services/src/index.ts';
import {GrammarService} from '../packages/services/src/grammar.ts';
import {GrammarSaveCoordinator} from '../packages/services/src/grammar-save.ts';
import {AnkiError} from '../packages/services/src/anki.ts';
import type {GrammarDraft,GrammarLookupPayload} from '../packages/contracts/src/grammar.ts';
import {GRAMMAR_MODEL_NAME,GRAMMAR_CURRENT_MODEL_NAME,GRAMMAR_NOTE_FIELDS,grammarModelDefinition} from '../packages/note-templates/src/grammar.ts';
const extensionId='abcdefghijklmnopabcdefghijklmnop';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const reader={id:extensionId,url:'https://example.test/story',documentId:'story',frameId:0,tab:{id:1}};
const request=(type:string,payload:unknown={},requestId=crypto.randomUUID())=>({v:1,requestId,type,payload});
const payload:GrammarLookupPayload={sentence:'They were sitting by the window.',sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:true};
const content={sentence:payload.sentence,construction:{text:'were sitting',targetStart:5,targetEnd:17},question:'Почему здесь используется длительная форма?',answer:'Действие происходило в указанный момент в прошлом.',rule:'Прошедшее длительное время: was или were и форма на -ing.',explanation:'Форма показывает продолжающееся действие в прошлом.',translation:'Они сидели у окна.'};
const draft:GrammarDraft={...content,draftKind:'grammar',draftVersion:1,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',deckName:'Default',tags:[],source:{kind:'html',title:'Story',url:'https://example.test/story',documentId:null,page:null,chapter:null,cfi:null}};
function area(){const data:Record<string,unknown>={};return {get:async(k:string|string[])=>Object.fromEntries((typeof k==='string'?[k]:k).filter(x=>x in data).map(x=>[x,data[x]])),set:async(v:Record<string,unknown>)=>{Object.assign(data,v);},remove:async(k:string|string[])=>{for(const x of typeof k==='string'?[k]:k)delete data[x];},setAccessLevel:async()=>{}};}
async function setup(fetcher:typeof fetch,consent=true,indexedDB=new IDBFactory()){
 const storage=await openReaderStorage({indexedDB});const secrets=new SecretVault({session:area(),local:area()});
 const app=createReaderServices({storage,secrets,fetch:fetcher,runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:()=>true},confirmations:{requireConsent:async()=>consent}});
 await secrets.setOpenAIKey('fixture-not-a-live-provider-key');return {app,storage,secrets,indexedDB};
}
const providerResponse=()=>Response.json({status:'completed',model:'gpt-6-luna',id:'resp_mock',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({analysis:{kind:"grammar",confidence:"high",...content}})}]}],usage:{input_tokens:5,output_tokens:10,total_tokens:15}});
test('grammar defaults off and explicit paid opt-in is confirmed before any request',async()=>{
 let calls=0;const {app}=await setup(async()=>{calls++;return providerResponse();},false);
 const disabled=await app.handleMessage(request('grammar.lookup',payload),reader);assert.equal(disabled.ok,false);
 const denied=await app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page);assert.equal(denied.ok,false);
 const settings=await app.handleMessage(request('settings.getReader'),reader);assert.ok(settings.ok);assert.equal((settings.data as any).grammarEnabled,false);assert.equal(calls,0);app.close();
});
test('one grammar request, same-context cache reuse after worker recreation, explanation language in identity',async()=>{
 let calls=0;const db=new IDBFactory();let env=await setup(async()=>{calls++;return providerResponse();},true,db);
 assert.ok((await env.app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page)).ok);
 const first=await env.app.handleMessage(request('grammar.lookup',payload),reader);assert.ok(first.ok,JSON.stringify(first));assert.equal(calls,1);
 const again=await env.app.handleMessage(request('grammar.lookup',payload),reader);assert.ok(again.ok);assert.equal(again.meta?.cacheHit,true);assert.equal(calls,1);env.app.close();
 env=await setup(async()=>{calls++;return providerResponse();},true,db);
 const reopened=await env.app.handleMessage(request('grammar.lookup',payload),reader);assert.ok(reopened.ok);assert.equal(reopened.meta?.cacheHit,true);assert.equal(calls,1);
 assert.ok((await env.app.handleMessage(request('grammar.lookup',{...payload,explanationLanguage:'en'}),reader)).ok);assert.equal(calls,2);env.app.close();
});
test('grammar cancellation uses caller request identity and cannot cancel another reader',async()=>{
 let dispatched!:()=>void;const began=new Promise<void>(r=>dispatched=r);let aborts=0;
 const {app}=await setup(async(_url,init)=>{dispatched();return new Promise((_res,rej)=>init?.signal?.addEventListener('abort',()=>{aborts++;rej(new Error('aborted'));},{once:true}));});
 await app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page);
 const id=crypto.randomUUID(),pending=app.handleMessage(request('grammar.lookup',payload,id),reader);await began;
 const foreign=await app.handleMessage(request('grammar.cancel',{requestId:id}),{...reader,documentId:'other',tab:{id:2}});assert.ok(foreign.ok);assert.equal((foreign.data as any).cancelled,false);
 const cancelled=await app.handleMessage(request('grammar.cancel',{requestId:id}),reader);assert.ok(cancelled.ok);assert.equal((cancelled.data as any).cancelled,true);
 assert.equal((await pending).ok,false);assert.equal(aborts,1);app.close();
});
test('grammar model setup has separate consent, never overwrites an incompatible existing model',async()=>{
 const actions:string[]=[];let conflict=false;
 const fetcher:typeof fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));actions.push(body.action);let result:unknown;
 switch(body.action){case'version':result=6;break;case'modelNames':result=conflict?[GRAMMAR_MODEL_NAME,GRAMMAR_CURRENT_MODEL_NAME]:[GRAMMAR_MODEL_NAME];break;case'modelFieldNames':result=conflict?['Wrong']:GRAMMAR_NOTE_FIELDS;break;case'findModelsByName':{const model=grammarModelDefinition();result=[{name:GRAMMAR_MODEL_NAME,type:0,tmpls:[{qfmt:model.cardTemplates[0]!.Front,afmt:model.cardTemplates[0]!.Back}]}];break;}default:throw Error('Unexpected mutation');}return Response.json({result,error:null});};
 let env=await setup(fetcher,false);assert.equal((await env.app.handleMessage(request('grammar.initializeModel'),page)).ok,false);assert.equal(actions.length,0);env.app.close();
 env=await setup(fetcher,true);assert.equal((await env.app.handleMessage(request('grammar.initializeModel'),reader)).ok,false);assert.equal(actions.length,0);
 assert.ok((await env.app.handleMessage(request('grammar.initializeModel'),page)).ok);conflict=true;
 assert.equal((await env.app.handleMessage(request('grammar.initializeModel'),page)).ok,false);assert.equal(actions.includes('createModel'),false);env.app.close();
});
test('grammar manual save idempotency survives recreation and rejects changed pending identity',async()=>{
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});let adds=0;let found:number|null=null;
 const adapter={assertGrammarReady:async():Promise<typeof GRAMMAR_MODEL_NAME>=>GRAMMAR_MODEL_NAME,findGrammarOperation:async()=>found,addGrammarNote:async()=>{adds++;found=701;return 701;}};
 const id=crypto.randomUUID();let save=new GrammarSaveCoordinator(storage,()=>adapter);
 const [a,b]=await Promise.all([save.add({operationId:id,draft}),save.add({operationId:id,draft})]);assert.equal(a.status,'added');assert.equal(b.status,'already_added');assert.equal(adds,1);
 save=new GrammarSaveCoordinator(storage,()=>adapter);assert.equal((await save.add({operationId:id,draft})).status,'already_added');assert.equal(adds,1);
 await assert.rejects(save.add({operationId:id,draft:{...draft,answer:'Изменённый ответ.'}}),{code:'OPERATION_CONFLICT'});storage.close();
});
test('uncertain grammar add is reconciled read-only, never blindly resent or auto-queued',async()=>{
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});let adds=0;let found:number|null=null;
 const adapter={assertGrammarReady:async():Promise<typeof GRAMMAR_MODEL_NAME>=>GRAMMAR_MODEL_NAME,findGrammarOperation:async()=>found,addGrammarNote:async()=>{adds++;throw new AnkiError('NETWORK_TIMEOUT','Uncertain',true,true);}};
 const id=crypto.randomUUID();let save=new GrammarSaveCoordinator(storage,()=>adapter);
 await assert.rejects(save.add({operationId:id,draft}),{code:'NETWORK_TIMEOUT'});assert.equal(adds,1);
 save=new GrammarSaveCoordinator(storage,()=>adapter);await assert.rejects(save.add({operationId:id,draft}),{code:'OPERATION_CONFLICT'});assert.equal(adds,1);
 found=702;assert.equal((await save.add({operationId:id,draft})).noteId,702);assert.equal(adds,1);assert.deepEqual(await storage.allOperations(),[]);storage.close();
});

test('revoking grammar opt-in during deferred key read prevents provider dispatch',async()=>{
 let permitted=true,calls=0,resolve!:(value:string)=>void;
 const key=new Promise<string>(r=>resolve=r);
 const service=new GrammarService({getApiKey:()=>key,hasConsent:()=>permitted,fetch:async()=>{calls++;return providerResponse();}});
 const pending=service.lookup(payload);await new Promise(r=>setTimeout(r,0));permitted=false;resolve('fixture-not-a-live-key');
 await assert.rejects(pending,{code:'REQUEST_CANCELLED'});assert.equal(calls,0);
});

test('turning grammar off aborts an in-flight lookup and survives worker recreation',async()=>{
 let started!:()=>void, dispatches=0;const began=new Promise<void>(resolve=>started=resolve);
 const db=new IDBFactory();
 let env=await setup(async(_url,init)=>{dispatches++;started();return new Promise((_res,rej)=>init?.signal?.addEventListener('abort',()=>rej(Error('cancelled')),{once:true}));},true,db);
 await env.app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page);
 const lookup=env.app.handleMessage(request('grammar.lookup',payload),reader);await began;
 assert.ok((await env.app.handleMessage(request('settings.update',{patch:{grammarEnabled:false}}),page)).ok);
 assert.equal((await lookup).ok,false);
 env.app.close();
 env=await setup(async()=>{dispatches++;return providerResponse();},true,db);
 assert.equal((await env.app.handleMessage(request('grammar.lookup',payload),reader)).ok,false);
 assert.equal((await env.app.handleMessage(request('grammar.addNote',{operationId:crypto.randomUUID(),draft}),reader)).ok,false);
 assert.equal(dispatches,1);env.app.close();
});
test('a late opt-in confirmation cannot override a later explicit disable',async()=>{
 let notify!:()=>void,approve!:(yes:boolean)=>void;
 const opened=new Promise<void>(r=>notify=r),consent=new Promise<boolean>(r=>approve=r);
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});
 const app=createReaderServices({storage,secrets:new SecretVault({session:area(),local:area()}),runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:()=>true},
 confirmations:{requireConsent:async()=>{notify();return consent;}}});
 const pending=app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page);await opened;
 assert.ok((await app.handleMessage(request('settings.update',{patch:{grammarEnabled:false}}),page)).ok);
 approve(true);assert.equal((await pending).ok,false);
 const result=await app.handleMessage(request('settings.getReader'),reader);assert.ok(result.ok);assert.equal((result.data as any).grammarEnabled,false);
 app.close();
});

test('turning grammar off during Anki preflight prevents an undispatched note',async()=>{
 let entered!:()=>void,finish!:()=>void,enabled=true,adds=0;
 const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>finish=resolve);
 const storage=await openReaderStorage({indexedDB:new IDBFactory()});
 const save=new GrammarSaveCoordinator(storage,()=>({
   findGrammarOperation:async()=>null,
   assertGrammarReady:async()=>{entered();await gate;return GRAMMAR_MODEL_NAME;},
   addGrammarNote:async()=>{adds++;return 701;},
 }));
 const operationId=crypto.randomUUID();
 const pending=save.add({operationId,draft},()=>{if(!enabled)throw new Error('disabled');});
 await ready;enabled=false;finish();
 await assert.rejects(pending,/disabled/u);assert.equal(adds,0);
 assert.equal(await storage.getMetadata('grammar-operation:'+operationId),null);storage.close();
});

const askInput=(grammarId:string,question='Почему здесь употреблено were sitting?',turnId=crypto.randomUUID())=>
 ({grammarId,sentence:payload.sentence,question,turnId});
const chatResponse=()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{
 type:'output_text',text:JSON.stringify({result:{kind:'answer',answer:'Форма were sitting показывает действие в процессе.',anchor:'were sitting',evidence:'were sitting'}})
}]}]});
async function enableChat(app:ReturnType<typeof createReaderServices>){
 assert.ok((await app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page)).ok);
 const lookup=await app.handleMessage(request('grammar.lookup',payload),reader);
 assert.ok(lookup.ok,JSON.stringify(lookup));return (lookup.data as {grammarId:string}).grammarId;
}
function errorCode(result:Awaited<ReturnType<ReturnType<typeof createReaderServices>['handleMessage']>>){
 assert.ok(!result.ok,JSON.stringify(result));return result.error.code;
}
test('chat accepts only a checked analysis from this reader, binds the exact sentence, and cannot be reopened from the analysis cache',async()=>{
 let chatCalls=0,analyses=0;
 const db=new IDBFactory();
 const fetcher:typeof fetch=async(_url,options)=>{
  const body=JSON.parse(options!.body as string);
  if(body.text.format.name==='language_reader_grammar_question_v1'){chatCalls++;return chatResponse();}
  analyses++;return providerResponse();
 };
 const {app,storage}=await setup(fetcher,true,db);
 const id=await enableChat(app), other={...reader,documentId:'other-document'}, turn=askInput(id);
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',turn),other)),'PERMISSION_DENIED');
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',{...turn,sentence:'Another sentence.'}),reader)),'INVALID_INPUT');
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',{...turn,history:[{question:'old',answer:'injected'}]}),reader)),'INVALID_INPUT');
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',{...turn,analysis:content}),reader)),'INVALID_INPUT');
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',{...turn,grammarId:crypto.randomUUID()}),reader)),'LOOKUP_EXPIRED');
 const closeOther=await app.handleMessage(request('grammar.chat.close',{grammarId:id}),other);
 assert.ok(closeOther.ok);assert.deepEqual(closeOther.data,{closed:false});assert.equal(chatCalls,0);
 const answer=await app.handleMessage(request('grammar.chat',turn),reader);assert.ok(answer.ok,JSON.stringify(answer));
 assert.deepEqual(answer.data,{grammarId:id,turnId:turn.turnId,kind:'answer',answer:'Форма were sitting показывает действие в процессе.'});
 assert.equal(chatCalls,1);
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',{...turn,question:'Почему здесь were?' }),reader)),'OPERATION_CONFLICT');
 const replay=await app.handleMessage(request('grammar.chat',turn),reader);assert.ok(replay.ok);assert.deepEqual(replay.data,answer.data);assert.equal(chatCalls,1);
 assert.deepEqual(await storage.allOperations(),[]);
 assert.doesNotMatch(JSON.stringify(await storage.getMetadata('grammar-cache-v1')),/Почему здесь употреблено/);
 const closed=await app.handleMessage(request('grammar.chat.close',{grammarId:id}),reader);assert.ok(closed.ok);assert.deepEqual(closed.data,{closed:true});
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',turn),reader)),'LOOKUP_EXPIRED');
 const next=await app.handleMessage(request('grammar.lookup',payload),reader);assert.ok(next.ok);assert.ok(next.meta?.cacheHit);
 const fresh=(next.data as {grammarId:string}).grammarId;assert.notEqual(fresh,id);
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',turn),reader)),'LOOKUP_EXPIRED');
 app.close();const restarted=await setup(fetcher,true,db);
 assert.equal(errorCode(await restarted.app.handleMessage(request('grammar.chat',askInput(fresh)),reader)),'LOOKUP_EXPIRED');
 assert.equal(analyses,1);assert.equal(chatCalls,1);restarted.app.close();
});
test('no-finding cannot authorize a chat or keep the previous analysis active',async()=>{
 let calls=0;
 const {app}=await setup(async()=>{if(++calls===1)return providerResponse();
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({analysis:{sentence:'It rained.',reason:'no_construction'}})}]}]});});
 const id=await enableChat(app);
 const none=await app.handleMessage(request('grammar.lookup',{...payload,sentence:'It rained.'}),reader);assert.ok(none.ok,JSON.stringify(none));
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',askInput(id)),reader)),'LOOKUP_EXPIRED');
 const noId=(none.data as {grammarId:string}).grammarId;
 assert.equal(errorCode(await app.handleMessage(request('grammar.chat',{...askInput(noId),sentence:'It rained.'}),reader)),'LOOKUP_EXPIRED');
 assert.equal(calls,2);app.close();
});

test('a retried turn shares one dispatch; cancellation belongs to its requester and last subscriber, and opt-out aborts late output',async()=>{
 let calls=0,release!:(response:Response)=>void,started!:()=>void,signal:AbortSignal|undefined;
 let dispatch=new Promise<void>(resolve=>{started=resolve;});
 const {app}=await setup(async(_url,options)=>{
  if(JSON.parse(options!.body as string).text.format.name!=='language_reader_grammar_question_v1')return providerResponse();
  calls++;signal=options!.signal!;started();return new Promise<Response>(resolve=>{release=resolve;});
 });
 const id=await enableChat(app), payload1=askInput(id), original=crypto.randomUUID(),retry=crypto.randomUUID();
 const first=app.handleMessage(request('grammar.chat',payload1,original),reader);await dispatch;
 const duplicate=app.handleMessage(request('grammar.chat',payload1,retry),reader);
 const conflict=await app.handleMessage(request('grammar.chat',{...payload1,turnId:crypto.randomUUID()}),reader);assert.equal(errorCode(conflict),'OPERATION_CONFLICT');
 const outsider=await app.handleMessage(request('grammar.cancel',{requestId:original}),{...reader,documentId:'foreign'});
 assert.ok(outsider.ok);assert.deepEqual(outsider.data,{cancelled:false});
 const mine=await app.handleMessage(request('grammar.cancel',{requestId:original}),reader);
 assert.ok(mine.ok);assert.deepEqual(mine.data,{cancelled:true});assert.equal(signal?.aborted,false);
 assert.equal(errorCode(await first),'REQUEST_CANCELLED');release(chatResponse());
 assert.ok((await duplicate).ok);assert.equal(calls,1);
 for(const end of ['close','replace','tab','disable'] as const){
  const current=await app.handleMessage(request('grammar.lookup',payload),reader);assert.ok(current.ok);
  const currentId=(current.data as {grammarId:string}).grammarId;
  dispatch=new Promise<void>(resolve=>{started=resolve;});
  const pending=app.handleMessage(request('grammar.chat',askInput(currentId)),reader);await dispatch;
  if(end==='tab'){
   app.closeGrammarTab(74);assert.equal(signal?.aborted,false);
   app.closeGrammarTab(reader.tab.id);
  }else if(end==='close')assert.ok((await app.handleMessage(request('grammar.chat.close',{grammarId:currentId}),reader)).ok);
  else if(end==='replace')assert.ok((await app.handleMessage(request('grammar.lookup',payload),reader)).ok);
  else assert.ok((await app.handleMessage(request('settings.update',{patch:{grammarEnabled:false}}),page)).ok);
  assert.equal(signal?.aborted,true);release(chatResponse());assert.equal(errorCode(await pending),'REQUEST_CANCELLED');
  assert.equal(errorCode(await app.handleMessage(request('grammar.chat',askInput(currentId)),reader)),end==='disable'?'PERMISSION_DENIED':'LOOKUP_EXPIRED');
 }
 assert.equal(calls,5);app.close();
});

test('cancel and close before a queued settings write settles cannot start a paid question',async t=>{
 let questionCalls=0;
 const {app,storage}=await setup(async(_url,options)=>{
  if(JSON.parse(options!.body as string).text.format.name==='language_reader_grammar_question_v1'){questionCalls++;return chatResponse();}
  return providerResponse();
 });
 const id=await enableChat(app);const write=storage.setMetadata.bind(storage);
 let entered!:()=>void,release!:()=>void;
 const writing=new Promise<void>(resolve=>{entered=resolve;});
 const wait=new Promise<void>(resolve=>{release=resolve;});
 t.mock.method(storage,'setMetadata',async(key:string,value:unknown)=>{if(key==='preferences'){entered();await wait;}return write(key,value);});
 const settings=app.handleMessage(request('settings.update',{patch:{grammarDeck:'Grammar sample'}}),page);
 await writing;
 const first=crypto.randomUUID(),pending=app.handleMessage(request('grammar.chat',askInput(id),first),reader);
 const cancel=await app.handleMessage(request('grammar.cancel',{requestId:first}),reader);
 assert.ok(cancel.ok);assert.deepEqual(cancel.data,{cancelled:true});assert.equal(errorCode(await pending),'REQUEST_CANCELLED');
 const another=app.handleMessage(request('grammar.chat',askInput(id)),reader);
 const closed=await app.handleMessage(request('grammar.chat.close',{grammarId:id}),reader);
 assert.ok(closed.ok);assert.deepEqual(closed.data,{closed:true});assert.equal(errorCode(await another),'REQUEST_CANCELLED');
 release();assert.ok((await settings).ok);assert.equal(questionCalls,0);app.close();
});

test('public grammar.chat distinguishes local and model topic decisions, insufficient evidence and transport errors',async()=>{
 const output=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',role:'assistant',
  content:[{type:'output_text',text:JSON.stringify(value)}]}]});
 const cases=[
  {kind:'model_out_of_scope',response:()=>output({result:{kind:'out_of_scope'}})},
  {kind:'model_no_answer',response:()=>output({result:{kind:'insufficient_evidence'}})},
  {error:'MODEL_REFUSAL',response:()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'PRIVATE-REFUSAL'}]}]})},
  {error:'MODEL_INCOMPLETE',response:()=>Response.json({status:'incomplete',output:[{type:'message',role:'assistant',status:'incomplete'}]})},
  {error:'INVALID_MODEL_OUTPUT',response:()=>new Response('PRIVATE-PROVIDER-OUTPUT')},
  {error:'INVALID_MODEL_OUTPUT',response:()=>output({result:{kind:'answer',answer:'Форма were sitting показывает действие в процессе.',anchor:'were sitting',evidence:'PRIVATE-FABRICATED-EVIDENCE'}})},
  {error:'INVALID_MODEL_OUTPUT',response:()=>output({result:{kind:'model_no_answer'}})},
  {kind:'answer',response:chatResponse},
 ];
 const histories:unknown[]=[];
 const {app,storage}=await setup(async(_url,options)=>{
  const body=JSON.parse(options!.body as string);
  if(body.text.format.name!=='language_reader_grammar_question_v1')return providerResponse();
  const i=histories.length;histories.push(JSON.parse(body.input[0].content[0].text).history);
  return cases[i]!.response();
 });
 try{
  const id=await enableChat(app);
  const local=askInput(id,'Где купить кофе?');
  const denied=await app.handleMessage(request('grammar.chat',local),reader);assert.ok(denied.ok);
  assert.deepEqual(denied.data,{grammarId:id,turnId:local.turnId,kind:'out_of_scope'});assert.equal(histories.length,0);
  for(const [i,item] of cases.entries()){
   const turn=askInput(id);
   for(let delivery=0;delivery<2;delivery++){
    const reply=await app.handleMessage(request('grammar.chat',turn),reader);
    if(item.error){assert.equal(errorCode(reply),item.error);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE-/);}
    else {
     assert.ok(reply.ok,JSON.stringify(reply));const data=reply.data as {kind:string;grammarId:string;turnId:string};
     assert.equal(data.kind,item.kind);assert.equal(data.grammarId,id);assert.equal(data.turnId,turn.turnId);
    }
    assert.equal(histories.length,i+1,'redelivery must never dispatch the question a second time');
   }
  }
  assert.deepEqual(histories,cases.map(()=>[]),'only a checked answer may enter the history sent to the provider');
  assert.deepEqual(await storage.allOperations(),[]);
 }finally{app.close();}
});

test('an example after a checked answer uses one strict example request, validates the variation, and preserves the current lesson',async()=>{
 const variation='They are sitting by the window.';
 const answer='Пример: «'+variation+'» Замена were sitting на are sitting переносит описываемое действие в настоящее.';
 let questions=0,examples=0;
 const {app}=await setup(async(_url,options)=>{
  const body=JSON.parse(options!.body as string),name=body.text.format.name;
  if(name==='language_reader_grammar_v2')return providerResponse();
  if(name==='language_reader_grammar_question_v1'){questions++;return chatResponse();}
  assert.equal(name,'language_reader_grammar_example_v1');assert.equal(body.text.format.strict,true);
  const input=JSON.parse(body.input[0].content[0].text);
  assert.equal(input.sentence,payload.sentence);assert.equal(input.history.length,1);
  assert.equal(input.history[0].answer,'Форма were sitting показывает действие в процессе.');
  const sample=++examples===1?'They were sitting by the door.':variation;
  const raw={result:{kind:'answer',anchor:'were sitting',evidence:payload.sentence,variation:sample,answer:answer.replace(variation,sample)}};
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(raw)}]}]});
 });
 try{
  const id=await enableChat(app),ask=(p:ReturnType<typeof askInput>)=>app.handleMessage(request('grammar.chat',p),reader);
  const before=await ask(askInput(id,'Можно пример?'));assert.ok(before.ok);assert.equal((before.data as {kind:string}).kind,'out_of_scope');
  assert.equal(questions+examples,0);
  const valid=await ask(askInput(id));assert.ok(valid.ok);assert.equal((valid.data as {kind:string}).kind,'answer');
  const bad=askInput(id,'Можно пример?');
  assert.equal(errorCode(await ask(bad)),'INVALID_MODEL_OUTPUT');assert.equal(errorCode(await ask(bad)),'INVALID_MODEL_OUTPUT');
  assert.equal(examples,1);
  const fresh=askInput(id,'Можно пример?'),result=await ask(fresh);assert.ok(result.ok,JSON.stringify(result));
  assert.deepEqual(result.data,{grammarId:id,turnId:fresh.turnId,kind:'answer',answer});
  const replay=await ask(fresh);assert.ok(replay.ok);assert.deepEqual(replay.data,result.data);
  assert.equal(questions,1);assert.equal(examples,2);
 }finally{app.close();}
});

test('the real reader RPC can quote the checked photo 7 rule and excludes a closed, foreign or disabled session before any chat call',async()=>{
 const {relativeClauseLesson:lesson}=await import('./fixtures/grammar-relative-clause.ts');
 let analyses=0,questions=0;
 const {app,secrets}=await setup(async(_url,options)=>{
  const body=JSON.parse(String(options?.body));
  if(body.text.format.name!=='language_reader_grammar_v2'){questions++;return chatResponse();}
  analyses++;const {grammarId:_id,...verified}=lesson.analysis;
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({analysis:{kind:'grammar',confidence:'high',...verified}})}]}]});
 });
 try{
  assert.ok((await app.handleMessage(request('settings.update',{patch:{grammarEnabled:true}}),page)).ok);
  const lookup=await app.handleMessage(request('grammar.lookup',lesson.input),reader);assert.ok(lookup.ok);
  const grammarId=(lookup.data as {grammarId:string}).grammarId;
  await secrets.clearOpenAIKey(); // A genuinely free follow-up must still work.
  const turn={grammarId,turnId:crypto.randomUUID(),turnNumber:1,sentence:lesson.input.sentence,question:"Процитируй правило из карточки"};
  const response=await app.handleMessage(request('grammar.chat',turn),reader);assert.ok(response.ok,JSON.stringify(response));
  assert.deepEqual(response.data,{grammarId,turnId:turn.turnId,kind:'answer',source:'analysis',answer:lesson.analysis.rule});
  assert.equal(errorCode(await app.handleMessage(request('grammar.chat',turn),{...reader,documentId:'another'})),'PERMISSION_DENIED');
  assert.ok((await app.handleMessage(request('grammar.chat.close',{grammarId}),reader)).ok);
  assert.equal(errorCode(await app.handleMessage(request('grammar.chat',turn),reader)),'LOOKUP_EXPIRED');
  assert.ok((await app.handleMessage(request('settings.update',{patch:{grammarEnabled:false}}),page)).ok);
  assert.equal(errorCode(await app.handleMessage(request('grammar.chat',turn),reader)),'PERMISSION_DENIED');
  assert.deepEqual({analyses,questions},{analyses:1,questions:0});
 }finally{app.close();}
});
