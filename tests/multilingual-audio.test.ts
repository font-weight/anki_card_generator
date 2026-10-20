import test from 'node:test';
import assert from 'node:assert/strict';
import {LANGUAGES,type LanguageCode} from '../packages/contracts/src/index.ts';
import {AudioService,freezeAudioInput,validateAudioSnapshot,createAudioInputCacheKey,createDraftAudioSnapshot,type AudioCache,type LocalAudioEntry,type MultilingualAudioDraft,type AudioDraft} from '../packages/services/src/audio.ts';
import {PronunciationService} from '../packages/services/src/pronunciation.ts';
const bytes=new Uint8Array([0x49,0x44,0x33,4,0,0,0,0,0,0,1]);
const makeCache=():AudioCache=>{const entries:LocalAudioEntry[]=[];return{getByCacheKey:async key=>entries.find(e=>e.cacheKey===key)??null,getById:async id=>entries.find(e=>e.audioId===id)??null,put:async e=>{entries.push(e);}};};
const draft:MultilingualAudioDraft={draftVersion:2,sourceLanguage:'fr',targetLanguage:'ru',expression:'bonjour',lemma:'bonjour',partOfSpeech:'interjection',selectedSense:{id:'hello',translations:['привет'],definition:'Une salutation.'},context:{sentence:'Je dis bonjour.',targetStart:7,targetEnd:14},pronunciation:{ipa:'/bɔ̃ʒuʁ/',dialect:'fr-FR',source:'generated',sourceUrl:null}};
test('v1 audio snapshot literal and hash remain identical after multilingual rollout',async()=>{
 const frozen=freezeAudioInput({text:'read',context:'I read yesterday.',pronunciation:'/rɛd/',dialect:'en-GB',speed:.8,cacheDiscriminator:'legacy-fixed'});
 assert.equal(JSON.stringify(frozen),'{"snapshotVersion":1,"text":"read","context":"I read yesterday.","pronunciation":"/rɛd/","cacheDiscriminator":"legacy-fixed","dialect":"en-GB","speed":0.8,"voice":"coral","model":"gpt-4o-mini-tts","format":"mp3"}');
 assert.equal(await createAudioInputCacheKey(frozen),'sha256:f1e163d2863229198201b5715005f6bcdf4d811f660405749a372fac57c6ce0c');
 assert.deepEqual(validateAudioSnapshot(structuredClone(frozen)),frozen);
 assert.throws(()=>validateAudioSnapshot({...frozen,sourceLanguage:'en'}),{code:'AUDIO_UNAVAILABLE'});
});
test('v1 reviewed-draft semantic discriminator and cache key retain original golden values',async()=>{
 const legacy:AudioDraft={expression:'read',lemma:'read',partOfSpeech:'verb',selectedSense:{id:'id',translations:['читать'],definitionEn:'Understand written words.'},context:{sentence:'I read the book yesterday.',targetStart:2,targetEnd:6},pronunciation:{ipa:'/rɛd/',dialect:'unknown',source:'generated',sourceUrl:null}};
 const snapshot=await createDraftAudioSnapshot(legacy,{dialect:'en-GB',speed:.8});
 assert.equal(snapshot.snapshotVersion,1);assert.equal(snapshot.cacheDiscriminator,'draft-v1:0046cdfc20d4859e34763655d9c655cbffcd256ec03d9051c0470af5ec8009f4');
 assert.equal(await createAudioInputCacheKey(snapshot),'sha256:56b1440b746ece717bd5147ee3ef497da713e5a1622102325512a1bbc145b41e');
});
test('v2 freezes source pair, locale and semantic meaning independently of changed preferences',async()=>{
 const mutable=structuredClone(draft),preferences={dialect:'fr-FR' as const,speed:.85};const pending=createDraftAudioSnapshot(mutable,preferences);mutable.targetLanguage='de';mutable.selectedSense.translations[0]='changed';preferences.speed=2;const snapshot=await pending;
 assert.equal(snapshot.snapshotVersion,2);if(snapshot.snapshotVersion!==2)assert.fail('expected v2');assert.equal(snapshot.sourceLanguage,'fr');assert.equal(snapshot.targetLanguage,'ru');assert.equal(snapshot.locale,'fr-FR');assert.equal(snapshot.speed,.85);assert.equal(Object.isFrozen(snapshot),true);
 assert.deepEqual(validateAudioSnapshot(structuredClone(snapshot)),snapshot);
 const changed=await createDraftAudioSnapshot({...draft,targetLanguage:'de' as const},{dialect:'fr-FR',speed:.85});assert.notEqual(await createAudioInputCacheKey(changed),await createAudioInputCacheKey(snapshot));
 const sameLanguage=await createDraftAudioSnapshot({...draft,targetLanguage:'fr' as const},{dialect:'fr-FR',speed:.85});assert.equal(sameLanguage.snapshotVersion,2);
});
test('all 17 source languages get distinct source-locale audio identity; no English fallback',async()=>{
 const keys=new Set<string>();for(const language of LANGUAGES){const snapshot=freezeAudioInput({text:'same',sourceLanguage:language.code,targetLanguage:'ru',locale:language.locale});keys.add(await createAudioInputCacheKey(snapshot));assert.equal(snapshot.snapshotVersion,2);assert.equal(snapshot.dialect,language.locale);}assert.equal(keys.size,17);
 assert.throws(()=>freezeAudioInput({text:'bonjour',sourceLanguage:'fr',targetLanguage:'ru',locale:'en-US'}),{code:'INVALID_INPUT'});
 assert.throws(()=>freezeAudioInput({text:'bonjour',sourceLanguage:'xx' as LanguageCode,targetLanguage:'ru'}),{code:'INVALID_INPUT'});
});
test('v2 persisted snapshots reject source/locale mismatch and missing or injected identity fields',()=>{
 const snapshot=freezeAudioInput({text:'bonjour',sourceLanguage:'fr',targetLanguage:'ru',locale:'fr-FR'});
 for(const changed of [{...snapshot,locale:'en-US'},{...snapshot,targetLanguage:null},{...snapshot,sourceLanguage:'unknown'},{...snapshot,extra:true},{...snapshot,voice:'other'}])assert.throws(()=>validateAudioSnapshot(changed),{code:'AUDIO_UNAVAILABLE'});
 const missing={...snapshot} as Record<string,unknown>;delete missing.sourceLanguage;assert.throws(()=>validateAudioSnapshot(missing),{code:'AUDIO_UNAVAILABLE'});
});
test('mock TTS uses frozen non-English source locale and never English pronunciation instructions',async()=>{
 let body:Record<string,unknown>|undefined;const audio=new AudioService({fetch:async(_url,options)=>{body=JSON.parse(String(options?.body));return new Response(bytes,{headers:{'content-type':'audio/mpeg'}});},getOpenAIKey:()=> 'test-only',hasCloudAudioConsent:()=>true,cache:makeCache()});
 const snapshot=await createDraftAudioSnapshot(draft,{dialect:'fr-FR',speed:1});const result=await audio.prepare(snapshot);assert.equal(result.metadata.dialect,'fr-FR');assert.equal(result.metadata.sourceLanguage,'fr');assert.equal(body?.input,'bonjour');assert.match(String(body?.instructions),/fr-FR/);assert.doesNotMatch(String(body?.instructions),/American|British/);assert.equal(body?.model,'gpt-4o-mini-tts');
});
test('mock local preview requires exact local source locale and propagates it to playback',async()=>{
 let spoken:unknown;const audio=new AudioService({fetch:async()=>{throw Error('must not fetch');},getOpenAIKey:()=>null,hasCloudAudioConsent:()=>false,cache:makeCache(),playback:{playMp3:async()=>{},listVoices:async()=>[{voiceURI:'fr-local',lang:'fr_FR',localService:true},{voiceURI:'en-local',lang:'en-US',localService:true}],speakLocal:async input=>{spoken=input;}}});
 await audio.playLocal({text:'bonjour',sourceLanguage:'fr',locale:'fr-FR'});assert.deepEqual(spoken,{text:'bonjour',dialect:'fr-FR',locale:'fr-FR',sourceLanguage:'fr',speed:1,voiceURI:'fr-local'});
 await assert.rejects(audio.playLocal({text:'こんにちは',sourceLanguage:'ja',locale:'ja-JP'}),{code:'AUDIO_UNAVAILABLE'});
 await assert.rejects(audio.playLocal({text:'bonjour',sourceLanguage:'fr',locale:'en-US'}),{code:'INVALID_INPUT'});
});
test('non-English pronunciation never invokes English dictionary, including Latin-spelled words',async()=>{
 let fetched=0;const service=new PronunciationService({fetch:async()=>{fetched++;throw Error('never');},hasDictionaryConsent:()=>true});
 for(const language of LANGUAGES.filter(l=>l.code!=='en')){const result=await service.get({expression:'bank',sourceLanguage:language.code,dialect:language.locale,generatedCandidate:{ipa:'/test/',dialect:language.locale}});assert.equal(result.pronunciation.source,'generated');assert.ok(result.warnings.includes('GENERATED_IPA_APPROXIMATE'));assert.ok(result.warnings.includes('DICTIONARY_LANGUAGE_UNSUPPORTED'));assert.equal(result.alternatives.length,0);}
 assert.equal(fetched,0);const unavailable=await service.get({expression:'bonjour',sourceLanguage:'fr',dialect:'fr-FR'});assert.equal(unavailable.pronunciation.source,'unavailable');assert.equal(unavailable.pronunciation.ipa,null);
 await assert.rejects(service.get({expression:'bonjour',sourceLanguage:'fr',dialect:'fr-FR',generatedCandidate:{ipa:'/test/',dialect:'en-US'}}),{code:'INVALID_INPUT'});
 await assert.rejects(service.get({expression:'bank',sourceLanguage:null,dialect:'en-US'} as any),{code:'INVALID_INPUT'});assert.equal(fetched,0);
});

