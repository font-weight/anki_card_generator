import {countEnglishWords} from '../../contracts/src/words.ts';
import {
  ENRICH_SYSTEM_PROMPT, EXAMPLE_MODEL_SCHEMA, LOOKUP_MODEL_SCHEMA,
  LOOKUP_SYSTEM_PROMPT, examplePromptData, lookupPromptData,
} from "./prompts.ts";
import type { EnrichInput, ExtraExample, LookupInput, ModelLookupOutput, Sense } from "./prompts.ts";
import type { LookupData, Usage } from "../../contracts/src/index.ts";
import { ServiceError } from "./errors.ts";
export type { LookupData, Usage } from "../../contracts/src/index.ts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const LOOKUP_MODEL = "gpt-4.1-mini";
export const REFINE_MODEL = "gpt-4.1";
export type TextModel = typeof LOOKUP_MODEL | typeof REFINE_MODEL;
export type OpenAIErrorCode =
  | "INVALID_INPUT" | "OPENAI_AUTH" | "OPENAI_QUOTA" | "OPENAI_RATE_LIMIT"
  | "MODEL_UNAVAILABLE" | "MODEL_REFUSAL" | "MODEL_INCOMPLETE" | "INVALID_MODEL_OUTPUT"
  | "NETWORK_TIMEOUT" | "REQUEST_CANCELLED" | "INTERNAL_ERROR";

const safeMessages: Record<OpenAIErrorCode, string> = {
  INVALID_INPUT: "Некорректный запрос перевода.",
  OPENAI_AUTH: "Проверьте ключ и доступ к OpenAI API.",
  OPENAI_QUOTA: "Квота или оплаченный лимит OpenAI API исчерпаны.",
  OPENAI_RATE_LIMIT: "Достигнут лимит запросов OpenAI. Повторите позже.",
  MODEL_UNAVAILABLE: "Выбранная модель недоступна. Автоматическая замена отключена.",
  MODEL_REFUSAL: "Модель отказалась обработать этот фрагмент.",
  MODEL_INCOMPLETE: "Модель не завершила ответ.",
  INVALID_MODEL_OUTPUT: "Модель не вернула полный допустимый результат.",
  NETWORK_TIMEOUT: "Истёк срок ожидания ответа OpenAI.",
  REQUEST_CANCELLED: "Запрос отменён. Отмена не гарантирует отсутствия списания.",
  INTERNAL_ERROR: "Не удалось получить ответ OpenAI. Повторите позже.",
};

/** Never include raw provider bodies, input, keys or arbitrary exception messages. */
export class OpenAIServiceError extends ServiceError {
  usage: Usage | null = null;
  responseId: string | null = null;
  constructor(code: OpenAIErrorCode, retryable = false) {
    super(code, safeMessages[code], retryable);
    this.name = "OpenAIServiceError";
  }
}

export interface ModelExecution<T> {
  data: T;
  model: TextModel;
  resolvedModel: string | null;
  responseId: string | null;
  usage: Usage | null;
  cacheHit: boolean;
  warnings: string[];
}
export type LookupExecution = ModelExecution<LookupData>;

export interface OpenAIServiceOptions {
  getApiKey: () => string | null | Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  /** Covers secret retrieval, both attempts, body reads and any retry backoff. */
  budgetMs?: number;
  retryDelayMs?: number;
  idFactory?: () => string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[], optional: string[] = []): boolean {
  return keys.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim().length > 0;
}
function plainText(value: unknown, max: number): value is string {
  return text(value, max) && !/<\/?[a-z][^>]*>/i.test(value) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}
