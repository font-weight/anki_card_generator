import test from 'node:test';
import assert from 'node:assert/strict';
import {
 draftExamples,draftSenses,validateData,validateNoteDraft,validateRequest,
 MAX_LOOKUP_SENSES,MAX_SENSE_TRANSLATIONS,
} from '../packages/contracts/src/index.ts';
import type {NoteDraftV1,NoteDraftV2,NoteDraftV3,MultilingualSense} from '../packages/contracts/src/index.ts';

const id='9f1638a4-d2ce-49ab-b259-cf2ee0ec15f0';
const senses:MultilingualSense[]=Array.from({length:8},(_,i)=>({id:`sense-${i}`,translations:Array.from({length:4},(_,j)=>`перевод ${i}-${j}`),definition:`Common meaning ${i}.`}));
const draft:NoteDraftV3={draftVersion:3,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',mode:'recognition',deckName:'Default',tags:[],expression:'bank',lemma:'bank',partOfSpeech:'noun',selectedSense:senses[0]!,senses,context:{sentence:'We stopped at the bank.',targetStart:18,targetEnd:22},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},examples:[{text:'The bank opens early.',translation:'Банк открывается рано.',source:'ai'}],source:{kind:'html',title:'A source',url:'https://example.test/book',documentId:null,page:null,chapter:null,cfi:null}};
function v2():NoteDraftV2{const{senses:ignored,...rest}=structuredClone(draft);return{...rest,draftVersion:2,selectedSense:{...rest.selectedSense,translations:['банк']}};}
function v1():NoteDraftV1{const{draftVersion:ignored,learnerLevel,examples,selectedSense,pronunciation,...rest}=v2();return{...rest,sourceLanguage:'en',targetLanguage:'ru',selectedSense:{id:selectedSense.id,definitionEn:selectedSense.definition,translations:selectedSense.translations},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:null};}

 test('v3 preserves all eight senses and four translations with primary first without mutation',()=>{
 const before=JSON.stringify(draft);assert.deepEqual(validateNoteDraft(draft),draft);assert.equal(JSON.stringify(draft),before);
 assert.equal(MAX_LOOKUP_SENSES,8);assert.equal(MAX_SENSE_TRANSLATIONS,4);
 assert.deepEqual(draftSenses(draft),senses);assert.deepEqual(draftExamples(draft),draft.examples);
 for(const type of ['anki.findDuplicates','audio.prepare','anki.addNote'] as const){
  const payload=type==='anki.findDuplicates'?{draft}:type==='audio.prepare'?{draft,lookupId:id,senseId:senses[0]!.id}:{draft,operationId:id,includeAudio:false};
  assert.doesNotThrow(()=>validateRequest({v:1,requestId:id,type,payload}));
 }
});

test('v3 rejects omitted, excessive, duplicated or mixed-schema meanings',()=>{
 const {senses:ignored,...missing}=draft;
 for(const invalid of [missing,{...draft,senses:[]},{...draft,senses:[...senses,{...senses[0]!,id:'ninth'}]},
  {...draft,senses:[senses[0],senses[0]]},{...draft,senses:[{id:'sense-0',translations:['банк'],definitionEn:'A bank.'}]},
  {...draft,selectedSense:{...senses[0]!,translations:['one','two','three','four','five']},senses:[{...senses[0]!,translations:['one','two','three','four','five']}]},
  {...draft,selectedSense:{...senses[0]!,translations:['one','one']},senses:[{...senses[0]!,translations:['one','one']}]},
  {...draft,extraExample:null},{...draft,draftVersion:4}])assert.throws(()=>validateNoteDraft(invalid));
});

test('v3 primary edits must agree exactly with first sense, including translation order',()=>{
 for(const selectedSense of [senses[1],{...senses[0]!,definition:'Changed.'},{...senses[0]!,translations:senses[0]!.translations.slice(1)},{...senses[0]!,translations:[...senses[0]!.translations].reverse()}])assert.throws(()=>validateNoteDraft({...draft,selectedSense}));
 const primary={...senses[0]!,translations:['мой перевод'],definition:'Edited definition.'};
 assert.doesNotThrow(()=>validateNoteDraft({...draft,selectedSense:primary,senses:[primary,...senses.slice(1)]}));
 const reordered=[senses[3]!,...senses.filter(s=>s.id!==senses[3]!.id)];
 assert.doesNotThrow(()=>validateNoteDraft({...draft,selectedSense:reordered[0],senses:reordered}));
});

test('v1/v2 readers remain strict, unchanged, and never acquire a full-meaning snapshot',()=>{
 for(const old of [v1(),v2()]){
  const before=JSON.stringify(old);assert.deepEqual(validateNoteDraft(old),old);assert.equal(JSON.stringify(old),before);
  assert.deepEqual(draftSenses(old),[old.selectedSense]);
  assert.throws(()=>validateNoteDraft({...old,senses}));
  assert.throws(()=>validateNoteDraft({...old,selectedSense:{...old.selectedSense,translations:['a','b','c']}}));
 }
});

test('v3 keeps multilingual provenance and original grapheme range validation',()=>{
 for(const patch of [{sourceLanguage:'fr',pronunciation:{ipa:'/bæŋk/',dialect:'en-US',source:'generated',sourceUrl:null}},
  {sourceLanguage:'fr',pronunciation:{ipa:'/bɑ̃k/',dialect:'fr-FR',source:'dictionary',sourceUrl:'https://example.test/word'}},
  {expression:'cafe',lemma:'cafe',context:{sentence:'A café.',targetStart:2,targetEnd:6}}])assert.throws(()=>validateNoteDraft({...draft,...patch}));
});

test('lookup RPC accepts expanded bounded common senses but still rejects overbounds or bad references',()=>{
 const data={lookupId:id,expression:'bank',lemma:'bank',partOfSpeech:'noun',recommendedSenseId:senses[0]!.id,contextAmbiguous:false,senses,ipaCandidate:null,extraExample:null};
 assert.deepEqual(validateData('lookup',data),data);
 for(const patch of [{senses:[]},{senses:[...senses,{...senses[0],id:'ninth'}]},{senses:[{...senses[0],translations:['a','b','c','d','e']}]},{recommendedSenseId:'missing'},{contextAmbiguous:true}])assert.throws(()=>validateData('lookup',{...data,...patch}));
});

test('legacy add inputs and persisted v3 audio-decision rows remain valid without a prepared ID',()=>{
 for(const old of [v1(),v2()])assert.doesNotThrow(()=>validateRequest({v:1,requestId:id,type:'anki.addNote',payload:{operationId:id,draft:old,includeAudio:true}}));
 const row={operationId:id,draft,includeAudio:true,audioId:null,duplicateAction:'review',state:'awaiting_audio_decision',attempts:0,lastError:null,noteId:null,createdAt:'2026-10-21T00:00:00.000Z',updatedAt:'2026-10-21T00:00:00.000Z',nextAttemptAt:null};
 assert.doesNotThrow(()=>validateData('queue.list',{items:[row],nextCursor:null}));
 for(const type of ['queue.retry','queue.resolveAudio'] as const)assert.doesNotThrow(()=>validateData(type,{operation:row}));
 assert.doesNotThrow(()=>validateRequest({v:1,requestId:id,type:'queue.resolveAudio',payload:{operationId:id,action:'retry'}}));
});
