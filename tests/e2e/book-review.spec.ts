import { chromium, expect, test, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const chapters = ['The First Crossing', 'The Copper Gate', 'The Last Island'];
const captureDirectory = 'test-results/first-design';
type Kind = 'epub' | 'fb2';
let context: BrowserContext, profile: string, libraryUrl: string;

function paragraphs(chapter: number) {
  const opening = [
    '<p><strong>Saffron</strong> and <strong>Lavender</strong> bloomed beside the pier.</p>',
    '<p>The first copper compass lay beside a second copper compass.</p>',
    '<p>The silver island appeared beyond the hills.</p>',
  ][chapter]!;
  const body = Array.from({length: 90}, (_, i) =>
    '<p>The crew recorded observation ' + (i + 1) + ' on the morning passage. A trail of pale shells followed the bends in the bay.</p>');
  return opening + body.join('');
}

function reflowBook(kind: Kind,title = 'Coastal Review ' + kind.toUpperCase()) {
  if (kind === 'fb2') return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' +
    '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info>' +
    '<author><first-name>Eleanor</first-name><last-name>Vale</last-name></author><book-title>' + title +
    '</book-title><lang>en</lang></title-info></description><body>' +
    chapters.map((name,i) => '<section><title><p>'+name+'</p></title>'+paragraphs(i)+'</section>').join('') +
    '</body></FictionBook>');
  const xml:Record<string,string> = {
    mimetype:'application/epub+zip',
    'META-INF/container.xml':'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'book.opf':'<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">reader-acceptance</dc:identifier><dc:title>'+title+'</dc:title><dc:creator>Eleanor Vale</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'+
      chapters.map((_,i)=>`<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
      '</manifest><spine toc="toc">'+chapters.map((_,i)=>`<itemref idref="c${i}"/>`).join('')+'</spine></package>',
    'toc.ncx':'<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="reader-acceptance"/></head><docTitle><text>'+title+'</text></docTitle><navMap>'+
      chapters.map((name,i)=>`<navPoint id="n${i}" playOrder="${i+1}"><navLabel><text>${name}</text></navLabel><content src="c${i}.xhtml"/></navPoint>`).join('')+'</navMap></ncx>',
  };
  chapters.forEach((name,i)=>{xml[`c${i}.xhtml`]=`<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>${name}</title></head><body><h1>${name}</h1>${paragraphs(i)}</body></html>`;});
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(xml).map(([name,data])=>[name,strToU8(data)])),{level:0}));
}

function threePagePdf(words=['First lighthouse','Second harbour','Third beacon and Third beacon']) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  words.forEach((word,i)=>{
    const stream=`BT /F1 22 Tf 65 690 Td (${word}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+2*i} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let data='%PDF-1.4\n';
  const offsets=objects.map((obj,index)=>{const start=data.length;data+=`${index+1} 0 obj\n${obj}\nendobj\n`;return start;});
  const xref=data.length;
  data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+
    `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data,'ascii');
}

test.beforeAll(async()=>{
  profile=await mkdtemp(path.join(tmpdir(),'reader-book-acceptance-'));
  await mkdir(captureDirectory,{recursive:true});
  const dist=path.resolve('dist/english-reader');
  context=await chromium.launchPersistentContext(profile,{
    executablePath:process.env.CHROMIUM_PATH || (process.platform==='linux'?'/usr/bin/chromium':undefined),
    headless:true,viewport:{width:1260,height:870},ignoreDefaultArgs:['--disable-extensions'],
    args:[`--load-extension=${dist}`,`--disable-extensions-except=${dist}`,'--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>'],
  });
  await context.route(/^https?:\/\//,route=>route.abort());
  const sw=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  libraryUrl=new URL('library.html',sw.url()).href;
});
test.afterAll(async()=>{await context?.close();if(profile)await rm(profile,{recursive:true,force:true});});

async function clickRail(page:Page,name:string){
  await page.getByRole('navigation',{name:'Инструменты чтения'}).getByRole('button',{name,exact:true}).click();
}
// Sample actual hit targets as well as rectangles: an open drawer must never cover either arrow.
async function verifySideArrows(page:Page){
  await expect.poll(()=>page.evaluate(()=>{
    const page=document.querySelector('.rc-book-view .rc-page')?.getBoundingClientRect();
    const grip=document.querySelector('.rc-resize')?.getBoundingClientRect();
    const arrows=document.querySelectorAll<HTMLButtonElement>('.rc-book-view .rc-page-edge');
    if(!page || page.width<=0 || page.height<=0 || arrows.length!==2) return false;
    return [...arrows].every((button,i)=>{
      const r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      return r.width>=24 && r.height>=32 && x>=0 && x<innerWidth && y>=0 && y<innerHeight &&
        Math.abs(y-(page.top+page.height/2))<=1.5 &&
        (i===0?r.right<=page.left+1:r.left>=page.right-1) &&
        (!grip || r.left>=grip.right-.5 || r.right<=grip.left+.5 || r.top>=grip.bottom-.5 || r.bottom<=grip.top+.5) &&
        document.elementFromPoint(x,y)?.closest('button')===button;
    });
  })).toBe(true);
  await expect(page.locator('.rc-nav-page .rc-arrow,.rc-nav-page .rc-page-edge')).toHaveCount(0);
}
test('reading rail fits without sideways scrolling, text and progress share a center, and Alt follows settings live', async()=>{
  const page=await context.newPage(),settings=await context.newPage();
  try {
    await page.goto(libraryUrl);
    const buffer=Buffer.from(reflowBook('fb2').toString().replace('Coastal Review FB2','Reader Toolbar Proof'));
    await page.locator('input[type=file]').setInputFiles({name:'Toolbar.fb2',mimeType:'application/x-fictionbook+xml',buffer});
    await expect(page.getByRole('slider',{name:'Позиция в книге'})).toBeEnabled();
    const verifyBounds=async()=>expect.poll(()=>page.evaluate(()=>{
      const rail=document.querySelector<HTMLElement>('.rc-rail')!,stage=document.querySelector<HTMLElement>('.rc-stage')!;
      const center=(el:Element)=>{const r=el.getBoundingClientRect();return r.left+r.width/2;};
      const railBounds=rail.getBoundingClientRect();
      return rail.scrollWidth<=rail.clientWidth+1&&
        [...rail.querySelectorAll('button')].every(button=>{
          const rect=button.getBoundingClientRect();return rect.left>=railBounds.left-.5&&rect.right<=railBounds.right+.5;
        })&&Math.abs(center(stage)-center(document.querySelector('.er-epub-viewport')!))<=1.5&&
        Math.abs(center(stage)-center(document.querySelector('.rc-progress input')!))<=1.5;
    })).toBe(true);
    for(const [width,height] of [[1260,870],[850,620],[385,690],[300,270]] as const){
      await page.setViewportSize({width,height});await verifyBounds();await verifySideArrows(page);
      await clickRail(page,'Главы');await verifyBounds();await verifySideArrows(page);
      await page.getByRole('button',{name:'Закрыть панель'}).click();
    }
    await page.setViewportSize({width:1260,height:870});
    await clickRail(page,'Главы');await verifyBounds();
    await expect(page.locator('.rc-panel')).not.toContainText('Закладки');
    await clickRail(page,'Закладки');
    await expect(page.locator('.rc-panel')).toContainText('Пока нет закладок.');
    await verifySideArrows(page);
    await clickRail(page,'Вид');
    const panel=page.locator('.rc-panel'),hint=panel.locator('.rc-shortcuts small');
    await expect(panel.locator('.rc-shortcuts kbd')).toHaveText(['Shift','Alt']);
    await expect(panel.getByRole('switch',{name:'Оформление издателя'})).toHaveAttribute('aria-checked','true');
    await expect(panel).not.toContainText('О чтении книги');
    await expect(hint).toContainText('Выключено');
    await settings.goto(new URL('settings.html',libraryUrl).href);
    const optIn=settings.getByRole('checkbox',{name:'Разбор предложения и языковой чат по левому Alt'});
    await optIn.check();
    const confirmation=context.waitForEvent('page');
    await settings.getByRole('button',{name:'Сохранить настройки'}).click();
    const dialogue=await confirmation;
    await expect(dialogue).toHaveURL(/confirm\.html#/);
    await dialogue.getByRole('button',{name:'Разрешить'}).click();
    await expect(hint).toContainText('Это платный запрос');
    await expect(hint).toContainText('без нового запроса');
    await optIn.uncheck();await settings.getByRole('button',{name:'Сохранить настройки'}).click();
    await expect(hint).toContainText('Выключено');
  } finally {await settings.close();await page.close();}
});

async function capture(page:Page,name:string){
  await page.screenshot({path:path.join(captureDirectory,name+'.png'),animations:'disabled'});
}

// Inspect the painted range in the actual document/text layer, including its character position.
async function paintedMatch(page: Page, format: 'epub'|'pdf') {
  return page.evaluate(kind => {
    const docs = kind === 'pdf' ? [document] : Array.from(
      document.querySelectorAll<HTMLIFrameElement>('.er-epub-viewport iframe'), frame => frame.contentDocument,
    );
    for (const doc of docs) {
      const win = doc?.defaultView;
      if (!win) continue;
      const registry = (win as Window & typeof globalThis).CSS.highlights;
      const match = registry.get(kind === 'pdf' ? 'reader-pdf-search' : 'reader-search-hit');
      for (const range of match ?? []) {
        const block = range.startContainer.parentElement?.closest(kind === 'pdf' ? '.textLayer' : 'p');
        if (!block) continue;
        const prefix = doc!.createRange();
        prefix.selectNodeContents(block);
        prefix.setEnd(range.startContainer, range.startOffset);
        return {text:range.toString(), offset:prefix.toString().length};
      }
    }
    return null;
  }, format);
}

// The database is only an observer here. Every state change goes through visible reader controls.
async function savedPosition(page:Page,documentId:string) {
  return page.evaluate(async id=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('english-reader');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try {
      return await new Promise<{cfi?:string;chapterNumber?:number;percent?:number;page?:number;updatedAt:string}|null>((resolve,reject)=>{
        const read=db.transaction('readingProgress','readonly').objectStore('readingProgress').get(id);
        read.onsuccess=()=>resolve(read.result??null);read.onerror=()=>reject(read.error);
      });
    } finally {db.close();}
  },documentId);
}

for (const kind of ['epub','fb2'] as const) {
  test(`${kind.toUpperCase()}: import → search/TOC → themes and quotes → whole-book seek → exact CFI after reflow/reopen`,async()=>{
    test.setTimeout(90_000);
    const page=await context.newPage();
    try {
      await page.goto(libraryUrl);
      await expect(page.getByRole('heading',{name:'Библиотека',exact:true})).toBeVisible();
      const buffer=reflowBook(kind), id='sha256:'+createHash('sha256').update(buffer).digest('hex');
      await page.locator('input[type=file]').setInputFiles({name:'review.'+kind,mimeType:kind==='epub'?'application/epub+zip':'application/x-fictionbook+xml',buffer});
      const reader=page.locator('.rc-shell'), range=page.getByRole('slider',{name:'Позиция в книге'});
      const chapter=page.getByRole('group',{name:'Переключение глав'});
      const panel=page.locator('.rc-panel');
      await expect(range).toBeEnabled();
      await expect(chapter).toContainText(chapters[0]!);
      await verifySideArrows(page);await expect(page.locator('.rc-nav-page')).toHaveText(/^Страница 1 из \d+$/);
      await expect(panel).toHaveCount(0);
      const frame=page.frameLocator('.er-epub-viewport iframe').first();
      for(const [token,action] of [['Saffron','Выделить'],['Lavender','Комментарий']]){
        await frame.getByText(token!,{exact:true}).dblclick();
        const tools=page.getByRole('toolbar',{name:'Действия с выделением'});
        await expect(tools.getByRole('button')).toHaveText(['Выделить','Комментарий']);
        await tools.getByRole('button',{name:action,exact:true}).click();
        if(action==='Комментарий'){
          const editor=page.getByRole('dialog',{name:'Комментарий к цитате'});
          await editor.getByLabel('Ваша заметка').fill('Запомнить название растения.');
          await editor.getByRole('button',{name:'Сохранить',exact:true}).click();
        }
        await expect(tools).toHaveCount(0);
      }
      await clickRail(page,'Цитаты');
      await expect(panel.locator('blockquote')).toHaveCount(2);
      await expect(panel).toContainText('Запомнить название растения.');
      await capture(page,kind+'-quotes');

      await clickRail(page,'Поиск');
      await panel.getByRole('searchbox').fill('copper compass');
      await panel.getByRole('button',{name:'Найти',exact:true}).click();
      const hit=panel.locator('.rc-results button').filter({hasText:'copper compass'});
      await expect(hit).toHaveCount(2);
      const sentence='The first copper compass lay beside a second copper compass.';
      for (const [i, offset] of [sentence.indexOf('copper compass'),sentence.lastIndexOf('copper compass')].entries()) {
        await hit.nth(i).click();
        await expect.poll(()=>paintedMatch(page,'epub')).toEqual({text:'copper compass',offset});
      }
      await capture(page,kind+'-selected-search-hit');
      await expect(chapter).toContainText(chapters[1]!);
      await panel.getByRole('button',{name:'Оглавление',exact:true}).click();
      const entries=panel.getByRole('list',{name:'Оглавление книги'}).getByRole('button');
      await expect(entries).toHaveCount(3);await expect(entries.nth(1)).toHaveAttribute('aria-current','location');
      await panel.getByRole('button',{name:'Закрыть панель'}).click();
      const track=await range.boundingBox();expect(track).toBeTruthy();
      await page.mouse.click(track!.x+track!.width*.83,track!.y+track!.height/2);
      await expect(chapter).toContainText(chapters[2]!);
      await expect.poll(async()=>(await savedPosition(page,id))?.percent??0).toBeGreaterThan(68);
      const before=(await savedPosition(page,id))!;expect(before.cfi).toMatch(/^epubcfi\(/);
      const mark=page.getByRole('button',{name:'Добавить закладку на текущую страницу'});
      await mark.click();await expect(page.getByRole('button',{name:'Убрать закладку'})).toHaveAttribute('aria-pressed','true');
      await clickRail(page,'Вид');
      const colors:{surface:string;rail:string;drawer:string}[]=[];
      for(const [label,key] of [['Белая','white'],['Кремовая','cream'],['Графит','graphite']]){
        await panel.getByRole('button',{name:label,exact:true}).click();
        await expect(reader).toHaveAttribute('data-reader-theme',key!);
        colors.push(await reader.evaluate(async el=>{
          await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));
          return {surface:getComputedStyle(el).backgroundColor,rail:getComputedStyle(el.querySelector('.rc-rail')!).backgroundColor,drawer:getComputedStyle(el.querySelector('.rc-drawer')!).backgroundColor};
        }));
      }
      for(const part of ['surface','rail','drawer'] as const)expect(new Set(colors.map(c=>c[part])).size).toBe(3);
      const font=panel.getByRole('group',{name:'Размер шрифта'}),initial=parseInt(await font.locator('output').innerText(),10);
      await font.getByRole('button',{name:'Увеличить: Размер шрифта'}).click();
      await expect(font.locator('output')).toHaveText((initial+1)+' px');
      const divider=page.getByRole('separator',{name:'Ширина панели'});
      await divider.press('Home');const narrow=await panel.boundingBox();
      await divider.press('End');await expect.poll(async()=>(await panel.boundingBox())!.width).toBeGreaterThan(narrow!.width+80);
      await expect(page.locator('.er-epub-viewport')).toHaveAttribute('aria-busy','false');
      await capture(page,kind+'-graphite-drawer');
      await clickRail(page,'Библиотека');
      await expect(page.getByRole('heading',{name:'Библиотека',exact:true})).toBeVisible();
      const atClose=(await savedPosition(page,id))!;
      expect(atClose.cfi).toBe(before.cfi);
      await page.reload();await capture(page,kind+'-library');
      await page.getByRole('button',{name:'Coastal Review '+kind.toUpperCase(),exact:true}).click();
      await expect(range).toBeEnabled();await expect(chapter).toContainText(chapters[2]!);
      await expect(reader).toHaveAttribute('data-reader-theme','graphite');
      await expect(page.getByRole('button',{name:'Убрать закладку'})).toHaveAttribute('aria-pressed','true');
      await expect.poll(async()=>(await savedPosition(page,id))?.updatedAt).not.toBe(atClose.updatedAt);
      expect((await savedPosition(page,id))?.cfi).toBe(before.cfi);
      await clickRail(page,'Цитаты');await expect(panel.locator('blockquote')).toHaveCount(2);
      await expect(panel).toContainText('Запомнить название растения.');
      await panel.getByRole('button',{name:'К фрагменту'}).first().click();
      await expect(chapter).toContainText(chapters[0]!);
      await page.setViewportSize({width:385,height:690});await verifySideArrows(page);
      await expect(page.locator('.rc-nav-page')).toHaveText(/^Страница \d+ из \d+$/);
    } finally {await page.close();}
  });
}

test('PDF: jump to actual page 2 of 3, bookmark, search to page 3, move back with whole-document slider and reopen',async()=>{
  const page=await context.newPage();
  try {
    await page.goto(libraryUrl);
    const buffer=threePagePdf(),id='sha256:'+createHash('sha256').update(buffer).digest('hex');
    await page.locator('input[type=file]').setInputFiles({name:'Three Harbours.pdf',mimeType:'application/pdf',buffer});
    await page.getByRole('button',{name:'Страница 1 из 3',exact:true}).click();
    await page.getByRole('textbox',{name:'Номер страницы PDF'}).fill('2');
    await page.getByRole('button',{name:'Перейти',exact:true}).click();
    const page2=page.locator('.er-pdf-page[data-page="2"]');
    await expect(page2.locator('.textLayer')).toContainText('Second harbour');
    await expect(page2).toBeInViewport();await expect(page.getByRole('button',{name:'Страница 2 из 3'})).toBeVisible();
    await verifySideArrows(page);await expect(page.locator('.rc-nav-page button')).toHaveCount(1);
    await clickRail(page,'Главы');await verifySideArrows(page);
    await page.setViewportSize({width:385,height:690});await verifySideArrows(page);
    await page.getByRole('button',{name:'Следующий экран',exact:true}).click();
    await expect(page.getByRole('button',{name:'Страница 3 из 3'})).toBeVisible();
    await page.getByRole('button',{name:'Предыдущий экран',exact:true}).click();
    await expect(page.getByRole('button',{name:'Страница 2 из 3'})).toBeVisible();
    await page.getByRole('button',{name:'Закрыть панель'}).click();await verifySideArrows(page);
    await page.setViewportSize({width:1260,height:870});
    await page.getByRole('button',{name:'Добавить закладку на текущую страницу'}).click();
    await expect(page.getByRole('button',{name:'Убрать закладку'})).toHaveAttribute('aria-pressed','true');
    await capture(page,'pdf-page-two');
    await clickRail(page,'Главы');
    await expect(page.locator('.rc-panel')).not.toContainText('Закладки');
    await clickRail(page,'Закладки');
    await expect(page.locator('.rc-panel .er-pdf-bookmark-link')).toContainText('Страница 2');
    await clickRail(page,'Поиск');const panel=page.locator('.rc-panel');
    await panel.getByRole('searchbox').fill('Third beacon');await panel.getByRole('button',{name:'Найти',exact:true}).click();
    const hits=panel.locator('.rc-results button').filter({hasText:'Third beacon'});
    await expect(hits).toHaveCount(2);
    for (const [i,offset] of [0, 'Third beacon and '.length].entries()) {
      await hits.nth(i).click();
      await expect.poll(()=>paintedMatch(page,'pdf')).toEqual({text:'Third beacon',offset});
    }
    await capture(page,'pdf-selected-search-hit');
    await expect(page.getByRole('button',{name:'Страница 3 из 3'})).toBeVisible();
    await expect(page.locator('.er-pdf-page[data-page="3"] .textLayer')).toContainText('Third beacon');
    await panel.getByRole('button',{name:'Закрыть панель'}).click();
    const slider=page.getByRole('slider',{name:'Позиция в книге'});
    for (const [key,expected] of [['Home',1],['ArrowRight',2],['ArrowRight',3],['ArrowRight',3],['ArrowLeft',2],['End',3]] as const) {
      await slider.press(key);
      await expect(page.getByRole('button',{name:'Страница '+expected+' из 3'})).toBeVisible();
    }
    await expect.poll(()=>paintedMatch(page,'pdf')).toBeNull();
    const box=await slider.boundingBox();
    await page.mouse.click(box!.x+box!.width*.5,box!.y+box!.height/2);
    await expect(page.getByRole('button',{name:'Страница 2 из 3'})).toBeVisible();
    await expect.poll(async()=>(await savedPosition(page,id))?.page).toBe(2);
    await clickRail(page,'Библиотека');await page.reload();
    await page.getByRole('button',{name:'Three Harbours',exact:true}).click();
    await expect(page.getByRole('button',{name:'Страница 2 из 3'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Убрать закладку'})).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:'Убрать закладку'}).click();
    await expect(page.getByRole('button',{name:'Добавить закладку на текущую страницу'})).toHaveAttribute('aria-pressed','false');
  } finally {await page.close();}
});

// Translate a native glyph rectangle into the outer Playwright viewport. The
// same helper drives real mouse drags inside both EPUB iframes and PDF.js spans.
async function glyphPoint(block:Locator,index:number,fraction:number){
  const box=await block.boundingBox();expect(box).toBeTruthy();
  const local=await block.evaluate((el,{index,fraction})=>{
    const doc=el.ownerDocument,walker=doc.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    let offset=index;
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      const size=node.textContent?.length??0;
      if(offset>=size){offset-=size;continue;}
      const range=doc.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);
      const rect=range.getBoundingClientRect(),parent=el.getBoundingClientRect();
      return {x:rect.left-parent.left+fraction*rect.width,y:rect.top-parent.top+rect.height/2};
    }
    throw new Error('Character outside fixture passage');
  },{index,fraction});
  return {x:box!.x+local.x,y:box!.y+local.y};
}

async function savedQuotesForBook(page:Page,id:string){
  return page.evaluate(async id=>{
    const db=await new Promise<IDBDatabase>((ok,fail)=>{const req=indexedDB.open('english-reader');req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error);});
    try{return await new Promise<import('../../apps/extension/src/readers/types').ReaderQuote[]>((ok,fail)=>{
      const req=db.transaction('metadata','readonly').objectStore('metadata').get('reader-state:'+id);
      req.onsuccess=()=>ok(req.result?.value?.quotes??[]);req.onerror=()=>fail(req.error);
    });}finally{db.close();}
  },id);
}

for(const kind of ['epub','fb2','pdf'] as const){
  test(kind.toUpperCase()+' reopens a saved full highlight with one real click and edits its original comment',async()=>{
    const page=await context.newPage();
    try{
      const pdf=kind==='pdf',phrase=pdf?'copper compass':'Saffron and Lavender';
      const buffer=pdf?threePagePdf(['A copper compass and a copper compass.','Another harbour.','The end.']):reflowBook(kind,'Quote editing '+kind);
      const id='sha256:'+createHash('sha256').update(buffer).digest('hex');
      await page.goto(libraryUrl);
      await page.locator('input[type=file]').setInputFiles({name:'quote-edit.'+kind,mimeType:pdf?'application/pdf':kind==='fb2'?'application/x-fictionbook+xml':'application/epub+zip',buffer});
      const block=pdf?page.locator('.er-pdf-page[data-page="1"] .textLayer span').filter({hasText:phrase}).first():
        page.frameLocator('.er-epub-viewport iframe').first().locator('p').filter({hasText:phrase}).first();
      await expect(block).toBeVisible();await block.scrollIntoViewIfNeeded();
      if(!pdf)await expect(page.locator('.er-epub-viewport')).toHaveAttribute('aria-busy','false');
      const start=(await block.textContent())!.lastIndexOf(phrase);
      const a=await glyphPoint(block,start,.12),b=await glyphPoint(block,start+phrase.length-1,.88);
      await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:18});await page.mouse.up();
      const toolbar=page.getByRole('toolbar',{name:'Действия с выделением'});
      await toolbar.getByRole('button',{name:'Выделить',exact:true}).click();
      await expect.poll(()=>savedQuotesForBook(page,id)).toHaveLength(1);
      const [original]=await savedQuotesForBook(page,id);expect(original!.text).toBe(phrase);
      const point=await glyphPoint(block,start+phrase.lastIndexOf(' ')+2,.5);
      const editor=page.getByRole('dialog',{name:'Комментарий к цитате'}),field=editor.getByLabel('Ваша заметка');
      await page.mouse.click(point.x,point.y);await expect(editor.locator('blockquote')).toHaveText(phrase);
      await expect(field).toHaveValue('');await field.fill('Первый комментарий.');
      await editor.getByRole('button',{name:'Сохранить',exact:true}).click();
      const commented={...original!,comment:'Первый комментарий.'};
      await expect.poll(()=>savedQuotesForBook(page,id)).toEqual([commented]);
      await page.mouse.click(point.x,point.y);await expect(field).toHaveValue(commented.comment);
      const geometry=await editor.evaluate(dialog=>{
        const label=dialog.querySelector('label')!,text=dialog.querySelector('textarea')!,form=dialog.querySelector('form')!;
        return {gap:text.getBoundingClientRect().top-label.getBoundingClientRect().bottom,
          width:Math.abs(form.getBoundingClientRect().width-text.getBoundingClientRect().width),label:label.htmlFor,field:text.id};
      });
      expect(geometry.gap).toBeGreaterThan(0);expect(geometry.width).toBeLessThanOrEqual(1);expect(geometry.label).toBe(geometry.field);
      await capture(page,'rc4-'+kind+'-edit-saved-quote');
      await field.fill('Несохранённый черновик');await field.press('Escape');await expect(editor).toHaveCount(0);
      await page.mouse.click(point.x,point.y);await expect(field).toHaveValue(commented.comment);
      await field.fill('Исправленный комментарий.');await editor.getByRole('button',{name:'Сохранить',exact:true}).click();
      const edited={...original!,comment:'Исправленный комментарий.'};
      await expect.poll(()=>savedQuotesForBook(page,id)).toEqual([edited]);
      await page.mouse.click(point.x,point.y);await field.fill('Оставить черновик');
      await editor.getByRole('button',{name:'Удалить цитату',exact:true}).click();
      const confirm=page.getByRole('alertdialog',{name:'Удалить цитату?'}),keep=confirm.getByRole('button',{name:'Оставить'});
      await expect(keep).toBeFocused();await expect(confirm.locator('blockquote')).toHaveText(phrase);
      await capture(page,'rc4-'+kind+'-quote-delete-confirm');await page.keyboard.press('Enter');
      await expect(field).toHaveValue('Оставить черновик');
      await expect(editor.getByRole('button',{name:'Удалить цитату',exact:true})).toBeFocused();
      await editor.getByRole('button',{name:'Отмена',exact:true}).click();expect(await savedQuotesForBook(page,id)).toEqual([edited]);
      await clickRail(page,'Цитаты');const panel=page.locator('.rc-panel'),request=panel.getByRole('button',{name:'Удалить цитату',exact:true});
      await request.click();await expect(keep).toBeFocused();await page.keyboard.press('Escape');await expect(request).toBeFocused();
      await request.click();await confirm.getByRole('button',{name:'Удалить цитату',exact:true}).click();
      await expect.poll(()=>savedQuotesForBook(page,id)).toEqual([]);await expect(panel).toContainText('Цитат пока нет');
      if(pdf)await expect(page.locator('.er-pdf-marks i')).toHaveCount(0);
      else await expect.poll(()=>block.evaluate(el=>(el.ownerDocument.defaultView as Window & typeof globalThis).CSS.highlights.has('reader-quotes'))).toBe(false);
    }finally{await page.close();}
  });
}


test('local EPUB and FB2 cover pixels survive library reload and the open button stays centered',async()=>{
 const page=await context.newPage();
 const paint=await readFile('tests/fixtures/quiet-coast-cover.png');
 try {
  await page.goto(libraryUrl);
  for(const kind of ['epub','fb2'] as const){
   const title='Shelf cover '+kind.toUpperCase();
   let buffer:Buffer;
   if(kind==='epub'){
    const files=unzipSync(reflowBook(kind));
    files['book.opf']=strToU8(strFromU8(files['book.opf']).replace('Coastal Review EPUB',title)
     .replace('</metadata>','<meta name="cover" content="jacket"/></metadata>')
     .replace('</manifest>','<item id="jacket" href="art/jacket.png" media-type="image/png"/></manifest>'));
    files['art/jacket.png']=new Uint8Array(paint);
    buffer=Buffer.from(zipSync(files));
   }else{
    const fb2=reflowBook(kind).toString().replace('Coastal Review FB2',title)
     .replace('</title-info>','<coverpage><image href="#jacket"/></coverpage></title-info>')
     .replace('</FictionBook>','<binary id="jacket" content-type="image/png">'+paint.toString('base64')+'</binary></FictionBook>');
    buffer=Buffer.from(fb2);
   }
   await page.locator('input[type=file]').setInputFiles({name:'shelf.'+kind,mimeType:kind==='epub'?'application/epub+zip':'application/x-fictionbook+xml',buffer});
   await expect(page.getByRole('slider',{name:'Позиция в книге'})).toBeEnabled();
   await clickRail(page,'Библиотека');
   const jacket=page.locator('.er-library-book').filter({has:page.getByRole('button',{name:title,exact:true})}).locator('.embedded-cover img');
   const painted=()=>jacket.evaluate((el:HTMLImageElement)=>el.complete && el.naturalWidth===224 && el.naturalHeight===320 && el.src.startsWith('data:image/'));
   await expect(jacket).toBeVisible();await expect.poll(painted).toBe(true);
   await page.reload();
   await expect(jacket).toBeVisible();await expect.poll(painted).toBe(true);
  }
  const center=await page.locator('.er-library-heading .er-library-opener').evaluate(el=>{
   const css=getComputedStyle(el);
   return css.display==='inline-flex' && css.alignItems==='center' && css.justifyContent==='center' &&
    css.paddingTop===css.paddingBottom && css.paddingLeft===css.paddingRight;
  });
  expect(center).toBe(true);
 } finally {await page.close();}
});

test('a saved settings confirmation centers its text in the area before the close button and restarts its two-second lifetime',async()=>{
  const page=await context.newPage();
  try{
    await page.goto(new URL('settings.html',libraryUrl).href);
    const save=page.getByRole('button',{name:'Сохранить настройки'});
    await expect(save).toBeEnabled();
    await page.clock.install({time:new Date('2020-01-01T09:00:00Z')});
    await page.clock.pauseAt(new Date('2020-01-01T09:01:00Z'));
    await save.click();
    const toast=page.locator('.settings-notification.success'),close=toast.getByRole('button',{name:'Закрыть уведомление'});
    await expect(toast.getByRole('status')).toHaveText('Настройки сохранены.');
    const offsets=await toast.evaluate(el=>{
      const toastRect=el.getBoundingClientRect();
      const innerLeft=toastRect.left+parseFloat(getComputedStyle(el).borderLeftWidth);
      const button=el.querySelector('button')!.getBoundingClientRect();
      const cross=el.querySelector('button svg')!.getBoundingClientRect();
      const range=document.createRange();
      range.selectNodeContents(el.querySelector('[role=status] span')!);
      const text=range.getBoundingClientRect();
      return [Math.abs((text.left-innerLeft)-(button.left-text.right))/2,
        Math.abs(button.left+button.width/2-cross.left-cross.width/2),
        Math.abs(button.top+button.height/2-cross.top-cross.height/2)];
    });
    expect(Math.max(...offsets)).toBeLessThanOrEqual(1);
    const firstAnnouncement=await toast.locator('[role=status] span').elementHandle();
    await page.clock.fastForward(1500);await save.click();
    await expect.poll(()=>firstAnnouncement!.evaluate(node=>node.isConnected)).toBe(false);
    await expect(toast.getByRole('status')).toHaveText('Настройки сохранены.');
    await page.clock.fastForward(1999);await expect(toast).toBeVisible();
    await page.clock.fastForward(1);await expect(toast).toHaveCount(0);
    await save.click();await close.click();await expect(toast).toHaveCount(0);
  }finally{await page.close();}
});

// Keep the built EPUB's own internal navigation tree separate from the reader drawer.
function bookWithLongContents(title:string) {
  const entries=unzipSync(reflowBook('epub',title));
  const longLabel='IntercontinentalHarbourPassage'.repeat(9);
  const body='<p><a href="c1.xhtml#start">'+longLabel+'</a></p>'+Array.from({length:42},(_,i)=>{
    const chapter=i%3;
    return '<p><a href="c'+chapter+'.xhtml#start">'+chapters[chapter]+' · Passage '+(i+1)+'</a></p>';
  }).join('');
  for(let i=0;i<3;i++){
    const key='c'+i+'.xhtml';
    let xml=strFromU8(entries[key]!).replace('<h1>', '<h1 id="start">');
    if(i===0)xml=xml.replace('</h1>','</h1><p>Coastal passages and harbours.</p>'+body);
    entries[key]=strToU8(xml);
  }
  return Buffer.from(zipSync(entries,{level:0}));
}

async function importGeometryBook(page:Page,kind:'epub'|'fb2'|'pdf',scenario:string){
  const title='Geometry '+kind+' '+scenario+' '+page.viewportSize()!.width;
  const buffer=kind==='epub'?bookWithLongContents(title):kind==='fb2'?reflowBook(kind,title):threePagePdf();
  await page.goto(libraryUrl);
  await page.locator('input[type=file]').setInputFiles({name:title+'.'+kind,
    mimeType:kind==='pdf'?'application/pdf':kind==='epub'?'application/epub+zip':'application/x-fictionbook+xml',buffer});
  if(kind==='pdf')await expect(page.locator('.er-pdf-page[data-page="1"] .textLayer span').first()).toBeVisible();
  else await expect(page.locator('.er-epub-viewport')).toHaveAttribute('aria-busy','false');
}

async function rectOfChrome(page:Page) {
  return page.evaluate(()=>{
    const r=document.querySelector('.rc-progress input')!.getBoundingClientRect(),doc=document.scrollingElement!;
    return {left:r.left,top:r.top,width:r.width,height:r.height,windowX:window.scrollX,windowY:window.scrollY,
      outerWidth:doc.scrollWidth,outerHeight:doc.scrollHeight};
  });
}

async function expectAppearanceClosed(page:Page) {
  await expect(page.locator('.rc-rail-appearance')).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('.rc-panel')).toHaveCount(0);
}

for(const width of [1920,480]){
  test('the vertical book has one full-height scrollbar and wheels through the spine at '+width+'px',async()=>{
    const page=await context.newPage();
    try{
      await page.setViewportSize({width,height:width===1920?1080:840});
      await importGeometryBook(page,'epub','wheel');
      const appearance=page.locator('.rc-rail-appearance'),panel=page.locator('.rc-panel');
      await appearance.click();
      const mode=panel.getByRole('switch',{name:'Вертикальная прокрутка'});
      if(await mode.getAttribute('aria-checked')!=='true')await mode.click();
      const frameHost=page.locator('.er-epub-scrolled .er-epub-viewport');
      await expect(frameHost).toHaveAttribute('aria-busy','false');
      const scroller=frameHost.locator(':scope > .epub-container');
      async function measure(){
        return scroller.evaluate(el=>{
          const view=el.closest('.rc-book-view')!,bounds=view.getBoundingClientRect(),r=el.getBoundingClientRect();
          const nodes=[view,...view.querySelectorAll('*')];
          for(const f of view.querySelectorAll('iframe')){
            const doc=f.contentDocument;if(doc)nodes.push(doc.documentElement,doc.body,...doc.body.querySelectorAll('*'));
          }
          const scrollable=(node:Element,axis:'X'|'Y')=>{
            const css=node.ownerDocument.defaultView!.getComputedStyle(node);
            return /^(auto|scroll|overlay)$/.test(css[axis==='X'?'overflowX':'overflowY'])&&
              (axis==='X'?node.scrollWidth-node.clientWidth:node.scrollHeight-node.clientHeight)>1;
          };
          return {one:nodes.filter(n=>scrollable(n,'Y')).length===1&&scrollable(el,'Y'),
            noX:!nodes.some(n=>scrollable(n,'X'))&&el.scrollWidth<=el.clientWidth+1,
            edge:Math.abs(bounds.right-r.right),top:Math.abs(bounds.top-r.top),bottom:Math.abs(bounds.bottom-r.bottom),
            outer:document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1};
        });
      }
      async function wrapsWithoutClipping(){
        const first=page.frameLocator('.er-epub-viewport iframe').first();
        const anchor=first.locator('a').filter({hasText:'IntercontinentalHarbourPassage'}).first();
        await expect.poll(()=>anchor.evaluate(el=>{
          const doc=el.ownerDocument,range=doc.createRange();range.selectNodeContents(el);
          const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
          const last=doc.querySelector('p:last-of-type')!,tail=doc.createRange();tail.selectNodeContents(last);
          const height=doc.defaultView!.innerHeight,width=doc.documentElement.clientWidth;
          return new Set(rects.map(r=>Math.round(r.top))).size>1&&rects.every(r=>r.left>=-1&&r.right<=width+1)&&
            tail.getBoundingClientRect().bottom<=height+2;
        })).toBe(true);
      }
      async function exactArea(){await expect.poll(measure).toEqual({one:true,noX:true,edge:expect.any(Number),top:expect.any(Number),bottom:expect.any(Number),outer:true});
        const rect=await measure();expect(Math.max(rect.edge,rect.top,rect.bottom)).toBeLessThanOrEqual(2);}
      await exactArea();await wrapsWithoutClipping();
      await panel.getByRole('button',{name:'Закрыть панель'}).click();
      await exactArea();await wrapsWithoutClipping();
      const visibleChapter=page.locator('.rc-chapter-name');
      await expect(visibleChapter).toContainText(chapters[0]!);
      const box=await scroller.boundingBox();expect(box).toBeTruthy();
      await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height*.7);
      for(let i=0;i<55&&(await visibleChapter.textContent())?.includes(chapters[0]!);i++){
        await page.mouse.wheel(0,Math.floor(box!.height*.9));
        await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      }
      await expect(visibleChapter).toContainText(chapters[1]!);
      await exactArea();
    }finally{await page.close();}
  });
}

test('a real internal TOC click in vertical EPUB closes appearance and remains at the destination after reflow',async()=>{
  const page=await context.newPage();
  try{
    await page.setViewportSize({width:1920,height:1080});await importGeometryBook(page,'epub','native link');
    const appearance=page.locator('.rc-rail-appearance');await appearance.click();
    const mode=page.getByRole('switch',{name:'Вертикальная прокрутка'});
    if(await mode.getAttribute('aria-checked')!=='true')await mode.click();
    await expect(page.locator('.er-epub-scrolled .er-epub-viewport')).toHaveAttribute('aria-busy','false');
    const contents=page.frameLocator('.er-epub-viewport iframe').first();
    await contents.getByRole('link',{name:'The Copper Gate · Passage 2',exact:true}).click();
    await expectAppearanceClosed(page);await expect(page.locator('.rc-chapter-name')).toHaveAttribute('title',chapters[1]!);
    await page.setViewportSize({width:1230,height:875});
    await expect.poll(()=>page.evaluate(()=>{
      const view=document.querySelector('.rc-book-view')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLIFrameElement>('.er-epub-viewport iframe')].some(f=>{
        const heading=f.contentDocument?.querySelector('h1'),rr=heading?.getBoundingClientRect();
        if(!rr||heading?.textContent!=='The Copper Gate')return false;
        const y=f.getBoundingClientRect().top+rr.top;
        return y>=view.top-45&&y<=view.bottom-10;
      });
    })).toBe(true);
    await expect(page.locator('.rc-chapter-name')).toHaveAttribute('title',chapters[1]!);
  }finally{await page.close();}
});

// Use native glyph and margin clicks, while the same built reader handles either
// PDF.js canvas or real EPUB/converted FB2 iframes. A press on bare paper must
// leave both document geometry and the slider fixed.
for(const [kind,width] of [['epub',1920],['fb2',1920],['pdf',1920],['epub',480]] as const){
  test(kind+' native text, blank paper and selection preserve the reading controls at '+width+'px',async()=>{
    const page=await context.newPage();
    try{
      await page.setViewportSize({width,height:width===1920?1080:840});
      await page.addInitScript(()=>{
        const interface_=chrome.runtime,original=interface_.sendMessage.bind(interface_);
        interface_.sendMessage=(async(message:any)=>{
          const data=message.type==='settings.getReader'?{sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US',
            grammarEnabled:true,grammarExplanationLanguage:'ru',grammarIncludeExplanation:true,defaultDeck:'Synthetic only',cloudAudioEnabled:false}:
            message.type==='lookup'?{lookupId:'11111111-1111-4111-8111-111111111111',expression:message.payload.expression,lemma:message.payload.expression,
              partOfSpeech:'noun',recommendedSenseId:'near',contextAmbiguous:false,senses:[{id:'near',translations:['у берега'],definition:'Beside the coast.'}]}:
            message.type==='grammar.lookup'?{grammarId:'22222222-2222-4222-8222-222222222222',sentence:message.payload.sentence,reason:'no_construction'}:
            message.type==='pronunciation.get'?{pronunciation:{ipa:'/ə/',dialect:'en-US',source:'dictionary',sourceUrl:null}}:undefined;
          return data?{v:1,requestId:message.requestId,ok:true,data}:original(message);
        }) as typeof original;
      });
      await importGeometryBook(page,kind,'blank');
      const appearance=page.locator('.rc-rail-appearance');
      const block=kind==='pdf'?page.locator('.textLayer span').filter({hasText:'First lighthouse'}).first():
        page.frameLocator('.er-epub-viewport iframe').first().locator('p').filter({hasText:kind==='fb2'?'Saffron':'Coastal passages'}).first();
      await expect(block).toBeVisible();
      await appearance.click();await expect(page.locator('.rc-panel')).toBeVisible();
      const selectPoint=await glyphPoint(block,1,.5),end=await glyphPoint(block,6,.8);
      await page.mouse.move(selectPoint.x,selectPoint.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:12});await page.mouse.up();
      await expect(page.getByRole('toolbar',{name:'Действия с выделением'})).toBeVisible();
      await expect(appearance).toHaveAttribute('aria-expanded','true');
      await page.keyboard.press('Escape');
      const nativeSelection=await block.evaluate(el=>el.ownerDocument.getSelection()?.toString());
      if(nativeSelection)await page.mouse.click(selectPoint.x,selectPoint.y);
      if(await appearance.getAttribute('aria-expanded')==='false')await appearance.click();
      const word=await glyphPoint(block,2,.5);await page.mouse.click(word.x,word.y);
      await expectAppearanceClosed(page);

      await appearance.click();
      const stage=await page.locator('.rc-book-view').boundingBox();expect(stage).toBeTruthy();
      const outer=await page.evaluate(({x,y,width,height})=>{
        for(const dx of [8,width-10,24,width-24,width/4,3*width/4]){
          for(const dy of [15,height/4,height*.73]){
            const at=document.elementFromPoint(x+dx,y+dy);
            if(at?.closest('.rc-book-view')&&!at.closest('button,iframe,.textLayer span,.rc-resize'))return {x:x+dx,y:y+dy};
          }
        }
        throw new Error('No visible outer book margin');
      },stage!);
      if(width===480){
        const input=await context.newCDPSession(page);
        await input.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
        await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[outer]});
        await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await input.send('Emulation.setTouchEmulationEnabled',{enabled:false});await input.detach();
      }else await page.mouse.click(outer.x,outer.y);
      await expectAppearanceClosed(page);
      if(kind==='pdf')return;

      await appearance.click();
      const innerBlank=async()=>{
        const box=await block.boundingBox();
        const pt=await block.evaluate(el=>{
        const doc=el.ownerDocument,body=doc.body;
        const text=doc.createRange();text.selectNodeContents(el);
        const line=text.getClientRects()[0]!,area=el.getBoundingClientRect();
        for(const x of [line.right+8,area.right-4,area.left+2]){
          const y=line.top+line.height/2;
          if(x<=0||x>=doc.documentElement.clientWidth||[...text.getClientRects()].some(r=>x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom))continue;
          if(body.contains(doc.elementFromPoint(x,y)))return {x:x-area.left,y:y-area.top};
        }
        throw new Error('Fixture has no blank inner margin');
      });
        return {x:box!.x+pt.x,y:box!.y+pt.y};
      };
      const ink=await glyphPoint(block,0,.5),openBlank=await innerBlank();
      await page.mouse.move(ink.x,ink.y);await page.mouse.click(openBlank.x,openBlank.y);await expectAppearanceClosed(page);
      // Closing the drawer can reflow the iframe. Resolve its inner blank again.
      const glyph=await glyphPoint(block,0,.5),closedBlank=await innerBlank();
      const before=await rectOfChrome(page);
      expect(before.outerWidth).toBeLessThanOrEqual(width+1);expect(before.outerHeight).toBeLessThanOrEqual(page.viewportSize()!.height+1);
      await page.mouse.move(glyph.x,glyph.y);await page.mouse.move(closedBlank.x,closedBlank.y);
      await page.keyboard.press('Shift');await page.keyboard.press('Shift');await page.keyboard.down('Shift');
      await page.keyboard.down('Shift');await page.keyboard.up('Shift');await page.keyboard.press('Alt');
      await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Наведите курсор на слово.',{exact:true})).toHaveCount(0);
      expect(await rectOfChrome(page)).toEqual(before);
      await expect(page.locator('#root > [role=status]')).toHaveCount(0);
      // Real books use a borderless iframe. A transparent two-pixel border makes
      // Chromium's parent-document hit target reproducible without dispatching events.
      const locator=page.locator('.er-epub-viewport iframe').first();
      await locator.evaluate(f=>{f.style.borderLeft='2px solid transparent';f.style.boxSizing='border-box';
        document.addEventListener('pointermove',e=>{if(e.target===f)f.dataset.geometryBorderHit='yes';},{once:false});});
      const frame=await locator.boundingBox();
      await page.mouse.move(glyph.x,glyph.y);await page.mouse.move(frame!.x+1,glyph.y);
      await expect(locator).toHaveAttribute('data-geometry-border-hit','yes');
      await page.keyboard.press('Shift');await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await rectOfChrome(page)).toEqual(before);
      for(const key of ['Shift','Alt']){
        const actual=await glyphPoint(block,1,.5);await page.mouse.move(actual.x,actual.y);
        await page.keyboard.press(key);await expect(page.getByRole('dialog')).toBeVisible();
        if(key==='Shift')await expect(page.getByRole('dialog')).toContainText('у берега');
        else await expect(page.getByRole('dialog')).toContainText('Отдельный разбор не нужен');
        await page.keyboard.press('Escape');
      }
    }finally{await page.close();}
  });
}
