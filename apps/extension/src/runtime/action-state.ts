export type ReaderActionTarget = 'library' | 'web' | 'restricted';

/** Recognize only this extension's own library, not another extension or a URL
 * that merely contains its path. Query/hash never change the page identity.
 * The Chrome Web Store is HTTPS, but Chrome does not allow script injection there. */
export function readerActionTarget(url: string | undefined, libraryUrl: string): ReaderActionTarget {
  if (!url) return 'restricted';
  try {
    const page = new URL(url), library = new URL(libraryUrl);
    if (page.protocol === library.protocol && page.host === library.host && page.pathname === library.pathname) return 'library';
    if (page.protocol !== 'http:' && page.protocol !== 'https:') return 'restricted';
    if (page.hostname === 'chromewebstore.google.com' ||
      (page.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(page.pathname))) return 'restricted';
    return 'web';
  } catch { return 'restricted'; }
}

export interface ReaderActionPage {
  id: number | undefined;
  url: string | undefined;
  target: ReaderActionTarget;
  label: string;
}

/** Read-only presentation data. Never display a URL's credentials, path or query. */
export function readerActionPage(tab: Pick<chrome.tabs.Tab, 'id' | 'url'> | undefined, libraryUrl: string): ReaderActionPage {
  const candidateId = tab?.id;
  const id = typeof candidateId === 'number' && Number.isSafeInteger(candidateId) && candidateId >= 0 ? candidateId : undefined;
  let target = readerActionTarget(tab?.url, libraryUrl);
  if (target === 'web' && id === undefined) target = 'restricted';
  let label = 'Текущая вкладка';
  if (target === 'library') label = 'Библиотека Language Reader';
  else if (tab?.url) {
    try {
      const url = new URL(tab.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') label = url.hostname;
      else if (url.protocol === 'file:') label = 'Локальный файл';
      else if (url.protocol === 'chrome-extension:') label = 'Страница расширения';
      else label = 'Служебная страница браузера';
    } catch { /* Keep the neutral label for unavailable URL data. */ }
  }
  return { id, url: tab?.url, target, label };
}

export function sameReaderActionPage(first: ReaderActionPage, second: ReaderActionPage): boolean {
  return first.id === second.id && first.url === second.url && first.target === second.target;
}
