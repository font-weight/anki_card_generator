// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installActivation } from '../../apps/extension/src/content/activation';
import { lookupPayloadFor } from '../../apps/extension/src/content/payloads';
import { lookupPreferences } from '../../apps/extension/src/runtime/reader-preferences';
import { OpenAIService } from '../../packages/services/src/openai';
import { lookupModelSchema } from '../../packages/services/src/prompts';
import type { ExtractedText } from '../../apps/extension/src/content/extraction';
import type { LookupPayload } from '../../packages/contracts/src/index';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  vi.restoreAllMocks(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren();
});
const cases = [
  ['He is bound on a longer voyage.', 'bound on', 'bound on', 'Going on a journey.', 'Он отправляется в более долгое путешествие.'],
  ['Two days went by.', 'went by', 'go by', 'To pass, especially of time.', 'Прошло два дня.'],
  ['She kept up with the group.', 'kept up', 'keep up', 'To continue at the same speed.', 'Она не отставала от группы.'],
  ['The sky clouded over.', 'clouded over', 'cloud over', 'To become covered with clouds.', 'Небо затянулось облаками.'],
  ['Hours go by.', 'go by', 'go by', 'To pass, especially of time.', 'Часы проходят.'],
  ['I cannot put up with it.', 'put up with', 'put up with', 'To tolerate something unpleasant.', 'Я не могу с этим мириться.'],
  ['Two days went by.', 'went', 'go', 'To move or pass.', 'Прошло два дня.'],
] as const;

// Exercise the registered Shift handler with a trusted-event-shaped test double:
// real DOM Selection/extraction/payload/schema/service, but no live browser input/API.
for (const framed of [false, true]) for (const [sentence, expression, lemma, definition, sentenceTranslation] of cases) {
  it(`manual selection then Shift: ${expression}, ${framed ? 'EPUB iframe' : 'document'}`, async () => {
    const frame = document.createElement('iframe');
    if (framed) document.body.append(frame);
    const doc = framed ? frame.contentDocument! : document;
    const paragraph = doc.createElement('p'), start = sentence.indexOf(expression);
    // Inline source wrapping crosses the selected phrase's DOM range.
    paragraph.append(doc.createTextNode(sentence.slice(0, start)));
    const first = doc.createTextNode(expression.split(' ')[0]!);
    const rest = doc.createElement('em'); rest.textContent = expression.slice(first.length);
    paragraph.append(first, rest, doc.createTextNode(sentence.slice(start + expression.length)));
    doc.body.append(paragraph);
    const range = doc.createRange(); range.setStart(first, 0);
    if (rest.firstChild) range.setEnd(rest.firstChild, rest.textContent!.length);
    else range.setEnd(first, first.length);
    doc.getSelection()!.addRange(range);
    const prototype = doc.defaultView!.Range.prototype;
    Object.defineProperty(prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x:0,y:0,width:20,height:20 }) });
    cleanups.push(() => { delete (prototype as any).getBoundingClientRect; });
    const add = vi.spyOn(doc.defaultView!, 'addEventListener');
    let payload: LookupPayload | undefined;
    const activate = vi.fn((value: ExtractedText) => {
      expect(value.origin).toBe('selection');
      payload = lookupPayloadFor(value, lookupPreferences({ sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B2' }));
    });
    cleanups.push(installActivation({ document: doc, getLocale: () => 'en-US', onActivate: activate }));
    const handler = add.mock.calls.filter(([type]) => type === 'keydown').at(-1)![1] as (event: KeyboardEvent) => void;
    const event = { key:'Shift', isTrusted:true, repeat:false, isComposing:false, ctrlKey:false, altKey:false, metaKey:false, composedPath:()=>[paragraph] };
    handler({ ...event, isTrusted: false } as unknown as KeyboardEvent);
    expect(activate).not.toHaveBeenCalled();
    handler(event as unknown as KeyboardEvent);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(payload!.expression).toBe(expression);
    expect(payload!.context).toEqual({ sentence, targetStart:start, targetEnd:start + expression.length });
    expect(payload).not.toHaveProperty('phrasalCandidates');
    expect(lookupModelSchema(payload!).properties).not.toHaveProperty('selectedCandidateId');
    let calls = 0, sent: any;
    const service = new OpenAIService({ getApiKey: () => 'synthetic-only', fetch: async (_url, init) => {
      calls++; sent = JSON.parse(String(init?.body));
      return Response.json({ status:'completed', output:[{type:'message',role:'assistant',content:[{type:'output_text',
        text:JSON.stringify({lemma,partOfSpeech:'verb',senses:[{id:'context',translations:['продолжать'],definition}],
          contextAmbiguous:false,recommendedSenseId:'context',ipaCandidate:null,sentenceTranslation,extraExample:null})}]}] });
    } });
    const result = await service.lookup(payload!);
    expect(JSON.parse(sent.input[0].content[0].text)).toEqual(payload);
    expect(result.data.expression).toBe(expression);
    expect(result.data.lemma).toBe(lemma);
    expect(result.data.sentenceTranslation).toBe(sentenceTranslation);
    expect(calls).toBe(1);
  });
}
