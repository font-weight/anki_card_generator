import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteDraftV3 } from '@english-reader/contracts';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';
import { preparedAudioDraftKey, usePreparedAudio } from '../../apps/extension/src/ui/use-prepared-audio';

const audioId = 'c04f8451-3d8b-411a-b71a-75035f17bed0';
const otherAudioId = 'd04f8451-3d8b-411a-b71a-75035f17bed0';
const primary = { id: 'bank', definition: 'The land beside water.', translations: ['берег'] };
const draft: NoteDraftV3 = {
  draftVersion: 3, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', expression: 'bank', lemma: 'bank', partOfSpeech: 'noun',
  selectedSense: primary, senses: [primary, { id: 'money', definition: 'A financial institution.', translations: ['банк'] }],
  context: { sentence: 'The bank was green.', targetStart: 4, targetEnd: 8 },
  pronunciation: { ipa: '/bæŋk/', dialect: 'en-US', source: 'generated', sourceUrl: null },
  examples: [], deckName: 'Test', mode: 'recognition', tags: [],
  source: { kind: 'html', title: 'Source', url: 'https://example.com', documentId: null, page: null, chapter: null, cfi: null },
};
type Options = Parameters<typeof usePreparedAudio>[0];
let hook: ReturnType<typeof usePreparedAudio>, root: ReturnType<typeof createRoot>, node: HTMLDivElement;
function Harness(props: Options) { hook = usePreparedAudio(props); return <p>{hook.status}:{hook.audioId}:{hook.error}</p>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function render(rpc: UiRpc, changes: Partial<Options> = {}) {
  await act(async () => root.render(<Harness rpc={rpc} draft={draft} lookupId="lookup-1" audioAllowed={true} {...changes} />));
}
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

describe('explicit reviewed-draft audio preparation', () => {
  it('never generates on mount, rerender, or asynchronous pronunciation arrival', async () => {
    const rpc = vi.fn(async () => ({ audioId })) as UiRpc;
    await render(rpc); await render(rpc, { draft: structuredClone(draft) });
    await render(rpc, { draft: { ...draft, pronunciation: { ...draft.pronunciation, ipa: '[bæŋk]' } } });
    expect(rpc).not.toHaveBeenCalled(); expect(hook.status).toBe('idle');
  });

  it('requires stored consent before dispatching even an explicit request', async () => {
    const rpc = vi.fn(async () => ({ audioId })) as UiRpc;
    await render(rpc, { audioAllowed: false }); await act(async () => hook.prepare());
    expect(rpc).not.toHaveBeenCalled(); expect(hook.getAudioId(draft)).toBeUndefined(); expect(hook.error).toContain('согласие');
  });

  it('sets loading synchronously, deduplicates repeated checks, and returns the same prepared ID', async () => {
    const response = deferred<{ audioId: string }>(); const rpc = vi.fn(() => response.promise) as UiRpc;
    await render(rpc);
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = hook.prepare(); expect(hook.isPreparing()).toBe(true); expect(hook.getAudioId(draft)).toBeUndefined(); second = hook.prepare(); });
    expect(rpc).toHaveBeenCalledTimes(1); expect(hook.status).toBe('loading');
    await act(async () => { response.resolve({ audioId }); await Promise.all([first, second]); });
    expect(hook.getAudioId(draft)).toBe(audioId); expect(hook.status).toBe('ready');
    expect(rpc).toHaveBeenCalledWith('audio.prepare', { lookupId: 'lookup-1', senseId: 'bank', draft });
  });

  it('unchecked stale success stays unbound and a later identical recheck reuses that cached file', async () => {
    const response = deferred<{ audioId: string }>(); const rpc = vi.fn(() => response.promise) as UiRpc;
    await render(rpc);
    let pending!: Promise<void>; await act(async () => { pending = hook.prepare(); });
    await act(async () => { hook.reset(); expect(hook.isPreparing()).toBe(false); expect(hook.getAudioId(draft)).toBeUndefined(); });
    await act(async () => { response.resolve({ audioId }); await pending; });
    expect(hook.status).toBe('idle'); expect(hook.getAudioId(draft)).toBeUndefined();
    await act(async () => hook.prepare()); expect(hook.getAudioId(draft)).toBe(audioId); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('uncheck/recheck while pending shares one RPC and the latest intent wins', async () => {
    const response = deferred<{ audioId: string }>(); const rpc = vi.fn(() => response.promise) as UiRpc;
    await render(rpc); let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = hook.prepare(); });
    await act(async () => { hook.reset(); second = hook.prepare(); });
    await act(async () => { response.resolve({ audioId }); await Promise.all([first, second]); });
    expect(rpc).toHaveBeenCalledTimes(1); expect(hook.getAudioId(draft)).toBe(audioId);
  });

  it('cancels same-tick untick before RPC dispatch without a paid request', async () => {
    const rpc = vi.fn(async () => ({ audioId })) as UiRpc; await render(rpc);
    await act(async () => { const pending = hook.prepare(); hook.reset(); await pending; });
    expect(rpc).not.toHaveBeenCalled(); expect(hook.status).toBe('idle');
  });

  it('ignores a stale completion after a different meaning edit, even when old response arrives last', async () => {
    const old = deferred<{ audioId: string }>(), next = deferred<{ audioId: string }>();
    const rpc = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise) as UiRpc;
    await render(rpc); let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = hook.prepare(); });
    const changed = structuredClone(draft); changed.senses[1]!.translations = ['финансовый банк'];
    await render(rpc, { draft: changed }); expect(hook.status).toBe('idle');
    await act(async () => { second = hook.prepare(); });
    await act(async () => { next.resolve({ audioId: otherAudioId }); await second; });
    await act(async () => { old.resolve({ audioId }); await first; });
    expect(hook.getAudioId(changed)).toBe(otherAudioId); expect(hook.getAudioId(draft)).toBeUndefined();
  });

  it('snapshots same-tick draft/lookup overrides rather than stale render data', async () => {
    const response = deferred<{ audioId: string }>(); const rpc = vi.fn(() => response.promise) as UiRpc;
    await render(rpc); const changed = structuredClone(draft); changed.pronunciation.ipa = '[bæŋk]';
    let pending!: Promise<void>;
    await act(async () => { hook.reset(); pending = hook.prepare(changed, 'lookup-2'); });
    changed.senses[1]!.translations.push('mutation after capture');
    const captured = (vi.mocked(rpc).mock.calls[0]![1]!.draft as NoteDraftV3);
    expect(captured.pronunciation.ipa).toBe('[bæŋk]'); expect(captured.senses[1]!.translations).toEqual(['банк']);
    expect(vi.mocked(rpc).mock.calls[0]![1]!.lookupId).toBe('lookup-2');
    await render(rpc, { draft: captured, lookupId: 'lookup-2' });
    await act(async () => { response.resolve({ audioId }); await pending; });
    expect(hook.getAudioId(captured)).toBe(audioId); expect(hook.getAudioId(changed)).toBeUndefined();
  });

  it('preserves ready ID on equal objects or export-only edits but invalidates raw IPA changes without regeneration', async () => {
    const rpc = vi.fn(async () => ({ audioId })) as UiRpc; await render(rpc); await act(async () => hook.prepare());
    const changed: NoteDraftV3 = { ...structuredClone(draft), deckName: 'Other', tags: ['tag'], mode: 'cloze', source: { ...draft.source, title: 'Other title' } };
    expect(preparedAudioDraftKey(changed)).toBe(preparedAudioDraftKey(draft));
    await render(rpc, { draft: changed }); expect(hook.getAudioId(changed)).toBe(audioId);
    await render(rpc, { draft: { ...changed, pronunciation: { ...changed.pronunciation, ipa: '[bæŋk]' } } });
    expect(hook.status).toBe('idle'); expect(hook.getAudioId(changed)).toBeUndefined(); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps source language distinct from source metadata and binds every reviewed audio field', () => {
    const baseline = preparedAudioDraftKey(draft);
    const variants = [
      { ...draft, sourceLanguage: 'fr' as const }, { ...draft, targetLanguage: 'de' as const },
      { ...draft, expression: 'Bank' }, { ...draft, lemma: 'banks' }, { ...draft, partOfSpeech: 'verb' },
      { ...draft, selectedSense: draft.senses[1]! }, { ...draft, senses: [...draft.senses].reverse() },
      { ...draft, context: { ...draft.context, sentence: 'The bank was green!' } },
      { ...draft, context: { ...draft.context, targetStart: 3 } },
      { ...draft, context: { ...draft.context, targetEnd: 9 } },
      { ...draft, pronunciation: { ...draft.pronunciation, ipa: '[bæŋk]' } },
    ];
    for (const changed of variants) expect(preparedAudioDraftKey(changed)).not.toBe(baseline);
  });

  it('revoked consent drops pending binding and never auto-restores or regenerates it', async () => {
    const response = deferred<{ audioId: string }>(); const rpc = vi.fn(() => response.promise) as UiRpc;
    await render(rpc); let pending!: Promise<void>; await act(async () => { pending = hook.prepare(); });
    await render(rpc, { audioAllowed: false });
    await act(async () => { response.resolve({ audioId }); await pending; });
    expect(hook.status).toBe('idle'); expect(hook.getAudioId(draft)).toBeUndefined();
    await render(rpc); expect(hook.status).toBe('idle'); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('errors require an explicit retry and never retain a pretend audioId', async () => {
    const rpc = vi.fn().mockRejectedValueOnce(new Error('Quota exhausted')).mockResolvedValueOnce({ audioId }) as UiRpc;
    await render(rpc); await act(async () => hook.prepare());
    expect(hook.status).toBe('error'); expect(hook.error).toBe('Quota exhausted'); expect(hook.getAudioId(draft)).toBeUndefined();
    await render(rpc); expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => hook.prepare()); expect(hook.status).toBe('ready'); expect(hook.getAudioId(draft)).toBe(audioId); expect(rpc).toHaveBeenCalledTimes(2);
  });
});
