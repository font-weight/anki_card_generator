import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {createReaderServices,SecretVault} from '../packages/services/src/index.ts';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import type {GrammarChatReply,GrammarLookupPayload} from '../packages/contracts/src/index.ts';
import {restoreReaderAccess,isRegisteredReader} from '../apps/extension/src/runtime/reader-access.ts';
import {createGrammarChatStore} from '../apps/extension/src/runtime/grammar-chat-store.ts';

const extension='abcdefghijklmnopabcdefghijklmnop';
const settings={id:extension,url:'chrome-extension://'+extension+'/settings.html',frameId:0};
const reader={id:extension,url:'https://reader.invalid/offline',documentId:'test-document',tab:{id:7},frameId:0};
const other={...reader,documentId:'another-document',tab:{id:8}};
const sentence='I longed for leisure to read, and to write the books I had dreamed of writing back in my college days.';
const selected='I had dreamed of writing';
const ruleRequest='Отправь мне правило целиком, как оно звучит';
const nextSentence='The painter who restored the mural waited outside.';
const nextSelected='who restored the mural';
const unrelated='Какие книги продались лучше всего в прошлом году?';
type Recorded={sentence:string;question:string;history:{question:string;answer:string}[]};
type Services=ReturnType<typeof createReaderServices>;
type Sender=Parameters<Services['handleMessage']>[1];
type Reply=Awaited<ReturnType<Services['handleMessage']>>;

function area(){
  let data:Record<string,unknown>={};
  return {
    async get(keys:string|string[]|null=null){
      if(keys===null)return structuredClone(data);
      return structuredClone(Object.fromEntries([keys].flat().filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]])));
    },
    async set(values:Record<string,unknown>){data={...data,...structuredClone(values)};},
    async remove(keys:string|string[]){for(const key of [keys].flat())delete data[key];},
    async setAccessLevel(){},
  };
}

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};}
function response(content:unknown){
  return Response.json({status:'completed',model:'gpt-6-luna',id:'resp_offline',output:[{type:'message',role:'assistant',status:'completed',
    content:[{type:'output_text',text:JSON.stringify(content)}]}]});
}
function answerFor(input:Recorded){
  if(input.sentence===nextSentence)return {anchor:nextSelected,evidence:'The painter who restored the mural',
    answer:'Придаточное who restored the mural уточняет, какой художник ждал.'};
  if(input.question.includes('leisure'))return {anchor:'leisure',evidence:'for leisure',answer:'Слово leisure стоит после for и называет то, чего хотелось говорящему.'};
  if(input.question.includes('перед read'))return {anchor:'to read',evidence:'leisure to read',answer:'В to read частица to вводит инфинитив и указывает, для чего нужно свободное время.'};
  if(input.question.includes('после of'))return {anchor:'of writing',evidence:'dreamed of writing',answer:'В сочетании of writing после предлога стоит форма глагола на -ing.'};
  if(input.question.includes('subject of longed'))return {anchor:'I',evidence:'I longed',answer:'Подлежащее глагола longed — местоимение I в начале предложения.'};
  return {anchor:selected,evidence:'the books I had dreamed of writing',
    answer:'В обороте I had dreamed of writing форма had dreamed относит мечту к более раннему моменту в прошлом.'};
}
function success<T>(reply:Reply):T{assert.ok(reply.ok,JSON.stringify(reply));return reply.data as T;}
function error(reply:Reply,code:string){assert.ok(!reply.ok,JSON.stringify(reply));assert.equal(reply.error.code,code);}
function answered(reply:Reply){const data=success<GrammarChatReply>(reply);assert.equal(data.kind,'answer');return data;}
function turn(grammarId:string,question:string,source=sentence,turnNumber?:number){
  return {grammarId,question,sentence:source,turnId:crypto.randomUUID(),...(turnNumber===undefined?{}:{turnNumber})};
}

