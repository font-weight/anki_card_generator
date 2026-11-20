import {act} from 'react';
import {expect,vi} from 'vitest';
import {mountGrammarPopup} from '../../apps/extension/src/ui/mount';
import type {UiRpc} from '../../apps/extension/src/ui/interfaces';

export async function openTestChat(doc:Document, word:string, anchor:()=>DOMRect|null=()=>new DOMRect(24,24,40,18)) {
  const grammarId=crypto.randomUUID();
  const sentence='The '+word+' was quiet.';
  const source=doc.createElement('p');source.textContent=sentence;doc.body.append(source);
  const range=doc.createRange();range.setStart(source.firstChild!,4);range.setEnd(source.firstChild!,4+word.length);
  const turns:{question:string;signal?:AbortSignal;finish:(answer:string)=>void}[]=[];
  const rpc=vi.fn(async(type:string,body:Record<string,unknown>,options?:{signal?:AbortSignal})=>{
    if(type==='settings.getReader')return {grammarEnabled:true,defaultDeck:'Test'};
    if(type==='grammar.lookup')return {
      grammarId,sentence,construction:{text:'was quiet',targetStart:sentence.indexOf('was'),targetEnd:sentence.length-1},
      question:'Что выражает was quiet?',answer:'Состояние в прошлом.',rule:'Was связывает подлежащее с прилагательным.',
      explanation:'Форма is описала бы состояние в настоящем.',translation:'Там было тихо.',
    };
    if(type==='grammar.chat')return new Promise(resolve=>turns.push({question:String(body.question),signal:options?.signal,
      finish:answer=>resolve({kind:'answer',grammarId,turnId:body.turnId,answer})}));
    return {};
  });
  const context={sentence,targetStart:4,targetEnd:4+word.length};
  const frame=doc!==document;
  let card!:ReturnType<typeof mountGrammarPopup>;
  await act(async()=>{
    card=mountGrammarPopup({
      rpc:rpc as UiRpc, trustedPage:frame,autoGenerate:true,anchor,selectionRange:range,selection:{expression:word,range,context},
      source:{kind:frame?'epub':'html',title:'Synthetic',url:null,documentId:frame?'fixture-book':null,page:null,chapter:null,cfi:null},
      payload:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:true},
    });
  });
  const host=document.querySelector<HTMLElement>('[data-english-reader-popup]')!;
  const shadow=host.shadowRoot!;
  await act(async()=>shadow.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!.click());
  const field=shadow.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  const edit=async(text:string)=>act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,text);
    field.dispatchEvent(new Event('input',{bubbles:true}));
  });
  return {host,shadow,field,turns,edit,
    async send(text:string) {
      await edit(text);
      const button=[...shadow.querySelectorAll('button')].find(btn=>btn.textContent==='Отправить')!;
      await act(async()=>button.click());
    },
    async finish(index:number,text:string){await act(async()=>turns[index].finish(text));},
    async close(){await act(async()=>card.close());},
    closed:()=>rpc.mock.calls.filter(([kind])=>kind==='grammar.chat.close').length,
  };
}

export async function exerciseTabReturn(card:Awaited<ReturnType<typeof openTestChat>>, switchTab:(away:boolean)=>void){
  await card.send('Объясни прошедшее время.');
  await card.finish(0,'Первый ответ остаётся в переписке.');
  await card.send('Дай ещё один пример.');
  await card.edit('Черновик следующего вопроса');
  await act(async()=>switchTab(true));
  expect(card.host.isConnected).toBe(true);
  expect(card.turns[1].signal?.aborted).toBe(false);
  expect(card.closed()).toBe(0);
  await card.finish(1,'Ответ пришёл, пока вкладка была скрыта.');
  await act(async()=>switchTab(false));
  expect(document.querySelector('[data-english-reader-popup]')).toBe(card.host);
  expect(card.shadow.querySelector('#grammar-chat-question')).toBe(card.field);
  expect(card.field.value).toBe('Черновик следующего вопроса');
  expect(card.shadow.querySelector('[role=log]')?.textContent).toContain('Первый ответ остаётся в переписке.');
  expect(card.shadow.querySelector('[role=log]')?.textContent).toContain('Ответ пришёл, пока вкладка была скрыта.');
  expect(card.turns).toHaveLength(2);
  expect(card.closed()).toBe(0);
}
