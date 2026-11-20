import React from 'react';
import {ReaderBookmarkLink} from './ReaderChrome';
import type {ReaderBookmark} from './types';

export function EpubBookmarks({bookmarks,label,onLabel,onAdd,onOpen,onRemove,canAdd,disabled,valid}:{
 bookmarks:Extract<ReaderBookmark,{kind:'epub'|'fb2'}>[];label:string;onLabel:(value:string)=>void;
 onAdd:()=>void;onOpen:(cfi:string)=>void;onRemove:(id:string)=>void;canAdd:boolean;disabled:boolean;valid:(cfi:string)=>boolean;
}){
 return <div className="er-epub-bookmark-list">
  <form onSubmit={event=>{event.preventDefault();onAdd();}}>
   <label>Название закладки<input aria-label="Название закладки" maxLength={200} value={label} onChange={event=>onLabel(event.target.value)}/></label>
   <button type="submit" disabled={!canAdd}>Добавить закладку</button>
  </form>
  {bookmarks.length?<ul className="er-epub-bookmarks">{bookmarks.map(mark=><li key={mark.id}>
   <ReaderBookmarkLink disabled={disabled||!valid(mark.cfi)} onOpen={()=>onOpen(mark.cfi)}>{mark.label}</ReaderBookmarkLink>
   <button type="button" aria-label={'Удалить закладку «'+mark.label+'»'} onClick={()=>onRemove(mark.id)}>Удалить</button>
  </li>)}</ul>:<p>Пока нет закладок.</p>}
 </div>;
}
