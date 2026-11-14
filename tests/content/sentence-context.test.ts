// @vitest-environment jsdom
import {afterEach, describe, expect, it} from 'vitest';
import {extractAtPoint, extractFromRange, extractSelection, type ExtractedText} from '../../apps/extension/src/content/extraction';
import {lookupPayloadFor, grammarPayloadFor} from '../../apps/extension/src/content/payloads';
import {grammarPreferences, lookupPreferences} from '../../apps/extension/src/runtime/reader-preferences';
import {validateRequest} from '../../packages/contracts/src/index';
import {sourceGraphemeBoundaries} from '../../packages/contracts/src/words';

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  delete (document as any).caretRangeFromPoint;
});
const preferences = lookupPreferences({});
function select(element: Element, expression: string, occurrence = 0): Range {
  const doc = element.ownerDocument, text = element.textContent!;
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(expression, start + 1);
  if (start < 0) throw Error('Missing fixture expression');
  const end = start + expression.length, walk = doc.createTreeWalker(element, 4), range = doc.createRange();
  let at = 0, node: Node | null;
  while ((node = walk.nextNode())) {
    const length = node.nodeValue!.length;
    if (start >= at && start < at + length) range.setStart(node, start - at);
    if (end > at && end <= at + length) range.setEnd(node, end - at);
    at += length;
  }
  return range;
}
function lookup(range: Range, origin: 'selection' | 'hover', locale = 'en-US'): ExtractedText {
  const doc = range.startContainer.ownerDocument!;
  if (origin === 'selection') { doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range); }
  else (doc as any).caretRangeFromPoint = () => { const caret = range.cloneRange(); caret.collapse(true); return caret; };
  const value = origin === 'selection' ? extractSelection(doc, locale) : extractAtPoint(doc, 10, 10, locale);
  expect(value?.ok).toBe(true);
  if (!value?.ok) throw Error('Extraction failed');
  expect(value.origin).toBe(origin);
  expect(value.context.sentence.slice(value.context.targetStart, value.context.targetEnd)).toBe(value.expression);
  expect(value.range.startContainer.ownerDocument).toBe(doc);
  expect(value.range.toString()).toBe(value.expression);
  const payload = lookupPayloadFor(value, preferences);
  expect(payload.context.sentence.length + (payload.context.before?.length ?? 0) + (payload.context.after?.length ?? 0)).toBeLessThanOrEqual(1500);
  expect(() => validateRequest({v: 1, requestId: '3fbc6d2e-806b-4cae-8878-6b11c46b6901', type: 'lookup', payload})).not.toThrow();
  return value;
}

