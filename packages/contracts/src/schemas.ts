import {isLanguageChatText} from './language-chat-text.ts';
import {GRAMMAR_QUESTION_LIMIT,GRAMMAR_ANSWER_LIMIT} from './grammar-question.ts';
import {LOOKUP_DIAGNOSTIC_STAGES,LOOKUP_DIAGNOSTIC_REASONS} from './lookup-diagnostics.ts';
import {MAX_PHRASAL_CANDIDATES,validPhrasalCandidates} from './phrasal-candidates.ts';
import {isGrammarPlainText,grammarLookupPayloadSchema,grammarLookupDataSchema,grammarAddPayloadSchema,validateGrammarLookupPayload,validateGrammarDraft} from './grammar.ts';
import {countEnglishWords,countSourceWords,sourceGraphemeBoundaries} from './words.ts';
import {LANGUAGE_CODES,LEARNER_LEVELS,DIALECTS,localeMatchesLanguage} from './languages.ts';
import {ENGLISH_USAGE_REGISTERS,ENGLISH_USAGE_FREQUENCIES} from './english-usage.ts';
import type {LanguageCode} from './languages.ts';
import { ERROR_CODES, OPERATION_STATES, MAX_LOOKUP_SENSES, MAX_SENSE_TRANSLATIONS } from './constants.ts';
import type { NoteDraft, Operation, RpcData, RpcRequest } from './index.ts';
import { ContractValidationError, validateSchema } from './validation.ts';
import type { Schema } from './validation.ts';
export { ContractValidationError, validateSchema } from './validation.ts';
export type { Schema } from './validation.ts';
const str=(min=1,max=256):Schema=>({type:'string',minLength:min,maxLength:max});
const en=(...values:unknown[]):Schema=>({enum:values});
const obj=(properties:Record<string,Schema>,optional:string[]=[]):Schema=>({type:'object',properties,required:Object.keys(properties).filter(k=>!optional.includes(k)),additionalProperties:false});
const arr=(items:Schema,min=0,max=100):Schema=>({type:'array',items,minItems:min,maxItems:max} as unknown as Schema);
const num=(minimum=0,maximum=Number.MAX_SAFE_INTEGER,integer=true):Schema=>({type:integer?'integer':'number',minimum,maximum});
const bool:Schema={type:'boolean'};
const nullable=(s:Schema):Schema=>({anyOf:[s,{type:'null'}]});
const uuid:Schema={...str(36,36),format:'uuid'};
const url:Schema={...str(1,2048),format:'url'};
const date:Schema={...str(20,30),format:'date-time'};
const dialect=en(...DIALECTS);
const language=en(...LANGUAGE_CODES);
const learnerLevel=en(...LEARNER_LEVELS);
const speed=num(.25,4,false);
const state=en(...OPERATION_STATES);
const endpoint=en('http://127.0.0.1:8765','http://localhost:8765');
const effectiveEndpoint=en('http://127.0.0.1:8765','http://localhost:8765','http://127.0.0.1:18765');
const legacySense=(max=3)=>obj({id:str(1,64),translations:arr(str(1,200),1,max),definitionEn:str(1,500)});
const multilingualSense=(max=3)=>obj({id:str(1,64),translations:arr(str(1,200),1,max),definition:str(1,500)});
const sense=(max=3):Schema=>({anyOf:[legacySense(max),multilingualSense(max)]});
const context=obj({sentence:str(1,1500),targetStart:num(0,1499),targetEnd:num(1,1500),before:str(0,1500),after:str(0,1500)},['before','after']);
const phrasalCandidate=obj({id:str(1,64),expression:str(1,256),targetStart:num(0,1499),targetEnd:num(1,1500),lemma:str(1,256)});
const resolvedTarget=obj({candidateId:nullable(str(1,64)),targetStart:num(0,1499),targetEnd:num(1,1500)});
const noteContext=obj({sentence:str(1,1500),targetStart:num(0,1499),targetEnd:num(1,1500)});
const contextExample=obj({text:str(1,500),translation:str(1,500),source:en('ai')});
const example=obj({textEn:str(1,500),textRu:str(1,500),source:en('ai')});
const pronunciation=obj({ipa:nullable(str(1,256)),dialect:en(...DIALECTS,'unknown'),source:en('dictionary','generated','unavailable'),sourceUrl:nullable(url)});
const legacyPronunciation=obj({...pronunciation.properties,dialect:en('en-US','en-GB','unknown')});
const source=obj({kind:en('html','pdf','epub','fb2'),title:str(0,500),url:nullable(url),documentId:nullable(str(1,128)),page:nullable(num(1)),chapter:nullable(str(0,500)),cfi:nullable(str(1,2048))});
const safeErrorSchema=obj({code:en(...ERROR_CODES),message:str(1,500),retryable:bool,diagnostics:obj({stage:en(...LOOKUP_DIAGNOSTIC_STAGES),reason:en(...LOOKUP_DIAGNOSTIC_REASONS)})},['diagnostics']);
export const legacyNoteDraftSchema=obj({sourceLanguage:en('en'),targetLanguage:en('ru'),mode:en('recognition','cloze'),deckName:str(1,200),tags:arr({...str(1,80),pattern:'^\\S+$'},0,32),expression:str(1,256),lemma:str(1,256),partOfSpeech:str(1,80),selectedSense:legacySense(2),context:noteContext,pronunciation:legacyPronunciation,extraExample:nullable(example),source});
export const multilingualNoteDraftSchema=obj({...legacyNoteDraftSchema.properties,draftVersion:en(2),sourceLanguage:language,targetLanguage:language,learnerLevel,pronunciation,selectedSense:multilingualSense(2),examples:arr(contextExample,0,3)});
delete multilingualNoteDraftSchema.properties!.extraExample;
multilingualNoteDraftSchema.required=Object.keys(multilingualNoteDraftSchema.properties!);
export const fullMeaningsNoteDraftSchema=obj({...multilingualNoteDraftSchema.properties,draftVersion:en(3),selectedSense:multilingualSense(MAX_SENSE_TRANSLATIONS),senses:arr(multilingualSense(MAX_SENSE_TRANSLATIONS),1,MAX_LOOKUP_SENSES),sentenceTranslation:str(1,6000)},['sentenceTranslation']);
export const noteDraftSchema:Schema={anyOf:[legacyNoteDraftSchema,multilingualNoteDraftSchema,fullMeaningsNoteDraftSchema]};
export const lookupDataSchema=obj({englishUsage:obj({level:nullable(learnerLevel),register:nullable(en(...ENGLISH_USAGE_REGISTERS)),frequency:nullable(en(...ENGLISH_USAGE_FREQUENCIES))}),sentenceTranslation:str(1,6000),lookupId:uuid,expression:str(1,256),resolvedTarget,lemma:str(1,256),partOfSpeech:str(1,80),recommendedSenseId:nullable(str(1,64)),contextAmbiguous:bool,senses:arr(sense(MAX_SENSE_TRANSLATIONS),1,MAX_LOOKUP_SENSES),examples:arr(contextExample,0,3),ipaCandidate:nullable(obj({ipa:str(1,256),dialect:en(...DIALECTS,'unknown')})),extraExample:nullable(example)},['examples','resolvedTarget','sentenceTranslation','englishUsage']);
const queueItem=obj({operationId:uuid,draft:noteDraftSchema,includeAudio:bool,audioId:nullable(uuid),duplicateAction:en('review','add_new'),state,attempts:num(),lastError:nullable(safeErrorSchema),noteId:nullable(num(1)),createdAt:date,updatedAt:date,nextAttemptAt:nullable(date)});
const grammarSettings={grammarEnabled:bool,grammarIncludeExplanation:bool,grammarExplanationLanguage:language,grammarDeck:str(0,200)};
const grammarSettingNames=Object.keys(grammarSettings);
const publicSettings=obj({...grammarSettings,sourceLanguage:language,targetLanguage:language,learnerLevel,dialect,dictionaryEnabled:bool,cloudAudioEnabled:bool,includeAudioByDefault:bool,defaultDeck:str(1,200),defaultMode:en('recognition','cloze'),openAIKeyPersistence:en('session','local'),ankiKeyPersistence:en('session','local'),ankiEndpoint:effectiveEndpoint,audioVoice:en('coral'),audioSpeed:speed,cacheLimitBytes:en(104857600),hasOpenAIKey:bool,hasAnkiKey:bool},grammarSettingNames);
const patch=obj({...grammarSettings,sourceLanguage:language,targetLanguage:language,learnerLevel,dialect,dictionaryEnabled:bool,cloudAudioEnabled:bool,includeAudioByDefault:bool,ankiEndpoint:endpoint,audioSpeed:speed,defaultDeck:str(1,200),defaultMode:en('recognition','cloze')},[...grammarSettingNames,'sourceLanguage','targetLanguage','learnerLevel','defaultDeck','defaultMode','dialect','dictionaryEnabled','cloudAudioEnabled','includeAudioByDefault','ankiEndpoint','audioSpeed']);
const idPayload=obj({operationId:uuid});
export const payloadSchemas:Record<Operation,Schema>={
 'grammar.lookup':grammarLookupPayloadSchema,
 'grammar.chat':obj({grammarId:uuid,sentence:str(1,1500),turnId:uuid,turnNumber:num(1),question:str(1,GRAMMAR_QUESTION_LIMIT)},['turnNumber']),
 'grammar.chat.close':obj({grammarId:uuid}),
 'grammar.cancel':obj({requestId:uuid}),
 'grammar.initializeModel':obj({}),
 'grammar.addNote':grammarAddPayloadSchema,
 lookup:obj({expression:str(1,256),context,sourceLanguage:language,targetLanguage:language,learnerLevel,dialect,phrasalCandidates:arr(phrasalCandidate,1,MAX_PHRASAL_CANDIDATES)},['phrasalCandidates']),
 'lookup.refine':obj({lookupId:uuid,reason:str(1,500)},['reason']),
 'lookup.cancel':obj({lookupId:uuid,requestId:uuid},['lookupId','requestId']),
 'pronunciation.get':obj({lookupId:uuid}),
 'card.enrich':obj({lookupId:uuid,senseId:str(1,64)}),
 'audio.prepare':obj({lookupId:uuid,senseId:str(1,64),speed,draft:noteDraftSchema},['speed','draft']),
 'audio.play':obj({lookupId:uuid,audioId:uuid},['lookupId','audioId']),
 'anki.status':obj({}),'anki.decks':obj({}),'anki.createDeck':obj({deckName:str(1,200)}),'anki.configuration':obj({}),'anki.initializeModels':obj({modelVersion:en(1,2)},['modelVersion']),
 'anki.findDuplicates':obj({draft:noteDraftSchema}),
 'anki.addNote':obj({operationId:uuid,draft:noteDraftSchema,includeAudio:bool,audioId:uuid,duplicateAction:en('review','add_new')},['audioId','duplicateAction']),
 'anki.openNote':obj({noteId:num(1)}),
 'queue.list':obj({states:arr(state,1,11),limit:num(1,100),cursor:str(1,128)},['states','limit','cursor']),
 'queue.retry':idPayload,'queue.cancel':idPayload,'queue.removeLocal':idPayload,
 'queue.resolveAudio':obj({operationId:uuid,action:en('retry','save_without_audio','cancel')}),
 'settings.getPublic':obj({}),'settings.getReader':obj({}),
 'settings.update':obj({patch,ankiKey:nullable(str(1,512)),persistAnkiKey:bool},['ankiKey','persistAnkiKey']),
 'secrets.setOpenAIKey':obj({key:str(10,512),persist:bool},['persist']),
 'secrets.clearOpenAIKey':obj({}),
 'providers.test':obj({provider:en('openai','dictionary','anki'),allowPaidTest:bool},['allowPaidTest'])
};
export const dataSchemas:Record<Operation,Schema>={
 'grammar.lookup':grammarLookupDataSchema,
 'grammar.chat':{anyOf:[obj({grammarId:uuid,turnId:uuid,kind:en('answer'),answer:str(1,GRAMMAR_ANSWER_LIMIT),source:en('analysis')},['source']),obj({grammarId:uuid,turnId:uuid,kind:en('out_of_scope','model_out_of_scope','model_no_answer','topic_reset')})]},
 'grammar.chat.close':obj({closed:bool}),
 'grammar.cancel':obj({cancelled:bool}),
 'grammar.initializeModel':obj({created:arr(str(1,100),0,1),existing:arr(str(1,100),0,1)}),
 'grammar.addNote':obj({operationId:uuid,status:en('added','already_added'),noteId:num(1)}),
 lookup:lookupDataSchema,'lookup.refine':lookupDataSchema,
 'lookup.cancel':obj({cancelled:bool}),
 'pronunciation.get':obj({pronunciation,variants:arr(obj({ipa:str(1,256),dialect:en(...DIALECTS,'unknown'),source:en('dictionary'),sourceUrl:nullable(url),license:nullable(obj({name:str(1,200),url:nullable(url)}))}),0,16),ambiguous:bool}),
 'card.enrich':{anyOf:[obj({lookupId:uuid,senseId:str(1,64),extraExample:example}),obj({lookupId:uuid,senseId:str(1,64),examples:arr(contextExample,1,3)})]},
 'audio.prepare':obj({sourceLanguage:language,audioId:uuid,text:str(1,500),dialect,voice:en('coral'),model:en('gpt-4o-mini-tts'),speed,format:en('mp3'),byteLength:num(1,10485760),createdAt:date},['sourceLanguage']),
 'audio.play':obj({played:bool,method:en('local_speech','cached_audio')}),
 'anki.status':obj({available:bool,version:nullable(num()),error:nullable(safeErrorSchema)}),
 'anki.decks':obj({deckNames:arr(str(1,200),0,10000)}),'anki.createDeck':obj({deckName:str(1,200),deckId:num(1)}),
 'anki.configuration':obj({endpoint:effectiveEndpoint,origin:str(1,200),deckNames:arr(str(1,200),0,10000),models:arr(obj({name:str(1,100),exists:bool,compatible:bool}),0,4)}),
 'anki.initializeModels':obj({created:arr(str(1,100),0,4),existing:arr(str(1,100),0,4)}),
 'anki.findDuplicates':obj({lexemeKey:str(1,256),contentKey:str(1,256),matches:arr(obj({noteId:num(1),modelName:str(1,100),expression:str(0,1000),meaning:str(0,2000),exactContent:bool}),0,1000)}),
 'anki.addNote':obj({operationId:uuid,status:en('added','queued','already_added','duplicate_review'),noteId:nullable(num(1))}),
 'anki.openNote':obj({opened:bool}),
 'queue.list':obj({items:arr(queueItem,0,100),nextCursor:nullable(str(1,128))}),
 'queue.removeLocal':obj({removed:en(true)}),
 'queue.retry':obj({operation:queueItem}),'queue.cancel':obj({operation:queueItem}),'queue.resolveAudio':obj({operation:queueItem}),
 'settings.getPublic':publicSettings,'settings.update':publicSettings,'settings.getReader':obj({...grammarSettings,sourceLanguage:language,targetLanguage:language,learnerLevel,dialect,defaultDeck:str(1,200),defaultMode:en('recognition','cloze'),includeAudioByDefault:bool,cloudAudioEnabled:bool},grammarSettingNames),
 'secrets.setOpenAIKey':obj({configured:en(true),persistence:en('session','local')}),
 'secrets.clearOpenAIKey':obj({configured:en(false)}),
 'providers.test':obj({provider:en('openai','dictionary','anki'),ok:bool,checkedAt:date,model:nullable(str(1,100)),error:nullable(safeErrorSchema)})
};
function invalid(path:string):never {throw new ContractValidationError(`Invalid field: ${path}`);}
/** Frozen c1 v1 semantics: do not strand previously accepted durable intents. */
function legacyRange(expression:string,c:{sentence:string;targetStart:number;targetEnd:number;before?:string;after?:string}){
 if(expression.trim()!==expression||countEnglishWords(expression)<1||countEnglishWords(expression)>5||c.targetStart>=c.targetEnd||c.targetEnd>c.sentence.length||c.sentence.slice(c.targetStart,c.targetEnd)!==expression||(c.sentence+(c.before??'')+(c.after??'')).length>1500)invalid('context');
 const split=(i:number)=>i>0&&i<c.sentence.length&&/[\uD800-\uDBFF]/.test(c.sentence[i-1]!)&&/[\uDC00-\uDFFF]/.test(c.sentence[i]!);
 if(split(c.targetStart)||split(c.targetEnd))invalid('context.range');
}
function range(expression:string,c:{sentence:string;targetStart:number;targetEnd:number;before?:string;after?:string},language:LanguageCode='en'){
 const count=countSourceWords(expression,language);
 if(expression.trim()!==expression||count<1||count>5||c.targetStart>=c.targetEnd||c.targetEnd>c.sentence.length||c.sentence.slice(c.targetStart,c.targetEnd)!==expression||(c.sentence+(c.before??'')+(c.after??'')).length>1500)invalid('context');
 // Preserve complete combining sequences and surrogate pairs in original UTF-16.
 const boundaries=sourceGraphemeBoundaries(c.sentence,language);
 if(!boundaries?.has(c.targetStart)||!boundaries.has(c.targetEnd))invalid('context.range');
}
export function validateNoteDraft(value:unknown):NoteDraft{
 validateSchema(noteDraftSchema,value);const d=value as NoteDraft;
 if(d.draftVersion===2||d.draftVersion===3)range(d.expression,d.context,d.sourceLanguage);else legacyRange(d.expression,d.context);
 if(d.draftVersion!==undefined&&d.pronunciation.source==='dictionary'&&d.sourceLanguage!=='en')invalid('pronunciation.source');
 if(d.draftVersion!==undefined&&d.pronunciation.dialect!=='unknown'&&!localeMatchesLanguage(d.pronunciation.dialect,d.sourceLanguage))invalid('pronunciation.dialect');
 if(d.draftVersion===3){
  const first=d.senses[0]!;
  if(new Set(d.senses.map(s=>s.id)).size!==d.senses.length)invalid('senses');
  if(first.id!==d.selectedSense.id||first.definition!==d.selectedSense.definition||first.translations.length!==d.selectedSense.translations.length||first.translations.some((translation,index)=>translation!==d.selectedSense.translations[index]))invalid('selectedSense');
  for(const entry of d.senses)if(new Set(entry.translations).size!==entry.translations.length)invalid('senses.translations');
 }
 if(d.pronunciation.source==='unavailable'&&(d.pronunciation.ipa!==null||d.pronunciation.sourceUrl!==null||d.pronunciation.dialect!=='unknown'))invalid('pronunciation');
 if(d.pronunciation.source==='generated'&&d.pronunciation.sourceUrl!==null)invalid('pronunciation.sourceUrl');
 if(d.pronunciation.source!=='unavailable'&&d.pronunciation.ipa===null)invalid('pronunciation.ipa');
 if(d.source.kind==='html'&&(d.source.page!==null||d.source.chapter!==null||d.source.cfi!==null))invalid('source');
 if(d.source.kind==='pdf'&&(!d.source.documentId||!d.source.page||d.source.chapter!==null||d.source.cfi!==null))invalid('source');
 if((d.source.kind==='epub'||d.source.kind==='fb2')&&(!d.source.documentId||d.source.page!==null))invalid('source');
 if(d.source.kind==='fb2'&&d.source.url!==null)invalid('source');return d;
}
export function validateRequest(value:unknown):RpcRequest{
 const envelope=obj({v:en(1),requestId:uuid,type:en(...Object.keys(payloadSchemas)),payload:{type:'object'}});
 // Envelope payload is dispatched separately, never treated as an unvalidated object.
 validateSchema({...envelope,properties:{...envelope.properties,payload:{}}},value);
 const r=value as RpcRequest;validateSchema(payloadSchemas[r.type],r.payload);const p=r.payload as unknown as Record<string,any>;
 if(r.type==='grammar.lookup')validateGrammarLookupPayload(p);
 if(r.type==='grammar.chat'&&(!isGrammarPlainText(p.sentence)||!isLanguageChatText(p.question)||p.question!==p.question.trim()))invalid('grammar.chat');
 if(r.type==='grammar.addNote')validateGrammarDraft(p.draft);
 if(r.type==='lookup'){range(p.expression,p.context,p.sourceLanguage);if(p.phrasalCandidates!==undefined&&!validPhrasalCandidates(p.phrasalCandidates,p.context,p.sourceLanguage))invalid('payload.phrasalCandidates');if(!localeMatchesLanguage(p.dialect,p.sourceLanguage))invalid('payload.dialect');}
 if(r.type==='anki.addNote'||r.type==='anki.findDuplicates'||r.type==='audio.prepare'&&p.draft)validateNoteDraft(p.draft);
 if(r.type==='lookup.cancel'&&!p.lookupId&&!p.requestId)invalid('payload');
 if(r.type==='audio.play'&&Boolean(p.lookupId)===Boolean(p.audioId))invalid('payload');
 if(r.type==='anki.addNote'&&!p.includeAudio&&p.audioId)invalid('payload.audioId');
 if(r.type==='settings.update'){
  if(!Object.keys(p.patch).length&&!Object.hasOwn(p,'ankiKey'))invalid('payload.patch');
  if(p.patch.sourceLanguage&&p.patch.dialect&&!localeMatchesLanguage(p.patch.dialect,p.patch.sourceLanguage))invalid('payload.patch.dialect');
  if(Object.hasOwn(p,'persistAnkiKey')&&typeof p.ankiKey!=='string')invalid('payload.persistAnkiKey');
 }
 if(r.type==='providers.test'&&p.provider!=='openai'&&p.allowPaidTest)invalid('payload.allowPaidTest');return r;
}
export function validateData<T extends Operation>(type:T,value:unknown):RpcData[T]{
 validateSchema(dataSchemas[type],value);
 if(type==='grammar.chat'){const r=value as RpcData['grammar.chat'];if(r.kind==='answer'&&!isLanguageChatText(r.answer))invalid('data.answer');}
 if(type==='settings.getPublic'||type==='settings.update'||type==='settings.getReader'){const s=value as RpcData['settings.getPublic'];if(!localeMatchesLanguage(s.dialect,s.sourceLanguage))invalid('data.dialect');}
 if(type==='lookup'||type==='lookup.refine'){
  const d=value as RpcData['lookup'];if(d.resolvedTarget&&d.resolvedTarget.targetStart>=d.resolvedTarget.targetEnd)invalid('data.resolvedTarget');const ids=d.senses.map(s=>s.id);if(new Set(ids).size!==ids.length||d.recommendedSenseId!==null&&!ids.includes(d.recommendedSenseId)||d.contextAmbiguous&&d.recommendedSenseId!==null)invalid('data.senses');
 }
 if(type==='queue.list')for(const row of (value as RpcData['queue.list']).items)validateNoteDraft(row.draft);
 if(type==='queue.retry'||type==='queue.cancel'||type==='queue.resolveAudio')validateNoteDraft((value as RpcData['queue.retry']).operation.draft);
 return value as RpcData[T];
}