async function harness(t:TestContext){
  let sessionArea=area();
  const local=area(),indexedDB=new IDBFactory();
  const chromeApi={runtime:{id:extension},storage:{session:sessionArea,local}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'chrome');
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:chromeApi});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'chrome',previous);else Reflect.deleteProperty(globalThis,'chrome');});
  await sessionArea.set({registeredReaderDocuments:[reader.documentId,other.documentId]});
  await new SecretVault({session:sessionArea,local}).setOpenAIKey('offline-fixture');
  const calls:Recorded[]=[],lookups:string[]=[];
  type Pause={began:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>};
  let slow:Pause|undefined,slowLookup:Pause|undefined,nextCheckpoint:ReturnType<typeof deferred>|undefined;
  const fetcher:typeof fetch=async(_url,options)=>{
    const body=JSON.parse(String(options?.body)),input=JSON.parse(body.input[0].content[0].text);
    if(body.text.format.name==='language_reader_grammar_v2'){
      lookups.push(input.sentence);
      const pause=slowLookup;slowLookup=undefined;
      if(pause){pause.began.resolve();await pause.release.promise;}
      const text=input.sentence===sentence?selected:nextSelected,start=input.sentence.indexOf(text);
      assert.ok(start>=0,'Unknown fixture');
      const meaning=input.sentence===sentence?'Мечта предшествовала желанию получить свободное время.':'Речь о художнике, который восстановил роспись.';
      return response({analysis:{kind:'grammar',confidence:'high',sentence:input.sentence,construction:{text,targetStart:start,targetEnd:start+text.length},
        question:'Что показывает выделенная форма?',answer:meaning,rule:input.sentence===sentence?'Past Perfect указывает на более раннее событие в прошлом.':'Относительное придаточное уточняет, о каком человеке идёт речь.',
        explanation:null,translation:input.sentence===sentence?'Мне хотелось иметь время для чтения и для книг, о которых я мечтал ещё в колледже.':'Художник, который восстановил роспись, ждал снаружи.'}});
    }
    assert.ok(['language_reader_grammar_question_v1','language_reader_tutor_v1'].includes(body.text.format.name));calls.push(structuredClone(input));
    const pending=slow;slow=undefined;
    if(pending){pending.began.resolve();await pending.release.promise;}
    const checked=answerFor(input);
    return response({result:{kind:'answer',...(body.text.format.name==='language_reader_tutor_v1'?{answer:checked.answer}:checked)}});
  };
  async function newWorker(){
    // Chrome serializes session data; a fresh factory, registry and DB connection
    // cannot share in-memory sessions with the previous background worker.
    await restoreReaderAccess();
    const sessionStore=createGrammarChatStore(sessionArea);
    return createReaderServices({storage:await openReaderStorage({indexedDB}),secrets:new SecretVault({session:sessionArea,local}),
      grammarChatStore:{read:sessionStore.read,async write(data){
        await sessionStore.write(data);
        if(nextCheckpoint){nextCheckpoint.resolve();nextCheckpoint=undefined;}
      }},fetch:fetcher,
      runtime:{extensionId:extension,allowedPageUrls:[settings.url],isRegisteredReader},confirmations:{requireConsent:async()=>true}});
  }
  let worker=await newWorker();t.after(()=>worker.close());
  const send=(type:string,payload:unknown,sender:Sender=reader,requestId=crypto.randomUUID())=>worker.handleMessage({v:1,requestId,type,payload},sender);
  const enabled=async(value:boolean)=>{success(await send('settings.update',{patch:{grammarEnabled:value}},settings));};
  await enabled(true);
  const lookup=async(source=sentence,sender:Sender=reader)=>{
    const payload:GrammarLookupPayload={sentence:source,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false};
    return success<{grammarId:string}>(await send('grammar.lookup',payload,sender)).grammarId;
  };
  return {calls,lookups,send,lookup,enabled,indexedDB,local,sessionValues:()=>sessionArea.get(),ask:(p:ReturnType<typeof turn>,sender:Sender=reader)=>send('grammar.chat',p,sender),
    async restart(abrupt=false){
      if(abrupt){
        // Snapshot exactly what Chrome had acknowledged at the instant the old
        // worker disappeared. Its teardown and late fetch cannot populate the
        // storage facade handed to the replacement worker.
        const recovered=area();await recovered.set(await sessionArea.get());
        sessionArea=recovered;chromeApi.storage.session=recovered;
      }
      await worker.close();worker=await newWorker();
    },
    closeTab:async(tabId:number)=>{await worker.closeGrammarTab(tabId);},
    checkpoint(){nextCheckpoint=deferred();return nextCheckpoint.promise;},
    holdLookup(){const pause={began:deferred(),release:deferred()};slowLookup=pause;return pause;},
    hold(){const pause={began:deferred(),release:deferred()};slow=pause;return pause;},
  };
}

