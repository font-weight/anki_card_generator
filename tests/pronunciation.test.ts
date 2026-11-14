import test from 'node:test';
import assert from 'node:assert/strict';
import { PronunciationService, parseDictionaryPronunciations } from '../packages/services/src/pronunciation.ts';

const entry = (word: string, texts: string[]) => [{ word, phonetics: texts.map(text => ({ text })),
  sourceUrls: ['https://en.wiktionary.org/wiki/' + word], license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' } }];
const service = (data: unknown, consent = true) => new PronunciationService({
  fetch: async () => new Response(JSON.stringify(data)), hasDictionaryConsent: () => consent,
});

test('dictionary sends only the word to the fixed endpoint after opt-in', async () => {
  let called = false;
  const adapter = new PronunciationService({ hasDictionaryConsent: () => true, fetch: async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.dictionaryapi.dev/api/v2/entries/en/hello');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.body, undefined);
    assert.equal(options?.headers, undefined);
    return new Response(JSON.stringify(entry('hello', ['/həˈloʊ/'])));
  } });
  const result = await adapter.get({ expression: 'Hello', dialect: 'en-US' });
  assert.equal(called, true);
  assert.equal(result.pronunciation.source, 'dictionary');
  assert.equal(result.pronunciation.dialect, 'unknown');
  assert.deepEqual(result.warnings, ['DICTIONARY_DIALECT_UNVERIFIED', 'DICTIONARY_CONTEXT_UNVERIFIED']);
  assert.equal(result.alternatives[0]!.licenses[0]!.name, 'CC BY-SA 3.0');
});

test('no dictionary request without saved consent', async () => {
  const adapter = new PronunciationService({ hasDictionaryConsent: () => false, fetch: async () => { throw new Error('must not fetch'); } });
  const result = await adapter.get({ expression: 'hello', dialect: 'en-GB' });
  assert.equal(result.pronunciation.source, 'unavailable');
  assert.deepEqual(result.warnings, ['DICTIONARY_DISABLED']);
});

for (const expression of ['put up with', 'https://attacker.invalid/', '../secret', 'word?context=private', 'a'.repeat(101)]) {
  test(`dictionary rejects non-word disclosure: ${expression.slice(0, 30)}`, async () => {
    let calls = 0;
    const adapter = new PronunciationService({ hasDictionaryConsent: () => true, fetch: async () => { calls++; return new Response('[]'); } });
    const result = await adapter.get({ expression, dialect: 'en-US' });
    assert.equal(calls, 0);
    assert.ok(result.warnings.includes('DICTIONARY_WORD_ONLY'));
  });
}

for (const [word, variants] of [['read', ['/riːd/', '/rɛd/']], ['lead', ['/liːd/', '/lɛd/']], ['close', ['/kləʊz/', '/kləʊs/']]] as const) {
  test(`${word}: never select the first dictionary homograph or invent a dialect`, async () => {
    const result = await service(entry(word, [...variants])).get({ expression: word, dialect: 'en-US' });
    assert.equal(result.pronunciation.source, 'unavailable');
    assert.equal(result.alternatives.length, 2);
    assert.ok(result.alternatives.every(item => item.dialect === 'unknown'));
    assert.ok(result.warnings.includes('PRONUNCIATION_AMBIGUOUS'));
  });
}

test('known homograph stays unverified even when dictionary incompletely returns one IPA', async () => {
  const result = await service(entry('read', ['/riːd/'])).get({ expression: 'read', dialect: 'en-GB' });
  assert.equal(result.pronunciation.ipa, null);
  assert.ok(result.warnings.includes('PRONUNCIATION_AMBIGUOUS'));
});

test('generated context candidate stays generated beside ambiguous dictionary results', async () => {
  const result = await service(entry('read', ['/riːd/', '/rɛd/'])).get({
    expression: 'read', dialect: 'en-US', generatedCandidate: { ipa: '/rɛd/', dialect: 'en-US' },
  });
  assert.deepEqual(result.pronunciation, { ipa: '/rɛd/', dialect: 'en-US', source: 'generated', sourceUrl: null });
  assert.ok(result.warnings.includes('GENERATED_IPA_APPROXIMATE'));
});

test('source metadata and licenses are preserved without using audio filenames as dialect evidence', () => {
  const result = parseDictionaryPronunciations([{ word: 'hello', phonetics: [
    { text: '/həˈloʊ/', audio: 'https://example.org/hello-us.mp3', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Hello.ogg',
      license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }, dialect: 'en-US' },
    { text: '/həˈloʊ/' },
  ], sourceUrls: ['javascript:alert(1)', 'https://en.wiktionary.org/wiki/hello'],
  license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' } }], 'hello');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.dialect, 'unknown');
  assert.equal(result[0]!.sourceUrls.length, 2);
  assert.deepEqual(result[0]!.licenses.map(item => item.scope), ['entry', 'phonetic']);
  assert.ok(!JSON.stringify(result).includes('javascript:'));
  assert.ok(!JSON.stringify(result).includes('hello-us.mp3'));
});

test('unrelated dictionary word entries cannot supply IPA', () => {
  assert.deepEqual(parseDictionaryPronunciations(entry('other', ['/x/']), 'hello'), []);
});

test('404 and unavailable dictionary never block generated fallback', async () => {
  for (const response of [new Response('{}', { status: 404 }), new Response('not JSON'), new Response('secret diagnostic', { status: 500 })]) {
    const adapter = new PronunciationService({ hasDictionaryConsent: () => true, fetch: async () => response });
    const result = await adapter.get({ expression: 'hello', dialect: 'en-US', generatedCandidate: { ipa: '/həˈloʊ/', dialect: 'en-US' } });
    assert.equal(result.pronunciation.source, 'generated');
    assert.ok(!JSON.stringify(result).includes('secret diagnostic'));
  }
});

test('dictionary timeout is bounded and optional', async () => {
  let signal: AbortSignal | null | undefined;
  const adapter = new PronunciationService({ hasDictionaryConsent: () => true, timeoutMs: 5, fetch: async (_, options) => {
    signal = options?.signal; return await new Promise<Response>(() => {});
  } });
  const result = await adapter.get({ expression: 'hello', dialect: 'en-US' });
  assert.equal(signal?.aborted, true);
  assert.ok(result.warnings.includes('DICTIONARY_UNAVAILABLE'));
});

test('dictionary oversized body is refused without parsing', async () => {
  const adapter = new PronunciationService({ hasDictionaryConsent: () => true, fetch: async () => new Response('x'.repeat(513 * 1024)) });
  const result = await adapter.get({ expression: 'hello', dialect: 'en-US' });
  assert.ok(result.warnings.includes('DICTIONARY_UNAVAILABLE'));
});

test('invalid input and invalid generated IPA are rejected', async () => {
  await assert.rejects(service([]).get({ expression: '', dialect: 'en-US' }), { code: 'INVALID_INPUT' });
  await assert.rejects(service([]).get({ expression: 'hi', dialect: 'en-US', generatedCandidate: { ipa: 'x', dialect: 'en-AU' } }), { code: 'INVALID_INPUT' });
});
