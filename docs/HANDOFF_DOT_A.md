# dot A handoff

Reasoning: original-context ranges, isolated trusted setup and durable OperationId handling are enforced by shared contracts and tested boundaries. Actual browser execution found issues that static build checks missed, so final candidate status remains blocked rather than done.

Conclusion: source R5 is published on feat/english-reader-v1. Typecheck, 155 unit tests, 211 service tests and both builds pass locally. Previous R4 passed actual Windows reader and isolated Anki tests. Final R5 browser retest was interrupted by the executor usage limit. See REPORT_DOT_A.json and TEST_REPORT.md.

Open Questions: final R5 Windows and previous-Stable behavior; live model availability, semantic quality, actual cost and TTS; explicit future model migration before announced retirement. No secrets are in the repository.

Next Steps for dot a/dot b coordination: preserve R5 and existing test evidence; resume bounded Windows checks after execution allowance returns; review any concrete runtime failure on its exact commit. Use separate test Anki18765 and database, never personal collection. No repeated paid calls or new provider choice without the required key/budget and review.
