import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {GrammarQuestionContext} from '../packages/contracts/src/grammar-question.ts';
import {GrammarService} from '../packages/services/src/grammar.ts';

const sentence='The road that we crossed was quiet.';
const context:GrammarQuestionContext={
  input:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false},
  analysis:{grammarId:crypto.randomUUID(),sentence,construction:{text:'that we crossed',targetStart:9,targetEnd:24},
    question:'Какое уточнение относится к дороге?',answer:'Придаточная часть уточняет, какую дорогу перешли.',rule:'That вводит определительное придаточное.',
    explanation:null,translation:'Дорога, которую мы перешли, была тихой.'},
};
const question='Дай полное объяснение темы Present Perfect';
const answer='## Форма\n\n**Have** или **has** связывает событие с настоящим.';
const result=JSON.stringify({result:{kind:'answer',answer}});
const text=(value:string)=>({type:'output_text',text:value});
const message=(content:unknown[],phase?:string)=>({type:'message',role:'assistant',status:'completed',content,...(phase?{phase}:{})});
const final=(...output:unknown[])=>({status:'completed',id:'resp_fixture',usage:{input_tokens:32,output_tokens:21,total_tokens:53},output});
function event(type:string,body:Record<string,unknown>){
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...body})+'\n\n';
}
const sse=(stream:string)=>new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
async function ask(response:()=>Response) {
  let calls=0;
  const service=new GrammarService({getApiKey:()=>'offline-fixture',fetch:async(_url,init)=>{
    calls++;
    const body=JSON.parse(String(init?.body));
    assert.equal(body.reasoning.effort,'none');
    assert.equal(body.max_output_tokens,10_000);
    assert.equal(body.stream,true);assert.equal(body.store,false);
    return response();
  }});
  try{return await service.chat(context,[],question);}finally{assert.equal(calls,1);}
}
for (const mode of ['json','stream'] as const) {
  const response=(body:{status:string})=>mode==='stream'?sse(event('response.'+body.status,{response:body})):Response.json(body);
  test(mode+' joins only the ordered text blocks of one final message and retains usage',async()=>{
    const body=final(message([text('Preparing the answer.')],'commentary'),{type:'reasoning',summary:[]},message([text(result.slice(0,35)),text(result.slice(35))],'final_answer'));
    const execution=await ask(()=>response(body));
    assert.equal(execution.data.kind,'answer');
    assert.equal(execution.data.kind==='answer'&&execution.data.answer,answer);
    assert.equal(execution.usage?.outputTokens,21);assert.equal(execution.responseId,'resp_fixture');
  });
  test(mode+' distinguishes empty and ambiguous final messages, refusal, invalid JSON and ordinary insufficient evidence',async()=>{
    const cases=[
      [final(message([text('  \n')])), 'INVALID_MODEL_OUTPUT','output_missing'],
      [final(message([text(result)]),message([text(result)])), 'INVALID_MODEL_OUTPUT','output_multiple'],
      [final(message([{type:'refusal',refusal:'private detail'}])),'MODEL_REFUSAL','output_refusal'],
      [final(message([text('{"partial":')])),'INVALID_MODEL_OUTPUT','output_json'],
      [{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},'MODEL_INCOMPLETE','output_token_limit'],
      [{status:'incomplete',incomplete_details:{reason:'content_filter'}},'MODEL_INCOMPLETE','output_incomplete'],
    ] as const;
    for(const [body,code,reason] of cases)await assert.rejects(ask(()=>response(body)),{code,diagnostics:{stage:'output',reason}});
    const noAnswer=await ask(()=>response(final(message([text(JSON.stringify({result:{kind:'insufficient_evidence'}}))]))));
    assert.equal(noAnswer.data.kind,'model_no_answer');
  });
}
test('network disconnect and premature stream EOF have a transport diagnostic, not a model status',async()=>{
  const expected={code:'INTERNAL_ERROR',diagnostics:{stage:'response',reason:'response_interrupted'}};
  await assert.rejects(ask(()=>{throw new TypeError('fixture connection lost');}),expected);
  await assert.rejects(ask(()=>sse(event('response.output_text.delta',{delta:'unfinished'})+'data: [DONE]\n\n')),expected);
  await assert.rejects(ask(()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('fixture network read error'));}}))),expected);
});
test('stream terminal errors identify the provider cause without exposing the provider message',async()=>{
  await assert.rejects(ask(()=>sse(event('error',{code:'rate_limit_exceeded',message:'provider text'}))),{code:'OPENAI_RATE_LIMIT'});
  await assert.rejects(ask(()=>sse(event('response.failed',{response:{status:'failed',error:{code:'invalid_api_key'}}}))),{code:'OPENAI_AUTH'});
});
