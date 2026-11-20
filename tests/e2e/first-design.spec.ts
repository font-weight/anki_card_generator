import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { grammarSentence, harbourGrammar, harbourLookup, harbourSentence } from '../fixtures/reader-design';

let context: BrowserContext, profile: string, extensionId: string;
const captures = 'test-results/first-design';
const hostname = 'https://reader-fixture.test';
const abspath = path.resolve('dist/english-reader');

test.beforeAll(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'lr-first-design-'));
  await mkdir(captures, { recursive: true });
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || (process.platform === 'linux' ? '/usr/bin/chromium' : undefined),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${abspath}`, `--load-extension=${abspath}`,
      '--disable-background-networking', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await context.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin !== hostname) return route.abort();
    return route.fulfill({contentType:'text/html', body: `<!doctype html><html lang="en"><title>The Quiet Coast</title>
      <style>body{max-width:44em;margin:5vh auto;padding:16px;font:22px/1.6 system-ui;color:#292938}h1{line-height:1.12}p{margin:1.3em 0}</style>
      <h1>The Harbour at Dawn</h1><p id="tense">By the time Mara reached the quay, the boats <b>had left</b>.</p>
      <p id="word">A <b>glimmer</b> of light appeared beyond the harbour wall.</p>
      <p id="simple">The <b>sea</b> is blue.</p></html>`});
  });
});
test.afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, {recursive:true,force:true});
});

type FixtureChatReply = {kind:'answer';answer:string} | {kind:'out_of_scope'|'model_out_of_scope'|'model_no_answer'};
async function openFixture(enabled=true,chatReplies:Record<string,FixtureChatReply>={}) {
  const page = await context.newPage();
  await page.goto(hostname);
  // Substitute only the host transport, inside an offline page. The bundled
  // content script, shadow DOM, native input events and rendered UI are real.
  await page.evaluate(({enabled,grammar,lookup,chatReplies}) => {
    const owned = window as any;
    Object.assign(owned, {fixtureCalls:[], grammarDelay:false, grammarError:false});
    const chromeApi = owned.chrome ??= {}; chromeApi.runtime ??= {};
    chromeApi.runtime.sendMessage = async (message:any) => {
      owned.fixtureCalls.push({type:message.type, payload:message.payload});
      let data:unknown = {};
      if (message.type==='settings.getReader') data={grammarEnabled:enabled, grammarExplanationLanguage:'ru', grammarIncludeExplanation:true, sourceLanguage:'en', targetLanguage:'ru', dialect:'en-US', defaultDeck:'Offline fixture'};
      if (message.type==='grammar.lookup') {
        if (owned.grammarDelay) await new Promise<void>(resolve => {owned.releaseGrammar=resolve;});
        if (owned.grammarError) return {v:1, requestId:message.requestId, ok:false, error:{code:'NETWORK_TIMEOUT',message:'Тестовый таймаут',retryable:true}};
        data = message.payload.sentence===grammar.sentence ? grammar : {grammarId:grammar.grammarId,sentence:message.payload.sentence,reason:'no_construction'};
      }
      if (message.type==='grammar.chat') {
        if (owned.deferChatReply) {
          owned.deferChatReply = false;
          await new Promise<void>(resolve => {owned.finishChatReply = resolve;});
        }
        const reply=Object.hasOwn(chatReplies,message.payload.question)?chatReplies[message.payload.question]:
          {kind:'answer',answer:'Форма had left показывает, что лодки ушли до прихода Мары.'};
        data={grammarId:message.payload.grammarId,turnId:message.payload.turnId,...reply};
      }
      if (message.type==='grammar.chat.close') data={closed:true};
      if (message.type==='lookup') data=lookup;
      if (message.type==='pronunciation.get') data={pronunciation:{ipa:'/ˈɡlɪmər/',dialect:'en-US',source:'dictionary',sourceUrl:null}};
      if (message.type==='grammar.addNote') data={operationId:message.payload.operationId,status:'added',noteId:321};
      return {v:1, requestId:message.requestId, ok:true, data};
    };
  }, {enabled,grammar:harbourGrammar,lookup:harbourLookup,chatReplies});
  await page.addScriptTag({path:path.join(abspath,'content.js')});
  return page;
}
async function count(page:Page,kind:string) {
  return page.evaluate(type=>(window as any).fixtureCalls.filter((m:any)=>m.type===type).length,kind);
}

for (const [name,width] of [['normal',1180],['narrow',390]] as const) {
  test(`grammar modes at ${width}px, provider and Anki are fixtures`, async () => {
    const page=await openFixture();
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>{(window as any).grammarDelay=true;});
    await page.locator('#tense b').hover(); await page.keyboard.press('Alt');
    await expect(page.getByText('Разбираем предложение…')).toBeVisible();
    await page.screenshot({path:`${captures}/grammar-loading-${name}.png`});
    await page.evaluate(()=>{const w=window as any;w.grammarDelay=false;w.releaseGrammar();});
    const dialog=page.getByRole('dialog');
    await expect(dialog.locator('mark')).toHaveText(harbourGrammar.construction.text);
    await expect(dialog).toContainText(harbourGrammar.answer);
    await expect(dialog).toContainText(harbourGrammar.rule);
    expect(await count(page,'grammar.addNote')).toBe(0);
    const bounds=await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width+1);
    await page.screenshot({path:`${captures}/grammar-brief-${name}.png`});
    await dialog.locator('summary').filter({hasText:'Подробнее'}).click();
    await expect(dialog).toContainText(harbourGrammar.explanation);
    await page.screenshot({path:`${captures}/grammar-details-${name}.png`});
    await dialog.getByRole('button',{name:'Добавить в Anki'}).click();
    await expect.poll(()=>count(page,'grammar.addNote')).toBe(1);
    expect(await page.locator('#tense').textContent()).toBe(grammarSentence);
    await page.keyboard.press('Escape'); await page.locator('#simple b').hover(); await page.keyboard.press('Alt');
    await expect(dialog).toContainText('Отдельный разбор не нужен');
    expect(await dialog.getByRole('button',{name:'Добавить в Anki'}).count()).toBe(0);
    await page.screenshot({path:`${captures}/grammar-none-${name}.png`});
    await page.close();
  });
}

for (const width of [1180, 360]) {
  test(`Alt chat supports keyboard suggestions, explicit send and Escape focus at ${width}px`, async () => {
    const lesson = 'Present Perfect связывает прошлое с настоящим и строится с have или has.';
    const practice = 'Заполните пропуск: She ___ just arrived.';
    const page = await openFixture(true,{
      'Дай полное объяснение темы Present Perfect':{kind:'answer',answer:lesson},
      'Дай упражнение по этой теме':{kind:'answer',answer:practice},
    });
    try {
      await page.setViewportSize({width, height:850});
      await page.locator('#tense b').hover();
      await page.keyboard.press('Alt');
      const dialog = page.getByRole('dialog');
      const opener = dialog.getByRole('button', {name:'Открыть языковой чат', exact:true});
      await opener.press('Enter');
      await expect(dialog.locator('mark')).toHaveText(harbourGrammar.construction.text);
      const field = dialog.getByRole('textbox', {name:'Ваш вопрос'});
      const hints = dialog.getByRole('group', {name:'Подсказки для вопроса'}).getByRole('button');
      const send = dialog.getByRole('button', {name:'Отправить', exact:true});
      await expect(field).toBeFocused();
      await expect(send).toBeDisabled();
      expect(await count(page, 'grammar.chat')).toBe(0);

      for (const [index,key] of ['Enter','Space'].entries()) {
        // Each activation returns focus to the textarea, so use real Tabs again for the second hint.
        for (let n=0;n<=index;n++) await page.keyboard.press('Tab');
        const hint = hints.nth(index);
        await expect(hint).toBeFocused();
        const text = (await hint.innerText()).trim();
        expect(text).not.toBe('');
        await page.keyboard.press(key);
        await expect(field).toHaveValue(text);
        await expect(field).toBeFocused();
        expect(await count(page, 'grammar.chat')).toBe(0);
      }

      const question = await field.inputValue();
      // Reach the submit button from the textarea by normal tabbing on both layouts.
      for (const hint of await hints.all()) {
        await page.keyboard.press('Tab');
        await expect(hint).toBeFocused();
      }
      await page.keyboard.press('Tab');
      await expect(dialog.locator('.grammar-chat-privacy summary')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(send).toBeFocused();
      const bounds = await send.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      expect(await count(page, 'grammar.chat')).toBe(0);
      await page.keyboard.press('Enter');
      const thread = dialog.getByRole('log', {name:'Вопросы и ответы'});
      await expect(thread).toContainText(question);
      await expect(thread).toContainText(lesson);
      expect(await count(page, 'grammar.chat')).toBe(1);
      expect(await count(page, 'grammar.addNote')).toBe(0);
      await dialog.getByRole('button',{name:'Дай упражнение по этой теме',exact:true}).click();
      await expect(field).toHaveValue('Дай упражнение по этой теме');
      expect(await count(page,'grammar.chat')).toBe(1);
      await send.click();
      await expect(thread).toContainText(practice);
      await page.screenshot({path:`${captures}/rc4-chat-answer-${width}.png`});
      await page.keyboard.press('Escape');
      await expect(field).toHaveCount(0);
      await expect(dialog.getByRole('button', {name:'Предпросмотр', exact:true})).toBeVisible();
      await expect(opener).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      expect(await count(page, 'grammar.chat')).toBe(2);
    } finally { await page.close(); }
  });
}


for (const width of [320, 390]) {
  test(`long chat geometry at ${width}px keeps both ends, previous turns and a draft reachable`, async () => {
    const first = 'Что показывает had left?', second = 'Теперь объясни правило целиком.', third = 'Можешь привести ещё один пример?';
    const heading = 'Нереальное условие в прошлом';
    const lastLine = 'Если бы мы вышли раньше, мы бы успели на поезд.';
    const lesson = ['## ' + heading, ...Array.from({length: 24}, (_, i) =>
      `Пример ${i + 1}. Изменение условия в прошлом даёт другой воображаемый результат.`), lastLine].join('\n\n');
    const page = await openFixture(true, {
      [first]: {kind:'answer', answer:'Обозначено более раннее событие. '.repeat(26)},
      [second]: {kind:'answer', answer:lesson},
      [third]: {kind:'answer', answer:'If I had seen the sign, I would have stopped.'},
    });
    try {
      await page.setViewportSize({width, height:width === 320 ? 640 : 780});
      await page.locator('#tense b').hover();
      await page.keyboard.press('Alt');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', {name:'Открыть языковой чат'}).click();
      const log = dialog.getByRole('log');
      const field = dialog.getByRole('textbox', {name:'Ваш вопрос'});
      const send = dialog.getByRole('button', {name:'Отправить', exact:true});
      await field.fill(first); await send.click();
      await expect(log.locator('.grammar-chat-answer')).toHaveCount(1);
      await field.fill(second); await send.click();
      // These checks do not scroll the expected content into view.
      await expect(log.getByRole('heading', {name:heading})).toBeInViewport({ratio:1});
      const dimensions = await dialog.evaluate(el => {
        const log = el.querySelector<HTMLElement>('[role=log]')!;
        return {
          outerScrolls:el.scrollHeight > el.clientHeight,
          innerScrolls:log.scrollHeight > log.clientHeight + 1,
          overflowsWidth:el.scrollWidth > el.clientWidth + 1,
        };
      });
      expect(dimensions).toEqual({outerScrolls:true, innerScrolls:false, overflowsWidth:false});
      await dialog.evaluate(el => {el.scrollTop = 0;});
      await expect(log.getByText(first, {exact:true})).toBeInViewport({ratio:1});
      const last = log.getByText(lastLine, {exact:true});
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport({ratio:1});
      await dialog.evaluate(el => {el.scrollTop = el.scrollHeight;});
      await expect(send).toBeInViewport({ratio:1});

      await page.evaluate(() => {(window as any).deferChatReply = true;});
      await field.fill(third); await send.click();
      await expect(log.getByRole('status')).toHaveText('Готовим ответ…');
      await field.fill('Черновик');
      // Focus the editor first, then read a slightly earlier point without
      // moving the caret out of sight. Native typing should retain that position.
      await field.evaluate(el => el.scrollIntoView({block:'center'}));
      const before = await dialog.evaluate(el => {el.scrollTop -= 40; return el.scrollTop;});
      await page.keyboard.insertText(' следующего вопроса');
      await page.evaluate(() => (window as any).finishChatReply());
      await expect(log.locator('.grammar-chat-answer')).toHaveCount(3);
      await expect(field).toHaveValue('Черновик следующего вопроса');
      await expect(field).toBeFocused();
      expect(Math.abs(await dialog.evaluate(el => el.scrollTop) - before)).toBeLessThanOrEqual(2);
      expect(await count(page, 'grammar.chat')).toBe(3);
      expect(await count(page, 'grammar.addNote')).toBe(0);
    } finally {await page.close();}
  });
}

test('a reader can ask a fresh grammar question after local and provider topic decisions in the same Alt chat',async()=>{
  const replies:Record<string,FixtureChatReply>={
    'Зачем тут had перед left?':{kind:'answer',answer:'В форме had left слово had относит отплытие к более раннему моменту.'},
    'Где купить билет?':{kind:'out_of_scope'},
    'Можно подробнее про эту поездку?':{kind:'model_out_of_scope'},
    'Что именно вы имеете в виду здесь?':{kind:'model_no_answer'},
    'А что связывает By the time с остальным предложением?':{kind:'answer',answer:'By the time связывает прибытие Мары с более ранним отплытием лодок.'},
  };
  const page=await openFixture(true,replies);
  try {
    await page.locator('#tense b').hover();await page.keyboard.press('Alt');
    const dialog=page.getByRole('dialog'),opener=dialog.getByRole('button',{name:'Открыть языковой чат'});
    await opener.click();
    const field=dialog.getByRole('textbox',{name:'Ваш вопрос'}),send=dialog.getByRole('button',{name:'Отправить',exact:true});
    const thread=dialog.getByRole('log',{name:'Вопросы и ответы'});
    let submitted=0;
    for(const [question,reply] of Object.entries(replies)){
      await field.fill(question);expect(await count(page,'grammar.chat')).toBe(submitted);
      await send.click();
      submitted++;
      await expect.poll(()=>count(page,'grammar.chat')).toBe(submitted);
      await expect(thread).toContainText(question);
      if(reply.kind==='answer'){
        await expect(thread).toContainText(reply.answer);
        await expect(field).toHaveValue('');await expect(send).toBeDisabled();
      } else {
        const messages={out_of_scope:'Запрос в OpenAI не отправлялся',model_out_of_scope:'По оценке модели',model_no_answer:'недостаточно сведений'};
        await expect(thread).toContainText(messages[reply.kind]);
        await expect(field).toHaveValue(question);await expect(send).toBeEnabled();
      }
      await expect(field).toBeEditable();
    }
    await expect(thread).toContainText('В форме had left');
    await expect(dialog.locator('mark')).toHaveText(harbourGrammar.construction.text);
    expect(await count(page,'grammar.lookup')).toBe(1);
    expect(await count(page,'grammar.addNote')).toBe(0);
  } finally {await page.close();}
});

test('turning grammar off leaves the regular Shift popup, editor and matching preview available',async()=>{
  const page=await openFixture(false);
  await page.locator('#word b').hover(); await page.keyboard.press('Alt');
  expect(await count(page,'grammar.lookup')).toBe(0);
  expect(await page.getByRole('dialog').count()).toBe(0);
  await page.keyboard.press('Shift');
  const popup=page.getByRole('dialog',{name:'Контекстный перевод'});
  await expect(popup).toContainText('проблеск');
  expect(await popup.getByRole('button',{name:'Разбор предложения по левому Alt'}).count()).toBe(0);
  expect(await page.locator('#word').textContent()).toBe(harbourSentence);
  await page.screenshot({path:`${captures}/grammar-disabled-shift.png`});
  await popup.getByRole('button',{name:'Редактировать',exact:true}).click();
  await expect(popup.getByLabel('Начальная форма слова')).toHaveValue('glimmer');
  await page.screenshot({path:`${captures}/lexical-editor.png`});
  await popup.getByRole('button',{name:'Предпросмотр',exact:true}).click();
  const card=popup.frameLocator('iframe').first().locator('body');
  await expect(card).toContainText('glimmer');
  await page.screenshot({path:`${captures}/lexical-preview.png`});
  expect(await count(page,'grammar.lookup')).toBe(0); await page.close();
});

test('production manifest loads actual declared PNG resources in Chromium',async()=>{
  const page=await context.newPage();await page.goto(`chrome-extension://${extensionId}/settings.html`);
  const result=await page.evaluate(async()=>{
    const m=chrome.runtime.getManifest();
    const icons={...m.icons,...m.action?.default_icon} as Record<string,string>;
    return Promise.all(Object.entries(icons).map(async([key,p])=>{
      const img=new Image();img.src=chrome.runtime.getURL(p);await img.decode();
      return [Number(key),img.naturalWidth,img.naturalHeight];
    }));
  });
  for(const size of [16,32,48,128])expect(result).toContainEqual([size,size,size]);
  await page.close();
});

