# Model and language validation

Checked: **2026-10-21 UTC**. This records documentary verification and offline implementation tests, not live API acceptance or translation accuracy.

## Required models and lifecycle

| Purpose | Configured model | Production policy | Target-project availability |
|---|---|---|---|
| Contextual lookup and explicit extra example | `gpt-6-luna` | `reasoning.effort=none`; no fallback | `not_run` |
| Explicit `lookup.refine` only | `gpt-6-luna` | `reasoning.effort=low`; never automatic | `not_run` |
| Exportable audio (separate audio module) | `gpt-4o-mini-tts` | Text adapter does not invoke audio | `not_run` |

The official [GPT-6 Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna) explicitly documents the public API identifier, Responses, Structured Outputs, and `none`/`low` reasoning efforts. It lists medium as the default; this application selects effort explicitly. Free-tier API access is unsupported; target-project entitlement, live acceptance and quality are unverified. Luna does not support audio, so TTS is not migrated.

The owner requested GPT-6 Luna **inside the extension**, replacing the former text defaults. `none` preserves the latency/cost role of ordinary translation and examples; `low` distinguishes the separate, explicit refinement action without switching model. This is an implementation choice, not measured evidence of better translation quality. Both use the existing bounded output caps; reasoning consumes that cap too. See [GPT-6 migration guidance](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart).

Old model IDs remain only as historical metadata types. No stored model-selection preference existed. Old caches are preserved but rejected; new keys include effort so lookup and refinement cannot be confused. Existing durable notes, queue operations, TTS configurations and saved audio are untouched. No credential was inspected and no live/paid call was made for this migration.

## API format verified against official documentation

The [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create) and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) were consulted. The REST request uses:

- `POST https://api.openai.com/v1/responses`, with `text.format.type="json_schema"`, `strict=true`, a named root-object schema and `additionalProperties=false`.
- Required properties at every object level; nullable candidates are represented explicitly. Provider-side schemas use a conservative supported structural subset. Local validation additionally enforces text bounds, cardinalities, unique IDs, original selection ranges and cross-field consistency.
- Response parsing from `output[].content[]`, not an SDK-only `output_text` shortcut. Refusal blocks and incomplete response status are handled separately. Complete output must contain one JSON text result; Markdown extraction is not attempted.

No official SDK is installed: the production adapter uses injected Fetch or the platform's native Fetch. The implementation is not an assertion that strict format works in the target project; that requires an authorized live request.

## Implemented behavior and offline checks

`packages/services/src/openai.ts`:

- Fixed HTTPS endpoint; callers cannot select a provider URL. Redirects are rejected, cookies omitted, no tools enabled, `store=false`, and no source metadata, URL, local path or whole book is added to the prompt.
- The original short context is allowlisted, bounded to 1,500 UTF-16 units and treated as untrusted quoted data. Selection offsets refer to the unnormalized original sentence and cannot cut a surrogate pair.
- Exact requested models, no automatic upgrade or fallback. Lookup supplies sufficient semantic fields for a card and leaves the extra example null. Enrichment is a separate explicit request with `source="ai"`.
- Overall default 15-second budget, at most one controlled retry for transient rate-limit/network/server errors, with `Retry-After` honored only when it fits the remaining budget. Auth, quota, unavailable-model, refusal, malformed JSON and incomplete-output errors are not automatically retried.
- Abort/deadline enforcement includes secret retrieval and streaming body reads, including injected adapters that ignore their signal. Response bodies are bounded to 128 KiB. Cancellation cannot undo billing or prove the provider stopped work.
- Sanitized shared error codes never include keys, provider error messages or quoted source content. Known usage is retained on successful results and malformed/incomplete model results; absent usage stays null internally and must be omitted from public RPC metadata, never reported as invented zero.
- IPA is explicitly generated and approximate, never dictionary verified.

`packages/services/src/lookup.ts`:

