// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {EpubCFI,Layout,Rendition,type Book,type Contents,type Location} from 'epubjs';
import {afterEach,expect,it,vi} from 'vitest';
import {EpubReader} from '../../apps/extension/src/readers/EpubReader';
import type {ReadingProgress,StoredBook} from '../../apps/extension/src/readers/types';

const open=vi.hoisted(()=>vi.fn());
vi.mock('epubjs',async original=>({...await original<typeof import('epubjs')>(),default:open}));
vi.mock('../../apps/extension/src/readers/epub-security',()=>({
  unpackEpub:async()=>({}),prepareSafeEpub:()=>({data:new ArrayBuffer(1),warnings:[],dispose:()=>{}}),
}));
vi.mock('../../apps/extension/src/readers/fb2',()=>({convertFb2ToEpub:async(blob:Blob)=>({blob,warnings:[]})}));

const screenHeight=800,screenWidth=600;
const roots:ReturnType<typeof createRoot>[]=[];
afterEach(async()=>{
  for(const root of roots.splice(0))await act(async()=>root.unmount());
  document.body.replaceChildren();vi.unstubAllGlobals();
});

type Geometry={lengths:number[];textLengths?:number[];wrapped?:boolean;loaded?:number[];kind?:'epub'|'fb2';flow?:'scrolled'|'paginated'};
const wrappedText='Mara walked down the long road at dawn.';
function measureWrappedLines(doc:Document){
  const lineStarts=[0,12,21,31];
  const line=(offset:number)=>lineStarts.filter(start=>start<=offset).length-1;
  const first=doc.querySelector('p')!.firstChild;
  Object.defineProperty(doc.defaultView!.Range.prototype,'getBoundingClientRect',{configurable:true,value(this:Range){
    if(this.startContainer!==first)return new DOMRect(0,80,300,880);
    const top=line(this.startOffset)*20,bottom=line(Math.max(this.startOffset,this.endOffset-1))*20+16;
    return new DOMRect(0,top,100,bottom-top);
  }});
}
// jsdom has no glyph layout. A character occupies one measurable unit in each
// synthetic chapter. epub.js computes visibility, page counts, CFIs, endpoint
// flags and page movement; the production component and progress index consume them.
async function reader({lengths,textLengths=lengths,wrapped=false,loaded=lengths.map((_,i)=>i),kind='epub',flow='scrolled'}:Geometry){
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('innerHeight',1000);
  const vertical=flow==='scrolled';
  let height=screenHeight;
  const screen=()=>vertical?height:screenWidth;
  const host=document.createElement('main');document.body.append(host);
  const root=createRoot(host);roots.push(root);
  const progress=vi.fn<(value:ReadingProgress)=>void>();
  const sections=lengths.map((length,index)=>({
    index,href:'c'+index+'.xhtml',url:'/c'+index,linear:true,cfiBase:'/6/'+(2+2*index),
    html:wrapped?'<p>'+wrappedText+'</p><p>Beyond the harbour wall.</p>':
      '<p>'+String.fromCharCode(65+index).repeat(textLengths[index]!)+'</p>'+(textLengths[index]!<length?'<img alt="Coastline">':''),
    cfiFromRange:(range:Range)=>new EpubCFI(range,'/6/'+(2+2*index)).toString(),
  }));
  const getSection=(position:string|number)=>typeof position==='number'?sections[position]:
    position.startsWith('epubcfi(')?sections[new EpubCFI(position).spinePos]:sections.find(s=>s.href===position);
  const spine={get:getSection,first:()=>sections[0],last:()=>sections.at(-1),
    each:(fn:(section:typeof sections[number])=>void)=>sections.forEach(fn),hooks:{serialize:{register:vi.fn()}}};
  const book={
    archived:true,archive:{getText:async(url:string)=>sections.find(s=>s.url===url)!.html},
    ready:Promise.resolve(),loaded:{navigation:Promise.resolve({toc:sections.map(s=>({id:'chapter'+s.index,href:s.href,label:'Chapter '+s.index}))})},
    spine,locations:{locationFromCfi:()=>null},pageList:{pageFromCfi:()=>-1},
    renderTo:(container:HTMLElement)=>{
      container.append(stage);
      Object.defineProperties(container,{clientHeight:{get:()=>height},clientWidth:{value:screenWidth}});
      Object.defineProperties(stage,{
        [vertical?'scrollTop':'scrollLeft']:{get:()=>offset,set:(n:number)=>{offset=Math.max(0,Math.min(Math.max(0,extent-screen()),n));}},
        clientHeight:{get:()=>height},clientWidth:{value:screenWidth},
        scrollHeight:{get:()=>vertical?Math.max(extent,height):height},
        scrollWidth:{value:vertical?screenWidth:Math.max(extent,screenWidth)},
      });
      stage.getBoundingClientRect=()=>new DOMRect(23,31,screenWidth,height);
      let start=0;
      for(const i of loaded){
        const el=document.createElement('div'),frame=document.createElement('iframe');
        el.className='epub-view';el.setAttribute('ref',String(i));el.append(frame);stage.append(el);
        frame.setAttribute('sandbox','allow-same-origin');
        Object.defineProperty(frame,'sandbox',{value:{contains:()=>false}});
        const length=lengths[i]!,base=start;start+=length;
        const bounds=()=>new DOMRect(vertical?23:23+base-offset,vertical?31+base-offset:31,
          vertical?screenWidth:length,vertical?length:height);
        el.getBoundingClientRect=bounds;frame.getBoundingClientRect=bounds;
        Object.defineProperties(el,{offsetHeight:{get:()=>bounds().height},offsetWidth:{get:()=>bounds().width}});
        const doc=frame.contentDocument!;doc.body.innerHTML=sections[i]!.html;
        if(wrapped)measureWrappedLines(doc);
        const contents={window:frame.contentWindow,document:doc,sectionIndex:i,emit:vi.fn()} as unknown as Contents;
        views.push({element:el,section:sections[i]!,contents,position:bounds,height:()=>bounds().height,width:()=>bounds().width});
      }
      return rendition;
    },destroy:vi.fn(),
  };
  const extent=loaded.reduce((n,i)=>n+lengths[i]!,0);
  const stage=document.createElement('div');stage.className='epub-container';
  let offset=0;
  const views:{element:HTMLElement;section:typeof sections[number];contents:Contents;position:()=>DOMRect;height:()=>number;width:()=>number}[]=[];
  const Continuous=Rendition.prototype.requireManager('continuous');
  const manager=new Continuous({settings:{axis:vertical?'vertical':'horizontal',direction:'ltr'}});
  const layout=new Layout({layout:'reflowable',spread:'none',minSpreadWidth:560,evenSpreads:false});
  layout.flow(flow);layout.calculate(screenWidth,screenHeight,0);
  manager.layout=layout;manager.isPaginated=!vertical;manager.container=stage;
  manager.bounds=()=>stage.getBoundingClientRect();manager.updateLayout=()=>{};
  manager.setLayout(layout);
  manager.views={get length(){return views.length;},displayed:()=>views,all:()=>views};
  // The fixture has no asynchronous section loader. Real manager.next/prev can
  // still use their normal scrollBy path, with browser-style clamped offsets.
  manager.q={enqueue:()=>{}};
  if(!wrapped)manager.mapping={page:(contents:Contents,base:string,start:number,end:number)=>{
    const doc=contents.document,text=doc.querySelector('p')!.firstChild as Text;
    const at=(coordinate:number)=>{
      const range=doc.createRange();range.setStart(text,Math.min(text.length,Math.max(0,Math.trunc(coordinate))));range.collapse(true);
      return new EpubCFI(range,base).toString();
    };
    return {start:at(start),end:at(end)};
  }};
  let contentHook:((contents:Contents)=>void)|undefined,relocated:((location:Location)=>void)|undefined;
  const rendition=Object.assign(Object.create(Rendition.prototype) as Rendition,{
    book:book as unknown as Book,manager,epubcfi:new EpubCFI(),
    hooks:{content:{register:(fn:typeof contentHook)=>{contentHook=fn;}}},
    on:(type:string,fn:typeof relocated)=>{if(type==='relocated')relocated=fn;},off:vi.fn(),
    themes:{default:vi.fn(),fontSize:vi.fn(),override:vi.fn()},resize:vi.fn(),
    display:vi.fn(async(cfi?:string)=>{
      if(!connected){for(const view of views)contentHook!(view.contents);connected=true;}
      if(!cfi)return;
      const point=new EpubCFI(cfi),view=views.find(v=>v.section.index===point.spinePos);
      if(!view)return;
      const preceding=loaded.slice(0,loaded.indexOf(view.section.index)).reduce((sum,i)=>sum+lengths[i]!,0);
      setOffset(preceding+point.toRange(view.contents.document).startOffset);
    }),
    next:vi.fn(async()=>manager.next()),prev:vi.fn(async()=>manager.prev()),
  });
  function setOffset(value:number){if(vertical)stage.scrollTop=value;else stage.scrollLeft=value;}
  let connected=false;open.mockReturnValue(book);
  const source:StoredBook={kind,title:'Sea passages',documentId:'geometry',size:1,addedAt:0,blob:{arrayBuffer:async()=>new ArrayBuffer(1)} as Blob};
  const slider=()=>host.querySelector<HTMLInputElement>('.rc-progress input')!;
  await act(async()=>root.render(<EpubReader book={source} onProgress={progress}
    appearance={{kind,flow,fontSize:20,lineHeight:1.5,theme:'cream'}}/>));
  await act(async()=>{await vi.waitFor(()=>expect(progress.mock.calls.at(-1)?.[0].percent).toBeDefined());});
  await vi.waitFor(()=>expect(slider()?.disabled).toBe(false));
  // epub.js 0.3.93 types describe currentLocation as a single endpoint, while
  // the runtime returns a start/end pair as consumed by EpubReader.
  const location=()=>rendition.currentLocation() as unknown as Location;
  const move=async(value:number)=>act(async()=>{
    views[0]!.contents.document.dispatchEvent(new Event('wheel'));
    setOffset(value);stage.dispatchEvent(new Event('scroll'));relocated!(location());
  });
  const resize=async(value:number)=>act(async()=>{
    height=value;layout.calculate(screenWidth,height,0);window.dispatchEvent(new Event('resize'));
  });
  const previous=host.querySelector<HTMLButtonElement>('[aria-label="Предыдущий экран"]')!;
  const next=host.querySelector<HTMLButtonElement>('[aria-label="Следующий экран"]')!;
  const key=async(target:EventTarget,name:string)=>{
    const e=new KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true});
    await act(async()=>{target.dispatchEvent(e);});return e.defaultPrevented;
  };
  const current=()=>progress.mock.calls.at(-1)![0];
  return {previous,next,slider,key,move,resize,current,location,rendition,offset:()=>offset,body:views[0]!.contents.document.body};
}

