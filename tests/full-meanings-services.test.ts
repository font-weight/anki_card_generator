import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import {createReaderServices,SecretVault} from '../packages/services/src/index.ts';
import type {RuntimeSender} from '../packages/services/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';
import {senseDefinition} from '../packages/contracts/src/index.ts';
import type {LookupData,LookupPayload,MultilingualSense,NoteDraftV3,Operation,RpcData,RpcResponse} from '../packages/contracts/src/index.ts';
import {LOOKUP_MAX_OUTPUT_TOKENS,ENRICH_MAX_OUTPUT_TOKENS,LOOKUP_MODEL,REFINE_MODEL,validateModelLookup,OpenAIService} from '../packages/services/src/openai.ts';
import {LOOKUP_SYSTEM_PROMPT,PROMPT_VERSION,MODEL_SCHEMA_VERSION} from '../packages/services/src/prompts.ts';
import {LookupCoordinator,lookupCacheKey} from '../packages/services/src/lookup.ts';
import {sha256} from '../packages/note-templates/src/index.ts';
import {TTS_ENDPOINT} from '../packages/services/src/audio.ts';

const extensionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const reader={id:extensionId,url:'https://reader.example/read',documentId:'source-document',frameId:0,tab:{id:1}};
const input:LookupPayload={expression:'bank',context:{sentence:'We stopped at the bank.',targetStart:18,targetEnd:22},sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-GB'};
const senses:MultilingualSense[]=Array.from({length:8},(_,i)=>({id:`sense-${i}`,translations:Array.from({length:4},(_,j)=>`перевод ${i}-${j}`),definition:`Common meaning ${i}.`}));
const output={lemma:'bank',partOfSpeech:'noun',recommendedSenseId:senses[0]!.id,contextAmbiguous:false,senses:[...senses.slice(1),senses[0]!],ipaCandidate:null,extraExample:null};
const example={text:'The bank is open.',translation:'Банк открыт.',source:'ai'};
function area():SecretStorageArea{const values:Record<string,unknown>={};return{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,values[key]])),set:async next=>{Object.assign(values,next);},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete values[key];},setAccessLevel:async()=>{}};}
function provider(value:unknown){return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}
function ok<T extends Operation>(response:RpcResponse):RpcData[T]{assert.equal(response.ok,true,JSON.stringify(response));if(!response.ok)throw Error('Expected success');return response.data as RpcData[T];}
function fails(response:RpcResponse,code:string){assert.equal(response.ok,false,JSON.stringify(response));if(!response.ok)assert.equal(response.error.code,code);}
async function harness(){
 const storage=await openReaderStorage({indexedDB:new IDBFactory()}),secrets=new SecretVault({session:area(),local:area()});
 await secrets.setOpenAIKey('synthetic-only-not-a-real-key');
 const calls:{url:string;body:any}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  const text=String(url),body=JSON.parse(String(init?.body));calls.push({url:text,body});
  if(text===TTS_ENDPOINT)return new Response(new Uint8Array([0x49,0x44,0x33,0x04,0,0,0,0]),{headers:{'Content-Type':'audio/mpeg'}});
  assert.equal(text,'https://api.openai.com/v1/responses','No network or Anki adapter is allowed in this offline harness');
  return provider(body.text.format.name==='language_reader_examples_v2'?{examples:[example]}:output);
 };
 const app=createReaderServices({storage,secrets,fetch:fetcher,confirmations:{requireConsent:async()=>true},runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:sender=>sender.documentId==='source-document'}});
 const send=(type:Operation,payload:unknown={},sender:RuntimeSender=reader)=>app.handleMessage({v:1,requestId:crypto.randomUUID(),type,payload},sender);
 return{app,storage,calls,send};
}
function draftFor(lookup:LookupData,selectedId=lookup.recommendedSenseId):NoteDraftV3{
 const neutral=lookup.senses.map(sense=>({id:sense.id,translations:[...sense.translations],definition:senseDefinition(sense)}));
 const selected=neutral.find(sense=>sense.id===selectedId)!;
 return{draftVersion:3,sourceLanguage:input.sourceLanguage,targetLanguage:input.targetLanguage,learnerLevel:input.learnerLevel,mode:'recognition',deckName:'Default',tags:[],expression:lookup.expression,lemma:lookup.lemma,partOfSpeech:lookup.partOfSpeech,selectedSense:structuredClone(selected),senses:[selected,...neutral.filter(sense=>sense.id!==selected.id)],context:{...input.context},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},examples:[],source:{kind:'html',title:'Local fixture',url:'https://reader.example/read',documentId:null,page:null,chapter:null,cfi:null}};
}

