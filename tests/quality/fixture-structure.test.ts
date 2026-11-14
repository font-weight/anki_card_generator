// @vitest-environment node
// Offline integrity checks only: no provider adapter, key access, or semantic scorer.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  DIALECTS, LANGUAGE_CODES, LEARNER_LEVELS, defaultLocale, validateRequest,
} from '../../packages/contracts/src/index.ts';

const text = z.string().min(1).max(1_500);
const tagSchema = z.enum([
  'polysemy', 'inflection', 'idiom', 'negation', 'false_friend', 'cjk', 'rtl',
  'grapheme', 'decomposed_unicode', 'astral_prefix', 'repeated_selection',
  'same_language', 'ambiguity', 'pronunciation_sensitive',
  'reverse_target', 'target_script', 'level_review', 'omitted_subject',
]);
const senseHintSchema = z.object({
  meaningInEnglish: text,
  // Empty for reverse probes: target-language answers need bilingual review.
  targetGlossCandidates: z.array(text).max(3),
  lemmaCandidate: text,
  partOfSpeechHint: text,
}).strict();
const candidateSchema = z.object({
  id: z.string().regex(/^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  coverageRole: z.enum(['source_probe', 'reverse_target_probe']),
  tags: z.array(tagSchema).min(1).refine(tags => new Set(tags).size === tags.length),
  input: z.object({
    expression: z.string().min(1).max(256),
    context: z.object({
      sentence: text,
      targetStart: z.number().int().nonnegative(),
      targetEnd: z.number().int().positive(),
      before: z.string().max(1_500).optional(),
      after: z.string().max(1_500).optional(),
    }).strict(),
    sourceLanguage: z.enum(LANGUAGE_CODES),
    targetLanguage: z.enum(LANGUAGE_CODES),
    learnerLevel: z.enum(LEARNER_LEVELS),
    dialect: z.enum(DIALECTS),
  }).strict(),
  authorship: z.literal('ai-authored-synthetic'),
  reviewStatus: z.literal('unreviewed'),
  expectedMeaningHints: z.object({
    status: z.literal('tentative-not-ground-truth'),
    contextClarity: z.enum(['apparently_clear', 'possibly_ambiguous']),
    possibleSenses: z.array(senseHintSchema).min(1).max(4),
    avoidReadings: z.array(text).max(5),
    reviewCaution: text,
  }).strict(),
  exampleReviewFocus: z.array(text).min(2).max(4),
  localeCaution: text,
}).strict();
const datasetSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.literal('multilingual-quality-candidates-v2'),
  authoredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  purpose: text,
  authorship: z.literal('ai-authored-synthetic'),
  reviewStatus: z.literal('unreviewed'),
  groundTruth: z.literal(false),
  semanticAccuracy: z.object({ status: z.literal('not_measured'), value: z.null() }).strict(),
  liveEvaluation: z.object({ status: z.literal('not_run'), resultCount: z.literal(0) }).strict(),
  offsetConvention: z.literal('zero-based UTF-16 code units; end exclusive; exact unnormalized original sentence'),
  sourceLanguages: z.array(z.enum(LANGUAGE_CODES)).length(17),
  limitations: z.array(text).min(5),
  cases: z.array(candidateSchema).length(53),
}).strict();

const dataset = datasetSchema.parse(JSON.parse(readFileSync(
  new URL('../fixtures/multilingual-quality-candidates.json', import.meta.url), 'utf8',
)) as unknown);
type Candidate = z.infer<typeof candidateSchema>;
const get = (id: string): Candidate => {
  const candidate = dataset.cases.find(item => item.id === id);
  if (!candidate) throw new Error(`Missing candidate: ${id}`);
  return candidate;
};

// This tripwire catches accidental Fetch use in this suite. It is not an OS-level
// network sandbox. All imports above are local validators or installed test tools.
const unexpectedFetch = vi.fn(() => { throw new Error('Offline fixture tests must not fetch'); });
beforeAll(() => { vi.stubGlobal('fetch', unexpectedFetch); });
afterAll(() => {
  try { expect(unexpectedFetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); }
});

