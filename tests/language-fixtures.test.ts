/**
 * Offline fixture-integrity checks, NOT a model-quality evaluation.
 *
 * Run from the repository root:
 *   node --experimental-strip-types --test tests/language-fixtures.test.ts
 *
 * Node built-ins, local JSON, and the pure production input validator are used.
 * No API key, instantiated model client, third-party package, or network is needed.
 * Semantic scoring must be performed separately with independent review.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateLookupInput } from '../packages/services/src/openai.ts';

type JsonObject = Record<string, any>;

const fixtureUrl = new URL('../fixtures/language.json', import.meta.url);
const dataset = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as JsonObject;
const fixtures = dataset.fixtures as JsonObject[];

const requiredCategoryCounts = {
  polysemy: 30,
  phrasal_verb: 20,
  idiom: 15,
  irregular_form: 20,
  negation: 10,
  homograph: 12,
  insufficient_context: 10,
  prompt_injection: 8,
  range_fidelity: 6,
  context_resolution: 4,
} as const;
const categories = new Set(Object.keys(requiredCategoryCounts));
const partsOfSpeech = new Set([
  'noun', 'verb', 'adjective', 'adverb', 'conjunction', 'determiner',
  'modal verb', 'phrase', 'idiom',
]);
const authorIdentity = 'dot_b/contextual-language-fixtures';

function object(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
}

function text(value: unknown, label: string, maximum = 1500): asserts value is string {
  assert.equal(typeof value, 'string', label);
  assert.ok((value as string).trim().length > 0, `${label}: empty`);
  assert.ok((value as string).length <= maximum, `${label}: too long`);
}

function keys(value: JsonObject, required: string[], optional: string[], label: string) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert.ok(Object.hasOwn(value, key), `${label}: missing ${key}`);
  for (const key of Object.keys(value)) assert.ok(allowed.has(key), `${label}: unexpected ${key}`);
}

function isUtf16Boundary(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return true;
  const left = value.charCodeAt(index - 1);
  const right = value.charCodeAt(index);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function validateInput(input: unknown, label: string) {
  object(input, label);
  keys(input, [
    'expression', 'context', 'sourceLanguage', 'targetLanguage', 'learnerLevel', 'dialect',
  ], [], label);
  text(input.expression, `${label}.expression`, 200);
  assert.equal(input.expression, input.expression.trim(), `${label}: expression whitespace`);
  const wordCount = input.expression.split(/\s+/u).length;
  assert.ok(wordCount >= 1 && wordCount <= 5, `${label}: select one to five words`);
  assert.equal(input.sourceLanguage, 'en');
  assert.equal(input.targetLanguage, 'ru');
  assert.equal(input.learnerLevel, 'B1');
  assert.ok(['en-US', 'en-GB'].includes(input.dialect), `${label}: dialect`);
  const context = input.context;
  object(context, `${label}.context`);
  keys(context, ['sentence', 'targetStart', 'targetEnd'], ['before', 'after'], `${label}.context`);
  text(context.sentence, `${label}.sentence`);
  let contextLength = context.sentence.length;
  for (const side of ['before', 'after']) {
    if (Object.hasOwn(context, side)) {
      text(context[side], `${label}.${side}`);
      contextLength += context[side].length;
    }
  }
  assert.ok(contextLength <= 1500, `${label}: total UTF-16 context limit`);
  assert.ok(Number.isInteger(context.targetStart), `${label}: integer targetStart`);
  assert.ok(Number.isInteger(context.targetEnd), `${label}: integer targetEnd`);
  assert.ok(context.targetStart >= 0, `${label}: nonnegative start`);
  assert.ok(context.targetEnd > context.targetStart, `${label}: nonempty range`);
  assert.ok(context.targetEnd <= context.sentence.length, `${label}: range within sentence`);
  assert.ok(isUtf16Boundary(context.sentence, context.targetStart), `${label}: start splits surrogate`);
  assert.ok(isUtf16Boundary(context.sentence, context.targetEnd), `${label}: end splits surrogate`);
  assert.equal(
    context.sentence.slice(context.targetStart, context.targetEnd),
    input.expression,
    `${label}: exact source slice, without normalizing`,
  );
}

function validateExpected(expected: unknown, label: string) {
  object(expected, label);
  keys(expected, [
    'lemma', 'partOfSpeech', 'contextAmbiguous', 'recommendedSense', 'senses', 'extraExample',
  ], ['notes', 'pronunciationNote', 'excludedMeaningsEn'], label);
  text(expected.lemma, `${label}.lemma`, 100);
  assert.ok(partsOfSpeech.has(expected.partOfSpeech), `${label}: part of speech`);
  assert.equal(typeof expected.contextAmbiguous, 'boolean');
  assert.equal(expected.extraExample, null, `${label}: no unsolicited enrichment`);
  assert.ok(Array.isArray(expected.senses), `${label}: senses array`);
  assert.ok(expected.senses.length >= 1 && expected.senses.length <= 4, `${label}: one to four senses`);
  const senseKeys = new Set<string>();
  const meanings = new Set<string>();
  for (const sense of expected.senses) {
    object(sense, `${label}.sense`);
    keys(sense, ['key', 'meaningEn', 'acceptableRussianVariants'], [], `${label}.sense`);
    text(sense.key, `${label}.sense.key`, 80);
    assert.match(sense.key, /^[a-z][a-z0-9_]*$/);
    assert.ok(!senseKeys.has(sense.key), `${label}: duplicate sense key`);
    senseKeys.add(sense.key);
    text(sense.meaningEn, `${label}.sense.meaningEn`, 300);
    assert.match(sense.meaningEn, /[A-Za-z]/u, `${label}: English definition`);
    assert.doesNotMatch(sense.meaningEn, /[А-Яа-яЁё]/u, `${label}: English definition language`);
    const meaning = sense.meaningEn.toLocaleLowerCase('en-US');
    assert.ok(!meanings.has(meaning), `${label}: distinct candidate meanings`);
    meanings.add(meaning);
    assert.ok(Array.isArray(sense.acceptableRussianVariants), `${label}: Russian variants array`);
    assert.ok(
      sense.acceptableRussianVariants.length >= 1 && sense.acceptableRussianVariants.length <= 3,
      `${label}: one to three Russian variants per sense`,
    );
    const translations = new Set<string>();
    for (const variant of sense.acceptableRussianVariants) {
      text(variant, `${label}.variant`, 100);
      assert.match(variant, /[А-Яа-яЁё]/u, `${label}: Russian equivalent`);
      assert.equal(variant, variant.trim(), `${label}: variant whitespace`);
      assert.ok(!translations.has(variant), `${label}: duplicate Russian equivalent`);
      translations.add(variant);
    }
  }
  object(expected.recommendedSense, `${label}.recommendedSense`);
  keys(expected.recommendedSense, ['policy', 'senseKey'], [], `${label}.recommendedSense`);
  if (expected.contextAmbiguous) {
    assert.equal(expected.recommendedSense.policy, 'must_be_null', `${label}: do not guess`);
    assert.equal(expected.recommendedSense.senseKey, null);
    assert.ok(expected.senses.length >= 2, `${label}: ambiguous meanings are separate candidates`);
  } else {
    assert.equal(expected.recommendedSense.policy, 'required', `${label}: recommend resolved meaning`);
    assert.ok(senseKeys.has(expected.recommendedSense.senseKey), `${label}: recommended key exists`);
  }
  for (const field of ['notes', 'pronunciationNote']) {
    if (Object.hasOwn(expected, field)) text(expected[field], `${label}.${field}`);
  }
  if (Object.hasOwn(expected, 'excludedMeaningsEn')) {
    assert.ok(Array.isArray(expected.excludedMeaningsEn));
    assert.ok(expected.excludedMeaningsEn.length > 0);
    for (const meaning of expected.excludedMeaningsEn) text(meaning, `${label}.excludedMeaning`, 300);
  }
  // No output-field provenance or numeric confidence is invented by the reference.
  assert.ok(!Object.hasOwn(expected, 'confidence'));
  assert.ok(!Object.hasOwn(expected, 'sourceUrl'));
  assert.ok(!Object.hasOwn(expected, 'lookupId'));
}

function validateProvenance(provenance: unknown, label: string) {
  object(provenance, label);
  keys(provenance, [
    'origin', 'authorIdentity', 'source', 'reviews', 'humanVetted',
  ], [], label);
  assert.equal(provenance.origin, 'synthetic-agent-authored');
  assert.equal(provenance.authorIdentity, authorIdentity);
  text(provenance.source, `${label}.source`);
  assert.equal(typeof provenance.humanVetted, 'boolean');
  assert.ok(Array.isArray(provenance.reviews));
  assert.equal(provenance.reviews.length, 3, `${label}: disclose each review class separately`);
  const types = new Set<string>();
  for (const review of provenance.reviews) {
    object(review, `${label}.review`);
    keys(review, ['reviewerIdentity', 'reviewerType', 'status', 'scope'],
      ['reviewedOn', 'evidenceRef', 'findings'], `${label}.review`);
    assert.ok(['author-agent', 'independent-agent', 'human'].includes(review.reviewerType));
    assert.ok(!types.has(review.reviewerType), `${label}: duplicate review class`);
    types.add(review.reviewerType);
    text(review.scope, `${label}.review.scope`);
    if (review.reviewerType === 'author-agent') {
      assert.equal(review.status, 'self_checked');
      assert.equal(review.reviewerIdentity, provenance.authorIdentity);
    } else if (review.status === 'not_run') {
      assert.equal(review.reviewerIdentity, null, `${label}: no invented reviewer`);
      assert.ok(!Object.hasOwn(review, 'reviewedOn'), `${label}: no invented review date`);
      assert.ok(!Object.hasOwn(review, 'evidenceRef'), `${label}: no invented evidence`);
    } else {
      assert.equal(review.status, 'reviewed');
      text(review.reviewerIdentity, `${label}.reviewerIdentity`);
      assert.notEqual(review.reviewerIdentity, provenance.authorIdentity, `${label}: independent identity`);
      assert.match(review.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
      text(review.evidenceRef, `${label}.review.evidenceRef`);
      text(review.findings, `${label}.review.findings`);
    }
  }
  assert.deepEqual([...types].sort(), ['author-agent', 'human', 'independent-agent']);
  const humanReview = provenance.reviews.find((review: JsonObject) => review.reviewerType === 'human');
  assert.equal(provenance.humanVetted, humanReview.status === 'reviewed');
}

function validateFixture(fixture: unknown) {
  object(fixture, 'fixture');
  keys(fixture, ['id', 'categories', 'input', 'expected', 'provenance'], [], 'fixture');
  text(fixture.id, 'fixture.id', 100);
  assert.match(fixture.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Array.isArray(fixture.categories));
  assert.ok(fixture.categories.length > 0);
  assert.equal(new Set(fixture.categories).size, fixture.categories.length, `${fixture.id}: unique categories`);
  for (const category of fixture.categories) assert.ok(categories.has(category), `${fixture.id}: category`);
  validateInput(fixture.input, fixture.id);
  validateExpected(fixture.expected, fixture.id);
  validateProvenance(fixture.provenance, fixture.id);
  if (fixture.categories.includes('insufficient_context')) {
    assert.equal(fixture.expected.contextAmbiguous, true, `${fixture.id}: ambiguous category consistency`);
  }
  if (fixture.categories.includes('prompt_injection')) {
    assert.match(fixture.expected.notes, /untrusted|data/i, `${fixture.id}: adversarial-text expectation`);
  }
}

function fixtureById(id: string): JsonObject {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  assert.ok(fixture, `missing fixture ${id}`);
  return fixture;
}

test('contains at least 150 independent lookup cases with the requested category diversity', () => {
  assert.equal(dataset.schemaVersion, '1.0.0');
  assert.equal(dataset.datasetId, 'english-reader-contextual-en-ru-v1');
  assert.deepEqual(dataset.languagePair, { sourceLanguage: 'en', targetLanguage: 'ru' });
  assert.ok(Array.isArray(fixtures));
  assert.ok(fixtures.length >= 150);
  for (const [category, minimum] of Object.entries(requiredCategoryCounts)) {
    const count = fixtures.filter((fixture) => fixture.categories.includes(category)).length;
    assert.ok(count >= minimum, `${category}: ${count} must be at least ${minimum}`);
  }
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.input.dialect)), new Set(['en-US', 'en-GB']));
});

test('all cases have valid lookup inputs, semantic expectations and honest review provenance', () => {
  for (const fixture of fixtures) validateFixture(fixture);
});

test('all fixture inputs are accepted by the actual production lookup validator', () => {
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => validateLookupInput(fixture.input), fixture.id);
  }
});

test('fixture IDs and full lookup inputs are unique', () => {
  const ids = new Set<string>();
  const inputs = new Set<string>();
  for (const fixture of fixtures) {
    assert.ok(!ids.has(fixture.id), `duplicate ID ${fixture.id}`);
    ids.add(fixture.id);
    const identity = JSON.stringify(fixture.input);
    assert.ok(!inputs.has(identity), `duplicate lookup input ${fixture.id}`);
    inputs.add(identity);
  }
});

test('contrast groups have consistent lemmas and distinct intended sense labels', () => {
  for (const ids of [
    ['poly-bank-money', 'poly-bank-river'],
    ['poly-bat-animal', 'poly-bat-sport'],
    ['poly-spring-season', 'poly-spring-coil', 'poly-spring-water'],
    ['phrasal-take-off-flight', 'phrasal-take-off-clothes'],
    ['phrasal-work-out-exercise', 'phrasal-work-out-solve'],
    ['homograph-lead-metal', 'homograph-lead-guide'],
    ['homograph-close-near', 'homograph-close-shut'],
  ]) {
    const group = ids.map(fixtureById);
    assert.equal(new Set(group.map((fixture) => fixture.expected.lemma)).size, 1, ids.join(', '));
    assert.equal(
      new Set(group.map((fixture) => fixture.expected.recommendedSense.senseKey)).size,
      group.length,
      `distinct meanings: ${ids.join(', ')}`,
    );
  }
  for (const id of [
    'homograph-read-present', 'homograph-read-past', 'homograph-read-participle',
    'homograph-lead-metal', 'homograph-lead-guide', 'homograph-close-near', 'homograph-close-shut',
  ]) text(fixtureById(id).expected.pronunciationNote, `${id}: pronunciation disambiguation`);
});

test('neighbouring context resolves identical sentences without word-only caching assumptions', () => {
  const ambiguous = fixtureById('ambiguous-bank');
  const before = fixtureById('context-bank-before');
  const after = fixtureById('context-bank-after');
  for (const fixture of [before, after]) {
    assert.equal(fixture.input.expression, ambiguous.input.expression);
    assert.equal(fixture.input.context.sentence, ambiguous.input.context.sentence);
    assert.equal(fixture.expected.contextAmbiguous, false);
    assert.equal(fixture.expected.recommendedSense.policy, 'required');
  }
  assert.equal(ambiguous.expected.contextAmbiguous, true);
  assert.notEqual(before.expected.recommendedSense.senseKey, after.expected.recommendedSense.senseKey);
});

test('UTF-16 spans preserve emoji, combining characters and non-first target occurrences', () => {
  for (const id of ['range-emoji-bank', 'range-emoji-read']) {
    const { expression, context } = fixtureById(id).input;
    assert.equal(context.targetStart, context.sentence.indexOf(expression));
    const codePointOffset = Array.from(context.sentence.slice(0, context.targetStart)).length;
    assert.ok(context.targetStart > codePointOffset, `${id}: detects code-point offsets`);
  }
  const combining = fixtureById('range-combining-mark').input;
  assert.ok(combining.context.sentence.includes('e\u0301'));
  assert.notEqual(combining.context.sentence, combining.context.sentence.normalize('NFC'));
  for (const id of ['range-repeat-bank-river', 'range-repeat-read-past', 'range-repeated-close']) {
    const { expression, context } = fixtureById(id).input;
    assert.ok(context.targetStart > context.sentence.indexOf(expression), `${id}: not first occurrence`);
  }
  const first = fixtureById('range-repeat-bank-money');
  const second = fixtureById('range-repeat-bank-river');
  assert.equal(first.input.context.sentence, second.input.context.sentence);
  assert.notEqual(first.input.context.targetStart, second.input.context.targetStart);
  assert.notEqual(first.expected.recommendedSense.senseKey, second.expected.recommendedSense.senseKey);
});

test('range validator rejects code-point offsets, normalization, mismatches and overlong context', () => {
  const emoji = structuredClone(fixtureById('range-emoji-bank').input);
  emoji.context.targetStart -= 1;
  emoji.context.targetEnd -= 1;
  assert.throws(() => validateInput(emoji, 'wrong emoji offsets'));

  const normalized = structuredClone(fixtureById('range-combining-mark').input);
  normalized.context.sentence = normalized.context.sentence.normalize('NFC');
  assert.throws(() => validateInput(normalized, 'normalized source'));

  const mismatch = structuredClone(fixtureById('poly-bank-river').input);
  mismatch.expression = 'river';
  assert.throws(() => validateInput(mismatch, 'mismatched slice'));

  const overlong = structuredClone(fixtureById('poly-bank-river').input);
  overlong.context.before = 'x'.repeat(1500);
  assert.throws(() => validateInput(overlong, 'overlong total context'));

  const negative = structuredClone(fixtureById('poly-bank-river').input);
  negative.context.targetStart = -1;
  assert.throws(() => validateInput(negative, 'negative range'));

  const unexpected = structuredClone(fixtureById('poly-bank-river').input);
  unexpected.sourceUrl = 'not-part-of-the-lookup-contract';
  assert.throws(() => validateInput(unexpected, 'unexpected data'));

  assert.equal(isUtf16Boundary('🛶 bank', 1), false);
  assert.equal(isUtf16Boundary('🛶 bank', 2), true);
});

test('ambiguous cases require null recommendation and separate meanings', () => {
  const ambiguous = fixtures.filter((fixture) => fixture.expected.contextAmbiguous);
  assert.ok(ambiguous.length >= 10);
  for (const fixture of ambiguous) {
    assert.equal(fixture.expected.recommendedSense.policy, 'must_be_null');
    assert.equal(fixture.expected.recommendedSense.senseKey, null);
    assert.ok(fixture.expected.senses.length >= 2 && fixture.expected.senses.length <= 4);
  }
  const invalid = structuredClone(fixtureById('ambiguous-bank').expected);
  invalid.recommendedSense = { policy: 'required', senseKey: 'financial_institution' };
  assert.throws(() => validateExpected(invalid, 'unjustified recommendation'));
});

test('independent review shortlist is nonempty, refers to real hard cases, and claims no completed review', () => {
  const request = dataset.independentReviewRequest;
  assert.equal(request.requestedReviewer, 'dot_a');
  assert.equal(request.status, 'pending_parent_coordination');
  assert.ok(request.fixtureIds.length >= 10);
  assert.equal(new Set(request.fixtureIds).size, request.fixtureIds.length);
  const selected = request.fixtureIds.map(fixtureById);
  for (const category of ['homograph', 'negation', 'prompt_injection', 'insufficient_context', 'range_fidelity']) {
    assert.ok(selected.some((fixture: JsonObject) => fixture.categories.includes(category)), category);
  }
});

test('self-checks cannot be relabelled as independent or human review without evidence', () => {
  const source = fixtureById('poly-bank-money');
  const sample = structuredClone(source.provenance);
  sample.reviews[1] = {
    reviewerIdentity: authorIdentity,
    reviewerType: 'independent-agent',
    status: 'reviewed',
    scope: 'Claimed independent review.',
    reviewedOn: '2026-10-20',
    evidenceRef: 'synthetic-invalid-example',
    findings: 'Invalid because the author is also the reviewer.',
  };
  assert.throws(() => validateProvenance(sample, 'same-author independent claim'));
  const human = structuredClone(source.provenance);
  human.humanVetted = true;
  assert.throws(() => validateProvenance(human, 'unperformed human review'));
});

test('95% is an unmeasured target, not a score inferred from passing structure tests', () => {
  assert.equal(dataset.evaluation.minimumFixtureCount, 150);
  assert.equal(dataset.evaluation.targetCorrectContextualMeaningRate, 0.95);
  assert.equal(dataset.evaluation.targetIsMeasuredResult, false);
  assert.deepEqual(dataset.evaluation.liveModelEvaluation, {
    status: 'not_run',
    model: null,
    sampleCount: 0,
    correctCount: null,
    observedCorrectContextualMeaningRate: null,
  });
  assert.match(dataset.evaluation.automatedChecksDoNotEstablish, /accuracy/i);
  assert.ok(dataset.evaluation.semanticScoringGuidance.length >= 5);
  assert.match(dataset.description, /not human-certified/i);
});

test('validating the complete dataset requires no live calls or credentials', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('Network is forbidden in offline language-fixture integrity tests.');
  }) as typeof fetch;
  try {
    for (const fixture of fixtures) {
      validateFixture(fixture);
      validateLookupInput(fixture.input);
    }
    assert.equal(fetchCalls, 0);
    const serialized = JSON.stringify(dataset);
    assert.doesNotMatch(serialized, /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u, 'no realistic API secrets');
    assert.doesNotMatch(serialized, /(?:https?:\/\/|file:\/\/|[A-Z]:\\\\Users\\\\)/u, 'no source URLs or private local paths');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
