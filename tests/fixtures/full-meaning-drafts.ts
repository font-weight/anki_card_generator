import type { FullMeaningsNoteDraft, LegacyNoteDraft, MultilingualNoteDraft } from '../../packages/contracts/src/index.ts';

export const operationId = '11111111-1111-4111-8111-111111111111';
export const secondOperationId = '22222222-2222-4222-8222-222222222222';

export function legacyDraft(): LegacyNoteDraft {
  return {
    sourceLanguage: 'en', targetLanguage: 'ru', mode: 'recognition', deckName: 'Test', tags: [],
    expression: 'read', lemma: 'read', partOfSpeech: 'verb',
    selectedSense: { id: 'reading', translations: ['читать'], definitionEn: 'To understand written words.' },
    context: { sentence: 'I read and read.', targetStart: 11, targetEnd: 15 },
    pronunciation: { ipa: '/riːd/', dialect: 'en-US', source: 'generated', sourceUrl: null },
    extraExample: { textEn: 'I read a book.', textRu: 'Я читаю книгу.', source: 'ai' },
    source: { kind: 'html', title: 'Book', url: 'https://example.com/book?private=x#secret', documentId: null, page: null, chapter: null, cfi: null },
  };
}

export function multilingualDraft(): MultilingualNoteDraft {
  const { selectedSense, extraExample, ...rest } = legacyDraft();
  return {
    ...rest, draftVersion: 2, learnerLevel: 'B1',
    selectedSense: { id: selectedSense.id, translations: [...selectedSense.translations], definition: selectedSense.definitionEn },
    examples: [{ text: extraExample!.textEn, translation: extraExample!.textRu, source: 'ai' }],
  };
}

export function fullMeaningsDraft(): FullMeaningsNoteDraft {
  const old = multilingualDraft();
  return {
    ...old, draftVersion: 3,
    senses: [structuredClone(old.selectedSense),
      { id: 'interpret', translations: ['понимать', 'истолковывать', 'интерпретировать'], definition: 'To interpret the meaning of a situation.' },
      { id: 'show', translations: ['показывать', 'гласить'], definition: 'To show particular words or a measurement.' }],
  };
}
