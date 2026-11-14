import test from 'node:test';
import assert from 'node:assert/strict';
import {enumeratePhrasalCandidates, MAX_LOOKUP_SENSES, MAX_SENSE_TRANSLATIONS} from '../packages/contracts/src/index.ts';
import type {LookupPayload} from '../packages/contracts/src/index.ts';
import {validateSchema} from '../packages/contracts/src/validation.ts';
import type {Schema} from '../packages/contracts/src/validation.ts';
import {OpenAIService, resolvedLookupInput, validateLookupResult, validateModelLookup} from '../packages/services/src/openai.ts';
import {LookupCoordinator} from '../packages/services/src/lookup.ts';
import {LOOKUP_MODEL_SCHEMA, LOOKUP_SYSTEM_PROMPT, lookupModelSchema} from '../packages/services/src/prompts.ts';

// Synthetic service fixtures, not a recovered provider response from the screenshot.
const sentence = 'Frodo kept up the custom of giving Bilbo’s Birthday Party year after year.';
function request(expression = 'kept', hovered = false, text = sentence, dialect: 'en-US' | 'en-GB' = 'en-US'): LookupPayload {
  const targetStart = text.lastIndexOf(expression);
  const context = {sentence: text, targetStart, targetEnd: targetStart + expression.length};
  return {expression, context, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', dialect,
    ...(hovered ? {phrasalCandidates: enumeratePhrasalCandidates(context)} : {})};
}
function model(lemma = 'keep') {
  return {lemma, partOfSpeech: 'verb', recommendedSenseId: 'continue', contextAmbiguous: false,
    senses: [
      {id: 'continue', translations: ['сохранять', 'продолжать'], definition: 'To continue a custom or activity.'},
      {id: 'retain', translations: ['оставлять у себя'], definition: 'To retain possession of something.'},
    ], ipaCandidate: null, sentenceTranslation: 'Они продолжали идти.', extraExample: null};
}
function envelope(value: unknown) {
  return {id: 'resp_offline_kept', status: 'completed', model: 'gpt-6-luna',
    usage: {input_tokens: 30, output_tokens: 40, total_tokens: 70},
    output: [{type: 'message', role: 'assistant', status: 'completed',
      content: [{type: 'output_text', text: JSON.stringify(value)}]}]};
}
function client(value: unknown) {
  const calls: any[] = [];
  const service = new OpenAIService({getApiKey: () => 'synthetic-only', fetch: async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json(envelope(value));
  }});
  return {service, calls};
}

// The shared contract validator expresses nullability with anyOf rather than a
// type array. Convert just that notation to test the outbound schema offline.
function localSchema(value: any): Schema {
  const {type, properties, items, anyOf, ...rest} = value;
  const fields = {...rest,
    ...(properties ? {properties: Object.fromEntries(Object.entries(properties).map(([key, field]) => [key, localSchema(field)]))} : {}),
    ...(items ? {items: localSchema(items)} : {}),
    ...(anyOf ? {anyOf: anyOf.map(localSchema)} : {}),
  };
  return Array.isArray(type) ? {anyOf: type.map(item => ({...fields, type: item}))} : {...fields, ...(type ? {type} : {})};
}

test('outbound lookup schema advertises sense IDs, cardinality and the exact requested IPA locale', () => {
  const input = request('kept', true, sentence, 'en-GB');
  const before = JSON.stringify(LOOKUP_MODEL_SCHEMA);
  const schema = lookupModelSchema(input), local = localSchema(schema);
  const candidate = input.phrasalCandidates![0]!;
  const good = {...model('keep up'), selectedCandidateId: candidate.id, englishUsage: null};
  assert.equal(candidate.lemma, 'keep up');
  assert.equal(candidate.expression, 'kept up');
  assert.doesNotThrow(() => validateSchema(local, good));
  assert.doesNotThrow(() => validateSchema(local, {...good, ipaCandidate: {ipa: '/kɛpt ʌp/', dialect: 'en-GB'}}));
  assert.doesNotThrow(() => validateSchema(local, {...good, contextAmbiguous: true, recommendedSenseId: null}));
  for (const id of ['keep up', candidate.id, 'значение', 'x'.repeat(65), '', 'continue\n']) {
    assert.throws(() => validateSchema(local, {...good, recommendedSenseId: id, senses: [{...good.senses[0], id}]}));
  }
  for (const id of ['continue', 'sense_1', 'keep-up', 'A'.repeat(64)]) {
    assert.doesNotThrow(() => validateSchema(local, {...good, recommendedSenseId: id, senses: [{...good.senses[0], id}]}));
  }
  for (const dialect of ['en-US', 'ru-RU', 'unknown', null]) {
    assert.throws(() => validateSchema(local, {...good, ipaCandidate: {ipa: '/kɛpt/', dialect}}));
  }
  assert.throws(() => validateSchema(local, {...good, senses: []}));
  assert.throws(() => validateSchema(local, {...good, senses: Array.from({length: MAX_LOOKUP_SENSES + 1}, (_, i) => ({...good.senses[0], id: `s${i}`}))}));
  assert.throws(() => validateSchema(local, {...good, senses: [{...good.senses[0], translations: []}]}));
  assert.throws(() => validateSchema(local, {...good, senses: [{...good.senses[0], translations: Array(MAX_SENSE_TRANSLATIONS + 1).fill('продолжать')}]}));
  assert.equal(JSON.stringify(LOOKUP_MODEL_SCHEMA), before, 'Per-request dialect narrowing must not mutate the shared schema');
  assert.doesNotThrow(() => validateSchema(localSchema(lookupModelSchema(request())), {...model(), englishUsage: null, ipaCandidate: {ipa: '/kɛpt/', dialect: 'en-US'}}));
  assert.match(LOOKUP_SYSTEM_PROMPT, /ASCII letters, digits, underscores or hyphens/);
  assert.match(LOOKUP_SYSTEM_PROMPT, /Sense ids identify meanings and are separate from selectedCandidateId/);
});

