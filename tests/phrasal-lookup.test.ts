import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {enumeratePhrasalCandidates,validPhrasalCandidates,validateRequest,validateNoteDraft,senseDefinition} from '../packages/contracts/src/index.ts';
import type {LookupPayload,LookupData,NoteDraftV3,Operation,RpcResponse,RpcData} from '../packages/contracts/src/index.ts';
import {OpenAIService,validateLookupInput,validateLookupResult,resolvedLookupInput,validateModelLookup} from '../packages/services/src/openai.ts';
import {LookupCoordinator,lookupCacheKey} from '../packages/services/src/lookup.ts';
import {lookupModelSchema,LOOKUP_SYSTEM_PROMPT,PROMPT_VERSION,MODEL_SCHEMA_VERSION} from '../packages/services/src/prompts.ts';
import {createReaderServices,SecretVault} from '../packages/services/src/index.ts';
import type {SecretStorageArea} from '../packages/services/src/secrets.ts';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import {renderPreview} from '../packages/note-templates/src/index.ts';
import {TTS_ENDPOINT} from '../packages/services/src/audio.ts';

function hover(sentence:string,token:string,last=false):LookupPayload {
 const targetStart=last?sentence.lastIndexOf(token):sentence.indexOf(token),context={sentence,targetStart,targetEnd:targetStart+token.length};
 const phrasalCandidates=enumeratePhrasalCandidates(context);
 return {expression:token,context,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US',...(phrasalCandidates.length?{phrasalCandidates}:{})};
}
const cloudy=hover('The sky clouded over suddenly.','clouded');
const output=(input:LookupPayload,id:string|null=input.phrasalCandidates?.[0]?.id??null)=>({
 lemma:id?input.phrasalCandidates!.find(candidate=>candidate.id===id)!.lemma:input.expression,
 partOfSpeech:id?'phrasal verb':'verb',recommendedSenseId:'context',contextAmbiguous:false,
 senses:[{id:'context',translations:['затянуться облаками'],definition:'To become covered with clouds.'}],ipaCandidate:null,sentenceTranslation:'Небо затянулось облаками.',extraExample:null,
 ...(input.phrasalCandidates?{selectedCandidateId:id}:{}),
});
const provider=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

for(const [sentence,token,surface,lemma] of [
 ['The sky will cloud over.','cloud','cloud over','cloud over'],
 ['The sky clouds over.','clouds','clouds over','cloud over'],
 ['The sky clouded over.','clouded','clouded over','cloud over'],
 ['The sky is clouding over.','over','clouding over','cloud over'],
 ['Hours go by.','go','go by','go by'],
 ['Time goes by.','goes','goes by','go by'],
 ['Time is going by.','going','going by','go by'],
 ['Two days went by.','went','went by','go by'],
 ['Three days have gone by.','by','gone by','go by'],
 ['I cannot put up with it.','up','put up with','put up with'],
])test(`local candidate preserves ${surface} while exposing lemma ${lemma}`,()=>{
 const request=hover(sentence,token),candidate=request.phrasalCandidates!.find(item=>item.expression===surface)!;
 assert.ok(candidate);assert.equal(candidate.lemma,lemma);assert.equal(sentence.slice(candidate.targetStart,candidate.targetEnd),surface);
 assert.ok(validPhrasalCandidates(request.phrasalCandidates,request.context,'en'));validateLookupInput(request);
 validateRequest({v:1,requestId:crypto.randomUUID(),type:'lookup',payload:request});
});

test('repeated text, astral symbols, accents and nonbreaking whitespace keep original UTF-16 range',()=>{
 const request=hover('🌤️ Café: clouds over here, but the sky clouds\u00a0over there.','clouds',true);
 const candidate=request.phrasalCandidates![0]!;
 assert.equal(candidate.expression,'clouds\u00a0over');assert.equal(candidate.targetStart,request.context.sentence.lastIndexOf('clouds'));
 assert.equal(candidate.targetEnd,candidate.targetStart+'clouds\u00a0over'.length);
 assert.equal(enumeratePhrasalCandidates({...request.context,targetStart:1,targetEnd:2}).length,0);
 assert.equal(enumeratePhrasalCandidates({...request.context,targetEnd:request.context.targetEnd-1}).length,0);
});

for(const [sentence,token] of [
 ['There is a cloud over the city.','cloud'],['A dark cloud over the city looks ominous.','cloud'],
 ['I go by bus.','go'],['She went by train.','went'],['We have gone by the car.','gone'],
 ['Please turn it off.','turn'],['Please turn it off.','off'],['They turned, off in the distance.','turned'],
])test(`literal/discontinuous negative has no candidate: ${sentence}`,()=>assert.equal(hover(sentence,token).phrasalCandidates,undefined));

test('canonical request validation rejects altered ranges, IDs, lemmas, extra fields and non-English candidates before calling provider',async()=>{
 let calls=0;const service=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return provider(output(cloudy));}});
 for(const patch of [{id:'invented'},{lemma:'take over'},{expression:'cloud over'},{targetStart:0},{targetEnd:999},{sourceUrl:'https://invalid.test'}]){
  const request={...cloudy,phrasalCandidates:[{...cloudy.phrasalCandidates![0],...patch}]};
  assert.throws(()=>validateRequest({v:1,requestId:crypto.randomUUID(),type:'lookup',payload:request}));
  await assert.rejects(service.lookup(request as LookupPayload),{code:'INVALID_INPUT'});
 }
 await assert.rejects(service.lookup({...cloudy,sourceLanguage:'fr',dialect:'fr-FR'}),{code:'INVALID_INPUT'});
 await assert.rejects(service.lookup({...cloudy,phrasalCandidates:[]}),{code:'INVALID_INPUT'});
 assert.equal(calls,0);
});

