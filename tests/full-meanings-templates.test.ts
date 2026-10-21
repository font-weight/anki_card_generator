import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LANGUAGE_CODES } from '../packages/contracts/src/index.ts';
import {
  buildClozeSentence, buildNoteFields, draftVersion, escapeAnkiText, formatIpaDisplay,
  modelDefinition, MULTILINGUAL_NOTE_FIELDS, renderPreview, semanticKeys, sha256,
} from '../packages/note-templates/src/index.ts';
import { fullMeaningsDraft, legacyDraft, multilingualDraft, operationId } from './fixtures/full-meaning-drafts.ts';

const dom = (html: string) => new JSDOM(html).window.document;
const fieldsFor = async (draft = fullMeaningsDraft()) => buildNoteFields(operationId, draft, await semanticKeys(draft));

test('v3 exposes every returned sense/translation/definition, contextual group first, without folded meanings', async () => {
  const draft = fullMeaningsDraft(), before = structuredClone(draft);
  const fields = await fieldsFor(draft), preview = renderPreview(draft), back = dom(preview.back);
  assert.deepEqual(Object.keys(fields), [...MULTILINGUAL_NOTE_FIELDS]);
  assert.equal(fields.Definition, '', 'paired sense blocks use existing Meaning field, not a new model');
  const groups = [...back.querySelectorAll('.sense-group')];
  assert.equal(groups.length, draft.senses.length);
  for (const [index, sense] of draft.senses.entries()) {
    const group = groups[index]!;
    assert.equal(group.querySelector('.sense-translations')!.textContent, sense.translations.join('; '));
    assert.equal(group.querySelector('.sense-definition')!.textContent, sense.definition);
    assert.equal(group.closest('details'), null, 'all meanings must be immediately visible');
  }
  assert.ok(groups[0]!.classList.contains('contextual-sense'));
  assert.equal(back.querySelector('.sense-label')!.textContent, 'В этом контексте');
  assert.equal(dom(preview.front).querySelector('.sense-group'), null);
  assert.equal(back.querySelector('.examples .example')!.textContent, 'I read a book.Я читаю книгу.Пример: ИИ');
  assert.deepEqual(draft, before, 'rendering must not rewrite the frozen draft');
});

test('v3 highlights only the selected UTF-16 occurrence, red and underlined, in expression and sentence', async () => {
  const draft = fullMeaningsDraft();
  draft.context = { sentence: '😀 read and read.', targetStart: 12, targetEnd: 16 };
  const fields = await fieldsFor(draft), preview = dom(renderPreview(draft).front);
  assert.equal(dom(fields.Sentence!).body.textContent, draft.context.sentence);
  assert.equal(dom(fields.Sentence!).querySelectorAll('.target-word').length, 1);
  assert.ok(fields.Sentence!.startsWith('😀 read and <span'));
  for (const target of preview.querySelectorAll<HTMLElement>('.target-word')) {
    assert.equal(target.textContent, 'read');
    assert.equal(target.style.color, 'rgb(220, 38, 38)');
    assert.equal(target.style.textDecoration, 'underline');
    assert.equal(target.style.fontWeight, '700');
  }
  assert.equal(preview.querySelectorAll('.target-word').length, 2);
  draft.context.targetStart = 3;
  assert.throws(() => buildNoteFields(operationId, draft, { lexemeKey: '', contentKey: '' }), { code: 'INVALID_INPUT' });
});

test('maximum v3 snapshot renders all eight groups and all thirty-two returned translations', () => {
  const draft = fullMeaningsDraft();
  draft.senses = Array.from({ length: 8 }, (_, sense) => ({ id: `sense-${sense}`,
    translations: Array.from({ length: 4 }, (_, translation) => `Перевод ${sense + 1}.${translation + 1}`),
    definition: `Definition ${sense + 1}.` }));
  draft.selectedSense = structuredClone(draft.senses[0]!);
  const back = dom(renderPreview(draft).back), groups = [...back.querySelectorAll('.sense-group')];
  assert.equal(groups.length, 8);
  for (const [index, sense] of draft.senses.entries()) {
    assert.equal(groups[index]!.querySelector('.sense-translations')!.textContent, sense.translations.join('; '));
    assert.equal(groups[index]!.querySelector('.sense-definition')!.textContent, sense.definition);
  }
});