test('Shift word playback and Close are centered inside a symmetrically padded panel',async()=>{
  const page=await openFixture(false);
  await page.locator('#word b').hover(); await page.keyboard.press('Shift');
  const panel=page.getByRole('dialog',{name:'Контекстный перевод'});
  const speak=panel.getByRole('button',{name:'Прослушать выражение системным голосом'});
  await expect(speak).toBeVisible();
  for(const width of [1180,390]){
    await page.setViewportSize({width,height:800});
    const geometry=await panel.evaluate(el=>{
      const outer=el.getBoundingClientRect();
      const heading=el.querySelector('.reading-heading')!.getBoundingClientRect();
      const buttons=[...el.querySelectorAll('.reading-header-actions button')];
      return {
        left:heading.left-outer.left,right:outer.right-buttons[1]!.getBoundingClientRect().right,
        icons:buttons.map(button=>{
          const b=button.getBoundingClientRect(),icon=button.querySelector('svg')!.getBoundingClientRect();
          return {x:Math.abs((b.left+b.right-icon.left-icon.right)/2),y:Math.abs((b.top+b.bottom-icon.top-icon.bottom)/2)};
        }),
      };
    });
    expect(Math.abs(geometry.left-geometry.right)).toBeLessThanOrEqual(1);
    for(const icon of geometry.icons){expect(icon.x).toBeLessThanOrEqual(.5);expect(icon.y).toBeLessThanOrEqual(.5);}
  }
  await speak.click();
  const audio=await page.evaluate(()=>(window as any).fixtureCalls.filter((c:{type:string})=>c.type.startsWith('audio.')));
  expect(audio).toEqual([{type:'audio.play',payload:{lookupId:harbourLookup.lookupId}}]);
  await panel.getByRole('button',{name:'Закрыть перевод'}).click();
  await expect(panel).toHaveCount(0);await page.close();
});

