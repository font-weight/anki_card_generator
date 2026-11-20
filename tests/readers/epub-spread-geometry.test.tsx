import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {Layout, Rendition, type Location} from 'epubjs';
import {afterEach, expect, it, vi} from 'vitest';
import {EpubReader} from '../../apps/extension/src/readers/EpubReader';
import type {ReaderAppearance, StoredBook} from '../../apps/extension/src/readers/types';

const mocks = vi.hoisted(() => ({open: vi.fn()}));
vi.mock('epubjs', async original => ({...await original<typeof import('epubjs')>(), default: mocks.open}));
vi.mock('../../apps/extension/src/readers/epub-security', () => ({
  unpackEpub: async () => ({}), prepareSafeEpub: () => ({data:new ArrayBuffer(1), warnings:[], dispose(){}}),
}));
vi.mock('../../apps/extension/src/readers/fb2', () => ({
  convertFb2ToEpub: async (blob: Blob) => ({blob, warnings:[]}),
}));
vi.mock('../../apps/extension/src/readers/epub-progress', () => ({indexBookProgress: async () => null}));

// Only measuring text and assigning positions need browser layout. epub.js owns
// the iframe expansion, spread arithmetic, page mapping boundaries, movement and atEnd.
function measuredBook(columns: number[]) {
  const width = 1000, height = 600;
  const sections = columns.map((_, index) => ({
    index, href:index+'.xhtml', cfiBase:'/6/'+(2+2*index),
  }));
  const cfi = (base:string, px:number) => 'epubcfi('+base+'!/4/2/1:'+Math.floor(px)+')';
  let stage: HTMLElement, manager: any, location: () => Location, reflow: (flow:string, spread:string) => void;
  let left = 0;
  const book = {
    ready:Promise.resolve(), loaded:{navigation:Promise.resolve({toc:[]})},
    spine:{hooks:{serialize:{register(){}}}, first:()=>sections[0], last:()=>sections.at(-1)},
    locations:{locationFromCfi:()=>null}, pageList:{pageFromCfi:()=>-1},
    renderTo(host:HTMLElement, options:Parameters<import('epubjs').Book['renderTo']>[1]) {
      const Manager = Rendition.prototype.requireManager(options!.manager!);
      const View = Rendition.prototype.requireView(options!.view ?? 'iframe');
      manager = new Manager({view:View,settings:{...options,direction:'ltr',gap:0}});
      manager.render(host,{width,height});
      stage = manager.container;
      const box = () => new DOMRect(0,0,width,height);
      stage.getBoundingClientRect = box;
      manager.stage.size = () => ({width,height});
      manager.stage.bounds = box;
      manager._bounds = box();
      const measuredWidth = () => [...stage.children].reduce((sum, el) => sum+parseFloat((el as HTMLElement).style.width || '0'), 0);
      Object.defineProperties(stage,{
        scrollWidth:{get:measuredWidth},clientWidth:{get:()=>width},clientHeight:{get:()=>height},
        scrollLeft:{get:()=>left,set:(x:number)=>{left=Math.max(0,Math.min(x,measuredWidth()-width));}},
      });
      // All synthetic sections already exist. Background prefetch does not
      // need to load or recycle anything for this pagination test.
      manager.check = () => Promise.resolve();
      let flow = options!.flow!, spread = options!.spread!;
      const rendition = Object.create(Rendition.prototype);
      rendition.book = book;
      reflow = (nextFlow, nextSpread) => {
        flow=nextFlow; spread=nextSpread;
        manager.views.clear();
        const layout = new Layout({layout:'reflowable', minSpreadWidth:560, spread, evenSpreads:false});
        layout.flow(flow);
        manager.applyLayout(layout);
        manager.updateFlow(flow);
        sections.forEach((section,i) => {
          const view = manager.createView(section);
          manager.views.append(view);
          view.create(); view.element.append(view.iframe);
          view.lockedWidth=width; view.lockedHeight=height;
          view.contents = {textWidth:()=>columns[i]*manager.layout.pageWidth, textHeight:()=>height*columns[i], destroy(){}};
          // Leave iframe.expand() and reframe() intact, including epub.js's
          // rounding to columns and padding to a spread if requested by the reader.
          view.expand(); view.displayed=true;
          view.element.getBoundingClientRect=()=>{
            const earlier=[...stage.children].slice(0,i).reduce((n,el)=>n+parseFloat((el as HTMLElement).style.width),0);
            return new DOMRect(earlier-left,0,view.width(),view.height());
          };
        });
        manager.mapping.page=(_content:unknown,base:string,from:number,to:number)=>({start:cfi(base,from),end:cfi(base,to)});
        stage.scrollLeft=left;
      };
      reflow(flow,spread);
      location=()=>rendition.located(flow==='paginated' ? manager.paginatedLocation() : manager.scrolledLocation());
      Object.assign(rendition,{
        on(){},off(){},themes:{default(){},fontSize(){},override(){}},hooks:{content:{register(){}}},
        display:async()=>{}, currentLocation:location,
        next:()=>manager.next(), prev:()=>manager.prev(), resize(){},
        spread:(s:string)=>reflow(flow,s), flow:(f:string)=>reflow(f,spread),
      });
      return rendition;
    },
    destroy(){manager.q.stop();manager.destroy();},
  };
  return {book, location:()=>location(), widths:()=>[...stage.children].map(el=>parseFloat((el as HTMLElement).style.width)),
    offset:()=>stage.scrollLeft};
}

