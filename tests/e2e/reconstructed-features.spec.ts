/** Production-bundle smoke tests with synthetic text and an in-page RPC fixture.
 * No credentials, provider calls, installed extension profile or personal Anki.
 * Authored here but NOT EXECUTED in the reconstruction environment: Chromium's
 * sandbox could not create its local socket; do not bypass that restriction. */
import {test,expect,chromium,type BrowserContext,type Page} from '@playwright/test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
let context:BrowserContext,profile:string,extensionId:string;
const source='The sky clouded over quickly.';
function syntheticEpub(){
 const files:Record<string,string>={
  mimetype:'application/epub+zip',
  'META-INF/container.xml':'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'book.opf':'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">synthetic-activation</dc:identifier><dc:title>Synthetic activation</dc:title><dc:language>en</dc:language></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="text"/></spine></package>',
  'toc.ncx':'<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="synthetic-activation"/></head><docTitle><text>Synthetic activation</text></docTitle><navMap><navPoint id="one" playOrder="1"><navLabel><text>Synthetic chapter</text></navLabel><content src="text.xhtml"/></navPoint></navMap></ncx>',
  'text.xhtml':`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>Synthetic chapter</title></head><body><p id="source">The sky <b id="word">clouded</b> over quickly.</p></body></html>`,
 };
 return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)]))));
}
test.beforeAll(async()=>{
 const extensionPath=path.resolve('dist/english-reader');await readFile(path.join(extensionPath,'manifest.json'));
 profile=await mkdtemp(path.join(tmpdir(),'reader-reconstructed-features-'));
 context=await chromium.launchPersistentContext(profile,{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,'--no-sandbox']});
 // Abort every external provider, web and loopback/Anki request. The only web
 // fixture below is fulfilled from an inline synthetic string.
 await context.route(/^https?:\/\//,route=>route.request().url()==='https://reader-fixture.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><button id="focus">Toolbar focus</button><p id="source">The sky <b id="word">clouded</b> over quickly.</p></body></html>'}):route.abort());
 await context.addInitScript(()=>{
  const state=window as any;state.__readerCalls=[];state.__grammarEnabled=location.search.includes('grammar=on');
  const chromeApi=state.chrome??(state.chrome={});chromeApi.runtime??={};
  chromeApi.runtime.sendMessage=async(message:any)=>{
   state.__readerCalls.push(structuredClone(message));const payload=message.payload||{};
   let data:any={};
   if(message.type==='settings.getReader')data={sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US',grammarEnabled:state.__grammarEnabled,grammarIncludeExplanation:true,grammarExplanationLanguage:'ru',defaultDeck:'Synthetic only',cloudAudioEnabled:false};
   else if(message.type==='lookup'){
    const candidate=payload.phrasalCandidates?.find((item:any)=>item.expression==='clouded over');
    data={lookupId:'11111111-1111-4111-8111-111111111111',expression:candidate?.expression||payload.expression,lemma:candidate?.lemma||payload.expression,partOfSpeech:'verb',recommendedSenseId:'sense',contextAmbiguous:false,senses:[{id:'sense',translations:['затянулось облаками'],definition:'To become covered in clouds.'}],ipaCandidate:null,...(candidate?{resolvedTarget:{candidateId:candidate.id,targetStart:candidate.targetStart,targetEnd:candidate.targetEnd}}:{})};
   }else if(message.type==='pronunciation.get')data={pronunciation:{ipa:'/klaʊd/',dialect:'en-US',source:'generated',sourceUrl:null}};
   else if(message.type==='grammar.lookup'){
    const targetStart=payload.sentence.indexOf('clouded over');
    data={grammarId:'22222222-2222-4222-8222-222222222222',sentence:payload.sentence,construction:{text:'clouded over',targetStart,targetEnd:targetStart+12},question:'Какая форма использована?',answer:'Past Simple.',rule:'Завершённое действие в прошлом.',explanation:'Форма clouded выражает прошедшее время.',translation:'Небо быстро затянулось облаками.'};
   }
   return {v:1,requestId:message.requestId,ok:true,data};
  };
 });
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');extensionId=new URL(worker.url()).host;
});
test.afterAll(async()=>{await context?.close();if(profile)await rm(profile,{recursive:true,force:true});});
async function calls(page:Page,type:string){return page.evaluate(type=>(window as any).__readerCalls.filter((message:any)=>message.type===type),type);}
async function openBook(enabled=false){
 const page=await context.newPage();await page.goto(`chrome-extension://${extensionId}/library.html${enabled?'?grammar=on':''}`);
 await page.locator('input[type=file]').setInputFiles({name:'synthetic.epub',mimeType:'application/epub+zip',buffer:syntheticEpub()});
 const book=page.frameLocator('.er-epub-viewport iframe').first();await expect(book.locator('#word')).toBeVisible();
 await expect.poll(async()=>(await calls(page,'settings.getReader')).length).toBeGreaterThan(0);
 await page.evaluate(()=>{const button=document.createElement('button');button.id='external-focus';button.textContent='Synthetic outside-frame focus';document.body.prepend(button);});
 await page.locator('#external-focus').focus();await book.locator('#word').hover();
 return {page,book};
}
test('HTML hover is local; Shift sends one contextual candidate lookup; manual selection wins',async()=>{
 const page=await context.newPage();await page.goto('https://reader-fixture.test/');await page.addScriptTag({path:path.resolve('dist/english-reader/content.js')});
 await page.locator('#focus').focus();await page.locator('#word').hover();expect(await calls(page,'lookup')).toHaveLength(0);expect(await calls(page,'grammar.lookup')).toHaveLength(0);
 await page.keyboard.press('Shift');await expect.poll(async()=>(await calls(page,'lookup')).length).toBe(1);
 const translation=page.getByRole('dialog',{name:'Контекстный перевод'});
 await expect(translation.locator('.pronunciation')).toHaveText('[klaʊd]');
 await expect(translation.locator('.pronunciation')).not.toContainText('приблизительно');
 await expect(translation.getByRole('button',{name:'Прослушать выражение системным голосом'})).toBeVisible();

 const first=(await calls(page,'lookup'))[0].payload;expect(first.expression).toBe('clouded');expect(first.phrasalCandidates).toEqual(expect.arrayContaining([expect.objectContaining({expression:'clouded over'})]));
 await page.locator('#word').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=document.getSelection()!;selection.removeAllRanges();selection.addRange(range);});
 await page.keyboard.press('Shift');await expect.poll(async()=>(await calls(page,'lookup')).length).toBe(2);expect((await calls(page,'lookup'))[1].payload).not.toHaveProperty('phrasalCandidates');expect(await page.locator('#source').textContent()).toBe(source);await page.close();
});
test('EPUB hover Shift works with focus outside its iframe; grammar stays off by default',async()=>{
 const {page,book}=await openBook();expect(await page.evaluate(()=>document.activeElement?.id)).toBe('external-focus');expect(await calls(page,'lookup')).toHaveLength(0);
 await page.keyboard.press('Alt');expect(await calls(page,'grammar.lookup')).toHaveLength(0);
 await page.keyboard.press('Shift');await expect.poll(async()=>(await calls(page,'lookup')).length).toBe(1);expect((await calls(page,'lookup'))[0].payload.context.sentence.trim()).toBe(source);expect(await book.locator('#source').textContent()).toBe(source);await page.close();
});
test('opted-in EPUB clean LeftAlt generates once; chord cancels; fallback reopen stays preview-only',async()=>{
 const {page,book}=await openBook(true);
 await page.keyboard.down('Alt');await page.keyboard.press('a');await page.keyboard.up('Alt');expect(await calls(page,'grammar.lookup')).toHaveLength(0);
 await page.keyboard.press('Alt');await expect.poll(async()=>(await calls(page,'grammar.lookup')).length).toBe(1);expect((await calls(page,'grammar.lookup'))[0].payload.sentence.trim()).toBe(source);
 await expect(page.getByRole('dialog',{name:'Разбор предложения по левому Alt'})).toBeVisible();await page.keyboard.press('Escape');
 await page.locator('#external-focus').focus();await book.locator('#word').hover();await page.keyboard.press('Shift');await page.getByText('Дополнительные действия',{exact:true}).click();await expect(page.getByRole('button',{name:'Разбор предложения по левому Alt'})).toBeVisible();await page.getByRole('button',{name:'Разбор предложения по левому Alt'}).click();
 await expect(page.getByRole('button',{name:'Разобрать предложение'})).toBeVisible();expect(await calls(page,'grammar.lookup')).toHaveLength(1);expect(await calls(page,'grammar.addNote')).toHaveLength(0);expect(await calls(page,'audio.prepare')).toHaveLength(0);await page.close();
});

