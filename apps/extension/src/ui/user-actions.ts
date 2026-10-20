/** Native event provenance, not Shadow DOM isolation, gates reader UI actions.
 * Internal module only: deliberately no configurable production bypass.
 * Unit tests may mock this predicate; that is not evidence of browser trust.
 */
export function isTrustedUiEvent(event: Event): boolean {
  return event.isTrusted === true;
}
