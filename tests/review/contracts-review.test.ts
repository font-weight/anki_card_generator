// @vitest-environment node
import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {buildNoteFields,safeSourceUrl} from '../../packages/note-templates/src/index';
import {extractFromRange} from '../../apps/extension/src/content/extraction';
import {readFileSync} from 'node:fs';
import {validateRequest,validateNoteDraft,validateData,type NoteDraft} from '../../packages/contracts/src/index';
const id='12345678-1234-4234-8234-123456789abc';
const lookup={expression:'bank',context:{sentence:'The bank near the bank.',targetStart:18,targetEnd:22},sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US'};
const request=(payload:unknown,type='lookup')=>({v:1,requestId:id,type,payload});
const draft=():NoteDraft=>({sourceLanguage:'en',targetLanguage:'ru',mode:'cloze',deckName:'Default',tags:[],expression:'bank',lemma:'bank',partOfSpeech:'noun',selectedSense:{id:'river',translations:['берег'],definitionEn:'Land beside a river.'},context:{...lookup.context},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},extraExample:null,source:{kind:'html',title:'Title',url:'https://example.test/read',documentId:null,page:null,chapter:null,cfi:null}});
const data=()=>({lookupId:id,expression:'bank',lemma:'bank',partOfSpeech:'noun',recommendedSenseId:'river',contextAmbiguous:false,senses:[{id:'river',translations:['берег'],definitionEn:'Land beside a river.'}],ipaCandidate:null,extraExample:null});
describe('independent A contract adversarial review',()=>{
 it('accepts exact second occurrence and rejects malformed bounds',()=>{
  expect(()=>validateRequest(request(lookup))).not.toThrow();
  for(const context of [{...lookup.context,targetStart:-1},{...lookup.context,targetStart:18.5},{...lookup.context,targetEnd:99},{...lookup.context,targetStart:22},{...lookup.context,targetStart:4,targetEnd:7}]) expect(()=>validateRequest(request({...lookup,context}))).toThrow();
 });
 it('rejects surrogate split even where slice equals expression',()=>{
  expect(()=>validateRequest(request({...lookup,expression:'\ud83d',context:{sentence:'😀 bank',targetStart:0,targetEnd:1}}))).toThrow();
 });
 it('enforces total context and word budget plus language and dialect enums',()=>{
  for(const patch of [{context:{...lookup.context,before:'x'.repeat(1500)}},{expression:'one two three four five six',context:{sentence:'one two three four five six',targetStart:0,targetEnd:27}},{dialect:'en-AU'},{sourceLanguage:'de'},{targetLanguage:'en'},{learnerLevel:'C2'}]) expect(()=>validateRequest(request({...lookup,...patch}))).toThrow();
 });
 it('rejects direct unknown keys and wrong RPC version',()=>{
  expect(()=>validateRequest({...request(lookup),unexpected:true})).toThrow();expect(()=>validateRequest({...request(lookup),v:2})).toThrow();
 });
 it('rejects unsafe URL schemes and embedded credentials',()=>{
  for(const url of ['javascript:alert(1)','file:///C:/Users/Alice/book.pdf','https://alice:secret@example.test/']){const d=draft();d.source.url=url;expect(()=>validateNoteDraft(d)).toThrow();}
 });
 it('rejects source-kind contradictions and zero-based PDF pages',()=>{
  for(const source of [{...draft().source,page:1},{...draft().source,kind:'pdf',documentId:'local-id',page:0},{...draft().source,kind:'pdf',documentId:'local-id',page:1,cfi:'epubcfi(/6/2)'},{...draft().source,kind:'epub',documentId:'local-id',page:1}]) expect(()=>validateNoteDraft({...draft(),source})).toThrow();
 });
 it('rejects provenance contradictions and more than two selected translations',()=>{
  expect(()=>validateNoteDraft({...draft(),pronunciation:{ipa:'/bæŋk/',dialect:'en-US',source:'generated',sourceUrl:'https://dictionary.test/bank'}})).toThrow();
  expect(()=>validateNoteDraft({...draft(),selectedSense:{...draft().selectedSense,translations:['a','b','c']}})).toThrow();
 });
 it('rejects duplicate senses, invalid recommendation, over-budget meanings',()=>{
  for(const patch of [{recommendedSenseId:'missing'},{contextAmbiguous:true},{senses:[...data().senses,...data().senses]},{senses:Array.from({length:5},(_,i)=>({...data().senses[0],id:String(i)}))}])expect(()=>validateData('lookup',{...data(),...patch})).toThrow();
 });
 it('rejects unexpected public secrets and non-loopback Anki settings',()=>{
  expect(()=>validateRequest(request({patch:{ankiEndpoint:'http://attacker.test:8765'}},'settings.update'))).toThrow();
  expect(()=>validateData('settings.getReader',{dialect:'en-US',defaultDeck:'Default',defaultMode:'cloze',includeAudioByDefault:false,key:'secret'})).toThrow();
 });
 // Corrected B artifact regressions and explicit downstream boundary checks.
 it('RESOLVED-1 rejects prototype-named additional properties',()=>{
  const value=JSON.parse(JSON.stringify(request(lookup)).replace('"v":1','"constructor":{"secret":"unvalidated"},"v":1'));
  expect(()=>validateRequest(value)).toThrow();
 });
 it('source URL query and fragment are stripped at the note rendering boundary',()=>{
  const d=draft();d.source.url='https://example.test/read?access_token=private#session=private';expect(()=>validateNoteDraft(d)).not.toThrow();
  expect(safeSourceUrl(d.source.url)).toBe('https&#58;//example.test/read');
  const fields=buildNoteFields(id,d,{lexemeKey:'lexeme',contentKey:'content'});expect(fields.SourceURL).toBe('https&#58;//example.test/read');expect(JSON.stringify(fields)).not.toContain('private');
 });
 it('RESOLVED-7 canonical word budget agrees with extraction for hyphenated fifth word',()=>{
  for(const expression of ['one two three four well-known','one two three four well‐known','one two three four well‑known',"one two three four doesn't",'one two three four doesn’t']) expect(()=>validateRequest(request({...lookup,expression,context:{sentence:expression,targetStart:0,targetEnd:expression.length}}))).not.toThrow();
 });
 it('documented compatibility allows unavailable EPUB chapter and CFI without fabricating them',()=>{
  const d=draft();d.source={...d.source,kind:'epub',url:null,documentId:'local-book'};expect(()=>validateNoteDraft(d)).not.toThrow();
 });
 it('RESOLVED-4 validates nested queue NoteDraft semantic ranges',()=>{
  const d=draft();d.context.targetStart=0;
  const item={operationId:id,draft:d,includeAudio:false,audioId:null,duplicateAction:'review',state:'pending',attempts:0,lastError:null,noteId:null,createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z',nextAttemptAt:null};
  expect(()=>validateData('queue.list',{items:[item],nextCursor:null})).toThrow();
 });
 it('RESOLVED-6 counts punctuation-separated words consistently with HTML extraction',()=>{
  const expression='one,two,three,four,five,six';expect(()=>validateRequest(request({...lookup,expression,context:{sentence:expression,targetStart:0,targetEnd:expression.length}}))).toThrow();
 });
 it('RESOLVED-5 rejects inherited prototype keys nested in strict payload',()=>{
  const value=request(JSON.parse('{"toString":{"arbitrary":"value"}}'),'anki.status');expect(()=>validateRequest(value)).toThrow();
 });
});
describe('independent fixture integrity (not model accuracy)',()=>{
 const corpus=JSON.parse(readFileSync(new URL('../../fixtures/language.json',import.meta.url),'utf8'));
 it('all authored fixture inputs satisfy canonical request and original UTF-16 range',()=>{
  for(const f of corpus.fixtures){expect(()=>validateRequest(request(f.input)),f.id).not.toThrow();const c=f.input.context;expect(c.sentence.slice(c.targetStart,c.targetEnd),f.id).toBe(f.input.expression);}
 });
 it('shortlist exists and retains synthetic / no human gold provenance',()=>{
  for(const id of corpus.independentReviewRequest.fixtureIds){const f=corpus.fixtures.find((x:any)=>x.id===id);expect(f,id).toBeDefined();expect(f.provenance.origin).toBe('synthetic-agent-authored');expect(f.provenance.humanVetted).toBe(false);}
  expect(corpus.evaluation.liveModelEvaluation.status).toBe('not_run');expect(corpus.evaluation.targetIsMeasuredResult).toBe(false);
 });
});

describe('extraction lexical budget audit',()=>{
 it('rejects six punctuation-delimited words; preserves apostrophes and supported hyphens',()=>{
  for(const [text,ok] of [['one,two,three,four,five,six',false],["one two three four well-known",true],["one two three four doesn’t",true],['one two three four well‑known',true]] as const){
   const dom=new JSDOM('<p></p>');const doc=dom.window.document;doc.querySelector('p')!.textContent=text;const r=doc.createRange();r.selectNodeContents(doc.querySelector('p')!);expect(extractFromRange(r).ok,text).toBe(ok);dom.window.close();
  }
 });
});
