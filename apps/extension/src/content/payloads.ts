import { enumeratePhrasalCandidates, type LookupPayload, type GrammarLookupPayload } from '@english-reader/contracts';
import type { ExtractedText } from './extraction';
import type { grammarPreferences, lookupPreferences } from '../runtime/reader-preferences';

/** Local-only proposals are attached to the one explicit Shift request. A
 * manual selection, even a single selected word, is never expanded. */
export function lookupPayloadFor(value: ExtractedText, preferences: ReturnType<typeof lookupPreferences>): LookupPayload {
  const candidates = value.origin === 'hover' && preferences.sourceLanguage === 'en' ? enumeratePhrasalCandidates(value.context) : [];
  return {expression:value.expression,context:value.context,...preferences,...(candidates.length ? {phrasalCandidates:candidates} : {})};
}
export function grammarPayloadFor(value: ExtractedText, preferences: ReturnType<typeof lookupPreferences>, grammar:ReturnType<typeof grammarPreferences>): GrammarLookupPayload {
  return {sentence:value.context.sentence,sourceLanguage:preferences.sourceLanguage,targetLanguage:preferences.targetLanguage,
    learnerLevel:preferences.learnerLevel,explanationLanguage:grammar.explanationLanguage,includeExplanation:grammar.includeExplanation};
}
