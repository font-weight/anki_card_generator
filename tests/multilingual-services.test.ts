import test from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGES,LEARNER_LEVELS} from '../packages/contracts/src/index.ts';
import {validateLookupInput,validateModelLookup,validateExamples,validateEnrichInput,OpenAIService} from '../packages/services/src/openai.ts';
import {lookupCacheKey} from '../packages/services/src/lookup.ts';
import {examplePromptData,LOOKUP_MODEL_SCHEMA,LOOKUP_SYSTEM_PROMPT,ENRICH_SYSTEM_PROMPT,PROMPT_VERSION} from '../packages/services/src/prompts.ts';
import type {LookupPayload} from '../packages/contracts/src/index.ts';
const input:LookupPayload={expression:'casa',context:{sentence:'La casa es pequeña.',targetStart:3,targetEnd:7},sourceLanguage:'es',targetLanguage:'ru',learnerLevel:'A2',dialect:'es-ES'};
const sense={id:'home',translations:['дом'],definition:'Un lugar para vivir.'};
const output={lemma:'casa',partOfSpeech:'sustantivo',recommendedSenseId:'home',contextAmbiguous:false,senses:[sense],ipaCandidate:null,extraExample:null};
test('all 17 registry source locales and same-language requests validate',()=>{for(const language of LANGUAGES)assert.doesNotThrow(()=>validateLookupInput({...input,sourceLanguage:language.code,targetLanguage:language.code,dialect:language.locale}));});
test('locale mismatch and unknown language/CEFR are rejected',()=>{for(const patch of [{dialect:'en-US'},{sourceLanguage:'xx'},{targetLanguage:'xx'},{learnerLevel:'D1'}])assert.throws(()=>validateLookupInput({...input,...patch}));});
test('new provider schema is neutral and rejects legacy definition field',()=>{assert.deepEqual(validateModelLookup(output,input),output);assert.throws(()=>validateModelLookup({...output,senses:[{id:'home',translations:['дом'],definitionEn:'A home'}]},input));assert.ok(JSON.stringify(LOOKUP_MODEL_SCHEMA).includes('"definition"'));assert.ok(!JSON.stringify(LOOKUP_MODEL_SCHEMA).includes('definitionEn'));});
test('cache separates both languages, level, locale and v1 schema namespace',()=>{const key=lookupCacheKey(input,'gpt-6-luna');for(const patch of [{targetLanguage:'en' as const},{learnerLevel:'C2' as const},{sourceLanguage:'fr' as const,dialect:'fr-FR' as const}])assert.notEqual(key,lookupCacheKey({...input,...patch},'gpt-6-luna'));assert.equal(JSON.parse(key)[0],PROMPT_VERSION);assert.doesNotMatch(key,/english-reader-lookup-v1/);});
test('enrichment freezes original sentence, offsets, pair, CEFR and selected meaning; excludes metadata',()=>{const value={...input,selectedSense:sense};validateEnrichInput(value);const prompt=JSON.parse(examplePromptData({...value,secret:'never',sourceUrl:'https://private.invalid'} as any));assert.deepEqual(prompt,{...input,selectedSense:sense});assert.throws(()=>validateEnrichInput({expression:input.expression,selectedSense:sense,learnerLevel:'A2',dialect:'es-ES'}));});
test('examples require 1..3 complete distinct plain AI pairs, never legacy or injected output',()=>{const example={text:'Mi casa es pequeña.',translation:'Мой дом маленький.',source:'ai'};assert.deepEqual(validateExamples({examples:[example]}),[example]);for(const examples of [[],Array(4).fill(example),[example,example],[{...example,source:'dictionary'}],[{...example,translation:''}],[{...example,text:'<script>alert(1)</script>'}],[{...example,extra:'x'}]])assert.throws(()=>validateExamples({examples}));assert.throws(()=>validateExamples({textEn:'hello',textRu:'привет',source:'ai'}));});
test('nonEnglish provider request sends explicit context and no source metadata or tools', async () => {
  let body: any;
  const client = new OpenAIService({
    getApiKey: () => 'synthetic-only',
    fetch: async (_url, init) => {
      body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{
          type: 'message', role: 'assistant',
          content: [{type: 'output_text', text: JSON.stringify({examples: [
            {text: 'Mi casa.', translation: 'Мой дом.', source: 'ai'},
          ]})}],
        }],
      }));
    },
  });
  const result = await client.enrich({...input, selectedSense: sense});
  assert.equal(result.data.length, 1);
  assert.deepEqual(JSON.parse(body.input[0].content[0].text), {...input, selectedSense: sense});
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.text.format.strict, true);
});


test('all 289 directed language pairs and all six CEFR levels validate independently', () => {
  for (const source of LANGUAGES) for (const target of LANGUAGES) for (const learnerLevel of LEARNER_LEVELS) {
    assert.doesNotThrow(() => validateLookupInput({...input, sourceLanguage: source.code, targetLanguage: target.code, dialect: source.locale, learnerLevel}));
  }
});

test('generated content uses explicit simplified Mandarin and Modern Standard Arabic conventions', () => {
  for (const prompt of [LOOKUP_SYSTEM_PROMPT, ENRICH_SYSTEM_PROMPT]) {
    assert.match(prompt, /Standard Mandarin in simplified Chinese writing/);
    assert.match(prompt, /Modern Standard Arabic \(MSA\)/);
    assert.match(prompt, /not a regional dialect/);
  }
});

test('direct provider input rejects split combining-mark selections and untrimmed expression', () => {
  assert.throws(() => validateLookupInput({...input, expression: 'e', context: {sentence: 'e\u0301', targetStart: 0, targetEnd: 1}}), {code: 'INVALID_INPUT'});
  assert.doesNotThrow(() => validateLookupInput({...input, expression: 'e\u0301', context: {sentence: 'e\u0301', targetStart: 0, targetEnd: 2}}));
  assert.throws(() => validateLookupInput({...input, expression: ' casa ', context: {sentence: ' casa ', targetStart: 0, targetEnd: 6}}), {code: 'INVALID_INPUT'});
});