test('repeats the complete-rule request after worker recreation with the same analysis and no implicit charges',async t=>{
  const h=await harness(t),id=await h.lookup();
  const first=turn(id,ruleRequest),initial=answered(await h.ask(first));
  assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].history,[]);
  await h.restart();assert.deepEqual(h.lookups,[sentence]);assert.equal(h.calls.length,1);
  assert.deepEqual(answered(await h.ask(first)),initial);assert.equal(h.calls.length,1);
  const second=turn(id,ruleRequest);
  answered(await h.ask(second));assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].sentence,sentence);assert.deepEqual(h.calls[1].history,[{question:ruleRequest,answer:initial.answer}]);
});

test('an unrelated turn is free and leaves the active lesson usable after recreation',async t=>{
  const h=await harness(t),id=await h.lookup(),off=turn(id,unrelated);
  assert.equal(success<GrammarChatReply>(await h.ask(off)).kind,'out_of_scope');assert.equal(h.calls.length,0);
  await h.restart();assert.equal(success<GrammarChatReply>(await h.ask(off)).kind,'out_of_scope');
  answered(await h.ask(turn(id,'Почему не Past Simple?')));assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].history,[]);
});

test('more than sixteen submissions retain only the five recent accepted pairs across worker lifetimes',async t=>{
  const h=await harness(t),id=await h.lookup(),accepted:Recorded['history']=[];
  const wording=[ruleRequest,'Почему не Past Simple?','Do we really need ‘had’ here?','Как изменится смысл, если убрать had?'];
  let first:ReturnType<typeof turn>|undefined,last:ReturnType<typeof turn>|undefined;
  for(let n=1;n<=28;n++){
    if(n===19||n===24)await h.restart();
    const free=n%4===0;
    const contextual=n<=17 ? wording[1+n%2]! : wording[(n+Math.floor(n/4))%wording.length]!;
    const q=free ? unrelated : contextual;
    // Also exercise a reader that started with the RC4.1 payload. This makes
    // the previous sixteen-turn ceiling observable before using sequence numbers.
    const p=turn(id,q,sentence,n<=17 ? undefined : n);
    first??=p;
    last=p;
    const before=h.calls.length,result=await h.ask(p);
    if(free){assert.equal(success<GrammarChatReply>(result).kind,'out_of_scope');assert.equal(h.calls.length,before);continue;}
    const reply=answered(result);
    assert.equal(h.calls.length,before+1);assert.deepEqual(h.calls.at(-1)!.history,accepted.slice(-5));
    accepted.push({question:q,answer:reply.answer});
  }
  assert.equal(accepted.length,21);await h.restart();
  assert.equal(success<GrammarChatReply>(await h.ask(last!)).kind,'out_of_scope');
  error(await h.ask(first!),'REQUEST_CANCELLED');assert.equal(h.calls.length,21);
});

test('a restored analysis remains owned by its exact sender and sentence, and close and disable stay revoked',async t=>{
  const h=await harness(t),id=await h.lookup(),p=turn(id,'Почему не Past Simple?');
  await h.restart();
  for(const foreign of [other,{...reader,frameId:1},{...reader,tab:{id:9}}])error(await h.ask(p,foreign),'PERMISSION_DENIED');
  error(await h.ask({...p,sentence:sentence.replace('college','school')}),'INVALID_INPUT');
  assert.equal(h.calls.length,0);answered(await h.ask(p));assert.equal(h.calls.length,1);
  assert.deepEqual(success(await h.send('grammar.chat.close',{grammarId:id})),{closed:true});
  await h.restart();error(await h.ask(p),'LOOKUP_EXPIRED');
  const fresh=await h.lookup();await h.enabled(false);await h.restart();
  error(await h.ask(turn(fresh,'Почему не Past Simple?')),'PERMISSION_DENIED');await h.enabled(true);
  error(await h.ask(turn(fresh,'Почему не Past Simple?')),'LOOKUP_EXPIRED');
  const tabSession=await h.lookup();await h.restart();await h.closeTab(reader.tab.id);await h.restart();
  error(await h.ask(turn(tabSession,'Почему не Past Simple?')),'LOOKUP_EXPIRED');assert.equal(h.calls.length,1);
});