test('common-meaning prompt is broad but explicitly bounded rather than an exhaustive dictionary claim',()=>{
 assert.match(LOOKUP_SYSTEM_PROMPT,/Return 1 to 8 distinct common senses/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/other common meanings that do not fit this particular sentence/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/not an exhaustive dictionary of every rare, obsolete or specialist sense/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/1 to 4 concise targetLanguage equivalents/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/recommended contextual sense first/);
});

test('eight senses with four translations survive provider validation with recommendation first and no mutation',()=>{
 const before=JSON.stringify(output),result=validateModelLookup(output,input);
 assert.deepEqual(result.senses,senses);assert.equal(JSON.stringify(output),before);
 assert.equal(result.senses.reduce((sum,sense)=>sum+sense.translations.length,0),32);
 for(const invalid of [{...output,senses:[...senses,{...senses[0],id:'ninth'}]},{...output,senses:[{...senses[0],translations:['a','b','c','d','e']}]},{...output,senses:[{...senses[0],definition:'<script>unsafe()</script>'}]}])assert.throws(()=>validateModelLookup(invalid,input),{code:'INVALID_MODEL_OUTPUT'});
});

test('lookup/refine have a bounded larger output budget and Luna effort is explicit for every text route',async()=>{
 const h=await harness();try{
  const lookup=ok<'lookup'>(await h.send('lookup',input));assert.deepEqual(lookup.senses,senses);
  ok(await h.send('lookup.refine',{lookupId:lookup.lookupId}));
  ok(await h.send('card.enrich',{lookupId:lookup.lookupId,senseId:senses[0]!.id}));
  assert.deepEqual(h.calls.map(call=>call.body.model),[LOOKUP_MODEL,REFINE_MODEL,LOOKUP_MODEL]);
  assert.deepEqual(h.calls.map(call=>call.body.reasoning),[{effort:'none'},{effort:'low'},{effort:'none'}]);
  assert.deepEqual(h.calls.map(call=>call.body.max_output_tokens),[LOOKUP_MAX_OUTPUT_TOKENS,LOOKUP_MAX_OUTPUT_TOKENS,ENRICH_MAX_OUTPUT_TOKENS]);
  assert.equal(LOOKUP_MAX_OUTPUT_TOKENS,3200);assert.equal(ENRICH_MAX_OUTPUT_TOKENS,1800);
  assert.equal(h.calls[0]!.body.text.format.name,'language_reader_lookup_v3');
  assert.ok(h.calls.every(call=>call.body.store===false&&call.body.stream===false&&call.body.tools===undefined));
 }finally{h.app.close();}
});

test('cache serves every meaning with independent result copies and no additional provider request',async()=>{
 const h=await harness();try{
  const first=ok<'lookup'>(await h.send('lookup',input));first.senses[0]!.translations[0]='caller mutation';
  const response=await h.send('lookup',input),second=ok<'lookup'>(response);
  assert.deepEqual(second.senses,senses);assert.equal(h.calls.length,1);if(response.ok)assert.equal(response.meta?.cacheHit,true);
 }finally{h.app.close();}
});

test('coordinator normalizes cached recommendation order without editing the cache snapshot',async()=>{
 const service=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>provider(output)});
 const cached=await service.lookup(input);cached.data.senses=structuredClone(output.senses);const before=JSON.stringify(cached);
 const coordinator=new LookupCoordinator({lookup:async()=>{throw Error('No provider call expected');}},{get:async()=>cached,set:async()=>{throw Error('No cache rewrite expected');}});
 const result=await coordinator.lookup(input,{requestId:crypto.randomUUID()});
 assert.deepEqual(result.data.senses,senses);assert.equal(result.cacheHit,true);assert.equal(JSON.stringify(cached),before);
});

test('previous single-context lookup namespace cannot bypass the common-meaning prompt or be enriched',async()=>{
 const h=await harness();try{
  const lookupId=crypto.randomUUID(),parts=JSON.parse(lookupCacheKey(input,LOOKUP_MODEL));parts[0]='language-reader-lookup-v3';parts[1]='language-reader-model-v2';
  const key=await sha256(JSON.stringify(parts)),old={key,lookupId,request:input,data:{lookupId,expression:input.expression,...output,senses:[senses[0]]},meta:{model:LOOKUP_MODEL,cacheHit:false,schemaVersion:'1',promptVersion:'language-reader-lookup-v3'},byteLength:0,createdAt:new Date().toISOString(),lastAccessedAt:new Date().toISOString()};
  await h.storage.putLookup(old as any);
  fails(await h.send('card.enrich',{lookupId,senseId:senses[0]!.id},page),'LOOKUP_EXPIRED');assert.equal(h.calls.length,0);
  const reply=await h.send('lookup',input);assert.deepEqual(ok<'lookup'>(reply).senses,senses);assert.equal(h.calls.length,1);
  if(reply.ok){assert.equal(reply.meta?.cacheHit,false);assert.equal(reply.meta?.promptVersion,PROMPT_VERSION);}
  assert.equal(MODEL_SCHEMA_VERSION,'language-reader-model-v3');assert.deepEqual((await h.storage.getLookup(key))?.data,old.data);
 }finally{h.app.close();}
});

