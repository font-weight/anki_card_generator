import {extractFromRange, type ExtractedText, type ExtractionResult} from './extraction';
import type {createReaderPreferenceCache} from '../runtime/reader-preferences';

/** Both the fallback button and Alt pass through this check before mounting.
 * A chapter or SPA can replace its source while the settings request is in flight. */
export function requestGrammarOpening(
  preferences: ReturnType<typeof createReaderPreferenceCache>,
  value: ExtractedText,
  onError: (failure: Extract<ExtractionResult, {ok:false}>) => void,
  open: (exact: ExtractedText) => void,
  sourceAlive: () => boolean = () => true,
) {
  const {range} = value;
  const doc = range.startContainer.ownerDocument;
  const frame = doc?.defaultView?.frameElement as HTMLIFrameElement | null;
  const url = doc?.URL;
  return preferences.openGrammarIfEnabled(() => {
    if (!sourceAlive() || !doc || doc.URL !== url || doc.hidden ||
      (frame && (!frame.isConnected || frame.contentDocument !== doc)) ||
      range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return;
    const exact = extractFromRange(range, preferences.getSnapshot().dialect, 'sentence');
    if (!exact.ok) { onError(exact); return; }
    if (exact.expression !== value.expression || exact.context.sentence !== value.context.sentence ||
      exact.context.targetStart !== value.context.targetStart || exact.context.targetEnd !== value.context.targetEnd) return;
    open(exact);
  });
}
