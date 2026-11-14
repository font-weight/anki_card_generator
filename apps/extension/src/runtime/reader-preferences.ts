import { defaultLocale, localeMatchesLanguage } from '@english-reader/contracts';
import type { LookupPayload, PublicSettings, LanguageCode } from '@english-reader/contracts';

/** Only safe, explicit reading preferences; never infer a language from page text. */
export function lookupPreferences(settings: Partial<PublicSettings>, fallback?: Partial<LookupPayload>): Pick<LookupPayload, 'sourceLanguage' | 'targetLanguage' | 'learnerLevel' | 'dialect'> {
  const sourceLanguage = settings.sourceLanguage ?? fallback?.sourceLanguage ?? 'en';
  const targetLanguage = settings.targetLanguage ?? fallback?.targetLanguage ?? 'ru';
  const learnerLevel = settings.learnerLevel ?? fallback?.learnerLevel ?? 'B1';
  const preferred = settings.dialect ?? fallback?.dialect;
  const dialect = preferred && localeMatchesLanguage(preferred, sourceLanguage) ? preferred : defaultLocale(sourceLanguage);
  return { sourceLanguage, targetLanguage, learnerLevel, dialect };
}

export function grammarPreferences(settings: Partial<PublicSettings>): {enabled:boolean; includeExplanation:boolean; explanationLanguage:LanguageCode} {
  return {enabled:settings.grammarEnabled === true,includeExplanation:settings.grammarIncludeExplanation !== false,explanationLanguage:settings.grammarExplanationLanguage ?? settings.targetLanguage ?? 'ru'};
}

/** Latest-request-wins cache for synchronous extraction; an old focus refresh cannot roll back its locale. */
export function createReaderPreferenceCache(read: () => Promise<Partial<PublicSettings>>) {
  let snapshot = Object.freeze(lookupPreferences({}));
  let grammarSnapshot = Object.freeze(grammarPreferences({}));
  let revision = 0;
  return {
    getSnapshot: () => snapshot,
    getGrammarSnapshot: () => grammarSnapshot,
    invalidate: () => { revision++; },
    async refresh(): Promise<void> {
      const token = ++revision;
      try {
        const settings = await read();
        if (token === revision) {
          snapshot = Object.freeze(lookupPreferences(settings));
          grammarSnapshot = Object.freeze(grammarPreferences(settings));
        }
      } catch { /* Keep the last confirmed preferences; the popup reports a failed settings read. */ }
    },
  };
}