test('malformed versioned cache inputs cannot silently downgrade to legacy identity',async()=>{
 const legacy=freezeAudioInput({text:'hello'});
 const multilingual=freezeAudioInput({text:'bonjour',sourceLanguage:'fr',targetLanguage:'ru',locale:'fr-FR'});
 const malformed=[{...legacy,snapshotVersion:2},{...legacy,snapshotVersion:99},{...legacy,voice:'other'},
  {...multilingual,locale:undefined},{...multilingual,targetLanguage:undefined},{...multilingual,sourceLanguage:undefined}];
 for(const input of malformed)await assert.rejects(createAudioInputCacheKey(input as any),{code:'AUDIO_UNAVAILABLE'});
});

test('local preview snapshots text and language before waiting for installed voices',async()=>{
 let resolveVoices!:(voices:{voiceURI:string;lang:string;localService:boolean}[])=>void;
 let spoken:unknown;
 const audio=new AudioService({fetch:async()=>{throw Error('must not fetch');},getOpenAIKey:()=>null,hasCloudAudioConsent:()=>false,cache:makeCache(),
  playback:{playMp3:async()=>{},listVoices:()=>new Promise(resolve=>{resolveVoices=resolve;}),speakLocal:async input=>{spoken=input;}}});
 const input={text:'bonjour',sourceLanguage:'fr' as LanguageCode,locale:'fr-FR' as const,speed:.8};
 const pending=audio.playLocal(input);input.text='changed';input.sourceLanguage='en';input.speed=2;
 resolveVoices([{voiceURI:'fr-local',lang:'fr-FR',localService:true}]);await pending;
 assert.deepEqual(spoken,{text:'bonjour',sourceLanguage:'fr',locale:'fr-FR',dialect:'fr-FR',speed:.8,voiceURI:'fr-local'});
 await assert.rejects(audio.playLocal({text:'bonjour\u0000',sourceLanguage:'fr',locale:'fr-FR'}),{code:'INVALID_INPUT'});
 for(const invalid of [{sourceLanguage:null},{locale:null},{dialect:null},{speed:null}])await assert.rejects(audio.playLocal({text:'hello',...invalid} as any),{code:'INVALID_INPUT'});
});