test('audio preparation accepts the complete v3 meanings and another explicitly selected sense without truncation',async()=>{
 const h=await harness();try{
  ok(await h.send('settings.update',{patch:{cloudAudioEnabled:true}},page));
  const lookup=ok<'lookup'>(await h.send('lookup',input));
  for(const selectedId of [senses[0]!.id,senses[5]!.id]){
   const draft=draftFor(lookup,selectedId),audio=ok<'audio.prepare'>(await h.send('audio.prepare',{lookupId:lookup.lookupId,senseId:selectedId,draft}));
   assert.equal(audio.text,'bank');assert.equal(audio.dialect,'en-GB');assert.equal(draft.senses.length,8);assert.equal(draft.selectedSense.translations.length,4);
  }
  assert.equal(h.calls.filter(call=>call.url===TTS_ENDPOINT).length,2);
  const tts=h.calls.find(call=>call.url===TTS_ENDPOINT)!.body;assert.equal(tts.input,'bank');assert.equal(tts.model,'gpt-4o-mini-tts');
 }finally{h.app.close();}
});

test('audio preparation rejects missing or altered secondary meanings before any TTS call',async()=>{
 const h=await harness();try{
  ok(await h.send('settings.update',{patch:{cloudAudioEnabled:true}},page));
  const lookup=ok<'lookup'>(await h.send('lookup',input)),draft=draftFor(lookup);
  const patches=[
   {senses:draft.senses.slice(0,1)},
   {senses:draft.senses.map((sense,index)=>index===2?{...sense,definition:'A different meaning.'}:sense)},
   {senses:draft.senses.map((sense,index)=>index===2?{...sense,translations:sense.translations.slice(0,1)}:sense)},
   {senses:[draft.senses[0],...draft.senses.slice(1).reverse()]},
   {senses:draft.senses.map((sense,index)=>index===2?{...sense,id:'injected'}:sense)},
   {selectedSense:{...draft.selectedSense,translations:['unrelated']},senses:[{...draft.selectedSense,translations:['unrelated']},...draft.senses.slice(1)]},
   {learnerLevel:'C2'},
  ];
  for(const patch of patches)fails(await h.send('audio.prepare',{lookupId:lookup.lookupId,senseId:draft.selectedSense.id,draft:{...draft,...patch}}),'INVALID_INPUT');
  assert.equal(h.calls.filter(call=>call.url===TTS_ENDPOINT).length,0);
  const selectedSense={...draft.selectedSense,translations:draft.selectedSense.translations.slice(0,2)};
  ok(await h.send('audio.prepare',{lookupId:lookup.lookupId,senseId:selectedSense.id,draft:{...draft,selectedSense,senses:[selectedSense,...draft.senses.slice(1)]}}));
  assert.equal(h.calls.filter(call=>call.url===TTS_ENDPOINT).length,1);
 }finally{h.app.close();}
});

test('new v3 add with checked but unprepared audio fails before any fetch or outbox write',async()=>{
 const h=await harness();try{
  const draft=draftFor({lookupId:crypto.randomUUID(),expression:input.expression,...output,senses});
  for(const cloudAudioEnabled of [false,true]){
   if(cloudAudioEnabled)ok(await h.send('settings.update',{patch:{cloudAudioEnabled:true}},page));
   const before=await h.storage.allOperations(),operationId=crypto.randomUUID();
   const reply=await h.send('anki.addNote',{operationId,draft,includeAudio:true});
   fails(reply,'AUDIO_UNAVAILABLE');
   if(!reply.ok){assert.match(reply.error.message,/дождитесь статуса «Аудио готово»/);assert.match(reply.error.message,/сохранить без аудио/);assert.equal(reply.error.retryable,false);}
   assert.equal(h.calls.length,0);assert.equal(await h.storage.getOperation(operationId),null);assert.deepEqual(await h.storage.allOperations(),before);
  }
 }finally{h.app.close();}
});
