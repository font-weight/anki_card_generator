import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import {createReaderServices,SecretVault,ServiceError} from '../packages/services/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';
import {LANGUAGES,LEARNER_LEVELS} from '../packages/contracts/src/index.ts';
import type {LookupPayload,NoteDraftV1,NoteDraftV2,Operation,RpcData,RpcResponse} from '../packages/contracts/src/index.ts';
import {canonicalJson,sha256} from '../packages/note-templates/src/index.ts';
import {lookupCacheKey} from '../packages/services/src/lookup.ts';
import {PROMPT_VERSION,MODEL_SCHEMA_VERSION} from '../packages/services/src/prompts.ts';

const extensionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
const reader={id:extensionId,url:'https://reader.example/read',documentId:'doc',frameId:0,tab:{id:1}};
const input:LookupPayload={expression:'livre',context:{sentence:'Ce livre est intéressant.',targetStart:3,targetEnd:8,before:'Je suis à la bibliothèque.',after:'Je vais le lire.'},sourceLanguage:'fr',targetLanguage:'en',learnerLevel:'B2',dialect:'fr-FR'};
const sense={id:'book',translations:['book'],definition:'Un ensemble de pages à lire.'};
const examples=[{text:'Je lis un livre.',translation:'I am reading a book.',source:'ai' as const},{text:'Ce livre est court.',translation:'This book is short.',source:'ai' as const},{text:'Voici mon livre.',translation:'Here is my book.',source:'ai' as const}];
function area():SecretStorageArea{const state:Record<string,unknown>={};return{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,state[k]])),set:async values=>{Object.assign(state,values);},remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete state[k];},setAccessLevel:async()=>{}};}
function ok<T extends Operation>(response:RpcResponse):RpcData[T]{assert.equal(response.ok,true,JSON.stringify(response));if(!response.ok)throw Error('Expected success');return response.data as RpcData[T];}
function fails(response:RpcResponse,code:string){assert.equal(response.ok,false,JSON.stringify(response));if(!response.ok)assert.equal(response.error.code,code);}
function provider(value:unknown){return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}
async function harness(indexedDB=new IDBFactory()){
 const storage=await openReaderStorage({indexedDB}),secrets=new SecretVault({session:area(),local:area()});
 await secrets.setOpenAIKey('synthetic-only-not-a-real-key');
 const calls:{url:string;body:any}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  const text=String(url),body=init?.body?JSON.parse(String(init.body)):null;calls.push({url:text,body});
  if(text.includes('dictionaryapi.dev'))return Response.json([{word:'book',phonetics:[{text:'/bʊk/'}],sourceUrls:['https://en.wiktionary.org/wiki/book']}]);
  if(!text.endsWith('/responses'))throw new ServiceError('NETWORK_TIMEOUT');
  const data=JSON.parse(body.input[0].content[0].text);
  return provider(body.text.format.name==='language_reader_examples_v2'?{examples}:{lemma:data.expression,partOfSpeech:'noun',recommendedSenseId:sense.id,contextAmbiguous:false,senses:[sense],ipaCandidate:null,extraExample:null});
 };
 const app=createReaderServices({storage,secrets,fetch:fetcher,confirmations:{requireConsent:async()=>true},runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:s=>s.documentId==='doc'}});
 const send=(type:Operation,payload:unknown={},sender=page)=>app.handleMessage({v:1,requestId:crypto.randomUUID(),type,payload},sender);
 return{app,storage,secrets,calls,send,indexedDB};
}
const legacyDraft:NoteDraftV1={sourceLanguage:'en',targetLanguage:'ru',mode:'recognition',deckName:'Default',tags:[],expression:'book',lemma:'book',partOfSpeech:'noun',selectedSense:{id:'book',translations:['книга'],definitionEn:'A written work.'},context:{sentence:'Read this book.',targetStart:10,targetEnd:14},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:null,source:{kind:'html',title:'Private source',url:'https://reader.example/read?private=yes',documentId:null,page:null,chapter:null,cfi:null}};
function modernDraft():NoteDraftV2{const{extraExample,selectedSense,...old}=structuredClone(legacyDraft);return{...old,draftVersion:2,learnerLevel:'B1',selectedSense:{id:selectedSense.id,translations:selectedSense.translations,definition:selectedSense.definitionEn},examples:[]};}

