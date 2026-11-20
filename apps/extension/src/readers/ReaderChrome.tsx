import React, {
  createContext, forwardRef, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode
} from 'react';
import {displayBookPercent} from './book-presentation';
import {panelBounds, rememberPanelWidth, savedPanelWidth, type ReaderTheme} from './reader-preferences';
import type {PanelDismissRef} from './book-text-tap';
import {grammarRequestCost,languageFeatureLabel,languageChatCost} from '../ui/grammar-copy';
import './ReaderChrome.css';

export type {ReaderTheme} from './reader-preferences';
type Panel = 'search' | 'chapters' | 'quotes' | 'bookmarks' | 'appearance';
type Glyph = Panel | 'library' | 'bookmark' | 'left' | 'right' | 'close' | 'cancel' | 'arrow' | 'marker' | 'comment' | 'one' | 'two' | 'resize';

const paths: Record<Glyph, ReactNode> = {
  library: <><path d="M12 5.4C9.1 3.7 5.9 3.6 2.8 4.7v14.9c3.1-1.1 6.3-1 9.2.7 2.9-1.7 6.1-1.8 9.2-.7V4.7c-3.1-1.1-6.3-1-9.2.7z"/><path d="M12 5.4v14.9"/></>,
  search: <><circle cx="10.1" cy="10.1" r="6.5"/><path d="m15.1 15.1 5.7 5.7"/></>,
  chapters: <><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.3" cy="6" r=".85"/><circle cx="3.3" cy="12" r=".85"/><circle cx="3.3" cy="18" r=".85"/></>,
  quotes: <><path d="M3 4h18v14H8l-5 3V4z"/><path d="M7 12c0-2 1-3.6 3-4m-3 4h3v2H7zm6 0c0-2 1-3.6 3-4m-3 4h3v2h-3z"/></>,
  appearance: <><path d="M2 6.5h6m6 0h8M2 17.5h11m6 0h3"/><circle cx="11" cy="6.5" r="2.5"/><circle cx="16" cy="17.5" r="2.5"/></>,
  bookmarks: <><path d="M6 5h11v16l-5.5-4-5.5 4z"/><path d="M10 2.5h10v15"/></>,
  bookmark: <path d="M5.5 3.5h13v17l-6.5-4.6-6.5 4.6z"/>,
  left: <path d="m15.2 5.3-6.6 6.7 6.6 6.7"/>, right: <path d="m8.8 5.3 6.6 6.7-6.6 6.7"/>,
  close: <path d="m5.5 5.5 13 13m0-13-13 13"/>, cancel: <path d="m6 6 12 12M18 6 6 18"/>,
  arrow: <path d="M3 12h17m-5.9-6 6 6-6 6"/>,
  marker: <><path d="m5 15 9-10 4.7 4.5-9.4 10-4.3-1zM3 21h8"/></>,
  comment: <><path d="M3 4h18v14H8l-5 3zM7 9h10M7 13h6"/></>,
  one: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8"/></>,
  two: <><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M12 3v18M5 8h4m6 0h4"/></>,
  resize: <path d="m5 9-3 3 3 3m14-6 3 3-3 3M9 5v14m6-14v14"/>
};

function Icon({name, filled = false}: {name: Glyph; filled?: boolean}) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const railLabels: Record<Panel | 'library', string> = {
  library: 'Библиотека', search: 'Поиск', chapters: 'Главы', quotes: 'Цитаты', bookmarks:'Закладки', appearance: 'Вид'
};
const panelHeadings: Record<Panel, string> = {search: 'Навигация', chapters: 'Навигация', quotes: 'Цитаты', bookmarks:'Закладки', appearance: 'Вид и подсказки'};
export const ReaderGrammarConsent=createContext(false);
const CloseSmallPanel = createContext<() => void>(() => {});

export interface ReaderNavigation {
  label: string;
  title?: string;
  previous?: () => void;
  next?: () => void;
}

