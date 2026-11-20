import type {GrammarChatPayload,GrammarChatReply,GrammarLookupPayload,GrammarLookupResult,GrammarLookupData} from '../../contracts/src/index.ts';
import {validateGrammarLookupData} from '../../contracts/src/grammar.ts';
import {splitLanguageTopicReset} from '../../contracts/src/language-topic.ts';
import {abortable} from './openai.ts';
import type {GrammarService} from './grammar.ts';
import {ServiceError,safeError} from './errors.ts';
import {MAX_CHAT_OWNERS,RECENT_CHAT_TURNS,RETIRED_IDS,boundedChatHistory,restoreChatSnapshots} from './grammar-chat-store.ts';
import type {ChatSnapshot,GrammarChatStore,StoredTurn} from './grammar-chat-store.ts';

const cancelled=()=>new ServiceError('REQUEST_CANCELLED');
interface ActiveTurn {id:string;controller:AbortController;subscribers:Map<string,AbortController>;promise?:Promise<GrammarChatReply>}
interface Session {
 id:string;tabId?:number;persistable:boolean;input:GrammarLookupPayload;lookupRequestId?:string;analysis?:GrammarLookupData;
 history:ChatSnapshot['history'];turns:Map<string,StoredTurn>;highest:number;retired:string[];numberRequired:boolean;active?:ActiveTurn;
}
function retireOldest(s:Session){
 const id=s.turns.keys().next().value!;
 s.turns.delete(id);s.retired.push(id);
 if(s.retired.length>RETIRED_IDS){s.retired.shift();s.numberRequired=true;}
}
function boundReplay(s:Session){
 // One full fresh answer is always replayable. Limit older payloads per owner;
 // retired IDs and monotonically increasing turn numbers still prevent rebilling.
 const weight=(turn:StoredTurn)=>turn.question.length+(turn.outcome&&'reply' in turn.outcome&&turn.outcome.reply.kind==='answer'?turn.outcome.reply.answer.length:0);
 let size=0;for(const turn of s.turns.values())size+=weight(turn);
 while(s.turns.size>1&&size>96*1024){size-=weight(s.turns.values().next().value!);retireOldest(s);}
}
const inputKey=(p:GrammarLookupPayload)=>JSON.stringify([p.sentence,p.sourceLanguage,p.targetLanguage,p.explanationLanguage,p.learnerLevel,p.includeExplanation]);

