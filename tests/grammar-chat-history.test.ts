import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GrammarChatSessions} from '../packages/services/src/grammar-chat-sessions.ts';
import {MAX_CHAT_OWNERS,RECENT_CHAT_TURNS,restoreChatSnapshots} from '../packages/services/src/grammar-chat-store.ts';
import type {ChatSnapshot,GrammarChatStore} from '../packages/services/src/grammar-chat-store.ts';
import type {GrammarService} from '../packages/services/src/grammar.ts';
import type {GrammarLookupData,GrammarLookupPayload} from '../packages/contracts/src/grammar.ts';

const sentence='Mara had dreamed of the coast.';
const input:GrammarLookupPayload={sentence,sourceLanguage:'en',targetLanguage:'ru',explanationLanguage:'ru',includeExplanation:false,learnerLevel:'B1'};
const analysis:GrammarLookupData={sentence,grammarId:crypto.randomUUID(),construction:{text:'had dreamed',targetStart:5,targetEnd:16},question:'Какая форма стоит в тексте?',answer:'Действие предшествует другому моменту.',rule:'Форма had dreamed ставит действие раньше прошлого момента.',translation:'Мара мечтала о побережье.',explanation:null};
const owner=(tab=1,doc='current',frame=0)=>JSON.stringify(['reader',tab,doc,frame,9]);

function provider(){
 const inputs:{question:string;prior:string[];rule:string}[]=[];
 const service:Pick<GrammarService,'chat'>={
  async chat(context,history,question){
   inputs.push({question,prior:history.map(x=>x.question),rule:context.analysis.rule});
   const data=question==='unrelated'?{kind:'out_of_scope' as const}:{kind:'answer' as const,answer:'had dreamed',anchor:'had dreamed',evidence:'had dreamed'};
   return {data,model:'gpt-6-luna',reasoningEffort:'none',resolvedModel:null,usage:null,responseId:null,cacheHit:false,warnings:[]};
  }
 };
 return {service,inputs};
}
function memory(){
 let value:unknown;
 const store:GrammarChatStore={read:async()=>structuredClone(value),write:async data=>{value=structuredClone(data);}};
 return {store,entries:()=>restoreChatSnapshots(value)};
}
async function verified(sessions:GrammarChatSessions,tab=1,doc='current',frame=0){
 await sessions.ready();
 const key=owner(tab,doc,frame),id=sessions.begin(key,input,tab,true);
 sessions.accept(key,id,analysis);await sessions.flushed();return id;
}
function question(grammarId:string,number=1,word='question '+number){
 return {grammarId,turnId:crypto.randomUUID(),turnNumber:number,question:word,sentence};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};}

test('long lessons retain five accepted pairs and a bounded replay ledger after restart',async()=>{
 const {service,inputs}=provider(),m=memory();
 let sessions=new GrammarChatSessions(service,m.store);
 const id=await verified(sessions),send=(p:ReturnType<typeof question>)=>sessions.ask(owner(),p,crypto.randomUUID());
 const first=question(id,1),firstReply=await send(first),accepted=[first.question];let last=first;
 assert.deepEqual(await send(first),firstReply);assert.equal(inputs.length,1);
 for(let n=2;n<=65;n++){
  last=question(id,n,n%6===0?'unrelated':'question '+n);const reply=await send(last);
  assert.deepEqual(inputs.at(-1)?.prior,accepted.slice(-5));assert.equal(inputs.at(-1)?.rule,analysis.rule);
  if(reply.kind==='answer')accepted.push(last.question);
 }
 const [snapshot]=m.entries();assert.equal(snapshot.highest,65);assert.equal(snapshot.turns.length,RECENT_CHAT_TURNS);
 assert.equal(snapshot.history.length,5);assert.ok(snapshot.numberRequired);
 sessions.dispose();sessions=new GrammarChatSessions(service,m.store);await sessions.ready();
 assert.equal((await send(last)).kind,'answer');assert.throws(()=>send(first),{code:'REQUEST_CANCELLED'});
 assert.throws(()=>sessions.ask(owner(),{...first,turnNumber:undefined},crypto.randomUUID()),{code:'REQUEST_CANCELLED'});
 assert.equal(inputs.length,65);assert.equal((await send(question(id,66))).kind,'answer');
});