export interface ReaderChromeProps {
  title: string;
  onBack?: () => void;
  theme: ReaderTheme;
  onThemeChange: (theme: ReaderTheme) => void;
  chapter?: ReaderNavigation;
  page: ReaderNavigation;
  pageControl?: ReactNode;
  progress?: number;
  scrollEndVisible?: boolean;
  onSeek?: (percent: number) => void;
  minimumSeekStep?: number;
  pageProgress?: {current: number; total: number; seek: (page: number) => void};
  bookmarked: boolean;
  onBookmark?: () => void;
  search: ReactNode;
  chapters: ReactNode;
  quotes: ReactNode;
  bookmarks?: ReactNode;
  appearance?: ReactNode;
  notices?: ReactNode;
  children: ReactNode;
  className?: string;
  onPanelChange?: (panel: Panel | null, fromPage?: boolean) => void;
  textTapDismiss?: PanelDismissRef;
}

function ArrowButton({direction, label, move, edge}: {direction:'left'|'right'; label:string; move?:()=>void; edge?:boolean}) {
  return <button type="button" className={edge?'rc-page-edge rc-page-edge-'+direction:'rc-arrow'}
    aria-label={label} title={label} disabled={!move} onClick={move}><Icon name={direction}/></button>;
}

const themeOptions: [ReaderTheme, string][] = [['white', 'Белая'], ['cream','Кремовая'], ['graphite','Графит']];
function ThemePicker({theme, onChange}: {theme:ReaderTheme; onChange:(value:ReaderTheme)=>void}) {
  return <fieldset className="rc-theme-picker"><legend>Тема</legend><div>
    {themeOptions.map(([id,label]) => <button key={id} type="button" onClick={()=>onChange(id)} aria-pressed={id===theme}
      className="rc-theme-button" aria-label={label}><span className="rc-swatch" data-color={id}>Aa</span><span>{label}</span></button>)}
  </div></fieldset>;
}

type LineHeight = 1.3 | 1.5 | 1.7 | 2;
const lineOptions: LineHeight[] = [1.3,1.5,1.7,2];
interface ReflowControlsProps {
  fontSize: number; lineHeight: LineHeight; spread: boolean; publisher: boolean; scrolling: boolean;
  onFontSize:(value:number)=>void; onLineHeight:(value:LineHeight)=>void;
  onSpread:(value:boolean)=>void; onPublisher:(value:boolean)=>void; onScrolling:(value:boolean)=>void;
}

function Stepper({label,display,less,more}: {label:string; display:string; less?:()=>void; more?:()=>void}) {
  return <div className="rc-setting-row"><strong>{label}</strong><div className="rc-stepper" role="group" aria-label={label}>
    <button type="button" aria-label={`Уменьшить: ${label}`} onClick={less} disabled={!less}>−</button>
    <output aria-live="polite">{display}</output>
    <button type="button" aria-label={`Увеличить: ${label}`} onClick={more} disabled={!more}>+</button>
  </div></div>;
}

function Toggle({label,value,onChange}: {label:string;value:boolean;onChange:(value:boolean)=>void}) {
  return <button className="rc-toggle" type="button" role="switch" aria-checked={value}
    onClick={()=>onChange(!value)}><strong>{label}</strong><span aria-hidden="true"/></button>;
}

