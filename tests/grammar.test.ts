import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGrammarContent, validateGrammarDraft, validateGrammarLookupPayload } from '../packages/contracts/src/grammar.ts';
import type { GrammarContent, GrammarDraft, GrammarLookupPayload } from '../packages/contracts/src/grammar.ts';
import { GrammarService, GrammarCoordinator, grammarCacheKey, GRAMMAR_SYSTEM_PROMPT } from '../packages/services/src/grammar.ts';
import type { GrammarExecution } from '../packages/services/src/grammar.ts';
import { buildGrammarNoteFields, grammarModelDefinition, grammarSemanticKeys, renderGrammarPreview, GRAMMAR_MODEL_NAME, GRAMMAR_NOTE_FIELDS } from '../packages/note-templates/src/grammar.ts';
import { ContractValidationError } from '../packages/contracts/src/index.ts';
const id = '12345678-1234-4234-8234-123456789abc';
const sentence = 'Inside Bag End, Bilbo and Gandalf were sitting at the open window of a small room looking out west on to the garden.';
const input: GrammarLookupPayload = { sentence, sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru', learnerLevel: 'B1', includeExplanation: true };
const content: GrammarContent = { sentence, construction: { text: 'were sitting', targetStart: 34, targetEnd: 46 }, question: 'Что передаёт форма were sitting в этом описании?', answer: 'Действие находилось в процессе в описываемый момент прошлого.', rule: 'Past Continuous образуется из was или were и формы глагола на -ing.', explanation: 'Сидение служит фоном сцены, а не завершённым действием.', translation: 'Внутри Бэг-Энда Бильбо и Гэндальф сидели у открытого окна маленькой комнаты, выходившего на запад в сад.' };
const source = { kind: 'html', title: 'A book', url: 'https://example.com/book?private=token#location', documentId: null, page: null, chapter: null, cfi: null } as const;
const draft: GrammarDraft = { ...content, draftKind: 'grammar', draftVersion: 1, sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru', learnerLevel: 'B1', deckName: 'Default', tags: ['Grammar'], source };
function provider(value: unknown = content, patch: Record<string, unknown> = {}) {
  return { id: 'resp_grammar', model: 'gpt-6-luna', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }, ...patch };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function execution(): GrammarExecution { return { data: { ...structuredClone(content), grammarId: id }, model: 'gpt-6-luna', reasoningEffort: 'none', resolvedModel: 'gpt-6-luna', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, responseId: 'resp_grammar', cacheHit: false, warnings: [] }; }

test('grammar repairs only unique exact construction numeric miscounts, retaining unchanged source', () => {
  const wrong = { ...content, construction: { ...content.construction, targetStart: 35, targetEnd: 47 } };
  const result = validateGrammarContent(wrong, input, { repairOffsets: true });
  assert.deepEqual(result.construction, { text: 'were sitting', targetStart: 34, targetEnd: 46 });
  assert.equal(result.sentence, sentence); assert.equal(wrong.construction.targetStart, 35);
  assert.throws(() => validateGrammarContent(wrong, input), ContractValidationError);
});
test('grammar shape, numeric types, bounds and all exact keys are validated before repair', () => {
  for (const patch of [
    { construction: { ...content.construction, targetStart: '35' } },
    { construction: { ...content.construction, targetStart: -1 } },
    { construction: { ...content.construction, targetEnd: 1501 } },
    { construction: { ...content.construction, targetEnd: 46.2 } },
    { construction: { ...content.construction, targetStart: NaN } },
    { construction: { ...content.construction, extra: 'ignored?' } },
    { answer: 'x'.repeat(1001) }, { extra: true }, { rule: '' },
  ]) assert.throws(() => validateGrammarContent({ ...content, ...patch }, input, { repairOffsets: true }), ContractValidationError);
});
test('grammar rejects changed sentence, ambiguous occurrence and fuzzy construction', () => {
  assert.throws(() => validateGrammarContent({ ...content, sentence: sentence + ' ' }, input, { repairOffsets: true }));
  const repeated = { ...input, sentence: 'They were sitting and we were sitting.' };
  assert.throws(() => validateGrammarContent({ ...content, sentence: repeated.sentence, construction: { text: 'were sitting', targetStart: 6, targetEnd: 18 } }, repeated, { repairOffsets: true }));
  assert.throws(() => validateGrammarContent({ ...content, construction: { text: 'were Sitting', targetStart: 35, targetEnd: 47 } }, input, { repairOffsets: true }));
  assert.equal(validateGrammarContent({ ...content, sentence: repeated.sentence, construction: { text: 'were sitting', targetStart: 5, targetEnd: 17 } }, repeated, { repairOffsets: true }).construction.targetStart, 5);
});
test('grammar repair still undergoes complete grapheme and plaintext checks', () => {
  for (const [text, full] of [['e', 'Cafe\u0301.'], ['\ud83d', 'A 😀.'], ['👩', 'A 👩‍💻.']]) {
    const next = { ...input, sentence: full };
    assert.throws(() => validateGrammarContent({ ...content, sentence: full, construction: { text, targetStart: 0, targetEnd: 1 } }, next, { repairOffsets: true }));
  }
  for (const bad of ['<b>rule</b>', '{{c1::rule}}', '[sound:bad.mp3]', '```text', 'x\u0000y']) assert.throws(() => validateGrammarContent({ ...content, rule: bad }, input, { repairOffsets: true }));
});
test('grammar has independent explanation language/visibility, strict drafts and source provenance', () => {
  assert.equal(validateGrammarLookupPayload({ ...input, explanationLanguage: 'de' }).explanationLanguage, 'de');
  assert.throws(() => validateGrammarLookupPayload({ ...input, explanationLanguage: 'unsupported' }));
  assert.throws(() => validateGrammarLookupPayload({ ...input, sentence: 'x'.repeat(1501) }));
  assert.throws(() => validateGrammarContent(content, { ...input, includeExplanation: false }));
  assert.equal(validateGrammarContent({ ...content, explanation: null }, { ...input, includeExplanation: false }).explanation, null);
  assert.throws(() => validateGrammarDraft({ ...draft, audio: true }));
  assert.throws(() => validateGrammarDraft({ ...draft, source: { ...source, kind: 'fb2', url: source.url } }));
  assert.throws(() => validateGrammarDraft({ ...draft, construction: { ...content.construction, targetStart: 35, targetEnd: 47 } }));
});
test('grammar provider request is one bounded structured call with no autosave or audio', async () => {
  const calls: RequestInit[] = [];
  const service = new GrammarService({ getApiKey: () => 'synthetic-key', idFactory: () => id, fetch: async (url, init) => { assert.equal(url, 'https://api.openai.com/v1/responses'); calls.push(init!); return reply(provider({ ...content, construction: { ...content.construction, targetStart: 35, targetEnd: 47 } })); } });
  const result = await service.lookup(input);
  assert.equal(calls.length, 1); assert.equal(result.data.construction.targetStart, 34);
  const body = JSON.parse(calls[0].body as string);
  assert.equal(body.store, false); assert.equal(body.stream, false); assert.equal(body.text.format.strict, true);
  assert.doesNotMatch(JSON.stringify(body.text.format.schema), /minLength|maxLength|minimum|maximum|format|pattern/u);
  assert.equal(body.reasoning.effort, 'none'); assert.equal(calls[0].credentials, 'omit'); assert.equal(calls[0].redirect, 'error');
  assert.deepEqual(JSON.parse(body.input[0].content[0].text), input);
  assert.match(GRAMMAR_SYSTEM_PROMPT, /explanationLanguage/); assert.match(GRAMMAR_SYSTEM_PROMPT, /ONE useful grammar card/);
});
test('grammar never secretly retries HTTP failure, refusal, incomplete or invalid output', async () => {
  for (const [body, status, code] of [
    [{ error: { code: 'rate_limit_exceeded' } }, 429, 'OPENAI_RATE_LIMIT'],
    [{ error: { code: 'insufficient_quota' } }, 429, 'OPENAI_QUOTA'],
    [provider({ invalid: true }), 200, 'INVALID_MODEL_OUTPUT'],
    [provider(content, { status: 'incomplete' }), 200, 'MODEL_INCOMPLETE'],
    [provider(content, { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }), 200, 'MODEL_REFUSAL'],
  ] as const) {
    let calls = 0;
    const service = new GrammarService({ getApiKey: () => 'synthetic-key', fetch: async () => { calls++; return reply(body, status); } });
    await assert.rejects(service.lookup(input), (err: any) => err.code === code); assert.equal(calls, 1);
  }
});
test('grammar response byte cap and source validation reject without retry', async () => {
  for (const response of [new Response('x'.repeat(128 * 1024 + 1)), reply(provider({ ...content, sentence: 'A different sentence.' }))]) {
    let count = 0;
    await assert.rejects(new GrammarService({ getApiKey: () => 'synthetic', fetch: async () => { count++; return response; } }).lookup(input), (e: any) => e.code === 'INVALID_MODEL_OUTPUT');
    assert.equal(count, 1);
  }
});
test('grammar timeout and cancellation bound non-cooperative adapters without retries', async () => {
  let calls = 0;
  const service = new GrammarService({ getApiKey: () => 'synthetic', budgetMs: 15, fetch: async () => { calls++; return new Promise<Response>(() => {}); } });
  await assert.rejects(service.lookup(input), (e: any) => e.code === 'NETWORK_TIMEOUT'); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.lookup(input, { signal: controller.signal }), (e: any) => e.code === 'REQUEST_CANCELLED'); assert.equal(calls, 1);
});
test('grammar cache and concurrent requests share one generation; returned objects are detached', async () => {
  let calls = 0;
  const coordinator = new GrammarCoordinator({ lookup: async () => { calls++; return execution(); } });
  const [one, two] = await Promise.all([coordinator.lookup(input, { requestId: 'a' }), coordinator.lookup(input, { requestId: 'b' })]);
  assert.equal(calls, 1); one.data.answer = 'User edit'; assert.notEqual(two.data.answer, one.data.answer);
  const cached = await coordinator.lookup(input, { requestId: 'c' });
  assert.equal(cached.cacheHit, true); assert.equal(cached.usage, null); assert.equal(cached.responseId, null); assert.equal(calls, 1);
  assert.notEqual(grammarCacheKey(input), grammarCacheKey({ ...input, explanationLanguage: 'de' }));
  assert.notEqual(grammarCacheKey(input), grammarCacheKey({ ...input, includeExplanation: false }));
});
test('grammar cancellation isolates concurrent subscribers and cancels obsolete work', async () => {
  let resolve!: (value: GrammarExecution) => void;
  const coordinator = new GrammarCoordinator({ lookup: () => new Promise(r => { resolve = r; }) });
  const controller = new AbortController();
  const a = coordinator.lookup(input, { requestId: 'a', signal: controller.signal });
  const b = coordinator.lookup(input, { requestId: 'b' });
  await new Promise(r => setTimeout(r, 0)); controller.abort();
  await assert.rejects(a, (e: any) => e.code === 'REQUEST_CANCELLED'); resolve(execution()); assert.equal((await b).data.sentence, sentence);
  assert.equal(coordinator.cancel('a'), false);
});
test('grammar model is separate, without cloze/audio, with exact escaped source and target-language metadata', async () => {
  const model = grammarModelDefinition(); assert.equal(model.modelName, 'LanguageReader.Grammar.v1'); assert.equal(GRAMMAR_MODEL_NAME, model.modelName);
  assert.equal(model.isCloze, false); assert.equal(model.cardTemplates.length, 1); assert.deepEqual(model.inOrderFields, [...GRAMMAR_NOTE_FIELDS]);
  assert.ok(!GRAMMAR_NOTE_FIELDS.some(field => /Audio|Cloze/iu.test(field)));
  const keys = await grammarSemanticKeys(draft); const fields = buildGrammarNoteFields(id, draft, keys);
  assert.equal(fields.Sentence.replace(/<[^>]+>/gu, ''), sentence); assert.equal(fields.SourceURL, 'https&#58;//example.com/book');
  assert.equal(fields.ExplanationLanguage, 'ru'); assert.equal(fields.TargetLanguage, 'ru');
  const preview = renderGrammarPreview(draft); assert.match(preview.front, /were sitting/); assert.match(preview.back, /Past Continuous/); assert.doesNotMatch(preview.front + preview.back, /\{\{|\[sound:/u);
  assert.notEqual((await grammarSemanticKeys({ ...draft, answer: 'Другой ответ' })).contentKey, keys.contentKey);
});