test('the initial strict lookup chooses candidate ID in one request; no detection/repair call or source rewrite',async()=>{
 const calls:any[]=[];
 const service=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async(_url,init)=>{calls.push(JSON.parse(String(init!.body)));return provider(output(cloudy));}});
 const result=await service.lookup(cloudy),chosen=cloudy.phrasalCandidates![0]!;
 assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].input[0].content[0].text),cloudy);
 assert.equal(calls[0].text.format.strict,true);assert.deepEqual(calls[0].text.format.schema,lookupModelSchema(cloudy));
 assert.equal(result.data.expression,'clouded over');assert.equal(result.data.lemma,'cloud over');
 assert.deepEqual(result.data.resolvedTarget,{candidateId:chosen.id,targetStart:chosen.targetStart,targetEnd:chosen.targetEnd});
 assert.ok(!Object.hasOwn(result.data,'selectedCandidateId'));
 assert.equal(resolvedLookupInput(cloudy,result.data).context.sentence,cloudy.context.sentence);
 assert.equal(resolvedLookupInput(cloudy,result.data).phrasalCandidates,undefined);
});

test('manual word and phrase selections remain exact and cannot be expanded by provider output',async()=>{
 const {phrasalCandidates,...manual}=cloudy;
 let calls=0;
 const service=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return provider({...output(manual),lemma:'cloud'});}});
 const result=await service.lookup(manual);assert.equal(result.data.expression,'clouded');assert.equal(result.data.resolvedTarget,undefined);
 assert.throws(()=>validateModelLookup({...output(manual),selectedCandidateId:phrasalCandidates![0]!.id},manual),{code:'INVALID_MODEL_OUTPUT'});
 const phrase:LookupPayload={...manual,expression:'clouded over',context:{...manual.context,targetEnd:manual.context.targetStart+'clouded over'.length}};
 validateLookupInput(phrase);assert.equal(lookupModelSchema(phrase).properties.hasOwnProperty('selectedCandidateId'),false);assert.equal(calls,1);
});

test('candidate uncertainty retains hovered token; forged/noncanonical model IDs, surface and offsets are rejected without retry',async()=>{
 let calls=0;
 const fallback=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return provider({...output(cloudy,null),lemma:'cloud'});}});
 const result=await fallback.lookup(cloudy);assert.equal(result.data.expression,'clouded');assert.deepEqual(result.data.resolvedTarget,{candidateId:null,targetStart:cloudy.context.targetStart,targetEnd:cloudy.context.targetEnd});
 for(const change of [{selectedCandidateId:'bad'},{selectedCandidateId:cloudy.phrasalCandidates![0]!.id,lemma:'go by'},{selectedCandidateId:null,lemma:'cloud over'},{targetStart:0},{expression:'cloud over'}]){
  const service=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return provider({...output(cloudy),...change});}});
  await assert.rejects(service.lookup(cloudy),{code:'INVALID_MODEL_OUTPUT'});
 }
 assert.equal(calls,6);
 assert.throws(()=>validateLookupResult({...result.data,expression:'clouded over'},cloudy));
 assert.throws(()=>validateLookupResult({...result.data,resolvedTarget:{...result.data.resolvedTarget,targetStart:0}},cloudy));
});

