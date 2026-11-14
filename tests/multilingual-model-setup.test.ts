import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import {createReaderServices,SecretVault} from '../packages/services/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';
import type {NoteDraftV1,NoteDraftV2,Operation,RpcData,RpcResponse} from '../packages/contracts/src/index.ts';
import {modelDefinition,modelNamesFor} from '../packages/note-templates/src/index.ts';
import type {PreparedAnkiNote} from '../packages/services/src/anki.ts';

const extensionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const reader={id:extensionId,url:'https://reader.example/article',documentId:'doc',frameId:0,tab:{id:1}};
function area():SecretStorageArea{const values:Record<string,unknown>={};return{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,values[key]])),set:async items=>{Object.assign(values,items);},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete values[key];},setAccessLevel:async()=>{}};}
function ok<T extends Operation>(response:RpcResponse):RpcData[T]{assert.equal(response.ok,true,JSON.stringify(response));if(!response.ok)throw Error('Expected success');return response.data as RpcData[T];}
function fails(response:RpcResponse,code:string){assert.equal(response.ok,false,JSON.stringify(response));if(!response.ok)assert.equal(response.error.code,code);}
const legacy:NoteDraftV1={sourceLanguage:'en',targetLanguage:'ru',mode:'recognition',deckName:'Default',tags:[],expression:'book',lemma:'book',partOfSpeech:'noun',selectedSense:{id:'book',translations:['книга'],definitionEn:'A written work.'},context:{sentence:'Read this book.',targetStart:10,targetEnd:14},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:null,source:{kind:'html',title:'Book',url:null,documentId:null,page:null,chapter:null,cfi:null}};
function modern():NoteDraftV2{const{extraExample,selectedSense,...draft}=structuredClone(legacy);return{...draft,draftVersion:2,learnerLevel:'B1',selectedSense:{id:selectedSense.id,translations:selectedSense.translations,definition:selectedSense.definitionEn},examples:[]};}

async function harness(){
 const indexedDB=new IDBFactory();let storage=await openReaderStorage({indexedDB});
 const secrets=new SecretVault({session:area(),local:area()});
 const models=new Map<string,ReturnType<typeof modelDefinition>>(),notes=new Map<number,PreparedAnkiNote>();
 const calls:{action:string;params:any}[]=[],confirmations:{kind:string;payload:unknown}[]=[];
 let consent=true,online=true;
 const fetcher:typeof fetch=async(url,init)=>{
  assert.equal(String(url),'http://127.0.0.1:8765/');
  const call=JSON.parse(String(init?.body));calls.push(structuredClone(call));
  if(!online)throw new TypeError('Mock offline');
  const result=(value:unknown)=>Response.json({result:value,error:null});
  switch(call.action){
   case'version':return result(6);
   case'deckNames':return result(['Default']);
   case'modelNames':return result([...models.keys()]);
   case'createModel':assert.ok(!models.has(call.params.modelName),'never overwrite an existing model');models.set(call.params.modelName,structuredClone(call.params));return result({});
   case'modelFieldNames':{const model=models.get(call.params.modelName);return model?result(model.inOrderFields):Response.json({result:null,error:'model not found'});}
   case'findModelsByName':return result(call.params.modelNames.flatMap((name:string)=>{const model=models.get(name);return model?[{name,type:model.isCloze?1:0,tmpls:[{qfmt:model.cardTemplates[0]!.Front,afmt:model.cardTemplates[0]!.Back}]}]:[];}));
   case'findNotes':{const match=/"(OperationId|LexemeKey):([0-9a-f-]+)"/iu.exec(call.params.query);assert.ok(match);return result([...notes].filter(([,note])=>note.fields[match[1]!]===match[2]).map(([id])=>id));}
   case'notesInfo':return result(call.params.notes.map((id:number)=>{const note=notes.get(id)!;return{noteId:id,modelName:note.modelName,fields:Object.fromEntries(Object.entries(note.fields).map(([name,value],order)=>[name,{value,order}]))};}));
   case'addNote':{const note=structuredClone(call.params.note) as PreparedAnkiNote;assert.ok(models.has(note.modelName));const id=notes.size+101;notes.set(id,note);return result(id);}
   default:throw new Error(`Unexpected mock action ${call.action}`);
  }
 };
 const makeApp=()=>createReaderServices({storage,secrets,fetch:fetcher,confirmations:{requireConsent:async(kind,{request})=>{confirmations.push({kind,payload:request.payload});return consent;}},runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:s=>s.documentId==='doc'}});
 let app=makeApp();
 const send=(type:Operation,payload:unknown={},sender=page)=>app.handleMessage({v:1,requestId:crypto.randomUUID(),type,payload},sender);
 return{send,models,notes,calls,confirmations,getStorage:()=>storage,setConsent:(value:boolean)=>{consent=value;},setOnline:(value:boolean)=>{online=value;},restart:async()=>{app.close();storage=await openReaderStorage({indexedDB});app=makeApp();},close:()=>app.close()};
}

test('configuration reports both model versions without creating models; omitted setup still creates only v2',async()=>{
 const h=await harness();try{
  const empty=ok<'anki.configuration'>(await h.send('anki.configuration'));
  assert.deepEqual(new Set(empty.models.map(model=>model.name)),new Set([...Object.values(modelNamesFor(1)),...Object.values(modelNamesFor(2))]));
  assert.ok(empty.models.every(model=>!model.exists&&!model.compatible));assert.equal(h.models.size,0);assert.equal(h.calls.filter(call=>call.action==='createModel').length,0);
  const initialized=ok<'anki.initializeModels'>(await h.send('anki.initializeModels'));
  assert.deepEqual(initialized.created,Object.values(modelNamesFor(2)));assert.deepEqual(initialized.existing,[]);
  assert.deepEqual([...h.models.keys()],Object.values(modelNamesFor(2)));
  const configured=ok<'anki.configuration'>(await h.send('anki.configuration'));
  assert.ok(configured.models.filter(model=>Object.values(modelNamesFor(2)).some(name=>name===model.name)).every(model=>model.exists&&model.compatible));
  assert.ok(configured.models.filter(model=>Object.values(modelNamesFor(1)).some(name=>name===model.name)).every(model=>!model.exists&&!model.compatible));
 }finally{h.close();}
});