export function ReflowControls(p:ReflowControlsProps) {
  const index = lineOptions.indexOf(p.lineHeight);
  return <>
    <div className="rc-setting-group">
      <Stepper label="Размер шрифта" display={`${p.fontSize} px`} less={p.fontSize>14?()=>p.onFontSize(Math.max(14,p.fontSize-1)):undefined}
        more={p.fontSize<36?()=>p.onFontSize(Math.min(36,p.fontSize+1)):undefined}/>
      <Stepper label="Интервал строк" display={p.lineHeight.toLocaleString('ru-RU')} less={index>0?()=>p.onLineHeight(lineOptions[index-1]):undefined}
        more={index<lineOptions.length-1?()=>p.onLineHeight(lineOptions[index+1]):undefined}/>
    </div>
    <fieldset className="rc-spread"><legend>Разворот</legend><div>
      {([false,true] as const).map(double=><button type="button" key={String(double)} aria-pressed={p.spread === double && !p.scrolling}
        disabled={p.scrolling} onClick={()=>p.onSpread(double)}><Icon name={double?'two':'one'}/>{double?'Две страницы':'Одна страница'}</button>)}
    </div></fieldset>
    <div className="rc-setting-group"><Toggle label="Оформление издателя" value={p.publisher} onChange={p.onPublisher}/>
      <Toggle label="Вертикальная прокрутка" value={p.scrolling} onChange={p.onScrolling}/></div>
  </>;
}

export function ReaderBookmarkLink({onOpen,children,disabled,className}:{
  onOpen:()=>void;children:ReactNode;disabled?:boolean;className?:string;
}) {
  const dismiss=useContext(CloseSmallPanel);
  return <button type="button" className={className} disabled={disabled} onClick={()=>{onOpen();dismiss();}}>{children}</button>;
}

export interface ReaderChapterItem {id:string; title:string; level?:number; onOpen:()=>void; disabled?:boolean}
export function ReaderChapters({items,selected}: {items:ReaderChapterItem[];selected?:string}) {
  const dismiss=useContext(CloseSmallPanel);
  if (!items.length) return <p className="rc-empty">В этом файле нет оглавления.</p>;
  return <ol className="rc-chapters" aria-label="Оглавление книги">{items.map((item,i)=>
    <li key={item.id}><button type="button" aria-current={item.id===selected?'location':undefined} disabled={item.disabled}
      style={{paddingInlineStart:`${10+12*Math.min(5,Math.max(0,item.level??0))}px`}} onClick={()=>{item.onOpen();dismiss();}}>
      <span className="rc-index">{String(i+1).padStart(2,'0')}</span><span>{item.title}</span></button></li>
  )}</ol>;
}

export interface ReaderQuoteItem {id:string; text:string; comment?:string; location:string; onOpen:()=>void; onEdit?:(trigger:HTMLButtonElement)=>void; onRequestDelete?:(trigger:HTMLButtonElement)=>void}
export function ReaderQuoteList({items,title}: {items:ReaderQuoteItem[];title:string}) {
  const dismiss=useContext(CloseSmallPanel);
  const descriptions=useId();
  if (!items.length) return <div className="rc-empty"><strong>Цитат пока нет</strong><p>Выберите фрагмент книги и нажмите «Выделить» или «Комментарий».</p></div>;
  const forms: Record<string,string> = {one:'цитата',few:'цитаты',many:'цитат'};
  return <><p className="rc-subtle">{title} · {items.length} {forms[new Intl.PluralRules('ru').select(items.length)]||'цитат'}</p>
    <ul className="rc-quotes">{items.map((item,i)=><li key={item.id}>
      <strong className="rc-quote-kind"><Icon name={item.comment?'comment':'marker'}/>{item.comment?'С комментарием':'Выделение'}</strong>
      <blockquote id={descriptions+'-'+i}>{item.text}</blockquote>{item.comment&&<p className="rc-quote-note">{item.comment}</p>}
      <div><span>{item.location}</span><button type="button" onClick={()=>{item.onOpen();dismiss();}}>К фрагменту <Icon name="arrow"/></button></div>
      {item.onEdit&&<button type="button" onClick={event=>item.onEdit?.(event.currentTarget)}>{item.comment?'Изменить комментарий':'Добавить комментарий'}</button>}
      {item.onRequestDelete&&<button type="button" aria-describedby={descriptions+'-'+i} onClick={event=>item.onRequestDelete?.(event.currentTarget)}>Удалить цитату</button>}
    </li>)}</ul></>;
}

