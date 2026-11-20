import {isLanguageChatText} from '../../contracts/src/language-chat-text.ts';
import type {GrammarQuestionTurn} from '../../contracts/src/grammar-question.ts';
import {GRAMMAR_CHAT_HISTORY_TURNS,GRAMMAR_CHAT_HISTORY_UNITS} from '../../contracts/src/grammar-chat-limits.ts';
import {ERROR_CODES,validateData,validateRequest,readLookupDiagnostics} from '../../contracts/src/index.ts';
import type {ErrorCode,LookupDiagnostics,GrammarChatReply,GrammarLookupData,GrammarLookupPayload} from '../../contracts/src/index.ts';
import {validateGrammarLookupData,validateGrammarLookupPayload} from '../../contracts/src/grammar.ts';
import {GRAMMAR_ANSWER_LIMIT,GRAMMAR_QUESTION_LIMIT} from '../../contracts/src/grammar-question.ts';

export interface GrammarChatStore {read():Promise<unknown>;write(snapshot:{version:1;sessions:ChatSnapshot[]}):Promise<void>}
export const MAX_CHAT_OWNERS=32, RECENT_CHAT_TURNS=16, CHAT_HISTORY_SIZE=GRAMMAR_CHAT_HISTORY_TURNS, RETIRED_IDS=32;
export type StoredTurn={id:string;number:number;question:string;outcome:null|{reply:GrammarChatReply}|{error:ErrorCode;diagnostics?:LookupDiagnostics;retryable?:boolean}};
export type ChatSnapshot={
 owner:string;tabId:number;id:string;input:GrammarLookupPayload;analysis:GrammarLookupData;
 history:GrammarQuestionTurn[];lookupRequestId?:string;highest:number;retired:string[];numberRequired:boolean;turns:StoredTurn[];
};
// Only the history sent back as context is shortened; the returned message and
// most recent replay value retain the complete validated provider answer.
export function boundedChatHistory(pairs:readonly GrammarQuestionTurn[]):GrammarQuestionTurn[]{
 const history:GrammarQuestionTurn[]=[];let left=GRAMMAR_CHAT_HISTORY_UNITS;
 for(const pair of pairs.slice(-CHAT_HISTORY_SIZE).reverse()){
  if(pair.question.length+pair.answer.length<=left){
   history.unshift(pair);left-=pair.question.length+pair.answer.length;continue;
  }
  if(!history.length){
   let end=left-pair.question.length-1;
   if(/[\uD800-\uDBFF]/u.test(pair.answer.charAt(end-1)))end--;
   history.unshift({...pair,answer:pair.answer.slice(0,end)+'…'});
  }
  break;
 }
 return history;
}
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const uint=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&x.length<=max&&isLanguageChatText(x);
function snapshot(raw:unknown):ChatSnapshot|undefined {
 if(!record(raw)||!uuid(raw.id)||!uint(raw.tabId)||typeof raw.owner!=='string'||raw.owner.length>650||!uint(raw.highest)||
    raw.lookupRequestId!==undefined&&!uuid(raw.lookupRequestId)||
    !Array.isArray(raw.history)||raw.history.length>CHAT_HISTORY_SIZE||!Array.isArray(raw.turns)||raw.turns.length>RECENT_CHAT_TURNS||
    !Array.isArray(raw.retired)||raw.retired.length>RETIRED_IDS||!raw.retired.every(uuid)||typeof raw.numberRequired!=='boolean')return;
 const identity:unknown=JSON.parse(raw.owner);
 if(!Array.isArray(identity)||identity.length!==5||typeof identity[0]!=='string'||identity[1]!==raw.tabId||
    typeof identity[2]!=='string'||!identity[2].length||identity[2].length>128||!uint(identity[3])||
    !(identity[4]===null||uint(identity[4])))return;
 const input=validateGrammarLookupPayload(raw.input),analysis=validateGrammarLookupData(raw.analysis,input);
 if(analysis.grammarId!==raw.id||'reason' in analysis)return;
 const history=[];
 for(const pair of raw.history){
  if(!record(pair)||!text(pair.question,GRAMMAR_QUESTION_LIMIT)||!text(pair.answer,GRAMMAR_ANSWER_LIMIT))return;
  if(pair.scope!==undefined&&pair.scope!=='sentence'&&pair.scope!=='language')return;
  if(pair.topicStart!==undefined&&(pair.scope!=='language'||pair.topicStart!==true))return;
  history.push({question:pair.question,answer:pair.answer,...(pair.scope==='language'?{scope:'language' as const}:{}),
   ...(pair.topicStart===true?{topicStart:true as const}:{})});
 }
 const turns:StoredTurn[]=[],seen=new Set(raw.retired);let previous=0;
 if(seen.size!==raw.retired.length)return;
 for(const item of raw.turns){
  if(!record(item)||!uuid(item.id)||seen.has(item.id)||!uint(item.number)||item.number<=previous||item.number>raw.highest||
     !text(item.question,GRAMMAR_QUESTION_LIMIT))return;
  validateRequest({v:1,type:'grammar.chat',requestId:item.id,payload:{grammarId:raw.id,sentence:input.sentence,turnId:item.id,turnNumber:item.number,question:item.question}});
  seen.add(item.id);previous=item.number;
  let outcome:StoredTurn['outcome'];
  if(item.outcome===null)outcome={error:'REQUEST_CANCELLED'}; // An earlier worker may already have dispatched it.
  else if(record(item.outcome)&&Object.keys(item.outcome).length===1&&'reply' in item.outcome){
   const reply=validateData('grammar.chat',item.outcome.reply);
   if(reply.grammarId!==raw.id||reply.turnId!==item.id||reply.kind==='answer'&&!text(reply.answer,GRAMMAR_ANSWER_LIMIT))return;
   outcome={reply};
  }else if(record(item.outcome)&&ERROR_CODES.includes(item.outcome.error as ErrorCode)){
   const failed=item.outcome;
   if(Object.keys(failed).some(key=>!['error','diagnostics','retryable'].includes(key)) ||
      failed.retryable!==undefined && typeof failed.retryable!=='boolean')return;
   const diagnostics=readLookupDiagnostics(failed.diagnostics);
   if(failed.diagnostics!==undefined&&!diagnostics)return;
   outcome={error:failed.error as ErrorCode,...(diagnostics?{diagnostics}:{}),...(failed.retryable?{retryable:true}:{})};
  }else return;
  turns.push({id:item.id,number:item.number,question:item.question,outcome});
 }
 if(previous!==raw.highest || (raw.highest===0 && (raw.retired.length||raw.history.length||raw.numberRequired)))return;
 return {owner:raw.owner,tabId:raw.tabId,id:raw.id,input,analysis,history:boundedChatHistory(history),highest:raw.highest,retired:[...raw.retired],numberRequired:raw.numberRequired,turns,...(raw.lookupRequestId?{lookupRequestId:raw.lookupRequestId}:{})};
}
export function restoreChatSnapshots(raw:unknown):ChatSnapshot[] {
 if(!record(raw)||raw.version!==1||!Array.isArray(raw.sessions)||raw.sessions.length>MAX_CHAT_OWNERS)return [];
 const sessions:ChatSnapshot[]=[],owners=new Set<string>(),ids=new Set<string>();
 for(const value of raw.sessions){
  try{
   const entry=snapshot(value);
   if(entry){if(owners.has(entry.owner)||ids.has(entry.id))return [];owners.add(entry.owner);ids.add(entry.id);sessions.push(entry);}
  }catch{/* Discard damaged or incompatible data. A persisted analysis is checked again before use. */}
 }
 return sessions;
}