describe('complete original sentence context', () => {
  it.each(['selection', 'hover'] as const)('keeps the screenshot sentence after a source newline for %s', origin => {
    const sentence = 'There was some laughing and clapping: the audience seemed to think that Ted had\nscored a point.';
    document.body.innerHTML = `<p>‘Then Hal stopped.’ ${sentence} Next sentence.</p><aside>Unrelated private page text.</aside>`;
    const source = document.querySelector('p')!, before = source.innerHTML;
    const value = lookup(select(source, 'seemed'), origin);
    expect(value.expression).toBe('seemed');
    expect(value.context.sentence).toBe(sentence + ' ');
    expect(source.innerHTML).toBe(before);
    expect(value.context.sentence).not.toContain('Unrelated');
  });

  it.each(['\n', '\r\n', '\u2028'])('preserves a literal %j without using it as an inline sentence terminator', lineBreak => {
    const p = document.createElement('p');
    p.textContent = `First. 😀 The café seemed${lineBreak}to be open. Last.`;
    document.body.append(p);
    const value = lookup(select(p, 'seemed'), 'selection');
    expect(value.context.sentence).toBe(`😀 The café seemed${lineBreak}to be open. `);
    expect(value.context.targetStart).toBe('😀 The café '.length);
  });

  it.each(['selection', 'hover'] as const)('retains a hyphenated target and the whole book sentence across inline nodes for %s', origin => {
    document.body.innerHTML = '<p>‘Ah,’ said Ted, ‘you do, if you listen. But I can hear fire<em>side</em>-tales and children’s stories at\nhome, if I want to.’</p>';
    const value = lookup(select(document.querySelector('p')!, 'fireside-tales'), origin);
    expect(value.expression).toBe('fireside-tales');
    expect(value.context.sentence).toBe('But I can hear fireside-tales and children’s stories at\nhome, if I want to.’');
  });

  it('keeps an authoritative apostrophe phrase without changing its spelling or expanding it', () => {
    document.body.innerHTML = '<p>But I can hear fireside-tales and <em>children’s</em> stories at\nhome, if I want to.</p>';
    const value = lookup(select(document.querySelector('p')!, 'children’s stories'), 'selection');
    expect(value.expression).toBe('children’s stories');
    expect(value.context.sentence).toBe(document.querySelector('p')!.textContent);
    expect(lookupPayloadFor(value, preferences)).not.toHaveProperty('phrasalCandidates');
  });

  it.each(['selection', 'hover'] as const)('keeps uppercase ZIP in its original Russian context for %s', origin => {
    document.body.innerHTML = '<p lang="ru">Первый <strong>ZIP</strong> — расширение, второй — исходники с\nкоммитами, третий — инструкция и отчёт. Следующее предложение.</p>';
    const value = lookup(select(document.querySelector('p')!, 'ZIP'), origin, 'ru-RU');
    expect(value.expression).toBe('ZIP');
    expect(value.context.sentence).toBe('Первый ZIP — расширение, второй — исходники с\nкоммитами, третий — инструкция и отчёт. ');
  });

  it('treats BR as a soft line break but retains its exact context offset', () => {
    document.body.innerHTML = '<p>First. The audience <em>seemed</em> to think that Ted had<br>scored a point. Last.</p>';
    const value = lookup(select(document.querySelector('p')!, 'seemed'), 'hover');
    expect(value.context.sentence).toBe('The audience seemed to think that Ted had\nscored a point. ');
  });

  it('does not merge separate blocks when there is no punctuation', () => {
    document.body.innerHTML = '<section><p>Chosen word</p><p>Unrelated private page text</p></section>';
    const section = document.querySelector('section')!, range = document.createRange();
    range.setStart(section, 0); range.setEnd(section, 1);
    const value = extractFromRange(range, 'en-US');
    expect(value.ok).toBe(true);
    if (value.ok) expect(value.context.sentence).toBe('Chosen word\n');
  });

  it('keeps an explicit Unicode paragraph separator as a hard boundary', () => {
    const p = document.createElement('p'); p.textContent = 'Chosen word\u2029Unrelated paragraph'; document.body.append(p);
    const value = lookup(select(p, 'word'), 'selection');
    expect(value.context.sentence).toBe('Chosen word\u2029');
  });

  it('retains an English title abbreviation without joining the next complete sentence', () => {
    document.body.innerHTML = '<p>My cousin Hal for one. He works for Mr. Boffin at\nNorthfarthing for the hunting. He saw one.</p>';
    const value = lookup(select(document.querySelector('p')!, 'Boffin'), 'selection');
    expect(value.context.sentence).toBe('He works for Mr. Boffin at\nNorthfarthing for the hunting. ');
  });

  it('keeps terminal punctuation and quotation marks as real sentence boundaries', () => {
    document.body.innerHTML = '<p>‘Who is there?’\nThe audience seemed amused!\n‘Why?’</p>';
    const value = lookup(select(document.querySelector('p')!, 'seemed'), 'selection');
    expect(value.context.sentence).toBe('The audience seemed amused!\n');
  });

  it('keeps grammar on one exact complete sentence across source newlines', () => {
    document.body.innerHTML = '<p>Before. There was some laughing and clapping: the audience seemed to think that Ted had\nscored a point. After.</p>';
    const p = document.querySelector('p')!, value = extractFromRange(select(p, 'seemed'), 'en-US', 'sentence');
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    expect(grammarPayloadFor(value, preferences, grammarPreferences({})).sentence).toBe('There was some laughing and clapping: the audience seemed to think that Ted had\nscored a point. ');
    const both = extractFromRange(select(p, 'point. After'), 'en-US', 'sentence');
    expect(both).toMatchObject({ok: false, code: 'unsupported'});
  });

  it.each(['selection', 'hover'] as const)('retains the selected repeated occurrence in the source iframe for %s', origin => {
    document.body.innerHTML = '<p>The audience seemed unrelated.</p><iframe></iframe>';
    const doc = document.querySelector('iframe')!.contentDocument!;
    doc.body.innerHTML = '<p>It seemed strange: the audience <em>seemed</em> to think that Ted had\nscored a point.</p>';
    const range = select(doc.querySelector('p')!, 'seemed', 1), value = lookup(range, origin);
    expect(value.context.targetStart).toBe('It seemed strange: the audience '.length);
    expect(value.range.startContainer).toBe(doc.querySelector('em')!.firstChild);
    expect(value.context.sentence).toBe(doc.querySelector('p')!.textContent);
    expect(value.context.sentence).not.toContain('unrelated');
  });

  it.each(['start', 'middle', 'end'] as const)('clips only a genuinely oversized sentence with the target at its %s', position => {
    const clusters = '👩🏽‍🚀 café\n'.repeat(180);
    const text = position === 'start' ? 'seemed ' + clusters : position === 'end' ? clusters + 'seemed' : clusters + 'seemed ' + clusters;
    const p = document.createElement('p'); p.textContent = text; document.body.append(p);
    const range = select(p, 'seemed'), value = lookup(range, 'selection');
    const start = text.indexOf('seemed') - value.context.targetStart;
    const boundaries = sourceGraphemeBoundaries(text, 'en-US')!;
    expect(value.context.sentence).toBe(text.slice(start, start + value.context.sentence.length));
    expect(boundaries.has(start)).toBe(true);
    expect(boundaries.has(start + value.context.sentence.length)).toBe(true);
    expect(extractFromRange(range, 'en-US', 'sentence')).toMatchObject({ok: false, code: 'too_long'});
  });

  it('still rejects selections over five lexical segments', () => {
    document.body.innerHTML = '<p>one two\nthree four five six.</p>';
    expect(extractFromRange(select(document.querySelector('p')!, 'one two\nthree four five six'))).toMatchObject({ok: false, code: 'too_many_words'});
  });
});