export interface ReaderSearchItem {id:string; title:string; excerpt:string; match?:{start:number;end:number}; onOpen:()=>void; disabled?:boolean}
export interface ReaderSearchProps {
  query:string; onQuery:(value:string)=>void; onSubmit:()=>void; onCancel?:()=>void;
  status?:string; items:ReaderSearchItem[]; disabled?:boolean; label?:string;
}
function MarkMatch({text,query,match: span}: {text:string;query:string;match?:ReaderSearchItem['match']}) {
  if(span && span.start>=0 && span.end>span.start && span.end<=text.length){
    return <>{text.slice(0,span.start)}<mark>{text.slice(span.start,span.end)}</mark>{text.slice(span.end)}</>;
  }
  const needle=query.trim();
  if(!needle)return <>{text}</>;
  const literal=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=new RegExp(literal,'iu').exec(text);
  return !match ? <>{text}</> : <>{text.slice(0,match.index)}<mark>{match[0]}</mark>{text.slice(match.index+match[0].length)}</>;
}
export function ReaderSearch({query,onQuery,onSubmit,onCancel,status,items,disabled,label='Поиск по книге'}:ReaderSearchProps) {
  const dismiss=useContext(CloseSmallPanel);
  return <div className="rc-search">
    <form role="search" onSubmit={event=>{event.preventDefault();if(!disabled&&query.trim())onSubmit();}}>
      <div className="rc-query"><button className="rc-find" type="submit" aria-label="Найти" title="Найти" disabled={disabled||!query.trim()}><Icon name="search"/></button>
        <input type="search" aria-label={label} placeholder="Слово или фраза" value={query} maxLength={200} onChange={e=>onQuery(e.currentTarget.value)}/>
        {query&&<button type="button" aria-label="Очистить поиск" onClick={()=>onQuery('')}><Icon name="cancel"/></button>}
      </div>{onCancel&&<button type="button" className="rc-cancel" onClick={onCancel}>Остановить поиск</button>}
    </form>
    <p className="rc-search-status" role="status">{status}</p>
    <ul className="rc-results">{items.map(item=><li key={item.id}><button type="button" disabled={item.disabled}
      onClick={()=>{item.onOpen();dismiss();}}><strong>{item.title}</strong><span><MarkMatch text={item.excerpt} query={query} match={item.match}/></span></button></li>)}</ul>
  </div>;
}

type BookProgressProps = Pick<ReaderChromeProps, 'title' | 'progress' | 'scrollEndVisible' | 'onSeek' | 'minimumSeekStep' | 'pageProgress' | 'bookmarked' | 'onBookmark'>;