function assertCandidate(value: unknown): void {
  const candidate = candidateSchema.parse(value);
  const { input } = candidate;
  const { sentence, targetStart, targetEnd } = input.context;
  expect(candidate.id.startsWith(`${input.sourceLanguage}-`)).toBe(true);
  expect(targetStart).toBeLessThan(targetEnd);
  expect(targetEnd).toBeLessThanOrEqual(sentence.length);
  expect(sentence.slice(targetStart, targetEnd)).toBe(input.expression);
  expect(input.dialect).toBe(defaultLocale(input.sourceLanguage));
  if (candidate.coverageRole === 'reverse_target_probe') {
    expect(input.sourceLanguage).toBe('ru');
    expect(['ru', 'en']).not.toContain(input.targetLanguage);
    expect(candidate.id.startsWith(`ru-to-${input.targetLanguage}-`)).toBe(true);
    expect(candidate.tags).toContain('reverse_target');
    for (const sense of candidate.expectedMeaningHints.possibleSenses) {
      expect(sense.targetGlossCandidates).toEqual([]);
    }
  } else {
    expect(candidate.tags).not.toContain('reverse_target');
    for (const sense of candidate.expectedMeaningHints.possibleSenses) {
      expect(sense.targetGlossCandidates.length).toBeGreaterThan(0);
    }
  }

  // Compute boundaries independently of the application's range helper; ICU
  // availability is required rather than substituting code-point counting.
  const boundaries = new Set([sentence.length]);
  for (const segment of new Intl.Segmenter(input.dialect, { granularity: 'grapheme' }).segment(sentence)) {
    boundaries.add(segment.index);
  }
  expect(boundaries.has(targetStart), `${candidate.id}: complete start grapheme`).toBe(true);
  expect(boundaries.has(targetEnd), `${candidate.id}: complete end grapheme`).toBe(true);
  expect(() => validateRequest({
    v: 1, requestId: '3fbc6d2e-806b-4cae-8878-6b11c46b6901', type: 'lookup', payload: input,
  }), `${candidate.id}: production lookup input compatibility`).not.toThrow();
}

