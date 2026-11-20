import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ReaderChrome, ReaderGrammarConsent, ReaderQuoteList, ReaderSearch, ReflowControls, type ReaderChromeProps} from '../../apps/extension/src/readers/ReaderChrome';
import {QuoteSelectionTools,type QuoteSelection} from '../../apps/extension/src/readers/QuoteSelectionTools';
import {panelBounds, readerTheme} from '../../apps/extension/src/readers/reader-preferences';

describe('shared reader navigation',()=>{
  let node:HTMLDivElement, root:Root;
  beforeEach(()=>{
    Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
    localStorage.clear();
    node=document.createElement('div');document.body.append(node);root=createRoot(node);
  });
  afterEach(async()=>{
    await act(async()=>root.unmount());
    node.remove();localStorage.clear();
  });
  function button(label:string) {
    const match=Array.from(node.querySelectorAll('button')).find(el=>el.getAttribute('aria-label')===label || el.textContent===label);
    if(!match)throw new Error('Missing '+label);
    return match;
  }
  async function click(label:string){await act(async()=>button(label).click());}
  async function render(props:Partial<ReaderChromeProps>={},grammar=false) {
    await act(async()=>root.render(<ReaderGrammarConsent.Provider value={grammar}><ReaderChrome title="Test book" theme="white" onThemeChange={()=>{}}
      chapter={{label:'Глава 2',title:'Pier'}} page={{label:'Страница 3 из 9'}} bookmarked={false}
      search={<ReaderSearch query="[a+b]" onQuery={()=>{}} onSubmit={()=>{}} items={[{id:'hit',title:'Pier',excerpt:'İ — [A+B] and C',onOpen:()=>{}}]}/>}
      chapters={<p>Second chapter</p>} quotes={<p>Notes</p>} {...props}><div data-book-surface/></ReaderChrome></ReaderGrammarConsent.Provider>));
  }
  it('requires a second explicit action for a saved quote and preserves drafts on safe dismissal',async()=>{
    const fresh:QuoteSelection={rect:{top:10,bottom:30,left:50,right:120},text:'The harbour wall.'};
    const cancel=vi.fn(),save=vi.fn(),remove=vi.fn();
    const open=async(selection:QuoteSelection)=>{await act(async()=>root.render(<div data-reader-theme="cream"><QuoteSelectionTools
      selection={selection} onCancel={cancel} onSave={save} onDelete={remove}/></div>));};
    await open(fresh);await click('Комментарий');expect(node.querySelector('.er-quote-delete-request')).toBeNull();
    await open({...fresh,saved:{id:'second',comment:'Прежняя заметка'}});
    const textarea=node.querySelector('textarea')!;expect(textarea.labels?.[0].textContent).toBe('Ваша заметка');
    expect(textarea.previousElementSibling).toBe(textarea.labels?.[0]);
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Черновик');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));});
    await click('Удалить цитату');expect(node.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(document.activeElement).toBe(button('Оставить'));expect(remove).not.toHaveBeenCalled();
    await click('Оставить');expect(node.querySelector('textarea')!.value).toBe('Черновик');expect(document.activeElement).toBe(button('Удалить цитату'));
    await click('Удалить цитату');await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    expect(node.querySelector('textarea')!.value).toBe('Черновик');expect(cancel).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
    await click('Удалить цитату');await click('Удалить цитату');expect(remove.mock.calls).toEqual([['second']]);
  });
  it('keeps the book mounted, highlights literal matches and returns focus on Escape',async()=>{
    await render();
    const surface=node.querySelector('[data-book-surface]')!;
    await click('Поиск');
    expect(document.activeElement).toBe(node.querySelector('input[type=search]'));
    expect(node.querySelector('mark')?.textContent).toBe('[A+B]');
    await click('Оглавление');expect(node.querySelector('aside')?.textContent).toContain('Second chapter');
    await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    expect(node.querySelector('aside')).toBeNull();
    expect(document.activeElement).toBe(button('Главы'));
    expect(node.querySelector('[data-book-surface]')).toBe(surface);
  });
  it('keeps named bookmarks in their own panel, page controls on either side of the reading surface and the counter in the header',async()=>{
    const previous=vi.fn(),next=vi.fn();
    await render({bookmarks:<p>A named bookmark</p>,page:{label:'Страница 3 из 9',previous,next}});
    await click('Главы');expect(node.querySelector('.rc-panel')?.textContent).not.toContain('A named bookmark');
    await click('Закладки');expect(node.querySelector('.rc-panel h2')?.textContent).toBe('Закладки');
    expect(node.querySelector('.rc-panel')?.textContent).toContain('A named bookmark');
    const page=node.querySelector('.rc-book-view .rc-page')!;
    expect(page.previousElementSibling).toBe(button('Предыдущий экран'));
    expect(page.nextElementSibling).toBe(button('Следующий экран'));
    expect(node.querySelector('.rc-nav-page button')).toBeNull();
    expect(node.querySelector('.rc-nav-page [role=status]')?.textContent).toBe('Страница 3 из 9');
    await click('Предыдущий экран');await click('Следующий экран');
    expect(previous).toHaveBeenCalledOnce();expect(next).toHaveBeenCalledOnce();
    expect(node.querySelector('.rc-stage .rc-foot input[type=range]')).toBeTruthy();
  });
  it('shows Shift and left Alt together and refreshes the cost message without reopening the drawer',async()=>{
    await render();await click('Вид');
    expect([...node.querySelectorAll('.rc-shortcuts kbd')].map(el=>el.textContent)).toEqual(['Shift','Alt']);
    expect(node.querySelector('.rc-shortcuts small')?.textContent).toContain('Выключено в настройках');
    await render({},true);expect(node.querySelector('.rc-shortcuts small')?.textContent).toContain('Это платный запрос');
    await render({},false);expect(node.querySelector('.rc-shortcuts small')?.textContent).toContain('Выключено');
  });
  it('supports resizing the actual drawer with the keyboard and preserves its width after closing',async()=>{
    await render();await click('Поиск');
    const separator=node.querySelector<HTMLElement>('[role=separator]')!;
    const initial=Number(separator.getAttribute('aria-valuenow'));
    await act(async()=>separator.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(initial+16);
    expect(node.querySelector<HTMLElement>('.rc-workspace')!.style.getPropertyValue('--rc-panel-width')).toBe(`${initial+16}px`);
    await click('Закрыть панель');await click('Цитаты');
    expect(node.querySelector('[role=separator]')?.getAttribute('aria-valuenow')).toBe(String(initial+16));
    expect(panelBounds(250,true)).toEqual({minimum:236,maximum:236});
  });
  it('offers exactly three distinct themes, and preserves old book preferences',async()=>{
    const onThemeChange=vi.fn();await render({theme:'graphite',onThemeChange});await click('Вид');
    const choices=node.querySelectorAll('.rc-theme-button');
    expect(choices).toHaveLength(3);expect(button('Графит').getAttribute('aria-pressed')).toBe('true');
    await click('Кремовая');expect(onThemeChange).toHaveBeenCalledWith('cream');
    expect(readerTheme('dark')).toBe('graphite');expect(readerTheme('light')).toBe('white');
  });
  it('commits a scrub once on release, and supports direct keyboard changes',async()=>{
    const onSeek=vi.fn();
    await render({progress:28,onSeek});
    const input=node.querySelector<HTMLInputElement>('.rc-progress input')!;
    const change=async(value:number)=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,String(value));
      await act(async()=>input.dispatchEvent(new Event('input',{bubbles:true})));
    };
    await act(async()=>input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:2})));
    await change(33);await change(57);expect(onSeek).not.toHaveBeenCalled();
    await act(async()=>input.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2})));
    expect(onSeek.mock.calls).toEqual([[57]]);
    await change(29);expect(onSeek.mock.calls).toEqual([[57],[29]]);
  });
  it('retains successive native range steps when the parent quantizes to the same reported position',async()=>{
    const raw:number[]=[];
    function QuantizedReader(){
      const [page,setPage]=React.useState(1);
      return <ReaderChrome title="Short book" theme="white" onThemeChange={()=>{}} page={{label:String(page)}}
        progress={(page-1)*50} onSeek={percent=>{raw.push(percent);setPage(1+Math.round(percent/50));}}
        bookmarked={false} search={null} chapters={null} quotes={null}>{page}</ReaderChrome>;
    }
    await act(async()=>root.render(<QuantizedReader/>));
    const slider=node.querySelector<HTMLInputElement>('input[type=range]')!;
    for(let i=0;i<2;i++){
      const value=slider.valueAsNumber+Number(slider.step);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(slider,String(value));
      await act(async()=>slider.dispatchEvent(new Event('input',{bubbles:true})));
    }
    expect(raw).toEqual([.1,.2]);
  });
  it('keeps page layout and publisher styling independent of the chosen theme',async()=>{
    const theme=vi.fn(),publisher=vi.fn(),spread=vi.fn(),size=vi.fn(),line=vi.fn();
    await render({onThemeChange:theme,appearance:<ReflowControls fontSize={20} lineHeight={1.7}
      publisher={false} scrolling={false} spread={false} onScrolling={()=>{}} onFontSize={size} onLineHeight={line}
      onSpread={spread} onPublisher={publisher}/>});
    await click('Вид');await click('Оформление издателя');await click('Две страницы');
    await click('Увеличить: Размер шрифта');await click('Уменьшить: Интервал строк');
    expect(publisher).toHaveBeenCalledWith(true);expect(spread).toHaveBeenCalledWith(true);
    expect(size).toHaveBeenCalledWith(21);expect(line).toHaveBeenCalledWith(1.5);expect(theme).not.toHaveBeenCalled();
  });
  it('returns to a saved quote and closes the drawer on a narrow screen',async()=>{
    vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(330);
    const open=vi.fn();
    await render({quotes:<ReaderQuoteList title="Book" items={[{id:'q',text:'At dawn',comment:'Рассвет',location:'Глава 2',onOpen:open}]}/>});
    await click('Цитаты');
    expect(node.querySelector('.rc-quote-note')?.textContent).toBe('Рассвет');
    await click('К фрагменту ');expect(open).toHaveBeenCalledOnce();expect(node.querySelector('aside')).toBeNull();
  });
});