function BookProgress({title,progress,scrollEndVisible,onSeek,minimumSeekStep=1,pageProgress,bookmarked,onBookmark}:BookProgressProps) {
  const pointer=useRef<number|null>(null);
  const [preview,setPreview]=useState<number|null>(null);
  // Retain the last requested position if the reader is still on the same
  // page. Otherwise native input events can repeatedly submit the first step.
  const [requested,setRequested]=useState<{from:number;to:number}|null>(null);
  const minimum=pageProgress?1:0, maximum=pageProgress?.total??100;
  const reported=pageProgress?.current??progress;
  const known=reported!==undefined && Number.isFinite(reported);
  const current=known?Math.max(minimum,Math.min(maximum,reported)):minimum;
  const seek=pageProgress?.seek??onSeek;
  const disabled=!known || !seek || maximum<=minimum;
  const target=preview??(requested?.from===current?requested.to:current);
  // Native ranges round to step=.1. Keep their last step available to End
  // while the final text CFI and the physical bottom still differ.
  const position=scrollEndVisible===false?Math.min(target,99.9):target;
  const percent=maximum===minimum?0:(position-minimum)*100/(maximum-minimum);
  const percentLabel=(scrollEndVisible===undefined?Math.round(percent):displayBookPercent(percent))+'% книги';
  useEffect(()=>{setRequested(null);},[current,disabled]);
  const request=(next:number)=>{
    if(disabled)return;
    setRequested({from:current,to:next});
    seek?.(next);
  };
  const keyDown=(event:KeyboardEvent<HTMLInputElement>)=>{
    if(disabled||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||event.nativeEvent.isComposing)return;
    const value=event.currentTarget.valueAsNumber;
    const small=pageProgress?1:minimumSeekStep;
    const large=pageProgress?Math.max(1,Math.round((maximum-minimum)/10)):Math.max(10,small);
    let next:number;
    switch(event.key){
      case 'ArrowRight':case 'ArrowUp':next=value+small;break;
      case 'ArrowLeft':case 'ArrowDown':next=value-small;break;
      case 'PageUp':next=value+large;break;
      case 'PageDown':next=value-large;break;
      case 'Home':next=minimum;break;
      case 'End':next=maximum;break;
      default:return;
    }
    event.preventDefault();
    next=Math.max(minimum,Math.min(maximum,next));
    if(next!==value){
      event.currentTarget.value=String(next);
      request(next);
    }
  };
  const cancelPointer=()=>{pointer.current=null;setPreview(null);};
  const commit=(event:PointerEvent<HTMLInputElement>)=>{
    if(pointer.current!==event.pointerId)return;
    const target=scrollEndVisible===false&&preview!==null?preview:event.currentTarget.valueAsNumber;
    cancelPointer();
    request(target);
  };
  return <footer className="rc-foot">
    <div className="rc-progress"><div><strong title={title}>{title}</strong>
      <span>{known?percentLabel:'Позиция уточняется'}</span></div>
      <input aria-label="Позиция в книге" type="range" min={minimum} max={maximum} step={pageProgress?1:.1} disabled={disabled}
        aria-valuetext={pageProgress?'Страница '+position+' из '+maximum:percentLabel} value={position}
        style={{'--rc-filled': `${percent}%`} as CSSProperties}
        onPointerDown={event=>{pointer.current=event.pointerId;event.currentTarget.setPointerCapture?.(event.pointerId);}}
        onPointerUp={commit} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}
        onKeyDown={keyDown} onBlur={()=>setRequested(null)}
        onChange={event=>{const next=event.currentTarget.valueAsNumber;if(pointer.current===null)request(next);else setPreview(next);}}/>
    </div><div className="rc-bookmark"><button type="button" disabled={!onBookmark} onClick={onBookmark} aria-pressed={bookmarked}
      aria-label={bookmarked?'Убрать закладку':'Добавить закладку на текущую страницу'} title={bookmarked?'Убрать закладку':'Добавить закладку на текущую страницу'}>
      <Icon name="bookmark" filled={bookmarked}/></button></div>
  </footer>;
}