test('legacy and v2 EN→RU cache namespaces never collide or share a paid result',async()=>{
 const requests:Record<string,unknown>[]=[];
 const audio=new AudioService({fetch:async(_url,options)=>{requests.push(JSON.parse(String(options?.body)));return new Response(bytes,{headers:{'content-type':'audio/mpeg'}});},getOpenAIKey:()=> 'test-only',hasCloudAudioConsent:()=>true,cache:makeCache()});
 const legacy=freezeAudioInput({text:'hello'}),v2=freezeAudioInput({text:'hello',sourceLanguage:'en',targetLanguage:'ru',locale:'en-US'});
 assert.notEqual(await createAudioInputCacheKey(legacy),await createAudioInputCacheKey(v2));
 const [first,second]=await Promise.all([audio.prepare(legacy),audio.prepare(v2)]);
 assert.notEqual(first.metadata.audioId,second.metadata.audioId);assert.equal(requests.length,2);
 assert.equal((await audio.prepare(legacy)).cacheHit,true);assert.equal((await audio.prepare(v2)).cacheHit,true);assert.equal(requests.length,2);
});

test('v2 source-local defaults never use a changed language preference and keep all meaning fields in identity',async()=>{
 const unverified={...draft,pronunciation:{ipa:null,dialect:'unknown' as const,source:'unavailable' as const,sourceUrl:null}};
 const base=await createDraftAudioSnapshot(unverified,{dialect:'en-US',speed:1});
 assert.equal(base.dialect,'fr-FR');
 const stable=await createDraftAudioSnapshot({...unverified,selectedSense:{...unverified.selectedSense,id:'provider-rerolled-id'}},{dialect:'fr-FR',speed:1});
 assert.equal(await createAudioInputCacheKey(base),await createAudioInputCacheKey(stable));
 for(const changed of [
  {...unverified,targetLanguage:'fr' as const},
  {...unverified,selectedSense:{...unverified.selectedSense,definition:'Autre sens.'}},
  {...unverified,selectedSense:{...unverified.selectedSense,translations:['здравствуйте']}},
  {...unverified,context:{...unverified.context,sentence:'Tu dis bonjour.'}},
  {...unverified,context:{...unverified.context,targetStart:8,targetEnd:15}},
 ])assert.notEqual(await createAudioInputCacheKey(await createDraftAudioSnapshot(changed,{dialect:'fr-FR',speed:1})),await createAudioInputCacheKey(base));
});

test('all supported source locales use their own mock TTS instructions without target text disclosure',async()=>{
 let sent:Record<string,unknown>|undefined;
 const audio=new AudioService({fetch:async(_url,options)=>{sent=JSON.parse(String(options?.body));return new Response(bytes,{headers:{'content-type':'audio/mpeg'}});},getOpenAIKey:()=> 'test-only',hasCloudAudioConsent:()=>true,cache:makeCache()});
 for(const language of LANGUAGES){
  await audio.prepare({text:'same',sourceLanguage:language.code,targetLanguage:'ru',locale:language.locale,cacheDiscriminator:'private-target-meaning'});
  assert.match(String(sent?.instructions),new RegExp(language.locale));assert.match(String(sent?.instructions),/Do not translate/);
  assert.equal(sent?.input,'same');assert.equal(JSON.stringify(sent).includes('private-target-meaning'),false);
  if(language.code==='ar')assert.match(String(sent?.instructions),/Modern Standard Arabic/);
  if(language.code==='zh')assert.match(String(sent?.instructions),/Standard Mandarin Chinese/);
 }
});
