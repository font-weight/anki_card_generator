import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {GrammarService} from '../packages/services/src/grammar.ts';
import {GrammarChatSessions} from '../packages/services/src/grammar-chat-sessions.ts';
import {createGrammarChatStore} from '../apps/extension/src/runtime/grammar-chat-store.ts';
import {restoreChatSnapshots} from '../packages/services/src/grammar-chat-store.ts';
import type {GrammarQuestionContext} from '../packages/contracts/src/grammar-question.ts';

type Pair={question:string;answer:string};
type Request={format:string;budget:number;stored:boolean;input:Record<string,unknown>};
const first:Pair={question:'Как по-итальянски сказать „Я люблю путешествовать“?',answer:'Mi piace viaggiare.'};
const german:Pair={question:'А по-немецки?',answer:'Ich reise gern.'};
const example:Pair={question:'А можешь привести пример?',answer:'Ich reise gern mit dem Zug.'};
const why:Pair={question:'Почему именно так?',answer:'Слово gern показывает, что действие доставляет удовольствие.'};
const another:Pair={question:'А ещё пример?',answer:'Ich reise gern nach Wien.'};
const book='The pelican had crossed Beacon Quay before dawn.';
const form='had crossed';
const source:GrammarQuestionContext={
 input:{sentence:book,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false},
 analysis:{grammarId:crypto.randomUUID(),sentence:book,construction:{text:form,targetStart:book.indexOf(form),targetEnd:book.indexOf(form)+form.length},
  question:'Что произошло на пристани?',answer:'Пеликан пересёк пристань до рассвета.',rule:'had crossed обозначает предшествование.',translation:'Пеликан пересёк пристань до рассвета.',explanation:null},
};
const owner=JSON.stringify(['reader-extension',17,'offline-page',0,3]);

// Exercise the released session adapter across worker recreation. Only Chrome's
// key/value storage area and external HTTP are replaced with in-memory doubles.
async function lesson(t:TestContext){
 const values=new Map<string,unknown>();
 const area={
  async get(keys:string|string[]){return Object.fromEntries([keys].flat().filter(k=>values.has(k)).map(k=>[k,structuredClone(values.get(k))]));},
  async set(entries:Record<string,unknown>){for(const [k,v] of Object.entries(entries))values.set(k,structuredClone(v));},
  async remove(keys:string|string[]){for(const k of [keys].flat())values.delete(k);},
 };
 const posts:Request[]=[];let keyReads=0,turnNumber=0,answer='';
 let nextResponse:(()=>Promise<Response>)|undefined;
 const service=new GrammarService({
  hasConsent:()=>true,getApiKey:()=>{keyReads++;return 'offline-fixture';},
  fetch:async(url,init)=>{
   assert.equal(String(url),'https://api.openai.com/v1/responses');assert.equal(init?.method,'POST');
   const b=JSON.parse(String(init?.body));const input=JSON.parse(b.input[0].content[0].text);
   posts.push({format:b.text.format.name,budget:b.max_output_tokens,stored:b.store,input});
   if(nextResponse){const respond=nextResponse;nextResponse=undefined;return respond();}
   const result=b.text.format.name==='language_reader_tutor_v1'?{kind:'answer',answer}:{kind:'insufficient_evidence'};
   return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({result})}]}]});
  },
 });
 const worker=()=>new GrammarChatSessions(service,createGrammarChatStore(area));
 let sessions=worker();await sessions.ready();let id=sessions.begin(owner,source.input,17,true);
 sessions.accept(owner,id,source.analysis);await sessions.flushed();t.after(()=>sessions.dispose());
 return {
  async ask(pair:Pair){
   const count=posts.length,keys=keyReads;answer=pair.answer;
   const payload={grammarId:id,sentence:book,turnId:crypto.randomUUID(),turnNumber:++turnNumber,question:pair.question};
   const reply=await sessions.ask(owner,payload,crypto.randomUUID());
   assert.equal(posts.length-count,keyReads-keys,'read keys only for actual provider calls');
   return {pair,reply,payload,posts:posts.slice(count)};
  },
  async nextCard(){
   const earlier=id;
   id=sessions.begin(owner,source.input,17,true);sessions.accept(owner,id,source.analysis);
   await sessions.flushed();turnNumber=0;
   return {earlier,id};
  },
  async restart(){await sessions.flushed();sessions.dispose();sessions=worker();await sessions.ready();},
  async replay(payload:{grammarId:string;sentence:string;turnId:string;turnNumber:number;question:string}){
   const count=posts.length,keys=keyReads;const reply=await sessions.ask(owner,payload,crypto.randomUUID());
   assert.equal(posts.length,count);assert.equal(keyReads,keys);return reply;
  },
  async storedHistory(){
   const [saved]=restoreChatSnapshots(await createGrammarChatStore(area).read());assert.ok(saved,'chat must remain usable after restart');
   return saved.history.map(({question,answer})=>({question,answer}));
  },
  respondOnce(respond:()=>Promise<Response>){nextResponse=respond;},
  posts,
 };
}
type Step=Awaited<ReturnType<Awaited<ReturnType<typeof lesson>>['ask']>>;
function expectIsolatedPost(step:Step,history:Pair[],wireQuestion=step.pair.question){
 assert.equal(step.posts.length,1,step.pair.question+' must have exactly one POST');
 const [post]=step.posts;
 assert.equal(post.format,'language_reader_tutor_v1',step.pair.question);
 assert.equal(post.budget,10_000);assert.equal(post.stored,false);
 assert.deepEqual(post.input,{
  question:wireQuestion,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',history,
 },step.pair.question);
 assert.doesNotMatch(JSON.stringify(post.input),/Beacon Quay|had crossed|Пеликан/u);
 assert.equal(step.reply.kind,'answer');assert.equal(step.reply.answer,step.pair.answer);
}
const pair=(question:string,answer:string):Pair=>({question,answer});
function trace(t:TestContext,steps:Step[]){
 t.diagnostic(steps.map(s=>s.pair.question+' → '+s.posts.length+' POST, '+(s.posts[0]?.input.history as Pair[]|undefined)?.length+' prior turns').join(' | '));
}

