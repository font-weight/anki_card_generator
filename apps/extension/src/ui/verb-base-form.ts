import type { LanguageCode } from '@english-reader/contracts';

// POS is a free-text provider field, including in existing cache entries. Match
// explicit labels only: substring checks would also accept "adverb" or "noun/verb".
const verbLabels = new Set([
  'verb', 'v', 'v.', 'vb', 'phrasal verb', 'prepositional verb', 'phrasal-prepositional verb',
  'transitive verb', 'intransitive verb', 'reflexive verb', 'linking verb', 'copular verb',
  'verb (transitive)', 'verb (intransitive)', 'verb (reflexive)', 'verb (phrasal)',
  'verb (past tense)', 'verb (past participle)', 'verb (present participle)',
  'глагол', 'гл.', 'фразовый глагол', 'переходный глагол', 'непереходный глагол', 'возвратный глагол',
  'verbo', 'verbe', 'werkwoord', 'дієслово', 'czasownik', 'етістік', 'fiil',
  '动词', '動詞', '동사', 'فعل', 'क्रिया',
]);
const auxiliaryLabels = new Set([
  'aux', 'auxiliary', 'auxiliary verb', 'modal', 'modal verb', 'modal auxiliary',
  'modal auxiliary verb', 'verb (auxiliary)', 'verb (modal)',
  'вспомогательный глагол', 'модальный глагол',
]);
// These languages normally cite verbs by a dictionary form rather than an
// infinitive. An English modal also need not have an infinitive (e.g. can).
const dictionaryFormLanguages = new Set<LanguageCode>(['ar', 'zh', 'ja', 'ko']);
const unavailableLemmas = new Set(['unknown', 'unavailable', 'none', 'null', 'undefined', 'n/a', 'not available', 'неизвестно', 'недоступно', 'не определено']);

/** Read-only presentation of the existing lemma, never a lemmatizer or a request.
 * Unknown/mixed POS and visibly missing/alternative lemmas are not guessed. This
 * deliberately does not promise semantic verification of the provider's lemma. */
export function verbBaseFormDisplay(input: {
  lemma?: unknown; partOfSpeech?: unknown; sourceLanguage: LanguageCode;
}): { label: 'Инфинитив' | 'Начальная форма'; text: string } | null {
  if (typeof input.partOfSpeech !== 'string' || typeof input.lemma !== 'string') return null;
  const pos = input.partOfSpeech.trim().toLowerCase().replace(/\s+/gu, ' ');
  const auxiliary = auxiliaryLabels.has(pos);
  if (!verbLabels.has(pos) && !auxiliary) return null;
  const lemma = input.lemma.trim();
  if (!lemma || lemma.length > 256 || !/\p{L}/u.test(lemma) || unavailableLemmas.has(lemma.toLowerCase()) ||
      /[\u0000-\u001f\u007f<>/\\|;,?:()[\]{}]/u.test(lemma) || /\s(?:or|или)\s/iu.test(lemma)) return null;
  return {
    label: auxiliary || dictionaryFormLanguages.has(input.sourceLanguage) ? 'Начальная форма' : 'Инфинитив',
    text: lemma,
  };
}
