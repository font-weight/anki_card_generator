import {asksForCardRuleQuotation} from '../../contracts/src/language-topic.ts';
import type {GrammarQuestionContext} from '../../contracts/src/grammar-question.ts';

/** Only a literal copy of the displayed rule can be fulfilled without a tutor request. */
export function storedCardRule(context: GrammarQuestionContext, question: string) {
  if (asksForCardRuleQuotation(question)) {
    return {kind: 'answer' as const, answer: context.analysis.rule, source: 'analysis' as const};
  }
}
