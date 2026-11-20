import {GRAMMAR_ANSWER_LIMIT} from '../../contracts/src/grammar-chat-limits.ts';
import {abortable,OpenAIServiceError,providerError} from './openai.ts';

// A UTF-16 unit may occupy six JSON escape bytes and another backslash when
// that JSON is embedded in a Responses output_text string. Keep envelope room.
export const CHAT_RESPONSE_BYTES=7*GRAMMAR_ANSWER_LIMIT+128*1024;
const wireBudget=CHAT_RESPONSE_BYTES*5;
const invalid=(reason:'response_json'|'response_shape'|'response_too_large')=>
 new OpenAIServiceError('INVALID_MODEL_OUTPUT',false,{stage:'response',reason});

export function interruptedChatResponse():OpenAIServiceError {
 return new OpenAIServiceError('INTERNAL_ERROR',true,{stage:'response',reason:'response_interrupted'});
}

/** Deltas are provisional. Publish only the terminal Responses object, whose
 * status, refusal, usage and single structured message are verified by the caller. */
export async function readChatStream(response:Response,signal:AbortSignal):Promise<unknown>{
 if(!response.body)throw invalid('response_shape');
 if(Number(response.headers.get('content-length'))>wireBudget)throw invalid('response_too_large');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let bytes=0,eventUnits=0,eventType='',lineUnits=0,skipLF=false;
 let fragments:string[]=[],data:string[]=[];
 const terminal=new Set(['response.completed','response.failed','response.incomplete','error']);
 const finishEvent=()=>{
  const name=eventType;
  eventType='';eventUnits=0;
  const lines=data;data=[];
  if(!lines.length || name&&!terminal.has(name))return;
  const text=lines.join('\n');
  if(text==='[DONE]')return;
  let value;try{value=JSON.parse(text);}catch{throw invalid('response_json');}
  if(!value||typeof value!=='object'||typeof value.type!=='string'||name&&name!==value.type)throw invalid('response_shape');
  if(!terminal.has(value.type))return;
  if(value.type==='error')throw providerError(null,{error:value.error??value});
  const status=value.type.slice('response.'.length);
  if(value.response?.status!==status)throw invalid('response_shape');
  return value.response as object;
 };
 const line=(text:string)=>{
  if(!text.length)return finishEvent();
  if(text.startsWith('event:'))eventType=text.slice(6).trim();
  if(text.startsWith('data:')){
   const value=text.slice(text[5]===' '?6:5);
   eventUnits+=value.length;if(eventUnits>CHAT_RESPONSE_BYTES)throw invalid('response_too_large');
   data.push(value);
  }
 };
 const feed=(chunk:string)=>{
  let start=0;
  for(let i=0;i<chunk.length;i++){
   const char=chunk.charCodeAt(i);
   if(skipLF){skipLF=false;if(char===10){start=i+1;continue;}}
   if(char!==10&&char!==13)continue;
   const suffix=chunk.slice(start,i);lineUnits+=suffix.length;
   if(lineUnits>CHAT_RESPONSE_BYTES)throw invalid('response_too_large');
   fragments.push(suffix);const result=line(fragments.join(''));fragments=[];lineUnits=0;
   if(result)return result;
   skipLF=char===13;start=i+1;
  }
  if(start<chunk.length){
   const rest=chunk.slice(start);lineUnits+=rest.length;
   if(lineUnits>CHAT_RESPONSE_BYTES)throw invalid('response_too_large');
   fragments.push(rest);
  }
 };
 const decode=(part?:Uint8Array<ArrayBufferLike>)=>{
  try{return part?decoder.decode(part,{stream:true}):decoder.decode();}
  catch{throw invalid('response_json');}
 };
 try{
  while(true){
   const part=await abortable(reader.read(),signal);
   if(part.done)break;
   bytes+=part.value.byteLength;if(bytes>wireBudget)throw invalid('response_too_large');
   const result=feed(decode(part.value));if(result)return result;
  }
  const result=feed(decode());
  if(result)return result;
  throw interruptedChatResponse();
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