test('switching sentences while a question is outstanding rejects the late result and starts fresh history',async t=>{
  const h=await harness(t),id=await h.lookup(),gate=h.hold();
  const pending=h.ask(turn(id,'Почему не Past Simple?'));
  await Promise.race([gate.began.promise,pending.then(reply=>assert.fail('Question ended before dispatch: '+JSON.stringify(reply)))]);
  try{
    const newer=await h.lookup(nextSentence);assert.notEqual(newer,id);
    error(await pending,'REQUEST_CANCELLED');gate.release.resolve();
    await h.restart();error(await h.ask(turn(id,'Почему не Past Simple?')),'LOOKUP_EXPIRED');
    answered(await h.ask(turn(newer,'Что показывает форма «who restored the mural» в этом предложении?',nextSentence)));
    assert.equal(h.calls.length,2);assert.equal(h.calls[1].sentence,nextSentence);assert.deepEqual(h.calls[1].history,[]);
  }finally{gate.release.resolve();}
});

test('worker interruption never replays a paid question; a separate explicit turn can retry',async t=>{
  const h=await harness(t),id=await h.lookup(),gate=h.hold(),question='Почему не Past Simple?',old=turn(id,question);
  const pending=h.ask(old);
  await Promise.race([gate.began.promise,pending.then(reply=>assert.fail('Question ended before dispatch: '+JSON.stringify(reply)))]);
  try{
    await h.restart(true);assert.equal(h.calls.length,1);error(await pending,'REQUEST_CANCELLED');
    error(await h.ask(old),'REQUEST_CANCELLED');assert.equal(h.calls.length,1);
    const retry=turn(id,question);const ok=answered(await h.ask(retry));assert.equal(h.calls.length,2);
    gate.release.resolve();await h.restart();
    assert.deepEqual(answered(await h.ask(retry)),ok);assert.equal(h.calls.length,2);
    answered(await h.ask(turn(id,'А почему?')));
    assert.deepEqual(h.calls.at(-1)!.history,[{question,answer:ok.answer}]);
  }finally{gate.release.resolve();}
});

test('a reader can restate the screenshot follow-up in Russian after an accepted explanation',async t=>{
  const h=await harness(t),id=await h.lookup(),question='Почему не Past Simple?';
  const initial=answered(await h.ask(turn(id,question)));
  await h.restart();
  const restated='Можешь изложить это правило своими словами от начала до конца?';
  answered(await h.ask(turn(id,restated)));
  assert.equal(h.calls.length,2);
  assert.deepEqual(h.calls[1].history,[{question,answer:initial.answer}]);
});

for(const [question,anchor,source] of [
  ['Какую роль здесь играет слово leisure?','leisure',sentence],
  ['Зачем перед read стоит to?','to read',sentence],
  ['А почему после of стоит writing?','of writing',sentence],
  ['What is the subject of longed?','I',sentence],
  ['Could you spell out the grammar rule in full?',selected,sentence],
  ['What does this relative clause describe?',nextSelected,nextSentence],
]){
  test('grounds a natural question through the background RPC: '+question,async t=>{
    const h=await harness(t),id=await h.lookup(source);
    const data=answered(await h.ask(turn(id,question,source)));
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].sentence,source);assert.ok(data.answer.includes(anchor));
  });
}


