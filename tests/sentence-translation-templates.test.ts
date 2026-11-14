import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildNoteFields, renderPreview, semanticKeys, MULTILINGUAL_NOTE_FIELDS } from '../packages/note-templates/src/index.ts';
import { fullMeaningsDraft, operationId } from './fixtures/full-meaning-drafts.ts';

for (const mode of ['recognition', 'cloze'] as const) test(mode + ': full sentence translation on answer only; exact phrase occurrence underlined', async () => {
  const draft = fullMeaningsDraft();
  draft.mode = mode; draft.expression = 'bound on';
  draft.context = { sentence: '😀 bound on, then bound on a voyage.', targetStart: 18, targetEnd: 26 };
  assert.equal(draft.context.sentence.slice(18, 26), draft.expression);
  draft.sentenceTranslation = 'Сначала направлялся, а затем отправился в путешествие.';
  const before = structuredClone(draft);
  const fields = buildNoteFields(operationId, draft, await semanticKeys(draft));
  assert.deepEqual(Object.keys(fields), [...MULTILINGUAL_NOTE_FIELDS]);
  const preview = renderPreview(draft), back = new JSDOM(preview.back).window.document;
  assert.ok(!preview.front.includes('sentence-translation'));
  assert.equal(back.querySelector('.sentence-translation-text')?.textContent, draft.sentenceTranslation);
  const sentence = new JSDOM(fields.Sentence).window.document;
  assert.equal(sentence.body.textContent, draft.context.sentence);
  assert.equal(sentence.querySelectorAll('.target-word').length, 1);
  assert.equal(sentence.querySelector('.target-word')?.textContent, 'bound on');
  assert.ok(fields.Sentence.startsWith('😀 bound on, then <span'));
  if (mode === 'cloze') {
    assert.ok(preview.front.includes('[…]'));
    assert.equal(back.querySelector('.cloze .target-word')?.textContent, 'bound on');
  }
  assert.deepEqual(draft, before);
});

test('translation is inert escaped plain text, never cloze/media/HTML; target language and line breaks preserved', () => {
  const draft = fullMeaningsDraft();
  draft.sentenceTranslation = '<img src=x onerror=alert(1)> {{c2::answer}} [sound:bad.mp3]\nПеревод & текст';
  const back = new JSDOM(renderPreview(draft).back).window.document;
  assert.equal(back.querySelector('.sentence-translation-text')?.textContent, draft.sentenceTranslation);
  assert.equal(back.querySelectorAll('img,script').length, 0);
  const fields = buildNoteFields(operationId, draft, {lexemeKey:'',contentKey:''});
  assert.ok(!fields.Meaning.includes('{{c2::'));
  assert.ok(!fields.Meaning.includes('[sound:'));
  assert.equal(back.querySelector('.sentence-translation')?.getAttribute('lang'), 'ru');
});

test('legacy v3 drafts remain renderable and translation participates only in content identity', async () => {
  const draft = fullMeaningsDraft(), oldKeys = await semanticKeys(draft);
  assert.ok(!renderPreview(draft).back.includes('sentence-translation'));
  draft.sentenceTranslation = 'Я читаю книгу.';
  const newKeys = await semanticKeys(draft);
  assert.equal(newKeys.lexemeKey, oldKeys.lexemeKey);
  assert.notEqual(newKeys.contentKey, oldKeys.contentKey);
  draft.sentenceTranslation = 'Я прочитал книгу.';
  assert.notEqual((await semanticKeys(draft)).contentKey, newKeys.contentKey);
  delete draft.sentenceTranslation;
  assert.deepEqual(await semanticKeys(draft), oldKeys);
});
