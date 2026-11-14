/** Compile-time validation build only. Never toggled by web content or public settings. */
export const isolatedAnkiTestMode = import.meta.env.VITE_ISOLATED_ANKI_TEST === '1';
export const storageOptions = isolatedAnkiTestMode ? {name:'english-reader-isolated-anki-test-v1'} : {};
