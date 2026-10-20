import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGE_CODES,LEARNER_LEVELS,defaultLocale,validateRequest,validateNoteDraft,validateData,senseDefinition,draftExamples,DEFAULT_SETTINGS} from '../packages/contracts/src/index.ts';
import {countEnglishWords,countSourceWords,sourceGraphemeBoundaries} from '../packages/contracts/src/words.ts';
const id='3fbc6d2e-806b-4cae-8878-6b11c46b6901';
const request=(type:string,payload:unknown)=>({v:1,requestId:id,type,payload});
const legacy={sourceLanguage:'en',targetLanguage:'ru',mode:'recognition',deckName:'Default',tags:[],expression:'book',lemma:'book',partOfSpeech:'noun',selectedSense:{id:'one',translations:['книга'],definitionEn:'written work'},context:{sentence:'book',targetStart:0,targetEnd:4},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:{textEn:'I read a book.',textRu:'Я читаю книгу.',source:'ai'},source:{kind:'html',title:'',url:null,documentId:null,page:null,chapter:null,cfi:null}};
const {extraExample:unused,...base}=legacy;
const modern={...base,draftVersion:2,learnerLevel:'A2',sourceLanguage:'ja',targetLanguage:'ar',expression:'本',lemma:'本',selectedSense:{id:'one',translations:['كتاب'],definition:'印刷された読み物'},context:{sentence:'本',targetStart:0,targetEnd:1},examples:[{text:'本を読みます。',translation:'أقرأ كتابًا.',source:'ai'}]};
test('all allowlisted pairs and levels round-trip, including same-language',()=>{for(const sourceLanguage of LANGUAGE_CODES)for(const targetLanguage of LANGUAGE_CODES)for(const learnerLevel of LEARNER_LEVELS)assert.ok(validateRequest(request('lookup',{expression:'word',context:{sentence:'word',targetStart:0,targetEnd:4},sourceLanguage,targetLanguage,learnerLevel,dialect:defaultLocale(sourceLanguage)})));});
test('legacy draft remains unchanged and v2 neutral draft validates',()=>{const before=JSON.stringify(legacy);const old=validateNoteDraft(legacy);assert.equal(JSON.stringify(old),before);assert.equal(senseDefinition(old.selectedSense),'written work');assert.equal(draftExamples(old)[0]?.text,'I read a book.');const next=validateNoteDraft(modern);assert.equal(senseDefinition(next.selectedSense),'印刷された読み物');assert.equal(draftExamples(next).length,1);});
test('mixed versions, aliases, excess examples and source-mismatched IPA are rejected',()=>{for(const value of [{...legacy,draftVersion:2},{...modern,extraExample:unused},{...modern,selectedSense:legacy.selectedSense},{...modern,examples:Array(4).fill(modern.examples[0])},{...modern,pronunciation:{ipa:'a',dialect:'en-US',source:'generated',sourceUrl:null}},{...legacy,pronunciation:{ipa:'a',dialect:'ja-JP',source:'generated',sourceUrl:null}}])assert.throws(()=>validateNoteDraft(value));});
test('locale mismatch and unsupported languages fail closed',()=>{assert.throws(()=>validateRequest(request('lookup',{expression:'word',context:{sentence:'word',targetStart:0,targetEnd:4},sourceLanguage:'ja',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US'})));assert.throws(()=>validateData('settings.getPublic',{...DEFAULT_SETTINGS,sourceLanguage:'ja'}));assert.throws(()=>validateRequest(request('settings.update',{patch:{sourceLanguage:'unknown'}})));});
test('enrichment accepts bounded neutral examples and old one-example response',()=>{assert.ok(validateData('card.enrich',{lookupId:id,senseId:'one',examples:modern.examples}));assert.ok(validateData('card.enrich',{lookupId:id,senseId:'one',extraExample:unused}));for(const examples of [[],Array(4).fill(modern.examples[0])])assert.throws(()=>validateData('card.enrich',{lookupId:id,senseId:'one',examples}));});
test('source ranges preserve full graphemes and exact original UTF16 offsets',()=>{
 for(const [sourceLanguage,sentence,expression,partial] of [
  ['fr','😀 Je lis au café.','café','cafe'],
  ['ar','😀 أقرأ كِتَابًا.','كِتَابًا','ك'],
  ['hi','😀 कि पढ़ो।','कि','क'],
 ] as const){
  const payload=(selected:string)=>({expression:selected,context:{sentence,targetStart:sentence.indexOf(selected),targetEnd:sentence.indexOf(selected)+selected.length},sourceLanguage,targetLanguage:'en',learnerLevel:'A2',dialect:defaultLocale(sourceLanguage)});
  assert.ok(validateRequest(request('lookup',payload(expression))));
  assert.throws(()=>validateRequest(request('lookup',payload(partial))));
 }
 assert.deepEqual([...sourceGraphemeBoundaries('😀café','fr')!],[0,2,3,4,5,7]);
});
test('missing ICU segmentation fails closed at the source-word and request boundaries',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(Intl,'Segmenter')!;
 try{
  Object.defineProperty(Intl,'Segmenter',{...descriptor,value:undefined});
  assert.equal(sourceGraphemeBoundaries('中文','zh'),null);
  assert.throws(()=>countSourceWords('中文','zh'));
  assert.throws(()=>validateRequest(request('lookup',{expression:'中文',context:{sentence:'中文',targetStart:0,targetEnd:2},sourceLanguage:'zh',targetLanguage:'en',learnerLevel:'A2',dialect:'zh-CN'})));
 }finally{Object.defineProperty(Intl,'Segmenter',descriptor);}
});
test('v1 retains historical partial-grapheme acceptance without weakening v2 or new lookups',()=>{
 const draft={...legacy,expression:'cafe',lemma:'cafe',context:{sentence:'A café.',targetStart:2,targetEnd:6}};
 const before=JSON.stringify(draft);assert.deepEqual(validateNoteDraft(draft),draft);assert.equal(JSON.stringify(draft),before);
 const {extraExample:ignored,...rest}=draft;
 assert.throws(()=>validateNoteDraft({...rest,draftVersion:2,learnerLevel:'A2',selectedSense:{id:'one',translations:['кафе'],definition:'A small restaurant.'},examples:[]}));
 assert.throws(()=>validateRequest(request('lookup',{expression:draft.expression,context:draft.context,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'A2',dialect:'en-US'})));
 for(const invalid of [{...draft,context:{...draft.context,targetStart:3}}, {...draft,expression:'one two three four five six',context:{sentence:'one two three four five six',targetStart:0,targetEnd:27}}, {...draft,expression:'a\ud83d',context:{sentence:'a😀',targetStart:0,targetEnd:2}}])assert.throws(()=>validateNoteDraft(invalid));
});
test('frozen v1 word rules preserve compound boundaries and agree with new English counting',()=>{
 for(const [text,count] of [["can't",1],['well-known',1],['well‐known',1],['well‑known',1],['one--two',2],['one,two',2],['café',1],['one two three four well-known',5],['one two three four five six',6],['!!!',0]] as const){
  assert.equal(countEnglishWords(text),count);assert.equal(countSourceWords(text,'en'),count);
 }
});
test('model initialization accepts explicit legacy/current versions and rejects unsupported selectors',()=>{
 for(const payload of [{},{modelVersion:1},{modelVersion:2}])assert.ok(validateRequest(request('anki.initializeModels',payload)));
 for(const payload of [{modelVersion:0},{modelVersion:3},{modelVersion:'1'},{modelVersion:1,all:true}])assert.throws(()=>validateRequest(request('anki.initializeModels',payload)));
});