test('settings paint the full canvas and permission controls and toolbar rows remain aligned in either theme',async()=>{
  const page=await context.newPage();
  await page.setViewportSize({width:1600,height:900});
  for(const colorScheme of ['light','dark'] as const){
    await page.emulateMedia({colorScheme});
    await page.goto(`chrome-extension://${extensionId}/settings.html`);
    await page.getByRole('button',{name:'Произношение и сервисы'}).click();
    const fields=page.getByRole('group',{name:'Голос и дополнительные источники'}).getByRole('checkbox');
    await expect(fields).toHaveCount(2);
    const boxes=await fields.evaluateAll(inputs=>inputs.map(input=>{
      const box=input.getBoundingClientRect(),label=input.closest('label')!.getBoundingClientRect();
      return {width:box.width,height:box.height,x:box.x,offset:box.top-label.top};
    }));
    expect(boxes[0]?.width).toBe(16);expect(boxes[0]?.height).toBe(16);expect(boxes[1]).toEqual(boxes[0]);
    const canvas=await page.evaluate(()=>({background:getComputedStyle(document.documentElement).backgroundColor,
      margin:getComputedStyle(document.body).marginLeft,
      left:document.querySelector('#root')!.shadowRoot!.querySelector('.settings-page')!.getBoundingClientRect().left}));
    expect(canvas.margin).toBe('0px');expect(canvas.left).toBeGreaterThan(100);
    expect(canvas.background).toBe(colorScheme==='dark'?'rgb(51, 51, 54)':'rgb(246, 246, 251)');
    await page.goto(`chrome-extension://${extensionId}/action.html`);
    const rows=page.locator('.action-nav-pair button');await expect(rows).toHaveCount(2);
    for(const row of await rows.all()){
      const insets=await row.evaluate(button=>{
        const r=button.getBoundingClientRect(),icons=button.querySelectorAll('svg');
        return [icons[0]!.getBoundingClientRect().left-r.left,r.right-icons[1]!.getBoundingClientRect().right];
      });
      expect(insets[0]).toBeGreaterThanOrEqual(16);expect(insets[1]).toBe(insets[0]);
    }
  }
  await page.close();
});
