import {countSourceWords,sourceGraphemeBoundaries} from '../../contracts/src/words.ts';
import {isLanguageCode,isLearnerLevel,localeMatchesLanguage,MAX_LOOKUP_SENSES,MAX_SENSE_TRANSLATIONS,validPhrasalCandidates,validateData,normalizeEnglishUsage} from '../../contracts/src/index.ts';
import {
  ENRICH_SYSTEM_PROMPT, EXAMPLE_MODEL_SCHEMA,
  LOOKUP_SYSTEM_PROMPT, LOOKUP_SENSE_ID_PATTERN, examplePromptData, lookupPromptData, lookupModelSchema,
} from "./prompts.ts";
import type { EnrichInput, ExtraExample, LookupInput, ModelLookupOutput, Sense } from "./prompts.ts";
import type { LookupData, Usage, ContextExample, LanguageCode, LookupDiagnostics } from "../../contracts/src/index.ts";
import { ServiceError } from "./errors.ts";
export type { LookupData, Usage, ContextExample } from "../../contracts/src/index.ts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const LOOKUP_MODEL = "gpt-6-luna";
export const REFINE_MODEL = "gpt-6-luna";
/** Explicit effort avoids Luna's medium default for latency-sensitive translation. */
export const LOOKUP_REASONING_EFFORT = "none";
export const REFINE_REASONING_EFFORT = "low";
export type TextReasoningEffort = typeof LOOKUP_REASONING_EFFORT | typeof REFINE_REASONING_EFFORT;
/** Bounded space for eight senses; refinement reasoning counts against the same cap. */
export const LOOKUP_MAX_OUTPUT_TOKENS = 3200;
export const ENRICH_MAX_OUTPUT_TOKENS = 1800;
export type TextModel = typeof LOOKUP_MODEL | typeof REFINE_MODEL;
export type OpenAIErrorCode =
  | "INVALID_INPUT" | "OPENAI_AUTH" | "OPENAI_QUOTA" | "OPENAI_RATE_LIMIT"
  | "OPENAI_REQUEST_REJECTED" | "MODEL_UNAVAILABLE" | "MODEL_REFUSAL" | "MODEL_INCOMPLETE" | "INVALID_MODEL_OUTPUT"
  | "NETWORK_TIMEOUT" | "REQUEST_CANCELLED" | "INTERNAL_ERROR";

const safeMessages: Record<OpenAIErrorCode, string> = {
  INVALID_INPUT: "Некорректный запрос перевода.",
  OPENAI_AUTH: "Проверьте ключ и доступ к OpenAI API.",
  OPENAI_QUOTA: "Квота или оплаченный лимит OpenAI API исчерпаны.",
  OPENAI_RATE_LIMIT: "Достигнут лимит запросов OpenAI. Повторите позже.",
  OPENAI_REQUEST_REJECTED: "OpenAI отклонил параметры запроса. Повтор без исправления не поможет.",
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
  constructor(code: OpenAIErrorCode, retryable = false, diagnostics?: LookupDiagnostics) {
    super(code, safeMessages[code], retryable, diagnostics);
    this.name = "OpenAIServiceError";
  }
}

