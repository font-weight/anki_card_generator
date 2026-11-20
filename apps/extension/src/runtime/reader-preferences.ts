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
export function createReaderPreferenceCache(read: () => Promise<Partial<PublicSettings>>, onGrammarEnabledChange?: (enabled:boolean)=>void) {
  let snapshot = Object.freeze(lookupPreferences({}));
  let grammarSnapshot = Object.freeze(grammarPreferences({}));
  let revision = 0;
  let grammarIntent = 0;
  async function refresh() {
    const token = ++revision;
    try {
      const settings = await read();
      if (token !== revision) return false;
      snapshot = Object.freeze(lookupPreferences(settings));
      grammarSnapshot = Object.freeze(grammarPreferences(settings));
      onGrammarEnabledChange?.(grammarSnapshot.enabled);
      return true;
    } catch { return false; }
  }
  function cancelGrammarOpening() { grammarIntent++; }
  return {
    getSnapshot: () => snapshot,
    getGrammarSnapshot: () => grammarSnapshot,
    cancelGrammarOpening,
    invalidate: () => { revision++; cancelGrammarOpening(); },
    refresh,
    refreshGrammarConsent() {
      cancelGrammarOpening();
      grammarSnapshot = Object.freeze({...grammarSnapshot, enabled:false});
      onGrammarEnabledChange?.(false);
      return refresh();
    },
    async openGrammarIfEnabled(open: () => void) {
      const intent = ++grammarIntent;
      // Cached opt-in is a gesture hint. Only a successful current read can
      // open the mode, and a later Shift, Alt or dismissal takes precedence.
      if (await refresh() && intent === grammarIntent && grammarSnapshot.enabled) open();
    },
  };
}
