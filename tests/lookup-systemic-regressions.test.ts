import test from 'node:test';
import assert from 'node:assert/strict';
import {enumeratePhrasalCandidates} from '../packages/contracts/src/index.ts';
import type {LookupPayload, LookupDiagnostics} from '../packages/contracts/src/index.ts';
import {OpenAIService, OpenAIServiceError, validateLookupResult, validateModelLookup} from '../packages/services/src/openai.ts';
import {ServiceError, safeError} from '../packages/services/src/errors.ts';
import {LOOKUP_SYSTEM_PROMPT, lookupModelSchema} from '../packages/services/src/prompts.ts';

// These are deterministic synthetic regression fixtures, NOT recovered responses
// from the three user screenshots. No real API key or network is used.
function request(expression:string,sentence:string,sourceLanguage:'en'|'ru'='en'):LookupPayload {
  const targetStart=sentence.indexOf(expression);
  return {expression,context:{sentence,targetStart,targetEnd:targetStart+expression.length},sourceLanguage,targetLanguage:'ru',learnerLevel:'B1',dialect:sourceLanguage==='en'?'en-GB':'ru-RU'};
}
const seemed=request('seemed','There was some laughing and clapping: the audience seemed to think that Ted had');
const fireside=request('fireside-tales','But I can hear fireside-tales and children’s stories at home, if I want to.');
const zip=request('ZIP','Первый ZIP — расширение, второй — исходники с коммитами, третий — инструкция и отчёт.');
function output(lemma='seem',definition='To appear to be true.',translations=['казаться']) {
  return {lemma,partOfSpeech:'verb',senses:[{id:'appearance',translations,definition}],contextAmbiguous:false,recommendedSenseId:'appearance',ipaCandidate:null as null|{ipa:string;dialect:string},sentenceTranslation:'Это казалось верным.',extraExample:null};
}
function envelope(value:unknown=output()):any {
  return {id:'resp_synthetic_fixture',model:'gpt-6-luna',status:'completed',usage:{input_tokens:31,output_tokens:47,total_tokens:78},
    output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]};
}
function harness(make:()=>Response) {
  const requests:any[]=[];
  const service=new OpenAIService({getApiKey:()=> 'synthetic-secret-not-an-api-key',fetch:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return make();}});
  return {service,requests};
}
function diagnosis(stage:LookupDiagnostics['stage'],reason:LookupDiagnostics['reason'],code='INVALID_MODEL_OUTPUT') {
  return (error:unknown)=>{
    assert.ok(error instanceof OpenAIServiceError);
    assert.equal(error.code,code);
    assert.deepEqual(error.diagnostics,{stage,reason});
    assert.deepEqual(safeError(error).diagnostics,{stage,reason});
    return true;
  };
}

test('strict generation order resolves candidates and senses before dependent fields, with unchanged required keys',()=>{
  const context={sentence:'The sky Clouded\u00a0over.',targetStart:8,targetEnd:15};
  const input={...request('Clouded',context.sentence),context,phrasalCandidates:enumeratePhrasalCandidates(context)};
  for(const value of [seemed,input]){
    const schema=lookupModelSchema(value),keys=Object.keys(schema.properties);
    assert.ok(keys.indexOf('senses')<keys.indexOf('recommendedSenseId'));
    assert.ok(keys.indexOf('contextAmbiguous')<keys.indexOf('recommendedSenseId'));
    assert.deepEqual([...schema.required].sort(),[...keys].sort());
    if(value.phrasalCandidates)assert.equal(keys[0],'selectedCandidateId');
  }
  assert.match(LOOKUP_SYSTEM_PROMPT,/Hyphenated compounds/);
  assert.match(LOOKUP_SYSTEM_PROMPT,/sentence fragment/);
  assert.match(LOOKUP_SYSTEM_PROMPT,/only alongside a concise explanatory equivalent/);
});