test('v3 cloze front hides answer/meanings/IPA/audio; back reveals styled answer inside c1 only', async () => {
  const draft = fullMeaningsDraft();
  draft.mode = 'cloze'; draft.expression = 'unique';
  draft.context = { sentence: 'A unique word.', targetStart: 2, targetEnd: 8 };
  const fields = await fieldsFor(draft), preview = renderPreview(draft, { audioFilename: 'word.mp3' });
  assert.match(fields.ClozeSentence!, /^A \{\{c1::<span class="target-word"/u);
  assert.equal((fields.ClozeSentence!.match(/\{\{c1::/gu) ?? []).length, 1);
  assert.equal(buildClozeSentence(draft), fields.ClozeSentence);
  const front = dom(preview.front), back = dom(preview.back);
  assert.equal(front.body.textContent, 'A […] word.');
  assert.equal(front.querySelector('.target-word'), null);
  for (const hidden of ['unique', 'sense-group', 'читать', 'riːd', 'audio-label']) assert.ok(!preview.front.includes(hidden), hidden);
  assert.equal(back.querySelector('.cloze .target-word')!.textContent, 'unique');
  assert.equal(back.querySelector('.cloze .target-word')!.getAttribute('style'), 'color: #dc2626; text-decoration: underline; font-weight: 700;');
  assert.match(preview.back, /Аудио будет добавлено/u);
});

test('v3 source/model markup, native cloze, audio and LaTeX injections remain inert text', async () => {
  const hostile = '<img src=x onerror="evil()"> {{c9::stolen}} [sound:evil.mp3] [latex]evil[/latex] &';
  const draft = fullMeaningsDraft(); draft.mode = 'cloze';
  draft.expression = hostile; draft.context = { sentence: 'Before ' + hostile + ' after.', targetStart: 7, targetEnd: 7 + hostile.length };
  draft.selectedSense.translations = [hostile]; draft.selectedSense.definition = hostile;
  draft.senses[0] = structuredClone(draft.selectedSense);
  draft.senses[1]!.translations = [hostile]; draft.senses[1]!.definition = hostile;
  draft.examples = [{ text: hostile, translation: hostile, source: 'ai' }];
  draft.pronunciation.ipa = '/' + hostile + '/';
  const fields = await fieldsFor(draft), preview = renderPreview(draft), back = dom(preview.back);
  for (const value of Object.values(fields)) {
    assert.ok(!value.includes('<img')); assert.ok(!value.includes('{{c9::'));
    assert.ok(!value.includes('[sound:evil')); assert.ok(!value.includes('[latex]'));
  }
  assert.equal(back.querySelectorAll('img,script,iframe,audio,video,style').length, 0);
  for (const element of back.querySelectorAll('*')) for (const attribute of element.attributes) assert.ok(!attribute.name.startsWith('on'));
  assert.equal(back.querySelector('.sense-translations')!.textContent, hostile);
  assert.equal(back.querySelector('.cloze .target-word')!.textContent, hostile);
  assert.equal(dom(preview.front).body.textContent, 'Before […] after.');
});

test('v3 preview is the same installed v2 template plus constructed note fields', async () => {
  for (const mode of ['recognition', 'cloze'] as const) {
    const draft = fullMeaningsDraft(); draft.mode = mode;
    const fields = await fieldsFor(draft), template = modelDefinition(mode, draftVersion(draft)).cardTemplates[0]!;
    const expected = (source: string, reveal: boolean) => source
      .replace(/\{\{#([A-Za-z]+)\}\}([\s\S]*?)\{\{\/\1\}\}/gu, (_all, field: string, content: string) => fields[field] ? content : '')
      .replace(/\{\{cloze:ClozeSentence\}\}/gu, () => fields.ClozeSentence!.replace(/\{\{c1::([\s\S]*?)\}\}/gu, (_all, answer: string) => '<span class="cloze">' + (reveal ? answer : '[…]') + '</span>'))
      .replace(/\{\{([A-Za-z]+)\}\}/gu, (_all, field: string) => fields[field] ?? '');
    assert.deepEqual(renderPreview(draft), { front: expected(template.Front, false), back: expected(template.Back, true) });
  }
});

test('v3 square IPA formatting is display-only, preserves interior symbols/provenance and stays escaped', async () => {
  for (const [value, expected] of [[null, ''], ['', ''], ['   ', ''], [' /riːd/ ', '[riːd]'], ['[riːd]', '[riːd]'], ['riːd', '[riːd]'], ['/[riːd]/', '[riːd]'], ['a/b', '[a/b]']] as const) {
    assert.equal(formatIpaDisplay(value), expected);
    const draft = fullMeaningsDraft(); draft.pronunciation.ipa = value;
    const before = structuredClone(draft.pronunciation), fields = await fieldsFor(draft);
    assert.equal(fields.IPA, escapeAnkiText(expected));
    assert.equal(fields.IPASource, 'Приблизительно · сгенерировано ИИ');
    assert.deepEqual(draft.pronunciation, before);
  }
  const draft = fullMeaningsDraft(); draft.pronunciation = { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null };
  assert.equal(dom(renderPreview(draft).back).querySelector('.ipa'), null);
  assert.equal((await fieldsFor(draft)).IPASource, 'Недоступно');
});

test('all language metadata and RTL sense/example pairs survive v3 rendering', async () => {
  const words = { en: 'cat', ru: 'кот', es: 'gato', fr: 'chat', de: 'Katze', it: 'gatto', pt: 'gato', zh: '猫', ja: '猫', ko: '고양이', ar: 'قط', hi: 'बिल्ली', tr: 'kedi', uk: 'кіт', pl: 'kot', nl: 'kat', kk: 'мысық' } as const;
  for (const sourceLanguage of LANGUAGE_CODES) {
    const draft = fullMeaningsDraft(); draft.sourceLanguage = sourceLanguage; draft.targetLanguage = sourceLanguage === 'ar' ? 'en' : 'ar';
    draft.expression = words[sourceLanguage]; draft.lemma = draft.expression;
    draft.context = { sentence: `🐈 ${draft.expression}.`, targetStart: 3, targetEnd: 3 + draft.expression.length };
    const back = dom(renderPreview(draft).back);
    assert.equal(back.querySelector('.sentence')!.getAttribute('lang'), sourceLanguage);
    for (const block of back.querySelectorAll('.sense-translations')) { assert.equal(block.getAttribute('lang'), draft.targetLanguage); assert.equal(block.getAttribute('dir'), 'auto'); }
    for (const block of back.querySelectorAll('.sense-definition')) { assert.equal(block.getAttribute('lang'), sourceLanguage); assert.equal(block.getAttribute('dir'), 'auto'); }
    const example = back.querySelector('.example')!;
    assert.equal(example.children[0]!.getAttribute('lang'), sourceLanguage);
    assert.equal(example.children[1]!.getAttribute('lang'), draft.targetLanguage);
  }
});

test('v3 full-sense content keys ignore IDs but include secondary senses and primary ordering', async () => {
  const draft = fullMeaningsDraft(), keys = await semanticKeys(draft);
  assert.equal(keys.lexemeKey, (await semanticKeys(legacyDraft())).lexemeKey);
  assert.equal(keys.lexemeKey, (await semanticKeys(multilingualDraft())).lexemeKey);
  assert.notEqual(keys.contentKey, (await semanticKeys(multilingualDraft())).contentKey);
  draft.senses.forEach((sense, index) => { sense.id = 'new-' + index; }); draft.selectedSense = structuredClone(draft.senses[0]!);
  assert.deepEqual(await semanticKeys(draft), keys);
  draft.senses[1]!.translations.push('новый перевод');
  assert.notEqual((await semanticKeys(draft)).contentKey, keys.contentKey);
  const reordered = fullMeaningsDraft(); [reordered.senses[0], reordered.senses[1]] = [reordered.senses[1]!, reordered.senses[0]!]; reordered.selectedSense = structuredClone(reordered.senses[0]!);
  assert.notEqual((await semanticKeys(reordered)).contentKey, keys.contentKey);
  const shortened = fullMeaningsDraft(); shortened.senses.pop();
  assert.notEqual((await semanticKeys(shortened)).contentKey, keys.contentKey);
  const definition = fullMeaningsDraft(); definition.senses[2]!.definition = 'A changed secondary definition.';
  assert.notEqual((await semanticKeys(definition)).contentKey, keys.contentKey);
});

// Captured from base0.2.1 before any v3 rendering changes. JSON byte hashes pin the
// complete fields, previews and installed models; existing keys remain exact too.
const baseline = [
  ['3acfba166becdc38bd387e3079d1cc38f901903561ebebc333403dbc9973c8d4', 'eea89628ec19a49895be4b4bdfbcc4bc47399b1673cb34c83f6db4f55c444a41', 'bc6a1a0680770bb53c9952aa3e48c2d17aee8250985959cd6cdadfba7fdccf5b', '9a5dcca0d9848d8a6e9d0497d519b11a607da64f117c44d5639c1c8edfd2bca4'],
  ['05a824726b4c232b56643dbf99f7b829229a2b12bf6bb8eba89196be775c0673', 'aaae2198c0a9a8e3d9eeb5d010a61d215ab241daeff375f61c3df0980d13df28', '63c033d488e85cd549133d6dd0ca5db12b5a0d314fc7db96a37ec1e394ba1b26', '59523160b3ced31ba29554dc49d704ef9ab4ff934ed27648515264cdd3e8c98e'],
  ['15a5e420d70c8e8023d9afac17b72d6272bb7468e9612cd5142f6ba28815316a', '014e158ec5802fbd994d6d8ca3b2a71243d7c7718e75db61bcf872a21bfb0c9f', '91bdaab3313b22199fac4613290a9c14728e52566aa27c0b9de4470907785b18', 'ebae6fd958134d218806048125fc068d345ed055178315ad3ff91728a323c2ca'],
  ['5f647b5dfcac7881206a5595296a3047cf485dd2f650a5fcbfa04224d83f3ecd', '0c481150c97f926ae7ed0f6bc87e23c9319fdd85936780499044f02a01f732e4', '8f080c8bd4d1e5214e6aba11cc212216fe599ba576447dec718fcf7b1b27f688', '81b29668cdd5175f47d99e95a889ec2cc26320c185747ec9ff9f484bb763e98f'],
];
test('legacy v1/v2 recognition and cloze fields, keys, previews and installed models remain byte-identical', async () => {
  let index = 0;
  for (const draft of [legacyDraft(), multilingualDraft()]) for (const mode of ['recognition', 'cloze'] as const) {
    draft.mode = mode;
    const keys = await semanticKeys(draft), expected = baseline[index++]!;
    assert.equal(keys.lexemeKey, '77e20b105cd09bfbf1046fc8cf12fa5c7b6cd6adc42128c536a68e3c36bcf018');
    assert.equal(keys.contentKey, expected[0]);
    assert.equal(await sha256(JSON.stringify(buildNoteFields(operationId, draft, keys, 'произношение.mp3'))), expected[1]);
    assert.equal(await sha256(JSON.stringify(renderPreview(draft, { audioFilename: 'произношение.mp3' }))), expected[2]);
    assert.equal(await sha256(JSON.stringify(modelDefinition(mode, draftVersion(draft)))), expected[3]);
  }
});