test('legacy preferences inherit EN→RU/B1 without rewriting preferences or frozen v1 queue rows',async()=>{
 const h=await harness(),operationId=crypto.randomUUID();
 ok(await h.send('anki.addNote',{operationId,draft:legacyDraft,includeAudio:false},reader));
 const frozen=await h.storage.getOperation(operationId);
 const preferences={dialect:'en-GB',defaultDeck:'Old deck',audioSpeed:.75};
 await h.storage.setMetadata('preferences',preferences);h.app.close();
 const reopened=await harness(h.indexedDB),reply=await reopened.send('settings.getReader',{},reader),settings=ok<'settings.getReader'>(reply);
 assert.equal(settings.sourceLanguage,'en');assert.equal(settings.targetLanguage,'ru');assert.equal(settings.learnerLevel,'B1');assert.equal(settings.dialect,'en-GB');assert.equal(settings.defaultDeck,'Old deck');
 if(reply.ok)assert.ok(!reply.warnings.includes('SETTINGS_REPAIR_REQUIRED'));
 assert.deepEqual(await reopened.storage.getMetadata('preferences'),preferences);
 assert.deepEqual(await reopened.storage.getOperation(operationId),frozen);
 assert.equal(reopened.calls.length,0);reopened.app.close();
});

test('all registry sources and CEFR levels persist with matching automatic locale and reload safely',async()=>{
 const h=await harness();
 for(const [index,language] of LANGUAGES.entries()){
  const target=LANGUAGES[(index+1)%LANGUAGES.length]!.code,level=LEARNER_LEVELS[index%LEARNER_LEVELS.length]!;
  const saved=ok<'settings.update'>(await h.send('settings.update',{patch:{sourceLanguage:language.code,targetLanguage:target,learnerLevel:level}}));
  assert.equal(saved.sourceLanguage,language.code);assert.equal(saved.targetLanguage,target);assert.equal(saved.learnerLevel,level);assert.equal(saved.dialect,language.locale);
 }
 const saved=await h.storage.getMetadata('preferences');h.app.close();const reopened=await harness(h.indexedDB);
 const settings=ok<'settings.getPublic'>(await reopened.send('settings.getPublic'));
 for(const key of ['sourceLanguage','targetLanguage','learnerLevel','dialect'] as const)assert.equal(settings[key],(saved as any)[key]);
 assert.equal(reopened.calls.length,0);reopened.app.close();
});

test('merged locale mismatch fails before credential writes and leaves preferences unchanged',async()=>{
 const h=await harness();
 ok(await h.send('settings.update',{patch:{sourceLanguage:'ja',targetLanguage:'en',learnerLevel:'C2'}}));
 await h.secrets.setAnkiConnectKey('old-synthetic-key');const before=await h.storage.getMetadata('preferences');
 fails(await h.send('settings.update',{patch:{dialect:'fr-FR'},ankiKey:'replacement-synthetic-key'}),'INVALID_INPUT');
 assert.equal(await h.secrets.getAnkiConnectKeyForService(),'old-synthetic-key');assert.deepEqual(await h.storage.getMetadata('preferences'),before);
 assert.equal(ok<'settings.getReader'>(await h.send('settings.getReader',{},reader)).dialect,'ja-JP');assert.equal(h.calls.length,0);h.app.close();
});

test('enrichment and refinement use the frozen lookup pair, CEFR, sentence and sense after settings change',async()=>{
 const h=await harness(),lookup=ok<'lookup'>(await h.send('lookup',input,reader));
 ok(await h.send('settings.update',{patch:{sourceLanguage:'ja',targetLanguage:'ru',learnerLevel:'C2'}}));
 const enriched=ok<'card.enrich'>(await h.send('card.enrich',{lookupId:lookup.lookupId,senseId:sense.id},reader));
 assert.deepEqual(enriched.examples,examples);
 assert.deepEqual(JSON.parse(h.calls[1]!.body.input[0].content[0].text),{...input,selectedSense:sense});
 ok(await h.send('lookup.refine',{lookupId:lookup.lookupId},reader));
 assert.deepEqual(JSON.parse(h.calls[2]!.body.input[0].content[0].text),input);assert.equal(h.calls[2]!.body.model,'gpt-4.1');
 assert.equal(ok<'settings.getReader'>(await h.send('settings.getReader',{},reader)).sourceLanguage,'ja');h.app.close();
});

test('legacy cache entries neither serve a new lookup nor become enrichable under the v2 schema',async()=>{
 const h=await harness(),lookupId=crypto.randomUUID(),oldKey=lookupCacheKey(input,'gpt-4.1-mini').replace(PROMPT_VERSION,'english-reader-lookup-v1').replace(MODEL_SCHEMA_VERSION,'english-reader-model-v1');
 const old={key:await sha256(oldKey),lookupId,request:input,data:{lookupId,expression:input.expression,lemma:input.expression,partOfSpeech:'noun',recommendedSenseId:'book',contextAmbiguous:false,senses:[{id:'book',translations:['book'],definitionEn:'A written work.'}],ipaCandidate:null,extraExample:null},meta:{model:'gpt-4.1-mini',cacheHit:false,schemaVersion:'1',promptVersion:'english-reader-lookup-v1'},byteLength:0,createdAt:new Date().toISOString(),lastAccessedAt:new Date().toISOString()};
 await h.storage.putLookup(old as any);const preserved=await h.storage.getLookup(old.key);
 fails(await h.send('card.enrich',{lookupId,senseId:'book'}),'LOOKUP_EXPIRED');assert.equal(h.calls.length,0);
 const fresh=await h.send('lookup',input,reader);ok(fresh);if(fresh.ok)assert.equal(fresh.meta?.cacheHit,false);assert.equal(h.calls.length,1);
 const retained=await h.storage.getLookup(old.key);assert.deepEqual(retained?.data,preserved?.data);assert.deepEqual(retained?.request,preserved?.request);h.app.close();
});