for(const variant of [
  {input:seemed,value:output()},
  {input:seemed,value:{...output(),contextAmbiguous:true,recommendedSenseId:null}},
  {input:seemed,value:{...output(),ipaCandidate:{ipa:'/siːmd/',dialect:'en-GB'}}},
  {input:fireside,value:{...output('fireside tale','A story told while sitting by a fire.',['рассказ у камина']),partOfSpeech:'noun'}},
  {input:fireside,value:{...output('fireside-tale','A story told while sitting by a fire.',['рассказ у камина']),partOfSpeech:'noun',ipaCandidate:{ipa:'/ˈfaɪəsaɪd teɪlz/',dialect:'en-GB'}}},
  {input:zip,value:{...output('ZIP','A compressed archive file format.',['ZIP','ZIP-архив']),partOfSpeech:'abbreviation'}},
  {input:{...zip,sourceLanguage:'ru' as const,dialect:'ru-RU' as const},value:{...output('ZIP','Формат сжатого файлового архива.',['ZIP','сжатый архив']),partOfSpeech:'аббревиатура'}},
])test(`${variant.input.expression}: valid literal surface/lemma/IPA survives once (${JSON.stringify(variant.value.ipaCandidate)}, ambiguous=${variant.value.contextAmbiguous})`,async()=>{
  const before=structuredClone(variant.input),modelBefore=structuredClone(variant.value);
  const {service,requests}=harness(()=>Response.json(envelope(variant.value)));
  const result=await service.lookup(variant.input);
  assert.equal(requests.length,1);
  assert.equal(result.data.expression,variant.input.expression);
  assert.equal(result.data.lemma,variant.value.lemma);
  assert.deepEqual(result.data.ipaCandidate,variant.value.ipaCandidate);
  assert.deepEqual(result.data.senses,variant.value.senses);
  assert.deepEqual(variant.input,before);
  assert.deepEqual(variant.value,modelBefore);
  assert.deepEqual(JSON.parse(requests[0].input[0].content[0].text),before);
  assert.equal(variant.input.context.sentence.slice(variant.input.context.targetStart,variant.input.context.targetEnd),result.data.expression);
  assert.doesNotThrow(()=>validateLookupResult(result.data,variant.input));
});

for(const [expression,lemma] of [['fireside‐tales','fireside tale'],['fireside‑tales','fireside-tale'],['Fireside-tales','fireside tale'],['seemed','seem'],["reader's",'reader'],['reader’s','reader']] as const){
  test(`punctuation, case and repeated Unicode-prefixed source do not alter offsets: ${expression}`,async()=>{
    const input=request(expression,`📚 ‘${expression}’, he said, then ${expression}.`);
    input.context.targetStart=input.context.sentence.lastIndexOf(expression);input.context.targetEnd=input.context.targetStart+expression.length;
    const value=output(lemma,'A valid contextual meaning.',['контекстное значение']);
    const {service,requests}=harness(()=>Response.json(envelope(value)));
    const result=await service.lookup(input);
    assert.equal(result.data.expression,expression);assert.equal(result.data.lemma,lemma);assert.equal(requests.length,1);
    assert.deepEqual(JSON.parse(requests[0].input[0].content[0].text).context,input.context);
  });
}

test('only known selected candidate lemma case/space is canonicalized, without changing its original surface',async()=>{
  const input=request('Clouded','The sky Clouded\u00a0over.');
  input.phrasalCandidates=enumeratePhrasalCandidates(input.context);
  const candidate=input.phrasalCandidates[0]!;
  for(const lemma of ['cloud over','Cloud Over',' CLOUD\u00a0\u00a0OVER ','cloud\tover']){
    const value={...output(lemma,'To become covered in clouds.',['затянуться облаками']),selectedCandidateId:candidate.id};
    const {service,requests}=harness(()=>Response.json(envelope(value)));
    const result=await service.lookup(input);
    assert.equal(result.data.lemma,candidate.lemma);assert.equal(value.lemma,lemma);assert.equal(result.data.expression,'Clouded\u00a0over');assert.equal(requests.length,1);
    assert.deepEqual(result.data.resolvedTarget,{candidateId:candidate.id,targetStart:candidate.targetStart,targetEnd:candidate.targetEnd});
  }
  for(const lemma of ['clouded over','cloud under','to cloud over','cloud\nover','cloud-over','\ncloud over','cloud over\n','\rcloud over\r']){
    assert.throws(()=>validateModelLookup({...output(lemma),selectedCandidateId:candidate.id},input),diagnosis('validation','candidate_binding'));
  }
});