for (const dialect of ['en-US', 'en-GB'] as const) for (const ipaCandidate of [null, {ipa: '/kɛpt/', dialect}]) {
  test(`manual kept keeps its irregular lemma and original span (${dialect}, IPA ${ipaCandidate ? 'present' : 'null'})`, async () => {
    const input = request('kept', false, sentence, dialect), original = structuredClone(input);
    const {service, calls} = client({...model(), ipaCandidate});
    const result = await service.lookup(input);
    assert.equal(result.data.expression, 'kept');
    assert.equal(result.data.lemma, 'keep');
    assert.equal(result.data.resolvedTarget, undefined);
    assert.deepEqual(result.data.ipaCandidate, ipaCandidate);
    assert.deepEqual(resolvedLookupInput(input, result.data), original);
    assert.deepEqual(input, original);
    assert.deepEqual(JSON.parse(calls[0].input[0].content[0].text), original);
    assert.equal(calls.length, 1);
  });
}

test('hovered kept selects only the canonical kept up candidate and preserves repeated UTF-16 surface offsets', async () => {
  const input = request('kept', true, `📚 ${sentence} Frodo kept\u00a0up the custom again.`);
  const candidate = input.phrasalCandidates![0]!;
  const {service, calls} = client({...model('keep up'), partOfSpeech: 'phrasal verb',
    selectedCandidateId: candidate.id, ipaCandidate: {ipa: '/kɛpt ʌp/', dialect: input.dialect}});
  const result = await service.lookup(input);
  assert.equal(calls.length, 1);
  assert.equal(result.data.expression, 'kept\u00a0up');
  assert.equal(result.data.lemma, 'keep up');
  assert.equal(candidate.targetStart, input.context.sentence.lastIndexOf('kept'));
  assert.equal(input.context.sentence.slice(candidate.targetStart, candidate.targetEnd), result.data.expression);
  assert.deepEqual(result.data.resolvedTarget, {candidateId: candidate.id, targetStart: candidate.targetStart, targetEnd: candidate.targetEnd});
  assert.equal(Object.hasOwn(result.data, 'selectedCandidateId'), false);
  const resolved = resolvedLookupInput(input, result.data);
  assert.equal(resolved.phrasalCandidates, undefined);
  assert.equal(resolved.context.sentence, input.context.sentence);
  assert.equal(resolved.expression, 'kept\u00a0up');
  assert.equal(resolved.context.targetStart, candidate.targetStart);
  assert.equal(resolved.context.targetEnd, candidate.targetEnd);
  validateLookupResult(result.data, input);
  for (const patch of [
    {expression: 'keep up'},
    {resolvedTarget: {...result.data.resolvedTarget, targetStart: candidate.targetStart - 1}},
    {resolvedTarget: {...result.data.resolvedTarget, candidateId: 'pv1:0:7:keep_up'}},
  ]) assert.throws(() => validateLookupResult({...result.data, ...patch}, input), {code: 'INVALID_MODEL_OUTPUT'});
});

test('a null candidate retains kept / keep and a manual kept up selection stays authoritative', async () => {
  const hovered = request('kept', true);
  const tokenClient = client({...model(), selectedCandidateId: null});
  const token = await tokenClient.service.lookup(hovered);
  assert.equal(token.data.expression, 'kept');
  assert.equal(token.data.lemma, 'keep');
  assert.deepEqual(token.data.resolvedTarget, {candidateId: null, targetStart: hovered.context.targetStart, targetEnd: hovered.context.targetEnd});
  const manual = request('kept up');
  const phraseClient = client(model('keep up'));
  const phrase = await phraseClient.service.lookup(manual);
  assert.equal(phrase.data.expression, 'kept up');
  assert.equal(phrase.data.lemma, 'keep up');
  assert.equal(phrase.data.resolvedTarget, undefined);
  assert.equal(Object.hasOwn(lookupModelSchema(manual).properties, 'selectedCandidateId'), false);
  assert.equal(tokenClient.calls.length, 1);
  assert.equal(phraseClient.calls.length, 1);
});

