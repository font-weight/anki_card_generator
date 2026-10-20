const trustedPages = new Set(['/settings.html', '/library.html', '/queue.html', '/action.html']);
export function classifySender(sender: chrome.runtime.MessageSender, extensionId: string): 'trusted' | 'content' | 'rejected' {
  if (sender.id !== extensionId || !sender.url) return 'rejected';
  try {
    const url = new URL(sender.url);
    if (url.protocol === 'chrome-extension:' && url.hostname === extensionId && trustedPages.has(url.pathname) && (sender.frameId === 0 || sender.frameId === undefined)) return 'trusted';
    if ((url.protocol === 'https:' || url.protocol === 'http:') && sender.tab?.id !== undefined) return 'content';
  } catch { /* reject malformed sender */ }
  return 'rejected';
}
