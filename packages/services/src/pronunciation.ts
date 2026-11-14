import {isDialect,isLanguageCode,localeMatchesLanguage} from '../../contracts/src/index.ts';
import type {Dialect,LanguageCode} from '../../contracts/src/index.ts';
import { ServiceError } from './errors.ts';
export type PronunciationDialect = Dialect | 'unknown';
export interface Pronunciation {
  ipa: string | null;
  dialect: PronunciationDialect;
  source: 'dictionary' | 'generated' | 'unavailable';
  sourceUrl: string | null;
}
export interface DictionaryLicense {
  scope: 'entry' | 'phonetic';
  name: string | null;
  url: string | null;
}
export interface DictionaryVariant extends Pronunciation {
  ipa: string;
  dialect: 'unknown';
  source: 'dictionary';
  sourceUrls: string[];
  licenses: DictionaryLicense[];
}
export interface PronunciationInput {
  expression: string;
  dialect: Dialect;
  sourceLanguage?:LanguageCode;
  generatedCandidate?: { ipa: string; dialect: string } | null;
}
export interface PronunciationResult {
  pronunciation: Pronunciation;
  alternatives: DictionaryVariant[];
  warnings: string[];
}
export interface PronunciationOptions {
  fetch: typeof globalThis.fetch;
  /** Trusted saved preference, not a boolean taken directly from an untrusted RPC payload. */
  hasDictionaryConsent: () => boolean | Promise<boolean>;
  timeoutMs?: number;
}
export class PronunciationError extends ServiceError {
  constructor(code: 'INVALID_INPUT' | 'DICTIONARY_UNAVAILABLE', message: string, retryable = false) {
    super(code, message, retryable); this.name = 'PronunciationError';
  }
}