test('unchanged acronym exception is bounded: no bare acronym, unrelated code, case change or untranslated ordinary word',()=>{
  for(const translations of [['ZIP'],['PDF','архив'],['zip','архив'],['ZIP archive','архив'],['ZIP','archive']]){
    assert.throws(()=>validateModelLookup(output('ZIP','An archive format.',translations),zip),diagnosis('validation','translation_language'));
  }
  for(const input of [seemed,fireside]){
    assert.throws(()=>validateModelLookup(output(input.expression,'A contextual meaning.',[input.expression,'значение']),input),diagnosis('validation','translation_language'));
  }
});

test('a single completed JSON object can span ordered text content parts, retaining reasoning privacy',async()=>{
  const value=output(),json=JSON.stringify(value),body=envelope(value);
  body.output.unshift({type:'reasoning',summary:[],encrypted_content:'PRIVATE-REASONING'});
  body.output[1].content=[json.slice(0,19),json.slice(19,74),json.slice(74)].map(text=>({type:'output_text',text,annotations:[]}));
  const {service,requests}=harness(()=>Response.json(body));
  const result=await service.lookup(seemed);
  assert.equal(result.data.lemma,'seem');assert.equal(requests.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE-REASONING/);
});

for(const [label,body,reason] of [
  ['two separate answers',(()=>{const x=envelope();x.output.push(structuredClone(x.output[0]));return x;})(),'output_multiple'],
  ['two JSON objects in one content array',(()=>{const x=envelope();x.output[0].content.push(structuredClone(x.output[0].content[0]));return x;})(),'output_json'],
  ['malformed concatenated JSON',(()=>{const x=envelope();x.output[0].content=[{type:'output_text',text:'{"lemma":'},{type:'output_text',text:'INVALID'}];return x;})(),'output_json'],
  ['missing output text',{status:'completed',output:[]},'output_missing'],
] as const)test(`${label} still fails once, never repairing or choosing an answer`,async()=>{
  const {service,requests}=harness(()=>Response.json(body));
  await assert.rejects(service.lookup(seemed),diagnosis('output',reason));assert.equal(requests.length,1);
});

for(const [error,reason] of [
  [{code:'invalid_json_schema',param:'text.format.schema'},'request_schema'],
  [{code:'invalid_request_error',param:'text.format'},'request_schema'],
  [{code:'unsupported_parameter',param:'reasoning.effort'},'request_parameter'],
  [{code:'invalid_value',param:'max_output_tokens'},'request_parameter'],
  [{code:'invalid_request_error',param:'model'},'request_model'],
  [{code:'PRIVATE-CODE',param:'PRIVATE-FIELD'},'request_rejected'],
] as const)test(`HTTP 400 is request/${reason}, not invalid generated JSON`,async()=>{
  const body={error:{...error,message:'PRIVATE-KEY PRIVATE-SENTENCE PRIVATE-PROVIDER-BODY'}};
  const {service,requests}=harness(()=>Response.json(body,{status:400}));
  await assert.rejects(service.lookup(seemed),(failure:unknown)=>{
    diagnosis('request',reason,'OPENAI_REQUEST_REJECTED')(failure);
    assert.ok(failure instanceof OpenAIServiceError);assert.equal(failure.retryable,false);assert.equal(failure.usage,null);
    assert.doesNotMatch(JSON.stringify(failure),/PRIVATE|synthetic-secret|seemed|audience/);return true;
  });assert.equal(requests.length,1);
});

test('non-JSON HTTP400 and successful HTTP200 malformed JSON remain distinct safe categories',async()=>{
  for(const status of [400,422]){
    const {service,requests}=harness(()=>new Response('<html>PRIVATE GATEWAY</html>',{status}));
    await assert.rejects(service.lookup(seemed),diagnosis('request','request_rejected','OPENAI_REQUEST_REJECTED'));assert.equal(requests.length,1);
  }
  const {service,requests}=harness(()=>new Response('{"PRIVATE":'));
  await assert.rejects(service.lookup(seemed),diagnosis('response','response_json'));assert.equal(requests.length,1);
});

