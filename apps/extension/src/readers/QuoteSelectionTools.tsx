import React, {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {isBookPanelSurfacePress} from './book-text-tap';
import './quote-selection.css';

export interface QuoteSelection {
  text: string;
  saved?:{id:string;comment?:string};
  returnFocus?:HTMLElement;
  confirmDelete?:boolean;
  rect: {left:number; top:number; right:number; bottom:number};
}

export function QuoteSelectionTools({selection, onSave, onCancel, onDelete}: {
  selection: QuoteSelection | null;
  onSave:(comment?:string)=>void;
  onCancel:()=>void;
  onDelete?:(id:string)=>void;
}) {
  const [stage,setStage]=useState<'tools'|'edit'|'delete'>('tools'), [draft,setDraft]=useState('');
  const fieldId=useId(),deleteTitle=useId(),deleteExcerpt=useId(),deleteDescription=useId();
  const keep=useRef<HTMLButtonElement>(null),requestDelete=useRef<HTMLButtonElement>(null),returnToDelete=useRef(false);
  const [position, setPosition] = useState({left:0, top:0});
  const node = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  const finish=(fn:()=>void,focus=selection?.returnFocus)=>{fn();if(focus?.isConnected)focus.focus({preventScroll:true});};
  const dismiss=()=>{
    if(stage==='delete'&&!selection?.confirmDelete){
      returnToDelete.current=true;setStage('edit');
    }else finish(()=>cancel.current());
  };
  const remove=()=>{
    if(!onDelete||!selection?.saved)return;
    const {id}=selection.saved,origin=selection.returnFocus;
    // A deleted list row cannot receive focus. Its panel survives the last deletion too.
    const focus=origin?.closest('.rc-quotes')?.closest<HTMLElement>('.rc-panel')??origin;
    finish(()=>onDelete(id),focus);
  };
  useLayoutEffect(() => {
    returnToDelete.current=false;
    setStage(selection?.saved?(selection.confirmDelete&&onDelete?'delete':'edit'):'tools');
    setDraft(selection?.saved?.comment??'');
  }, [selection]);
  useLayoutEffect(() => {
    if (!selection || !node.current) return;
    const rect = selection.rect, width = node.current.offsetWidth, height = node.current.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth-width-8, rect.left));
    const below = rect.bottom+9;
    const top = Math.max(8, Math.min(window.innerHeight-height-8, below+height+8 <= window.innerHeight ? below : rect.top-height-9));
    setPosition({left,top});
    if(stage==='delete')keep.current?.focus({preventScroll:true});
    if(stage==='edit'){
      (returnToDelete.current?requestDelete.current:input.current)?.focus({preventScroll:true});
      returnToDelete.current=false;
    }
  },[selection,stage]);
  useEffect(() => {
    if (!selection) return;
    const outside = (event:PointerEvent) => {
      if (isBookPanelSurfacePress(event)) return;
      if (event.target instanceof Node && !node.current?.contains(event.target)) cancel.current();
    };
    const key = (event:KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();dismiss();}
    };
    const moved=(event:Event)=>{if(!(event.target instanceof Node && node.current?.contains(event.target)))cancel.current();};
    window.addEventListener('resize',moved);
    document.addEventListener('scroll',moved,true);
    document.addEventListener('pointerdown',outside,true);
    document.addEventListener('keydown',key,true);
    return () => {window.removeEventListener('resize',moved);document.removeEventListener('scroll',moved,true);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);};
  },[selection,stage]);
  if (!selection) return null;
  // Keep theme tokens inherited from the reader when its ancestor clips the scroll viewport.
  const target = document.querySelector('[data-reader-theme]') || document.body;
  const confirming=stage==='delete',editing=stage==='edit';
  return createPortal(<div ref={node} className={'er-quote-tools'+(stage==='tools'?'':' er-quote-editor')} style={position}
    data-quote-tools="" role={confirming?'alertdialog':editing?'dialog':'toolbar'}
    aria-label={confirming?undefined:editing?'Комментарий к цитате':'Действия с выделением'}
    aria-labelledby={confirming?deleteTitle:undefined} aria-describedby={confirming?deleteExcerpt+' '+deleteDescription:undefined}>
    {confirming ? <>
      <h3 id={deleteTitle}>Удалить цитату?</h3><blockquote id={deleteExcerpt}>{selection.text}</blockquote>
      <p id={deleteDescription}>{selection.saved?.comment?'Из книги исчезнут выделение и комментарий к нему.':'Из книги исчезнет выделение.'}</p>
      <footer><button ref={keep} type="button" onClick={dismiss}>Оставить</button>
        <button type="button" className="er-quote-danger" onClick={remove}>Удалить цитату</button></footer>
    </> : editing ? <form onSubmit={event=>{event.preventDefault();if(draft.trim())finish(()=>onSave(draft.trim()));}}>
      <h3>Комментарий</h3><blockquote>{selection.text}</blockquote>
      <div className="er-quote-note-field"><label htmlFor={fieldId}>Ваша заметка</label>
        <textarea id={fieldId} ref={input} rows={3} maxLength={2000} value={draft} onChange={event=>setDraft(event.target.value)}/>
      </div>
      <footer>{selection.saved&&onDelete&&<button ref={requestDelete} className="er-quote-delete-request" type="button" onClick={()=>setStage('delete')}>Удалить цитату</button>}
        <button type="button" onClick={()=>finish(onCancel)}>Отмена</button><button className="er-quote-primary" disabled={!draft.trim()}>Сохранить</button></footer>
    </form> : <><button type="button" onPointerDown={e=>e.preventDefault()} onClick={()=>onSave()}>Выделить</button>
      <button type="button" onPointerDown={e=>e.preventDefault()} onClick={()=>setStage('edit')}>Комментарий</button></>}
  </div>,target);
}
