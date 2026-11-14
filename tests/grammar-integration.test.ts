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
const providerResponse=()=>Response.json({status:'completed',model:'gpt-6-luna',id:'resp_mock',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(content)}]}],usage:{input_tokens:5,output_tokens:10,total_tokens:15}});
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
