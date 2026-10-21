import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenAIService,LOOKUP_MODEL} from '../packages/services/src/openai.ts';
import {lookupCacheKey} from '../packages/services/src/lookup.ts';
import {LOOKUP_SYSTEM_PROMPT,ENRICH_SYSTEM_PROMPT,PROMPT_VERSION,ENRICH_PROMPT_VERSION,MODEL_SCHEMA_VERSION} from '../packages/services/src/prompts.ts';
import type {LookupPayload} from '../packages/contracts/src/index.ts';

const inflected:LookupPayload={expression:'went',context:{sentence:'She went home.',targetStart:4,targetEnd:8},sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-GB'};
const pastSense={id:'go',translations:['пойти'],definition:'To move to another place.'};
function response(output:unknown){return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(output)}]}]});}

test('every enrichment example must include studied vocabulary or its own natural inflected form, not only a synonym',()=>{
 assert.match(ENRICH_SYSTEM_PROMPT,/Every source-language example must contain the studied expression or a natural inflected form of that same vocabulary item in the selected sense\./);
 assert.match(ENRICH_SYSTEM_PROMPT,/A synonym or a sentence merely related to the meaning is not a substitute/);
});

test('lookup IPA belongs to the selected contextual surface form, never a substituted lemma; uncertainty returns null',()=>{
 assert.match(LOOKUP_SYSTEM_PROMPT,/selected SURFACE expression exactly as it occurs in context, including its inflection/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/Never substitute the dictionary lemma's pronunciation for the selected surface expression/);
 assert.match(LOOKUP_SYSTEM_PROMPT,/If the surface-form pronunciation is uncertain, including contextually unresolved heteronyms, return null/);
});

test('lookup and enrichment preserve Japanese/Korean omitted subjects rather than inventing Russian person, gender or number',()=>{
 for(const prompt of [LOOKUP_SYSTEM_PROMPT,ENRICH_SYSTEM_PROMPT]){
  assert.match(prompt,/Japanese and Korean often omit a subject/);
  assert.match(prompt,/Do not infer a person's identity or grammatical person, gender or number unless the supplied context establishes it/);
  assert.match(prompt,/Russian/);
  assert.match(prompt,/natural neutral form or clearly marked alternatives rather than inventing a specific person, gender or number/);
 }
 assert.match(ENRICH_SYSTEM_PROMPT,/For each example's translation, preserve any subject ambiguity left by its source text and the supplied context/);
});

test('broader common meanings invalidate previous lookup cache while keeping model defaults unchanged',()=>{
 assert.equal(PROMPT_VERSION,'language-reader-lookup-v4');assert.equal(ENRICH_PROMPT_VERSION,'language-reader-enrich-v3');
 assert.equal(MODEL_SCHEMA_VERSION,'language-reader-model-v3');assert.equal(LOOKUP_MODEL,'gpt-4.1-mini');
 const key=lookupCacheKey(inflected,LOOKUP_MODEL),parts=JSON.parse(key);
 assert.equal(parts[0],PROMPT_VERSION);assert.equal(parts[1],MODEL_SCHEMA_VERSION);
 parts[0]='language-reader-lookup-v3';parts[1]='language-reader-model-v2';assert.notEqual(key,JSON.stringify(parts));
});

test('mocked lookup/enrichment wire requests retain an inflected surface expression separately from its lemma',async()=>{
 const bodies:any[]=[];
 const client=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));bodies.push(body);
  return response(bodies.length===1?{lemma:'go',partOfSpeech:'verb',recommendedSenseId:'go',contextAmbiguous:false,senses:[pastSense],ipaCandidate:{ipa:'/wɛnt/',dialect:'en-GB'},extraExample:null}:{examples:[{text:'They went home.',translation:'Они пошли домой.',source:'ai'}]});
 }});
 const lookup=await client.lookup(inflected);assert.equal(lookup.data.expression,'went');assert.equal(lookup.data.lemma,'go');
 assert.equal(lookup.data.ipaCandidate?.ipa,'/wɛnt/');
 await client.enrich({...inflected,selectedSense:pastSense});
 assert.deepEqual(bodies.map(body=>JSON.parse(body.input[0].content[0].text).expression),['went','went']);
 assert.equal(bodies[0].instructions,LOOKUP_SYSTEM_PROMPT);assert.equal(bodies[1].instructions,ENRICH_SYSTEM_PROMPT);
 assert.ok(bodies.every(body=>body.model==='gpt-4.1-mini'&&body.store===false&&body.tools===undefined));
});

for(const fixture of [
 {sourceLanguage:'ja',dialect:'ja-JP',expression:'行った',sentence:'昨日、行った。',start:3,definition:'ある場所へ移動する。'},
 {sourceLanguage:'ko',dialect:'ko-KR',expression:'갔어요',sentence:'어제 갔어요.',start:3,definition:'어떤 곳으로 이동하다.'},
] as const)test(`${fixture.sourceLanguage} omitted-subject fixture reaches enrichment unchanged with faithful marked Russian alternatives`,async()=>{
 const input:LookupPayload={expression:fixture.expression,context:{sentence:fixture.sentence,targetStart:fixture.start,targetEnd:fixture.start+fixture.expression.length},sourceLanguage:fixture.sourceLanguage,targetLanguage:'ru',learnerLevel:'B1',dialect:fixture.dialect};
 const selectedSense={id:'go',translations:['пойти'],definition:fixture.definition};let sent:any;
 const examples=[{text:fixture.sentence,translation:'Вчера пошёл / пошла / пошли.',source:'ai' as const}];
 const client=new OpenAIService({getApiKey:()=> 'synthetic-only',fetch:async(_url,init)=>{sent=JSON.parse(String(init?.body));return response({examples});}});
 const result=await client.enrich({...input,selectedSense});
 assert.deepEqual(JSON.parse(sent.input[0].content[0].text),{...input,selectedSense});assert.equal(sent.instructions,ENRICH_SYSTEM_PROMPT);assert.deepEqual(result.data,examples);
});
