import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {webcrypto} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {GrammarPopup, type GrammarPopupOptions} from '../../apps/extension/src/ui/GrammarPopup';
import type {UiRpc} from '../../apps/extension/src/ui/interfaces';
import * as actions from '../../apps/extension/src/ui/user-actions';

const topic = 'Дай полное объяснение темы Present Perfect';
const lesson = '# Present Perfect\n\n## 1. Образование\n\n**have/has + причастие**\n\n'
  + 'Употребление формы зависит от контекста. '.repeat(800) + 'Конец первого урока.';
const second = 'Как использовать артикль с названием реки?';
const nextLesson = 'Названия рек берут определённый артикль. '.repeat(700) + 'Конец второго урока.';
const questions = [topic, second, 'А можешь привести пример?', 'Почему именно так?', 'Новая тема', '2+2?', '2+2?'];
const posts: Array<Record<string,unknown>> = [];
const lookupSentences: string[] = [];
let root: ReturnType<typeof createRoot>, host: HTMLElement;

const rpc = (async (name: string, body: Record<string,unknown> = {}) => {
  if (name === 'settings.getReader') return {grammarEnabled: true};
  if (name === 'grammar.lookup') {
    const sentence = String(body.sentence);
    lookupSentences.push(sentence);
    return {grammarId: crypto.randomUUID(), sentence,
      construction: {text: 'has sailed', targetStart: sentence.indexOf('has sailed'), targetEnd: sentence.indexOf('has sailed') + 10},
      question: 'Что выражает has sailed?', answer: 'У капитана уже есть опыт плавания.',
      rule: 'Форма has sailed связывает плавание с настоящим моментом.', explanation: null, translation: 'Капитан уже выходил в море.'};
  }
  if (name === 'grammar.chat') {
    posts.push(body);
    const {grammarId, turnId, question} = body;
    if (question === '2+2?') return {grammarId, turnId, kind: 'out_of_scope'};
    if (question === 'Новая тема') return {grammarId, turnId, kind: 'topic_reset'};
    const answer = question === topic ? lesson : question === second ? nextLesson : 'Вариант из текущего учебного примера.';
    return {grammarId, turnId, kind: 'answer', answer};
  }
  return {};
}) as UiRpc;

function button(label: string) {
  const target = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  if (!target) throw new Error('Missing button ' + label);
  return target;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function mountCard(cardKey:string, sentence:string, autoGenerate=true) {
  const options: GrammarPopupOptions={rpc,autoGenerate,trustedPage:true,
    source:{kind:'epub',title:'Synthetic',url:null,documentId:'one-book',page:null,cfi:null,chapter:'Port'},
    payload:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false}};
  await act(async()=>root.render(<GrammarPopup key={cardKey} options={options} close={()=>{}}/>));
}
async function send(question: string) {
  const input = host.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,question);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await vi.waitFor(() => expect(button('Отправить').disabled).toBe(false));
  await click('Отправить');
}
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);
  vi.spyOn(actions,'isTrustedUiEvent').mockReturnValue(true);
  posts.length=0;lookupSentences.length=0;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

it('retains both long lessons and every repeated refusal while the same card is open, including preview and returning to the chat',async()=>{
  await mountCard('first word','Mara has sailed before.');await click('Открыть языковой чат');
  for(const question of questions)await send(question);
  expect([...host.querySelectorAll('.grammar-chat-question span')].map(el=>el.textContent)).toEqual(questions);
  expect(host.querySelector('.language-chat-markdown h4')?.textContent).toContain('Образование');
  expect(host.textContent).toContain('Конец первого урока.');expect(host.textContent).toContain('Конец второго урока.');
  const input=host.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Черновик третьего вопроса');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await click('← К разбору');expect(document.activeElement).toBe(button('Открыть языковой чат'));
  await click('Предпросмотр');await click('Открыть языковой чат');
  const returned=host.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  expect(document.activeElement).toBe(returned);expect(returned.value).toBe('Черновик третьего вопроса');
  expect([...host.querySelectorAll('.grammar-chat-question span')].map(el=>el.textContent)).toEqual(questions);
  expect(posts).toHaveLength(questions.length);expect(lookupSentences).toHaveLength(1);
  for(const post of posts)expect(Object.keys(post).sort()).toEqual(['grammarId','question','sentence','turnId','turnNumber'].sort());
});

it('starts empty for another word in the very same sentence and after a new opening of the original card',async()=>{
  const sentence='Mara has sailed before.';
  await mountCard('word A',sentence);await click('Открыть языковой чат');await send(topic);
  expect(host.textContent).toContain('Конец первого урока.');
  await mountCard('word B',sentence);await click('Открыть языковой чат');
  expect(host.querySelector('[role=log]')?.textContent).toBe('');
  expect(host.querySelector<HTMLTextAreaElement>('#grammar-chat-question')?.value).toBe('');
  await send('А по-немецки?');
  expect(posts[0].grammarId).not.toBe(posts[1].grammarId);
  expect(JSON.stringify(posts[1])).not.toContain(topic);
  await act(async()=>root.unmount());root=createRoot(host);
  await mountCard('word A again',sentence,false);
  expect(host.textContent).not.toMatch(/История чата книги|Очистить историю книги|первого урока/);
  expect(posts).toHaveLength(2);expect(lookupSentences).toHaveLength(2);
  await click('Разобрать предложение');await click('Открыть языковой чат');
  expect(host.querySelector('[role=log]')?.textContent).toBe('');
  expect(posts).toHaveLength(2);expect(lookupSentences).toHaveLength(3);
});
