import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLocale, enumeratePhrasalCandidates, validateNoteDraft } from '@english-reader/contracts';
import type { LanguageCode, LookupData, LookupPayload, NoteDraftV3 } from '@english-reader/contracts';
import { buildNoteFields, renderPreview } from '@english-reader/note-templates';
import { LookupCoordinator, lookupCacheKey } from '../../packages/services/src/lookup';
import { LOOKUP_MODEL, OpenAIService, resolvedLookupInput } from '../../packages/services/src/openai';
import type { LookupExecution } from '../../packages/services/src/openai';
import { ReadingPopup } from '../../apps/extension/src/ui/ReadingPopup';
import { preparedAudioDraftKey } from '../../apps/extension/src/ui/use-prepared-audio';
import type { PopupOptions, UiRpc } from '../../apps/extension/src/ui/interfaces';
import * as userActions from '../../apps/extension/src/ui/user-actions';

const source = { kind: 'html' as const, title: 'Offline verb fixture', url: 'https://reader.example', documentId: null, page: null, chapter: null, cfi: null };
const unavailable = { ipa: null, dialect: 'unknown', source: 'unavailable', sourceUrl: null } as const;
const audioId = '77777777-7777-4777-8777-777777777777';
function fixture(expression = 'went', lemma = 'go', partOfSpeech = 'verb', sentence = `🌤️ ${expression}, then she ${expression}.`, sourceLanguage: LanguageCode = 'en') {
  const targetStart = sentence.lastIndexOf(expression);
  const payload: LookupPayload = { expression, context: { sentence, targetStart, targetEnd: targetStart + expression.length }, sourceLanguage, targetLanguage: 'ru', learnerLevel: 'B1', dialect: defaultLocale(sourceLanguage) };
  const result: LookupData = { lookupId: '55555555-5555-4555-8555-555555555555', expression, lemma, partOfSpeech, recommendedSenseId: 'move', contextAmbiguous: false, senses: [{ id: 'move', translations: ['идти'], definition: 'To move from one place to another.' }], ipaCandidate: null, extraExample: null };
  return { payload, result };
}
function fakeRpc(result: LookupData, overrides: Record<string, unknown> = {}): UiRpc {
  return vi.fn(async (type: string, payload?: Record<string, unknown>) => {
    if (type in overrides) { const value = overrides[type]; return typeof value === 'function' ? value(payload) : value; }
    if (type === 'settings.getReader') return { defaultDeck: 'Test', cloudAudioEnabled: true };
    if (type === 'lookup') return structuredClone(result);
    if (type === 'pronunciation.get') return { pronunciation: unavailable };
    if (type === 'anki.addNote') return { operationId: '88888888-8888-4888-8888-888888888888', status: 'queued', noteId: null };
    if (type === 'audio.prepare') return { audioId };
    return {};
  }) as UiRpc;
}
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  // Mocked component behavior only, not browser isTrusted/real layout evidence.
  vi.spyOn(userActions, 'isTrustedUiEvent').mockReturnValue(true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
const button = (label: string) => [...node.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const calls = (rpc: UiRpc, type: string) => vi.mocked(rpc).mock.calls.filter(call => call[0] === type);
const base = () => node.querySelector('.verb-base-form');
const displayOptions = (rpc: UiRpc, payload: LookupPayload): PopupOptions => ({ rpc, lookupPayload: payload, source, anchor: new DOMRect(0, 0, 10, 10), renderPreview });
async function render(rpc: UiRpc, payload: LookupPayload, extra: Partial<PopupOptions> = {}) {
  await act(async () => root.render(<ReadingPopup options={{ ...displayOptions(rpc, payload), ...extra }} close={() => {}} />));
}
async function changeLemma(value: string) {
  const field = [...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Лемма')!.querySelector<HTMLInputElement>('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('verb base form in the reading popup', () => {
  it.each([['went', 'go'], ['was', 'be'], ['saw', 'see'], ['go', 'go']])('shows %s → %s without changing the selected surface or creating another request', async (surface, lemma) => {
    const { payload, result } = fixture(surface, lemma), rpc = fakeRpc(result);
    await render(rpc, payload);
    expect(base()?.textContent).toBe(`Инфинитив: ${lemma}`);
    expect(base()?.querySelector('bdi')?.getAttribute('lang')).toBe('en');
    expect(base()?.querySelector('bdi')?.getAttribute('dir')).toBe('auto');
    expect(node.querySelector('header strong')?.textContent).toBe(surface);
    expect(node.querySelector('mark')?.textContent).toBe(surface);
    expect(node.querySelector('mark')?.previousSibling?.textContent).toBe(payload.context.sentence.slice(0, payload.context.targetStart));
    expect(node.querySelector('.sentence')?.textContent).toBe(payload.context.sentence);
    expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getReader', 'lookup', 'pronunciation.get']);
    await act(async () => button('Добавить в Anki').click());
    const draft = calls(rpc, 'anki.addNote')[0]![1]!.draft as NoteDraftV3;
    expect(draft).toMatchObject({ expression: surface, lemma, partOfSpeech: 'verb', context: payload.context, pronunciation: unavailable });
    validateNoteDraft(draft);
    const fields = buildNoteFields('88888888-8888-4888-8888-888888888888', draft, { lexemeKey: 'lexeme', contentKey: 'content' });
    expect(new DOMParser().parseFromString(fields.Expression, 'text/html').body.textContent).toBe(surface);
    expect(fields.Expression).toContain('class="target-word"'); expect(fields.Lemma).toBe(lemma);
  });

  it.each(['noun', 'adverb', 'noun/verb', 'unknown'])('never labels %s as an infinitive', async partOfSpeech => {
    const { payload, result } = fixture('saw', 'saw', partOfSpeech), rpc = fakeRpc(result);
    await render(rpc, payload);
    expect(base()).toBeNull();
    expect(node.querySelector('header strong')?.textContent).toBe('saw');
    expect(calls(rpc, 'lookup')).toHaveLength(1);
  });

  it('uses a dictionary-form label and isolated source-language text for Arabic', async () => {
    const { payload, result } = fixture('ذهبت', 'ذَهَبَ', 'فعل', 'أنا ذهبت.', 'ar'), rpc = fakeRpc(result);
    await render(rpc, payload);
    expect(base()?.textContent).toBe('Начальная форма: ذَهَبَ');
    expect(base()?.querySelector('bdi')?.getAttribute('lang')).toBe('ar');
    expect(base()?.querySelector('bdi')?.getAttribute('dir')).toBe('auto');
    expect(node.querySelector('header strong')?.textContent).toBe('ذهبت');
  });

  it('does not replace surface pronunciation or system-audio lookup with the displayed base form', async () => {
    const { payload, result } = fixture(), pronunciation = { ipa: '/went/', dialect: 'en-US', source: 'generated', sourceUrl: null };
    const rpc = fakeRpc(result, { 'pronunciation.get': { pronunciation } });
    await render(rpc, payload);
    expect(base()?.textContent).toBe('Инфинитив: go'); expect(node.querySelector('.pronunciation-ipa')?.textContent).toBe('≈ [went]');
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать выражение системным голосом"]')!.click());
    expect(calls(rpc, 'audio.play')[0]![1]).toEqual({ lookupId: result.lookupId });
    expect(calls(rpc, 'audio.prepare')).toHaveLength(0);
    await act(async () => button('Добавить в Anki').click());
    expect((calls(rpc, 'anki.addNote')[0]![1]!.draft as NoteDraftV3).pronunciation).toEqual(pronunciation);
  });

  it('also displays the lemma for an exact manually selected phrasal verb', async () => {
    const { payload, result } = fixture('went by', 'go by', 'phrasal verb', 'Two days went by.'), rpc = fakeRpc(result);
    await render(rpc, payload);
    expect(base()?.textContent).toBe('Инфинитив: go by'); expect(node.querySelector('mark')?.textContent).toBe('went by');
    expect(calls(rpc, 'lookup')[0]![1]).toEqual(payload);
    await act(async () => button('Добавить в Anki').click());
    expect((calls(rpc, 'anki.addNote')[0]![1]!.draft as NoteDraftV3).context).toEqual(payload.context);
  });

  it('omits a visibly ambiguous lemma and waits for explicit sense selection when context is ambiguous', async () => {
    const { payload, result } = fixture(), rpc = fakeRpc({ ...result, lemma: 'go / travel' });
    await render(rpc, payload); expect(base()).toBeNull();
    const ambiguous = fakeRpc({ ...result, contextAmbiguous: true, recommendedSenseId: null });
    await render(ambiguous, payload); expect(base()).toBeNull();
    await act(async () => node.querySelector<HTMLInputElement>('input[type=radio]')!.click());
    expect(base()?.textContent).toBe('Инфинитив: go');
    expect(calls(ambiguous, 'lookup')).toHaveLength(1);
    expect(calls(ambiguous, 'lookup.refine')).toHaveLength(0);
  });

  it('follows deliberate lemma edits, hides an empty value, and does not silently restore the provider lemma', async () => {
    const { payload, result } = fixture(), rpc = fakeRpc(result);
    await render(rpc, payload);
    await act(async () => button('Редактировать').click());
    await changeLemma(''); expect(base()).toBeNull();
    await changeLemma('travel'); expect(base()?.textContent).toBe('Инфинитив: travel');
    await act(async () => button('Готово').click());
    await act(async () => button('Добавить в Anki').click());
    const draft = calls(rpc, 'anki.addNote')[0]![1]!.draft as NoteDraftV3;
    expect(draft.lemma).toBe('travel'); expect(draft.expression).toBe('went'); expect(draft.context).toEqual(payload.context);
    expect(calls(rpc, 'lookup')).toHaveLength(1); expect(calls(rpc, 'audio.prepare')).toHaveLength(0);
  });

  it('updates from the refined lemma and POS, then removes the row if a later refinement is nonverbal', async () => {
    const { payload, result } = fixture('saw', 'saw', 'noun');
    const refine = vi.fn().mockResolvedValueOnce({ ...result, lemma: 'see', partOfSpeech: 'verb' }).mockResolvedValueOnce(result);
    const rpc = fakeRpc(result, { 'lookup.refine': refine });
    await render(rpc, payload); expect(base()).toBeNull();
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(base()?.textContent).toBe('Инфинитив: see');
    expect(node.querySelector('header strong')?.textContent).toBe('saw');
    expect(node.querySelector('.sentence')?.textContent).toBe(payload.context.sentence);
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(base()).toBeNull(); expect(calls(rpc, 'lookup')).toHaveLength(1); expect(refine).toHaveBeenCalledTimes(2);
  });

  it('drops a previous verb row on replacement and ignores a late refinement for that old selection', async () => {
    const old = fixture(), next = fixture('bank', 'bank', 'noun', 'The bank is nearby.');
    let finish!: (result: LookupData) => void;
    const rpc = fakeRpc(old.result, { 'lookup.refine': () => new Promise<LookupData>(resolve => { finish = resolve; }) });
    await render(rpc, old.payload);
    await act(async () => button('Уточнить смысл — платный запрос').click());
    const nextRpc = fakeRpc(next.result); await render(nextRpc, next.payload);
    expect(base()).toBeNull();
    await act(async () => finish({ ...old.result, lemma: 'travel' }));
    expect(base()).toBeNull(); expect(node.querySelector('header strong')?.textContent).toBe('bank');
    expect(calls(rpc, 'lookup.cancel')).toHaveLength(1);
  });

  it('keeps the base form outside cloze preview and hides only the chosen repeated surface occurrence', async () => {
    const { payload, result } = fixture(), rpc = fakeRpc(result, { 'settings.getReader': { defaultDeck: 'Test', defaultMode: 'cloze' } });
    await render(rpc, payload);
    expect(base()?.textContent).toBe('Инфинитив: go');
    await act(async () => button('Предпросмотр').click());
    const front = node.querySelector<HTMLIFrameElement>('[title="Предпросмотр лицевой стороны"]')!.srcdoc;
    expect(front).toContain('🌤️ went, then she <span class="cloze">[…]</span>.');
    expect(front).not.toContain('go'); expect(front).not.toContain('Инфинитив');
    await act(async () => button('Добавить в Anki').click());
    const draft = calls(rpc, 'anki.addNote')[0]![1]!.draft as NoteDraftV3;
    const fields = buildNoteFields('88888888-8888-4888-8888-888888888888', draft, { lexemeKey: 'lexeme', contentKey: 'content' });
    expect(new DOMParser().parseFromString(fields.Expression, 'text/html').body.textContent).toBe('went'); expect(fields.Lemma).toBe('go');
    expect(fields.ClozeSentence).toMatch(/^🌤️ went, then she \{\{c1::.*>went<\/span>\}\}\.$/u);
    expect(draft.context).toEqual(payload.context);
  });

  it('displays cached went by → go by and preserves refine, examples, audio binding and Anki data without extra provider calls', async () => {
    const { payload: original } = fixture('went', 'go', 'verb', '🌤️ Days went by, then weeks went by.');
    const phrasalCandidates = enumeratePhrasalCandidates(original.context), candidate = phrasalCandidates.find(value => value.expression === 'went by')!;
    const payload = { ...original, phrasalCandidates };
    const modelResult = { sentenceTranslation: 'Дни проходили.', lemma: 'go by', partOfSpeech: 'phrasal verb', recommendedSenseId: 'pass', contextAmbiguous: false, senses: [{ id: 'pass', translations: ['проходить'], definition: 'To pass as time elapses.' }], ipaCandidate: null, extraExample: null };
    const providerCalls: Record<string, any>[] = [];
    const service = new OpenAIService({ getApiKey: () => 'synthetic-only', fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body)); providerCalls.push(body);
      const input = JSON.parse(body.input[0].content[0].text) as LookupPayload;
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...modelResult, ...(input.phrasalCandidates ? { selectedCandidateId: candidate.id } : {}) }) }] }] });
    } });
    const cache = new Map<string, LookupExecution>();
    const coordinator = new LookupCoordinator(service, { get: async key => cache.get(key), set: async (key, value) => { cache.set(key, value); } });
    const primed = await coordinator.lookup(payload, { requestId: 'prime' });
    const key = lookupCacheKey(payload, LOOKUP_MODEL), cachedBefore = structuredClone(cache.get(key));
    let latest = primed.data;
    const received: LookupExecution[] = [];
    const rpc = fakeRpc(latest, {
      lookup: async (request: LookupPayload) => { const value = await coordinator.lookup(request, { requestId: 'popup' }); received.push(value); latest = value.data; return latest; },
      'lookup.refine': async () => { const value = await coordinator.lookup(resolvedLookupInput(payload, primed.data), { requestId: 'refine', refine: true }); received.push(value); latest = value.data; return latest; },
      'card.enrich': { examples: [{ text: 'The days went by.', translation: 'Дни проходили.', source: 'ai' }] },
    });
    await render(rpc, payload);
    expect(received[0]!.cacheHit).toBe(true); expect(providerCalls).toHaveLength(1);
    expect(base()?.textContent).toBe('Инфинитив: go by');
    expect(node.querySelector('header strong')?.textContent).toBe('went by');
    expect(node.querySelector('mark')?.textContent).toBe('went by');
    expect(node.querySelector('mark')?.previousSibling?.textContent).toBe(original.context.sentence.slice(0, candidate.targetStart));
    expect(cache.get(key)).toEqual(cachedBefore);
    await act(async () => button('Уточнить смысл — платный запрос').click());
    expect(providerCalls).toHaveLength(2); expect(providerCalls[1]!.reasoning.effort).toBe('low');
    const refinedInput = JSON.parse(providerCalls[1]!.input[0].content[0].text) as LookupPayload;
    expect(refinedInput.expression).toBe('went by'); expect(refinedInput.phrasalCandidates).toBeUndefined();
    expect(refinedInput.context).toEqual({ sentence: original.context.sentence, targetStart: candidate.targetStart, targetEnd: candidate.targetEnd });
    expect(base()?.textContent).toBe('Инфинитив: go by'); expect(latest.resolvedTarget).toBeUndefined();
    await act(async () => button('Получить до 3 примеров — платный запрос').click());
    await act(async () => node.querySelector<HTMLInputElement>('fieldset input[type=checkbox]')!.click());
    const checkbox = [...node.querySelectorAll('label')].find(label => label.textContent?.includes('Создать аудиофайл (платный запрос)'))!.querySelector<HTMLInputElement>('input')!;
    await act(async () => checkbox.click());
    const prepared = calls(rpc, 'audio.prepare')[0]![1]!, draft = prepared.draft as NoteDraftV3;
    expect(draft).toMatchObject({ expression: 'went by', lemma: 'go by', partOfSpeech: 'phrasal verb', context: refinedInput.context });
    expect(draft.examples).toHaveLength(1); validateNoteDraft(draft);
    const audioKey = preparedAudioDraftKey(draft);
    await act(async () => button('Предпросмотр').click());
    expect(base()?.textContent).toBe('Инфинитив: go by'); expect(preparedAudioDraftKey(draft)).toBe(audioKey);
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="Прослушать готовый аудиофайл"]')!.click());
    expect(calls(rpc, 'audio.play')[0]![1]).toEqual({ audioId });
    await act(async () => button('Добавить в Anki').click());
    const added = calls(rpc, 'anki.addNote')[0]![1]!;
    expect(added.draft).toEqual(draft); expect(added.audioId).toBe(audioId);
    expect(calls(rpc, 'lookup')).toHaveLength(1); expect(calls(rpc, 'lookup.refine')).toHaveLength(1);
    expect(calls(rpc, 'card.enrich')[0]![1]).toEqual({ lookupId: latest.lookupId, senseId: 'pass' });
    expect(calls(rpc, 'audio.prepare')).toHaveLength(1); expect(providerCalls).toHaveLength(2);
    expect(cache.get(key)).toEqual(cachedBefore);
  });
});

