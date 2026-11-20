import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LanguageChatMarkdown } from '../../apps/extension/src/ui/LanguageChatMarkdown';
import { GrammarChat } from '../../apps/extension/src/ui/GrammarChat';
import { type UiRpc } from '../../apps/extension/src/ui/interfaces';
import * as userActions from '../../apps/extension/src/ui/user-actions';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.getSelection()?.removeAllRanges();
  host.remove();
});

async function render(text: string) {
  await act(async () => root.render(<LanguageChatMarkdown text={text} language="ru" />));
  return host.querySelector<HTMLElement>('.language-chat-markdown')!;
}

const lesson = [
  '# Present Perfect',
  '',
  '**Present Perfect** связывает прошлое с настоящим.',
  '',
  '## 1. Образование',
  '**have/has + причастие прошедшего времени**',
  '',
  '- **I/you/we/they have worked.** Я работал.',
  '- **She has worked.** Она работала.',
  '',
  '3. Начните с подлежащего.',
  '4. Добавьте *have* или _has_.',
].join('\n');

it('formats the lesson headings, forms, emphasis and numbered or bulleted examples', async () => {
  const body = await render(lesson);
  expect(body.lang).toBe('ru'); expect(body.dir).toBe('auto');
  expect(body.querySelector('h3')?.textContent).toBe('Present Perfect');
  expect(body.querySelector('h4')?.textContent).toBe('1. Образование');
  expect(body.querySelector('p strong')?.textContent).toBe('Present Perfect');
  expect([...body.querySelectorAll('p strong')][1].textContent).toBe('have/has + причастие прошедшего времени');
  expect(body.querySelector('ul > li > strong')?.textContent).toBe('I/you/we/they have worked.');
  expect(body.querySelectorAll('ul li')).toHaveLength(2);
  expect(body.querySelector('ol')?.start).toBe(3);
  expect([...body.querySelectorAll('ol em')].map(tag => tag.textContent)).toEqual(['have', 'has']);
  expect(body.textContent).not.toContain('**');
});

it('keeps examples, IPA, literal marks, unclosed emphasis and comparison signs legible', async () => {
  const literal = 'C#, #hashtag, *goed, 2 * 3, /ðə/, [ˈwɜːkt], 日本語, x < y, word_form и **';
  const body = await render(literal + '\n\n#\n\n*\n\n\\*текст\\*');
  expect([...body.querySelectorAll('p')].map(node => node.textContent)).toEqual([literal, '#', '*', '*текст*']);
  expect(body.querySelectorAll('em,strong')).toHaveLength(0);
  const prose = 'Начало **незакрытая фраза';
  expect((await render(prose)).textContent).toBe(prose);
});

it('preserves linguistic error marks in slash-separated forms alongside ordinary emphasis and IPA', async () => {
  const body = await render('*italic* — *goed/*buyed, /ðə/, [ˈwɜːkt]. Затем *again*.\n\n*goed');
  expect([...body.querySelectorAll('p')].map(row => row.textContent)).toEqual([
    'italic — *goed/*buyed, /ðə/, [ˈwɜːkt]. Затем again.', '*goed',
  ]);
  expect([...body.querySelectorAll('em')].map(node => node.textContent)).toEqual(['italic', 'again']);
});

it('renders quoted paragraphs, literal code, table headers and cells without activating provider-supplied HTML or resources', async () => {
  const html = '<em>Пример</em> <img src="https://example.invalid/example.png">';
  const resource = '![**рисунок**](https://example.invalid/_icons_/image.png) [слово](https://example.invalid/word) https://example.invalid/_form_';
  const body = await render([
    '> Сравните **обе** формы.',
    '>',
    '> Обе корректны.',
    '',
    '| Слово | IPA |',
    '| --- | :--- |',
    '| worked | [ˈwɜːkt] |',
    '| the | /ðə/ |',
    '',
    'Inline: `**have**` и `x < y`.',
    '',
    '```text',
    '# Topic',
    '**have** <b>пример</b> \\*',
    '```',
    '',
    html, resource,
  ].join('\n'));
  expect(body.querySelectorAll('blockquote p')).toHaveLength(2);
  expect(body.querySelector('blockquote strong')?.textContent).toBe('обе');
  expect([...body.querySelectorAll('th[scope=col]')].map(tag => tag.textContent)).toEqual(['Слово', 'IPA']);
  expect(body.querySelector('td:nth-child(2)')?.textContent).toBe('[ˈwɜːkt]');
  expect(body.querySelectorAll('p code')).toHaveLength(2);
  expect(body.querySelector('pre code')?.textContent).toBe('# Topic\n**have** <b>пример</b> \\*');
  expect(body.textContent).toContain(html);
  expect(body.textContent).toContain(resource);
  expect(body.querySelector('a,img,iframe,object,script,em,b')).toBeNull();
});

it('retains the final paragraphs of a long answer and lets the browser select text across formatted elements', async () => {
  const passage = 'Причастие **worked** произносится [ˈwɜːkt]. ';
  const body = await render('# Тренировка\n\n' + Array.from({length:240}, () => passage.repeat(4)).join('\n\n') + '\n\nКонец: /ðə/.');
  expect(body.querySelectorAll('p')).toHaveLength(241);
  expect(body.querySelectorAll('strong')).toHaveLength(960);
  expect(body.lastElementChild?.textContent).toBe('Конец: /ðə/.');
  const range = document.createRange();
  range.selectNodeContents(body.querySelector('p')!);
  const selection = window.getSelection()!;
  selection.addRange(range);
  expect(selection.toString()).toBe(passage.replaceAll('**', '').repeat(4));
});

it('renders only assistant answers and uses the same presentation for messages restored after returning to the analysis', async () => {
  vi.spyOn(userActions, 'isTrustedUiEvent').mockReturnValue(true);
  const rpc = vi.fn(async (kind: string, body: any) => {
    if (kind === 'settings.getReader') return {grammarEnabled:true};
    return {kind:'answer', grammarId:body.grammarId, turnId:body.turnId, answer:lesson};
  }) as UiRpc;
  const props = {rpc,grammarId:'synthetic',sentence:'They worked.',construction:'worked',explanationLanguage:'ru' as const,
    onBack:vi.fn(), onExpired:vi.fn(), onPermissionError:vi.fn()};
  const open = (visible: boolean) => act(async () => root.render(<GrammarChat {...props} open={visible} />));
  await open(true);
  const question = '# Мой вопрос про **worked** и [ˈwɜːkt]';
  const field = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,question);
    field.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Отправить')!.click());
  const questionNode = host.querySelector('.grammar-chat-question span')!;
  expect(questionNode.textContent).toBe(question);
  expect(questionNode.childElementCount).toBe(0);
  expect(host.querySelector('.grammar-chat-answer .language-chat-markdown h3')?.textContent).toBe('Present Perfect');
  await open(false); await open(true);
  expect(host.querySelector('.grammar-chat-answer ul strong')?.textContent).toBe('I/you/we/they have worked.');
  expect(vi.mocked(rpc).mock.calls.filter(([kind]) => kind === 'grammar.chat')).toHaveLength(1);
});