test('cancelling an opening RPC after the worker has delivered or cached the analysis only revokes that exact card',async t=>{
  const h=await harness(t);
  const p:GrammarLookupPayload={sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false};
  const firstRequest=crypto.randomUUID(),secondRequest=crypto.randomUUID();
  const first=success<{grammarId:string}>(await h.send('grammar.lookup',p,reader,firstRequest)).grammarId;
  const firstTurn=turn(first,'Почему не Past Simple?');
  answered(await h.ask(firstTurn));
  await h.restart();
  assert.equal(success<{grammarId:string}>(await h.send('grammar.lookup',p,reader,firstRequest)).grammarId,first);
  const newest=success<{grammarId:string}>(await h.send('grammar.lookup',p,reader,secondRequest)).grammarId;
  assert.notEqual(newest,first);assert.deepEqual(h.lookups,[sentence]);
  assert.deepEqual(success(await h.send('grammar.cancel',{requestId:firstRequest})),{cancelled:false});
  assert.deepEqual(success(await h.send('grammar.cancel',{requestId:secondRequest},other)),{cancelled:false});
  error(await h.ask(firstTurn),'LOOKUP_EXPIRED');
  const secondTurn=turn(newest,'Почему не Past Simple?');
  answered(await h.ask(secondTurn));assert.deepEqual(h.calls.at(-1)?.history,[]);
  await h.restart();
  assert.deepEqual(success(await h.send('grammar.cancel',{requestId:secondRequest})),{cancelled:true});
  await h.restart();error(await h.ask(secondTurn),'LOOKUP_EXPIRED');
  assert.deepEqual(success(await h.send('grammar.cancel',{requestId:secondRequest})),{cancelled:false});
  assert.equal(h.calls.length,2);
});

test('current chat and cancel use session storage only; the prior release’s on-disk book transcript remains byte-for-byte readable',async t=>{
  const h=await harness(t),storage=await openReaderStorage({indexedDB:h.indexedDB});
  try{
    const book=await storage.saveBook({kind:'pdf',title:'Archive',blob:new Blob(['offline test book']),mimeType:'application/pdf'});
    const turnId=crypto.randomUUID(),key='book-chat-v1:'+book.documentId;
    const oldTurn={kind:'answer' as const,turnId,question:'Старый вопрос',answer:'Полный ответ прошлой версии',language:'ru' as const};
    const head={generation:crypto.randomUUID(),entries:[{id:turnId,units:oldTurn.question.length+oldTurn.answer.length}]};
    await storage.setMetadata(key,head);await storage.setMetadata(key+':'+turnId,oldTurn);
    const before=JSON.stringify([head,oldTurn]);
    const id=await h.lookup(),current=turn(id,'Почему не Past Simple?');
    const reply=answered(await h.ask(current));await h.restart();
    assert.deepEqual(answered(await h.ask(current)),reply);
    error(await h.send('grammar.chat',{...current,bookChatGeneration:head.generation}),'INVALID_INPUT');
    assert.deepEqual(success(await h.send('grammar.chat.close',{grammarId:id})),{closed:true});
    await h.restart();error(await h.ask(current),'LOOKUP_EXPIRED');
    assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].history,[]);
    assert.ok(!JSON.stringify(h.calls).includes(oldTurn.question));
    const raw=await new Promise<IDBDatabase>((resolve,reject)=>{const req=h.indexedDB.open(storage.databaseName);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const rows=await new Promise<{key:string;value:unknown}[]>((resolve,reject)=>{const r=raw.transaction('metadata').objectStore('metadata').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});raw.close();
    assert.deepEqual(rows.filter(row=>row.key.startsWith('book-chat-v1:')).map(row=>row.key).sort(),[key,key+':'+turnId].sort());
    assert.equal(JSON.stringify([await storage.getMetadata(key),await storage.getMetadata(key+':'+turnId)]),before);
    for(const durable of [rows,await h.local.get(),await h.sessionValues()])assert.ok(!JSON.stringify(durable).includes(current.question));
    assert.deepEqual((await storage.bookChatHistory(book.documentId).read()).turns,[oldTurn]);
  }finally{storage.close();}
});