const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.unstubAllGlobals();});
async function mounted(columns:number[],kind:'epub'|'fb2',spread:'single'|'double'='double') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const geometry=measuredBook(columns);mocks.open.mockReturnValue(geometry.book);
  const node=document.body.appendChild(document.createElement('div')),root=createRoot(node);
  cleanups.push(async()=>{await act(async()=>root.unmount());node.remove();});
  const book:StoredBook={kind,documentId:kind+'-spread',title:'Spread',size:1,addedAt:0,blob:{arrayBuffer:async()=>new ArrayBuffer(1)} as Blob};
  const appearance:ReaderAppearance={kind,theme:'light',flow:'paginated',spread,fontSize:18,lineHeight:1.5};
  await act(async()=>root.render(<EpubReader book={book} appearance={appearance} onProgress={()=>{}}/>));
  const button=(label:string)=>node.querySelector<HTMLButtonElement>('button[aria-label="'+label+'"]')!;
  const next=button('Следующий экран'),prev=button('Предыдущий экран');
  const click=async(el:HTMLElement)=>{await act(async()=>el.click());};
  const choose=async(label:string)=>{
    if(button('Вид').getAttribute('aria-expanded')!=='true')await click(button('Вид'));
    await click([...node.querySelectorAll('button')].find(b=>b.textContent===label)!);
  };
  expect(node.querySelector('[role=alert]')?.textContent).toBeUndefined();
  return {...geometry,next,prev,choose,click};
}

it.each(['epub','fb2'] as const)('reaches the physical end of the last odd %s spread and returns through the middle',async kind=>{
  const r=await mounted([2,3],kind);
  expect(r.prev.disabled).toBe(true);expect(r.next.disabled).toBe(false);
  await r.click(r.next);
  expect(r.offset()).toBe(1000);expect(r.location().end.displayed.page).toBe(2);
  expect(r.next.disabled).toBe(false);expect(r.prev.disabled).toBe(false);
  await r.click(r.next);
  expect({page:r.location().end.displayed.page,total:r.location().end.displayed.total,atEnd:!!r.location().atEnd,enabled:!r.next.disabled})
    .toEqual({page:4,total:4,atEnd:true,enabled:false});
  expect(r.widths()).toEqual([1000,2000]);
  await r.click(r.next);expect(r.offset()).toBe(2000);
  await r.click(r.prev);expect(r.offset()).toBe(1000);expect(r.next.disabled).toBe(false);
  await r.click(r.prev);expect(r.prev.disabled).toBe(true);
});

it.each([1,2,4])('keeps the last chapter with %i columns reachable and disables Next only at the end',async count=>{
  const r=await mounted([2,count],'epub');
  await r.click(r.next);
  if(count>2){expect(r.next.disabled).toBe(false);await r.click(r.next);}
  expect(r.location().atEnd).toBe(true);expect(r.next.disabled).toBe(true);
  await r.click(r.prev);expect(r.next.disabled).toBe(false);
});

it('keeps single-page and vertical geometry, then remeasures the double spread on return',async()=>{
  const r=await mounted([3],'epub','single');
  expect(r.widths()).toEqual([3000]);
  await r.click(r.next);expect(r.next.disabled).toBe(false);
  await r.click(r.next);expect(r.next.disabled).toBe(true);
  await r.choose('Вертикальная прокрутка');expect(r.widths()).toEqual([1000]);
  await r.choose('Вертикальная прокрутка');
  await r.choose('Две страницы');
  expect(r.widths()).toEqual([2000]);
  await r.click(r.next);expect(r.location().atEnd).toBe(true);expect(r.next.disabled).toBe(true);
});