test('the reported Italian → German sequence keeps the translation, examples and explanation after worker recreation',async t=>{
 const h=await lesson(t),steps:Step[]=[];
 for(const p of [first,german,example,why,another]){
  if(p===german||p===why)await h.restart();
  steps.push(await h.ask(p));
 }
 trace(t,steps);assert.equal(h.posts.length,5);
 for(const [i,s] of steps.entries())expectIsolatedPost(s,steps.slice(0,i).map(v=>v.pair));
});

for(const q of ['А на немецком?','А как это будет на французском?','And in German?','Can you give me an example?','Ещё один, пожалуйста.']){
 test('an elliptical language follow-up inherits the previous accepted turn: '+q,async t=>{
  const h=await lesson(t);expectIsolatedPost(await h.ask(first),[]);
  const s=await h.ask(pair(q,'Учебный ответ для текущего запроса.'));trace(t,[s]);expectIsolatedPost(s,[first]);
 });
}

test('an independent new translation forgets the old topic and supplies its own history on the next short question',async t=>{
 const h=await lesson(t),newTopic=pair('Как по-польски сказать «Спасибо за помощь»?','Dziękuję za pomoc.');
 expectIsolatedPost(await h.ask(first),[]);expectIsolatedPost(await h.ask(newTopic),[]);
 await h.restart();
 expectIsolatedPost(await h.ask(pair('А на французском?','Merci pour votre aide.')),[newTopic]);
});

test('an explicit change of subject remains a boundary after restart, including when the new task asks for an example',async t=>{
 const h=await lesson(t);expectIsolatedPost(await h.ask(first),[]);
 const reset=pair('Смени тему: приведи пример употребления Dativ в немецком.','Ich helfe dem Kind.');
 const task=pair('приведи пример употребления Dativ в немецком.',reset.answer);
 expectIsolatedPost(await h.ask(reset),[],task.question);await h.restart();
 expectIsolatedPost(await h.ask(pair('Почему именно так?','После helfen используется Dativ.')),[task]);
});

test('a standalone reset is local and durable, and redelivering its ID cannot reset the next topic',async t=>{
 const h=await lesson(t);expectIsolatedPost(await h.ask(first),[]);
 const reset=await h.ask(pair('Давайте начнём с чистого листа.',''));
 assert.equal(reset.reply.kind,'topic_reset');assert.deepEqual(reset.posts,[]);
 assert.deepEqual(await h.storedHistory(),[]);await h.restart();
 const fresh=pair('Как по-польски сказать «Спасибо за помощь»?','Dziękuję za pomoc.');
 expectIsolatedPost(await h.ask(fresh),[]);await h.restart();
 assert.deepEqual(await h.replay(reset.payload),reset.reply);
 assert.deepEqual(await h.storedHistory(),[fresh]);
 expectIsolatedPost(await h.ask(pair('А по-немецки?','Danke für die Hilfe.')),[fresh]);
 assert.equal(h.posts.length,3);
});

for(const failure of ['decline','offline'] as const){
 test('explicit reset is durable before its new task reaches HTTP and survives '+failure,async t=>{
  const h=await lesson(t);expectIsolatedPost(await h.ask(first),[]);
  let sawPost!:()=>void,finish!:()=>void;
  const started=new Promise<void>(r=>{sawPost=r;}),release=new Promise<void>(r=>{finish=r;});
  h.respondOnce(async()=>{
   sawPost();await release;
   if(failure==='offline')throw TypeError('Offline synthetic transport');
   return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[
    {type:'output_text',text:JSON.stringify({result:{kind:'insufficient_evidence'}})},
   ]}]});
  });
  const task='Как по-польски сказать «Спасибо за помощь»?';
  const sent=h.ask(pair('Новая тема: '+task,''));
  await started;
  const persisted=await h.storedHistory();
  const post=h.posts.at(-1)!;finish();
  if(failure==='offline')await assert.rejects(sent);else assert.equal((await sent).reply.kind,'model_no_answer');
  assert.deepEqual(persisted,[],'old topic already cleared before the first HTTP response');
  assert.deepEqual(post.input,{question:task,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',history:[]});
  await h.restart();assert.deepEqual(await h.storedHistory(),[]);
  expectIsolatedPost(await h.ask(pair('Как по-немецки сказать «Время идти»?','Es ist Zeit zu gehen.')),[]);
  assert.equal(h.posts.length,3,'no automatic retry');
 });
}