test('two cards opened on the same sentence during one in-flight analysis only authorize the newest and share one analysis POST',async t=>{
  const h=await harness(t),gate=h.holdLookup();
  const p:GrammarLookupPayload={sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',learnerLevel:'B1',includeExplanation:false};
  const opening=crypto.randomUUID(),newest=crypto.randomUUID();
  const old=h.send('grammar.lookup',p,reader,opening);
  await gate.began.promise;
  try{
    const saved=h.checkpoint();
    const current=h.send('grammar.lookup',p,reader,newest);
    // The service reserves the new capability before unblocking the first HTTP
    // response. A duplicate delivery is not a substitute for an actual new card.
    let reserved=false;void saved.then(()=>{reserved=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.ok(reserved,'A new opening must reserve its own chat before the in-flight analysis finishes');
    gate.release.resolve();
    error(await old,'REQUEST_CANCELLED');
    const b=success<{grammarId:string}>(await current).grammarId;
    assert.deepEqual(h.lookups,[sentence]);
    assert.deepEqual(success(await h.send('grammar.cancel',{requestId:opening})),{cancelled:false});
    answered(await h.ask(turn(b,'Почему не Past Simple?')));assert.deepEqual(h.calls[0].history,[]);
  }finally{gate.release.resolve();}
});


test('open cards in separate tabs retain independent conversations across concurrent sends, worker recreation and closing only tab B',async t=>{
  const h=await harness(t);
  async function dispatchAndHold(input:ReturnType<typeof turn>,sender:Sender){
    const gate=h.hold(),reply=h.ask(input,sender);
    t.after(()=>gate.release.resolve());
    await Promise.race([gate.began.promise,reply.then(outcome=>assert.fail('Expected a pending provider request: '+JSON.stringify(outcome)))]);
    return {reply,release:gate.release.resolve};
  }
  const pair=(input:ReturnType<typeof turn>,reply:{answer:string})=>({question:input.question,answer:reply.answer});

  const cardA=await h.lookup(sentence,reader);
  const a1=turn(cardA,'Почему не Past Simple?',sentence,1);
  const a1Result=answered(await h.ask(a1,reader));
  const cardB=await h.lookup(sentence,other);
  assert.notEqual(cardA,cardB);
  assert.deepEqual(h.lookups,[sentence],'the same cached analysis may serve both cards');

  const b1=turn(cardB,'Зачем перед read стоит to?',sentence,1);
  // A reused client turn ID cannot link two independent cards or merge their replies.
  const a2={...turn(cardA,'Какую роль здесь играет слово leisure?',sentence,2),turnId:b1.turnId};
  const pendingB=await dispatchAndHold(b1,other);
  const pendingA=await dispatchAndHold(a2,reader);
  assert.deepEqual(h.calls.map(r=>({question:r.question,history:r.history})),[
    {question:a1.question,history:[]},
    {question:b1.question,history:[]},
    {question:a2.question,history:[pair(a1,a1Result)]},
  ]);
  pendingA.release();const a2Result=answered(await pendingA.reply);
  pendingB.release();const b1Result=answered(await pendingB.reply);
  assert.equal(a2Result.grammarId,cardA);assert.equal(b1Result.grammarId,cardB);
  assert.match(a2Result.answer,/leisure/);assert.match(b1Result.answer,/to read/);

  await h.restart(true);
  const [replayA,replayB]=await Promise.all([h.ask(a2,reader),h.ask(b1,other)]);
  assert.deepEqual(answered(replayA),a2Result);assert.deepEqual(answered(replayB),b1Result);
  error(await h.ask(a2,other),'PERMISSION_DENIED');
  error(await h.ask(b1,reader),'PERMISSION_DENIED');
  assert.equal(h.calls.length,3,'rehydration, redelivery and foreign requests cost no POST');

  const b2=turn(cardB,'Почему не Past Simple?',sentence,2);
  const a3=turn(cardA,'What is the subject of longed?',sentence,3);
  const closingB=await dispatchAndHold(b2,other);
  const continuingA=await dispatchAndHold(a3,reader);
  assert.deepEqual(h.calls[3].history,[pair(b1,b1Result)]);
  assert.deepEqual(h.calls[4].history,[pair(a1,a1Result),pair(a2,a2Result)]);
  await h.closeTab(other.tab.id);
  error(await closingB.reply,'REQUEST_CANCELLED');
  closingB.release();continuingA.release();const a3Result=answered(await continuingA.reply);
  assert.equal(a3Result.grammarId,cardA);assert.match(a3Result.answer,/longed/);

  await h.restart(true);
  error(await h.ask(b1,other),'LOOKUP_EXPIRED');error(await h.ask(b2,other),'LOOKUP_EXPIRED');
  assert.deepEqual(answered(await h.ask(a3,reader)),a3Result);assert.equal(h.calls.length,5);
  const a4=turn(cardA,'А почему после of стоит writing?',sentence,4);
  answered(await h.ask(a4,reader));
  assert.deepEqual(h.calls[5].history,[pair(a1,a1Result),pair(a2,a2Result),pair(a3,a3Result)]);
  assert.equal(h.calls.length,6);assert.deepEqual(h.lookups,[sentence]);
});
