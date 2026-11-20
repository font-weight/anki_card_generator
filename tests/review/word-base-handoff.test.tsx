import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ActionMenu} from '../../apps/extension/src/action/ActionMenu';
import {QueueApp} from '../../apps/extension/src/ui/QueueApp';
import {uiCss} from '../../apps/extension/src/ui/styles';
import type {UiRpc} from '../../apps/extension/src/ui/interfaces';

let host:HTMLDivElement, root:ReturnType<typeof createRoot>;
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  host=document.createElement('div'); host.id='root'; document.body.append(host); root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});

function exportSnapshot(name:string,css:string,icon?:string){
  const destination=process.env.LR_REVIEW_DOM;
  if(!destination)return;
  const copy=host.cloneNode(true) as HTMLElement;
  if(icon) {
    const img=copy.querySelector<HTMLImageElement>('img.action-brand-mark')!;
    img.setAttribute('src','data:image/png;base64,'+readFileSync(icon).toString('base64'));
  }
  mkdirSync(destination,{recursive:true});
  writeFileSync(path.join(destination,name+'.html'),'<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Language Reader for Anki</title><style>'+css+'</style></head><body style="margin:0">'+copy.outerHTML+'</body></html>\n');
}

it('captures the real toolbar menu of an eligible web page when grammar is disabled',async()=>{
  const event={addListener:vi.fn(),removeListener:vi.fn()};
  const create=vi.fn(),sendMessage=vi.fn(),readGrammarEnabled=vi.fn(async()=>false);
  vi.stubGlobal('chrome',{
    runtime:{getURL:(p:string)=>'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'+p,sendMessage},
    tabs:{query:async()=>[{id:12,url:'https://gutenberg.org/ebooks/'}],create,onActivated:event,onUpdated:event},
  });
  await act(async()=>root.render(<ActionMenu readGrammarEnabled={readGrammarEnabled}/>));
  expect(host.querySelector('.action-page-label bdi')?.textContent).toBe('gutenberg.org');
  expect(host.querySelector('.action-primary')?.textContent).toBe('Включить чтение');
  expect(host.querySelector<HTMLImageElement>('.action-brand-mark')?.getAttribute('src')).toBe('icons/icon32.png');
  expect([...host.querySelectorAll('kbd')].map(k=>k.textContent)).toEqual(['Shift']);
  expect(host.querySelector('nav')?.textContent).toContain('База слов');
  expect(readGrammarEnabled).toHaveBeenCalledOnce();expect(create).not.toHaveBeenCalled();expect(sendMessage).not.toHaveBeenCalled();
  exportSnapshot('action-popup',readFileSync('apps/extension/src/action/action.css','utf8'),'apps/extension/public/icons/icon32.png');
});

it('captures the loaded empty word base with a real route back to the book library',async()=>{
  const rpc=vi.fn(async()=>({items:[],nextCursor:null})) as UiRpc;
  await act(async()=>root.render(<QueueApp rpc={rpc}/>));
  expect(host.querySelector('.wb-heading')?.textContent).toContain('0 записей');
  expect(host.querySelector('.wb-empty h2')?.textContent).toBe('Пока нет сохранённых слов');
  expect(host.querySelector<HTMLAnchorElement>('.wb-empty a')?.getAttribute('href')).toBe('library.html');
  expect(host.querySelectorAll('article,dialog')).toHaveLength(0);
  expect(vi.mocked(rpc).mock.calls.map(x=>x[0])).toEqual(['queue.list']);
  // The standalone document flattens the page's ShadowRoot for offline print engines.
  exportSnapshot('word-base-empty',uiCss.replaceAll(':host',':root')+'\n'+readFileSync('apps/extension/src/ui/word-base.css','utf8'));
});
