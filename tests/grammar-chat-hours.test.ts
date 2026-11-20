import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {classifyGrammarQuestion, type GrammarQuestionContext} from '../packages/contracts/src/grammar-question.ts';
import {GrammarService} from '../packages/services/src/grammar.ts';

const sentence = 'By the time the library opened, Nell had returned the key.';
const construction = 'had returned';
const start = sentence.indexOf(construction);
const context: GrammarQuestionContext = {
  input: {
    sentence, sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru',
    learnerLevel: 'B1', includeExplanation: false,
  },
  analysis: {
    grammarId: '00000000-0000-4000-8000-000000000043', sentence,
    construction: {text: construction, targetStart: start, targetEnd: start + construction.length},
    question: 'Как открытие библиотеки связано по времени с возвращением ключа?',
    answer: 'К тому времени, когда библиотека открылась, Нелл уже вернула ключ.',
    rule: 'Past Perfect обозначает действие, завершённое к другому моменту в прошлом.',
    translation: 'К открытию библиотеки Нелл уже вернула ключ.',
    explanation: null,
  },
};

const timeAnswer = {
  kind: 'answer' as const, anchor: construction, evidence: 'Nell had returned the key',
  answer: 'Форма had returned показывает, что Нелл вернула ключ до открытия библиотеки.',
};
const roleAnswer = {
  kind: 'answer' as const, anchor: 'library', evidence: 'the library opened',
  answer: 'Существительное library входит в подлежащее the library при глаголе opened.',
};

// A valid, grounded answer even for an unrelated request makes an accidental
// trip to the provider visible. Only GrammarService decides whether to call it.
function offlineChat(answer = timeAnswer) {
  let keyReads = 0;
  const requests: {question: string; sentence: string; tokens: number; format: string}[] = [];
  const service = new GrammarService({
    hasConsent: () => true,
    getApiKey: () => { keyReads++; return 'offline-fixture'; },
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const input = JSON.parse(body.input[0].content[0].text);
      requests.push({question: input.question, sentence: input.sentence, tokens: body.max_output_tokens, format: body.text.format.name});
      return Response.json({
        status: 'completed', id: 'resp_fixture', output: [{
          type: 'message', role: 'assistant', status: 'completed',
          content: [{type: 'output_text', text: JSON.stringify({result: answer})}],
        }],
      });
    },
  });
  return {service, requests, counts: () => ({keyReads, fetches: requests.length})};
}

function checkAccess(t: TestContext, before: {keyReads: number; fetches: number}, after: typeof before, expected: number) {
  t.diagnostic(`key reads ${before.keyReads}→${after.keyReads}, provider calls ${before.fetches}→${after.fetches}`);
  assert.deepEqual(after, {keyReads: before.keyReads + expected, fetches: before.fetches + expected});
}

const reportedQuestion = 'Когда откроется ближайшая библиотека?';
const informationRequests = [
  reportedQuestion,
  'Во сколько закрывается музей по субботам?',
  'Аптека рядом уже открыта?',
  'What are the opening hours of the library near me?',
  'What time does the post office open tomorrow?',
  'Is the swimming pool open on Sundays?',
  'Во сколько уходит последняя электричка?',
  'When does the ferry to the island leave tomorrow?',
  'Сколько стоит вход в музей?',
  'What is the capital of Portugal?',
];

for (const question of informationRequests) {
  test('a practical information request stays local: ' + question, async t => {
    const {service, counts} = offlineChat();
    const before = counts();
    const result = await service.chat(context, [], question);
    checkAccess(t, before, counts(), 0);
    assert.deepEqual(result.data, {kind: 'out_of_scope'});
    assert.equal(result.responseId, null);
  });
}

test('the reported nearby-library request also stays local on an unrelated passage', async t => {
  const source = 'Before the train left, Nell had returned the key.';
  const at = source.indexOf(construction);
  const train: GrammarQuestionContext = {
    input: {...context.input, sentence: source},
    analysis: {
      ...context.analysis, sentence: source,
      construction: {text: construction, targetStart: at, targetEnd: at + construction.length},
      question: 'Что произошло до отправления поезда?',
      answer: 'Нелл вернула ключ до того, как поезд ушёл.',
      translation: 'Перед отправлением поезда Нелл уже вернула ключ.',
    },
  };
  const {service, counts} = offlineChat();
  const before = counts();
  const result = await service.chat(train, [], reportedQuestion);
  checkAccess(t, before, counts(), 0);
  assert.deepEqual(result.data, {kind: 'out_of_scope'});
  assert.equal(result.responseId, null);
});

const paraphrase = 'То есть одно дело успели закончить, пока до второго ещё не дошло?';
const lessonQuestions: [string, typeof timeAnswer][] = [
  ['Какую роль играет слово library в первой части?', roleAnswer],
  ['Is “library” the subject of “opened” here?', roleAnswer],
  ['Почему здесь стоит had returned, а не returned?', timeAnswer],
  ['Had Nell already returned the key when the library opened?', timeAnswer],
  [paraphrase, timeAnswer],
];

for (const [question, answer] of lessonQuestions) {
  test('a reader asking about the sentence gets one grounded decision: ' + question, async t => {
    if (question === paraphrase) assert.equal(classifyGrammarQuestion(context, [], question), 'uncertain');
    const {service, counts, requests} = offlineChat(answer);
    const before = counts();
    const result = await service.chat(context, [], question);
    checkAccess(t, before, counts(), 1);
    assert.deepEqual(result.data, answer);
    assert.equal(requests[0].sentence, sentence);
    assert.equal(requests[0].question, question);
    assert.equal(requests[0].format, 'language_reader_grammar_question_v1');
    assert.ok(requests[0].tokens === 10_000);
  });
}
