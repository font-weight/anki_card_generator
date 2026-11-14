import { describe, expect, it } from 'vitest';
import type { LanguageCode } from '@english-reader/contracts';
import { verbBaseFormDisplay } from '../../apps/extension/src/ui/verb-base-form';

describe('read-only verb base-form presentation', () => {
  it.each(['verb', ' Verb ', 'VERB', 'v.', 'phrasal verb', 'prepositional verb', 'transitive verb', 'verb (past tense)', 'глагол', 'фразовый глагол'])('recognizes explicit verb POS %s', partOfSpeech => {
    expect(verbBaseFormDisplay({ lemma: 'go by', partOfSpeech, sourceLanguage: 'en' })).toEqual({ label: 'Инфинитив', text: 'go by' });
  });

  it.each(['noun', 'adverb', 'adverbial', 'noun/verb', 'noun or verb', 'verb or noun', 'verbal noun', 'non-verb', 'unknown', '', undefined])('does not infer an infinitive from %s', partOfSpeech => {
    expect(verbBaseFormDisplay({ lemma: 'go', partOfSpeech, sourceLanguage: 'en' })).toBeNull();
  });

  it.each([undefined, null, 1, '', '  ', '?', '—', 'unknown', 'N/A', 'неизвестно', 'go / leave', 'go or leave', 'go или leave', 'go; leave', 'go, leave', 'go (leave)', 'go?', 'go\nleave', '<b>go</b>', 'x'.repeat(257)])('omits a missing or visibly unresolved lemma %j', lemma => {
    expect(verbBaseFormDisplay({ lemma, partOfSpeech: 'verb', sourceLanguage: 'en' })).toBeNull();
  });

  it.each([
    ['en', 'go', 'verb', 'Инфинитив'], ['ru', 'идти', 'глагол', 'Инфинитив'],
    ['es', 'ir', 'verbo', 'Инфинитив'], ['fr', 's’en aller', 'verbe', 'Инфинитив'],
    ['de', 'gehen', 'Verb', 'Инфинитив'], ['it', 'andare', 'verbo', 'Инфинитив'],
    ['pt', 'ir', 'verbo', 'Инфинитив'], ['zh', '去', '动词', 'Начальная форма'],
    ['ja', '行く', '動詞', 'Начальная форма'], ['ko', '가다', '동사', 'Начальная форма'],
    ['ar', 'ذَهَبَ', 'فعل', 'Начальная форма'], ['hi', 'जाना', 'क्रिया', 'Инфинитив'],
    ['tr', 'gitmek', 'fiil', 'Инфинитив'], ['uk', 'іти', 'дієслово', 'Инфинитив'],
    ['pl', 'iść', 'czasownik', 'Инфинитив'], ['nl', 'gaan', 'werkwoord', 'Инфинитив'],
    ['kk', 'бару', 'етістік', 'Инфинитив'],
  ] as const)('uses the supplied %s lemma without inventing English “to”', (sourceLanguage, lemma, partOfSpeech, label) => {
    const input = Object.freeze({ sourceLanguage: sourceLanguage as LanguageCode, lemma, partOfSpeech });
    expect(verbBaseFormDisplay(input)).toEqual({ label, text: lemma });
    expect(input.lemma).toBe(lemma);
  });

  it.each(['modal verb', 'auxiliary verb', 'AUX', 'модальный глагол'])('does not claim an infinitive for %s', partOfSpeech => {
    expect(verbBaseFormDisplay({ lemma: 'can', partOfSpeech, sourceLanguage: 'en' })).toEqual({ label: 'Начальная форма', text: 'can' });
  });

  it('only trims display whitespace, without modifying or re-lemmatizing the draft', () => {
    const input = Object.freeze({ lemma: '  go by  ', partOfSpeech: 'phrasal verb', sourceLanguage: 'en' as const });
    expect(verbBaseFormDisplay(input)?.text).toBe('go by');
    expect(input.lemma).toBe('  go by  ');
    expect(verbBaseFormDisplay({ ...input, lemma: 'to go by' })?.text).toBe('to go by');
  });
});
