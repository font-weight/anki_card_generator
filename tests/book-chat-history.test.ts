import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {openReaderStorage} from '../packages/storage/src/index.ts';
import type {ReaderStorage} from '../packages/storage/src/index.ts';
import type {BookChatHistory, BookChatTurn} from '../packages/contracts/src/book-chat.ts';
import {GRAMMAR_ANSWER_LIMIT} from '../packages/contracts/src/grammar-chat-limits.ts';
import {BOOK_CHAT_MAX_UNITS} from '../packages/storage/src/book-chat.ts';

const save=(storage:ReaderStorage,page:string)=>storage.saveBook({
  kind:'epub',mimeType:'application/epub+zip',blob:new Blob([page]),title:'Две книги с одним названием',
});
const answer=(question:string,body:string):BookChatTurn=>({turnId:crypto.randomUUID(),question,kind:'answer',answer:body});
async function all(port:BookChatHistory) {
  let page=await port.read();
  const turns=page.turns.slice();
  while(page.before!==null){page=await port.read(page.before);turns.unshift(...page.turns);}
  return turns;
}

test('book transcript survives reopening IndexedDB, paginates without truncating long text, and is isolated from same-title books',async()=>{
  const indexedDB=new IDBFactory(),storage=await openReaderStorage({indexedDB});
  const {documentId:id}=await save(storage,'archive A'),other=await save(storage,'archive B');
  let archive=storage.bookChatHistory(id);
  const {generation}=await archive.read(),inputs:BookChatTurn[]=[];
  for(let i=0;i<26;i++){
    const t=answer('Вопрос '+i, i===12||i===24?'Два языка 🌍 & <em>Пример</em>\n'.repeat(11_000):'Полный ответ '+i);
    await archive.upsert(t,generation);inputs.push(t);
  }
  assert.deepEqual((await storage.bookChatHistory(other.documentId).read()).turns,[]);
  const russian={turnId:crypto.randomUUID(),kind:'answer' as const,question:'Уточните',answer:'Учебное объяснение.',language:'ru' as const};
  await archive.upsert(russian,generation);inputs.push(russian);
  await assert.rejects(archive.upsert({...russian,language:'xx' as 'ru'},generation),{code:'INVALID_INPUT'});
  storage.close();
  const reopened=await openReaderStorage({indexedDB});
  archive=reopened.bookChatHistory(id);
  const page=await archive.read();assert.equal(page.generation,generation);assert.ok(page.before);
  assert.deepEqual(await all(archive),inputs);
  await assert.rejects(archive.read(-4),{code:'INVALID_INPUT'});
  await assert.rejects(reopened.bookChatHistory('sha256:'+'1'.repeat(64)).read(),{code:'INVALID_INPUT'});
  assert.throws(()=>reopened.bookChatHistory('fake-book-name'),{code:'INVALID_INPUT'});
  reopened.close();
});

test('concurrent tabs preserve all questions and finalize each pending turn in original sequence without duplicates',async()=>{
  const indexedDB=new IDBFactory(),a=await openReaderStorage({indexedDB}),b=await openReaderStorage({indexedDB});
  const {documentId}=await save(a,'shared archive'),p=a.bookChatHistory(documentId),q=b.bookChatHistory(documentId);
  const [l,r]=await Promise.all([p.read(),q.read()]);assert.equal(l.generation,r.generation);
  const first=answer('Первый вопрос','Первый ответ'),second=answer('Второй вопрос','Второй ответ');
  const pending:BookChatTurn={turnId:first.turnId,question:first.question,kind:'pending'};
  await p.upsert(pending,l.generation);
  await Promise.all([p.upsert(second,l.generation),q.upsert(first,l.generation),q.upsert(first,l.generation)]);
  await p.upsert(pending,l.generation);
  assert.deepEqual((await q.read()).turns,[first,second]);
  await assert.rejects(p.upsert({...first,question:'Подмена вопроса'},l.generation),{code:'OPERATION_CONFLICT'});
  await assert.rejects(p.upsert({...first,kind:'failed',message:'Поздний сбой'} as BookChatTurn,l.generation),{code:'INVALID_INPUT'});
  await assert.rejects(q.upsert({turnId:first.turnId,question:first.question,kind:'failed',message:'Поздний сбой'},l.generation),{code:'OPERATION_CONFLICT'});
  const crossBook={...second,bookId:'some-other-book'};
  await assert.rejects(q.upsert(crossBook,l.generation),{code:'INVALID_INPUT'});
  assert.deepEqual(await all(p),[first,second]);
  a.close();b.close();
});

test('explicit clear rotates the book generation, rejects late writes even for the same content, and keeps the other book and reader state',async()=>{
  const indexedDB=new IDBFactory(),a=await openReaderStorage({indexedDB}),b=await openReaderStorage({indexedDB});
  const first=await save(a,'saved first'),second=await save(a,'saved second');
  const p=a.bookChatHistory(first.documentId),q=b.bookChatHistory(first.documentId),other=a.bookChatHistory(second.documentId);
  const {generation:old}=await p.read(),different=(await other.read()).generation;
  const t=answer('А ещё пример?','Локальная копия.');
  await p.upsert(t,old);await other.upsert(t,different);
  await a.saveReaderState(first.documentId,{version:1,bookmarks:[]});
  const cleared=await p.clear(old);assert.notEqual(cleared.generation,old);
  assert.deepEqual(await q.read(),cleared);
  await assert.rejects(q.upsert(t,old),{code:'OPERATION_CONFLICT'});
  await assert.rejects(q.clear(old),{code:'OPERATION_CONFLICT'});
  assert.deepEqual((await other.read()).turns,[t]);
  assert.deepEqual(await a.getReaderState(first.documentId),{version:1,bookmarks:[]});
  await p.upsert(t,cleared.generation);await a.deleteBook(first.documentId);
  await assert.rejects(q.read(),{code:'INVALID_INPUT'});await assert.rejects(q.upsert(t,cleared.generation),{code:'INVALID_INPUT'});
  const again=await save(a,'saved first');assert.equal(again.documentId,first.documentId);
  const after=await q.read();assert.deepEqual(after.turns,[]);assert.notEqual(after.generation,cleared.generation);
  await assert.rejects(p.upsert(t,cleared.generation),{code:'OPERATION_CONFLICT'});
  assert.deepEqual((await other.read()).turns,[t]);
  a.close();b.close();
});

test('at the per-book size limit a new turn fails explicitly, while earlier complete answers remain readable',async()=>{
  const s=await openReaderStorage({indexedDB:new IDBFactory()});
  const {documentId}=await save(s,'large book'),port=s.bookChatHistory(documentId),{generation}=await port.read();
  const body='文'.repeat(GRAMMAR_ANSWER_LIMIT),count=Math.floor(BOOK_CHAT_MAX_UNITS/(body.length+1)),ids:string[]=[];
  for(let i=0;i<count;i++){const t=answer('Q',body);await port.upsert(t,generation);ids.push(t.turnId);}
  await assert.rejects(port.upsert(answer('Q',body),generation),{code:'STORAGE_QUOTA'});
  const page=await port.read();assert.equal(page.turns.length,1);assert.equal(page.turns[0].turnId,ids.at(-1));
  assert.deepEqual(page.turns[0],{turnId:ids.at(-1),question:'Q',kind:'answer',answer:body});
  assert.equal(page.before,count-1);
  await port.clear(generation);assert.deepEqual((await port.read()).turns,[]);
  s.close();
});
