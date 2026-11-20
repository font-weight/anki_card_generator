import type {GrammarQuestionContext} from '../../packages/contracts/src/grammar-question.ts';

// The source and the question are transcribed from the reported reader state.
// The checked teaching fields below are synthetic, not an alleged provider reply.
const sentence = 'This change has caused a great deal of confusion for librarians and other researchers who have tried to sort out the sequence of publication of these editions.';
const selected = 'who have tried to sort out the sequence of publication of these editions';
const start = sentence.indexOf(selected);
export const fullRuleQuestion = 'Объясни мне правило целиком';
export const relativeClauseLesson: GrammarQuestionContext = {
  input: {sentence, sourceLanguage: 'en', targetLanguage: 'ru', explanationLanguage: 'ru', learnerLevel: 'B1', includeExplanation: true},
  analysis: {
    grammarId: '00000000-0000-4000-8000-000000000044', sentence,
    construction: {text: selected, targetStart: start, targetEnd: start + selected.length},
    question: 'К кому относится who have tried и зачем нужна эта часть предложения?',
    rule: 'Определительное придаточное с who ставят после названия людей, чтобы уточнить, о ком идёт речь. Здесь who служит подлежащим при have tried, поэтому его нельзя опустить.',
    answer: 'Оборот who have tried относится к librarians and other researchers и уточняет, какие именно люди пытались установить порядок публикации изданий.',
    explanation: 'Например: «Researchers who have tried to date the editions compare their notes.» Здесь who вводит уточнение к researchers.',
    translation: 'Это изменение запутало библиотекарей и других исследователей, которые пытались установить порядок публикации этих изданий.',
  },
};
export const relativeClauseFullAnswer = [relativeClauseLesson.analysis.rule, relativeClauseLesson.analysis.answer, relativeClauseLesson.analysis.explanation].join('\n\n');
