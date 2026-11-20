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

describe('safe grammar preference cache',()=>{
 it('updates the visible shortcut immediately on invalidation and only from the latest consent read',async()=>{
  const outdated=deferred<Partial<PublicSettings>>(),latest=deferred<Partial<PublicSettings>>();
  const read=vi.fn().mockResolvedValueOnce({grammarEnabled:true}).mockReturnValueOnce(outdated.promise).mockReturnValueOnce(latest.promise);
  const visible=vi.fn(),cache=createReaderPreferenceCache(read,visible);
  await cache.refresh();expect(visible.mock.lastCall).toEqual([true]);
  const stale=cache.refresh(),revoked=cache.refreshGrammarConsent();expect(visible.mock.lastCall).toEqual([false]);
  latest.resolve({grammarEnabled:false});await revoked;outdated.resolve({grammarEnabled:true});await stale;
  expect(visible.mock.calls).toEqual([[true],[false],[false]]);
 });
 it('is off before hydration and honors only a confirmed explicit opt-in',async()=>{
  const read=vi.fn().mockResolvedValueOnce({grammarEnabled:true,grammarIncludeExplanation:false,grammarExplanationLanguage:'fr'}).mockResolvedValueOnce({});
  const cache=createReaderPreferenceCache(read);expect(cache.getGrammarSnapshot()).toEqual({enabled:false,includeExplanation:true,explanationLanguage:'ru'});
  await cache.refresh();expect(cache.getGrammarSnapshot()).toEqual({enabled:true,includeExplanation:false,explanationLanguage:'fr'});expect(cache.getSnapshot()).not.toHaveProperty('grammarEnabled');
  await cache.refresh();expect(cache.getGrammarSnapshot().enabled).toBe(false);
 });
 it('never rolls a newer disabled preference back to a stale enabled response',async()=>{
  const first=deferred<Partial<PublicSettings>>(),second=deferred<Partial<PublicSettings>>();const cache=createReaderPreferenceCache(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
  const old=cache.refresh(),fresh=cache.refresh();second.resolve({grammarEnabled:false});await fresh;first.resolve({grammarEnabled:true});await old;expect(cache.getGrammarSnapshot().enabled).toBe(false);
 });
});

it('immediately suspends cached Alt gestures on a consent-change hint even if the followup read fails',async()=>{
 const failed=deferred<Partial<PublicSettings>>();
 const cache=createReaderPreferenceCache(vi.fn().mockResolvedValueOnce({grammarEnabled:true}).mockReturnValueOnce(failed.promise));
 await cache.refresh();expect(cache.getGrammarSnapshot().enabled).toBe(true);
 const pending=cache.refreshGrammarConsent();expect(cache.getGrammarSnapshot().enabled).toBe(false);
 failed.reject(new Error('offline'));await pending;expect(cache.getGrammarSnapshot().enabled).toBe(false);
});