for(const [body,stage,reason,code] of [
  [null,'response','response_shape','INVALID_MODEL_OUTPUT'],
  [{status:'queued',output:[]},'response','response_status','INVALID_MODEL_OUTPUT'],
  [{status:'completed'},'response','response_shape','INVALID_MODEL_OUTPUT'],
  [{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},'output','output_incomplete','MODEL_INCOMPLETE'],
  [{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'PRIVATE'}]}]},'output','output_refusal','MODEL_REFUSAL'],
] as const)test(`provider envelope reports ${stage}/${reason}`,async()=>{
  const {service,requests}=harness(()=>Response.json(body));
  await assert.rejects(service.lookup(seemed),diagnosis(stage,reason,code));assert.equal(requests.length,1);
});

const base=output();
for(const [patch,reason] of [
  [{source:'dictionary'},'lookup_shape'],
  [{senses:[{...base.senses[0],definitionEn:'Wrong legacy field'}]},'sense_shape'],
  [{senses:[{...base.senses[0],id:'sense:1'}]},'sense_id'],
  [{senses:[base.senses[0],base.senses[0]]},'sense_id'],
  [{senses:[{...base.senses[0],translations:[]}]},'sense_translations'],
  [{senses:[{...base.senses[0],translations:['казаться','казаться']}]},'sense_translations'],
  [{senses:[{...base.senses[0],definition:'<script>PRIVATE</script>'}]},'sense_definition'],
  [{senses:[{...base.senses[0],definition:'Казаться правдивым.'}]},'definition_script_cyrillic'],
  [{senses:[{...base.senses[0],translations:['appear']}]},'translation_language'],
  [{recommendedSenseId:'nonexistent'},'recommendation'],
  [{contextAmbiguous:true},'recommendation'],
  [{ipaCandidate:{ipa:'/siːmd/',dialect:'en-GB',source:'dictionary'}},'ipa_shape'],
  [{ipaCandidate:{ipa:'/siːmd/',dialect:'en-US'}},'ipa_dialect'],
] as const)test(`semantic and shape guard ${reason} retains a privacy-safe category and actual billed usage`,async()=>{
  const {service,requests}=harness(()=>Response.json(envelope({...base,...patch})));
  await assert.rejects(service.lookup(seemed),(error:unknown)=>{
    diagnosis('validation',reason)(error);assert.ok(error instanceof OpenAIServiceError);
    assert.deepEqual(error.usage,{inputTokens:31,outputTokens:47,totalTokens:78});
    assert.equal(error.responseId,'resp_synthetic_fixture');
    assert.doesNotMatch(JSON.stringify(error),/PRIVATE|synthetic-secret|resp_synthetic_fixture|audience|inputTokens/);
    return true;
  });assert.equal(requests.length,1);
});

test('result bindings reject changed source offsets and contract fields with separate categories',async()=>{
  const {service}=harness(()=>Response.json(envelope()));const result=await service.lookup(seemed);
  assert.throws(()=>validateLookupResult({...result.data,lookupId:'not-a-uuid'},seemed),diagnosis('validation','result_contract'));
  assert.throws(()=>validateLookupResult({...result.data,expression:'seem'},seemed),diagnosis('validation','result_binding'));
});

test('oversized Responses data and examples have bounded allowlisted reasons',async()=>{
  const {service,requests}=harness(()=>new Response('x'.repeat(128*1024+1)));
  await assert.rejects(service.lookup(seemed),diagnosis('response','response_too_large'));assert.equal(requests.length,1);
  const example=harness(()=>Response.json(envelope({examples:[]})));
  await assert.rejects(example.service.enrich({...seemed,selectedSense:base.senses[0]!}),diagnosis('validation','examples_shape'));assert.equal(example.requests.length,1);
});

test('error serializers omit injected fields, provider text and arbitrary diagnostics even after mutation',()=>{
  const good={stage:'validation',reason:'recommendation'} as const;
  const error=new ServiceError('INVALID_MODEL_OUTPUT','PRIVATE MESSAGE',false,good);
  assert.deepEqual(safeError(error).diagnostics,good);
  for(const value of [{...good,text:'PRIVATE'}, {stage:'validation',reason:'PRIVATE'}, {stage:'PRIVATE',reason:'lookup_shape'}]){
    Object.assign(error,{diagnostics:value});assert.equal(safeError(error).diagnostics,undefined);
    assert.doesNotMatch(JSON.stringify(error),/PRIVATE/);
  }
});