test('cache separates manual and hovered requests and revalidates chosen surface, range and candidate identity',async()=>{
 let calls=0;const client=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return provider(output(cloudy));}});
 const store=new Map<string,any>();const cache={get:async(key:string)=>store.get(key),set:async(key:string,value:any)=>{store.set(key,structuredClone(value));}};
 const first=await new LookupCoordinator(client,cache).lookup(cloudy,{requestId:crypto.randomUUID()});
 const second=await new LookupCoordinator(client,cache).lookup(cloudy,{requestId:crypto.randomUUID()});
 assert.equal(second.cacheHit,true);assert.equal(second.data.expression,'clouded over');assert.equal(calls,1);
 const {phrasalCandidates,...manual}=cloudy;assert.notEqual(lookupCacheKey(manual,'gpt-6-luna'),lookupCacheKey(cloudy,'gpt-6-luna'));
 const cached=[...store.values()][0];cached.data.resolvedTarget.targetStart++;
 const repaired=await new LookupCoordinator(client,cache).lookup(cloudy,{requestId:crypto.randomUUID()});assert.equal(repaired.cacheHit,false);assert.equal(calls,2);
 assert.deepEqual(repaired.data.resolvedTarget,first.data.resolvedTarget);
});

function area():SecretStorageArea{const data:Record<string,unknown>={};return{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,data[key]])),set:async value=>{Object.assign(data,value);},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete data[key];},setAccessLevel:async()=>{}};}
function ok<T extends Operation>(response:RpcResponse):RpcData[T]{assert.equal(response.ok,true,JSON.stringify(response));if(!response.ok)throw Error('Expected success');return response.data as RpcData[T];}
const extensionId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',page={id:extensionId,url:`chrome-extension://${extensionId}/settings.html`,frameId:0};
function draftFor(data:LookupData):NoteDraftV3{
 const senses=data.senses.map(sense=>({id:sense.id,translations:[...sense.translations],definition:senseDefinition(sense)}));
 return {draftVersion:3,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',mode:'cloze',deckName:'Test',tags:[],expression:data.expression,lemma:data.lemma,partOfSpeech:data.partOfSpeech,selectedSense:senses[0]!,senses,context:{sentence:cloudy.context.sentence,targetStart:data.resolvedTarget!.targetStart,targetEnd:data.resolvedTarget!.targetEnd},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},examples:[],source:{kind:'html',title:'Offline fixture',url:'https://reader.example',documentId:null,page:null,chapter:null,cfi:null}};
}

test('persisted cache reopen binds refinement, enrichment, local/cloud audio and Anki cloze to the chosen expression',async()=>{
 const indexedDB=new IDBFactory(),calls:{url:string;body:any}[]=[],spoken:string[]=[];
 const secrets=new SecretVault({session:area(),local:area()});await secrets.setOpenAIKey('synthetic-only');
 const fetcher:typeof fetch=async(url,init)=>{
  const body=JSON.parse(String(init?.body));calls.push({url:String(url),body});
  if(String(url)===TTS_ENDPOINT)return new Response(new Uint8Array([0x49,0x44,0x33,4,0,0,0,0,0,0,1]),{headers:{'content-type':'audio/mpeg'}});
  assert.equal(String(url),'https://api.openai.com/v1/responses','Offline adapter must never contact Anki or another provider');
  const request=JSON.parse(body.input[0].content[0].text);
  if(body.text.format.name==='language_reader_examples_v2')return provider({examples:[{text:'The sky clouded over.',translation:'Небо затянулось облаками.',source:'ai'}]});
  return provider({...output(request),lemma:'cloud over'});
 };
 const start=async()=>{const storage=await openReaderStorage({indexedDB});const app=createReaderServices({storage,secrets,fetch:fetcher,runtime:{extensionId,allowedPageUrls:[page.url],isRegisteredReader:()=>true},confirmations:{requireConsent:async()=>true},playback:{listVoices:async()=>[{voiceURI:'local',lang:'en-US',localService:true,name:'Local'}],speakLocal:async input=>{spoken.push(input.text);},playMp3:async()=>{}}});return{app,storage,send:(type:Operation,payload:unknown={})=>app.handleMessage({v:1,requestId:crypto.randomUUID(),type,payload},page)};};
 const original=await start(),first=ok<'lookup'>(await original.send('lookup',cloudy));original.app.close();
 const reopened=await start();try{
  const cached=await reopened.send('lookup',cloudy),data=ok<'lookup'>(cached);assert.equal(data.lookupId,first.lookupId);assert.equal(data.expression,'clouded over');assert.equal(calls.length,1);if(cached.ok)assert.equal(cached.meta?.cacheHit,true);
  const draft=draftFor(data);validateNoteDraft(draft);assert.match(renderPreview(draft).back,/clouded over/);assert.match(renderPreview(draft).front,/The sky <span class="cloze">\[…\]<\/span> suddenly/);assert.equal(draft.context.sentence.slice(draft.context.targetStart,draft.context.targetEnd),'clouded over');
  ok(await reopened.send('audio.play',{lookupId:data.lookupId}));assert.deepEqual(spoken,['clouded over']);assert.equal(calls.length,1);
  ok(await reopened.send('card.enrich',{lookupId:data.lookupId,senseId:'context'}));const enriched=JSON.parse(calls[1]!.body.input[0].content[0].text);assert.equal(enriched.expression,'clouded over');assert.equal(enriched.phrasalCandidates,undefined);assert.deepEqual(enriched.context,draft.context);
  const refined=ok<'lookup.refine'>(await reopened.send('lookup.refine',{lookupId:data.lookupId}));assert.equal(refined.expression,'clouded over');assert.equal(refined.resolvedTarget,undefined);const refining=JSON.parse(calls[2]!.body.input[0].content[0].text);assert.equal(refining.expression,'clouded over');assert.deepEqual(refining.context,draft.context);assert.equal(refining.phrasalCandidates,undefined);
  ok(await reopened.send('settings.update',{patch:{cloudAudioEnabled:true}}));
  const invalid=await reopened.send('audio.prepare',{lookupId:data.lookupId,senseId:'context',draft:{...draft,context:cloudy.context}});assert.equal(invalid.ok,false);assert.equal(calls.length,3);
  const audio=ok<'audio.prepare'>(await reopened.send('audio.prepare',{lookupId:data.lookupId,senseId:'context',draft}));assert.equal(audio.text,'clouded over');assert.equal(calls.length,4);assert.equal(calls[3]!.body.input,'clouded over');
 }finally{reopened.app.close();}
});

test('every source-language definition is checked, including secondary senses; clear English/Cyrillic mismatches fail once',async()=>{
 const input:LookupPayload={expression:'casa',context:{sentence:'La casa es grande.',targetStart:3,targetEnd:7},sourceLanguage:'es',targetLanguage:'ru',learnerLevel:'A2',dialect:'es-ES'};
 const good={lemma:'casa',partOfSpeech:'sustantivo',recommendedSenseId:'home',contextAmbiguous:false,senses:[{id:'home',translations:['дом'],definition:'Un lugar para vivir.'},{id:'family',translations:['семья'],definition:'Un grupo familiar.'}],ipaCandidate:null,sentenceTranslation:'Небо затянулось облаками.',extraExample:null};
 validateModelLookup(good,input);
 let calls=0;
 for(const definition of ['To live in a building.','A place to live.','Something that people use.','Дом для проживания.']){
  const client=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return provider({...good,senses:[good.senses[0],{...good.senses[1],definition}]});}});
  await assert.rejects(client.lookup(input),{code:'INVALID_MODEL_OUTPUT'});
 }
 assert.equal(calls,4);assert.match(LOOKUP_SYSTEM_PROMPT,/EVERY sense/);assert.match(LOOKUP_SYSTEM_PROMPT,/MUST be written in sourceLanguage/);
 assert.equal(PROMPT_VERSION,'language-reader-lookup-v9-english-usage');assert.equal(MODEL_SCHEMA_VERSION,'language-reader-model-v8');
 assert.throws(()=>validateModelLookup({...good,senses:[{...good.senses[0],translations:['house']}]},input),{code:'INVALID_MODEL_OUTPUT'});
});