- One locally active lookup; a changed selection aborts obsolete work where possible. Matching requests coalesce.
- Cancellation is subscriber-specific. Cancelling one coalesced caller does not cancel another, and an obsolete request cannot cancel a new selection.
- A coordinator deadline also bounds cache reads/writes. Cache failures do not manufacture a response; an invalid cache is ignored and an unavailable write produces a warning.
- Cache keys include expression, original context, offsets, both adjacent strings, languages, level, dialect, requested model, reasoning effort, prompt version and model schema version. Word-only caching is not used.
- Cache hits do not report historical token usage as a fresh API charge. Returned data and in-flight inputs are copied so callers cannot mutate another request.

The prompt and schema versions are exported from `prompts.ts`. A must instantiate the coordinator once in the trusted service worker, supply real secret/storage adapters and preserve sender ownership when mapping `lookup.cancel`.

## Language reference dataset

`fixtures/language.json` contains **186 original synthetic cases**, exceeding the required 150. Coverage includes polysemy, phrasal verbs, idioms, irregular forms, negation, heteronyms, insufficient context, quoted prompt injection and UTF-16/repeated-selection fidelity. Categories overlap.

Every case records:

- The exact request and original selection.
- Intended meaning(s), local semantic sense keys and acceptable Russian variants.
- Recommendation/ambiguity expectations, lemma, part of speech and optional pronunciation distinctions.
- Synthetic-agent authorship and an author self-check, distinguished from independent-agent and human review.

The dataset is **not human-certified gold**, and neither structural tests nor author self-checks establish semantic quality. Dot A has independently checked the selection ranges for all **186 cases**. This is an independent agent range-integrity check, not approval of the semantic labels. The difficult-case semantic review shortlist remains pending; independent semantic review and human linguistic review remain `not_run`. Do not describe agent review as expert human review.

## Paid-test authorization and current gate

The owner explicitly approved **USD 5 total across the entire A+B project** for translation and speech API tests. This is one shared ceiling, not USD5 per agent, model, request or run. Dot a owns any future host live-test execution and a single shared spend ledger; B must not start parallel paid runs.

A safely supplied API key is still absent. **Live testing is paused at the safe-key gate: no live API call, spend or credential provisioning has occurred.** This authorization does not prove that all 186 cases plus audio fit within the cap. Before any live run, verify current tariffs, define a small bounded test plan, reserve for maximum output and any allowed retry, and track aggregate spend against the remaining ceiling. Dataset-wide budget feasibility is **not yet verified**.

### Planned semantic scoring

After safe BYOK is available, A has established the single shared ledger, and the planned run fits the remaining USD5 project ceiling:

1. Freeze the agreed dataset and document any independently reviewed label corrections.
2. Run each approved case against the actual configured model/prompt/schema, saving safe result metadata, usage and returned semantic fields without secrets.
3. Have an independent reviewer assess contextual meaning, selected-sense recommendation, ambiguity, negation scope and injection resistance. Do not use only the answer-generating model to grade itself.
4. Match senses semantically, not by arbitrary model IDs. Accept natural Russian inflections and equivalent wording; exact-string translation matching alone is insufficient.
5. Count a clear-context case correct only when the recommended sense is contextually correct and its equivalents do not mix unrelated meanings. Count an ambiguous case correct only when ambiguity is preserved, recommendation is null and relevant alternatives are not collapsed into one sense.
6. Report denominator, exclusions/failures, per-category results and reviewer identities. Structural failures, refusal and unresolved meaning failures count as failures unless the evaluation protocol agreed an explicit exclusion before the run.

The target is **at least 95% correct contextual meanings on the agreed set**. With 186 evaluated cases this would require at least 177 correct. **Measured semantic accuracy: not available; live evaluation was not run.**

## Validation status and reproducibility

Run from the project root:

```sh
node --experimental-strip-types --test tests/openai.test.ts tests/language-fixtures.test.ts tests/handler-openai.test.ts
```