test('all local payload and language guards still reject malformed kept results once, without repair or fabricated fallback', async () => {
  const input = request('kept', true), candidate = input.phrasalCandidates![0]!;
  const good = {...model('keep up'), selectedCandidateId: candidate.id};
  const {extraExample, ...missingRequired} = good;
  const badValues: unknown[] = [
    missingRequired,
    {...good, expression: 'keep up'},
    {...good, selectedCandidateId: 'keep_up'},
    {...good, selectedCandidateId: 'pv1:0:7:keep_up'},
    {...good, lemma: 'kept up'},
    {...good, selectedCandidateId: null, lemma: 'keep up'},
    {...good, recommendedSenseId: candidate.id, senses: [{...good.senses[0], id: candidate.id}]},
    {...good, recommendedSenseId: 'missing'},
    {...good, contextAmbiguous: true},
    {...good, senses: [good.senses[0], good.senses[0]]},
    {...good, senses: [{...good.senses[0], translations: ['сохранять', 'сохранять']}]},
    {...good, senses: [{...good.senses[0], translations: ['keep']}]},
    {...good, senses: [good.senses[0], {...good.senses[1], definition: 'Сохранять у себя.'}]},
    {...good, senses: [{id: 'continue', translations: ['сохранять'], definitionEn: 'To continue.'}]},
    {...good, ipaCandidate: {ipa: '/kɛpt/', dialect: 'en-GB'}},
    {...good, ipaCandidate: {ipa: '/kɛpt/', dialect: 'unknown'}},
  ];
  for (const value of badValues) {
    const {service, calls} = client(value);
    await assert.rejects(service.lookup(input), (error: any) => {
      assert.equal(error.code, 'INVALID_MODEL_OUTPUT');
      assert.deepEqual(error.usage, {inputTokens: 30, outputTokens: 40, totalTokens: 70});
      assert.equal(error.responseId, 'resp_offline_kept');
      return true;
    });
    assert.equal(calls.length, 1, 'A malformed response must not trigger a paid repair/retry');
  }
  const valid = validateModelLookup({...good, senses: [...good.senses].reverse()}, input);
  assert.equal(valid.senses[0]!.id, 'continue');
  assert.equal(valid.selectedCandidateId, candidate.id);
  assert.doesNotThrow(() => validateModelLookup({...good, contextAmbiguous: true, recommendedSenseId: null}, input));
});

for (const route of ['lookup', 'refine', 'enrich'] as const) {
  test(`${route} has one dispatch on network, rate-limit, gateway and incomplete-response failures`, async () => {
    const failures = [
      {code: 'INTERNAL_ERROR', fetch: async () => {throw new TypeError('Synthetic lost connection after dispatch');}},
      {code: 'OPENAI_RATE_LIMIT', fetch: async () => Response.json({error: {code: 'rate_limit_exceeded'}}, {status: 429, headers: {'retry-after': '0'}})},
      {code: 'INTERNAL_ERROR', fetch: async () => new Response('Synthetic gateway failure', {status: 503})},
      {code: 'MODEL_INCOMPLETE', fetch: async () => Response.json({...envelope(model()), status: 'incomplete'})},
      {code: 'INVALID_MODEL_OUTPUT', fetch: async () => new Response('{"status":')},
      {code: 'NETWORK_TIMEOUT', fetch: async () => new Promise<Response>(() => {})},
    ];
    for (const failure of failures) {
      let calls = 0;
      const service = new OpenAIService({getApiKey: () => 'synthetic-only', budgetMs: 30, fetch: async () => {
        calls++;
        return failure.fetch();
      }});
      const input = request();
      const pending = route === 'enrich' ? service.enrich({...input, selectedSense: model().senses[0]!}) :
        service.lookup(input, {refine: route === 'refine'});
      await assert.rejects(pending, {code: failure.code});
      assert.equal(calls, 1, `${route}/${failure.code} must never retry automatically`);
    }
  });
}

test('a failed lookup is not cached or repaired; one explicit new attempt can recover and then use cache', async () => {
  let calls = 0, writes = 0;
  const entries = new Map();
  const service = new OpenAIService({getApiKey: () => 'synthetic-only', fetch: async () => {
    calls++;
    return Response.json(envelope(calls === 1 ? {...model(), recommendedSenseId: 'not-a-sense'} : model()));
  }});
  const coordinator = new LookupCoordinator(service, {
    get: async key => entries.get(key),
    set: async (key, value) => {writes++; entries.set(key, value);},
  });
  const input = request();
  await assert.rejects(coordinator.lookup(input, {requestId: 'first-explicit-action'}), {code: 'INVALID_MODEL_OUTPUT'});
  assert.equal(calls, 1);
  assert.equal(writes, 0);
  const recovered = await coordinator.lookup(input, {requestId: 'explicit-user-retry'});
  assert.equal(calls, 2);
  assert.equal(writes, 1);
  assert.equal(recovered.data.expression, 'kept');
  assert.equal(recovered.data.lemma, 'keep');
  const cached = await coordinator.lookup(input, {requestId: 'later-explicit-action'});
  assert.equal(calls, 2);
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(cached.data, recovered.data);
});
