import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {GrammarQuestionContext} from '../packages/contracts/src/grammar-question.ts';
import {GrammarService} from '../packages/services/src/grammar.ts';
import {GrammarChatSessions} from '../packages/services/src/grammar-chat-sessions.ts';

const sentence='But suppose I had been bored by fishing, then how do you think I would have felt?';
const fragment='I had been bored by fishing',start=sentence.indexOf(fragment);
const context:GrammarQuestionContext={
  input:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false},
  analysis:{sentence,grammarId:crypto.randomUUID(),construction:{text:fragment,targetStart:start,targetEnd:start+fragment.length},
    question:'Как связаны условие и результат?',answer:'Говорящий воображает другой ход событий в прошлом.',
    rule:'Past Perfect здесь задаёт предположение; конструкция would have felt выражает его следствие.',explanation:null,
    translation:'Но предположим, что рыбалка бы мне наскучила. Как, по-твоему, я бы себя чувствовал?'},
};
type Input={sentence?:string;construction?:GrammarQuestionContext['analysis']['construction'];lesson?:{rule:string};
  question:string;history:{question:string;answer:string}[];explanationLanguage:string};
const first='дай мне правило целиком',second='дай полное объяснение как использовать правило это';
const present='Дай полное объяснение темы Present Perfect',rule='Present Perfect связывает предшествующее событие с настоящим.';
function harness(){
  const posts:{input:Input;instructions:string}[]=[];
  let answer='Собеседник предлагает вообразить иной исход уже завершившегося события.';
  const service=new GrammarService({getApiKey:()=>'offline',fetch:async(_url,options)=>{
    const body=JSON.parse(String(options?.body));
    assert.equal(body.text.format.name,'language_reader_tutor_v1');
    assert.equal(body.max_output_tokens,10000);assert.equal(body.stream,true);assert.equal(body.store,false);
    posts.push({input:JSON.parse(body.input[0].content[0].text),instructions:body.instructions});
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[
      {type:'output_text',text:JSON.stringify({result:{kind:'answer',answer}})},
    ]}]});
  }});
  return {posts,service,setAnswer:(value:string)=>{answer=value;}};
}

for(const wording of [first, second, 'Расскажи подробнее про это правило','Можно подробнее?', 'Explain more.',
  'Разбери по шагам, когда и как применять эту конструкцию.',
  'Объясни всю тему от начала до конца, с примерами и ошибками.',
  'Объясни, чем это правило отличается от Second Conditional.',
  'Walk me through the rule step by step.', 'Explain how to use this construction in detail.',
  'Explícame esta regla en detalle.', 'Pouvez-vous expliquer cette règle en détail ?',
  'Erkläre mir diese Regel ausführlich.', 'この文法を詳しく説明して。','请完整解释这个语法规则。'
]){
  test('a fresh request for the present lesson receives the checked card: '+wording,async()=>{
    const h=harness();
    const result=await h.service.chat(context,[],wording);
    assert.equal(result.data.kind,'answer');assert.equal(h.posts.length,1);
    const {input,instructions}=h.posts[0];
    assert.equal(input.question,wording);assert.equal(input.sentence,sentence);
    assert.deepEqual(input.construction,context.analysis.construction);assert.equal(input.lesson?.rule,context.analysis.rule);
    assert.deepEqual(input.history,[]);assert.match(instructions,/when to use it/i);
    assert.match(instructions,/translated examples/i);assert.match(instructions,/parenthetical/i);
    assert.match(instructions,/unless the reader asks otherwise/i);
  });
}

test('the same words refer to the last accepted topic, including after a weather question was rejected',async()=>{
  const h=harness(),owner='offline',s=new GrammarChatSessions(h.service);
  try{
    const id=s.begin(owner,context.input);s.accept(owner,id,context.analysis);
    let number=0;const ask=(question:string)=>s.ask(owner,{grammarId:id,sentence,question,turnNumber:++number,turnId:crypto.randomUUID()},crypto.randomUUID());
    const initial=await ask(first);assert.equal(initial.kind,'answer');await ask(second);
    const card=h.posts[1].input;
    assert.equal(card.sentence,sentence);assert.deepEqual(card.history,[{question:first,answer:initial.kind==='answer'?initial.answer:''}]);
    h.setAnswer(rule);await ask(present);assert.deepEqual(h.posts[2].input.history,[]);assert.equal(h.posts[2].input.sentence,undefined);
    assert.equal((await ask('Какая завтра погода?')).kind,'out_of_scope');assert.equal(h.posts.length,3);
    await ask(second);
    assert.deepEqual(h.posts[3].input.history,[{question:present,answer:rule}]);assert.equal(h.posts[3].input.sentence,undefined);
    const independent='Расскажи подробно про согласование прилагательных';await ask(independent);
    assert.deepEqual(h.posts[4].input.history,[]);assert.equal(h.posts[4].input.lesson,undefined);
  }finally{s.dispose();}
});

test('a full lesson follows the latest card-specific focus, preserving the configured explanation language',async()=>{
  const h=harness(),prior={question:'Какую роль играет do you think?',answer:'Это обращение к собеседнику внутри другого вопроса.'};
  await h.service.chat({...context,input:{...context.input,explanationLanguage:'de'}},[prior],second);
  assert.equal(h.posts[0].input.explanationLanguage,'de');assert.equal(h.posts[0].input.sentence,sentence);assert.deepEqual(h.posts[0].input.history,[prior]);
});

test('a title supplied after a colon sets the subject even when preceded by a demonstrative',async()=>{
  const old={scope:'language' as const,question:'Объясни Third Conditional',answer:'Форма описывает воображаемое прошлое.'};
  for(const q of ['Объясни мне эту тему: Present Perfect','Explain this topic: the present perfect','Расскажи про эту тему: порядок слов в корейском']){
    for(const history of [[],[old]]){
      const h=harness();
      await h.service.chat(context,history,q);
      assert.equal(h.posts.length,1);assert.deepEqual(h.posts[0].input.history,[]);
      assert.equal(h.posts[0].input.sentence,undefined);
    }
  }
  const h=harness();
  await h.service.chat(context,[old],'Объясни эту тему: с примерами и упражнениями');
  assert.deepEqual(h.posts[0].input.history,[{question:old.question,answer:old.answer}]);
});