function fail(code: OpenAIErrorCode = "INVALID_MODEL_OUTPUT"): never {
  throw new OpenAIServiceError(code);
}
function assertSense(value: unknown): asserts value is Sense {
  if (!record(value) || !exactKeys(value, ["id", "translations", "definitionEn"]) ||
      !text(value.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(value.id) ||
      !Array.isArray(value.translations) || value.translations.length < 1 || value.translations.length > 3 ||
      !value.translations.every(item => plainText(item, 200)) ||
      new Set(value.translations).size !== value.translations.length ||
      !plainText(value.definitionEn, 500)) fail();
}

/** Ranges are evaluated on the original string, never a trimmed/normalized copy. */
export function validateLookupInput(value: unknown): asserts value is LookupInput {
  if (!record(value) || !exactKeys(value, [
    "expression", "context", "sourceLanguage", "targetLanguage", "learnerLevel", "dialect",
  ]) || !text(value.expression, 256) || countEnglishWords(value.expression)<1 || countEnglishWords(value.expression)>5 ||
      value.sourceLanguage !== "en" || value.targetLanguage !== "ru" || value.learnerLevel !== "B1" ||
      !["en-US", "en-GB"].includes(value.dialect as string) || !record(value.context)) fail("INVALID_INPUT");
  const c = value.context;
  if (!exactKeys(c, ["sentence", "targetStart", "targetEnd"], ["before", "after"]) ||
      !text(c.sentence, 1500) ||
      (c.before !== undefined && (typeof c.before !== "string" || c.before.length > 1500)) ||
      (c.after !== undefined && (typeof c.after !== "string" || c.after.length > 1500)) ||
      !Number.isInteger(c.targetStart) || !Number.isInteger(c.targetEnd)) fail("INVALID_INPUT");
  const start = c.targetStart as number;
  const end = c.targetEnd as number;
  if (start < 0 || end <= start || end > c.sentence.length ||
      c.sentence.slice(start, end) !== value.expression ||
      c.sentence.length + ((c.before as string | undefined)?.length ?? 0) +
        ((c.after as string | undefined)?.length ?? 0) > 1500) fail("INVALID_INPUT");
  // Prevent offsets cutting a surrogate pair, even when the caller copied half.
  for (const offset of [start, end]) {
    if (offset > 0 && offset < c.sentence.length &&
        /[\uD800-\uDBFF]/.test(c.sentence[offset - 1]!) &&
        /[\uDC00-\uDFFF]/.test(c.sentence[offset]!)) fail("INVALID_INPUT");
  }
}

export function validateModelLookup(value: unknown, input: LookupInput): ModelLookupOutput {
  if (!record(value) || !exactKeys(value, [
    "lemma", "partOfSpeech", "recommendedSenseId", "contextAmbiguous",
    "senses", "ipaCandidate", "extraExample",
  ]) || !plainText(value.lemma, 256) || !plainText(value.partOfSpeech, 80) ||
      typeof value.contextAmbiguous !== "boolean" ||
      !Array.isArray(value.senses) || value.senses.length < 1 || value.senses.length > 4 ||
      value.extraExample !== null) fail();
  for (const sense of value.senses) assertSense(sense);
  const senses = value.senses as Sense[];
  if (new Set(senses.map(sense => sense.id)).size !== senses.length ||
      (value.recommendedSenseId !== null &&
        !senses.some(sense => sense.id === value.recommendedSenseId)) ||
      (value.contextAmbiguous && value.recommendedSenseId !== null)) fail();
  if (value.ipaCandidate !== null) {
    const ipa = value.ipaCandidate;
    if (!record(ipa) || !exactKeys(ipa, ["ipa", "dialect"]) ||
        !plainText(ipa.ipa, 256) || ipa.dialect !== input.dialect) fail();
  }
  return value as unknown as ModelLookupOutput;
}

export function validateEnrichInput(value: unknown): asserts value is EnrichInput {
  if (!record(value) || !exactKeys(value, ["expression", "selectedSense", "learnerLevel", "dialect"]) ||
      !text(value.expression, 256) || countEnglishWords(value.expression)<1 || countEnglishWords(value.expression)>5 ||
      value.learnerLevel !== "B1" || !["en-US", "en-GB"].includes(value.dialect as string)) fail("INVALID_INPUT");
  try { assertSense(value.selectedSense); } catch { fail("INVALID_INPUT"); }
}

export function validateExtraExample(value: unknown): ExtraExample {
  if (!record(value) || !exactKeys(value, ["textEn", "textRu", "source"]) ||
      !plainText(value.textEn, 500) || !plainText(value.textRu, 500) || value.source !== "ai") fail();
  return value as unknown as ExtraExample;
}

function parseUsage(value: unknown): Usage | null {
  if (!record(value)) return null;
  const fields = [value.input_tokens, value.output_tokens, value.total_tokens];
  if (!fields.every(item => Number.isSafeInteger(item) && (item as number) >= 0)) return null;
  return {
    inputTokens: value.input_tokens as number,
    outputTokens: value.output_tokens as number,
    totalTokens: value.total_tokens as number,
  };
}
function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;
}
function providerError(status: number, body: unknown): OpenAIServiceError {
  const error = record(body) && record(body.error) ? body.error : {};
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  if (["model_not_found", "model_not_available", "model_deprecated"].includes(code) || status === 404) {
    return new OpenAIServiceError("MODEL_UNAVAILABLE");
  }
  if (status === 401 || status === 403) return new OpenAIServiceError("OPENAI_AUTH");
  if (["insufficient_quota", "billing_hard_limit_reached", "billing_not_active"].includes(code) ||
      type === "insufficient_quota") return new OpenAIServiceError("OPENAI_QUOTA");
  if (status === 429 || code === "rate_limit_exceeded") return new OpenAIServiceError("OPENAI_RATE_LIMIT", true);
  if (status === 408 || status >= 500) return new OpenAIServiceError("INTERNAL_ERROR", true);
  return new OpenAIServiceError("INVALID_MODEL_OUTPUT");
}

