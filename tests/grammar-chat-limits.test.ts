import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateRequest,validateData} from '../packages/contracts/src/index.ts';
import {GRAMMAR_QUESTION_LIMIT,GRAMMAR_ANSWER_LIMIT,GRAMMAR_CHAT_HISTORY_UNITS,GRAMMAR_CHAT_TIMEOUT_MS} from '../packages/contracts/src/grammar-chat-limits.ts';
import type {GrammarQuestionContext} from '../packages/contracts/src/grammar-question.ts';
import {GrammarService} from '../packages/services/src/grammar.ts';
import {GrammarChatSessions} from '../packages/services/src/grammar-chat-sessions.ts';
import {boundedChatHistory,restoreChatSnapshots} from '../packages/services/src/grammar-chat-store.ts';
import {createGrammarChatStore} from '../apps/extension/src/runtime/grammar-chat-store.ts';
import {CHAT_RESPONSE_BYTES,readChatStream} from '../packages/services/src/grammar-chat-stream.ts';

const sentence='Mara had dreamed of the sea.';
const ctx:GrammarQuestionContext={input:{sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false},
 analysis:{grammarId:crypto.randomUUID(),sentence,construction:{text:'had dreamed',targetStart:5,targetEnd:16},question:'Что показывает форма?',answer:'Мечта относится к прошлому.',rule:'had dreamed ставит мечту раньше другого события.',translation:'Мара мечтала о море.',explanation:null}};
const query='Как перевести на немецкий: «Доброе утро»?';
const owner=(tab:number)=>JSON.stringify(['reader',tab,'document',0,1]);
const turn=(id:string,number:number,question=query)=>({grammarId:id,sentence,turnId:crypto.randomUUID(),turnNumber:number,question});
const env=(answer:string)=>({status:'completed',model:'gpt-6-luna',usage:{input_tokens:200,output_tokens:10_000,total_tokens:10_200},
 output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({result:{kind:'answer',answer}})}]}]});