/** One verified capability per live reader. Only the trusted browser-session store can restore it. */
export class GrammarChatSessions {
 #owners=new Map<string,Session>();
 #service:Pick<GrammarService,'chat'>;
 #store?:GrammarChatStore;
 #loading?:Promise<void>;
 #hydrated=false;
 #writing:Promise<void>=Promise.resolve();
 #disposed=false;
 constructor(service:Pick<GrammarService,'chat'>,store?:GrammarChatStore){this.#service=service;this.#store=store;}
 get hydrated():boolean{return !this.#store||this.#hydrated;}
 ready():Promise<void>{
  if(!this.#store)return Promise.resolve();
  return this.#loading??=this.#store.read().then(raw=>{
   if(this.#disposed)return;
   for(const s of restoreChatSnapshots(raw))this.#owners.set(s.owner,{...s,persistable:true,turns:new Map(s.turns.map(t=>[t.id,t]))});
   this.#hydrated=true;
  }).catch(()=>{this.#loading=undefined;throw new ServiceError('STORAGE_UNAVAILABLE');});
 }
 #persist():Promise<void>{
  if(!this.#store||this.#disposed)return Promise.resolve();
  const sessions:ChatSnapshot[]=[];
  for(const [owner,s] of this.#owners){
   if(!s.persistable||s.tabId===undefined||!s.analysis)continue;
   sessions.push({owner,id:s.id,tabId:s.tabId,input:s.input,analysis:s.analysis,history:s.history,turns:[...s.turns.values()],
    highest:s.highest,retired:s.retired,numberRequired:s.numberRequired,...(s.lookupRequestId?{lookupRequestId:s.lookupRequestId}:{})});
  }
  const payload=structuredClone({version:1 as const,sessions});
  this.#writing=this.#writing.catch(()=>{}).then(()=>this.#disposed?undefined:this.#store!.write(payload)).catch(()=>{throw new ServiceError('STORAGE_UNAVAILABLE');});
  void this.#writing.catch(()=>{});return this.#writing;
 }
 flushed():Promise<void>{return this.#writing;}
 #drop(owner:string){
  const s=this.#owners.get(owner);
  this.#owners.delete(owner);s?.active?.controller.abort(cancelled());
 }
 begin(owner:string,input:GrammarLookupPayload,tabId?:number,persistable=false,lookupRequestId?:string):string{
  const current=this.#owners.get(owner);
  // A cached or in-flight analysis may be shared, but each new card owns a chat.
  // Only another delivery of the same opening RPC belongs to the original card.
  if(current&&lookupRequestId&&current.lookupRequestId===lookupRequestId){
   if(inputKey(current.input)!==inputKey(input))throw new ServiceError('OPERATION_CONFLICT');
   return current.id;
  }
  if(current)this.#drop(owner);
  if(persistable){
   // A new verified reader in this tab/frame supersedes any document previously occupying it.
   const [, , ,frame]=JSON.parse(owner);
   for(const [previous,session] of this.#owners){
    if(session.persistable&&session.tabId===tabId&&JSON.parse(previous)[3]===frame)this.#drop(previous);
   }
  }
  if(this.#owners.size>=MAX_CHAT_OWNERS)this.#drop(this.#owners.keys().next().value!);
  const id=crypto.randomUUID();
  this.#owners.set(owner,{id,tabId,persistable,input:structuredClone(input),lookupRequestId,history:[],turns:new Map(),highest:0,retired:[],numberRequired:false});
  this.#persist();return id;
 }
 accept(owner:string,id:string,raw:GrammarLookupResult):GrammarLookupResult{
  const s=this.#owners.get(owner);if(!s||s.id!==id)throw cancelled();
  const result={...validateGrammarLookupData(raw,s.input),grammarId:id};
  if(!('reason' in result))s.analysis=structuredClone(result);
  this.#persist();return result;
 }
 close(owner:string,id:string):boolean{
  if(this.#owners.get(owner)?.id!==id)return false;
  this.#drop(owner);this.#persist();return true;
 }
 closeLookup(owner:string,requestId:string):boolean{
  const current=this.#owners.get(owner);
  return current?.lookupRequestId===requestId?this.close(owner,current.id):false;
 }
 clear(tabId?:number):void{
  for(const [owner,s] of this.#owners)if(tabId===undefined||s.tabId===tabId)this.#drop(owner);
  this.#persist();
 }
 /** A worker shutdown must leave the durable pending marker exactly as it was. */
 dispose():void{this.#disposed=true;for(const owner of this.#owners.keys())this.#drop(owner);}
 cancel(owner:string,requestId:string):boolean{
  const active=this.#owners.get(owner)?.active,subscriber=active?.subscribers.get(requestId);
  if(!active||!subscriber)return false;
  subscriber.abort(cancelled());active.subscribers.delete(requestId);
  if(!active.subscribers.size)active.controller.abort(cancelled());
  return true;
 }
 ask(owner:string,p:GrammarChatPayload,requestId:string,beforeDispatch?:()=>Promise<void>):Promise<GrammarChatReply>{
  const s=this.#owners.get(owner);
  if(!s||s.id!==p.grammarId){
   for(const other of this.#owners.values())if(other.id===p.grammarId)throw new ServiceError('PERMISSION_DENIED');
   throw new ServiceError('LOOKUP_EXPIRED');
  }
  if(!s.analysis)throw new ServiceError('LOOKUP_EXPIRED');
  if(s.input.sentence!==p.sentence)throw new ServiceError('INVALID_INPUT');
  let turn=s.turns.get(p.turnId);
  if(turn&&(turn.question!==p.question||p.turnNumber!==undefined&&p.turnNumber!==turn.number))throw new ServiceError('OPERATION_CONFLICT');
  if(!turn){
   if(s.retired.includes(p.turnId)||p.turnNumber!==undefined&&p.turnNumber<=s.highest||p.turnNumber===undefined&&s.numberRequired)throw cancelled();
   if(s.active)throw new ServiceError('OPERATION_CONFLICT');
   if(s.turns.size>=RECENT_CHAT_TURNS)retireOldest(s);
   const number=p.turnNumber??s.highest+1;if(!Number.isSafeInteger(number))throw new ServiceError('OPERATION_CONFLICT');
   // An explicit reset belongs to this new turn. Its boundary must survive a
   // refusal, interruption or restart, without applying again on redelivery.
   const reset=splitLanguageTopicReset(p.question);
   if(reset)s.history=[];
   s.highest=number;
   turn={id:p.turnId,number,question:p.question,outcome:null};s.turns.set(p.turnId,turn);boundReplay(s);
   const active:ActiveTurn={id:p.turnId,controller:new AbortController(),subscribers:new Map()};
   s.active=active;
   const claim=turn,context={input:s.input,analysis:s.analysis},signal=active.controller.signal;
   // The marker must be acknowledged before a billable provider call is possible.
   const checkpoint=this.#persist();
   active.promise=Promise.resolve().then(async():Promise<GrammarChatReply>=>{
    try{
     await abortable(checkpoint,signal);
     if(beforeDispatch)await abortable(beforeDispatch(),signal);
     signal.throwIfAborted();
     const result=await abortable(this.#service.chat(context,s.history.slice(),p.question,{signal}),signal);
     signal.throwIfAborted();
     const ids={grammarId:s.id,turnId:p.turnId};
     const reply:GrammarChatReply=result.data.kind==='answer'?{...ids,kind:'answer',answer:result.data.answer,...(result.data.source==='analysis'?{source:'analysis'}:{})}:{...ids,kind:result.data.kind};
     claim.outcome={reply};
     if(result.data.kind==='answer'){
      const language=result.data.scope==='language';
      const startsTopic=language&&result.data.topicStart===true;
      const pair={question:reset?.task||p.question,answer:result.data.answer,
       ...(language?{scope:'language' as const}:{}),...(startsTopic?{topicStart:true as const}:{})};
      s.history=boundedChatHistory(startsTopic?[pair]:[...s.history,pair]);boundReplay(s);
     }
     // The pending marker was durable before dispatch. If a large result will
     // not fit, deliver it now. Recovery of that marker can only be interrupted.
     await this.#persist().catch(()=>{});signal.throwIfAborted();
     return reply;
    }catch(error){
     if(this.#owners.get(owner)===s&&!this.#disposed){
      const {code,diagnostics,retryable}=safeError(error);
      claim.outcome={error:code,...(diagnostics?{diagnostics}:{}),...(retryable?{retryable:true}:{})};
      await this.#persist();
     }
     throw error;
    }
   }).finally(()=>{if(s.active===active)s.active=undefined;});
  }
  const active=s.active;
  if(!active||active.id!==p.turnId){
   const outcome=turn.outcome;if(!outcome)return Promise.reject(cancelled());
   if('error' in outcome)return Promise.reject(new ServiceError(outcome.error,undefined,outcome.retryable,outcome.diagnostics));
   return Promise.resolve(structuredClone(outcome.reply));
  }
  if(active.subscribers.size>=16&&!active.subscribers.has(requestId))throw new ServiceError('OPERATION_CONFLICT');
  const subscriber=active.subscribers.get(requestId)??new AbortController();
  active.subscribers.set(requestId,subscriber);
  return abortable(active.promise!,subscriber.signal).finally(()=>active.subscribers.delete(requestId));
 }
}
