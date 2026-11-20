/** Original synthetic text for UI acceptance. No provider request is needed. */
export const harbourSentence = 'A glimmer of light appeared beyond the harbour wall.';
export const grammarSentence = 'By the time Mara reached the quay, the boats had left.';
export const grammarExcerpt = 'had left';
const targetStart = grammarSentence.indexOf(grammarExcerpt);

export const harbourGrammar = {
  grammarId: '70707070-7070-4070-8070-707070707070',
  sentence: grammarSentence,
  construction: {text: grammarExcerpt, targetStart, targetEnd: targetStart + grammarExcerpt.length},
  question: 'Что случилось раньше: Мара пришла или лодки ушли?',
  answer: 'Когда Мара добралась до причала, лодки уже ушли.',
  rule: 'Форма had left указывает на более раннее из двух событий в прошлом. Момент отсчёта задают слова Mara reached the quay.',
  explanation: 'Сравните с фразой «When Mara arrived, the boats left». Здесь лодки ушли, когда Мара пришла. В исходной фразе они ушли раньше.',
  translation: 'К тому времени, когда Мара добралась до причала, лодки уже ушли.',
};

export const harbourLookup = {
  lookupId: '80808080-8080-4080-8080-808080808080',
  expression: 'glimmer', lemma: 'glimmer', partOfSpeech: 'noun',
  recommendedSenseId: 'light', contextAmbiguous: false, ipaCandidate: null,
  senses: [
    {id:'light', translations:['проблеск'], definition:'A small, faint light.'},
    {id:'sign', translations:['намёк'], definition:'A slight sign of something.'},
  ],
};
