import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioMetadata, NoteDraft } from '@english-reader/contracts';
import { canonicalJson } from '@english-reader/note-templates';
import { errorText, type UiRpc } from './interfaces';

export type PreparedAudioStatus = 'idle' | 'loading' | 'ready' | 'error';
type Binding = { key: string; status: PreparedAudioStatus; audioId?: string; error: string };
type Options = { rpc: UiRpc; draft: NoteDraft | null; lookupId?: string; audioAllowed: boolean };
const idle = (): Binding => ({ key: '', status: 'idle', error: '' });
/**
 * Export destination and source title/URL/location edits do not change speech.
 * Source/target LANGUAGES, all ordered senses, context and raw IPA remain bound.
 */
export function preparedAudioDraftKey(draft: NoteDraft): string {
  const { deckName: _deck, tags: _tags, mode: _mode, source: _source, ...audioDraft } = draft;
  return canonicalJson(audioDraft);
}
const fingerprint = (draft: NoteDraft, lookupId: string) => canonicalJson({ lookupId, draft: preparedAudioDraftKey(draft) });

/**
 * A paid prepare is only initiated by prepare(), never by mounting or an effect.
 * reset() synchronously unbinds a checkbox/draft edit, but deliberately does not
 * delete a potentially shared local file or duplicate an already running request.
 * The caller uses getAudioId(currentDraft) when freezing its immutable save intent.
 */
export function usePreparedAudio(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [, rerender] = useState(0);
  const mounted = useRef(true);
  const revision = useRef(0);
  const binding = useRef<Binding>(idle());
  const ready = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, Promise<string>>());
  const key = options.draft && options.lookupId ? fingerprint(options.draft, options.lookupId) : '';
  const renderedKey = useRef(key);
  const consent = useRef(options.audioAllowed);

  // Ref guards are immediate, including the render before an invalidation effect
  // could run. New object identities with identical data leave the binding intact.
  if (renderedKey.current !== key || consent.current !== options.audioAllowed) {
    renderedKey.current = key;
    consent.current = options.audioAllowed;
    if (binding.current.key !== key || !options.audioAllowed) {
      revision.current++;
      binding.current = idle();
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revision.current++; binding.current = idle(); };
  }, []);
  const notify = useCallback(() => { if (mounted.current) rerender(value => value + 1); }, []);
  const reset = useCallback(() => {
    revision.current++;
    binding.current = idle();
    notify();
  }, [notify]);

  const prepare = useCallback(async (currentDraft?: NoteDraft, currentLookupId?: string): Promise<void> => {
    const { rpc, audioAllowed } = latest.current;
    const draft = currentDraft ?? latest.current.draft;
    const lookupId = currentLookupId ?? latest.current.lookupId;
    const token = ++revision.current;
    if (!draft || !lookupId || !audioAllowed) {
      binding.current = { key: '', status: 'error', error: !audioAllowed
        ? 'Облачное аудио выключено. Сначала дайте согласие в настройках.'
        : 'Сначала дождитесь перевода.' };
      notify();
      return;
    }
    // Capture a full draft before any await: the eventual RPC and saved file must
    // refer to exactly the review state present at the explicit checkbox action.
    const captured = JSON.parse(JSON.stringify(draft)) as NoteDraft;
    const requestKey = fingerprint(captured, lookupId);
    const cached = ready.current.get(requestKey);
    if (cached) {
      binding.current = { key: requestKey, status: 'ready', audioId: cached, error: '' };
      notify();
      return;
    }
    binding.current = { key: requestKey, status: 'loading', error: '' };
    notify();
    let request = pending.current.get(requestKey);
    if (!request) {
      // Install the shared promise before invoking RPC, also covering synchronously
      // throwing adapters and same-tick repeated checkbox/retry actions.
      request = Promise.resolve().then(async () => {
        if (!mounted.current || !latest.current.audioAllowed || binding.current.status !== 'loading' || binding.current.key !== requestKey) {
          throw new Error('Подготовка аудио отменена.');
        }
        const result = await rpc<AudioMetadata>('audio.prepare', {
          lookupId, senseId: captured.selectedSense.id, draft: captured,
        });
        if (typeof result?.audioId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.audioId)) {
          throw new Error('Не удалось получить локальный аудиофайл. Повторите подготовку явно.');
        }
        ready.current.set(requestKey, result.audioId);
        if (ready.current.size > 32) ready.current.delete(ready.current.keys().next().value!);
        return result.audioId;
      });
      pending.current.set(requestKey, request);
    }
    try {
      const audioId = await request;
      if (mounted.current && revision.current === token) {
        binding.current = { key: requestKey, status: 'ready', audioId, error: '' };
        notify();
      }
    } catch (error) {
      if (mounted.current && revision.current === token) {
        binding.current = { key: requestKey, status: 'error', error: errorText(error) };
        notify();
      }
    } finally {
      if (pending.current.get(requestKey) === request) pending.current.delete(requestKey);
    }
  }, [notify]);
  const getAudioId = useCallback((draft: NoteDraft): string | undefined => {
    const { lookupId, audioAllowed } = latest.current;
    const current = binding.current;
    return audioAllowed && lookupId && current.status === 'ready' && current.key === fingerprint(draft, lookupId)
      ? current.audioId : undefined;
  }, []);
  const isPreparing = useCallback(() => binding.current.status === 'loading', []);

  return { ...binding.current, prepare, reset, getAudioId, isPreparing };
}
