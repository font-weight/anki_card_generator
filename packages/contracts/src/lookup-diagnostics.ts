/** Public lookup diagnostics contain categories only, never provider text, keys,
 * request/response identifiers, source passages or arbitrary field paths. */
export const LOOKUP_DIAGNOSTIC_STAGES = ['request', 'response', 'output', 'validation'] as const;
export const LOOKUP_DIAGNOSTIC_REASONS = [
  'request_rejected', 'request_schema', 'request_parameter', 'request_model',
  'response_too_large', 'response_json', 'response_shape', 'response_status',
  'output_missing', 'output_multiple', 'output_json', 'output_refusal', 'output_incomplete',
  'lookup_shape', 'sentence_translation', 'sense_shape', 'sense_id', 'sense_translations', 'sense_definition',
  'definition_language', 'definition_script_cyrillic', 'translation_language', 'candidate_binding', 'recommendation',
  'ipa_shape', 'ipa_dialect', 'result_contract', 'result_binding', 'examples_shape', 'input_invalid',
] as const;
export type LookupDiagnostics = {
  stage: typeof LOOKUP_DIAGNOSTIC_STAGES[number];
  reason: typeof LOOKUP_DIAGNOSTIC_REASONS[number];
};
export function readLookupDiagnostics(value: unknown): LookupDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  const fields = Object.keys(value);
  if (fields.length !== 2 || !Object.hasOwn(value, 'stage') || !Object.hasOwn(value, 'reason')) return;
  const {stage, reason} = value as Record<string, unknown>;
  if (typeof stage !== 'string' || typeof reason !== 'string' ||
      !LOOKUP_DIAGNOSTIC_STAGES.includes(stage as LookupDiagnostics['stage']) ||
      !LOOKUP_DIAGNOSTIC_REASONS.includes(reason as LookupDiagnostics['reason'])) return;
  return {stage: stage as LookupDiagnostics['stage'], reason: reason as LookupDiagnostics['reason']};
}
