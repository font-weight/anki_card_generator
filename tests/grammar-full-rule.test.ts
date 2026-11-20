import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GrammarService, GRAMMAR_QUESTION_MAX_OUTPUT_TOKENS} from '../packages/services/src/grammar.ts';
import {GrammarChatSessions} from '../packages/services/src/grammar-chat-sessions.ts';
import {OpenAIServiceError} from '../packages/services/src/openai.ts';
import {validateData} from '../packages/contracts/src/index.ts';
import {GRAMMAR_ANSWER_LIMIT} from '../packages/contracts/src/grammar-question.ts';
import {relativeClauseLesson as lesson, fullRuleQuestion as question} from './fixtures/grammar-relative-clause.ts';

const grounded = {kind:'answer',anchor:'who',evidence:'researchers who have tried',answer:'Местоимение who вводит придаточное и относится к людям, пытавшимся установить порядок изданий.'};
function tutor(enabled = true) {
  let keyReads = 0;
  const prompts: {history: {question:string;answer:string}[]; question: string}[] = [];
  const service = new GrammarService({
    hasConsent: () => enabled, getApiKey: () => { keyReads++;return 'offline-fixture'; },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const name=body.text.format.name;
      assert.ok(name==='language_reader_tutor_v1'||name==='language_reader_grammar_question_v1');
      assert.equal(body.max_output_tokens,GRAMMAR_QUESTION_MAX_OUTPUT_TOKENS);
      prompts.push(JSON.parse(body.input[0].content[0].text));
      return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',
        content:[{type:'output_text',text:JSON.stringify({result:name==='language_reader_tutor_v1'?{kind:'answer',answer:grounded.answer}:grounded})}]}]});
    },
  });
  return {service,prompts,counts:()=>[keyReads,prompts.length]};
}

test('a full lesson on the relative clause uses the whole source and requests original examples',async()=>{
  for(const wording of [question,'Could you spell out the rule in full?','Отправь мне правило целиком, как оно звучит']){
    for(const detailed of [true,false]){
      const {service,prompts,counts}=tutor();
      const context={...lesson,input:{...lesson.input,includeExplanation:detailed},
        analysis:{...lesson.analysis,explanation:detailed?lesson.analysis.explanation:null}};
      const result=await service.chat(context,[],wording);
      assert.deepEqual(result.data,{kind:'answer',answer:grounded.answer});
      assert.deepEqual(counts(),[1,1]);assert.deepEqual(prompts[0].history,[]);
      assert.equal((prompts[0] as any).sentence,lesson.input.sentence);
      assert.equal((prompts[0] as any).lesson.rule,lesson.analysis.rule);
    }
  }
  const off=tutor(false);await assert.rejects(off.service.chat(lesson,[],question),{code:'REQUEST_CANCELLED'});assert.deepEqual(off.counts(),[0,0]);
});
test('only an explicit card quotation is served for free; a mixed off-topic request is declined',async()=>{
  const {service,counts}=tutor();
  for(const quote of ['Процитируй правило из карточки','Повтори дословно правило из карточки','Quote the rule from this card.']){
    const reply=await service.chat(lesson,[{scope:'language',question:'Translate apple',answer:'Яблоко'}],quote);
    assert.deepEqual(reply.data,{kind:'answer',source:'analysis',answer:lesson.analysis.rule});
  }
  assert.equal((await service.chat(lesson,[],'Объясни мне правило целиком и где купить билет?')).data.kind,'out_of_scope');
  assert.deepEqual(counts(),[0,0]);
});
test('verified local answer survives the public reply contract, session restart, replay and accepted teaching history',async()=>{
  let raw:unknown;
  const store={read:async()=>structuredClone(raw),write:async(value:unknown)=>{raw=structuredClone(value);}};
  const {service,prompts,counts}=tutor(),owner=JSON.stringify(['reader',7,'document',0,1]);
  let sessions=new GrammarChatSessions(service,store);
  await sessions.ready();const grammarId=sessions.begin(owner,lesson.input,7,true);
  sessions.accept(owner,grammarId,lesson.analysis);await sessions.flushed();
  const quote="Процитируй правило из карточки",expected=lesson.analysis.rule;
  const first={grammarId,sentence:lesson.input.sentence,question:quote,turnNumber:1,turnId:crypto.randomUUID()};
  const reply=validateData('grammar.chat',await sessions.ask(owner,first,crypto.randomUUID()));
  assert.deepEqual(reply,{grammarId,turnId:first.turnId,kind:'answer',source:'analysis',answer:expected});
  sessions.dispose();sessions=new GrammarChatSessions(service,store);await sessions.ready();
  assert.deepEqual(await sessions.ask(owner,first,crypto.randomUUID()),reply);assert.deepEqual(counts(),[0,0]);
  await sessions.ask(owner,{...first,turnNumber:2,turnId:crypto.randomUUID(),question:'К кому относится who?'},crypto.randomUUID());
  assert.deepEqual(prompts[0].history,[{question:quote,answer:expected}]);assert.deepEqual(counts(),[1,1]);
  assert.throws(()=>validateData('grammar.chat',{...reply,source:'untrusted'}));
  assert.throws(()=>validateData('grammar.chat',{...reply,answer:'а'.repeat(GRAMMAR_ANSWER_LIMIT+1)}));
});

test('safe validation diagnostics persist across worker restart and never dispatch a failed turn twice', async()=>{
  let raw:unknown,calls=0;
  const store={read:async()=>structuredClone(raw),write:async(value:unknown)=>{raw=structuredClone(value);}};
  const diagnostics={stage:'output',reason:'output_json'} as const;
  const service={chat:async()=>{calls++;throw new OpenAIServiceError('INVALID_MODEL_OUTPUT',false,diagnostics);}};
  const owner=JSON.stringify(['reader',7,'document',0,1]);let sessions=new GrammarChatSessions(service,store);
  await sessions.ready();const grammarId=sessions.begin(owner,lesson.input,7,true);
  sessions.accept(owner,grammarId,lesson.analysis);await sessions.flushed();
  const claim={grammarId,sentence:lesson.input.sentence,question:'К кому относится who?',turnNumber:1,turnId:crypto.randomUUID()};
  await assert.rejects(sessions.ask(owner,claim,crypto.randomUUID()),{code:'INVALID_MODEL_OUTPUT',diagnostics});
  sessions.dispose();sessions=new GrammarChatSessions(service,store);await sessions.ready();
  await assert.rejects(sessions.ask(owner,claim,crypto.randomUUID()),{code:'INVALID_MODEL_OUTPUT',diagnostics});
  assert.equal(calls,1);
});
