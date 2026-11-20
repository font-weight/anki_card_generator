import test from 'node:test';
import assert from 'node:assert/strict';
import {GrammarService, GRAMMAR_QUESTION_MAX_OUTPUT_TOKENS, LANGUAGE_TUTOR_SYSTEM_PROMPT} from '../packages/services/src/grammar.ts';
import {classifyGrammarQuestion,validateLanguageTutorOutput,type GrammarQuestionContext,type GrammarQuestionTurn} from '../packages/contracts/src/grammar-question.ts';

const sentence='Charles Luckman said: “As far back as I can remember, I have got up at five o\'clock in the morning because I can think better then than any other time, I can think better then and plan my day, plan to do things in the order of their importance.”';
const form='As far back as I can remember',start=sentence.indexOf(form);
const context:GrammarQuestionContext={
 input:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',includeExplanation:false,learnerLevel:'B1'},
 analysis:{sentence,grammarId:crypto.randomUUID(),construction:{text:form,targetStart:start,targetEnd:start+form.length},
  question:'Как далеко во времени простирается воспоминание?',answer:'Слова говорящего ограничены тем периодом, который он помнит.',
  rule:'As far back as вводит границу времени, о котором говорится.',translation:'Отрывок о раннем подъёме.',explanation:null},
};
const screenshot='дай полное объяснение темы Present Perfect';
const answer='Present Perfect образуется с have или has и причастием прошедшего времени. Пример: I have finished the letter.';
const last:GrammarQuestionTurn={question:screenshot,answer,scope:'language'};
function stub(){
 const calls:Record<string,unknown>[]=[],keys:string[]=[];
 let result:unknown={kind:'answer',answer};
 const service=new GrammarService({hasConsent:()=>true,getApiKey:()=>{keys.push('read');return 'offline-synthetic';},
  fetch:async(_url,options)=>{
   const b=JSON.parse(String(options?.body));
   assert.equal(b.instructions,LANGUAGE_TUTOR_SYSTEM_PROMPT);assert.equal(b.text.format.name,'language_reader_tutor_v1');
   assert.equal(b.max_output_tokens,GRAMMAR_QUESTION_MAX_OUTPUT_TOKENS);assert.equal(b.store,false);assert.equal(b.tools,undefined);
   calls.push(JSON.parse(b.input[0].content[0].text));
   return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({result})}]}]});
  }});
 return {service,calls,keys,set:(r:unknown)=>{result=r;}};
}