test('a practical request performs zero calls and leaves the active language topic available after restart',async t=>{
 const h=await lesson(t);expectIsolatedPost(await h.ask(first),[]);
 const rejected=await h.ask(pair('Во сколько сегодня закрывается музей?',''));
 assert.equal(rejected.posts.length,0);assert.equal(rejected.reply.kind,'out_of_scope');
 await h.restart();expectIsolatedPost(await h.ask(german),[first]);assert.equal(h.posts.length,2);
});

test('more than five accepted questions include the five most recent matching pairs and no earlier material',async t=>{
 const h=await lesson(t),answers:Pair[]=[];
 const questions=[first.question,'А можно подробнее?','А ещё пример?','Почему именно так?','А можешь привести пример?','А по-немецки?','А ещё пример?','А можно подробнее?'];
 const steps:Step[]=[];
 for(const [i,q] of questions.entries()){
  if(i===6)await h.restart();
  const next=pair(q,i===0?first.answer:'Синтетический ответ номер '+i+'.');
  steps.push(await h.ask(next));answers.push(next);
 }
 trace(t,steps);
 for(const [i,s] of steps.entries())expectIsolatedPost(s,answers.slice(Math.max(0,i-5),i));
});

test('a long previous answer stays a bounded excerpt in a follow-up while the first displayed answer is complete',async t=>{
 const h=await lesson(t);const text='Italienisch: viaggiare. '.repeat(2600);
 const p=pair(first.question,text);expectIsolatedPost(await h.ask(p),[]);await h.restart();
 const step=await h.ask(german);assert.equal(step.posts.length,1);
 const history=step.posts[0].input.history as Pair[];assert.equal(history.length,1);assert.equal(history[0].question,first.question);
 assert.ok(history[0].answer.endsWith('…'));assert.ok(text.startsWith(history[0].answer.slice(0,-1)));
 assert.ok(history[0].question.length+history[0].answer.length<=48_000);
 expectIsolatedPost(step,history);
});

test('an identical sentence on the next card owns a fresh chat after worker restart; old questions cannot be replayed',async t=>{
 const h=await lesson(t),opening=await h.ask(first);
 expectIsolatedPost(opening,[]);await h.restart();
 expectIsolatedPost(await h.ask(german),[first]);
 const next=await h.nextCard();assert.notEqual(next.id,next.earlier);await h.restart();
 assert.deepEqual(await h.storedHistory(),[]);
 const count=h.posts.length;
 await assert.rejects(h.replay(opening.payload),{code:'LOOKUP_EXPIRED'});assert.equal(h.posts.length,count);
 const newTopic=pair('Как по-французски сказать «Спасибо»?','Merci.');
 expectIsolatedPost(await h.ask(newTopic),[]);await h.restart();
 expectIsolatedPost(await h.ask(pair('А по-немецки?','Danke.')),[newTopic]);
});

const topicBoundaries: Array<[string,boolean]> = [
 ['Какие падежи есть в немецком?',true],
 ['Какие артикли есть во французском языке?',true],
 ['Сколько падежей в финском?',true],
 ['Зачем нужен дательный падеж?',true],
 ['How many cases does German have?',true],
 ['У глаголов в польском есть род?',true],
 ['Is it true that Finnish has fifteen cases?',true],
 ['Is it true that it has four cases?',false],
 ['А по-немецки?',false],
 ['Какие ещё варианты есть по-немецки?',false],
 ['Сколько падежей в этом примере?',false],
 ['Зачем нужен артикль в твоём переводе?',false],
 ['Which cases appear in your example?',false],
 ['How many cases in total?',false],
 ['Переведи на немецкий',false],
];
for(const [question,newTopic] of topicBoundaries){
 test('topic-boundary r2: '+question,async t=>{
  const h=await lesson(t);
  expectIsolatedPost(await h.ask(first),[]);
  const next=pair(question,'Учебный ответ по запрошенной теме.');
  const step=await h.ask(next);
  trace(t,[step]);expectIsolatedPost(step,newTopic?[]:[first]);
  await h.restart();
  expectIsolatedPost(await h.ask(pair('А можешь привести пример?','Подходящий пример.')),newTopic?[next]:[first,next]);
 });
}
