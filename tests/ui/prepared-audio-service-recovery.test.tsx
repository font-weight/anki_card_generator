// @vitest-environment node
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openReaderStorage } from '../../packages/storage/src/index';
import { createReaderServices, SecretVault } from '../../packages/services/src/index';
import { TTS_ENDPOINT } from '../../packages/services/src/audio';
import type { SecretStorageArea } from '../../packages/services/src/secrets';
import type { RuntimeSender } from '../../packages/services/src/index';
import type { LookupData, LookupPayload, NoteDraftV3 } from '@english-reader/contracts';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';
import { usePreparedAudio } from '../../apps/extension/src/ui/use-prepared-audio';

// Real service routing and IndexedDB with an injected offline-only transport.
// Node retains Blob/Response/crypto; JSDOM supplies only the React host document.
const extensionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const reader: RuntimeSender = { id: extensionId, url: 'https://example.test/read', documentId: 'registered', frameId: 0, tab: { id: 1 } };
const page: RuntimeSender = { id: extensionId, url: `chrome-extension://${extensionId}/settings.html`, frameId: 0 };
const input: LookupPayload = { expression: 'bank', context: { sentence: 'The bank was green.', targetStart: 4, targetEnd: 8 }, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', dialect: 'en-US' };
const primary = { id: 'river', definition: 'The land beside a river.', translations: ['берег'] };
const meanings = [primary, { id: 'money', definition: 'A financial institution.', translations: ['банк'] }];
const draft: NoteDraftV3 = { draftVersion: 3, sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', expression: 'bank', lemma: 'bank', partOfSpeech: 'noun',
  selectedSense: primary, senses: meanings, context: { ...input.context }, pronunciation: { ipa: '/bæŋk/', dialect: 'en-US', source: 'generated', sourceUrl: null },
  examples: [], mode: 'recognition', deckName: 'Test', tags: [], source: { kind: 'html', title: 'Test', url: reader.url!, documentId: null, page: null, chapter: null, cfi: null } };
const bytes = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1]);
function area(): SecretStorageArea {
  const values: Record<string, unknown> = {};
  return { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])),
    set: async next => { Object.assign(values, next); }, remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }, setAccessLevel: async () => {} };
}
async function service() {
  const indexedDB = new IDBFactory(), name = `prepared-recovery-${crypto.randomUUID()}`;
  let storage = await openReaderStorage({ indexedDB, name });
  const secrets = new SecretVault({ session: area(), local: area() });
  await secrets.setOpenAIKey('synthetic-offline-test-only');
  let tts = 0, lookupRequests = 0, played = 0;
  const fetcher: typeof fetch = async (url) => {
    if (url === TTS_ENDPOINT) { tts++; return new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }); }
    if (String(url) === 'https://api.openai.com/v1/responses') {
      lookupRequests++;
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ lemma: 'bank', partOfSpeech: 'noun', recommendedSenseId: 'river', contextAmbiguous: false, senses: meanings, ipaCandidate: { ipa: '/bæŋk/', dialect: 'en-US' }, extraExample: null }) }] }] });
    }
    throw Error('Unexpected request: no live network or Anki allowed in this test');
  };
  const create = () => createReaderServices({ storage, secrets, fetch: fetcher,
    runtime: { extensionId, allowedPageUrls: [page.url!], isRegisteredReader: sender => sender.documentId === 'registered' },
    confirmations: { requireConsent: async () => true },
    playback: { listVoices: async () => [], speakLocal: async () => {}, playMp3: async () => { played++; } } });
  let app = create();
  const send = async (type: string, payload: Record<string, unknown> = {}, sender = reader) => {
    const result = await app.handleMessage({ v: 1, requestId: crypto.randomUUID(), type, payload }, sender);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.data;
  };
  const rpc = vi.fn((type: string, payload?: Record<string, unknown>) => send(type, payload)) as UiRpc;
  await send('settings.update', { patch: { cloudAudioEnabled: true } }, page);
  const lookup = await rpc<LookupData>('lookup', { ...input });
  return { rpc, lookup,
    counts: () => ({ tts, lookupRequests, played }),
    restart: async () => { app.close(); storage = await openReaderStorage({ indexedDB, name }); app = create(); },
    evict: async (audioId: string) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('audioCache', 'readwrite'); tx.objectStore('audioCache').delete(audioId); tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error); }); }
      finally { db.close(); }
    },
    close: () => app.close() };
}

let dom: JSDOM, node: HTMLDivElement, root: ReturnType<typeof createRoot>, hook: ReturnType<typeof usePreparedAudio>;
function Harness(props: { rpc: UiRpc; lookupId: string }) { hook = usePreparedAudio({ ...props, draft, audioAllowed: true }); return <p>{hook.status}</p>; }
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>'); vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); dom.window.close(); vi.unstubAllGlobals(); });

it.each(['restart', 'eviction'] as const)('real mocked service %s invalidates the hook until explicit close/reselect and preparation', async failure => {
  const h = await service();
  try {
    await act(async () => root.render(<Harness rpc={h.rpc} lookupId={h.lookup.lookupId} />));
    await act(async () => hook.prepare());
    const firstId = hook.getAudioId(draft)!; expect(firstId).toBeTruthy();
    await h.rpc('audio.play', { audioId: firstId }); expect(h.counts()).toEqual({ tts: 1, lookupRequests: 1, played: 1 });
    if (failure === 'restart') await h.restart(); else await h.evict(firstId);
    const failed = hook.capturePlaybackFailure(firstId);
    await act(async () => {
      try { await h.rpc('audio.play', { audioId: firstId }); throw Error('Expected cached playback failure'); }
      catch (error) { expect((error as { code?: string }).code).toBe(failure === 'restart' ? 'PERMISSION_DENIED' : 'AUDIO_UNAVAILABLE'); expect(failed(error)).toBe(true); }
    });
    expect(hook.status).toBe('error'); expect(hook.recoveryRequired).toBe(true); expect(hook.getAudioId(draft)).toBeUndefined();
    const calls = vi.mocked(h.rpc).mock.calls.length;
    await act(async () => { hook.reset(); await hook.prepare(); });
    expect(vi.mocked(h.rpc).mock.calls).toHaveLength(calls); expect(h.counts().tts).toBe(1);
    // Actual fresh lookup after explicit close/reselect restores scope; mounting
    // alone never performs a paid request. Only the subsequent explicit prepare
    // may regenerate a genuinely evicted file.
    await act(async () => root.unmount()); root = createRoot(node);
    const fresh = await h.rpc<LookupData>('lookup', { ...input });
    await act(async () => root.render(<Harness rpc={h.rpc} lookupId={fresh.lookupId} />));
    expect(hook.status).toBe('idle'); expect(hook.recoveryRequired).toBe(false); expect(h.counts().tts).toBe(1);
    await act(async () => hook.prepare());
    const recoveredId = hook.getAudioId(draft)!;
    if (failure === 'restart') { expect(recoveredId).toBe(firstId); expect(h.counts().tts).toBe(1); }
    else { expect(recoveredId).not.toBe(firstId); expect(h.counts().tts).toBe(2); }
    await h.rpc('audio.play', { audioId: recoveredId }); expect(h.counts().played).toBe(2); expect(h.counts().lookupRequests).toBe(1);
  } finally { h.close(); }
});