for(const kind of ['epub','fb2'] as const){
  it(kind+': a 1500px final chapter in an 800px viewport remains pageable until its physical bottom',async()=>{
    const r=await reader({kind,lengths:[1500]});
    expect(r.location().atEnd).toBe(true); // upstream already flags 2/2 with 700px still below the fold
    expect(r.previous.disabled).toBe(true);expect(r.next.disabled).toBe(false);
    for(const top of [1,5,350]){
      await r.move(top);expect(r.next.disabled).toBe(false);
      if(top===1)expect(r.current().percent).toBeLessThan(1);
      else {expect(r.current().percent).toBeCloseTo(top*100/1500);expect(r.previous.disabled).toBe(false);}
    }
    expect(await r.key(r.body,'PageDown')).toBe(true);expect(r.offset()).toBe(700);
    expect(r.next.disabled).toBe(true);expect(r.previous.disabled).toBe(false);expect(r.current().percent).toBe(100);
    expect(await r.key(r.body,'PageDown')).toBe(false);
    await act(async()=>r.previous.click());expect(r.offset()).toBe(0);
    expect(r.previous.disabled).toBe(true);expect(r.next.disabled).toBe(false);expect(r.current().percent).toBe(0);
    await act(async()=>r.next.click());expect(r.offset()).toBe(700);
    expect(await r.key(r.body,'PageUp')).toBe(true);expect(r.offset()).toBe(0);
  });
}
it('a 2400px final chapter remains reachable by arrow and keyboard from an early epub.js endpoint',async()=>{
  const r=await reader({lengths:[2400]});
  await r.move(1);expect(r.location().atEnd).toBe(true);
  expect(r.next.disabled).toBe(false);expect(r.current().percent).toBeLessThan(1);
  await r.move(400);expect(r.location().atEnd).toBe(true);
  expect(r.current().percent).toBeCloseTo(100/6);expect(r.next.disabled).toBe(false);
  await act(async()=>r.next.click());expect(r.offset()).toBe(1200);expect(r.next.disabled).toBe(false);
  expect(await r.key(r.body,'PageDown')).toBe(true);expect(r.offset()).toBe(1600);expect(r.next.disabled).toBe(true);
  await r.move(600);expect(r.previous.disabled).toBe(false);expect(r.next.disabled).toBe(false);
  expect(r.current().percent).toBeCloseTo(25);
});
it('a complete short book really fits, and a partially loaded middle spine section has neither book endpoint',async()=>{
  const short=await reader({lengths:[500]});
  expect(short.previous.disabled).toBe(true);expect(short.next.disabled).toBe(true);
  expect(await short.key(short.body,'PageDown')).toBe(false);
  const middle=await reader({lengths:[600,1200,900],loaded:[1]});
  for(const top of [0,400]){
    await middle.move(top);
    expect(middle.previous.disabled).toBe(false);expect(middle.next.disabled).toBe(false);
    expect(middle.current().percent).toBeCloseTo((600+top)*100/2700);
  }
});
it('recognizes a short final section while the tail of the previous section is still visible',async()=>{
  const r=await reader({lengths:[1400,300]});
  await r.move(890);
  expect(r.location()).toMatchObject({start:{index:0},end:{index:1},atEnd:true});
  expect(r.next.disabled).toBe(false);expect(r.current().percent).toBeCloseTo(890*100/1700);
  await act(async()=>r.next.click());
  expect(r.offset()).toBe(900);expect(r.location().start.index).toBe(0);
  expect(r.next.disabled).toBe(true);expect(r.previous.disabled).toBe(false);expect(r.current().percent).toBe(100);
});
it('a smaller viewport reopens Next at the same CFI and identical epub.js displayed page numbers',async()=>{
  const r=await reader({lengths:[1500]});
  await r.move(700);expect(r.next.disabled).toBe(true);
  const original=r.location();
  await r.resize(760);
  const after=r.location();
  expect(after.start.cfi).toBe(original.start.cfi);
  expect(after.start.displayed).toEqual(original.start.displayed);expect(after.end.displayed).toEqual(original.end.displayed);
  expect(after.atEnd).toBe(true);expect(r.offset()).toBe(700);expect(r.next.disabled).toBe(false);
  expect(await r.key(r.body,'PageDown')).toBe(true);expect(r.offset()).toBe(740);expect(r.next.disabled).toBe(true);
});
it('End and Home on the whole-book slider follow the actual CFI and keep the final chapter navigable after returning',async()=>{
  const r=await reader({lengths:[1500]});
  await r.move(350);
  expect(await r.key(r.slider(),'End')).toBe(true);
  expect(new EpubCFI(r.rendition.display.mock.lastCall![0]!).toRange(r.body.ownerDocument).startOffset).toBe(1500);
  expect(r.offset()).toBe(700);expect(r.next.disabled).toBe(true);expect(r.current().percent).toBe(100);
  expect(await r.key(r.slider(),'Home')).toBe(true);expect(r.offset()).toBe(0);expect(r.current().percent).toBe(0);
  expect(r.next.disabled).toBe(false);expect(r.previous.disabled).toBe(true);
});
it('does not show 100% before trailing artwork and lets End reach its visible bottom',async()=>{
  const r=await reader({lengths:[2800],textLengths:[1000]});
  for(const top of [999,1200]){
    await r.move(top);expect(r.next.disabled).toBe(false);expect(r.current().percent).toBeLessThan(100);
    expect(r.slider().getAttribute('aria-valuetext')).toBe('99% книги');
  }
  expect(await r.key(r.slider(),'End')).toBe(true);
  expect(r.offset()).toBe(2000);expect(r.next.disabled).toBe(true);
  expect(r.slider().getAttribute('aria-valuetext')).toBe('100% книги');
  expect(await r.key(r.slider(),'Home')).toBe(true);
  expect(r.offset()).toBe(0);expect(r.previous.disabled).toBe(true);
});
it('keeps progress moving with the viewport when the real epub.js word map doubles back on a wrapped line',async()=>{
  const r=await reader({lengths:[1700],wrapped:true});
  const sample=async(top:number)=>{
    await r.move(top);
    return {offset:new EpubCFI(r.location().start.cfi).toRange(r.body.ownerDocument).startOffset,percent:r.current().percent!};
  };
  const a=await sample(55),b=await sample(61),c=await sample(60);
  expect([a.offset,b.offset,c.offset]).toEqual([31,0,31]);
  expect(a.percent).toBeGreaterThan(0);
  expect(b.percent).toBeGreaterThanOrEqual(a.percent);expect(c.percent).toBeLessThanOrEqual(b.percent);
  const back=await sample(20);expect(back.percent).toBeLessThan(c.percent);
  await sample(0);expect(r.current().percent).toBe(0);
});
it('keeps one-page horizontal pagination independent of vertical stage geometry',async()=>{
  const r=await reader({lengths:[1800],flow:'paginated'});
  expect(r.previous.disabled).toBe(true);expect(r.next.disabled).toBe(false);
  await act(async()=>r.next.click());expect(r.offset()).toBe(600);
  expect(r.previous.disabled).toBe(false);expect(r.next.disabled).toBe(false);
  expect(await r.key(r.body,'PageDown')).toBe(true);expect(r.offset()).toBe(1200);
  expect(r.next.disabled).toBe(true);expect(r.previous.disabled).toBe(false);
});