function retryDelay(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after");
  if (header === null) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(fallback, seconds * 1000);
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(fallback, timestamp - Date.now()) : fallback;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Races abort even when an injected adapter ignores its AbortSignal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const MAX_BYTES = 128 * 1024;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) fail();
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) fail();
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(); }
}

function readOutput(body: unknown): { value: unknown; usage: Usage | null; responseId: string | null; resolvedModel: string | null } {
  if (!record(body)) fail();
  const usage = parseUsage(body.usage);
  const responseId = safeIdentifier(body.id);
  try {
    if (body.status === "failed" && record(body.error)) throw providerError(500, body);
    if (!Array.isArray(body.output)) fail();
    const parts: string[] = [];
    for (const item of body.output) {
      if (!record(item)) fail();
      if (item.type !== "message") continue;
      if (item.role !== "assistant" || !Array.isArray(item.content)) fail();
      for (const content of item.content) {
        if (!record(content)) fail();
        if (content.type === "refusal") fail("MODEL_REFUSAL");
        if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
        else fail();
      }
      if (item.status === "incomplete") fail("MODEL_INCOMPLETE");
      if (item.status !== undefined && item.status !== "completed") fail();
    }
    if (body.status === "incomplete") fail("MODEL_INCOMPLETE");
    if (body.status !== "completed" || body.error != null || parts.length !== 1) fail();
    let value: unknown;
    // Never extract JSON from Markdown or run model output as code.
    try { value = JSON.parse(parts[0]!); } catch { fail(); }
    return { value, usage, responseId, resolvedModel: safeIdentifier(body.model) };
  } catch (error) {
    if (error instanceof OpenAIServiceError) { error.usage = usage; error.responseId = responseId; }
    throw error;
  }
}