test('explicit legacy setup requires privileged sender and fresh consent before any mock Anki call',async()=>{
 const h=await harness();try{
  fails(await h.send('anki.initializeModels',{modelVersion:1},reader),'PERMISSION_DENIED');assert.equal(h.calls.length,0);assert.equal(h.confirmations.length,0);
  h.setConsent(false);fails(await h.send('anki.initializeModels',{modelVersion:1}),'PERMISSION_DENIED');assert.equal(h.calls.length,0);assert.deepEqual(h.confirmations,[{kind:'initialize_models',payload:{modelVersion:1}}]);
  h.setConsent(true);const result=ok<'anki.initializeModels'>(await h.send('anki.initializeModels',{modelVersion:1}));
  assert.deepEqual(result.created,Object.values(modelNamesFor(1)));assert.deepEqual([...h.models.keys()],Object.values(modelNamesFor(1)));
  const again=ok<'anki.initializeModels'>(await h.send('anki.initializeModels',{modelVersion:1}));assert.deepEqual(again.created,[]);assert.deepEqual(again.existing,Object.values(modelNamesFor(1)));assert.equal(h.calls.filter(call=>call.action==='createModel').length,2);
 }finally{h.close();}
});

test('legacy offline queue recovers after explicit v1 model setup without migrating any durable draft or keys',async()=>{
 const h=await harness();try{
  const operationId=crypto.randomUUID();h.setOnline(false);
  assert.equal(ok<'anki.addNote'>(await h.send('anki.addNote',{operationId,draft:legacy,includeAudio:false},reader)).status,'queued');
  const original=await h.getStorage().getOperation(operationId);assert.ok(original);assert.equal(original.state,'pending');
  await h.restart();h.setOnline(true);
  ok(await h.send('anki.initializeModels'));assert.deepEqual(await h.getStorage().getOperation(operationId),original,'v2 setup never rewrites old queued row');
  const beforeCreates=h.calls.filter(call=>call.action==='createModel').length;
  const missing=ok<'queue.retry'>(await h.send('queue.retry',{operationId})).operation;
  assert.equal(missing.state,'failed');assert.equal(missing.lastError?.code,'ANKI_SCHEMA_MISMATCH');assert.equal(h.notes.size,0);assert.equal(h.calls.filter(call=>call.action==='createModel').length,beforeCreates,'retry cannot auto-create legacy models');
  const beforeLegacySetup=await h.getStorage().getOperation(operationId);
  ok(await h.send('anki.initializeModels',{modelVersion:1}));
  assert.deepEqual(await h.getStorage().getOperation(operationId),beforeLegacySetup,'explicit model setup does not mutate queued intent');
  const recovered=ok<'queue.retry'>(await h.send('queue.retry',{operationId})).operation;
  assert.equal(recovered.state,'synced');assert.equal(recovered.noteId,101);assert.deepEqual(recovered.draft,legacy);
  const row=await h.getStorage().getOperation(operationId);for(const key of ['draft','keys','fingerprint','targetIdentity','audioSnapshot','audioCacheKey'] as const)assert.deepEqual(row![key],original[key],`${key} remains frozen`);
  assert.equal(Object.hasOwn(recovered.draft,'draftVersion'),false);assert.equal(h.notes.get(101)!.modelName,modelNamesFor(1).recognition);
  assert.equal(h.calls.filter(call=>call.action==='addNote').length,1);
 }finally{h.close();}
});

test('v2 offline queue still recovers with omitted default setup and never creates legacy models',async()=>{
 const h=await harness();try{
  const operationId=crypto.randomUUID(),draft=modern();h.setOnline(false);
  ok(await h.send('anki.addNote',{operationId,draft,includeAudio:false},reader));const before=await h.getStorage().getOperation(operationId);
  await h.restart();h.setOnline(true);ok(await h.send('anki.initializeModels'));
  assert.deepEqual(await h.getStorage().getOperation(operationId),before);
  const recovered=ok<'queue.retry'>(await h.send('queue.retry',{operationId})).operation;
  assert.equal(recovered.state,'synced');assert.deepEqual(recovered.draft,draft);assert.equal(h.notes.get(101)!.modelName,modelNamesFor(2).recognition);assert.deepEqual([...h.models.keys()],Object.values(modelNamesFor(2)));
 }finally{h.close();}
});

test('incompatible legacy model is reported and never overwritten or repaired automatically',async()=>{
 const h=await harness();try{
  const broken=structuredClone(modelDefinition('recognition',1));broken.inOrderFields.reverse();h.models.set(broken.modelName,broken);
  const config=ok<'anki.configuration'>(await h.send('anki.configuration'));assert.deepEqual(config.models.find(model=>model.name===broken.modelName),{name:broken.modelName,exists:true,compatible:false});
  fails(await h.send('anki.initializeModels',{modelVersion:1}),'ANKI_SCHEMA_MISMATCH');assert.deepEqual(h.models.get(broken.modelName),broken);assert.equal(h.models.size,1);assert.equal(h.calls.filter(call=>call.action==='createModel').length,0);
 }finally{h.close();}
});
