import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioService, createAudioInputCacheKey, createDraftAudioSnapshot, freezeAudioInput, validateAudioSnapshot,
  type AudioCache, type FullMeaningsAudioDraft, type LocalAudioEntry, type MultilingualAudioDraft,
} from '../packages/services/src/audio.ts';

const first = { id: 'hello', translations: ['привет', 'здравствуйте', 'добрый день', 'приветствие'], definition: 'Une salutation.' };
const second = { id: 'meeting', translations: ['встреча'], definition: 'Une rencontre amicale.' };
const draft: FullMeaningsAudioDraft = {
  draftVersion: 3, sourceLanguage: 'fr', targetLanguage: 'ru', expression: 'bonjour', lemma: 'bonjour', partOfSpeech: 'interjection',
  selectedSense: first, senses: [first, second], context: { sentence: 'Je dis bonjour.', targetStart: 7, targetEnd: 14 },
  pronunciation: { ipa: '/bɔ̃ʒuʁ/', dialect: 'fr-FR', source: 'generated', sourceUrl: null },
};
const preferences = { dialect: 'fr-FR' as const, speed: .85 };
const bytes = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1]);
function cache(): AudioCache & { entries: LocalAudioEntry[] } {
  const entries: LocalAudioEntry[] = [];
  return { entries, getById: async id => entries.find(entry => entry.audioId === id) ?? null,
    getByCacheKey: async key => entries.find(entry => entry.cacheKey === key) ?? null,
    put: async entry => { entries.push(entry); } };
}

test('v2 snapshot bytes and semantic hashes stay unchanged with v3 audio support', async () => {
  const frozen = freezeAudioInput({ text: 'bonjour', context: 'Je dis bonjour.', pronunciation: '/bɔ̃ʒuʁ/', sourceLanguage: 'fr', targetLanguage: 'ru', locale: 'fr-FR', speed: .85, cacheDiscriminator: 'v2-fixed' });
  assert.equal(JSON.stringify(frozen), '{"snapshotVersion":2,"sourceLanguage":"fr","targetLanguage":"ru","locale":"fr-FR","text":"bonjour","context":"Je dis bonjour.","pronunciation":"/bɔ̃ʒuʁ/","cacheDiscriminator":"v2-fixed","dialect":"fr-FR","speed":0.85,"voice":"coral","model":"gpt-4o-mini-tts","format":"mp3"}');
  assert.equal(await createAudioInputCacheKey(frozen), 'sha256:984a41ef8a745ecb2852ff5b68673e5d018b9f767a22d2a968f1b5ebe077610c');
  const v2: MultilingualAudioDraft = { ...draft, draftVersion: 2, selectedSense: { ...first, translations: ['привет'] } };
  const snapshot = await createDraftAudioSnapshot(v2, preferences);
  assert.equal(snapshot.cacheDiscriminator, 'draft-v2:ca5cc646311c84a3edec2310d816f026a96271cdee9116daa3ad928b1a644da7');
  assert.equal(await createAudioInputCacheKey(snapshot), 'sha256:b99aad641401f6bd464000d32e8f9cb1fefdd67d8e1231bdfdac582cb5b018a6');
});

test('v3 freezes all meanings and raw IPA before any asynchronous hashing', async () => {
  const mutable = structuredClone(draft), settings = { ...preferences };
  const pending = createDraftAudioSnapshot(mutable, settings);
  mutable.senses[1]!.definition = 'Changed after capture.';
  mutable.senses[0]!.translations[3] = 'changed fourth translation';
  mutable.pronunciation.ipa = '[bɔ̃ʒuʁ]';
  settings.speed = 2;
  const frozen = await pending;
  assert.equal(frozen.snapshotVersion, 3);
  assert.equal(frozen.pronunciation, '/bɔ̃ʒuʁ/');
  assert.equal(frozen.speed, .85);
  assert.equal(Object.isFrozen(frozen), true);
  assert.match(frozen.cacheDiscriminator, /^draft-v3:[a-f0-9]{64}$/);
  assert.deepEqual(validateAudioSnapshot(structuredClone(frozen)), frozen);
  assert.deepEqual(frozen, await createDraftAudioSnapshot(draft, preferences));
  assert.notEqual(await createAudioInputCacheKey(frozen), await createAudioInputCacheKey(await createDraftAudioSnapshot(mutable, preferences)));
});