const json=(id:string,value:unknown)=>'event: '+id+'\r\ndata: '+JSON.stringify({type:id,response:value})+'\r\n\r\n';
function sse(text:string){
 const bytes=new TextEncoder().encode(text);let start=0;
 return new Response(new ReadableStream({pull(out){
  if(start>=bytes.length){out.close();return;}
  const size=start<500?1:4093;out.enqueue(bytes.slice(start,start+size));start+=size;
 }}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
}
function area(){
 let data:Record<string,unknown>={};let limit=Infinity;
 return {get:async(keys:string|string[])=>Object.fromEntries([keys].flat().filter(k=>Object.hasOwn(data,k)).map(k=>[k,structuredClone(data[k])])),
  set:async(next:Record<string,unknown>)=>{const merged={...data,...next};if(JSON.stringify(merged).length>limit)throw Error('QUOTA_BYTES exceeded');data=structuredClone(merged);},
  remove:async(keys:string|string[])=>{for(const k of [keys].flat())delete data[k];},
  limit(n:number){limit=n;},bytes:()=>JSON.stringify(data).length};
}
test('RPC boundaries use UTF-16 and preserve escaped multilingual text in full',()=>{
 const prefix='Переведи: ';const body=prefix+'🦊'.repeat((GRAMMAR_QUESTION_LIMIT-prefix.length)>>1);
 const question=body+'文'.repeat(GRAMMAR_QUESTION_LIMIT-body.length);assert.equal(question.length,10_000);
 const request={v:1,type:'grammar.chat',requestId:crypto.randomUUID(),payload:turn(ctx.analysis.grammarId,1,question)};
 const valid=validateRequest(request);assert.ok(valid.type==='grammar.chat');assert.ok('question' in valid.payload);assert.equal(valid.payload.question,question);
 assert.throws(()=>validateRequest({...request,payload:{...request.payload,question:question+'X'}}));
 const source='«漢字»\\\n😀"';const answer=source.repeat(Math.floor(GRAMMAR_ANSWER_LIMIT/source.length))+'x'.repeat(GRAMMAR_ANSWER_LIMIT%source.length);
 const reply={grammarId:ctx.analysis.grammarId,turnId:request.payload.turnId,kind:'answer',answer};
 assert.deepEqual(validateData('grammar.chat',reply),reply);
 assert.throws(()=>validateData('grammar.chat',{...reply,answer:answer+'文'}));
});
test('one actual streaming Responses POST sets 10000 output tokens and delivers the full final message after split UTF-8 and JSON escapes',async()=>{
 const answer='Многоязычный учебный пример: Über, «漢字», \\ и "слово".\n'.repeat(4200);
 const requests:Record<string,any>[]=[];
 const service=new GrammarService({getApiKey:()=>'offline',fetch:async(_url,init)=>{
  requests.push(JSON.parse(String(init?.body)));
  return sse(': beat\r\n\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"未完"}\r\n\r\n'+json('response.completed',env(answer)));
 }});
 const prefix=query+' ';
 const longQuestion=prefix+'文'.repeat(GRAMMAR_QUESTION_LIMIT-prefix.length);
 const result=await service.chat(ctx,[],longQuestion);
 await assert.rejects(service.chat(ctx,[],longQuestion+'文'),{code:'INVALID_INPUT'});
 assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0].input[0].content[0].text).question,longQuestion);
 assert.equal(requests[0].stream,true);assert.equal(requests[0].store,false);assert.equal(requests[0].max_output_tokens,10_000);
 assert.equal(result.usage?.outputTokens,10_000);assert.ok(result.data.kind==='answer');assert.equal(result.data.answer,answer);
});
test('EOF, malformed JSON, and a terminal token-limit status never publish provisional deltas or retry',async()=>{
 for(const [stream,code] of [
  ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n','INTERNAL_ERROR'],
  ['event: response.completed\ndata: {bad json}\n\n','INVALID_MODEL_OUTPUT'],
  [json('response.incomplete',{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}),'MODEL_INCOMPLETE'],
  [json('response.completed',{status:'incomplete'}),'INVALID_MODEL_OUTPUT'],
  [json('response.completed',env('whole JSON but interrupted SSE frame')).trimEnd(),'INTERNAL_ERROR'],
 ] as const){
  let calls=0;const service=new GrammarService({getApiKey:()=>'offline',fetch:async()=>{calls++;return sse(stream);}});
  await assert.rejects(service.chat(ctx,[],query),{code});assert.equal(calls,1);
 }
 const raw=new Response(new Uint8Array([0xff,0xe1,0x80]),{headers:{'Content-Type':'text/event-stream'}});
 await assert.rejects(readChatStream(raw,new AbortController().signal),{code:'INVALID_MODEL_OUTPUT'});
});
test('rejects an oversized declared stream or unterminated event and releases the reader',async()=>{
 const empty=new Response('',{headers:{'content-length':String(CHAT_RESPONSE_BYTES*10)}});
 await assert.rejects(readChatStream(empty,new AbortController().signal),{diagnostics:{stage:'response',reason:'response_too_large'}});
 let cancelled=false;
 const fragment=new Uint8Array(256*1024).fill(65);
 const over=new Response(new ReadableStream({pull(out){out.enqueue(fragment);},cancel(){cancelled=true;}}));
 await assert.rejects(readChatStream(over,new AbortController().signal),{diagnostics:{stage:'response',reason:'response_too_large'}});
 assert.equal(cancelled,true);
});
test('the chat waits past the old 20s and 45s ceilings but cancels once at the longer deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0,stopped=0;
 let started!:()=>void;const opened=new Promise<void>(done=>{started=done;});
 const service=new GrammarService({getApiKey:()=>'offline',fetch:async()=>{
  calls++;started();
  return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': connected\n\n'));},cancel(){stopped++;}}),
   {headers:{'content-type':'text/event-stream'}});
 }});
 const request=service.chat(ctx,[],query);const outcome=assert.rejects(request,{code:'NETWORK_TIMEOUT'});await opened;
 await new Promise<void>(done=>setImmediate(done));t.mock.timers.tick(45_001);await new Promise<void>(done=>setImmediate(done));assert.equal(stopped,0);
 t.mock.timers.tick(GRAMMAR_CHAT_TIMEOUT_MS-45_001);await outcome;assert.equal(stopped,1);assert.equal(calls,1);
});
test('bounded provider history preserves recent turns, the scope marker and complete surrogate pairs',()=>{
 const long='🦊'.repeat(GRAMMAR_CHAT_HISTORY_UNITS);
 const history=boundedChatHistory([{question:'Older?',answer:'Older answer'},{scope:'language',question:'Почему?',answer:long}]);
 assert.equal(history.length,1);assert.equal(history[0].scope,'language');
 assert.ok(history[0].answer.endsWith('…'));assert.doesNotMatch(history[0].answer,/[\uD800-\uDBFF]…$/u);
 assert.ok(history[0].question.length+history[0].answer.length<=GRAMMAR_CHAT_HISTORY_UNITS);
 assert.equal(long.length,2*GRAMMAR_CHAT_HISTORY_UNITS);
});
test('a quota failure does not drop a paid answer, resend it, or remove another open reader',async()=>{
 const backend=area();let calls=0;
 const long='日本語の例と русский ответ. '.repeat(8000);
 const service=new GrammarService({getApiKey:()=>'offline',fetch:async()=>Response.json(env(++calls===2?long:'Guten Morgen — доброе утро.'))});
 const make=()=>new GrammarChatSessions(service,createGrammarChatStore(backend));
 let sessions=make();await sessions.ready();
 const register=async(tab:number)=>{const id=sessions.begin(owner(tab),ctx.input,tab,true);sessions.accept(owner(tab),id,ctx.analysis);await sessions.flushed();return id;};
 const firstId=await register(1),secondId=await register(2);
 const first=turn(firstId,1),second=turn(secondId,1);
 const ask=(tab:number,p:ReturnType<typeof turn>)=>sessions.ask(owner(tab),p,crypto.randomUUID());
 const earlier=await ask(1,first);
 backend.limit(backend.bytes()+8500);
 const [reply,replay]=await Promise.all([ask(2,second),ask(2,second)]);
 assert.ok(reply.kind==='answer');assert.equal(reply.answer,long);assert.deepEqual(replay,reply);assert.equal(calls,2);
 assert.deepEqual(await ask(2,second),reply);
 sessions.dispose();sessions=make();await sessions.ready();
 assert.deepEqual(await ask(1,first),earlier);await assert.rejects(ask(2,second),{code:'REQUEST_CANCELLED'});assert.equal(calls,2);
 assert.equal((await ask(2,turn(secondId,2))).kind,'answer');assert.equal(calls,3);
 sessions.close(owner(2),secondId);await sessions.flushed();sessions.dispose();sessions=make();await sessions.ready();
 assert.deepEqual(await ask(1,first),earlier);assert.throws(()=>ask(2,second),{code:'LOOKUP_EXPIRED'});assert.equal(calls,3);
});
test('an existing V1 analysis migrates with replayable paid text, storing its history reference without another full copy',async()=>{
 const backend=area(),key='grammarChatSessionsV1';
 const id=ctx.analysis.grammarId,p=turn(id,1);
 const answer='完整の erklärende Antwort «пример» — '.repeat(1400);
 const reply={grammarId:id,turnId:p.turnId,kind:'answer',answer} as const;
 await backend.set({[key]:{version:1,sessions:[{owner:owner(1),tabId:1,id,input:ctx.input,analysis:ctx.analysis,history:[{question:query,answer}],
  highest:1,retired:[],numberRequired:false,turns:[{id:p.turnId,number:1,question:query,outcome:{reply}}]}]}});
 const store=createGrammarChatStore(backend),before=restoreChatSnapshots(await store.read());
 assert.equal(before.length,1);await store.write({version:1,sessions:before});
 const record=(await backend.get('grammarChatOwner:'+id))['grammarChatOwner:'+id] as {history:unknown[]};
 assert.deepEqual(record.history,[{turn:p.turnId}]);
 const service=new GrammarService({getApiKey:()=>null,fetch:async()=>{throw Error('No paid replay');}});
 const sessions=new GrammarChatSessions(service,createGrammarChatStore(backend));await sessions.ready();
 assert.deepEqual(await sessions.ask(owner(1),p,crypto.randomUUID()),reply);
});