export const ReaderChrome=forwardRef<HTMLElement,ReaderChromeProps>(function ReaderChrome(p,ref) {
  const id=useId(),area=useRef<HTMLDivElement>(null),panelRef=useRef<HTMLElement>(null);
  const triggers=useRef<Partial<Record<Panel,HTMLButtonElement|null>>>({});
  const [panel,setPanel]=useState<Panel|null>(null),[preferred,setPreferred]=useState(savedPanelWidth);
  const [areaWidth,setAreaWidth]=useState(1000);
  const drag=useRef<{pointer:number;startX:number;startWidth:number;current:number}|null>(null);
  const compact=areaWidth<650;
  const bounds=panelBounds(areaWidth,compact);
  const clamp=(value:number)=>Math.max(bounds.minimum,Math.min(bounds.maximum,Math.round(value)));
  const width=clamp(preferred);
  useLayoutEffect(()=>{
    const target=area.current;
    if(!target)return;
    const measure=()=>setAreaWidth(target.clientWidth||target.getBoundingClientRect().width||window.innerWidth||1000);
    measure();
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(measure):undefined;
    observer?.observe(target); window.addEventListener('resize',measure);
    return ()=>{observer?.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  useEffect(()=>{
    if(!panel)return;
    const target=panel==='search'?panelRef.current?.querySelector<HTMLInputElement>('input[type=search]'):null;
    (target??panelRef.current)?.focus({preventScroll:true});
  },[panel]);
  const notifyPanel=useRef(p.onPanelChange);notifyPanel.current=p.onPanelChange;
  useLayoutEffect(()=>{
    const action=p.textTapDismiss;
    if(!action||!panel)return;
    // A press belongs to the panel that was open when the reader began it.
    action.current=()=>{drag.current=null;setPanel(null);notifyPanel.current?.(null,true);};
    return ()=>{action.current=null;};
  },[panel,p.textTapDismiss]);
  const changePanel=(next:Panel|null)=>{
    if(panel===next)return;
    drag.current=null;
    setPanel(next);p.onPanelChange?.(next);
    if(!next && panel)triggers.current[panel]?.focus({preventScroll:true});
  };
  const resizeKey=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='PageUp'||event.key==='PageDown'){event.stopPropagation();return;}
    const increment=event.shiftKey?64:16;
    const target={ArrowLeft:width-increment,ArrowRight:width+increment,Home:bounds.minimum,End:bounds.maximum}[event.key as 'ArrowLeft'|'ArrowRight'|'Home'|'End'];
    if(target===undefined)return;
    event.preventDefault();event.stopPropagation();
    const next=clamp(target);setPreferred(next);rememberPanelWidth(next);
  };
  const startDrag=(event:PointerEvent<HTMLDivElement>)=>{
    if(event.button!==0||drag.current)return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll:true});
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current={pointer:event.pointerId,startX:event.clientX,startWidth:width,current:width};
  };
  const dragWidth=(event:PointerEvent<HTMLDivElement>)=>{
    const active=drag.current;
    if(!active||active.pointer!==event.pointerId)return;
    active.current=clamp(active.startWidth+event.clientX-active.startX);
    setPreferred(active.current);
  };
  const endDrag=(event:PointerEvent<HTMLDivElement>)=>{
    const active=drag.current;
    if(!active||active.pointer!==event.pointerId)return;
    rememberPanelWidth(active.current);drag.current=null;
  };
  const grammarEnabled=useContext(ReaderGrammarConsent);
  const tools:Record<Panel,ReactNode>={
    search:p.search,chapters:p.chapters,quotes:p.quotes,bookmarks:p.bookmarks??<p className="rc-empty">Пока нет закладок.</p>,
    appearance:<><ThemePicker theme={p.theme} onChange={p.onThemeChange}/>{p.appearance}
      <div className="rc-shortcuts"><p><kbd>Shift</kbd><span>Перевести слово</span></p>
        <p><kbd>Alt</kbd><span>{languageFeatureLabel}
          <small aria-live="polite">{grammarEnabled?grammarRequestCost+' '+languageChatCost:'Выключено в настройках.'}</small></span></p></div></>
  };
  const rail=(mode:Panel|'library')=>{
    const active=panel===mode;
    return <button type="button" key={mode} className={`rc-rail-button rc-rail-${mode}`}
      ref={el=>{if(mode!=='library')triggers.current[mode]=el;}}
      aria-label={railLabels[mode]} title={mode==='appearance'?'Вид и подсказки':railLabels[mode]}
      aria-expanded={mode==='library'?undefined:active} aria-controls={active?id+'-panel':undefined}
      disabled={mode==='library'&&!p.onBack} onClick={()=>mode==='library'?p.onBack?.():changePanel(active?null:mode)}>
      <Icon name={mode}/><span>{railLabels[mode]}</span></button>;
  };
  return <section ref={ref} aria-label={`Чтение: ${p.title}`} data-reader-theme={p.theme} className={`rc-shell${p.className?' '+p.className:''}`}
    onKeyDown={event=>{if(panel&&event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();changePanel(null);}}}>
    <nav className="rc-rail" aria-label="Инструменты чтения">
      {rail('library')}<span className="rc-rail-rule" aria-hidden="true"/>{rail('search')}{rail('chapters')}{rail('quotes')}{rail('bookmarks')}{rail('appearance')}
    </nav>
    <header className="rc-top"><div className="rc-nav-chapter" role="group" aria-label="Переключение глав">
      {p.chapter ? <><ArrowButton direction="left" label="Предыдущий раздел оглавления" move={p.chapter.previous}/>
        <button type="button" className="rc-chapter-name" onClick={()=>changePanel(panel==='chapters'?null:'chapters')}
          aria-expanded={panel==='chapters'} aria-controls={panel==='chapters'?id+'-panel':undefined} title={p.chapter.title||p.chapter.label}>
          <strong>{p.chapter.label}</strong>{p.chapter.title&&<><span className="rc-dot">·</span><span className="rc-title">{p.chapter.title}</span></>}</button>
        <ArrowButton direction="right" label="Следующий раздел оглавления" move={p.chapter.next}/></> :
        <strong className="rc-title" title={p.title}>{p.title}</strong>}
    </div><div className="rc-nav-page" role="group" aria-label="Страница книги">
      {p.pageControl??<strong className="rc-counter" role="status" aria-atomic="true">{p.page.label}</strong>}
    </div></header>
    <div className="rc-workspace" ref={area} data-stacked={compact&&panel?true:undefined} style={{'--rc-panel-width':width+'px'} as CSSProperties}>
      {panel && <div className="rc-drawer">
        <aside className="rc-panel" ref={panelRef} tabIndex={-1} id={id+'-panel'} aria-labelledby={id+'-head'}>
          <header><h2 id={id+'-head'}>{panelHeadings[panel]}</h2><button type="button" aria-label="Закрыть панель" onClick={()=>changePanel(null)}><Icon name="close"/></button></header>
          {(panel==='search'||panel==='chapters')&&<div className="rc-tabs" role="group" aria-label="Раздел навигации">
            {(['search','chapters'] as const).map(tab=><button type="button" key={tab} onClick={()=>changePanel(tab)}
              aria-pressed={panel===tab}><Icon name={tab}/>{tab==='search'?'Поиск':'Оглавление'}</button>)}</div>}
          <CloseSmallPanel.Provider value={()=>{if(compact)changePanel(null);}}>{tools[panel]}</CloseSmallPanel.Provider>
        </aside>
        <div tabIndex={0} role="separator" aria-label="Ширина панели" title="Изменить ширину панели: перетащите или нажмите ← / →"
          aria-orientation="vertical" aria-controls={id+'-panel'} aria-valuemin={bounds.minimum} aria-valuemax={bounds.maximum}
          aria-valuenow={width} aria-valuetext={`${width} пикселей`} className="rc-resize"
          onPointerDown={startDrag} onPointerMove={dragWidth} onPointerUp={endDrag} onPointerCancel={endDrag}
          onLostPointerCapture={endDrag} onKeyDown={resizeKey}><Icon name="resize"/></div>
      </div>}
      <div className="rc-stage" key="stage">
        {p.notices && <div className="rc-notices">{p.notices}</div>}
        <div className="rc-book-view" role="group" aria-label="Листание книги">
          <ArrowButton edge direction="left" label="Предыдущий экран" move={p.page.previous}/>
          <div className="rc-page">{p.children}</div>
          <ArrowButton edge direction="right" label="Следующий экран" move={p.page.next}/>
        </div>
        <BookProgress title={p.title} progress={p.progress} scrollEndVisible={p.scrollEndVisible} onSeek={p.onSeek} pageProgress={p.pageProgress}
          minimumSeekStep={p.minimumSeekStep} bookmarked={p.bookmarked} onBookmark={p.onBookmark}/>
      </div>
    </div>
  </section>;
});
