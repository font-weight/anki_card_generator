import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_FIELDS, MODEL_NAMES, buildNoteFields, buildClozeSentence, escapeAnkiText, modelDefinition, semanticKeys, renderPreview, validMediaFilename, safeSourceUrl } from '../packages/note-templates/src/index.ts';
import type { NoteDraft } from '../packages/contracts/src/index.ts';
const draft = (): NoteDraft => ({ sourceLanguage: 'en', targetLanguage: 'ru', mode: 'recognition', deckName: 'Английский', tags: [],
  expression: 'read', lemma: 'read', partOfSpeech: 'verb', selectedSense: { id: 'unstable', translations: ['читать'], definitionEn: 'To understand written words.' },
  context: { sentence: 'I read and read.', targetStart: 11, targetEnd: 15 },
  pronunciation: { ipa: '/riːd/', dialect: 'en-US', source: 'generated', sourceUrl: null }, extraExample: null,
  source: { kind: 'html', title: 'Book', url: 'https://example.com/book?a=1&b=2', documentId: null, page: null, chapter: null, cfi: null } });
const id = '11111111-1111-4111-8111-111111111111';

test('exact official field order with OperationId first and one card per model', () => {
  assert.equal(NOTE_FIELDS[0], 'OperationId'); assert.equal(NOTE_FIELDS.length, 18);
  for (const mode of ['recognition', 'cloze'] as const) {
    const model = modelDefinition(mode); assert.equal(model.modelName, MODEL_NAMES[mode]);
    assert.deepEqual(model.inOrderFields, NOTE_FIELDS); assert.equal(model.cardTemplates.length, 1);
    assert.equal(model.isCloze, mode === 'cloze');
  }
});
test('only selected repeated occurrence becomes c1; original range is not normalized', () => {
  assert.equal(buildClozeSentence(draft()), 'I read and {{c1::read}}.');
  const invalid = draft(); invalid.context.targetStart = 0;
  assert.throws(() => buildClozeSentence(invalid), { code: 'INVALID_INPUT' });
});
test('source HTML, malicious cloze, sound and LaTeX syntax are neutralized', () => {
  const text = '<img src=x onerror="boom"> {{c9::answer}} [sound:evil.mp3] [latex]bad[/latex] &';
  const escaped = escapeAnkiText(text);
  assert.ok(!escaped.includes('<')); assert.ok(!escaped.includes('{{')); assert.ok(!escaped.includes('[sound:'));
  assert.ok(!escaped.includes('[latex]')); assert.ok(escaped.includes('&amp;'));
  const d = draft(); d.context = { sentence: text + ' read', targetStart: text.length + 1, targetEnd: text.length + 5 };
  const cloze = buildClozeSentence(d); assert.equal((cloze.match(/\{\{c1::/g) ?? []).length, 1); assert.ok(!cloze.includes('{{c9'));
});
test('generated content escaped, URL allowlist and local path exclusion', async () => {
  const d = draft(); d.selectedSense.translations = ['<script>alert(1)</script>'];
  d.extraExample = { textEn: '<svg/onload=x>', textRu: '{{c8::скрыто}}', source: 'ai' };
  d.source.url = 'javascript:alert(1)'; d.source.title = 'C:\\Users\\person\\secret.pdf';
  const fields = buildNoteFields(id, d, await semanticKeys(d));
  assert.equal(fields.SourceURL, ''); assert.equal(fields.SourceTitle, 'Локальный документ');
  assert.ok(!fields.Meaning.includes('<')); assert.ok(!fields.ExtraExampleTranslation.includes('{{'));
  assert.match(fields.IPASource, /Приблизительно/); assert.deepEqual(Object.keys(fields), NOTE_FIELDS);
  assert.equal(safeSourceUrl('file:///Users/me/book.pdf'), '');
  assert.equal(safeSourceUrl('https://name:secret@example.com/'), '');
});
test('cloze front contains no answer field or audio; preview hides exactly selected text', () => {
  const d = draft(); d.mode = 'cloze'; d.expression = 'unique'; d.context = { sentence: 'A unique word.', targetStart: 2, targetEnd: 8 };
  const tpl = modelDefinition('cloze').cardTemplates[0]!;
  assert.ok(!tpl.Front.includes('{{Expression}}')); assert.ok(!tpl.Front.includes('{{Audio}}'));
  const preview = renderPreview(d, { audioFilename: 'ответ.mp3' });
  assert.ok(!preview.front.includes('unique')); assert.ok(!preview.front.includes('Аудио')); assert.match(preview.back, /unique/);
  assert.match(preview.back, /Аудио будет добавлено/); assert.ok(!preview.back.includes('[sound:'));
});
test('semantic hashes ignore transient sense ids but distinguish meaning/context/mode', async () => {
  const d = draft(); const original = await semanticKeys(d);
  d.selectedSense.id = 'new-id'; assert.deepEqual(await semanticKeys(d), original);
  d.lemma = ' READ '; d.partOfSpeech = 'VERB'; assert.deepEqual(await semanticKeys(d), original);
  d.selectedSense.translations = ['прочитать']; const changed = await semanticKeys(d);
  assert.equal(changed.lexemeKey, original.lexemeKey); assert.notEqual(changed.contentKey, original.contentKey);
  d.mode = 'cloze'; assert.notEqual((await semanticKeys(d)).contentKey, changed.contentKey);
});
test('safe returned Cyrillic media filename is used literally and injection rejected', async () => {
  const d = draft(); const fields = buildNoteFields(id, d, await semanticKeys(d), 'произношение (1).mp3');
  assert.equal(fields.Audio, '[sound:произношение (1).mp3]');
  for (const bad of ['../x.mp3', 'x].mp3', 'https://x/a.mp3', 'x.mp3\n', 'x".mp3']) assert.equal(validMediaFilename(bad), false);
  assert.throws(() => buildNoteFields(id, d, { lexemeKey: '', contentKey: '' }, 'x].mp3'), { code: 'AUDIO_UNAVAILABLE' });
});
test('EPUB preserves chapter/CFI but never invents a page; PDF page starts at supplied one', async () => {
  const d = draft(); d.source = { kind: 'epub', title: 'Book', url: null, documentId: 'sha256:example', page: null, chapter: 'Глава 2', cfi: 'epubcfi(/6/4!/4/2)' };
  const fields = buildNoteFields(id, d, await semanticKeys(d)); assert.match(fields.SourceLocation, /Глава 2/); assert.ok(!fields.SourceLocation.includes('Страница'));
  d.source = { ...d.source, kind: 'pdf', page: 1, chapter: null, cfi: null };
  assert.equal(buildNoteFields(id, d, await semanticKeys(d)).SourceLocation, 'Страница 1');
});

test('source URLs drop credentials-bearing query and fragment before Anki/preview', () => {
  assert.equal(safeSourceUrl('https://example.com/chapter?token=private#access_token=secret'), 'https&#58;//example.com/chapter');
  const d = draft(); d.source.url = 'https://example.com/book?secret=private#hidden';
  const preview = renderPreview(d); assert.ok(!preview.back.includes('private')); assert.ok(!preview.back.includes('hidden'));
  assert.equal(d.source.url, 'https://example.com/book?secret=private#hidden', 'confirmed snapshot is not mutated');
});
