import { describe, expect, it, vi } from 'vitest';
import type { PublicSettings } from '@english-reader/contracts';
import { createReaderPreferenceCache, lookupPreferences } from '../../apps/extension/src/runtime/reader-preferences';

const arabic = { sourceLanguage: 'ar', targetLanguage: 'ar', learnerLevel: 'A2', dialect: 'ar-SA' } as const;
const japanese = { sourceLanguage: 'ja', targetLanguage: 'ru', learnerLevel: 'B2', dialect: 'ja-JP' } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('reader preferences', () => {
  it('uses explicit same-language preferences and replaces a mismatching locale', () => {
    expect(lookupPreferences({ ...arabic, dialect: 'en-GB' })).toEqual(arabic);
    expect(lookupPreferences({}, japanese)).toEqual(japanese);
    expect(lookupPreferences({ sourceLanguage: 'en', dialect: 'en-GB' })).toMatchObject({ dialect: 'en-GB' });
  });

  it('does not let a slower initial hydration replace the newer focus refresh', async () => {
    const first = deferred<Partial<PublicSettings>>();
    const second = deferred<Partial<PublicSettings>>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const cache = createReaderPreferenceCache(read);
    const initial = cache.refresh();
    const refresh = cache.refresh();
    second.resolve(japanese); await refresh;
    const frozen = cache.getSnapshot();
    first.resolve(arabic); await initial;
    expect(cache.getSnapshot()).toBe(frozen);
    expect(cache.getSnapshot()).toEqual(japanese);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('retains the last confirmed preferences when a refresh fails', async () => {
    const read = vi.fn().mockResolvedValueOnce(arabic).mockRejectedValue(new Error('offline'));
    const cache = createReaderPreferenceCache(read);
    await cache.refresh();
    const frozen = cache.getSnapshot();
    await cache.refresh();
    expect(cache.getSnapshot()).toBe(frozen);
  });

  it('invalidates in-flight reads on cleanup but permits a fresh mount', async () => {
    const stale = deferred<Partial<PublicSettings>>();
    const read = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(japanese);
    const cache = createReaderPreferenceCache(read);
    const pending = cache.refresh();
    cache.invalidate(); stale.resolve(arabic); await pending;
    expect(cache.getSnapshot().sourceLanguage).toBe('en');
    await cache.refresh();
    expect(cache.getSnapshot()).toEqual(japanese);
  });
});
