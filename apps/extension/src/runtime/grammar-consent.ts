/** Only the worker can invalidate a reader's cached consent. No settings, URL,
 * source text or tab metadata are included in this notification. */
const changeType = 'reader.grammarConsentChanged';

export function subscribeGrammarConsentChange(refresh: () => void): () => void {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return () => {};
  const listener = (message: { type?: string } | null, sender: chrome.runtime.MessageSender) => {
    if (sender.id === runtime.id && !sender.tab && message?.type === changeType) refresh();
  };
  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}

export async function notifyGrammarConsentChange(): Promise<void> {
  const message = {type: changeType};
  // Runtime messages reach extension pages. Per-tab messages reach only this
  // extension's own isolated scripts; a tab without the reader has no receiver.
  await Promise.allSettled([
    chrome.runtime.sendMessage(message),
    chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.flatMap(tab =>
      tab.id === undefined ? [] : [chrome.tabs.sendMessage(tab.id, message, {frameId: 0})]))),
  ]);
}
