import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {LibraryStorage,ReaderAppearance,ReaderBookmark,ReaderSavedState,StoredBook} from '../../apps/extension/src/readers/types';

type ReaderProps={book:StoredBook;bookmarks:ReaderBookmark[];appearance?:ReaderAppearance;onBookmarksChange:(marks:ReaderBookmark[])=>void;onAppearanceChange:(appearance:ReaderAppearance)=>void};
const tracker=vi.hoisted(()=>({current:undefined as ReaderProps|undefined}));
vi.mock('../../apps/extension/src/readers/PdfReader',()=>({PdfReader:(props:ReaderProps)=>{tracker.current=props;return <div data-independent-reader>{props.book.title}</div>;}}));
vi.mock('../../apps/extension/src/readers/EpubReader',()=>({EpubReader:(props:ReaderProps)=>{tracker.current=props;return <div data-independent-reader>{props.book.title}</div>;}}));
import {ReaderLibrary} from '../../apps/extension/src/readers/ReaderLibrary';

let node:HTMLDivElement,root:ReturnType<typeof createRoot>,storage:LibraryStorage,stored:StoredBook;
const empty=():ReaderSavedState=>({version:1,bookmarks:[]});
const mark:ReaderBookmark={id:'new',label:'New bookmark',createdAt:1,kind:'epub',chapter:'One',cfi:'epubcfi(/6/2!/4/2/1:4)'};
function deferred<T>(){let resolve!:(value:T)=>void;return{promise:new Promise<T>(yes=>{resolve=yes;}),resolve};}
async function click(text:string){const button=[...node.querySelectorAll('button')].find(button=>button.textContent===text)!;expect(button).toBeTruthy();await act(async()=>button.click());}
beforeEach(()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;tracker.current=undefined;
 vi.stubGlobal('crypto',{subtle:{digest:vi.fn(async()=>new Uint8Array(32).buffer)}});
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Independent reader tests permit no network');}));
 stored={documentId:'sha256:'+'0'.repeat(64),kind:'epub',title:'Saved.epub',addedAt:0,size:16,blob:new Blob(['same local bytes'])};
 storage={listBooks:vi.fn(async()=>[stored]),getBook:vi.fn(async()=>stored),putBook:vi.fn(),deleteBook:vi.fn(),saveProgress:vi.fn(),getReaderState:vi.fn(async()=>empty()),saveReaderState:vi.fn(async()=>{})};
 node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});

describe('independent saved reader-state races',()=>{
 it('does not let late hydration replace a newer book or its successfully saved edit',async()=>{
  const hydration=deferred<ReaderSavedState>();const second={...stored,documentId:'sha256:'+'1'.repeat(64),title:'Second.epub'};
  storage.listBooks=vi.fn(async()=>[stored,second]);storage.getBook=vi.fn(async id=>id===second.documentId?second:stored);
  storage.getReaderState=vi.fn(id=>id===stored.documentId?hydration.promise:Promise.resolve(empty()));
  await act(async()=>root.render(<ReaderLibrary storage={storage}/>));await click('Saved.epub');await click('Second.epub');
  await act(async()=>tracker.current!.onBookmarksChange([mark]));
  expect(storage.saveReaderState).toHaveBeenCalledWith(second.documentId,{version:1,bookmarks:[mark]});
  await act(async()=>hydration.resolve(empty()));
  expect(tracker.current?.book.documentId).toBe(second.documentId);expect(tracker.current?.bookmarks).toEqual([mark]);
  expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects callbacks from a replaced same-book session without overwriting the new session',async()=>{
  await act(async()=>root.render(<ReaderLibrary storage={storage}/>));await click('Saved.epub');const old=tracker.current!;
  await click('← Библиотека');await click('Saved.epub');await act(async()=>old.onBookmarksChange([mark]));
  expect(tracker.current?.bookmarks).toEqual([]);expect(storage.saveReaderState).not.toHaveBeenCalled();
 });
});
