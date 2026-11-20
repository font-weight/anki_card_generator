import assert from 'node:assert/strict';
import test from 'node:test';
import {GrammarService} from '../packages/services/src/grammar.ts';
import type {GrammarQuestionContext,GrammarQuestionTurn} from '../packages/contracts/src/grammar-question.ts';

function lesson(sentence:string,anchor:string,rule:string,answer:string,translation:string,language:'ru'|'en'='ru'):GrammarQuestionContext {
  const start=sentence.indexOf(anchor);
  assert.notEqual(start,-1);
  return {
    input:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:language,learnerLevel:'B1',includeExplanation:false},
    analysis:{
      grammarId:'00000000-0000-4000-8000-000000000041',sentence,construction:{text:anchor,targetStart:start,targetEnd:start+anchor.length},
      question:language==='ru'?'Что показывает выделенная форма?':'What does the highlighted form show?',
      answer,rule,translation,explanation:null,
    },
  };
}

const dream=lesson('Before they moved, Mara had dreamed of the sea.','had dreamed',
  'Past Perfect ставит мечту раньше другого момента в прошлом.',
  'Форма had dreamed показывает, что Мара мечтала о море до переезда.','До переезда Мара мечтала о море.');
const map=lesson('Before the ferry arrived, Inez had folded the map.','had folded',
  'Past Perfect показывает предшествование в прошлом.',
  'Форма had folded указывает, что Инес сложила карту до прибытия парома.','До прибытия парома Инес сложила карту.');
const relative=lesson('The gardener who planted the apple tree lives nearby.','who planted the apple tree',
  'A relative clause identifies a person through an action.',
  'Here, who planted the apple tree identifies the gardener who lives nearby.','Садовник, который посадил яблоню, живёт неподалёку.','en');
const modal=lesson('The bus might arrive after sunset.','might arrive',
  'Модальный глагол might выражает возможность.',
  'Форма might arrive называет возможное время прибытия автобуса.','Автобус может прибыть после заката.');
const conditional=lesson('If the lights went out, the lamp would still work.','would still work',
  'Условное предложение описывает следствие гипотетического отключения света.',
  'Форма would still work описывает работу лампы при воображаемом отключении света.','Если бы свет погас, лампа всё равно работала бы.');

const beforeQuestion='Does ‘before’ already tell us which event happened first?';
const pastSimple='Почему не Past Simple?';
const dreamExample={evidence:'Mara had dreamed of the sea',variation:'Mara dreamed of the sea',
  answer:'Например: «Mara dreamed of the sea». В исходной фразе had dreamed относит мечту к времени до переезда.'};
const mapExample={evidence:'Inez had folded the map',variation:'Inez folded the map',
  answer:'Например: «Inez folded the map». В исходной фразе had folded подчёркивает, что карта уже была сложена.'};
const examples=new Map([[dream,dreamExample],[map,mapExample]]);