export class OpenAIService {
  #getApiKey: OpenAIServiceOptions["getApiKey"];
  #fetch: typeof globalThis.fetch;
  #budgetMs: number;
  #retryDelayMs: number;
  #idFactory: () => string;
  constructor(options: OpenAIServiceOptions) {
    this.#getApiKey = options.getApiKey;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#budgetMs = options.budgetMs ?? 15_000;
    this.#retryDelayMs = options.retryDelayMs ?? 300;
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    if (!Number.isFinite(this.#budgetMs) || this.#budgetMs <= 0 || this.#budgetMs > 60_000 ||
        !Number.isFinite(this.#retryDelayMs) || this.#retryDelayMs < 0 || this.#retryDelayMs > 5_000) {
      fail("INVALID_INPUT");
    }
  }

  async lookup(input: LookupInput, options: { signal?: AbortSignal; refine?: boolean } = {}): Promise<LookupExecution> {
    validateLookupInput(input);
    const snapshot = structuredClone(input);
    const model = options.refine === true ? REFINE_MODEL : LOOKUP_MODEL;
    const result = await this.#request(model, LOOKUP_SYSTEM_PROMPT, lookupPromptData(snapshot),
      "english_reader_lookup_v1", LOOKUP_MODEL_SCHEMA, options.signal);
    let content: ModelLookupOutput;
    try { content = validateModelLookup(result.value, snapshot); }
    catch (error) {
      if (error instanceof OpenAIServiceError) { error.usage = result.usage; error.responseId = result.responseId; }
      throw error;
    }
    return {
      data: { lookupId: this.#idFactory(), expression: snapshot.expression, ...content },
      model, resolvedModel: result.resolvedModel, responseId: result.responseId,
      usage: result.usage, cacheHit: false,
      warnings: content.ipaCandidate === null ? [] : ["IPA_GENERATED_APPROXIMATE"],
    };
  }

  async enrich(input: EnrichInput, options: { signal?: AbortSignal } = {}): Promise<ModelExecution<ExtraExample>> {
    validateEnrichInput(input);
    const snapshot = structuredClone(input);
    const result = await this.#request(LOOKUP_MODEL, ENRICH_SYSTEM_PROMPT, examplePromptData(snapshot),
      "english_reader_example_v1", EXAMPLE_MODEL_SCHEMA, options.signal);
    let example: ExtraExample;
    try { example = validateExtraExample(result.value); }
    catch (error) {
      if (error instanceof OpenAIServiceError) { error.usage = result.usage; error.responseId = result.responseId; }
      throw error;
    }
    return {
      data: example, model: LOOKUP_MODEL,
      resolvedModel: result.resolvedModel, responseId: result.responseId,
      usage: result.usage, cacheHit: false, warnings: ["EXAMPLE_AI_GENERATED"],
    };
  }

  async #request(model: TextModel, instructions: string, data: string, name: string,
    schema: unknown, externalSignal?: AbortSignal) {
    const controller = new AbortController();
    const timeoutError = new OpenAIServiceError("NETWORK_TIMEOUT", true);
    const cancelError = new OpenAIServiceError("REQUEST_CANCELLED");
    const onExternalAbort = () => controller.abort(cancelError);
    if (externalSignal?.aborted) controller.abort(cancelError);
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError), this.#budgetMs);
    const deadline = performance.now() + this.#budgetMs;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      let key: string | null;
      try { key = await abortable(Promise.resolve().then(this.#getApiKey), controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new OpenAIServiceError("OPENAI_AUTH");
      }
      if (typeof key !== "string" || !/^[\x21-\x7e]{1,512}$/u.test(key)) throw new OpenAIServiceError("OPENAI_AUTH");
      for (let attempt = 0; attempt < 2; attempt++) {
        let delay = this.#retryDelayMs;
        try {
          const response = await abortable(this.#fetch(OPENAI_RESPONSES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model, store: false, stream: false,
              instructions,
              input: [{ role: "user", content: [{ type: "input_text", text: data }] }],
              text: { format: { type: "json_schema", name, strict: true, schema } },
              max_output_tokens: 1800,
            }),
            redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
            signal: controller.signal,
          }), controller.signal);
          delay = retryDelay(response, this.#retryDelayMs);
          let body: unknown;
          try { body = await boundedJson(response, controller.signal); }
          catch (error) {
            if (response.ok || controller.signal.aborted) throw error;
            // Even a non-JSON gateway error must retain its safe HTTP category.
            throw providerError(response.status, null);
          }
          if (!response.ok) throw providerError(response.status, body);
          return readOutput(body);
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const safe = error instanceof OpenAIServiceError ? error :
            new OpenAIServiceError("INTERNAL_ERROR", true);
          if (attempt === 1 || !safe.retryable || delay >= deadline - performance.now()) throw safe;
          // Exactly one controlled retry. The original deadline still governs it.
          await pause(delay, controller.signal);
        }
      }
      throw new OpenAIServiceError("INTERNAL_ERROR");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
