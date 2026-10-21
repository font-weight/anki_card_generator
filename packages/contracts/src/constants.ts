export const ERROR_CODES = ['INVALID_INPUT','PERMISSION_DENIED','EXTRACTION_FAILED','OPENAI_AUTH','OPENAI_QUOTA','OPENAI_RATE_LIMIT','MODEL_UNAVAILABLE','MODEL_REFUSAL','INVALID_MODEL_OUTPUT','NETWORK_TIMEOUT','DICTIONARY_UNAVAILABLE','AUDIO_UNAVAILABLE','ANKI_UNAVAILABLE','ANKI_AUTH','ANKI_ORIGIN_DENIED','ANKI_SCHEMA_MISMATCH','STORAGE_QUOTA','OPERATION_CONFLICT','REQUEST_CANCELLED','MODEL_INCOMPLETE','LOOKUP_EXPIRED','ANKI_DECK_NOT_FOUND','STORAGE_UNAVAILABLE','INTERNAL_ERROR'] as const;
export const OPERATION_STATES = ['pending','preparing_audio','awaiting_audio_decision','awaiting_duplicate_decision','ready','submitting','reconciling','synced','failed','cancelled'] as const;
/** Bounds for new lookup results and v3 full-meaning cards, not legacy drafts. */
export const MAX_LOOKUP_SENSES=8;
export const MAX_SENSE_TRANSLATIONS=4;
