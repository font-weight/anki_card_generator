import { LEARNER_LEVELS, type LearnerLevel } from './languages.ts';

export const ENGLISH_USAGE_REGISTERS = ['current', 'formal', 'literary', 'dated', 'archaic', 'regional', 'specialized'] as const;
export const ENGLISH_USAGE_FREQUENCIES = ['very_common', 'common', 'occasional', 'rare'] as const;

export type EnglishUsage = {
  level: LearnerLevel | null;
  register: typeof ENGLISH_USAGE_REGISTERS[number] | null;
  frequency: typeof ENGLISH_USAGE_FREQUENCIES[number] | null;
};

function enumOrNull<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && values.includes(value as T) ? value as T : null;
}

/** A best-effort estimate may not turn an otherwise valid translation into an error. */
export function normalizeEnglishUsage(value: unknown): EnglishUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const level = enumOrNull(LEARNER_LEVELS, item.level);
  const register = enumOrNull(ENGLISH_USAGE_REGISTERS, item.register);
  const frequency = enumOrNull(ENGLISH_USAGE_FREQUENCIES, item.frequency);
  return level || register || frequency ? {level, register, frequency} : undefined;
}