for (const mode of ['HTML', 'EPUB'] as const) test(`${mode} Shift reading marker survives popup dismissal and is replaced locally`, async () => {
 const opened = mode === 'EPUB' ? await openBook() : null;
 const page = opened?.page ?? await context.newPage();
 if (!opened) {
  await page.goto('https://reader-fixture.test/');
  await page.addScriptTag({path:path.resolve('dist/english-reader/content.js')});
  await page.locator('#focus').focus();
 }
 const sourceLocator = opened ? opened.book.locator('#source') : page.locator('#source');
 const word = opened ? opened.book.locator('#word') : page.locator('#word');
 const markedText = () => sourceLocator.evaluate(node => {
  const registry = (node.ownerDocument.defaultView as any).CSS?.highlights;
  const highlight = registry?.get('english-reader-reading-position');
  return highlight ? Array.from(highlight as Set<Range>).map(range => range.toString()).join('') : null;
 });
 await word.hover(); expect(await markedText()).toBeNull();
 await page.keyboard.press('Shift');
 await expect.poll(markedText).toBe('clouded');
 await expect.poll(async()=>(await calls(page,'lookup')).length).toBe(1);
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await markedText()).toBe('clouded');
 // A new explicit manual selection is equally a reading position and must not
 // leave the old word highlighted or rewrite the original source DOM.
 await sourceLocator.evaluate(node => {
  const doc = node.ownerDocument, text = node.firstChild!;
  const range = doc.createRange(); range.setStart(text, 4); range.setEnd(text, 7);
  doc.getSelection()!.removeAllRanges(); doc.getSelection()!.addRange(range);
 });
 await word.hover(); await page.keyboard.press('Shift');
 await expect.poll(markedText).toBe('sky');
 await expect.poll(async()=>(await calls(page,'lookup')).length).toBe(2);
 expect(await sourceLocator.textContent()).toBe(source);
 expect(await sourceLocator.locator('b').count()).toBe(1);
 await page.keyboard.press('Escape'); expect(await markedText()).toBe('sky');
 await page.close();
});


