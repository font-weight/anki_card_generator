/** A left-Alt tap is intentionally separate from Shift lookup. It never runs a
 * request itself and can only consume a fresh, trusted down/up pair. */
export type GrammarKey = Pick<KeyboardEvent, 'key' | 'code' | 'isTrusted' | 'repeat' | 'isComposing' | 'ctrlKey' | 'shiftKey' | 'metaKey'> &
  Partial<Pick<KeyboardEvent, 'keyCode' | 'altKey' | 'getModifierState'>>;
export const GRAMMAR_GESTURE_MAX_MS = 1500;
export function isCleanLeftAlt(event: GrammarKey, composing = false, editable = false): boolean {
  return event.key === 'Alt' && event.code === 'AltLeft' && event.isTrusted && !event.repeat && !event.isComposing &&
    event.keyCode !== 229 && !composing && !editable && !event.ctrlKey && !event.shiftKey && !event.metaKey &&
    event.getModifierState?.('AltGraph') !== true;
}
export function createGrammarGesture<T>(now: () => number = () => performance.now()) {
  let pending: { value: T; started: number } | undefined;
  return {
    begin(event: GrammarKey, value: T, enabled: boolean, composing = false, editable = false): boolean {
      pending = undefined;
      if (!enabled || !isCleanLeftAlt(event, composing, editable)) return false;
      pending = { value, started: now() }; return true;
    },
    cancel() { pending = undefined; },
    release(event: GrammarKey, enabled: boolean, composing = false, editable = false): T | null {
      const captured = pending; pending = undefined;
      if (!captured || !enabled || !isCleanLeftAlt(event, composing, editable)) return null;
      const elapsed = now() - captured.started;
      return elapsed >= 0 && elapsed <= GRAMMAR_GESTURE_MAX_MS ? captured.value : null;
    },
  };
}