export interface ModelExecution<T> {
  data: T;
  model: TextModel;
  reasoningEffort: TextReasoningEffort;
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
  /** Covers secret retrieval, the single provider request and body reads. */
  budgetMs?: number;
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
function fail(code: OpenAIErrorCode = "INVALID_MODEL_OUTPUT", reason: LookupDiagnostics["reason"] = "lookup_shape",
  stage: LookupDiagnostics["stage"] = "validation"): never {
  throw new OpenAIServiceError(code, false, {stage, reason: code === "INVALID_INPUT" ? "input_invalid" : reason});
}
function invalid(reason: LookupDiagnostics["reason"], stage: LookupDiagnostics["stage"] = "validation"): never {
  fail("INVALID_MODEL_OUTPUT", reason, stage);
}
function assertSense(value: unknown): asserts value is Sense {
  if (!record(value) || !exactKeys(value, ["id", "translations", "definition"])) invalid("sense_shape");
  if (!text(value.id, 64) || !new RegExp(LOOKUP_SENSE_ID_PATTERN).test(value.id)) invalid("sense_id");
  if (!Array.isArray(value.translations) || value.translations.length < 1 || value.translations.length > MAX_SENSE_TRANSLATIONS ||
      !value.translations.every(item => plainText(item, 200)) ||
      new Set(value.translations).size !== value.translations.length) invalid("sense_translations");
  if (!plainText(value.definition, 500)) invalid("sense_definition");
}

/** Ranges are evaluated on the original string, never a trimmed/normalized copy. */
export function validateLookupInput(value: unknown): asserts value is LookupInput {
  if (!record(value) || !exactKeys(value, [
    "expression", "context", "sourceLanguage", "targetLanguage", "learnerLevel", "dialect",
  ], ["phrasalCandidates"]) || !text(value.expression, 256) || value.expression.trim() !== value.expression || !isLanguageCode(value.sourceLanguage) || !isLanguageCode(value.targetLanguage) || !isLearnerLevel(value.learnerLevel) ||
      countSourceWords(value.expression,value.sourceLanguage)<1 || countSourceWords(value.expression,value.sourceLanguage)>5 ||
      !localeMatchesLanguage(value.dialect,value.sourceLanguage) || !record(value.context)) fail("INVALID_INPUT");
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
  // Offsets remain on the unchanged source string and must span whole graphemes.
  const boundaries = sourceGraphemeBoundaries(c.sentence, value.sourceLanguage);
  if (!boundaries?.has(start) || !boundaries.has(end)) fail("INVALID_INPUT");
  if (value.phrasalCandidates !== undefined && !validPhrasalCandidates(value.phrasalCandidates, c as unknown as LookupInput["context"], value.sourceLanguage)) fail("INVALID_INPUT");
}

/** Deliberately conservative language guards, not a language detector. Reject clear
 * script mismatches and unmistakable English definitions; never pay for repairs. */
function hasLanguageScript(value:string,language:LanguageCode):boolean {
  const scripts:Partial<Record<LanguageCode,RegExp>>={ru:/\p{Script=Cyrillic}/u,uk:/\p{Script=Cyrillic}/u,kk:/\p{Script=Cyrillic}/u,zh:/\p{Script=Han}/u,ja:/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,ko:/\p{Script=Hangul}/u,ar:/\p{Script=Arabic}/u,hi:/\p{Script=Devanagari}/u};
  return (scripts[language]??/\p{Script=Latin}/u).test(value);
}
/** An unchanged uppercase initialism can be a valid equivalent in another script
 * (ZIP in Russian). This is NOT a general exemption for untranslated words: only
 * the exact uppercase selected token, with a target-language explanation in the
 * same sense, is allowed. Casing alone is never sufficient. */
function assertTranslationLanguage(value:string,language:LanguageCode,input:LookupInput,sense:Sense):void {
  if(hasLanguageScript(value,language))return;
  if(/^[A-Z][A-Z0-9]{1,11}$/u.test(input.expression) && value===input.expression &&
    sense.translations.some(item=>item!==value&&hasLanguageScript(item,language)))return;
  invalid("translation_language");
}
function assertDefinitionLanguage(value:string,language:LanguageCode) {
  if(!hasLanguageScript(value,language)) {
    // Bounded evidence only: this records a script mismatch, not a detected
    // natural language and never the rejected definition or a provider payload.
    if(language==='en' && /\p{Script=Cyrillic}/u.test(value))invalid("definition_script_cyrillic");
    invalid("definition_language");
  }
  if(language==='en')return;
  const words=value.toLowerCase().match(/[a-z]+/g)??[];
  const distinct=new Set(words.filter(word=>/^(?:the|something|someone|which|without|where|with|when|that|being|having|used|become|means|another)$/.test(word)));
  if(distinct.size>=2||/^(?:to (?:be|have|do|make|become|give|get|take|put|go|come|move|walk|run|turn|cover|grow|look|see|say|tell|speak|use|keep|hold|carry|cause|bring|find|leave|read|write|eat|drink|feel|think|know|tolerate|stop|start|continue|change|pass|live|stay|remain|allow|accept|refuse|belong|contain|exist|happen|begin|finish|learn|understand|remember|forget|help|want|need)|(?:a|an) (?:place|person|thing|object|written|home|building|way|type|kind|small|large|word)|the (?:act|process|state|quality|ability)|used to|something that|someone who)\b/i.test(value.trim()))invalid("definition_language");
}

/** Only compare a provider lemma with an already validated local candidate. No
 * stemming, word substitution, source normalization or offset changes. */
function comparableCandidateLemma(value:string):string {
  return value.normalize('NFC').replace(/^[ \t\u00a0]+|[ \t\u00a0]+$/gu,'').replace(/[ \t\u00a0]+/gu,' ').toLowerCase();
}

export function validateModelLookup(value: unknown, input: LookupInput, options: {requireSentenceTranslation?: boolean} = {}): ModelLookupOutput {
  validateLookupInput(input);
  if (!record(value) || !exactKeys(value, [
    "lemma", "partOfSpeech", "recommendedSenseId", "contextAmbiguous",
    "senses", "ipaCandidate", "extraExample",
    ...(input.phrasalCandidates ? ["selectedCandidateId"] : []),
    ...(options.requireSentenceTranslation ? ["sentenceTranslation"] : []),
  ], ["englishUsage", ...(options.requireSentenceTranslation ? [] : ["sentenceTranslation"])]) || !plainText(value.lemma, 256) || !plainText(value.partOfSpeech, 80) ||
      typeof value.contextAmbiguous !== "boolean" ||
      !Array.isArray(value.senses) || value.senses.length < 1 || value.senses.length > MAX_LOOKUP_SENSES ||
      value.extraExample !== null) fail();
  if (value.sentenceTranslation !== undefined) {
    if (!plainText(value.sentenceTranslation, 6000)) invalid("sentence_translation");
    if (!hasLanguageScript(value.sentenceTranslation, input.targetLanguage)) invalid("translation_language");
  }
  for (const sense of value.senses) {
    assertSense(sense);
    assertDefinitionLanguage((sense as {definition:string}).definition,input.sourceLanguage);
    for(const translation of sense.translations)assertTranslationLanguage(translation,input.targetLanguage,input,sense);
  }
  let lemma=value.lemma;
  if(input.phrasalCandidates){
    const candidate=input.phrasalCandidates.find(item=>item.id===value.selectedCandidateId);
    if(value.selectedCandidateId!==null){
      if(!candidate||comparableCandidateLemma(lemma)!==candidate.lemma)invalid("candidate_binding");
      lemma=candidate.lemma;
    }
    if(value.selectedCandidateId===null&&countSourceWords(lemma,'en')!==1)invalid("candidate_binding");
  }
  const senses = value.senses as Sense[];
  if (new Set(senses.map(sense => sense.id)).size !== senses.length) invalid("sense_id");
  if ((value.recommendedSenseId !== null &&
        !senses.some(sense => sense.id === value.recommendedSenseId)) ||
      (value.contextAmbiguous && value.recommendedSenseId !== null)) invalid("recommendation");
  if (value.ipaCandidate !== null) {
    const ipa = value.ipaCandidate;
    if (!record(ipa) || !exactKeys(ipa, ["ipa", "dialect"]) ||
        !plainText(ipa.ipa, 256)) invalid("ipa_shape");
    if(ipa.dialect !== input.dialect) invalid("ipa_dialect");
  }
  // Preserve all supplied senses while presenting the contextual recommendation
  // first even if the provider returns an otherwise valid order. Never mutate it.
  const {englishUsage: rawUsage, ...translation} = value;
  const englishUsage = input.sourceLanguage === 'en' && !value.contextAmbiguous && value.recommendedSenseId !== null
    ? normalizeEnglishUsage(rawUsage) : undefined;
  return {...translation, ...(englishUsage ? {englishUsage} : {}),lemma,senses:value.recommendedSenseId===null?senses:[
    senses.find(sense=>sense.id===value.recommendedSenseId)!,
    ...senses.filter(sense=>sense.id!==value.recommendedSenseId),
  ]} as unknown as ModelLookupOutput;
}

/** Revalidate the chosen expression and offsets against the immutable request.
 * Cache and service callers share this binding instead of trusting model text. */
export function validateLookupResult(value:unknown,input:LookupInput,options: {requireSentenceTranslation?: boolean} = {}):LookupData {
  validateLookupInput(input);
  let data:LookupData;
  try{data=validateData('lookup',value);}catch{invalid('result_contract');}
  const {lookupId,expression,resolvedTarget,...model}=data;
  const content=validateModelLookup({...model,...(input.phrasalCandidates?{selectedCandidateId:resolvedTarget?.candidateId}:{})},input,options);
  if(input.phrasalCandidates){
    if(!resolvedTarget)invalid("result_binding");
    const candidate=input.phrasalCandidates.find(item=>item.id===resolvedTarget.candidateId);
    const expected=candidate??{expression:input.expression,...input.context};
    if(expression!==expected.expression||resolvedTarget.targetStart!==expected.targetStart||resolvedTarget.targetEnd!==expected.targetEnd)invalid("result_binding");
  }else if(expression!==input.expression||resolvedTarget!==undefined)invalid("result_binding");
  const {selectedCandidateId,...validated}=content;
  return {lookupId,expression,...(resolvedTarget?{resolvedTarget:{...resolvedTarget}}:{}),...validated};
}

/** Follow-on actions are about the chosen span, never the initial hovered token.
 * Dropping candidates freezes that decision, so refinement cannot silently switch. */
export function resolvedLookupInput(input:LookupInput,data:LookupData):LookupInput {
  validateLookupResult(data,input);
  const {phrasalCandidates,...request}=input;
  return {...request,expression:data.expression,context:{...input.context,...(data.resolvedTarget?{targetStart:data.resolvedTarget.targetStart,targetEnd:data.resolvedTarget.targetEnd}:{})}};
}

export function validateEnrichInput(value: unknown): asserts value is EnrichInput {
  if (!record(value) || !Object.hasOwn(value,"selectedSense")) fail("INVALID_INPUT");
  const {selectedSense,...lookup}=value;
  validateLookupInput(lookup);
  try { assertSense(selectedSense); } catch { fail("INVALID_INPUT"); }
}

export function validateExamples(value:unknown):ContextExample[] {
  if(!record(value)||!exactKeys(value,["examples"])||!Array.isArray(value.examples)||value.examples.length<1||value.examples.length>3)invalid("examples_shape");
  for(const item of value.examples)if(!record(item)||!exactKeys(item,["text","translation","source"])||!plainText(item.text,500)||!plainText(item.translation,500)||item.source!=="ai")invalid("examples_shape");
  if(new Set(value.examples.map(item=>item.text)).size!==value.examples.length)invalid("examples_shape");
  return value.examples as ContextExample[];
}

export function validateExtraExample(value: unknown): ExtraExample {
  if (!record(value) || !exactKeys(value, ["textEn", "textRu", "source"]) ||
      !plainText(value.textEn, 500) || !plainText(value.textRu, 500) || value.source !== "ai") invalid("examples_shape");
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
  // A rejected request has no generated output. Never label schema/parameter
  // errors as model-output failures, or invite a paid blind retry of unchanged data.
  const param = typeof error.param === "string" ? error.param : "";
  const reason:LookupDiagnostics["reason"] = code === "invalid_json_schema" ||
    ["text.format.schema", "text.format", "response_format", "response_format.json_schema"].includes(param) ? "request_schema" :
    param === "model" ? "request_model" :
    ["unsupported_parameter", "invalid_parameter", "invalid_value", "unsupported_value", "missing_required_parameter"].includes(code) ||
    ["reasoning", "reasoning.effort", "max_output_tokens", "text.verbosity"].includes(param) ? "request_parameter" : "request_rejected";
  return new OpenAIServiceError("OPENAI_REQUEST_REJECTED", false, {stage:"request",reason});
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
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) invalid("response_too_large", "response");
  if (!response.body) invalid("response_json", "response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) invalid("response_too_large", "response");
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
  catch { invalid("response_json", "response"); }
}

function readOutput(body: unknown): { value: unknown; usage: Usage | null; responseId: string | null; resolvedModel: string | null } {
  if (!record(body)) invalid("response_shape", "response");
  const usage = parseUsage(body.usage);
  const responseId = safeIdentifier(body.id);
  try {
    if (body.status === "failed") throw providerError(500, body);
    // Check the envelope first: an incomplete reply can legitimately have no
    // message at all (e.g. the token cap was exhausted during reasoning).
    if (body.status === "incomplete") fail("MODEL_INCOMPLETE", "output_incomplete", "output");
    if (body.status !== "completed" || body.error != null) invalid("response_status", "response");
    if (!Array.isArray(body.output)) invalid("response_shape", "response");
    const parts: string[] = [];
    let messages=0;
    for (const item of body.output) {
      if (!record(item)) invalid("response_shape", "response");
      if (item.type !== "message") continue;
      if (item.role !== "assistant" || !Array.isArray(item.content)) invalid("response_shape", "response");
      messages++;
      for (const content of item.content) {
        if (!record(content)) invalid("response_shape", "response");
        if (content.type === "refusal") fail("MODEL_REFUSAL", "output_refusal", "output");
        if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
        else invalid("response_shape", "response");
      }
      if (item.status === "incomplete") fail("MODEL_INCOMPLETE", "output_incomplete", "output");
      if (item.status !== undefined && item.status !== "completed") invalid("response_status", "response");
    }
    if (messages>1) invalid("output_multiple", "output");
    const outputText=parts.join('');
    if (messages===0 || parts.length===0 || outputText.trim().length===0) invalid("output_missing", "output");
    let value: unknown;
    // A Responses message has an ordered content array. Join its text blocks,
    // but never combine competing messages, strip fences, repair JSON or run code.
    try { value = JSON.parse(outputText); } catch { invalid("output_json", "output"); }
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
  #idFactory: () => string;
  constructor(options: OpenAIServiceOptions) {
    this.#getApiKey = options.getApiKey;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#budgetMs = options.budgetMs ?? 15_000;
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    if (!Number.isFinite(this.#budgetMs) || this.#budgetMs <= 0 || this.#budgetMs > 60_000) {
      fail("INVALID_INPUT");
    }
  }

  async lookup(input: LookupInput, options: { signal?: AbortSignal; refine?: boolean } = {}): Promise<LookupExecution> {
    validateLookupInput(input);
    const snapshot = structuredClone(input);
    const model = options.refine === true ? REFINE_MODEL : LOOKUP_MODEL;
    const reasoningEffort = options.refine === true ? REFINE_REASONING_EFFORT : LOOKUP_REASONING_EFFORT;
    const result = await this.#request(model, LOOKUP_SYSTEM_PROMPT, lookupPromptData(snapshot),
      "language_reader_lookup_v8", lookupModelSchema(snapshot), LOOKUP_MAX_OUTPUT_TOKENS, reasoningEffort, options.signal);
    let content: ModelLookupOutput;
    try { content = validateModelLookup(result.value, snapshot, {requireSentenceTranslation: true}); }
    catch (error) {
      if (error instanceof OpenAIServiceError) { error.usage = result.usage; error.responseId = result.responseId; }
      throw error;
    }
    const {selectedCandidateId,...validated}=content;
    const candidate=snapshot.phrasalCandidates?.find(item=>item.id===selectedCandidateId);
    const chosen=candidate??{expression:snapshot.expression,...snapshot.context};
    const data:LookupData={lookupId:this.#idFactory(),expression:chosen.expression,...validated,
      ...(snapshot.phrasalCandidates?{resolvedTarget:{candidateId:selectedCandidateId??null,targetStart:chosen.targetStart,targetEnd:chosen.targetEnd}}:{})};
    try { validateLookupResult(data,snapshot); }
    catch (error) {
      if (error instanceof OpenAIServiceError) { error.usage=result.usage; error.responseId=result.responseId; }
      throw error;
    }
    return {
      data,
      model, reasoningEffort, resolvedModel: result.resolvedModel, responseId: result.responseId,
      usage: result.usage, cacheHit: false,
      warnings: content.ipaCandidate === null ? [] : ["IPA_GENERATED_APPROXIMATE"],
    };
  }

  async enrich(input: EnrichInput, options: { signal?: AbortSignal } = {}): Promise<ModelExecution<ContextExample[]>> {
    validateEnrichInput(input);
    const snapshot = structuredClone(input);
    const result = await this.#request(LOOKUP_MODEL, ENRICH_SYSTEM_PROMPT, examplePromptData(snapshot),
      "language_reader_examples_v2", EXAMPLE_MODEL_SCHEMA, ENRICH_MAX_OUTPUT_TOKENS, LOOKUP_REASONING_EFFORT, options.signal);
    let example: ContextExample[];
    try { example = validateExamples(result.value); }
    catch (error) {
      if (error instanceof OpenAIServiceError) { error.usage = result.usage; error.responseId = result.responseId; }
      throw error;
    }
    return {
      data: example, model: LOOKUP_MODEL, reasoningEffort: LOOKUP_REASONING_EFFORT,
      resolvedModel: result.resolvedModel, responseId: result.responseId,
      usage: result.usage, cacheHit: false, warnings: ["EXAMPLE_AI_GENERATED"],
    };
  }

  async #request(model: TextModel, instructions: string, data: string, name: string,
    schema: unknown, maxOutputTokens:number, reasoningEffort: TextReasoningEffort, externalSignal?: AbortSignal) {
    const controller = new AbortController();
    const timeoutError = new OpenAIServiceError("NETWORK_TIMEOUT", true);
    const cancelError = new OpenAIServiceError("REQUEST_CANCELLED");
    const onExternalAbort = () => controller.abort(cancelError);
    if (externalSignal?.aborted) controller.abort(cancelError);
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError), this.#budgetMs);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      let key: string | null;
      try { key = await abortable(Promise.resolve().then(this.#getApiKey), controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new OpenAIServiceError("OPENAI_AUTH");
      }
      if (typeof key !== "string" || !/^[\x21-\x7e]{1,512}$/u.test(key)) throw new OpenAIServiceError("OPENAI_AUTH");
      // A POST may already have been billed even if its response is lost. Any
      // repeat requires a new explicit user action, including transient failures.
      try {
        const response = await abortable(this.#fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model, store: false, stream: false,
            reasoning: { effort: reasoningEffort },
            instructions,
            input: [{ role: "user", content: [{ type: "input_text", text: data }] }],
            text: { format: { type: "json_schema", name, strict: true, schema } },
            max_output_tokens: maxOutputTokens,
          }),
          redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
          signal: controller.signal,
        }), controller.signal);
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
        throw error instanceof OpenAIServiceError ? error : new OpenAIServiceError("INTERNAL_ERROR", true);
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
