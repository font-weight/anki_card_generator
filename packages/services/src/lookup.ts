import {
  LOOKUP_MODEL, REFINE_MODEL, OpenAIService, OpenAIServiceError, abortable,
  validateLookupInput, validateModelLookup,
} from "./openai.ts";
import type { LookupExecution, TextModel } from "./openai.ts";
import type { LookupInput } from "./prompts.ts";
import { MODEL_SCHEMA_VERSION, PROMPT_VERSION } from "./prompts.ts";

export interface LookupCache {
  get(key: string): Promise<LookupExecution | undefined>;
  set(key: string, value: LookupExecution): Promise<void>;
}

/** A private local key, not a provider request or a logging string. */
export function lookupCacheKey(input: LookupInput, model: TextModel): string {
  validateLookupInput(input);
  return JSON.stringify([
    PROMPT_VERSION, MODEL_SCHEMA_VERSION, model,
    input.expression, input.context.sentence, input.context.targetStart, input.context.targetEnd,
    input.context.before ?? null, input.context.after ?? null,
    input.sourceLanguage, input.targetLanguage, input.learnerLevel, input.dialect,
  ]);
}

type Active = {
  key: string;
  subscribers: Map<string, AbortController>;
  controller: AbortController;
  promise: Promise<LookupExecution>;
};

/**
 * Instantiate once in the trusted worker. A changed selection cancels obsolete
 * local work before starting the next one. Abort cannot reverse provider billing.
 * Identical simultaneous requests share one result and one provider call.
 */
export class LookupCoordinator {
  #service: Pick<OpenAIService, "lookup">;
  #cache?: LookupCache;
  #active?: Active;
  #budgetMs: number;
  constructor(service: Pick<OpenAIService, "lookup">, cache?: LookupCache, budgetMs = 15_000) {
    this.#service = service;
    this.#cache = cache;
    this.#budgetMs = budgetMs;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) {
      throw new OpenAIServiceError("INVALID_INPUT");
    }
  }

  lookup(input: LookupInput, options: {
    requestId: string;
    refine?: boolean;
    signal?: AbortSignal;
  }): Promise<LookupExecution> {
    validateLookupInput(input);
    if (!options.requestId || options.signal?.aborted) {
      return Promise.reject(new OpenAIServiceError(
        options.signal?.aborted ? "REQUEST_CANCELLED" : "INVALID_INPUT",
      ));
    }
    const model = options.refine === true ? REFINE_MODEL : LOOKUP_MODEL;
    const key = lookupCacheKey(input, model);
    if (this.#active?.key === key && !this.#active.controller.signal.aborted) {
      return this.#subscribe(this.#active, options.requestId, options.signal);
    }
    this.#active?.controller.abort(new OpenAIServiceError("REQUEST_CANCELLED"));
    const controller = new AbortController();
    const active: Active = {
      key, subscribers: new Map(), controller,
      promise: Promise.resolve(undefined as unknown as LookupExecution),
    };
    this.#active = active;
    // Snapshot before asynchronous work: caller mutation cannot alter the request.
    const snapshot = structuredClone(input);
    const deadline = setTimeout(() => controller.abort(new OpenAIServiceError("NETWORK_TIMEOUT", true)), this.#budgetMs);
    active.promise = this.#execute(snapshot, model, active).finally(() => {
      clearTimeout(deadline);
      if (this.#active === active) this.#active = undefined;
    });
    return this.#subscribe(active, options.requestId, options.signal);
  }

  /** Cancels only the identified subscriber, not a newer selection/request. */
  cancel(requestId: string): boolean {
    const active = this.#active;
    const subscriber = active?.subscribers.get(requestId);
    if (!active || !subscriber) return false;
    subscriber.abort(new OpenAIServiceError("REQUEST_CANCELLED"));
    active.subscribers.delete(requestId);
    if (active.subscribers.size === 0) active.controller.abort(new OpenAIServiceError("REQUEST_CANCELLED"));
    return true;
  }

  #subscribe(active: Active, requestId: string, signal?: AbortSignal): Promise<LookupExecution> {
    const subscriber = active.subscribers.get(requestId) ?? new AbortController();
    active.subscribers.set(requestId, subscriber);
    const onAbort = () => this.cancel(requestId);
    signal?.addEventListener("abort", onAbort, { once: true });
    return abortable(active.promise, subscriber.signal).then(value => structuredClone(value)).catch(error => {
      if (signal?.aborted) throw new OpenAIServiceError("REQUEST_CANCELLED");
      throw error;
    }).finally(() => signal?.removeEventListener("abort", onAbort));
  }

  async #execute(input: LookupInput, model: TextModel, active: Active): Promise<LookupExecution> {
    const signal = active.controller.signal;
    if (this.#cache) {
      try {
        const cached = await abortable(this.#cache.get(active.key), signal);
        if (cached && cached.model === model && cached.data.expression === input.expression) {
          const { lookupId, expression, ...content } = cached.data;
          validateModelLookup(content, input);
          if (typeof lookupId === "string" && lookupId.length > 0 && expression === input.expression) {
            // There is no new API usage on a cache hit. Null is not a fabricated zero.
            return { ...structuredClone(cached), usage: null, responseId: null, cacheHit: true };
          }
        }
      } catch {
        if (signal.aborted) throw signal.reason;
        // An absent/corrupt/unavailable disposable cache does not block translation.
      }
    }
    if (signal.aborted) throw signal.reason;
    const result = await abortable(this.#service.lookup(input, {
      signal, refine: model === REFINE_MODEL,
    }), signal);
    if (signal.aborted) throw signal.reason;
    if (this.#cache) {
      try { await abortable(this.#cache.set(active.key, structuredClone(result)), signal); }
      catch {
        if (signal.aborted) throw signal.reason;
        return { ...result, warnings: [...result.warnings, "LOOKUP_CACHE_UNAVAILABLE"] };
      }
    }
    return result;
  }
}
