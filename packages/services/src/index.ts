import {senseDefinition,localeMatchesLanguage,defaultLocale,ContractValidationError,DEFAULT_SETTINGS,PRIVILEGED_OPERATIONS,validateRequest,validateData,validateNoteDraft} from '../../contracts/src/index.ts';
import type {RpcRequest,RpcResponse,PublicSettings,SettingsPatch,NoteDraft,QueueItem,Meta,LookupPayload,OperationUpdatedEvent,PronunciationVariant,AddNotePayload} from '../../contracts/src/index.ts';
import type {ReaderStorage,LookupCacheEntry,StoredOperation,AudioEntry} from '../../storage/src/index.ts';
import {ISOLATED_TEST_DATABASE_NAME} from '../../storage/src/index.ts';
import {SecretVault} from './secrets.ts';
import {OpenAIService,abortable,validateLookupInput,validateModelLookup} from './openai.ts';
import type {LookupExecution,ModelExecution} from './openai.ts';
import {LookupCoordinator,lookupCacheKey} from './lookup.ts';
import {PROMPT_VERSION,MODEL_SCHEMA_VERSION,ENRICH_PROMPT_VERSION} from './prompts.ts';
import {AudioService,createAudioInputCacheKey,createDraftAudioSnapshot,validateAudioSnapshot,freezeAudioInput} from './audio.ts';
import type {AudioSnapshot,LocalAudioEntry,ExtensionAudioPlayback} from './audio.ts';
import {PronunciationService} from './pronunciation.ts';
import {AnkiClient} from './anki.ts';
import {DurableQueue} from './queue.ts';
import type {QueueRecord} from './queue.ts';
import {modelNamesFor,semanticKeys,canonicalJson,sha256,renderPreview} from '../../note-templates/src/index.ts';
import {ServiceError,safeError} from './errors.ts';
export {SecretVault,ServiceError,renderPreview};
export type RuntimeSender={id?:string;url?:string;origin?:string;documentId?:string;frameId?:number;tab?:{id?:number;url?:string}};
export type ConfirmationKind='dictionary'|'cloud_audio'|'initialize_models'|'create_deck'|'add_duplicate'|'paid_provider_test';
export interface ServiceDependencies {
 storage:ReaderStorage;
 /** Host-only opt-in, fixed port18765 and dedicated database; never an RPC setting. */
 isolatedAnkiTestMode?:true;
 secrets:SecretVault;
 fetch?:typeof globalThis.fetch;
 runtime:{extensionId:string;allowedPageUrls:readonly string[];isRegisteredReader:(sender:RuntimeSender)=>boolean};
 playback?:ExtensionAudioPlayback;
 confirmations?:{requireConsent:(kind:ConfirmationKind,context:{request:RpcRequest;sender:RuntimeSender})=>Promise<boolean>};
 onOperationUpdated?:(event:OperationUpdatedEvent)=>void|Promise<void>;
 scheduleQueueWake?:(timestamp:number|null)=>void|Promise<void>;
 now?:()=>number;
}
const FALLBACK_ID='00000000-0000-4000-8000-000000000000';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function safeRequestId(value:unknown){return value&&typeof value==='object'&&'requestId'in value&&typeof value.requestId==='string'&&UUID.test(value.requestId)?value.requestId:FALLBACK_ID;}
function queuePublic(r:QueueRecord):QueueItem{return {operationId:r.operationId,draft:r.draft,includeAudio:r.includeAudio,audioId:r.audioId,duplicateAction:r.duplicateAction,state:r.state,attempts:r.attempts,lastError:r.lastError,noteId:r.noteId,createdAt:r.createdAt,updatedAt:r.updatedAt,nextAttemptAt:r.nextAttemptAt};}
function executionMeta(result:ModelExecution<unknown>,promptVersion=PROMPT_VERSION):Meta{return {cacheHit:result.cacheHit,model:result.model,promptVersion,schemaVersion:'1',...result.usage?{usage:result.usage}:{}};}
function classify(sender:RuntimeSender,runtime:ServiceDependencies['runtime']):'page'|'reader'{
 if(sender.id!==runtime.extensionId||typeof sender.url!=='string')throw new ServiceError('PERMISSION_DENIED');
 let url:URL;try{url=new URL(sender.url);}catch{throw new ServiceError('PERMISSION_DENIED');}
 if(url.protocol==='chrome-extension:'&&url.hostname===runtime.extensionId){
  if(sender.frameId!==undefined&&sender.frameId!==0)throw new ServiceError('PERMISSION_DENIED');
  const canonical=`chrome-extension://${runtime.extensionId}${url.pathname}`;
  if(runtime.allowedPageUrls.includes(canonical)&&!url.username&&!url.password)return 'page';
  throw new ServiceError('PERMISSION_DENIED');
 }
 if(['http:','https:'].includes(url.protocol)&&Number.isInteger(sender.tab?.id)&&runtime.isRegisteredReader(sender))return 'reader';
 throw new ServiceError('PERMISSION_DENIED');
}
function scope(sender:RuntimeSender){return JSON.stringify([sender.id,sender.tab?.id??null,sender.documentId??null,sender.frameId??null,sender.documentId?null:sender.url]);}
/** Host owns runtime.onMessage, alarms and offscreen document. This factory registers no listeners. */
export function createReaderServices(deps:ServiceDependencies){
 const isolatedTestMode=deps.isolatedAnkiTestMode===true;
 const now=deps.now??Date.now, fetcher=deps.fetch??globalThis.fetch.bind(globalThis), storage=deps.storage;
 const scopes=new Map<string,Set<string>>();
 const activeRequests=new Map<string,{scope:string;requestId:string;lookupId?:string;controller:AbortController}>();
 // Bounded, disposable snapshots retain usable lookup results when IDB cache writes
 // fail. They contain only the already-approved short context, never books/queues.
 const recentLookups=new Map<string,LookupCacheEntry>();
 const rememberLookup=(entry:LookupCacheEntry)=>{
  const copy=structuredClone(entry);copy.lastAccessedAt=new Date(now()).toISOString();
  recentLookups.delete(copy.lookupId);recentLookups.set(copy.lookupId,copy);
  while(recentLookups.size>128){const oldest=recentLookups.keys().next().value!;recentLookups.delete(oldest);scopes.delete(oldest);}
 };
 const validateCacheEntry=async(entry:LookupCacheEntry,key?:string)=>{
  validateLookupInput(entry.request);validateData('lookup',entry.data);
  const {lookupId: _lookupId,expression: _expression,...content}=entry.data;
  validateModelLookup(content,entry.request);
  const model=entry.meta?.model;if(model!=='gpt-4.1-mini'&&model!=='gpt-4.1')throw new ServiceError('LOOKUP_EXPIRED');
  const expected=lookupCacheKey(entry.request,model);
  if(entry.lookupId!==entry.data.lookupId||entry.data.expression!==entry.request.expression||
    entry.key!==await sha256(expected)||(key!==undefined&&key!==expected))throw new ServiceError('LOOKUP_EXPIRED');
  return entry;
 };
 const cacheRequest=(key:string):LookupPayload=>{
  const p=JSON.parse(key) as unknown[];
  if(!Array.isArray(p)||p.length!==13||p[0]!==PROMPT_VERSION||p[1]!==MODEL_SCHEMA_VERSION||
    (p[2]!=='gpt-4.1-mini'&&p[2]!=='gpt-4.1'))throw new ServiceError('INVALID_INPUT');
  const request={expression:p[3],context:{sentence:p[4],targetStart:p[5],targetEnd:p[6],...(p[7]===null?{}:{before:p[7]}),...(p[8]===null?{}:{after:p[8]})},sourceLanguage:p[9],targetLanguage:p[10],learnerLevel:p[11],dialect:p[12]};
  validateLookupInput(request);if(lookupCacheKey(request,p[2])!==key)throw new ServiceError('INVALID_INPUT');
  return request;
 };
 const cacheEntry=async(request:LookupPayload,result:LookupExecution):Promise<LookupCacheEntry>=>({
  key:await sha256(lookupCacheKey(request,result.model)),lookupId:result.data.lookupId,
  request:structuredClone(request),data:structuredClone(result.data),meta:executionMeta(result),
  byteLength:0,createdAt:new Date(now()).toISOString(),lastAccessedAt:new Date(now()).toISOString()
 });
 const registerActive=(caller:string,requestId:string,lookupId?:string)=>{
  const token=crypto.randomUUID(),active={scope:caller,requestId,lookupId,controller:new AbortController()};
  activeRequests.set(token,active);return {token,...active};
 };
 let settings:PublicSettings={...DEFAULT_SETTINGS},initialized:Promise<void>|undefined,closed=false,settingsTail=Promise.resolve();
 type PreferencesRecovery={v:1;pending:boolean;blockedOperationIds:string[]};
 const recoveryMetadata='preferences-recovery-v1';
 let repairRequired=false,quarantinedOperations=new Set<string>();
 const validatePreferences=(patch:unknown)=>validateRequest({v:1,requestId:FALLBACK_ID,type:'settings.update',payload:{patch}});
 const readRecovery=(value:unknown):PreferencesRecovery|null=>{
  if(value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ServiceError('STORAGE_UNAVAILABLE');
  const r=value as Record<string,unknown>;
  if(r.v!==1||typeof r.pending!=='boolean'||!Array.isArray(r.blockedOperationIds)||!r.blockedOperationIds.every(id=>typeof id==='string'&&UUID.test(id))||Object.keys(r).some(key=>!['v','pending','blockedOperationIds'].includes(key)))throw new ServiceError('STORAGE_UNAVAILABLE');
  return {v:1,pending:r.pending,blockedOperationIds:[...new Set(r.blockedOperationIds as string[])]};
 };
 const init=()=>initialized??=(async()=>{
  if(isolatedTestMode?storage.databaseName!==ISOLATED_TEST_DATABASE_NAME:storage.databaseName===ISOLATED_TEST_DATABASE_NAME)throw new ServiceError('PERMISSION_DENIED');
  await deps.secrets.init();
  const saved=await storage.getMetadata<unknown>('preferences');
  let recovery=readRecovery(await storage.getMetadata<unknown>(recoveryMetadata));
  let accepted:SettingsPatch={},invalid=false;
  if(saved!==null){
   try{validatePreferences(saved);accepted=saved as SettingsPatch;}
   catch(error){
    if(!(error instanceof ContractValidationError))throw error;
    invalid=true;
    // Keep only independently validated preferences for a repair form, not an active Anki route.
    if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const key of ['sourceLanguage','targetLanguage','learnerLevel','dialect','dictionaryEnabled','cloudAudioEnabled','includeAudioByDefault','ankiEndpoint','audioSpeed','defaultDeck','defaultMode']){
     if(!Object.hasOwn(saved,key))continue;
     const field={[key]:(saved as Record<string,unknown>)[key]};
     try{validatePreferences(field);accepted={...accepted,...field};}catch(error){if(!(error instanceof ContractValidationError))throw error;}
    }
   }
  }
  if(invalid){
   // Commit the replay barrier before any repaired preferences can ever be persisted.
   const blockedOperationIds=[...new Set([...(recovery?.blockedOperationIds??[]),...(await storage.allOperations()).map(row=>row.operationId)])];
   recovery={v:1,pending:true,blockedOperationIds};
   await storage.setMetadata(recoveryMetadata,recovery);
  }
  settings={...DEFAULT_SETTINGS,...accepted};
  // Legacy preferences inherit explicit EN→RU/B1 defaults; no durable draft is migrated.
  if(!localeMatchesLanguage(settings.dialect,settings.sourceLanguage))settings.dialect=defaultLocale(settings.sourceLanguage);
  repairRequired=recovery?.pending??false;
  quarantinedOperations=new Set(recovery?.blockedOperationIds??[]);
 })().catch(error=>{initialized=undefined;throw error;});
 const assertAnkiConfigured=()=>{if(repairRequired)throw new ServiceError('OPERATION_CONFLICT');};
 const assertOperationAvailable=(id:string)=>{assertAnkiConfigured();if(quarantinedOperations.has(id))throw new ServiceError('OPERATION_CONFLICT');};
 // Quarantined intents cannot enter DurableQueue (including its network-capable paths).
 // Cancellation is a separate local CAS transition; it never removes the replay barrier.
 const cancelQuarantined=async(operationId:string):Promise<QueueRecord>=>{
  const conflict=()=>new ServiceError('OPERATION_CONFLICT');
  const canonicalTime=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  for(let attempt=0;attempt<3;attempt++){
   if(!quarantinedOperations.has(operationId))throw conflict();
   const record=await storage.getOperation(operationId) as unknown as QueueRecord|null;
   if(!record||record.operationId!==operationId)throw conflict();
   try{validateData('queue.cancel',{operation:queuePublic(record)});}catch{throw conflict();}
   const timestamp=now();
   if(!Number.isFinite(timestamp)||!Number.isSafeInteger(record.revision)||record.revision<0||record.revision>=Number.MAX_SAFE_INTEGER||
      !Number.isSafeInteger(record.automaticRetries)||record.automaticRetries<0||record.submissionUncertain!==false||record.noteId!==null||
      !['anki:loopback:8765','anki:isolated-test:18765'].includes(record.targetIdentity)||
      !canonicalTime(record.createdAt)||!canonicalTime(record.updatedAt)||Date.parse(record.updatedAt)<Date.parse(record.createdAt)||
      !['pending','ready','failed','awaiting_audio_decision','awaiting_duplicate_decision','cancelled'].includes(record.state))throw conflict();
   if(record.lease!==null){
    const lease=record.lease;
    if(!lease||typeof lease!=='object'||Array.isArray(lease)||Object.keys(lease).some(key=>!['owner','expiresAt'].includes(key))||
       typeof lease.owner!=='string'||!UUID.test(lease.owner)||!canonicalTime(lease.expiresAt)||Date.parse(lease.expiresAt)>timestamp)throw conflict();
   }
   if(record.state==='cancelled')return record;
   const updatedAt=new Date(timestamp).toISOString();
   if(Date.parse(updatedAt)<Date.parse(record.updatedAt))throw conflict();
   const next:QueueRecord={...record,state:'cancelled',revision:record.revision+1,updatedAt,nextAttemptAt:null,lease:null,lastError:null};
   if(await storage.compareAndSwap(operationId,record.revision,next as unknown as StoredOperation)){
    try{void Promise.resolve(deps.onOperationUpdated?.({v:1,type:'operation.updated',data:{operationId,state:'cancelled',noteId:null,error:null}})).catch(()=>{});}catch{/* Notification is not the durable state. */}
    return next;
   }
  }
  throw conflict();
 };
 const readSettings=async()=>{await init();const status=await deps.secrets.status();return {...settings,...isolatedTestMode?{ankiEndpoint:'http://127.0.0.1:18765' as const}:{},hasOpenAIKey:status.hasOpenAIKey,hasAnkiKey:isolatedTestMode?false:status.hasAnkiConnectKey,openAIKeyPersistence:status.openAIStorage??'session',ankiKeyPersistence:isolatedTestMode?'session':status.ankiConnectStorage??'session'} as PublicSettings;};
 const getAnki=()=>{assertAnkiConfigured();return new AnkiClient({endpoint:isolatedTestMode?undefined:settings.ankiEndpoint,isolatedTestMode:isolatedTestMode?true:undefined,fetch:fetcher,getApiKey:()=>isolatedTestMode?Promise.resolve(null):deps.secrets.getAnkiConnectKeyForService()});};
 const openai=new OpenAIService({fetch:fetcher,getApiKey:()=>deps.secrets.getOpenAIKeyForService()});
 const lookup=new LookupCoordinator(openai,{
  get:async key=>{
   const digest=await sha256(key);
   const e=[...recentLookups.values()].find(entry=>entry.key===digest)??await storage.getLookup(digest);
   if(!e)return undefined;await validateCacheEntry(e,key);rememberLookup(e);
   return {data:structuredClone(e.data),model:e.meta!.model!,resolvedModel:null,responseId:null,usage:null,cacheHit:true,warnings:e.data.ipaCandidate?['IPA_GENERATED_APPROXIMATE']:[]};
  },
  set:async(key,result)=>{const e=await cacheEntry(cacheRequest(key),result);rememberLookup(e);await storage.putLookup(e);}
 });
 const localAudio=async(e:AudioEntry|null):Promise<LocalAudioEntry|null>=>e?{audioId:e.audioId,cacheKey:e.cacheKey,bytes:new Uint8Array(await e.blob.arrayBuffer()),mimeType:'audio/mpeg',metadata:e.metadata,createdAt:e.createdAt,lastAccessedAt:e.lastAccessedAt}:null;
 const audio=new AudioService({fetch:fetcher,getOpenAIKey:()=>deps.secrets.getOpenAIKeyForService(),hasCloudAudioConsent:()=>settings.cloudAudioEnabled,cache:{getById:async id=>localAudio(await storage.getAudio(id)),getByCacheKey:async key=>localAudio(await storage.findAudio(key)),put:async e=>storage.putAudio({audioId:e.audioId,cacheKey:e.cacheKey,blob:new Blob([e.bytes as BlobPart],{type:'audio/mpeg'}),metadata:e.metadata,byteLength:e.bytes.byteLength,createdAt:e.createdAt,lastAccessedAt:e.lastAccessedAt})},playback:deps.playback,now:()=>new Date(now())});
 const pronunciation=new PronunciationService({fetch:fetcher,hasDictionaryConsent:()=>settings.dictionaryEnabled});
 const audioScopes=new Map<string,Set<string>>();
 const rememberAudio=(audioId:string,caller:string)=>{const owners=audioScopes.get(audioId)??new Set<string>();owners.add(caller);if(owners.size>32)owners.delete(owners.values().next().value!);audioScopes.delete(audioId);audioScopes.set(audioId,owners);if(audioScopes.size>512)audioScopes.delete(audioScopes.keys().next().value!);};
 const audioForDraft=async(draft:NoteDraft,audioId?:string):Promise<AudioSnapshot>=>{
  // Snapshot preferences now, not when queued work eventually resumes.
  const preferences={dialect:settings.dialect,speed:settings.audioSpeed};
  if(!audioId)return createDraftAudioSnapshot(draft,preferences);
  const entry=await storage.getAudio(audioId);
  if(!entry)throw new ServiceError('AUDIO_UNAVAILABLE');
  const snapshot=await createDraftAudioSnapshot(draft,{dialect:entry.metadata.dialect,speed:entry.metadata.speed});
  if(entry.cacheKey!==await createAudioInputCacheKey(snapshot))throw new ServiceError('AUDIO_UNAVAILABLE');
  return snapshot;
 };
 const queue=new DurableQueue({targetIdentity:isolatedTestMode?'anki:isolated-test:18765':'anki:loopback:8765',store:{
  create:async r=>{assertOperationAvailable(r.operationId);return storage.createOperation(r as unknown as StoredOperation) as unknown as Promise<{created:boolean;record:QueueRecord}>;},
  get:async id=>{assertOperationAvailable(id);return storage.getOperation(id) as unknown as Promise<QueueRecord|null>;},
  compareAndSwap:(id,rev,next)=>{assertOperationAvailable(id);return storage.compareAndSwap(id,rev,next as unknown as StoredOperation);},
  list:async()=>{assertAnkiConfigured();return (await storage.allOperations()).filter(row=>!quarantinedOperations.has(row.operationId)) as unknown as QueueRecord[];}
 },anki:{assertReady:d=>getAnki().assertReady(d),findOperation:(id,keys,mode,version)=>getAnki().findOperation(id,keys,mode,version),findDuplicates:(d,keys)=>getAnki().findDuplicates(d,keys),storeAudio:(id,bytes)=>getAnki().storeAudio(id,bytes),prepareNote:(id,d,k,f)=>getAnki().prepareNote(id,d,k,f),addPreparedNote:n=>getAnki().addPreparedNote(n)},audio:{snapshot:audioForDraft,prepare:async snapshot=>({audioId:(await audio.prepare(validateAudioSnapshot(snapshot))).metadata.audioId}),read:async(id,snapshot)=>{const frozen=validateAudioSnapshot(snapshot),entry=await storage.getAudio(id);if(!entry||entry.cacheKey!==await createAudioInputCacheKey(frozen))return null;return new Uint8Array(await entry.blob.arrayBuffer());}},now,onUpdated:async r=>deps.onOperationUpdated?.({v:1,type:'operation.updated',data:{operationId:r.operationId,state:r.state,noteId:r.noteId,error:r.lastError}}),scheduleWake:deps.scheduleQueueWake});
 const requireConsent=async(kind:ConfirmationKind,request:RpcRequest,sender:RuntimeSender)=>{if(!await deps.confirmations?.requireConsent(kind,{request,sender}))throw new ServiceError('PERMISSION_DENIED');};
 const savedLookup=async(id:string,caller:string,kind:'page'|'reader')=>{
  if(kind==='reader'&&!scopes.get(id)?.has(caller))throw new ServiceError('PERMISSION_DENIED');
  const record=recentLookups.get(id)??await storage.findLookup(id);
  if(!record||record.lookupId!==id)throw new ServiceError('LOOKUP_EXPIRED');
  try{await validateCacheEntry(record);}catch{throw new ServiceError('LOOKUP_EXPIRED');}
  rememberLookup(record);return structuredClone(record);
 };
 const validateProvenance=async(draft:NoteDraft)=>{validateNoteDraft(draft);if(draft.pronunciation.source==='dictionary'){const proof=await storage.getMetadata(`pronunciation:${await sha256(canonicalJson({sourceLanguage:draft.sourceLanguage,expression:draft.expression,pronunciation:draft.pronunciation}))}`);if(proof!==true){const legacy=draft.draftVersion===undefined&&draft.sourceLanguage==='en'&&draft.targetLanguage==='ru'?await storage.getMetadata(`pronunciation:${await sha256(canonicalJson({expression:draft.expression,pronunciation:draft.pronunciation}))}`):null;if(legacy!==true)throw new ServiceError('PERMISSION_DENIED');}}};
 async function handleMessage(value:unknown,sender:RuntimeSender):Promise<RpcResponse>{
  const requestId=safeRequestId(value);
  try{
   if(closed)throw new ServiceError('STORAGE_UNAVAILABLE');const kind=classify(sender,deps.runtime);const request=validateRequest(value);if(PRIVILEGED_OPERATIONS.has(request.type)&&kind!=='page')throw new ServiceError('PERMISSION_DENIED');
   if(request.type==='anki.addNote'){
    const payload=request.payload as AddNotePayload;
    // New v3 saves may only attach an already prepared preview. Enforce this
    // before even initializing storage; it is not a rule for durable recovery
    // or an explicit queue.resolveAudio retry, nor for legacy v1/v2 inputs.
    if(payload.draft.draftVersion===3&&payload.includeAudio&&!payload.audioId)return {
     v:1,requestId,ok:false,error:{code:'AUDIO_UNAVAILABLE',message:'Аудио ещё не подготовлено. Включите флажок аудио и дождитесь статуса «Аудио готово» либо снимите флажок, чтобы сохранить без аудио.',retryable:false}
    };
   }
   await init();if(closed)throw new ServiceError('STORAGE_UNAVAILABLE');
   const caller=scope(sender), p=request.payload as any;let data:unknown,warnings:string[]=[],meta:Meta|undefined;
   const ownLookup=()=>savedLookup(p.lookupId,caller,kind);
   switch(request.type){
    case 'lookup':case 'lookup.refine':{
     const active=registerActive(caller,request.requestId,request.type==='lookup.refine'?p.lookupId:undefined);
     try{
      const input:LookupPayload=request.type==='lookup'?p:(await abortable(ownLookup(),active.controller.signal)).request;
      const result=await lookup.lookup(input,{requestId:active.token,refine:request.type==='lookup.refine',signal:active.controller.signal});
      if(active.controller.signal.aborted)throw new ServiceError('REQUEST_CANCELLED');
      rememberLookup(await cacheEntry(input,result));
      data=result.data;warnings=result.warnings;meta=executionMeta(result);
      const owners=scopes.get(result.data.lookupId)??new Set<string>();owners.add(caller);
      while(owners.size>64)owners.delete(owners.values().next().value!);
      scopes.set(result.data.lookupId,owners);
     }finally{activeRequests.delete(active.token);}break;
    }
    case 'lookup.cancel':{
     let cancelled=false;
     for(const [token,active] of activeRequests){
      if(active.scope!==caller||active.controller.signal.aborted)continue;
      if((p.requestId&&active.requestId===p.requestId)||(p.lookupId&&active.lookupId===p.lookupId)){
       active.controller.abort(new ServiceError('REQUEST_CANCELLED'));lookup.cancel(token);cancelled=true;
      }
     }
     data={cancelled};break;
    }
    case 'pronunciation.get':{
     const record=await ownLookup();const result=await pronunciation.get({expression:record.data.expression,sourceLanguage:record.request.sourceLanguage,dialect:record.request.dialect,generatedCandidate:record.data.ipaCandidate});warnings=result.warnings;
     const variants:PronunciationVariant[]=result.alternatives.slice(0,16).map(v=>{const license=v.licenses.find(l=>l.scope==='entry'&&l.name);return{ipa:v.ipa,dialect:v.dialect,source:'dictionary',sourceUrl:v.sourceUrl,license:license?.name?{name:license.name,url:license.url}:null};});
     for(const v of [result.pronunciation,...variants])if(v.source==='dictionary'){const proof={ipa:v.ipa,dialect:v.dialect,source:v.source,sourceUrl:v.sourceUrl};await storage.setMetadata(`pronunciation:${await sha256(canonicalJson({sourceLanguage:record.request.sourceLanguage,expression:record.data.expression,pronunciation:proof}))}`,true);}
     try{await storage.putLookup({...record,pronunciationProvenance:{variants:result.alternatives,fetchedAt:new Date(now()).toISOString()}});}catch{warnings.push('PRONUNCIATION_PROVENANCE_CACHE_UNAVAILABLE');}
     data={pronunciation:result.pronunciation,variants,ambiguous:variants.length>1};break;
    }
    case 'card.enrich':{
     const active=registerActive(caller,request.requestId,p.lookupId);
     try{
      const record=await abortable(ownLookup(),active.controller.signal),sense=record.data.senses.find(s=>s.id===p.senseId);
      if(!sense)throw new ServiceError('INVALID_INPUT');
      const result=await openai.enrich({...record.request,selectedSense:sense},{signal:active.controller.signal});
      if(active.controller.signal.aborted)throw new ServiceError('REQUEST_CANCELLED');
      data={lookupId:p.lookupId,senseId:p.senseId,examples:result.data};warnings=result.warnings;meta=executionMeta(result,ENRICH_PROMPT_VERSION);
     }finally{activeRequests.delete(active.token);}break;
    }
    case 'audio.prepare':{
     const record=await ownLookup(),sense=record.data.senses.find(s=>s.id===p.senseId);if(!sense)throw new ServiceError('INVALID_INPUT');
     const candidate=record.data.ipaCandidate;
     if(p.draft){const draft:NoteDraft=p.draft;
      if(draft.expression!==record.data.expression||draft.lemma!==record.data.lemma||draft.partOfSpeech!==record.data.partOfSpeech||draft.context.sentence!==record.request.context.sentence||draft.context.targetStart!==record.request.context.targetStart||draft.context.targetEnd!==record.request.context.targetEnd||draft.selectedSense.id!==sense.id||senseDefinition(draft.selectedSense)!==senseDefinition(sense)||draft.sourceLanguage!==record.request.sourceLanguage||draft.targetLanguage!==record.request.targetLanguage||(draft.draftVersion!==undefined&&draft.learnerLevel!==record.request.learnerLevel)||!draft.selectedSense.translations.every(t=>sense.translations.includes(t)))throw new ServiceError('INVALID_INPUT');
      if(draft.draftVersion===3){
       // Every returned meaning remains bound to this lookup. The user may
       // choose another contextual sense, but cannot omit or replace the rest.
       const ordered=[sense,...record.data.senses.filter(entry=>entry.id!==sense.id)];
       if(draft.senses.length!==ordered.length||draft.senses.some((entry,index)=>{
        const original=ordered[index]!;
        return entry.id!==original.id||entry.definition!==senseDefinition(original)||(index>0&&(entry.translations.length!==original.translations.length||entry.translations.some((translation,i)=>translation!==original.translations[i])));
       }))throw new ServiceError('INVALID_INPUT');
      }
      await validateProvenance(draft);
     }
     const draft=p.draft??{draftVersion:2,sourceLanguage:record.request.sourceLanguage,targetLanguage:record.request.targetLanguage,learnerLevel:record.request.learnerLevel,examples:[],expression:record.data.expression,lemma:record.data.lemma,partOfSpeech:record.data.partOfSpeech,selectedSense:{...sense,translations:sense.translations.slice(0,2)},context:{sentence:record.request.context.sentence,targetStart:record.request.context.targetStart,targetEnd:record.request.context.targetEnd},pronunciation:candidate?{ipa:candidate.ipa,dialect:candidate.dialect,source:'generated',sourceUrl:null}:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null}};
     const baseSnapshot=await createDraftAudioSnapshot(draft,{dialect:record.request.dialect,speed:p.speed??settings.audioSpeed});
     // Legacy callers have not confirmed selected translations or IPA. Their preview cannot attach to a draft.
     const snapshot=p.draft?baseSnapshot:freezeAudioInput({...baseSnapshot,cacheDiscriminator:`lookup-preview-v1:${baseSnapshot.cacheDiscriminator}`});
     const result=await audio.prepare(snapshot);rememberAudio(result.metadata.audioId,caller);data=result.metadata;warnings=[...result.warnings,...p.draft?[]:['AUDIO_REVIEW_DRAFT_BEFORE_SAVE']];break;
    }
    case 'audio.play':{if(p.lookupId){const record=await ownLookup();data=await audio.playLocal({text:record.data.expression,sourceLanguage:record.request.sourceLanguage,locale:record.request.dialect,dialect:record.request.dialect,speed:settings.audioSpeed});}else{if(kind!=='page'&&!audioScopes.get(p.audioId)?.has(caller))throw new ServiceError('PERMISSION_DENIED');data=await audio.playCached(p.audioId);}break;}
    case 'anki.status':{try{data={available:true,version:await getAnki().version(),error:null};}catch(e){data={available:false,version:null,error:safeError(e)};}break;}
    case 'anki.decks':data={deckNames:await getAnki().deckNames()};break;
    case 'anki.createDeck':await requireConsent('create_deck',request,sender);data=await getAnki().createDeck(p.deckName);break;
    case 'anki.configuration':{
     const client=getAnki(),names=await client.modelNames(),models=[];
     // Report both namespaces without migrating or creating either one. Old queued
     // intents may still require v1 models even in a multilingual installation.
     for(const version of [2,1] as const)for(const mode of ['recognition','cloze'] as const){
      const name=modelNamesFor(version)[mode],exists=names.includes(name);let compatible=false;
      if(exists)try{await client.assertModel(mode,version);compatible=true;}
      catch(e){if(!(e instanceof ServiceError)||e.code!=='ANKI_SCHEMA_MISMATCH')throw e;}
      models.push({name,exists,compatible});
     }
     data={endpoint:isolatedTestMode?'http://127.0.0.1:18765':settings.ankiEndpoint,origin:`chrome-extension://${deps.runtime.extensionId}`,deckNames:await client.deckNames(),models};break;
    }
    case 'anki.initializeModels':await requireConsent('initialize_models',request,sender);data=await getAnki().initializeModels(true,p.modelVersion??2);break;
    case 'anki.findDuplicates':{const keys=await semanticKeys(p.draft);data={...keys,matches:await getAnki().findDuplicates(p.draft,keys)};break;}
    case 'anki.addNote':{await validateProvenance(p.draft);if(p.duplicateAction==='add_new')await requireConsent('add_duplicate',request,sender);data=await queue.add(p,{duplicateConfirmed:p.duplicateAction==='add_new'});break;}
    case 'anki.openNote':await getAnki().openNote(p.noteId);data={opened:true};break;
    case 'queue.list':{const result=await storage.listOperations(p);data={items:(result.items as unknown as QueueRecord[]).map(queuePublic),nextCursor:result.nextCursor};break;}
    case 'queue.retry':data={operation:queuePublic(await queue.retry(p.operationId))};break;
    case 'queue.cancel':data={operation:queuePublic(await (quarantinedOperations.has(p.operationId)?cancelQuarantined(p.operationId):queue.cancel(p.operationId)))};break;
    case 'queue.resolveAudio':data={operation:queuePublic(await queue.resolveAudio(p.operationId,p.action))};break;
    case 'settings.getPublic':data=await readSettings();break;
    case 'settings.getReader':data={sourceLanguage:settings.sourceLanguage,targetLanguage:settings.targetLanguage,learnerLevel:settings.learnerLevel,dialect:settings.dialect,defaultDeck:settings.defaultDeck,defaultMode:settings.defaultMode,includeAudioByDefault:settings.includeAudioByDefault,cloudAudioEnabled:settings.cloudAudioEnabled};break;
    case 'settings.update':{
     if(isolatedTestMode&&(Object.hasOwn(p.patch,'ankiEndpoint')||Object.hasOwn(p,'ankiKey')))throw new ServiceError('PERMISSION_DENIED');
     if(p.patch.dictionaryEnabled===true&&!settings.dictionaryEnabled)await requireConsent('dictionary',request,sender);
     if(p.patch.cloudAudioEnabled===true&&!settings.cloudAudioEnabled)await requireConsent('cloud_audio',request,sender);
     const update=settingsTail.then(async()=>{
      if(repairRequired&&!isolatedTestMode&&!Object.hasOwn(p.patch,'ankiEndpoint'))throw new ServiceError('OPERATION_CONFLICT');
      const next={...settings,...p.patch};
      if(!localeMatchesLanguage(next.dialect,next.sourceLanguage)){
       if(Object.hasOwn(p.patch,'dialect'))throw new ServiceError('INVALID_INPUT');
       next.dialect=defaultLocale(next.sourceLanguage);
      }
      // Validate the merged pair before touching credentials or durable preferences.
      if(Object.hasOwn(p,'ankiKey')){
       if(p.ankiKey===null)await deps.secrets.clearAnkiConnectKey();
       else await deps.secrets.setAnkiConnectKey(p.ankiKey,{persist:p.persistAnkiKey??false});
      }
      const persisted:SettingsPatch={sourceLanguage:next.sourceLanguage,targetLanguage:next.targetLanguage,learnerLevel:next.learnerLevel,dialect:next.dialect,dictionaryEnabled:next.dictionaryEnabled,cloudAudioEnabled:next.cloudAudioEnabled,includeAudioByDefault:next.includeAudioByDefault,ankiEndpoint:next.ankiEndpoint as import('../../contracts/src/index.ts').ProductionAnkiEndpoint,audioSpeed:next.audioSpeed,defaultDeck:next.defaultDeck,defaultMode:next.defaultMode};
      await storage.setMetadata('preferences',persisted);
      if(repairRequired){
       await storage.setMetadata(recoveryMetadata,{v:1,pending:false,blockedOperationIds:[...quarantinedOperations]} satisfies PreferencesRecovery);
       repairRequired=false;
      }
      settings=next;
     });
     settingsTail=update.catch(()=>{});await update;data=await readSettings();break;
    }
    case 'secrets.setOpenAIKey':await deps.secrets.setOpenAIKey(p.key,{persist:p.persist??false});data={configured:true,persistence:p.persist?'local':'session'};break;
    case 'secrets.clearOpenAIKey':await deps.secrets.clearOpenAIKey();data={configured:false};break;
    case 'providers.test':{
     if(p.allowPaidTest){await requireConsent('paid_provider_test',request,sender);throw new ServiceError('PERMISSION_DENIED','Live testing additionally requires an explicit host-side budget implementation.');}
     let error=null,model=null;try{if(p.provider==='anki')await getAnki().version();else if(p.provider==='dictionary'){if(!settings.dictionaryEnabled)throw new ServiceError('PERMISSION_DENIED');const result=await pronunciation.get({expression:'book',sourceLanguage:settings.sourceLanguage,dialect:settings.dialect});if(!result.alternatives.length)throw new ServiceError('DICTIONARY_UNAVAILABLE');}else{const key=await deps.secrets.getOpenAIKeyForService();if(!key)throw new ServiceError('OPENAI_AUTH');const response=await fetcher('https://api.openai.com/v1/models/gpt-4.1-mini',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(10000),redirect:'error',credentials:'omit'});if(response.status===401)throw new ServiceError('OPENAI_AUTH');if(response.status===404)throw new ServiceError('MODEL_UNAVAILABLE');if(!response.ok)throw new ServiceError('INTERNAL_ERROR');void response.body?.cancel().catch(()=>{});model='gpt-4.1-mini';warnings.push('MODEL_LISTING_IS_NOT_STRUCTURED_OUTPUT_VALIDATION');}}catch(e){error=safeError(e);}data={provider:p.provider,ok:error===null,checkedAt:new Date(now()).toISOString(),model,error};break;
    }
   }
   if(repairRequired)warnings.push('SETTINGS_REPAIR_REQUIRED');
   if(kind==='page'&&quarantinedOperations.size)warnings.push('ANKI_QUEUE_REVIEW_REQUIRED');
   validateData(request.type,data);return {v:1,requestId,ok:true,data:data as any,warnings,...meta?{meta}:{}};
  }catch(error){const safe=error instanceof ContractValidationError?new ServiceError('INVALID_INPUT'):error;return {v:1,requestId,ok:false,error:safeError(safe)};}
 }
 return {handleMessage,resumeQueue:async()=>{await init();assertAnkiConfigured();await queue.recover();await queue.processDue();},close:()=>{closed=true;for(const [id,active] of activeRequests){active.controller.abort(new ServiceError('REQUEST_CANCELLED'));lookup.cancel(id);}recentLookups.clear();scopes.clear();storage.close();},getPublicSettings:async()=>{const result=await readSettings();assertAnkiConfigured();return result;}};
}
export function createRpcHandler(dependencies:ServiceDependencies){const services=createReaderServices(dependencies);return Object.assign(services.handleMessage,{resumeQueue:services.resumeQueue,close:services.close});}
