// HTML maxlength and the wire validator both count UTF-16 code units.
// The provider counts tokens independently, including the structured envelope.
export const GRAMMAR_QUESTION_LIMIT=10_000;
export const GRAMMAR_CHAT_OUTPUT_TOKENS=10_000;
export const GRAMMAR_ANSWER_LIMIT=128*GRAMMAR_CHAT_OUTPUT_TOKENS;
export const GRAMMAR_CHAT_TIMEOUT_MS=180_000;
export const GRAMMAR_CHAT_RPC_TIMEOUT_MS=195_000;
export const GRAMMAR_CHAT_HISTORY_UNITS=48_000;
export const GRAMMAR_CHAT_HISTORY_TURNS=5;