test('removes superseded documents in the same tab and frame, and bounds verified owners',async()=>{
 const {service}=provider(),m=memory(),sessions=new GrammarChatSessions(service,m.store);
 const old=await verified(sessions),otherFrame=await verified(sessions,1,'embedded',1);
 const newer=await verified(sessions,1,'new');
 assert.throws(()=>sessions.ask(owner(),question(old),crypto.randomUUID()),{code:'LOOKUP_EXPIRED'});
 assert.equal((await sessions.ask(owner(1,'embedded',1),question(otherFrame),crypto.randomUUID())).kind,'answer');
 assert.equal(sessions.close(owner(),old),false);
 assert.deepEqual(new Set(m.entries().map(x=>x.id)),new Set([otherFrame,newer]));
 for(let tab=2;tab<=MAX_CHAT_OWNERS+2;tab++)await verified(sessions,tab);
 const entries=m.entries();
 assert.equal(entries.length,MAX_CHAT_OWNERS);assert.ok(entries.every(x=>x.tabId>=3));
});

test('close during the pending storage write prevents dispatch and is durable after that write',async()=>{
 const {service,inputs}=provider(),m=memory(),started=deferred(),release=deferred();
 const store:GrammarChatStore={read:m.store.read,async write(raw){
  const turn=(raw as {sessions:ChatSnapshot[]}).sessions[0]?.turns[0];
  if(turn?.outcome===null){started.resolve();await release.promise;}
  await m.store.write(raw);
 }};
 const sessions=new GrammarChatSessions(service,store),id=await verified(sessions),p=question(id);
 const asked=sessions.ask(owner(),p,crypto.randomUUID());await started.promise;
 assert.ok(sessions.close(owner(),id));release.resolve();
 await assert.rejects(asked,{code:'REQUEST_CANCELLED'});await sessions.flushed();
 assert.equal(inputs.length,0);assert.deepEqual(m.entries(),[]);
 const restored=new GrammarChatSessions(service,store);await restored.ready();
 assert.throws(()=>restored.ask(owner(),p,crypto.randomUUID()),{code:'LOOKUP_EXPIRED'});
});

test('a failed pending checkpoint costs no request, and damaged or unverified snapshots cannot restore a capability',async()=>{
 const {service,inputs}=provider(),m=memory();
 let refuse=false;
 const store:GrammarChatStore={read:m.store.read,async write(raw){
  if(refuse){refuse=false;throw Error('storage unavailable');}
  await m.store.write(raw);
 }};
 const sessions=new GrammarChatSessions(service,store),id=await verified(sessions);
 refuse=true;const p=question(id);
 await assert.rejects(sessions.ask(owner(),p,crypto.randomUUID()),{code:'STORAGE_UNAVAILABLE'});
 await assert.rejects(sessions.ask(owner(),p,crypto.randomUUID()),{code:'STORAGE_UNAVAILABLE'});
 assert.equal(inputs.length,0);assert.equal((await sessions.ask(owner(),question(id,2),crypto.randomUUID())).kind,'answer');
 const [original]=m.entries();
 for(const damaged of [{...original,owner:'{}'},{...original,input:{...original.input,sentence:'Another sentence.'}},
     {...original,history:[{question:'q',answer:'unsafe\u0000history'}]},{...original,analysis:{grammarId:id,sentence,reason:'no_finding'}},
     {...original,turns:[...original.turns,original.turns[0]]}]){
  assert.deepEqual(restoreChatSnapshots({version:1,sessions:[damaged]}),[]);
 }
 assert.deepEqual(restoreChatSnapshots({version:1,sessions:[original,original]}),[]);
});


test('distinct simultaneous card openings for the same text do not share authorization; only an identical request may be delivered twice',async()=>{
 const {service,inputs}=provider(),m=memory(),sessions=new GrammarChatSessions(service,m.store);
 await sessions.ready();
 const firstRequest=crypto.randomUUID(),nextRequest=crypto.randomUUID();
 const a=sessions.begin(owner(),input,1,true,firstRequest);
 assert.equal(sessions.begin(owner(),input,1,true,firstRequest),a);
 assert.throws(()=>sessions.begin(owner(),{...input,includeExplanation:true},1,true,firstRequest),{code:'OPERATION_CONFLICT'});
 const b=sessions.begin(owner(),input,1,true,nextRequest);
 assert.notEqual(b,a);assert.throws(()=>sessions.accept(owner(),a,analysis),{code:'REQUEST_CANCELLED'});
 sessions.accept(owner(),b,analysis);await sessions.flushed();
 assert.equal(sessions.close(owner(),a),false);
 assert.equal(sessions.closeLookup(owner(),firstRequest),false);
 assert.throws(()=>sessions.ask(owner(),question(a),crypto.randomUUID()),{code:'LOOKUP_EXPIRED'});
 await sessions.ask(owner(),question(b),crypto.randomUUID());assert.deepEqual(inputs[0].prior,[]);
 assert.equal(sessions.closeLookup(owner(),nextRequest),true);await sessions.flushed();assert.deepEqual(m.entries(),[]);
});
