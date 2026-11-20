import {type Contents,Layout,Rendition} from 'epubjs';
import {expect,it,vi} from 'vitest';
import {formatBookContents} from '../../apps/extension/src/readers/epub-format';

interface Section {index:number;prev:()=>Section|undefined;next:()=>Section|undefined}

// jsdom supplies no text layout. Give each synthetic section 900px of measured
// height, while epub.js itself owns the stage, scroll listener, queue and spine views.
class MeasuredSection {
  element=document.createElement('section');
  displayed=false;
  on=vi.fn();
  show=vi.fn();
  hide=vi.fn();
  setLayout=vi.fn();
  constructor(public section:Section){this.element.textContent='Chapter '+section.index;}
  async display(){this.displayed=true;return this;}
  destroy(){this.displayed=false;}
  position(){
    const stage=this.element.parentElement!;
    const top=Array.from(stage.children).indexOf(this.element)*900-stage.scrollTop;
    return {top,bottom:top+900,left:0,right:660};
  }
}

it('loads the next and previous spine sections from scroll events in the same real epub.js stage',async()=>{
  const host=document.createElement('div');
  document.body.append(host);
  const Manager=Rendition.prototype.requireManager('continuous');
  const manager=new Manager({view:MeasuredSection,settings:{direction:'ltr',offset:100}});
  const layout=new Layout({layout:'reflowable',spread:'none',minSpreadWidth:560,evenSpreads:false});
  manager.updateFlow('scrolled');
  manager.render(host,{width:660,height:400});
  const stage=host.querySelector<HTMLElement>('.epub-container')!;
  Object.defineProperties(stage,{
    clientHeight:{get:()=>400},clientWidth:{get:()=>660},
    scrollHeight:{get:()=>stage.children.length*900}
  });
  stage.getBoundingClientRect=()=>new DOMRect(0,0,660,400);
  manager.applyLayout(layout);
  manager._bounds=stage.getBoundingClientRect();
  const sections:Section[]=[0,1,2].map(index=>({index,prev:()=>sections[index-1],next:()=>sections[index+1]}));
  const scroll=(top:number)=>{stage.scrollTop=top;stage.dispatchEvent(new Event('scroll'));};
  try{
    await manager.append(sections[1]).display();
    expect(stage.style.overflowY).toBe('scroll');
    expect(stage.style.overflowX).toBe('hidden');
    scroll(480);
    await vi.waitFor(()=>expect(stage.textContent).toBe('Chapter 1Chapter 2'));
    scroll(0);
    await vi.waitFor(()=>expect(stage.textContent).toBe('Chapter 0Chapter 1Chapter 2'));
    manager.updateFlow('paginated');
    expect(manager.settings.axis).toBe('horizontal');
    expect(stage.style.overflow).toBe('hidden');
    manager.updateFlow('scrolled');
    expect(manager.settings.axis).toBe('vertical');
    expect(host.querySelectorAll('.epub-container')).toHaveLength(1);
    expect(host.firstElementChild).toBe(stage);
  }finally{
    clearTimeout(manager.trimTimeout);manager.q.stop();manager.destroy();host.remove();
  }
});

it('retains the complete link and preformatted text while rewrapping scroll flow and restoring page flow',()=>{
  const frame=document.createElement('iframe');document.body.append(frame);
  try{
    const doc=frame.contentDocument!,link=doc.createElement('a'),pre=doc.createElement('pre');
    link.href='chapter.xhtml#end';link.textContent='LongTableOfContentsEntry'.repeat(12);
    pre.textContent='0123456789'.repeat(28);doc.body.append(link,pre);
    const reference=doc.body.textContent,emit=vi.fn();
    const contents={document:doc,emit} as unknown as Contents;
    for(const flow of ['scrolled','paginated','scrolled'] as const){
      formatBookContents(contents,{kind:'epub',fontSize:20,lineHeight:1.5,theme:'cream',flow});
      expect(doc.body.textContent).toBe(reference);
      expect(link.getAttribute('href')).toBe('chapter.xhtml#end');
      const css=frame.contentWindow!.getComputedStyle(doc.body);
      expect(css.overflowWrap).toBe(flow==='scrolled'?'anywhere':'break-word');
      if(flow==='scrolled')expect(frame.contentWindow!.getComputedStyle(pre).whiteSpace).toBe('pre-wrap');
    }
    expect(emit.mock.calls).toEqual([['expand'],['expand']]);
  }finally{frame.remove();}
});
