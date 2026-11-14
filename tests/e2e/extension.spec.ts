import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
let context:BrowserContext, profile:string, extensionId:string;
test.beforeAll(async () => {
  const extensionPath=path.resolve('dist/english-reader');
  await readFile(path.join(extensionPath,'manifest.json'));
  profile=await mkdtemp(path.join(os.tmpdir(),'english-reader-e2e-'));
  context=await chromium.launchPersistentContext(profile, {
    executablePath:process.env.CHROMIUM_PATH || (process.platform==='linux'?'/usr/bin/chromium':undefined),
    headless:true,
    args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,'--no-sandbox'],
  });
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId=new URL(worker.url()).host;
});
test.afterAll(async () => {await context?.close();if(profile)await rm(profile,{recursive:true,force:true});});

test('trusted settings render disclosure and do not call providers on load',async()=>{
  const page=await context.newPage();const external:string[]=[];
  const capture=(request:import('@playwright/test').Request)=>{if(/^https?:/.test(request.url()))external.push(request.url());};
  context.on('request',capture);
  await context.route(/^https?:\/\//,route=>route.abort());
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  await expect(page.getByRole('heading',{name:'Настройка чтения'})).toBeVisible();
  await expect(page.getByText('API OpenAI оплачивается отдельно от подписки ChatGPT.',{exact:false})).toBeVisible();
  await expect(page.locator('input[name="openai-key"]')).toHaveAttribute('type','password');
  await expect(page.getByRole('button',{name:'Создать собственные типы заметок'})).toBeDisabled();
  expect(external).toEqual([]);
  await page.screenshot({path:'test-results/settings.png',fullPage:true});
  await page.close();context.off('request',capture);await context.unroute(/^https?:\/\//);
});

test('queue and library render headings without key-input controls',async()=>{
  const page=await context.newPage();
  for(const target of ['queue.html','library.html']){
    await page.goto(`chrome-extension://${extensionId}/${target}`);
    await expect(page.getByRole('heading',{name:target==='queue.html'?'Очередь заметок':'English Reader — локальная библиотека',exact:true})).toBeVisible();
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    await page.screenshot({path:`test-results/${target}.png`,fullPage:true});
  }
  await page.close();
});

test('text PDF and no-text PDF import through real file input',async()=>{
  const page=await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/library.html`);
  await page.locator('input[type="file"]').setInputFiles('tests/readers/fixtures/Текст PDF.pdf');
  await expect(page.locator('.textLayer')).toContainText('bank');
  await page.screenshot({path:'test-results/text-pdf.png',fullPage:true});
  await page.locator('input[type="file"]').setInputFiles('tests/readers/fixtures/no-text.pdf');
  await expect(page.getByText('Нет текстового слоя. OCR не поддерживается.',{exact:true})).toBeVisible();
  await page.close();
});

test('hostile EPUB renders text in script-free sandbox without remote resources',async()=>{
  const page=await context.newPage();const network:string[]=[];
  const capture=(request:import('@playwright/test').Request)=>{if(/^https?:/.test(request.url()))network.push(request.url());};
  context.on('request',capture);
  await context.route(/^https?:\/\//,route=>route.abort());
  await page.goto(`chrome-extension://${extensionId}/library.html`);
  await page.locator('input[type="file"]').setInputFiles('tests/readers/fixtures/Книга с пробелами.epub');
  const frame=page.locator('.er-epub-viewport iframe').first();
  await expect(frame).toHaveAttribute('sandbox','allow-same-origin');
  await expect(page.frameLocator('.er-epub-viewport iframe').first().locator('body')).toContainText('bank');
  const hostile=await page.frameLocator('.er-epub-viewport iframe').first().locator('script,form,iframe,object,embed').count();
  expect(hostile).toBe(0);expect(network).toEqual([]);
  expect(await page.evaluate(()=>('__bookExecuted' in window))).toBe(false);
  await page.screenshot({path:'test-results/epub.png',fullPage:true});
  await page.close();context.off('request',capture);await context.unroute(/^https?:\/\//);
});