test('the screenshot and independent grammar, translation, writing, pronunciation and exercises use only the explicit material',async()=>{
 const h=stub();
 const questions=[
  screenshot,'Как правильно по-испански объяснить дорогу?',
  'Как правильно обратиться к заказчику с просьбой перенести срок?',
  'У меня резюме. Как бы вы изменили формулировку „занимался координацией“?',
  'How does a better synonym change the tone of a sentence?', 'Почему в японском есть частицы?',
  'Объясни японскую грамматику для начинающих.', 'Чем отличаются ser и estar?',
  'Перефразируй по-деловому: „Можешь прислать счёт во вторник?“',
  'Перефразируй следующие реплики по-французски и сохрани их последовательность. Bonjour, Luc.',
  'Ответь только переводом: Good morning.', 'Переведи **срочно** на итальянский.',
  'Смени тему: начнём с фонетики испанского.', 'Как по-английски прочитать выражение 3 < 5?',
  'Как произносится through? Напиши транскрипцию.', 'Составь упражнения на французский subjunctif.',
  'Исправь письмо, сохраняя его разметку:\n# Agenda\n**Please** bring the <draft> and `notes`.',
  'Переведи: Во сколько открывается ближайшая библиотека?', 'Quelle est la différence entre imparfait et passé composé ?',
 ];
 for(const q of questions){
  const prior=[{question:'Текст чужой темы',answer:'Предыдущий пример.',scope:'language' as const}];
  const r=await h.service.chat(context,prior,q);
  assert.equal(r.data.kind,'answer',q);
  assert.deepEqual(h.calls.at(-1),{question:q.startsWith('Смени тему: ')?q.slice('Смени тему: '.length):q,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',history:[]},q);
 }
 assert.equal(h.keys.length,questions.length);assert.equal(h.calls.length,questions.length);
});

test('a general follow-up continues the accepted language lesson after a refusal without leaking a book sentence or an older topic',async()=>{
 const h=stub(),previous:GrammarQuestionTurn={question:'Как произнести приветствие по-польски?',answer:'Dzień dobry.',scope:'language'};
 const rejected=await h.service.chat(context,[previous,last],'Сколько рублей стоит билет в Сочи?');
 assert.deepEqual(rejected.data,{kind:'out_of_scope'});assert.equal(h.keys.length,0);
 const follow='А теперь дай ещё два примера.';
 const reply=await h.service.chat(context,[previous,last],follow);
 assert.equal(reply.data.kind,'answer');assert.deepEqual(h.calls[0].history,[{question:screenshot,answer}]);
 assert.equal(h.calls[0].sentence,undefined);assert.equal(h.calls[0].lesson,undefined);assert.equal(h.keys.length,1);
 const elaborate='А можно подробнее?';
 const more={question:follow,answer:'Voici deux exemples.',scope:'language' as const};
 assert.equal((await h.service.chat(context,[previous,last,more],elaborate)).data.kind,'answer');
 assert.deepEqual(h.calls[1].history,[{question:screenshot,answer},{question:follow,answer:more.answer}]);
 const focused=await h.service.chat(context,[last],'Переведи выделенное предложение.');
 assert.equal(focused.data.kind,'answer');assert.equal(h.calls[2].sentence,sentence);
 assert.equal(h.calls[2].lesson,undefined);assert.deepEqual(h.calls[2].history,[]);
 const supplied='Перефразируй следующие реплики и сохрани их последовательность. Bonjour, Emma.';
 const rewritten={question:supplied,answer:'Bonjour, madame.',scope:'language' as const};
 await h.service.chat(context,[last,rewritten],'Можно подробнее?');
 assert.deepEqual(h.calls[3].history,[{question:supplied,answer:rewritten.answer}]);
 h.set({kind:'out_of_scope'});assert.deepEqual((await h.service.chat(context,[last],'Tell me more about a different subject.')).data,{kind:'model_out_of_scope'});
 h.set({kind:'answer',answer:'Durante el verano.'});assert.equal((await h.service.chat(context,[last],'Traduce «in summer» al español.')).data.kind,'answer');
});

test('general tutor accepts harmless literal notation and paragraphs without requiring book evidence',()=>{
 for(const content of ['# Past Perfect\n\n**Form**: had + past participle.','On écrit `chère` pour le féminin.','3 < 5 means three is less than five.','Кавычки «<слово>» остаются текстом.']){
  assert.deepEqual(validateLanguageTutorOutput({result:{kind:'answer',answer:content}}),{kind:'answer',answer:content});
 }
 assert.throws(()=>validateLanguageTutorOutput({result:{kind:'answer',answer:'   '}}));
 assert.throws(()=>validateLanguageTutorOutput({result:{kind:'answer',answer:'Объяснение',unrequested:'field'}}));
 assert.equal(classifyGrammarQuestion(context,[],'Какая завтра погода?'),'local_decline');
});

test('an explanation of a quoted word from the previous answer keeps the topic; a supplied new translation stands alone',async()=>{
 const h=stub(),german:GrammarQuestionTurn={question:'А по-немецки?',answer:'Ich reise gern.',scope:'language',topicStart:true};
 for(const q of ['А почему „gern“?', 'Why ‘gern’ instead of ‘gerne’?', 'Объясни подробнее: почему так?', 'Почему *gern*?']){
  await h.service.chat(context,[german],q);
  assert.deepEqual(h.calls.at(-1)?.history,[{question:german.question,answer:german.answer}],q);
 }
 await h.service.chat(context,[german],'А как по-немецки сказать „До встречи“?');
 assert.deepEqual(h.calls.at(-1)?.history,[]);
});
