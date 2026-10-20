/** Browser test harness only. Production uses the shared IndexedDB adapter. */
import React from 'react';import{createRoot}from'react-dom/client';
import{ReaderLibrary}from'../../apps/extension/src/readers/ReaderLibrary';
import type{LibraryStorage,StoredBook}from'../../apps/extension/src/readers/types';
const books=new Map<string,StoredBook>();
const storage:LibraryStorage={listBooks:async()=>[...books.values()],getBook:async id=>books.get(id),putBook:async book=>{books.set(book.documentId,book);},deleteBook:async id=>{books.delete(id);},saveProgress:async(id,progress)=>{const book=books.get(id);if(book)book.progress=progress;}};
createRoot(document.getElementById('root')!).render(<ReaderLibrary storage={storage}/>);
