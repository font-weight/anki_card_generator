import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteFields, modelDefinition, renderPreview, semanticKeys, MODEL_NAMES, MULTILINGUAL_MODEL_NAMES, NOTE_FIELDS } from '../packages/note-templates/src/index.ts';
import { AnkiClient } from '../packages/services/src/anki.ts';
import type { MultilingualNoteDraft, LegacyNoteDraft } from '../packages/contracts/src/index.ts';
const id='11111111-1111-4111-8111-111111111111';
const draft=():MultilingualNoteDraft=>({draftVersion:2,sourceLanguage:'fr',targetLanguage:'ru',learnerLevel:'B1',mode:'recognition',deckName:'Test',tags:[],expression:'chat',lemma:'chat',partOfSpeech:'noun',selectedSense:{id:'cat',translations:['кот'],definition:'Un petit animal domestique.'},context:{sentence:'Le chat dort.',targetStart:3,targetEnd:7},pronunciation:{ipa:null,dialect:'unknown',source:'unavailable',sourceUrl:null},examples:[{text:'Le chat joue.',translation:'Кот играет.',source:'ai'}],source:{kind:'html',title:'Page',url:'https://example.com/?secret=x',documentId:null,page:null,chapter:null,cfi:null}});
test('v2 models are separate, one card, back-only examples and language-isolated text',()=>{
 for(const mode of ['recognition','cloze'] as const){const m=modelDefinition(mode,2);assert.equal(m.modelName,MULTILINGUAL_MODEL_NAMES[mode]);assert.equal(m.cardTemplates.length,1);assert.ok(!m.cardTemplates[0]!.Front.includes('{{Examples}}'));assert.ok(!m.cardTemplates[0]!.Front.includes('{{Meaning}}'));assert.match(m.cardTemplates[0]!.Back,/dir="auto"/);assert.ok(m.inOrderFields.includes('SourceLanguage'));}
 const old=modelDefinition('recognition');assert.equal(old.modelName,MODEL_NAMES.recognition);assert.deepEqual(old.inOrderFields,NOTE_FIELDS);
});
test('neutral field mapping, exact source and selected examples only',async()=>{
 const d=draft(), f=buildNoteFields(id,d,await semanticKeys(d));assert.equal(f.Definition,d.selectedSense.definition);assert.equal(f.SourceLanguage,'fr');assert.equal(f.TargetLanguage,'ru');assert.equal(f.DefinitionEN,undefined);assert.match(f.Examples!,/Le chat joue/);assert.equal(f.SourceURL,'https&#58;//example.com/');assert.equal(f.Sentence,'Le chat dort.');
 const preview=renderPreview(d);assert.ok(!preview.front.includes('Кот играет'));assert.ok(preview.back.includes('Кот играет'));assert.ok(!preview.back.includes('{{'));d.examples=[];assert.equal(buildNoteFields(id,d,await semanticKeys(d)).Examples,'');
});
test('hostile generated examples are inert and paired across RTL languages',async()=>{
 const d=draft();d.sourceLanguage='ar';d.targetLanguage='en';d.examples=[{text:'<img src=x onerror=alert(1)> {{c2::x}} [sound:x.mp3]',translation:'<script>x</script>',source:'ai'}];const f=buildNoteFields(id,d,await semanticKeys(d));assert.ok(!f.Examples!.includes('<img'));assert.ok(!f.Examples!.includes('{{c2'));assert.ok(!f.Examples!.includes('[sound:'));assert.match(f.Examples!,/lang="ar"/);assert.match(f.Examples!,/lang="en"/);
});
test('pair isolation and examples/level do not change lexical duplicate identity',async()=>{
 const a=draft(),ak=await semanticKeys(a);const b=structuredClone(a);b.targetLanguage='de';assert.notEqual(ak.lexemeKey,(await semanticKeys(b)).lexemeKey);b.targetLanguage='ru';b.learnerLevel='C1';b.examples=[];assert.deepEqual(ak,await semanticKeys(b));
});
test('new en-ru notes still discover old lexical duplicates without rewriting legacy content keys',async()=>{
 const a=draft();a.sourceLanguage='en';const legacy:LegacyNoteDraft={sourceLanguage:'en',targetLanguage:'ru',mode:a.mode,deckName:a.deckName,tags:a.tags,expression:a.expression,lemma:a.lemma,partOfSpeech:a.partOfSpeech,selectedSense:{id:'cat',translations:['кот'],definitionEn:a.selectedSense.definition},context:a.context,pronunciation:{ipa:null,dialect:"unknown",source:"unavailable",sourceUrl:null},extraExample:null,source:a.source};
 const before=JSON.stringify(legacy),old=await semanticKeys(legacy),next=await semanticKeys(a);assert.equal(old.lexemeKey,next.lexemeKey);assert.notEqual(old.contentKey,next.contentKey);assert.equal(JSON.stringify(legacy),before);
});
test('Anki prepares version-specific model and v2 exact cloze without touching source',async()=>{
 const a=draft();a.mode='cloze';const note=new AnkiClient().prepareNote(id,a,await semanticKeys(a));assert.equal(note.modelName,MULTILINGUAL_MODEL_NAMES.cloze);assert.equal(note.fields.ClozeSentence,'Le {{c1::chat}} dort.');assert.equal(a.context.sentence,'Le chat dort.');
});