test('book themes color open lookup and grammar surfaces while Anki previews stay light',async()=>{
 const {page,book}=await openBook(true);
 await page.emulateMedia({colorScheme:'dark'});
 const shell=page.locator('.rc-shell');
 for(const key of ['Shift','Alt'] as const){
  await shell.evaluate(node=>{(node as HTMLElement).dataset.readerTheme='cream';});
  await book.locator('#word').hover();await page.keyboard.press(key);
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('background-color','rgb(246, 240, 220)');
  await expect(dialog).toHaveCSS('color-scheme','light');
  await shell.evaluate(node=>{(node as HTMLElement).dataset.readerTheme='graphite';});
  await expect(dialog).toHaveCSS('background-color','rgb(59, 59, 63)');
  await expect(dialog).toHaveCSS('color','rgb(246, 245, 248)');
  await expect(dialog).toHaveCSS('color-scheme','dark');
  await dialog.getByRole('button',{name:'Предпросмотр',exact:true}).click();
  const frame=dialog.locator('iframe.preview').first();
  await expect(frame).toHaveCSS('background-color','rgb(255, 255, 255)');
  await expect(frame).toHaveCSS('color-scheme',/^(?:only light|light only)$/);
  await expect(dialog.frameLocator('iframe.preview').first().locator('body')).toHaveCSS('color','rgb(0, 0, 0)');
  await page.keyboard.press('Escape');
 }
 await page.close();
});