test('v3 identity binds every ordered definition, translation, context and raw pronunciation but not unstable model IDs', async () => {
  const baseline = await createAudioInputCacheKey(await createDraftAudioSnapshot(draft, preferences));
  const variants: FullMeaningsAudioDraft[] = [];
  for (let index = 0; index < draft.senses.length; index++) {
    const definition = structuredClone(draft); definition.senses[index]!.definition += ' Changed.'; variants.push(definition);
    for (let translation = 0; translation < draft.senses[index]!.translations.length; translation++) {
      const changed = structuredClone(draft); changed.senses[index]!.translations[translation] += ' изменено'; variants.push(changed);
    }
  }
  const reordered = structuredClone(draft); reordered.senses.reverse(); reordered.selectedSense = reordered.senses[0]!; variants.push(reordered);
  const fewer = structuredClone(draft); fewer.senses.pop(); variants.push(fewer);
  variants.push({ ...draft, pronunciation: { ...draft.pronunciation, ipa: '[bɔ̃ʒuʁ]' } });
  variants.push({ ...draft, context: { ...draft.context, targetStart: 6 } });
  variants.push({ ...draft, targetLanguage: 'de' });
  for (const changed of variants) assert.notEqual(await createAudioInputCacheKey(await createDraftAudioSnapshot(changed, preferences)), baseline);
  const rerolled = structuredClone(draft); rerolled.senses.forEach((sense, index) => { sense.id = `new-${index}`; });
  assert.equal(await createAudioInputCacheKey(await createDraftAudioSnapshot(rerolled, preferences)), baseline);
});

test('v3 never aliases v2 cache and validates frozen source/locale/configuration', async () => {
  const frozen = await createDraftAudioSnapshot(draft, preferences);
  assert.notEqual(await createAudioInputCacheKey(frozen), await createAudioInputCacheKey({ ...frozen, snapshotVersion: 2 }));
  for (const invalid of [{ ...frozen, locale: 'en-US' }, { ...frozen, sourceLanguage: null }, { ...frozen, snapshotVersion: 4 }, { ...frozen, model: 'future' }, { ...frozen, senses: draft.senses }]) {
    assert.throws(() => validateAudioSnapshot(invalid), { code: 'AUDIO_UNAVAILABLE' });
  }
});

test('v3 mock preparation deduplicates, previews identical bytes, and keeps meanings/provider secrets local', async () => {
  const local = cache();
  let requests = 0, played: LocalAudioEntry | undefined;
  const audio = new AudioService({ cache: local, hasCloudAudioConsent: () => true, getOpenAIKey: () => 'offline-test-only',
    fetch: async (_url, options) => {
      requests++;
      const body = JSON.parse(String(options?.body));
      assert.equal(body.input, 'bonjour'); assert.match(body.instructions, /fr-FR/); assert.doesNotMatch(body.instructions, /American|British/);
      assert.ok(body.instructions.includes('/bɔ̃ʒuʁ/')); assert.ok(!JSON.stringify(body).includes('привет'));
      assert.ok(!JSON.stringify(body).includes('Une rencontre')); assert.ok(!JSON.stringify(body).includes('draft-v3'));
      return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } });
    }, playback: { listVoices: async () => [], speakLocal: async () => {}, playMp3: async entry => { played = entry; } } });
  const snapshot = await createDraftAudioSnapshot(draft, preferences);
  const [first, second] = await Promise.all([audio.prepare(snapshot), audio.prepare(snapshot)]);
  assert.equal(first.metadata.audioId, second.metadata.audioId); assert.equal(requests, 1); assert.equal(first.metadata.sourceLanguage, 'fr');
  await audio.playCached(first.metadata.audioId);
  assert.equal(played?.audioId, first.metadata.audioId); assert.deepEqual(played?.bytes, bytes);
  assert.equal((await audio.prepare(snapshot)).metadata.audioId, first.metadata.audioId); assert.equal(requests, 1);
  const changed = structuredClone(draft); changed.senses[1]!.definition += ' Different.';
  assert.notEqual((await audio.prepare(await createDraftAudioSnapshot(changed, preferences))).metadata.audioId, first.metadata.audioId);
  assert.equal(requests, 2);
});
