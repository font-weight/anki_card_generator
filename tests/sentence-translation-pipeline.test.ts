import test from 'node:test';
import assert from 'node:assert/strict';
import {validateData,validateNoteDraft} from '../packages/contracts/src/index.ts';
import type {LookupPayload,NoteDraftV3} from '../packages/contracts/src/index.ts';
import {OpenAIService,validateModelLookup} from '../packages/services/src/openai.ts';
import {LOOKUP_MODEL_SCHEMA,LOOKUP_SYSTEM_PROMPT,lookupModelSchema} from '../packages/services/src/prompts.ts';
import {LookupCoordinator} from '../packages/services/src/lookup.ts';
const input:LookupPayload={expression:'put up with',context:{sentence:'I cannot put up with this noise, but I will stay.',targetStart:9,targetEnd:20},sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US'};
const translation='Я не могу мириться с этим шумом, но я останусь.';
const sense={id:'tolerate',translations:['терпеть'],definition:'To tolerate something unpleasant.'};
const output={lemma:'put up with',partOfSpeech:'verb',senses:[sense],recommendedSenseId:'tolerate',contextAmbiguous:false,ipaCandidate:null,extraExample:null,sentenceTranslation:translation};
const id='00000000-0000-4000-8000-000000000001';
function service(value:unknown){let calls=0;return {client:new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async()=>{calls++;return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]});}}),calls:()=>calls};}
test('strict provider schema requests full sentence translation in the existing lookup, not a second call',async()=>{
 assert.ok(LOOKUP_MODEL_SCHEMA.required.includes('sentenceTranslation'));
 assert.match(LOOKUP_SYSTEM_PROMPT,/ENTIRE supplied context.sentence/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/without completing it/);
 const h=service(output),result=await h.client.lookup(input);
 assert.equal(result.data.sentenceTranslation,translation);assert.equal(h.calls(),1);
 assert.deepEqual(input.context,{sentence:'I cannot put up with this noise, but I will stay.',targetStart:9,targetEnd:20});
});
test('live lookup rejects absent translation without retries while legacy validation remains readable',async()=>{
 const {sentenceTranslation:_,...old}=output;
 assert.doesNotThrow(()=>validateModelLookup(old,input));
 const h=service(old);await assert.rejects(h.client.lookup(input),{code:'INVALID_MODEL_OUTPUT'});assert.equal(h.calls(),1);
});
for(const invalid of ['', '  ', '<b>Перевод</b>', 'a'.repeat(6001), 'This is untranslated English.', null])test(`invalid supplied translation rejected: ${String(invalid).slice(0,25)}`,()=>{
 assert.throws(()=>validateModelLookup({...output,sentenceTranslation:invalid},input),{code:'INVALID_MODEL_OUTPUT'});
});
test('same-language faithful paraphrase and RTL target are accepted without generated alignment',()=>{
 assert.doesNotThrow(()=>validateModelLookup({...output,senses:[{...sense,translations:['tolerate']}],sentenceTranslation:'I cannot tolerate this noise, but I will remain.'},{...input,targetLanguage:'en'}));
 assert.doesNotThrow(()=>validateModelLookup({...output,senses:[{...sense,translations:['يتحمل']}],sentenceTranslation:'لا أستطيع تحمل هذه الضوضاء، لكنني سأبقى.'},{...input,targetLanguage:'ar'}));
});
test('v3 persisted draft and lookup preserve optional full translation; old v3 remains valid',()=>{
 const draft:NoteDraftV3={draftVersion:3,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',mode:'recognition',deckName:'Default',tags:[],expression:input.expression,lemma:output.lemma,partOfSpeech:'verb',senses:[sense],selectedSense:sense,context:input.context,pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},examples:[],source:{kind:'html',title:'Fixture',url:null,documentId:null,page:null,chapter:null,cfi:null}};
 assert.deepEqual(validateNoteDraft(draft),draft);
 assert.equal((validateNoteDraft({...draft,sentenceTranslation:translation}) as NoteDraftV3).sentenceTranslation,translation);
 assert.equal(validateData('lookup',{...output,lookupId:id,expression:input.expression}).sentenceTranslation,translation);
 for(const value of ['', 'x'.repeat(6001),null])assert.throws(()=>validateNoteDraft({...draft,sentenceTranslation:value}));
});
test('current-namespace cache missing translation is ignored, not served or silently fabricated',async()=>{
 const h=service(output),valid=await h.client.lookup(input);
 const cached=structuredClone(valid);delete cached.data.sentenceTranslation;
 const coordinator=new LookupCoordinator(h.client,{get:async()=>cached,set:async()=>{}});
 const result=await coordinator.lookup(input,{requestId:id});
 assert.equal(result.data.sentenceTranslation,translation);assert.equal(result.cacheHit,false);assert.equal(h.calls(),2);
});
test('usage estimates arrive with one English request and use a distinct cache namespace', async()=>{
 const englishUsage={level:'B2',register:'current',frequency:'common'};
 const h=service({...output,englishUsage}); const result=await h.client.lookup(input);
 assert.deepEqual(result.data.englishUsage,englishUsage); assert.equal(h.calls(),1);
 assert.deepEqual(validateData('lookup',result.data).englishUsage,englishUsage);
});
test('optional usage fails softly without losing the translation', async()=>{
 const h=service({...output,englishUsage:{level:'C3',register:'<script>',frequency:'rare',extra:'unexpected'}});
 assert.deepEqual((await h.client.lookup(input)).data.englishUsage,{level:null,register:null,frequency:'rare'});
 assert.equal(h.calls(),1);
 assert.equal(validateModelLookup({...output,englishUsage:[]},input).englishUsage,undefined);
 assert.equal(validateModelLookup({...output,englishUsage:{level:'B2'},recommendedSenseId:null,contextAmbiguous:true},input).englishUsage,undefined);
});

test('strict usage response schema is requested only for English source',()=>{
 assert.ok(lookupModelSchema(input).required.some(key=>key==='englishUsage'));
 const nonEnglish={...input,sourceLanguage:'fr',dialect:'fr-FR'} as const;
 const schema=lookupModelSchema(nonEnglish);
 assert.ok(!schema.required.some(key=>key==='englishUsage'));
 assert.ok(!('englishUsage' in schema.properties));
 assert.equal(validateModelLookup({...output,lemma:'aller',senses:[{...sense,definition:'Se déplacer.'}],englishUsage:{level:'A1'}},nonEnglish).englishUsage,undefined);
});
