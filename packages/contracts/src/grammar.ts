import type { Source } from './index.ts';
import { LANGUAGE_CODES, LEARNER_LEVELS } from './languages.ts';
import type { LanguageCode, LearnerLevel } from './languages.ts';
import { ContractValidationError, validateSchema } from './validation.ts';
import type { Schema } from './validation.ts';
import { sourceGraphemeBoundaries } from './words.ts';

/** Grammar is deliberately separate from lexical drafts, cloze and audio. */
export type GrammarLookupPayload = {
  sentence: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  explanationLanguage: LanguageCode;
  learnerLevel: LearnerLevel;
  includeExplanation: boolean;
};
export type GrammarConstruction = { text: string; targetStart: number; targetEnd: number };
export type GrammarContent = {
  sentence: string;
  construction: GrammarConstruction;
  question: string;
  answer: string;
  rule: string;
  explanation: string | null;
  translation: string;
};
export type GrammarLookupData = GrammarContent & { grammarId: string };
export type GrammarDraft = GrammarContent & {
  draftKind: 'grammar';
  draftVersion: 1;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  explanationLanguage: LanguageCode;
  learnerLevel: LearnerLevel;
  deckName: string;
  tags: string[];
  source: Source;
};
export type GrammarAddPayload = { operationId: string; draft: GrammarDraft };

const str = (min = 1, max = 500): Schema => ({ type: 'string', minLength: min, maxLength: max });
const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const integer = (minimum = 0, maximum = 1500): Schema => ({ type: 'integer', minimum, maximum });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const uuid: Schema = { ...str(36, 36), format: 'uuid' };
const language: Schema = { enum: LANGUAGE_CODES };
const level: Schema = { enum: LEARNER_LEVELS };
export const grammarLookupPayloadSchema = obj({ sentence: str(1, 1500), sourceLanguage: language, targetLanguage: language, explanationLanguage: language, learnerLevel: level, includeExplanation: { type: 'boolean' } });
export const grammarContentSchema = obj({
  sentence: str(1, 1500),
  construction: obj({ text: str(1, 500), targetStart: integer(0, 1499), targetEnd: integer(1, 1500) }),
  question: str(1, 500), answer: str(1, 1000), rule: str(1, 1000),
  explanation: nullable(str(1, 2000)), translation: str(1, 2000),
});
export const grammarLookupDataSchema = obj({ ...grammarContentSchema.properties, grammarId: uuid });
const sourceSchema = obj({
  kind: { enum: ['html', 'pdf', 'epub', 'fb2'] }, title: str(0, 500),
  url: nullable({ ...str(1, 2048), format: 'url' }), documentId: nullable(str(1, 128)),
  page: nullable(integer(1, Number.MAX_SAFE_INTEGER)), chapter: nullable(str(0, 500)), cfi: nullable(str(1, 2048)),
});
export const grammarDraftSchema = obj({
  ...grammarContentSchema.properties,
  draftKind: { enum: ['grammar'] }, draftVersion: { enum: [1] },
  sourceLanguage: language, targetLanguage: language, explanationLanguage: language, learnerLevel: level,
  deckName: str(1, 200), tags: { type: 'array', items: { ...str(1, 80), pattern: '^\\S+$' }, minItems: 0, maxItems: 32 }, source: sourceSchema,
});
export const grammarAddPayloadSchema = obj({ operationId: uuid, draft: grammarDraftSchema });

function invalid(field: string): never { throw new ContractValidationError(`Invalid field: grammar.${field}`); }
/** Plain data only. Escaping at template construction remains a separate barrier. */
export function isGrammarPlainText(value: string): boolean {
  return value.trim().length > 0 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) &&
    !/<\/?[a-z][^>]*>/iu.test(value) && !/\{\{|\}\}|\[sound:|\[\/?latex\]|```/iu.test(value);
}
export function validateGrammarLookupPayload(value: unknown): GrammarLookupPayload {
  validateSchema(grammarLookupPayloadSchema, value);
  const input = value as GrammarLookupPayload;
  if (!isGrammarPlainText(input.sentence)) invalid('sentence');
  return input;
}
function validateContent(value: GrammarContent, sourceLanguage: LanguageCode): void {
  for (const key of ['sentence', 'question', 'answer', 'rule', 'translation'] as const) if (!isGrammarPlainText(value[key])) invalid(key);
  if (value.explanation !== null && !isGrammarPlainText(value.explanation)) invalid('explanation');
  const c = value.construction;
  if (!isGrammarPlainText(c.text) || c.text.trim() !== c.text || c.targetStart >= c.targetEnd || c.targetEnd > value.sentence.length || value.sentence.slice(c.targetStart, c.targetEnd) !== c.text) invalid('construction');
  const boundaries = sourceGraphemeBoundaries(value.sentence, sourceLanguage);
  if (!boundaries?.has(c.targetStart) || !boundaries.has(c.targetEnd)) invalid('construction.range');
}
/** Only the model boundary may repair numeric miscounts. No coercion, normalization,
 * fuzzy matching, sentence changes or ambiguous occurrence selection is permitted. */
export function validateGrammarContent(value: unknown, input: GrammarLookupPayload, options: { repairOffsets?: boolean } = {}): GrammarContent {
  validateGrammarLookupPayload(input);
  validateSchema(grammarContentSchema, value); // Shape, type and size precede repair.
  const content = structuredClone(value) as GrammarContent;
  if (content.sentence !== input.sentence) invalid('sentence');
  if (input.includeExplanation ? content.explanation === null : content.explanation !== null) invalid('explanation');
  const c = content.construction;
  if (options.repairOffsets && content.sentence.slice(c.targetStart, c.targetEnd) !== c.text) {
    const start = content.sentence.indexOf(c.text);
    if (start < 0 || content.sentence.indexOf(c.text, start + 1) !== -1) invalid('construction.range');
    c.targetStart = start;
    c.targetEnd = start + c.text.length;
  }
  validateContent(content, input.sourceLanguage);
  return content;
}
export function validateGrammarLookupData(value: unknown, input: GrammarLookupPayload): GrammarLookupData {
  validateSchema(grammarLookupDataSchema, value);
  const { grammarId, ...content } = value as GrammarLookupData;
  return { ...validateGrammarContent(content, input), grammarId };
}
export function validateGrammarDraft(value: unknown): GrammarDraft {
  validateSchema(grammarDraftSchema, value);
  const draft = value as GrammarDraft;
  validateContent(draft, draft.sourceLanguage);
  if (!isGrammarPlainText(draft.deckName) || draft.tags.some(tag => !isGrammarPlainText(tag))) invalid('deckName');
  const s = draft.source;
  if (s.kind === 'html' && (s.page !== null || s.chapter !== null || s.cfi !== null)) invalid('source');
  if (s.kind === 'pdf' && (!s.documentId || !s.page || s.chapter !== null || s.cfi !== null)) invalid('source');
  if ((s.kind === 'epub' || s.kind === 'fb2') && (!s.documentId || s.page !== null)) invalid('source');
  if (s.kind === 'fb2' && s.url !== null) invalid('source');
  return draft;
}
