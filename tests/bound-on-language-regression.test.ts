import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIService, validateModelLookup } from '../packages/services/src/openai.ts';
import { lookupModelSchema } from '../packages/services/src/prompts.ts';
import { LANGUAGES, defaultLocale, senseDefinition, type LookupPayload } from '../packages/contracts/src/index.ts';

// Reproduced from the visible screenshot, not a recovered provider response.
const sentence = '"Now each one of you," Dr. Osier said to those Yale students, "is a much more marvelous organization than the great liner, and bound on a longer voyage.';
const targetStart = sentence.indexOf('bound on');
const input: LookupPayload = { expression: 'bound on', context: { sentence, targetStart, targetEnd: targetStart + 8 },
  sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B2', dialect: 'en-US' };
const output = { lemma: 'bound on', partOfSpeech: 'adjective phrase', recommendedSenseId: 'heading', contextAmbiguous: false,
  senses: [{ id: 'heading', translations: ['направляющийся в'], definition: 'Going or intending to go on a journey.' }],
  sentenceTranslation: '«Каждый из вас, — сказал доктор Осиер тем студентам Йеля, — представляет собой гораздо более удивительный организм, чем большой лайнер, и отправляется в более долгое путешествие.',
  ipaCandidate: null, extraExample: null };

test('screenshot bound on: valid English definition is accepted without changing source span', () => {
  const before = structuredClone(input);
  const result = validateModelLookup(output, input);
  assert.equal(senseDefinition(result.senses[0]!), output.senses[0]!.definition);
  assert.deepEqual(input, before);
  assert.equal(input.context.sentence.slice(input.context.targetStart, input.context.targetEnd), 'bound on');
});

test('screenshot bound on: wrong-language primary or secondary definition remains rejected', () => {
  for (const senses of [
    [{ ...output.senses[0], definition: 'Направляющийся в путешествие.' }],
    [...output.senses, { id: 'other', translations: ['связанный'], definition: 'Ограниченный обязательством.' }],
  ]) assert.throws(() => validateModelLookup({ ...output, senses }, input), error => {
    assert.equal((error as any).code, 'INVALID_MODEL_OUTPUT');
    assert.deepEqual((error as any).diagnostics, { stage: 'validation', reason: 'definition_script_cyrillic' });
    return true;
  });
});

test('each generated sense has explicit request-bound source/target language instructions', () => {
  for (const language of LANGUAGES) {
    const schema = lookupModelSchema({ ...input, sourceLanguage: language.code, dialect: defaultLocale(language.code) });
    const properties = schema.properties.senses.items.properties;
    assert.ok(properties.definition.description.includes(language.nativeName));
    assert.ok(properties.definition.description.includes('(' + language.code + ')'));
    assert.match(properties.definition.description, /every sense, including secondary/);
    assert.match(properties.translations.items.description, /Русский \(ru\)/);
  }
  const reverse = lookupModelSchema({ ...input, sourceLanguage: 'ru', targetLanguage: 'en', dialect: 'ru-RU' });
  assert.match(reverse.properties.senses.items.properties.definition.description, /Русский \(ru\)/);
  assert.match(reverse.properties.senses.items.properties.translations.items.description, /English \(en\)/);
});

test('language failure makes one mock provider request, no hidden repair or fallback', async () => {
  let calls = 0;
  const client = new OpenAIService({ getApiKey: () => 'synthetic-only',
    fetch: async () => {
      calls++;
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify({ ...output,
          senses: [{ ...output.senses[0], definition: 'Направляющийся в путешествие.' }] }) }] }] });
    } });
  await assert.rejects(client.lookup(input), error => {
    assert.equal((error as any).code, 'INVALID_MODEL_OUTPUT');
    assert.equal((error as any).diagnostics.reason, 'definition_script_cyrillic');
    return true;
  });
  assert.equal(calls, 1);
});

test('second screenshot lighted: same language rejection is not phrase-specific; valid inflected word accepted', async () => {
  const sentence = 'Shut out the yesterdays which have lighted fools the way to dusty death.';
  const targetStart = sentence.indexOf('lighted');
  const single: LookupPayload = {...input, expression:'lighted', context:{sentence,targetStart,targetEnd:targetStart+7}};
  const good = {...output,lemma:'light',partOfSpeech:'verb',recommendedSenseId:'illuminate',
    senses:[{id:'illuminate',translations:['освещать'],definition:'To illuminate or show a path.'}],
    sentenceTranslation:'Отгородитесь от вчерашних дней, которые освещали глупцам путь к праху смерти.'};
  let calls = 0;
  const client = new OpenAIService({getApiKey:()=> 'synthetic-only', fetch:async (_url, init)=>{
    calls++;
    const request = JSON.parse(String(init?.body));
    const data = JSON.parse(request.input[0].content[0].text);
    assert.equal(data.sourceLanguage,'en'); assert.equal(data.targetLanguage,'ru');
    assert.equal(data.expression,'lighted');
    assert.equal(data.context.sentence,sentence);
    assert.match(request.text.format.schema.properties.senses.items.properties.definition.description,/English \(en\)/);
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(good)}]}]});
  }});
  const result = await client.lookup(single);
  assert.equal(result.data.expression,'lighted'); assert.equal(result.data.lemma,'light'); assert.equal(calls,1);
  assert.throws(()=>validateModelLookup({...good,senses:[{...good.senses[0],definition:'Освещать или указывать путь.'}]},single),
    error => (error as any).diagnostics?.reason === 'definition_script_cyrillic');
});

test('bounded script diagnostic does not claim a language or leak failed text', () => {
  for (const definition of ['Направляющийся в путешествие.', 'Ұзақ сапарға шығатын.', 'Невідоме значення.']) {
    assert.throws(() => validateModelLookup({ ...output, senses: [{ ...output.senses[0], definition }] }, input), error => {
      assert.deepEqual((error as any).diagnostics, { stage:'validation', reason:'definition_script_cyrillic' });
      assert.ok(!JSON.stringify(error).includes(definition));
      return true;
    });
  }
  for (const definition of ['これは説明です。', 'هذا تعريف.', '12345']) {
    assert.throws(() => validateModelLookup({ ...output, senses: [{ ...output.senses[0], definition }] }, input),
      error => (error as any).diagnostics?.reason === 'definition_language');
  }
});
