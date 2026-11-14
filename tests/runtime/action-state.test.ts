import { describe, expect, it } from 'vitest';
import { readerActionPage, readerActionTarget, sameReaderActionPage } from '../../apps/extension/src/runtime/action-state';

const library = 'chrome-extension://own-extension/library.html';

describe('toolbar page classification', () => {
  it.each([library, `${library}?book=4`, `${library}#chapter`, `${library}?book=4#chapter`])('recognizes its exact library: %s', url => {
    expect(readerActionTarget(url, library)).toBe('library');
  });

  it.each([
    undefined, '', 'not a URL', 'chrome://settings/', 'about:blank', 'edge://newtab/',
    'file:///books/story.pdf', 'chrome-extension://other/library.html',
    'chrome-extension://own-extension/settings.html', `${library}/extra`,
    'https://chromewebstore.google.com/', 'https://chromewebstore.google.com/detail/reader',
    'https://chrome.google.com/webstore', 'https://chrome.google.com/webstore/detail/reader',
  ])('does not offer injection on restricted or unknown pages: %s', url => {
    expect(readerActionTarget(url, library)).toBe('restricted');
  });

  it.each([
    'https://example.com/library.html', 'http://localhost:8080/',
    'https://chromewebstore.google.com.example.com/', 'https://example.com/chrome.google.com/webstore',
    'https://chrome.google.com/webstore-other', 'https://chrome.google.com/other',
  ])('keeps ordinary HTTP(S) pages eligible without claiming activation: %s', url => {
    expect(readerActionTarget(url, library)).toBe('web');
  });

  it.each([undefined, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('requires a valid tab ID for activation: %s', id => {
    expect(readerActionPage({ id, url: 'https://example.com/' }, library).target).toBe('restricted');
  });

  it('allows the valid zero tab ID and handles no current tab', () => {
    expect(readerActionPage({ id: 0, url: 'https://example.com/' }, library)).toMatchObject({ id: 0, target: 'web' });
    expect(readerActionPage(undefined, library)).toEqual({ id: undefined, url: undefined, target: 'restricted', label: 'Текущая вкладка' });
  });

  it('displays only the hostname, never URL credentials, private paths or queries', () => {
    expect(readerActionPage({ id: 12, url: 'https://someone:secret@example.com/private/book?token=private#section' }, library).label).toBe('example.com');
    expect(readerActionPage({ id: 12, url: 'file:///private/book.pdf' }, library).label).toBe('Локальный файл');
    expect(readerActionPage({ id: 12, url: library }, library).label).toBe('Библиотека Language Reader');
  });

  it('invalidates the visible target after a tab switch, full navigation or hash change', () => {
    const first = readerActionPage({ id: 12, url: 'https://example.com/' }, library);
    expect(sameReaderActionPage(first, { ...first })).toBe(true);
    for (const next of [{ ...first, id: 13 }, { ...first, url: 'https://other.com/' }, { ...first, url: `${first.url}#chapter` }]) {
      expect(sameReaderActionPage(first, next)).toBe(false);
    }
  });
});
