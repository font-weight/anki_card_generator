# Low-cost model evaluation plan

Checked 2026-10-20. This document proposes evaluation only; it does not change the configured GPT-4.1 mini default or authorize paid tests.

Official standard uncached USD per million tokens:

| Model | Input | Output | Decision |
|---|---:|---:|---|
| GPT-4.1 mini | 0.40 | 1.60 | Current explicit specification; retirement announced |
| GPT-6 Luna | 0.10 | 0.50 | First replacement candidate to evaluate |
| GPT-5.6 Luna | 0.20 | 1.20 | Comparator; not cheaper than GPT-6 Luna |
| GPT-5 nano | 0.05 | 0.40 | Retiring soon; unsuitable new default |

Illustration: 1000 input plus 500 billed output tokens per lookup yields about $0.35 for 1000 GPT-6 Luna lookups. This is not measured usage or a spending guarantee. Excludes audio, retries, extra examples, refinement, tax and regional uplift. 1500 UTF-16 context units are not 1500 tokens; prompts/schema also count. Reasoning output can add billed tokens. Evaluate reasoning.effort:none explicitly for the candidate.

Sources:
- https://developers.openai.com/api/docs/models/gpt-4.1-mini
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://developers.openai.com/api/docs/models/gpt-5-nano
- https://developers.openai.com/api/docs/deprecations

The official retirement table lists GPT-4.1/mini snapshots for 2027-01-14 and current gpt-4o-mini-tts snapshots for 2027-01-06. Text and audio migrations are separate. Do not introduce GPT-4.1 nano, whose listed retirement is 2026-10-23.

Before switching: validate exact request/schema compatibility and cache separation offline, obtain safe key plus explicit numeric budget, then compare bounded live fixtures with blind semantic review. Report contextual Russian meaning, lemma/POS, ambiguity, schema failures/refusals, actual token usage/retries and latency. Existing 186 agent-authored fixtures are not human gold; 95% semantic accuracy is an unmeasured target. No model's documented Structured Outputs support establishes translation quality.