// Every provider request reaches this substitute, even if an unrelated question
// slips through. It returns a valid answer so a false positive cannot look like a local rejection.
function fixture(context:GrammarQuestionContext){
  let keyReads=0;
  const calls:{format:string;sentence:string;question:string;explanationLanguage:string;construction:GrammarQuestionContext['analysis']['construction'];history:GrammarQuestionTurn[]}[]=[];
  const service=new GrammarService({
    getApiKey:()=>{keyReads++;return 'offline-test';},
    hasConsent:()=>true,
    fetch:async(_url,options)=>{
      const request=JSON.parse(String(options?.body));
      const input=JSON.parse(request.input[0].content[0].text) as Omit<(typeof calls)[number],'format'>;
      calls.push({...input,format:request.text.format.name});
      const anchor=context.analysis.construction.text;
      const example=/пример|example/iu.test(input.question)?examples.get(context):undefined;
      const result=example?{kind:'answer',anchor,...example}:
        {kind:'answer',anchor,answer:context.analysis.answer,evidence:context.input.sentence};
      return Response.json({
        status:'completed',id:'resp_offline',output:[{type:'message',role:'assistant',status:'completed',
          content:[{type:'output_text',text:JSON.stringify({result})}]}],
      });
    },
  });
  return {
    accept:async(question:string,history:GrammarQuestionTurn[]=[]):Promise<GrammarQuestionTurn>=>{
      const count=calls.length;
      const reply=await service.chat(context,history,question);
      assert.equal(calls.length,count+1,question);assert.equal(keyReads,count+1);
      assert.equal(reply.data.kind,'answer');
      assert.equal(reply.data.anchor,context.analysis.construction.text);
      const example=/пример|example/iu.test(question)?examples.get(context):undefined;
      assert.equal(reply.data.evidence,example?.evidence??context.input.sentence);
      const sent=calls[count]!;
      assert.equal(sent.format,example?'language_reader_grammar_example_v1':'language_reader_grammar_question_v1');
      assert.equal(sent.question,question);assert.equal(sent.sentence,context.input.sentence);assert.equal(sent.explanationLanguage,context.input.explanationLanguage);
      assert.deepEqual(sent.construction,context.analysis.construction);assert.deepEqual(sent.history,history);
      return {question,answer:reply.data.answer};
    },
    reject:async(question:string,history:GrammarQuestionTurn[]=[])=>{
      const count=calls.length,keys=keyReads;
      const reply=await service.chat(context,history,question);
      assert.equal(calls.length,count,question);assert.equal(keyReads,keys);
      assert.deepEqual(reply.data,{kind:'out_of_scope'});
    },
  };
}

const ordinaryQuestions:[GrammarQuestionContext,string][]=[
  [dream,'Почему нельзя просто сказать dreamed?'],
  [dream,'А had здесь можно опустить?'],
  [dream,'Do we really need ‘had’ here?'],
  [dream,beforeQuestion],
  [dream,pastSimple],
  [map,'Почему нельзя просто сказать folded?'],
  [map,beforeQuestion],
  [relative,'К кому здесь относится who?'],
  [relative,'Who does ‘who’ refer to here?'],
  [modal,'Does ‘might’ mean the bus is certain to arrive?'],
  [conditional,'Что изменится, если убрать would?'],
];
for(const [context,question] of ordinaryQuestions){
  test('accepts a question on '+context.analysis.construction.text+': '+question,async()=>{
    await fixture(context).accept(question);
  });
}

test('can simplify the displayed lesson both before and after a chat answer',async()=>{
  const chat=fixture(dream);
  const question='Можешь объяснить попроще?';
  const initial=await chat.accept(question);
  await chat.accept(question,[initial]);
});

for(const question of ['Можно ещё один пример?','Can you give me an example?','А почему?']){
  test('resolves a short follow-up only after an accepted answer: '+question,async()=>{
    const chat=fixture(dream);
    await chat.reject(question);
    const previous=await chat.accept(pastSimple);
    const next=await chat.accept(question,[previous]);
    if(/пример|example/iu.test(question))assert.equal(next.answer,dreamExample.answer);
  });
}

test('a second lesson gets a variation of its own highlighted construction',async()=>{
  const chat=fixture(map);
  const previous=await chat.accept('Почему нельзя просто сказать folded?');
  const followUp=await chat.accept('Можно ещё один пример?',[previous]);
  assert.equal(followUp.answer,mapExample.answer);
});

const unrelated:[GrammarQuestionContext,string][]=[
  [relative,'Какие яблони лучше посадить весной?'],
  [modal,'How much does the bus ticket cost?'],
  [conditional,'Где купить такую лампу?'],
];
for(const [context,question] of unrelated){
  test('declines an ordinary off-topic question without a request: '+question,async()=>{
    await fixture(context).reject(question);
  });
}

test('a prior grammar answer does not authorize a change of subject',async()=>{
  const chat=fixture(dream);
  const previous=await chat.accept(pastSimple);
  await chat.reject('Как заказать билеты к морю?',[previous]);
});