describe('multilingual candidate integrity — not linguistic accuracy', () => {
  it('keeps explicit synthetic, unreviewed, unmeasured provenance', () => {
    expect(datasetSchema.safeParse(dataset).success).toBe(true);
    expect(dataset.groundTruth).toBe(false);
    expect(dataset.semanticAccuracy).toEqual({ status: 'not_measured', value: null });
    expect(dataset.liveEvaluation).toEqual({ status: 'not_run', resultCount: 0 });
    for (const candidate of dataset.cases) {
      expect(candidate.authorship).toBe('ai-authored-synthetic');
      expect(candidate.reviewStatus).toBe('unreviewed');
      expect(candidate.expectedMeaningHints.status).toBe('tentative-not-ground-truth');
    }
  });

  it('preserves 38 source probes across the current 17-language registry, two or three each', () => {
    expect(dataset.sourceLanguages).toEqual([...LANGUAGE_CODES]);
    expect(new Set(dataset.sourceLanguages).size).toBe(17);
    expect(new Set(dataset.cases.map(candidate => candidate.id)).size).toBe(dataset.cases.length);
    expect([...new Set(dataset.cases.map(candidate => candidate.input.sourceLanguage))].sort())
      .toEqual([...LANGUAGE_CODES].sort());
    const sourceProbes = dataset.cases.filter(candidate => candidate.coverageRole === 'source_probe');
    expect(sourceProbes).toHaveLength(38);
    for (const source of LANGUAGE_CODES) {
      const count = sourceProbes.filter(candidate => candidate.input.sourceLanguage === source).length;
      expect(count, source).toBeGreaterThanOrEqual(2);
      expect(count, source).toBeLessThanOrEqual(3);
    }
  });

  it('keeps original source probes aimed at Russian, Russian-to-English, or four same-language checks', () => {
    const sameLanguageSources: string[] = [];
    for (const { input, tags } of dataset.cases.filter(candidate => candidate.coverageRole === 'source_probe')) {
      if (input.sourceLanguage === input.targetLanguage) {
        sameLanguageSources.push(input.sourceLanguage);
        expect(tags).toContain('same_language');
      } else {
        expect(tags).not.toContain('same_language');
        expect(input.targetLanguage).toBe(input.sourceLanguage === 'ru' ? 'en' : 'ru');
      }
    }
    expect(sameLanguageSources.sort()).toEqual(['ar', 'en', 'fr', 'ja']);
  });

  it('adds exactly 15 reverse-target probes and covers 36 directed pairs, not all 289', () => {
    const reverse = dataset.cases.filter(candidate => candidate.coverageRole === 'reverse_target_probe');
    expect(reverse).toHaveLength(15);
    expect(reverse.map(candidate => candidate.input.targetLanguage).sort())
      .toEqual(LANGUAGE_CODES.filter(code => code !== 'ru' && code !== 'en').sort());
    expect([...new Set(dataset.cases.map(candidate => candidate.input.targetLanguage))].sort())
      .toEqual([...LANGUAGE_CODES].sort());
    const expectedPairs = [
      ...LANGUAGE_CODES.filter(code => code !== 'ru').flatMap(code => [`${code}->ru`, `ru->${code}`]),
      'en->en', 'fr->fr', 'ja->ja', 'ar->ar',
    ];
    const observedPairs = [...new Set(dataset.cases.map(candidate => `${candidate.input.sourceLanguage}->${candidate.input.targetLanguage}`))];
    expect(observedPairs).toHaveLength(36);
    expect(observedPairs.sort()).toEqual(expectedPairs.sort());
    expect(dataset.cases.filter(candidate => candidate.input.sourceLanguage === 'ru')).toHaveLength(17);
  });

  it('covers the declared lexical, script and original-selection stress categories', () => {
    const tags = new Set(dataset.cases.flatMap(candidate => candidate.tags));
    for (const tag of tagSchema.options) expect(tags.has(tag), tag).toBe(true);
    for (const source of ['zh', 'ja', 'ko']) {
      for (const candidate of dataset.cases.filter(item => item.input.sourceLanguage === source)) {
        expect(candidate.tags).toContain('cjk');
      }
    }
    for (const candidate of dataset.cases.filter(item => item.input.sourceLanguage === 'ar')) {
      expect(candidate.tags).toContain('rtl');
    }
  });

  it.each(dataset.cases)('$id preserves exact UTF-16 selection and passes the local input contract', assertCandidate);

  it('actually selects the later bank/chestnut occurrence rather than finding the first match', () => {
    for (const id of ['en-river-bank-repeated', 'ko-repeated-chestnut']) {
      const { input } = get(id);
      expect(input.context.targetStart).toBe(input.context.sentence.lastIndexOf(input.expression));
      expect(input.context.targetStart).toBeGreaterThan(input.context.sentence.indexOf(input.expression));
    }
  });

  it('contains genuine UTF-16 versus code-point offset differences after astral prefixes', () => {
    for (const candidate of dataset.cases.filter(item => item.tags.includes('astral_prefix'))) {
      const { sentence, targetStart } = candidate.input.context;
      expect(targetStart).toBeGreaterThan(Array.from(sentence.slice(0, targetStart)).length);
    }
  });

  it('retains decomposed French and Arabic/Hindi combining marks in original selected text', () => {
    const cafe = get('fr-decomposed-cafe').input;
    expect(cafe.expression).toBe('cafe\u0301');
    expect(cafe.expression).not.toBe(cafe.expression.normalize('NFC'));
    for (const id of ['ar-same-language-diacritic-book', 'hi-negated-tea']) {
      expect(get(id).input.expression).toMatch(/\p{Mark}/u);
    }
  });

  it('keeps alternative sense hints separate without pretending to score ambiguity', () => {
    const ambiguous = dataset.cases.filter(candidate => candidate.tags.includes('ambiguity'));
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const candidate of ambiguous) {
      expect(candidate.expectedMeaningHints.contextClarity).toBe('possibly_ambiguous');
      expect(candidate.expectedMeaningHints.possibleSenses.length).toBeGreaterThan(1);
    }
  });

  it('retains explicit level, omitted-subject and native-review cautions without certifying them', () => {
    const bat = get('en-same-language-ambiguous-bat');
    expect(bat.tags).toContain('level_review');
    for (const sense of bat.expectedMeaningHints.possibleSenses) {
      for (const gloss of sense.targetGlossCandidates) expect(gloss).not.toMatch(/\b(?:mammal|implement)\b/i);
    }
    expect(bat.expectedMeaningHints.reviewCaution).toContain('not been validated as A2-appropriate');
    expect(get('ar-same-language-diacritic-book').expectedMeaningHints.reviewCaution).toMatch(/too advanced.*A2/);
    for (const id of ['ja-bridge-homophone', 'ja-negated-eating', 'ko-repeated-chestnut', 'ko-negated-going']) {
      expect(get(id).tags).toContain('omitted_subject');
      expect(get(id).expectedMeaningHints.reviewCaution).toContain('Person, gender and number are not established');
    }
    expect(get('kk-negated-availability').expectedMeaningHints.reviewCaution).toContain('native Kazakh speaker');
  });

  it('does not silently turn unreviewed reverse probes into a target-language answer key', () => {
    const invalid = structuredClone(get('ru-to-es-bench'));
    invalid.expectedMeaningHints.possibleSenses[0]!.targetGlossCandidates = ['invented target answer'];
    expect(() => assertCandidate(invalid)).toThrow();
    const mislabeled = structuredClone(get('ru-to-es-bench'));
    mislabeled.coverageRole = 'source_probe';
    expect(() => assertCandidate(mislabeled)).toThrow();
  });

  it('rejects offsets accidentally converted to code-point positions', () => {
    const invalid = structuredClone(get('en-river-bank-repeated'));
    invalid.input.context.targetStart -= 1;
    invalid.input.context.targetEnd -= 1;
    expect(() => assertCandidate(invalid)).toThrow();
  });

  it('rejects a slice that matches text but cuts off a combining mark', () => {
    const invalid = structuredClone(get('fr-decomposed-cafe'));
    invalid.input.expression = 'cafe';
    invalid.input.context.targetEnd -= 1;
    expect(invalid.input.context.sentence.slice(invalid.input.context.targetStart, invalid.input.context.targetEnd))
      .toBe(invalid.input.expression);
    expect(() => assertCandidate(invalid)).toThrow();
  });

  it('rejects a partial Arabic grapheme and a split emoji surrogate', () => {
    const arabic = structuredClone(get('ar-same-language-diacritic-book'));
    arabic.input.expression = 'ك';
    arabic.input.context.targetEnd = arabic.input.context.targetStart + 1;
    expect(() => assertCandidate(arabic)).toThrow();
    const emoji = structuredClone(get('en-river-bank-repeated'));
    emoji.input.expression = emoji.input.context.sentence.slice(0, 1);
    emoji.input.context.targetStart = 0;
    emoji.input.context.targetEnd = 1;
    expect(() => assertCandidate(emoji)).toThrow();
  });

  it('rejects normalization of the source while the original selection remains decomposed', () => {
    const invalid = structuredClone(get('fr-decomposed-cafe'));
    invalid.input.context.sentence = invalid.input.context.sentence.normalize('NFC');
    expect(() => assertCandidate(invalid)).toThrow();
  });

  it('rejects invalid numeric ranges and a mismatched locale', () => {
    for (const patch of [
      { targetStart: -1 }, { targetStart: 0.5 }, { targetEnd: 9_999 },
      { targetStart: 0, targetEnd: 0 },
    ]) {
      const invalid = structuredClone(get('en-river-bank-repeated'));
      Object.assign(invalid.input.context, patch);
      expect(() => assertCandidate(invalid)).toThrow();
    }
    const invalid = structuredClone(get('ar-water-spring'));
    invalid.input.dialect = 'en-US';
    expect(() => assertCandidate(invalid)).toThrow();
  });

  it('rejects unsupported fields and fabricated review/accuracy claims in this draft format', () => {
    expect(candidateSchema.safeParse({ ...get('ru-inflected-door-key'), apiKey: 'not-a-real-key' }).success).toBe(false);
    expect(candidateSchema.safeParse({ ...get('ru-inflected-door-key'), reviewStatus: 'human-certified' }).success).toBe(false);
    expect(datasetSchema.safeParse({ ...dataset, groundTruth: true }).success).toBe(false);
    expect(datasetSchema.safeParse({ ...dataset, semanticAccuracy: { status: 'measured', value: 0.95 } }).success).toBe(false);
    expect(datasetSchema.safeParse({ ...dataset, liveEvaluation: { status: 'completed', resultCount: 38 } }).success).toBe(false);
  });
});