describe('English usage estimates', () => {
  it('shows contextual usage only in the popup and never in the saved draft or fields', async () => {
    const {payload, result} = fixture();
    const rpc = fakeRpc({...result,englishUsage:{level:'B2',register:'dated',frequency:'rare'}});
    await render(rpc,payload);
    const usage=node.querySelector('.reading-english-usage');
    expect(usage?.textContent).toContain('B2');
    expect(usage?.textContent).toContain('Устаревающее, ещё встречается');
    expect(usage?.textContent).toContain('Редко');
    await act(async () => button('Добавить в Anki').click());
    const draft=calls(rpc,'anki.addNote')[0]![1]!.draft as NoteDraftV3;
    expect(draft).not.toHaveProperty('englishUsage');
    expect(JSON.stringify(buildNoteFields('88888888-8888-4888-8888-888888888888',draft,{lexemeKey:'lexeme',contentKey:'content'}))).not.toContain('Устаревающее');
    expect(calls(rpc,'lookup')).toHaveLength(1);
  });
  it('does not carry the contextual estimate over to a different sense', async () => {
    const {payload,result}=fixture();
    const rpc=fakeRpc({...result,englishUsage:{level:'B2',register:'current',frequency:'common'},senses:[...result.senses,{id:'different',translations:['умирать'],definition:'To die.'}]});
    await render(rpc,payload);
    expect(node.querySelector('.reading-english-usage')?.textContent).toContain('B2');
    await act(async()=>node.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!.click());
    expect(node.querySelector('.reading-english-usage')?.textContent).not.toContain('B2');
  });
});