const DICTIONARY_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const MAX_DICTIONARY_BYTES = 512 * 1024;
const HOMOGRAPHS = new Set(['read', 'lead', 'close', 'live', 'wind', 'bow', 'tear', 'bass', 'row', 'wound', 'use', 'minute', 'record', 'present', 'object', 'refuse', 'invalid', 'content', 'conduct', 'desert', 'digest', 'produce', 'project', 'subject']);
const unavailable = (): Pronunciation => ({ ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
}
function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function license(value: unknown, scope: DictionaryLicense['scope']): DictionaryLicense | null {
  if (!isRecord(value)) return null;
  const name = cleanText(value.name, 200);
  const url = safeSourceUrl(value.url);
  return name || url ? { scope, name, url } : null;
}
function sameWord(value: unknown, word: string): boolean {
  return typeof value === 'string' && value.toLowerCase().replaceAll('’', "'") === word.toLowerCase().replaceAll('’', "'");
}

/** Parse documented fields only. Neither filenames nor requested dialect establish a dialect/sense. */
export function parseDictionaryPronunciations(value: unknown, word: string): DictionaryVariant[] {
  if (!Array.isArray(value)) return [];
  const variants: DictionaryVariant[] = [];
  for (const entry of value.slice(0, 32)) {
    if (!isRecord(entry) || !sameWord(entry.word, word)) continue;
    const sourceUrls = Array.isArray(entry.sourceUrls)
      ? [...new Set(entry.sourceUrls.slice(0, 16).map(safeSourceUrl).filter((url): url is string => !!url))]
      : [];
    const entryLicense = license(entry.license, 'entry');
    const add = (ipa: string, phonetic?: Record<string, unknown>) => {
      const phoneticSource = safeSourceUrl(phonetic?.sourceUrl);
      const phoneticLicense = license(phonetic?.license, 'phonetic');
      const sources = [...new Set([...sourceUrls, ...(phoneticSource ? [phoneticSource] : [])])];
      const licenses = [entryLicense, phoneticLicense].filter((item): item is DictionaryLicense => item !== null);
      const existing = variants.find(item => item.ipa === ipa);
      if (existing) {
        existing.sourceUrls = [...new Set([...existing.sourceUrls, ...sources])];
        for (const item of licenses) {
          if (!existing.licenses.some(saved => JSON.stringify(saved) === JSON.stringify(item))) existing.licenses.push(item);
        }
        return;
      }
      variants.push({
        ipa, dialect: 'unknown', source: 'dictionary',
        sourceUrl: sourceUrls[0] ?? `${DICTIONARY_BASE}${encodeURIComponent(word.toLowerCase())}`,
        sourceUrls: sources, licenses,
      });
    };
    if (Array.isArray(entry.phonetics)) {
      for (const phonetic of entry.phonetics.slice(0, 32)) {
        if (!isRecord(phonetic)) continue;
        const ipa = cleanText(phonetic.text, 256);
        if (ipa) add(ipa, phonetic);
      }
    }
    const fallback = cleanText(entry.phonetic, 256);
    if (fallback) add(fallback);
  }
  return variants.slice(0, 32);
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DICTIONARY_BYTES) { void response.body?.cancel().catch(() => {}); throw new Error('oversize'); }
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_DICTIONARY_BYTES) { void reader.cancel().catch(() => {}); throw new Error('oversize'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class PronunciationService {
  #options: PronunciationOptions;
  constructor(options: PronunciationOptions) { this.#options = options; }

  async get(input: PronunciationInput): Promise<PronunciationResult> {
    const sourceLanguage = input?.sourceLanguage === undefined ? 'en' : input.sourceLanguage;
    if (!input || typeof input.expression !== 'string' || !input.expression.trim() || input.expression.length > 256 ||
        !isLanguageCode(sourceLanguage)||!localeMatchesLanguage(input.dialect,sourceLanguage)) {
      throw new PronunciationError('INVALID_INPUT', 'Некорректный запрос произношения.');
    }
    const warnings: string[] = [];
    let pronunciation = unavailable();
    const generated = input.generatedCandidate;
    if (generated) {
      const ipa = cleanText(generated.ipa, 256);
      if (!ipa || (generated.dialect!=='unknown'&&(!isDialect(generated.dialect)||!localeMatchesLanguage(generated.dialect,sourceLanguage)))) {
        throw new PronunciationError('INVALID_INPUT', 'Некорректный сгенерированный IPA.');
      }
      pronunciation = { ipa, dialect: generated.dialect as PronunciationDialect, source: 'generated', sourceUrl: null };
      warnings.push('GENERATED_IPA_APPROXIMATE');
    }
    if(sourceLanguage!=='en'){warnings.push('DICTIONARY_LANGUAGE_UNSUPPORTED');return {pronunciation,alternatives:[],warnings};}
    const word = input.expression.trim().replaceAll('’', "'");
    // Never disclose context, a phrase, URL, or arbitrary path to this dictionary endpoint.
    if (!/^[A-Za-z]+(?:['-][A-Za-z]+)*$/.test(word) || word.length > 100) {
      warnings.push('DICTIONARY_WORD_ONLY');
      return { pronunciation, alternatives: [], warnings };
    }
    if (!(await this.#options.hasDictionaryConsent())) {
      warnings.push('DICTIONARY_DISABLED');
      return { pronunciation, alternatives: [], warnings };
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(this.#options.timeoutMs ?? 8_000, 15_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = (async () => {
        const response = await this.#options.fetch(`${DICTIONARY_BASE}${encodeURIComponent(word.toLowerCase())}`, {
          method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
        });
        if (response.status === 404) return [];
        if (!response.ok || response.redirected) throw new Error('unavailable');
        return parseDictionaryPronunciations(await boundedJson(response), word);
      })();
      const alternatives = await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
      })]);
      if (alternatives.length === 1 && !HOMOGRAPHS.has(word.toLowerCase())) {
        const variant = alternatives[0]!;
        pronunciation = { ipa: variant.ipa, dialect: 'unknown', source: 'dictionary', sourceUrl: variant.sourceUrl };
        const generatedWarning = warnings.indexOf('GENERATED_IPA_APPROXIMATE');
        if (generatedWarning !== -1) warnings.splice(generatedWarning, 1);
        warnings.push('DICTIONARY_DIALECT_UNVERIFIED', 'DICTIONARY_CONTEXT_UNVERIFIED');
      } else if (alternatives.length) {
        warnings.push('PRONUNCIATION_AMBIGUOUS', 'DICTIONARY_DIALECT_UNVERIFIED', 'DICTIONARY_CONTEXT_UNVERIFIED');
      } else warnings.push('DICTIONARY_NO_IPA');
      return { pronunciation, alternatives, warnings };
    } catch {
      // Optional dictionary failure must never block translation or expose provider body/error text.
      warnings.push('DICTIONARY_UNAVAILABLE');
      return { pronunciation, alternatives: [], warnings };
    } finally { if (timer) clearTimeout(timer); }
  }
}
