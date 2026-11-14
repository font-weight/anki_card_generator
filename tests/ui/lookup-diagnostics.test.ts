import {describe, expect, it} from 'vitest';
import {LOOKUP_DIAGNOSTIC_REASONS, readLookupDiagnostics, type LookupDiagnostics} from '@english-reader/contracts';
import {lookupDiagnosticText, lookupFailure} from '../../apps/extension/src/ui/lookup-feedback';

describe('lookup diagnostic category contract', () => {
  it('uses a fresh, exactly bounded public object and accepts null-prototype transport records', () => {
    const input = {stage: 'validation', reason: 'ipa_dialect'};
    const parsed = readLookupDiagnostics(input);
    expect(parsed).toEqual(input); expect(parsed).not.toBe(input);
    input.reason = 'PRIVATE'; expect(parsed?.reason).toBe('ipa_dialect');
    const record = Object.assign(Object.create(null), {stage: 'request', reason: 'request_parameter'});
    expect(readLookupDiagnostics(record)).toEqual({stage: 'request', reason: 'request_parameter'});
  });
  it('rejects unknown, missing, inherited and extra arbitrary diagnostic values', () => {
    for (const input of [undefined, null, [], 'PRIVATE', 1, {},
      {stage: 'validation', reason: 'PRIVATE'}, {stage: 'PRIVATE', reason: 'ipa_dialect'},
      {stage: 'validation', reason: 'ipa_dialect', context: 'PRIVATE'},
      Object.create({stage: 'validation', reason: 'ipa_dialect'})]) {
      expect(readLookupDiagnostics(input)).toBeUndefined();
    }
  });
  it('has fixed human-readable copy for every supported reason, never the original error text', () => {
    for (const reason of LOOKUP_DIAGNOSTIC_REASONS) {
      const diagnostics: LookupDiagnostics = {stage: 'validation', reason};
      const failure = lookupFailure({code: 'INVALID_MODEL_OUTPUT', diagnostics, message: 'PRIVATE-API-KEY'});
      expect(failure.diagnostics).toEqual(diagnostics);
      const copy = lookupDiagnosticText(failure.diagnostics!);
      expect(copy.stage).toBe('Проверка перевода'); expect(copy.reason).toMatch(/[А-Яа-я]/u);
      expect(JSON.stringify({...failure, ...copy})).not.toContain('PRIVATE-API-KEY');
    }
  });
  it('does not accept diagnostics attached to an unknown error code', () => {
    expect(lookupFailure({code: 'UNKNOWN', diagnostics: {stage: 'validation', reason: 'lookup_shape'}})).toEqual({message: 'Проверьте подключение и попробуйте ещё раз.'});
  });
});
