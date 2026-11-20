import { validateGrammarDraft } from '../../contracts/src/grammar.ts';
import type { GrammarDraft } from '../../contracts/src/grammar.ts';
import { canonicalJson, escapeAnkiText, noteSourceFields, sha256 } from './index.ts';
import type { NoteFields, SemanticKeys } from './index.ts';

export const GRAMMAR_MODEL_NAME = 'LanguageReader.Grammar.v1';
/** A separate namespace recovers incompatible v1 installations without rewriting them. */
export const GRAMMAR_CURRENT_MODEL_NAME = 'LanguageReader.Grammar.v2';
export const GRAMMAR_MODEL_NAMES = [GRAMMAR_MODEL_NAME, GRAMMAR_CURRENT_MODEL_NAME] as const;
export type GrammarModelName = typeof GRAMMAR_MODEL_NAMES[number];
export const GRAMMAR_NOTE_FIELDS = Object.freeze([
  'OperationId', 'LexemeKey', 'ContentKey', 'Sentence', 'Construction', 'Question', 'Answer', 'Rule',
  'Explanation', 'Translation', 'SourceTitle', 'SourceURL', 'SourceLocation', 'SourceLanguage',
  'TargetLanguage', 'ExplanationLanguage', 'LearnerLevel',
] as const);
const css = `.card { font-family: Arial, sans-serif; font-size: 22px; text-align: left; line-height: 1.5; }
.sentence, .question, .answer, .rule, .explanation, .translation { white-space: pre-wrap; unicode-bidi: isolate; margin: 0.8em 0; }
.construction { color: #dc2626; text-decoration: underline; font-weight: 700; }
.question, .answer { font-weight: 700; }
.source { font-size: 0.75em; opacity: 0.75; }`;
const front = '<div class="sentence" dir="auto" lang="{{SourceLanguage}}">{{Sentence}}</div><div class="question" dir="auto" lang="{{ExplanationLanguage}}">{{Question}}</div>';
const back = front + '<hr id="answer"><div class="answer" dir="auto" lang="{{ExplanationLanguage}}">{{Answer}}</div><div class="rule" dir="auto" lang="{{ExplanationLanguage}}">{{Rule}}</div>' +
  '{{#Explanation}}<div class="explanation" dir="auto" lang="{{ExplanationLanguage}}">{{Explanation}}</div>{{/Explanation}}' +
  '<div class="translation" dir="auto" lang="{{TargetLanguage}}">{{Translation}}</div>' +
  '<div class="source" dir="auto">{{SourceTitle}} {{SourceLocation}}{{#SourceURL}}<br><a href="{{SourceURL}}" rel="noreferrer noopener">Источник</a>{{/SourceURL}}</div>';
export function grammarModelDefinition(modelName: GrammarModelName = GRAMMAR_MODEL_NAME) {
  return { modelName, inOrderFields: [...GRAMMAR_NOTE_FIELDS], css, isCloze: false,
    cardTemplates: [{ Name: 'Grammar', Front: front, Back: back }] };
}
export async function grammarSemanticKeys(draft: GrammarDraft): Promise<SemanticKeys> {
  validateGrammarDraft(draft);
  const lexemeKey = await sha256(canonicalJson(['grammar-construction-v1', draft.sourceLanguage, draft.targetLanguage,
    draft.explanationLanguage, draft.construction.text, draft.rule]));
  const contentKey = await sha256(canonicalJson(['grammar-content-v1', lexemeKey, draft.sentence, draft.construction,
    draft.question, draft.answer, draft.rule, draft.explanation, draft.translation, draft.learnerLevel]));
  return { lexemeKey, contentKey };
}
export function buildGrammarNoteFields(operationId: string, draft: GrammarDraft, keys: SemanticKeys): NoteFields {
  validateGrammarDraft(draft);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) throw Object.assign(new Error('Некорректный идентификатор операции.'), { code: 'INVALID_INPUT', retryable: false });
  const { sentence, construction: c, source } = draft;
  return {
    OperationId: operationId, LexemeKey: escapeAnkiText(keys.lexemeKey), ContentKey: escapeAnkiText(keys.contentKey),
    Sentence: escapeAnkiText(sentence.slice(0, c.targetStart)) + '<span class="construction">' + escapeAnkiText(c.text) + '</span>' + escapeAnkiText(sentence.slice(c.targetEnd)),
    Construction: escapeAnkiText(c.text), Question: escapeAnkiText(draft.question), Answer: escapeAnkiText(draft.answer),
    Rule: escapeAnkiText(draft.rule), Explanation: escapeAnkiText(draft.explanation ?? ''), Translation: escapeAnkiText(draft.translation),
    ...noteSourceFields(source),
    SourceLanguage: draft.sourceLanguage, TargetLanguage: draft.targetLanguage, ExplanationLanguage: draft.explanationLanguage, LearnerLevel: draft.learnerLevel,
  };
}
/** Preview uses the same fixed templates and escaped field builder as Anki. */
export function renderGrammarPreview(draft: GrammarDraft): { front: string; back: string } {
  const fields = buildGrammarNoteFields('00000000-0000-4000-8000-000000000000', draft, { lexemeKey: '', contentKey: '' });
  const interpolate = (template: string) => template
    .replace(/\{\{#([A-Za-z]+)\}\}([\s\S]*?)\{\{\/\1\}\}/gu, (_all, key: string, text: string) => fields[key] ? text : '')
    .replace(/\{\{([A-Za-z]+)\}\}/gu, (_all, key: string) => fields[key] ?? '');
  return { front: interpolate(front), back: interpolate(back) };
}

/** Only call with the escaped fragment from renderGrammarPreview. */
export function grammarPreviewDocument(fragment: string): string {
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;"><style>' + css + '</style><body class="card">' + fragment + '</body>';
}