The OpenAI test suite uses injected in-memory HTTP responses only. It covers actual REST request/response shapes, strict schema, HTTP error classification, secrets not appearing in errors, input validation, refusal/incomplete/malformed output, bounded retries and body reads, usage, explicit enrichment, cancellation, coalescing, mutation isolation and cache behavior. The fixture suite validates dataset structure, coverage, original UTF-16 ranges, provenance, review labels and production-input compatibility.

| Check | Status | Limit |
|---|---|---|
| Official format/model documentation review | Completed | Documentary support only |
| Offline OpenAI adapter/coordinator tests | Passed: 42 tests on 2026-10-20 | Mock HTTP, not live provider behavior |
| Offline fixture integrity checks | Passed: 13 tests on 2026-10-20 | All 186 inputs pass production validation; no semantic score |
| Offline OpenAI handler integration tests | Passed: 10 tests on 2026-10-20 | Metadata, cache fallback, sender isolation, cancellation and cleanup |
| Dot A contract review | Technically accepted | Does not establish production or live-provider validation |
| Dot A independent selection-range check | Completed: 186 cases | Range integrity only; difficult semantic-label review remains pending |
| Paid API test authorization | Approved, USD5 shared A+B project ceiling | A owns live-test execution and one shared ledger; safe key still absent |
| Target-project model availability | `not_run` | No safely supplied key |
| Small strict-schema live smoke test | `not_run`; paused at key gate | Safe API key absent; bounded spend-enforcement plan still required |
| 186-case live semantic evaluation | `not_run` | Safe API key absent; dataset budget feasibility unverified; independent semantic review pending |
| Human linguistic review | `not_run` | No human reviewer has reviewed the dataset |
| Production extension integration | Pending host integration | Owned by dot A |

No API key was read from the environment, no live API request was made, no costs were incurred by these tests, and no production mock fallback exists. No price estimate is displayed, so no undated tariff assumption is embedded.

## Open Questions

- Dot A has technically accepted the contracts and independently checked all 186 selection ranges. Independent review of the difficult semantic-case shortlist remains a coordination dependency.
- The requested text migration is implemented; live acceptance, translation quality, latency and token use for Luna still need an authorized bounded evaluation.
- Real model/project access, live format acceptance, semantic accuracy and production extension wiring remain unverified. Safe-key, shared-ledger readiness and dataset budget-feasibility gates prevent live tests.

## Next Steps for dot A / dot B coordination

1. A connects these modules to the trusted worker, settings/secret storage, shared caches and sender-scoped cancellation; no parallel worker entry is introduced.
2. A reviews the fixture shortlist independently and returns exact case IDs with findings. B incorporates only evidenced review status and corrections.
3. Once safe BYOK is available, A must verify current tariffs and establish the shared ledger before implementing a bounded plan within the remaining USD5 project translation-plus-speech cap. Start with a minimal real Responses strict-format smoke test; do not assume the full dataset fits.
4. Record actual model identity/usage and any live failures; do not turn documentary model support or offline mocks into a claim of live acceptance.

## Luna migration regression checks (2026-10-21)

`node --test tests/openai.test.ts tests/handler-openai.test.ts tests/multilingual-services.test.ts tests/multilingual-handler-services.test.ts tests/multilingual-prompt-regressions.test.ts tests/full-meanings-services.test.ts`: **90 passed** (in-memory HTTP only). Tests verify exact model/effort, strict request shape, existing output caps, no fallback, restart-safe effort-specific cache hits, preserved but rejected GPT-4.1 caches, the exact non-generating model-listing diagnostic, and parsing of reasoning items without exposing them while retaining billed token totals. `npm run typecheck`: passed. These are not a semantic evaluation or browser-install test.

The [Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) documents `max_output_tokens` as the combined visible/reasoning upper bound. No temperature, top_p or legacy max_tokens parameter is sent. Existing single-JSON-output, refusal, incomplete-output, usage, no-tools and store=false handling is retained.
