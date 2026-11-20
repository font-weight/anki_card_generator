import {splitLanguageTopicReset} from '../../../../packages/contracts/src/language-topic.ts';
import type {SecretStorageArea} from '../../../../packages/services/src/secrets';
import {MAX_CHAT_OWNERS,type ChatSnapshot,type GrammarChatStore} from '../../../../packages/services/src/grammar-chat-store.ts';

const key='grammarChatSessionsV1';
const itemKey=(id:string)=>'grammarChatOwner:'+id;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>!!v&&typeof v==='object'&&!Array.isArray(v);

function historyReference(turn:string,pair:ChatSnapshot['history'][number],originalQuestion:string){
 return {turn,...(pair.scope?{scope:pair.scope}:{}),...(pair.topicStart?{topicStart:true}:{}),
  ...(pair.question!==originalQuestion?{question:pair.question}:{})};
}
const matchesQuestion=(stored:string,question:string)=>stored===question||splitLanguageTopicReset(stored)?.task===question;
function compact(session:ChatSnapshot){
 const history=session.history.map(pair=>{
  const turn=session.turns.find(t=>matchesQuestion(t.question,pair.question)&&t.outcome&&'reply' in t.outcome&&t.outcome.reply.kind==='answer'&&t.outcome.reply.answer===pair.answer);
  return turn?historyReference(turn.id,pair,turn.question):pair;
 });
 return {...session,history};
}
function expand(raw:unknown){
 if(!object(raw)||!Array.isArray(raw.history)||!Array.isArray(raw.turns))return raw;
 const turns=raw.turns;
 return {...raw,history:raw.history.map((p:unknown)=>{
  if(!object(p)||!uuid(p.turn))return p;
  const t=turns.find(t=>object(t)&&t.id===p.turn);
  if(!t||!object(t.outcome)||!object(t.outcome.reply)||t.outcome.reply.kind!=='answer')return null;
  if(p.question!==undefined&&(typeof t.question!=='string'||typeof p.question!=='string'||!matchesQuestion(t.question,p.question)))return null;
  return {question:p.question??t.question,answer:t.outcome.reply.answer,...(p.scope?{scope:p.scope}:{}),
   ...(p.topicStart!==undefined?{topicStart:p.topicStart}:{})};
 })};
}
/** Each verified reader owns its own temporary record. Previously shipped V1
 * snapshots are migrated atomically on the next write. No unrelated keys are read. */
export function createGrammarChatStore(area:Pick<SecretStorageArea,'get'|'set'|'remove'>):GrammarChatStore{
 let ids:string[]=[];
 const saved=new Map<string,string>();
 return {
  async read(){
   const manifest=(await area.get(key))[key];
   if(!object(manifest)||manifest.version!==2)return manifest;
   if(!Array.isArray(manifest.ids)||manifest.ids.length>MAX_CHAT_OWNERS||!manifest.ids.every(uuid))return;
   ids=manifest.ids;
   const entries=ids.length?await area.get(ids.map(itemKey)):{};
   return {version:1,sessions:ids.flatMap(id=>{
    const entry=entries[itemKey(id)];if(!object(entry)||entry.id!==id)return [];
    saved.set(id,JSON.stringify(entry));return [expand(entry)];
   })};
  },
  async write(snapshot){
   const next=snapshot.sessions.map(s=>s.id),keep=new Set(next);
   const removed=ids.filter(id=>!keep.has(id));
   // Removing a revoked record first ensures it cannot be recovered even if a
   // subsequent large write fails to fit. Other open readers retain their data.
   if(removed.length){await area.remove(removed.map(itemKey));for(const id of removed)saved.delete(id);}
   const changes:RecordValue={},serialized=new Map<string,string>();
   for(const s of snapshot.sessions){
    const entry=compact(s),encoded=JSON.stringify(entry);
    if(saved.get(s.id)!==encoded){changes[itemKey(s.id)]=entry;serialized.set(s.id,encoded);}
   }
   changes[key]={version:2,ids:next};
   try{await area.set(changes);}
   catch(error){
    if(!/quota|too large|exceed/i.test(String(error)))throw error;
    // Keep the manifest, all other owners and the exact paid-turn identities.
    // Release older replay text first; a fresh full answer gets the available space.
    const lean={...changes};
    for(const s of snapshot.sessions)if(serialized.has(s.id)){
     const recent=s.turns.at(-1);
     const pair=s.history.at(-1);
     const history=pair&&recent&&matchesQuestion(recent.question,pair.question)&&recent.outcome&&'reply' in recent.outcome&&recent.outcome.reply.kind==='answer'?
      [historyReference(recent.id,pair,recent.question)]:[];
     lean[itemKey(s.id)]={...s,history,turns:s.turns.map(t=>
      t!==recent&&t.outcome&&'reply' in t.outcome&&t.outcome.reply.kind==='answer'?{...t,outcome:{error:'REQUEST_CANCELLED'}}:t)};
    }
    try{await area.set(lean);}
    catch(retryError){
     if(!/quota|too large|exceed/i.test(String(retryError)))throw retryError;
     // The completed response still goes to the requesting UI; across worker
     // restarts this marker can never cause the paid call to execute again.
     for(const s of snapshot.sessions)if(serialized.has(s.id)){
      const item=lean[itemKey(s.id)] as ChatSnapshot;
      item.history=[];item.turns=item.turns.map(t=>t.outcome&&'reply' in t.outcome&&t.outcome.reply.kind==='answer'?{...t,outcome:{error:'REQUEST_CANCELLED'}}:t);
     }
     await area.set(lean);
    }
   }
   ids=next;for(const [id,value] of serialized)saved.set(id,value);
  },
 };
}