test('a structurally valid v2-prompt cache cannot bypass revised v3 pronunciation/ambiguity instructions',async()=>{
 const h=await harness(),lookupId=crypto.randomUUID(),parts=JSON.parse(lookupCacheKey(input,'gpt-4.1-mini'));
 parts[0]='language-reader-lookup-v2';
 const old={key:await sha256(JSON.stringify(parts)),lookupId,request:input,data:{lookupId,expression:input.expression,lemma:input.expression,partOfSpeech:'noun',recommendedSenseId:sense.id,contextAmbiguous:false,senses:[sense],ipaCandidate:null,extraExample:null},meta:{model:'gpt-4.1-mini',cacheHit:false,schemaVersion:'1',promptVersion:'language-reader-lookup-v2'},byteLength:0,createdAt:new Date().toISOString(),lastAccessedAt:new Date().toISOString()};
 await h.storage.putLookup(old as any);
 fails(await h.send('card.enrich',{lookupId,senseId:sense.id}),'LOOKUP_EXPIRED');assert.equal(h.calls.length,0);
 const fresh=await h.send('lookup',input,reader);ok(fresh);
 if(fresh.ok){assert.equal(fresh.meta?.cacheHit,false);assert.equal(fresh.meta?.promptVersion,PROMPT_VERSION);}
 assert.equal(h.calls.length,1);assert.deepEqual((await h.storage.getLookup(old.key))?.data,old.data);h.app.close();
});

test('v1 dictionary proof remains valid only for a legacy draft; v2 needs language-scoped proof',async()=>{
 const h=await harness(),pronunciation={ipa:'/bʊk/',dialect:'unknown' as const,source:'dictionary' as const,sourceUrl:'https://en.wiktionary.org/wiki/book'};
 const legacy={...structuredClone(legacyDraft),pronunciation},modern={...modernDraft(),pronunciation};
 const oldKey=`pronunciation:${await sha256(canonicalJson({expression:legacy.expression,pronunciation}))}`;
 await h.storage.setMetadata(oldKey,true);
 ok(await h.send('anki.addNote',{operationId:crypto.randomUUID(),draft:legacy,includeAudio:false},reader));const calls=h.calls.length;
 fails(await h.send('anki.addNote',{operationId:crypto.randomUUID(),draft:modern,includeAudio:false},reader),'PERMISSION_DENIED');assert.equal(h.calls.length,calls);
 const wrongLanguageKey=`pronunciation:${await sha256(canonicalJson({sourceLanguage:'fr',expression:modern.expression,pronunciation}))}`;
 await h.storage.setMetadata(wrongLanguageKey,true);
 fails(await h.send('anki.addNote',{operationId:crypto.randomUUID(),draft:modern,includeAudio:false},reader),'PERMISSION_DENIED');assert.equal(h.calls.length,calls);
 const newKey=`pronunciation:${await sha256(canonicalJson({sourceLanguage:'en',expression:modern.expression,pronunciation}))}`;
 await h.storage.setMetadata(newKey,true);
 ok(await h.send('anki.addNote',{operationId:crypto.randomUUID(),draft:modern,includeAudio:false},reader));assert.equal(h.calls.length,calls+1);h.app.close();
});

test('dictionary lookup writes source-language provenance; non-English lookups never call English dictionary',async()=>{
 const h=await harness();ok(await h.send('settings.update',{patch:{dictionaryEnabled:true}}));
 const english:LookupPayload={expression:'book',context:legacyDraft.context,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'A1',dialect:'en-GB'};
 const lookup=ok<'lookup'>(await h.send('lookup',english,reader));
 const pronunciation=ok<'pronunciation.get'>(await h.send('pronunciation.get',{lookupId:lookup.lookupId},reader)).pronunciation;
 assert.equal(pronunciation.source,'dictionary');
 const key=`pronunciation:${await sha256(canonicalJson({sourceLanguage:'en',expression:'book',pronunciation}))}`;
 assert.equal(await h.storage.getMetadata(key),true);
 assert.equal(await h.storage.getMetadata(`pronunciation:${await sha256(canonicalJson({expression:'book',pronunciation}))}`),null);
 const nonEnglish=ok<'lookup'>(await h.send('lookup',input,reader)),before=h.calls.length;
 const response=await h.send('pronunciation.get',{lookupId:nonEnglish.lookupId},reader);
 assert.equal(ok<'pronunciation.get'>(response).pronunciation.source,'unavailable');assert.equal(h.calls.length,before);h.app.close();
});
