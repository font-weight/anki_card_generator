import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {GrammarPopup} from '../../apps/extension/src/ui/GrammarPopup';
import {ReadingPopup} from '../../apps/extension/src/ui/ReadingPopup';
import {SettingsApp} from '../../apps/extension/src/ui/SettingsApp';
import {QueueApp} from '../../apps/extension/src/ui/QueueApp';
import { ReaderChrome, ReaderGrammarConsent, ReaderSearch, ReaderChapters, ReaderQuoteList, ReflowControls } from '../../apps/extension/src/readers/ReaderChrome';
import {EpubBookmarks} from '../../apps/extension/src/readers/EpubBookmarks';
import {QuoteSelectionTools,type QuoteSelection} from '../../apps/extension/src/readers/QuoteSelectionTools';
import {sanitizeChapter} from '../../apps/extension/src/readers/epub-security';
import {applyBookStyle} from '../../apps/extension/src/readers/epub-format';
import {ReaderLibrary} from '../../apps/extension/src/readers/ReaderLibrary';
import {uiCss} from '../../apps/extension/src/ui/styles';
import * as userActions from '../../apps/extension/src/ui/user-actions';
import {renderPreview} from '@english-reader/note-templates';
import type {UiRpc} from '../../apps/extension/src/ui/interfaces';
import type {LibraryStorage,LibraryBook} from '../../apps/extension/src/readers/types';
import {grammarSentence,harbourGrammar,harbourLookup,harbourSentence} from '../fixtures/reader-design';
import {fullMeaningsDraft} from '../fixtures/full-meaning-drafts';

const readingSource={kind:'epub',title:'The Quiet Coast',url:null,documentId:'review-book',page:null,chapter:'The Harbour at Dawn',cfi:'epubcfi(/6/2!/4/2:0)'} as const;
const language={sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',dialect:'en-US'} as const;
const grammarPayload={sentence:grammarSentence,sourceLanguage:'en',targetLanguage:'ru',learnerLevel:'B1',explanationLanguage:'ru',includeExplanation:true} as const;
const settings={...language,grammarEnabled:true,grammarIncludeExplanation:true,grammarExplanationLanguage:'ru',defaultDeck:'English Reading',cloudAudioEnabled:false};
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.spyOn(userActions,'isTrustedUiEvent').mockReturnValue(true);
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});
async function mount(content:React.ReactNode){await act(async()=>root.render(content));}
const btn=(title:string)=>[...node.querySelectorAll('button')].find(b=>b.textContent?.trim()===title);
async function click(button:HTMLElement|undefined){expect(button).toBeDefined();await act(async()=>button!.click());}
function capture(name:string, content:HTMLElement=node){
  const directory=process.env.LR_REVIEW_DOM;
  if(!directory)return;
  mkdirSync(directory,{recursive:true});
  const clone=content.cloneNode(true) as HTMLElement;
  const sourceFields=content.querySelectorAll('input,textarea,select');
  clone.querySelectorAll('input,textarea,select').forEach((field,index)=>{
    const original=sourceFields[index] as HTMLInputElement;
    if (content.ownerDocument.activeElement===original && original.matches(':focus-visible')) field.setAttribute('data-review-focus','');
    if(field instanceof HTMLInputElement){field.setAttribute('value',original.value);if(original.checked)field.setAttribute('checked','');}
    else if(field instanceof HTMLTextAreaElement)field.textContent=original.value;
    else field.querySelectorAll('option').forEach(option=>{option.toggleAttribute('selected',option.value===original.value);});
  });
  writeFileSync(path.join(directory,name+'.html'),clone.outerHTML);
  writeFileSync(path.join(directory,'ui.css'),uiCss);
}
function fixtureRpc(replies:Record<string,unknown>):UiRpc {
  return vi.fn(async(kind:string)=>{const owned=replies[kind];return typeof owned==='function'?owned():owned??{};}) as UiRpc;
}
it('preserves the visible source through loading, a short explanation, and the disclosed contrast',async()=>{
  let complete:(value:unknown)=>void=()=>{};
  const rpc=fixtureRpc({'settings.getReader':settings,'grammar.lookup':()=>new Promise(yes=>{complete=yes;})});
  await mount(<GrammarPopup options={{rpc,payload:grammarPayload,source:readingSource,autoGenerate:true}} close={()=>{}}/>);
  expect(node.querySelector('[data-state=loading]')).toBeTruthy();capture('grammar-loading');
  await act(async()=>complete(harbourGrammar));
  expect(node.querySelector('mark')?.textContent).toBe('had left');
  expect(node.querySelector('.grammar-reading')?.textContent).toContain(harbourGrammar.rule);
  capture('grammar-brief');
  const details=node.querySelector<HTMLDetailsElement>('.grammar-more')!;details.open=true;
  expect(details.textContent).toContain('When Mara arrived');capture('grammar-details');
  await click(btn('Предпросмотр'));
  const frames = [...node.querySelectorAll('iframe')];
  expect(frames).toHaveLength(2);
  expect(frames[1].srcdoc).toContain(readingSource.chapter);
  expect(frames.map(frame => frame.srcdoc).join('')).not.toContain('epubcfi(');
});
it('can render the empty, failure, retry and disabled states without saving a note',async()=>{
  const simple={...grammarPayload,sentence:'The sea is blue.'};
  const offline=vi.fn().mockRejectedValueOnce(new Error('Запрос не завершён.')).mockResolvedValue({grammarId:harbourGrammar.grammarId,sentence:simple.sentence,reason:'no_construction'});
  const rpc=fixtureRpc({'settings.getReader':settings,'grammar.lookup':offline});
  await mount(<GrammarPopup options={{rpc,payload:simple,source:readingSource,autoGenerate:true}} close={()=>{}}/>);
  expect(node.querySelector('[data-state=error]')).toBeTruthy();capture('grammar-retry');
  await click(btn('Повторить'));expect(node.querySelector('[data-state=empty]')).toBeTruthy();capture('grammar-none');
  const off=fixtureRpc({'settings.getReader':{...settings,grammarEnabled:false}});
  await mount(<GrammarPopup key="off" options={{rpc:off,payload:simple,source:readingSource,autoGenerate:true}} close={()=>{}}/>);
  expect(node.querySelector('[data-state=disabled]')).toBeTruthy();
  expect(vi.mocked(off).mock.calls.every(c=>c[0]!=='grammar.lookup')).toBe(true);
  capture('grammar-disabled');
});
it('renders the original Shift popup, editor and both current Anki template previews for one lexical example',async()=>{
  const rpc=fixtureRpc({'settings.getReader':settings,'lookup':harbourLookup,'anki.decks':{deckNames:['English Reading']},'pronunciation.get':{pronunciation:{ipa:'/ˈɡlɪmər/',dialect:'en-US',source:'dictionary',sourceUrl:null}}});
  const start=harbourSentence.indexOf('glimmer');
  await mount(<ReadingPopup close={()=>{}} options={{rpc,trustedPage:true,renderPreview,source:readingSource,anchor:new DOMRect(20,40,50,18),lookupPayload:{...language,expression:'glimmer',context:{sentence:harbourSentence,targetStart:start,targetEnd:start+7}}}}/>);
  expect(node.textContent).toContain('проблеск');capture('shift-lookup');
  await click(btn('Редактировать'));expect(node.textContent).toContain('Начальная форма слова');capture('shift-editor');
  await click(btn('Предпросмотр'));const frames=[...node.querySelectorAll('iframe')];
  expect(frames).toHaveLength(2);expect(frames[1].srcdoc).toContain('проблеск');
  expect(frames[1].srcdoc).toContain(readingSource.chapter);
  expect(frames.map(frame => frame.srcdoc).join('')).not.toContain('epubcfi(');
  if(process.env.LR_REVIEW_DOM)frames.forEach((frame,i)=>writeFileSync(path.join(process.env.LR_REVIEW_DOM!,i?'card-back.html':'card-front.html'),frame.srcdoc));
});
it('shows given with dictionary IPA as the sole transcription and keeps word playback',async()=>{
  const sentence='She had given the letter to her sister.';
  const start=sentence.indexOf('given');
  const lookup={...harbourLookup,expression:'given',lemma:'give',partOfSpeech:'verb',recommendedSenseId:'give',
    senses:[{id:'give',translations:['дать','придать'],definition:'To pass something to another person.'}]};
  const rpc=fixtureRpc({'settings.getReader':settings,'lookup':lookup,'pronunciation.get':{
    pronunciation:{ipa:'/ˈɡɪvən/',dialect:'en-US',source:'dictionary',sourceUrl:null}}});
  await mount(<ReadingPopup close={()=>{}} options={{rpc,trustedPage:true,renderPreview,source:readingSource,
    anchor:new DOMRect(20,40,50,18),lookupPayload:{...language,expression:'given',context:{sentence,targetStart:start,targetEnd:start+5}}}}/>);
  expect(node.querySelector('.translation')?.textContent).toBe('дать; придать');
  expect(node.querySelector('.pronunciation')?.textContent).toBe('[ˈɡɪvən]');
  expect(node.querySelector('.pronunciation')?.childElementCount).toBe(1);
  expect(node.querySelector('button[aria-label="Прослушать выражение системным голосом"]')).toBeTruthy();
  capture('shift-dictionary-ipa');
});
it('captures the generated Shift transcription and the successful settings save from the mounted components',async()=>{
  const rpc=fixtureRpc({'settings.getReader':settings,'lookup':harbourLookup,'anki.decks':{deckNames:['English Reading']},
    'pronunciation.get':{pronunciation:{ipa:'/ˈɡlɪmər/',dialect:'en-US',source:'generated',sourceUrl:null}}});
  const start=harbourSentence.indexOf('glimmer');
  await mount(<ReadingPopup close={()=>{}} options={{rpc,trustedPage:true,renderPreview,source:readingSource,anchor:new DOMRect(20,40,50,18),
    lookupPayload:{...language,expression:'glimmer',context:{sentence:harbourSentence,targetStart:start,targetEnd:start+7}}}}/>);
  expect(node.querySelector('.pronunciation')?.textContent).toBe('[ˈɡlɪmər]');
  expect(node.querySelector('.pronunciation')?.childElementCount).toBe(1);
  expect(node.querySelector('.pronunciation')?.textContent).not.toContain('приблизительно');
  expect(node.querySelector('button[aria-label="Прослушать выражение системным голосом"]')).toBeTruthy();
  capture('shift-phonetic');
  await mount(<SettingsApp rpc={fixtureRpc({'settings.getPublic':settings,'settings.update':settings})}/>);
  await click(btn('Сохранить настройки'));
  expect(node.querySelector('.settings-notification.success [role=status]')?.textContent).toBe('Настройки сохранены.');
  capture('settings-saved');
});

it('preserves the gap between the Anki note type button and the legacy divider at narrow width',async()=>{
  await mount(<SettingsApp rpc={fixtureRpc({'settings.getPublic':settings})}/>);
  await click(btn('Anki и колода'));
  node.style.width='360px';
  const detail=node.querySelector<HTMLDetailsElement>('.anki-legacy-recovery')!;
  expect(detail.previousElementSibling).toBe(btn('Создать собственные типы заметок'));
  expect(detail.querySelector('summary')?.textContent).toBe('Восстановление типов v1 для старой очереди');
  expect(node.querySelectorAll('.anki-legacy-recovery')).toHaveLength(1);
  capture('settings-anki-spacing-narrow');
});
it('captures the service permission controls from an existing synthetic settings profile',async()=>{
  const rpc=fixtureRpc({'settings.getPublic':{...settings,dictionaryEnabled:true,cloudAudioEnabled:true}});
  await mount(<SettingsApp rpc={rpc}/>);
  await click(btn('Произношение и сервисы'));
  const panel=[...node.querySelectorAll('fieldset')].find(field=>field.querySelector('legend')?.textContent==='Голос и дополнительные источники');
  expect(panel?.hidden).toBe(false);
  expect([...panel!.querySelectorAll<HTMLInputElement>('.check input[type=checkbox]')].map(input=>input.checked)).toEqual([true,true]);
  expect(vi.mocked(rpc).mock.calls.map(([kind])=>kind)).toEqual(['settings.getPublic']);
  capture('settings-permissions');
});
it('local data surfaces include the prior reading place and local-only deletion',async()=>{
  const books:LibraryBook[]=[{documentId:'review-book',title:'The Quiet Coast',author:'Eleanor Vale',kind:'epub',addedAt:100,size:1024,progress:{chapter:'The Harbour at Dawn',chapterNumber:3,percent:28,updatedAt:200}},{documentId:'second',title:'A Garden in Winter',kind:'fb2',addedAt:80,size:1000}];
  const cover='data:image/png;base64,'+readFileSync('tests/fixtures/quiet-coast-cover.png').toString('base64');
  const storage:LibraryStorage={listBooks:async()=>books,getBook:async()=>undefined,putBook:async()=>{},deleteBook:async()=>{},saveProgress:async()=>{},
    loadBookThumbnail:async id=>id==='review-book'?cover:null};
  await mount(<ReaderLibrary storage={storage}/>);
  expect(node.querySelectorAll('.embedded-cover img')).toHaveLength(2);
  expect(node.querySelector('.cover-fb2')?.textContent).toContain('A Garden in Winter');
  expect(node.textContent).toContain('The Quiet Coast');capture('library');
  const draft=fullMeaningsDraft();
  Object.assign(draft,{expression:'glimmer',lemma:'glimmer',selectedSense:harbourLookup.senses[0],senses:harbourLookup.senses,source:readingSource,context:{sentence:harbourSentence,targetStart:2,targetEnd:9},deckName:'English Reading'});
  const rpc=fixtureRpc({'queue.list':{items:[{state:'synced',operationId:'op-private',noteId:123,createdAt:'2026-01-01',draft}],nextCursor:null}});
  await mount(<QueueApp rpc={rpc}/>);expect(node.textContent).toContain('glimmer');expect(node.textContent).not.toContain('op-private');capture('word-base');
  await click(btn('Убрать из базы'));expect(node.textContent).toContain('Оставить');capture('word-base-confirm');
  await mount(<SettingsApp rpc={fixtureRpc({'settings.getPublic':{...settings,grammarEnabled:false}})}/>);
  await click(btn('Языки, разбор и чат'));expect(node.textContent).toContain('Разбор и языковой чат');capture('settings-off');
});

it('renders each coordinated reader theme with working left panel controls and book styling',async()=>{
  const noop=()=>{};
  const parts=['The Old Map','North by Water','The Harbour at Dawn'];
  const original='<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Preface</title></head><body>'+
    '<p class="calibre4"><i>Preface</i></p><p><br/></p><p class="calibre9">How This Book Was</p>'+
    '<p class="calibre9">Written and Why</p><p><br/></p><p>Years ago, I returned to the quiet street where this story began. The lights were on in the windows.</p>'+
    '<p>'+grammarSentence+'</p><p>'+harbourSentence+'</p><p>From the end of the pier, the open sea looked almost still. Farther out, a single boat was making its way home.</p></body></html>';
  const safePage=sanitizeChapter(original,'OPS/preface.xhtml',new Map());
  const mark={id:'quiet-coast-bookmark',label:'Рассвет в гавани',createdAt:10,kind:'epub' as const,cfi:readingSource.cfi,chapter:'The Harbour at Dawn'};
  const savedSelection={text:harbourSentence,rect:{left:675,top:310,right:900,bottom:340},saved:{id:'quote',comment:'Здесь glimmer — слабый свет.'}};
  function Scene({grammarEnabled=false}:{grammarEnabled?:boolean}={}){
    const [selection,setSelection]=React.useState<QuoteSelection|null>(null),[hasQuote,setHasQuote]=React.useState(true);
    const openQuote=(trigger:HTMLButtonElement,confirmDelete=false)=>setSelection({...savedSelection,returnFocus:trigger,confirmDelete});
    const [theme,setTheme]=React.useState<'white'|'cream'|'graphite'>('white');
    const [publisher,setPublisher]=React.useState<boolean>();
    const [bookmarked,setBookmarked]=React.useState(false);
    const [font,setFont]=React.useState(20);
    const text=React.useRef<HTMLIFrameElement>(null);
    React.useLayoutEffect(()=>{
      const doc=text.current?.contentDocument;if(!doc)return;
      const chapter=new DOMParser().parseFromString(safePage,'text/html');
      doc.body.replaceChildren(...Array.from(chapter.body.childNodes,child=>doc.importNode(child,true)));
      applyBookStyle(doc,{kind:'epub',fontSize:font,lineHeight:1.7,width:'comfortable',theme:theme==='cream'?'cream':theme==='graphite'?'dark':'light',...(publisher===undefined?{}:{publisher})});
      text.current!.dataset.previewHtml=doc.documentElement.outerHTML;
    },[theme,publisher,font]);
    return <ReaderGrammarConsent.Provider value={grammarEnabled}><ReaderChrome className="er-epub-reader" theme={theme} onThemeChange={setTheme} title="The Quiet Coast" onBack={noop} chapter={{label:'Глава 3',title:parts[2],previous:noop,next:noop}} page={{label:'Страница 14 из 49',previous:noop,next:noop}} progress={28} onSeek={noop} bookmarked={bookmarked} onBookmark={()=>setBookmarked(v=>!v)}
      appearance={<ReflowControls fontSize={font} onFontSize={setFont} lineHeight={1.7} onLineHeight={noop} spread={false} onSpread={noop} publisher={publisher!==false} onPublisher={setPublisher} scrolling={false} onScrolling={noop}/>}
      chapters={<ReaderChapters items={parts.map(title=>({id:title,title,onOpen:noop}))} selected={parts[2]}/>}
      bookmarks={<EpubBookmarks bookmarks={[mark]} label="" onLabel={noop} onAdd={noop} onOpen={noop} onRemove={noop} canAdd disabled={false} valid={()=>true}/>}
      search={<ReaderSearch query="glimmer" onQuery={noop} onSubmit={noop} status="1 совпадение" items={[{id:'one',title:parts[2],excerpt:harbourSentence,onOpen:noop}]}/>}
      quotes={<ReaderQuoteList title="The Quiet Coast" items={hasQuote?[{id:'quote',text:harbourSentence,comment:savedSelection.saved.comment,location:'Глава 3',onOpen:noop,onEdit:trigger=>openQuote(trigger),onRequestDelete:trigger=>openQuote(trigger,true)}]:[]}/>}>
      <section className="er-epub-viewport"><iframe title="Визуальный образец страницы" ref={text}/></section>
      <QuoteSelectionTools selection={selection} onSave={()=>setSelection(null)} onCancel={()=>setSelection(null)} onDelete={()=>{setHasQuote(false);setSelection(null);}}/>
    </ReaderChrome></ReaderGrammarConsent.Provider>;
  }
  await mount(<Scene/>);
  const rail=(name:string)=>node.querySelector<HTMLButtonElement>('.rc-rail [aria-label="'+name+'"]')!;
  const theme=(name:string)=>node.querySelector<HTMLButtonElement>('.rc-theme-picker [aria-label="'+name+'"]')!;
  capture('reader-white');await click(rail('Вид'));
  expect([...node.querySelectorAll('[role=switch]')].find(b=>b.textContent==='Оформление издателя')?.getAttribute('aria-checked')).toBe('true');
  capture('reader-publisher-default');await click(theme('Кремовая'));
  await click(rail('Вид'));capture('reader-cream');await click(rail('Вид'));
  await click([...node.querySelectorAll<HTMLButtonElement>('[role=switch]')].find(b=>b.textContent==='Оформление издателя'));
  await click(rail('Вид'));capture('reader-cream-neutral');
  await click(rail('Вид'));await click(theme('Графит'));
  expect(node.querySelector('[data-reader-theme=graphite]')).toBeTruthy();capture('reader-graphite');
  await mount(<Scene grammarEnabled/>);capture('reader-alt-enabled');
  await click(rail('Поиск'));expect(node.querySelector('mark')?.textContent).toBe('glimmer');capture('reader-search');
  await click(rail('Главы'));expect(node.querySelector('.rc-chapters')?.textContent).toContain(parts[2]);capture('reader-chapters');
  await click(rail('Закладки'));expect(node.textContent).toContain(mark.label);capture('reader-bookmarks');
  await click(rail('Цитаты'));expect(node.querySelector('blockquote')?.textContent).toBe(harbourSentence);capture('reader-quotes');
  await click(btn('Изменить комментарий'));
  const editor=node.querySelector('[role=dialog]');
  expect(editor?.querySelector('blockquote')?.textContent).toBe(harbourSentence);
  expect(editor?.querySelector('textarea')?.value).toBe(savedSelection.saved.comment);
  const field=editor!.querySelector('textarea')!,label=editor!.querySelector('label')!;
  expect(label.htmlFor).toBe(field.id);expect(label.nextElementSibling).toBe(field);
  capture('reader-quote-edit');
  await click([...editor!.querySelectorAll('button')].find(button=>button.textContent==='Удалить цитату'));
  const confirmation=node.querySelector('[role=alertdialog]')!;
  expect(confirmation.querySelector('blockquote')?.textContent).toBe(harbourSentence);
  expect(document.activeElement?.textContent).toBe('Оставить');
  capture('reader-quote-delete-confirm');
  await click(confirmation.querySelector<HTMLButtonElement>('button.er-quote-danger')!);
  expect(node.querySelector('.rc-empty')?.textContent).toContain('Цитат пока нет');
  expect(document.activeElement).toBe(node.querySelector('.rc-panel'));
});

it('captures the scoped grammar conversation after an explicit open and send',async()=>{
  const sentence='Before she moved to the city, she had dreamed of opening a small café.';
  const phrase='had dreamed', start=sentence.indexOf(phrase);
  const input={...grammarPayload,sentence};
  const analysis={...harbourGrammar,sentence,construction:{text:phrase,targetStart:start,targetEnd:start+phrase.length},
    question:'Когда у неё появилась мечта?',answer:'К моменту переезда она уже мечтала открыть небольшое кафе.',
    rule:'Форма had dreamed относит мечту ко времени до переезда. Слова she moved задают точку отсчёта.',
    explanation:'Сравните: She dreamed of a café after the move. Здесь мечта появилась после переезда.',
    translation:'До переезда в город она мечтала открыть небольшое кафе.'};
  let finish!:(reply:unknown)=>void;
  const rpc=vi.fn(async(type:string,body?:any)=>{
    if(type==='settings.getReader')return settings;
    if(type==='grammar.lookup')return analysis;
    if(type==='grammar.chat'){
      if(body.question==='А had здесь можно опустить?')return {grammarId:body.grammarId,turnId:body.turnId,kind:'model_no_answer'};
      if(body.question==='Где купить кофе?')return {grammarId:body.grammarId,turnId:body.turnId,kind:'out_of_scope'};
      if(body.question==='Можно объяснить проще?')throw Object.assign(new Error('timeout'),{code:'NETWORK_TIMEOUT'});
      return new Promise(resolve=>{finish=resolve;});
    }
    return {};
  }) as UiRpc;
  const options={rpc,source:readingSource,payload:input,autoGenerate:true};
  await mount(<GrammarPopup options={options} close={()=>{}}/>);
  capture('grammar-chat-entry');
  await click(node.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!);
  expect(node.querySelector('.sentence mark')?.textContent).toBe(phrase);capture('grammar-chat-open');
  const suggestionButtons=()=>[...node.querySelectorAll<HTMLButtonElement>('.grammar-chat-options button')];
  const originalSuggestions=suggestionButtons().map(control=>control.textContent);
  expect(originalSuggestions).toHaveLength(3);capture('grammar-chat-suggestions');
  await click(suggestionButtons()[0]);
  const questionField=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  expect(questionField.value).toBe(originalSuggestions[0]);expect(document.activeElement).toBe(questionField);
  expect(vi.mocked(rpc).mock.calls.filter(([kind])=>kind==='grammar.chat')).toHaveLength(0);
  capture('grammar-chat-prefilled');
  async function send(value:string){
    const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);
      field.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await click(btn('Отправить'));
  }
  await send('Почему не Past Simple?');
  expect(node.querySelector('.grammar-chat [role=status]')?.textContent).toContain('Готовим');capture('grammar-chat-loading');
  const sent=vi.mocked(rpc).mock.calls.find(([type])=>type==='grammar.chat')![1]!;
  await act(async()=>finish({grammarId:analysis.grammarId,turnId:sent.turnId,kind:'answer',
    answer:'Форма had dreamed показывает, что мечта уже существовала к моменту переезда. Вариант dreamed сам по себе просто относит мечту к прошлому. Здесь порядок событий также подсказывает слово before.'}));
  capture('grammar-chat-answer');
  expect(suggestionButtons().map(control=>control.textContent)).not.toEqual(originalSuggestions);
  capture('grammar-chat-followup');
  await send('Где купить кофе?');
  expect(node.querySelector('.grammar-chat-notice')?.textContent).toContain('Назовите языковую тему');capture('grammar-chat-scope');
  await send('Можно объяснить проще?');
  expect(node.querySelector('.grammar-chat [role=alert]')?.textContent).toBe('OpenAI не ответил вовремя.');
  capture('grammar-chat-error');
  for (const [key,question,message] of [
    ['grammar-chat-local-clarify','Где купить кофе?', 'Запрос в OpenAI не отправлялся.'],
    ['grammar-chat-model-no-answer','А had здесь можно опустить?', 'недостаточно сведений для уверенного объяснения']
  ]) {
    await mount(<GrammarPopup key={key} options={options} close={()=>{}}/>);
    await click(node.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!);
    await send(question);
    expect(node.querySelector('.grammar-chat-notice')?.textContent).toContain(message);
    capture(key);
  }
  expect(vi.mocked(rpc).mock.calls.filter(([kind])=>kind==='grammar.addNote')).toHaveLength(0);
});

it('captures a continuing conversation, a local refusal and an interrupted question awaiting explicit retry',async()=>{
  const ruleQuestion='Отправь мне правило целиком, как оно звучит', followup='Какое из двух событий произошло раньше?';
  const offTopic='Какая завтра погода?', correction='А had здесь можно опустить?';
  const interrupted='Можно объяснить это другими словами?';
  const answers:Record<string,string>={
    [ruleQuestion]:'Past Perfect обозначает действие, которое уже завершилось к определённому моменту в прошлом. В утверждении перед третьей формой глагола ставят had, в отрицании — had not. В вопросе had ставят перед подлежащим. Здесь had left показывает, что лодки ушли до прихода Мары.',
    [followup]:'Сначала лодки ушли (had left), затем Мара добралась до причала (reached). Past Perfect отмечает более раннее событие.',
    [correction]:'Если убрать had из had left, получится Past Simple — left. Слова by the time по-прежнему подсказывают порядок событий, но форма глагола больше не подчёркивает, что лодки ушли раньше.',
  };
  const rpc=vi.fn(async(type:string,body?:any)=>{
    if(type==='settings.getReader')return settings;
    if(type==='grammar.lookup')return harbourGrammar;
    if(type==='grammar.chat'){
      const ids={grammarId:body.grammarId,turnId:body.turnId};
      if(body.question===offTopic)return {...ids,kind:'out_of_scope'};
      if(body.question===interrupted)throw Object.assign(new Error('worker interrupted'),{code:'REQUEST_CANCELLED'});
      return {...ids,kind:'answer',answer:answers[body.question]};
    }
    return {};
  }) as UiRpc;
  const options={rpc,source:readingSource,payload:grammarPayload,autoGenerate:true};
  async function open(key:string){
    await mount(<GrammarPopup key={key} options={options} close={()=>{}}/>);
    await click(node.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!);
  }
  const field=()=>node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  async function ask(question:string){
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field(),question);
      field().dispatchEvent(new Event('input',{bubbles:true}));
    });
    await click(btn('Отправить'));
  }
  await open('rule-and-followup');await ask(ruleQuestion);
  expect(node.querySelector('.grammar-chat-answer')?.textContent).toContain('уже завершилось');
  capture('grammar-chat-rule');
  await ask(followup);expect(node.querySelectorAll('.grammar-chat-answer')).toHaveLength(2);capture('grammar-chat-followup');
  await open('clarification');await ask(offTopic);
  expect(field().value).toBe(offTopic);expect(node.querySelector('.grammar-chat-notice')?.textContent).toContain('не отправлялся');
  const sameField=field();await ask(correction);
  expect(field()).toBe(sameField);expect(node.querySelector('[role=log]')?.textContent).toContain(offTopic);
  capture('grammar-chat-after-clarification');
  await open('interrupted');await ask(ruleQuestion);await ask(interrupted);
  expect(field().value).toBe(interrupted);expect(btn('Повторить')).toBeDefined();
  const attempts=()=>vi.mocked(rpc).mock.calls.filter(([type,payload])=>type==='grammar.chat'&&payload?.question===interrupted);
  await act(async()=>window.dispatchEvent(new Event('focus')));
  expect(attempts()).toHaveLength(1);expect(node.querySelectorAll('.grammar-chat-answer')).toHaveLength(1);
  capture('grammar-chat-interrupted');
});

it('captures the expired conversation with the latest editable draft recovered for copying',async()=>{
  const asked='Почему здесь had left?', followup='Можно ещё один пример?', latest='А если вместо had left поставить left?';
  let rejectFollowup!:(reason:unknown)=>void;
  const rpc=vi.fn(async(type:string,body?:any)=>{
    if(type==='settings.getReader')return settings;
    if(type==='grammar.lookup')return harbourGrammar;
    if(type==='grammar.chat'&&body.question===asked)return {grammarId:body.grammarId,turnId:body.turnId,kind:'answer',
      answer:'Форма had left показывает, что лодки уже ушли к тому моменту, когда Мара добралась до причала.'};
    if(type==='grammar.chat')return new Promise((_resolve,reject)=>{rejectFollowup=reject;});
    return {};
  }) as UiRpc;
  await mount(<GrammarPopup options={{rpc,source:readingSource,payload:grammarPayload,autoGenerate:true}} close={()=>{}}/>);
  await click(node.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!);
  const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  async function typeQuestion(value:string){await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,value);
    field.dispatchEvent(new Event('input',{bubbles:true}));
  });}
  await typeQuestion(asked);await click(btn('Отправить'));
  await typeQuestion(followup);await click(btn('Отправить'));
  await typeQuestion(latest);
  await act(async()=>rejectFollowup(Object.assign(new Error('The fixture session expired'),{code:'LOOKUP_EXPIRED'})));
  expect(field.value).toBe(latest);expect(field.readOnly).toBe(true);
  expect(node.querySelector('.grammar-chat-answer')?.textContent).toContain('had left');
  expect(btn('Отправить')).toBeUndefined();expect(btn('Повторить')).toBeUndefined();
  capture('grammar-chat-expired');
  await click(btn('Вернуться к разбору'));
  expect(node.querySelector('.grammar-reading')?.textContent).toContain(harbourGrammar.rule);
  expect(vi.mocked(rpc).mock.calls.filter(([kind])=>kind==='grammar.lookup')).toHaveLength(1);
  expect(vi.mocked(rpc).mock.calls.filter(([kind])=>kind==='grammar.chat')).toHaveLength(2);
});

it('captures the requested relative-clause rule from the current analysis',async()=>{
  const {relativeClauseLesson,fullRuleQuestion,relativeClauseFullAnswer}=await import('../fixtures/grammar-relative-clause');
  const rpc=vi.fn(async(type:string,body:any)=>{
    if(type==='settings.getReader')return settings;
    if(type==='grammar.lookup')return relativeClauseLesson.analysis;
    if(type==='grammar.chat')return {grammarId:body.grammarId,turnId:body.turnId,kind:'answer',answer:relativeClauseFullAnswer};
    return {};
  }) as UiRpc;
  await mount(<GrammarPopup close={()=>{}} options={{rpc,payload:relativeClauseLesson.input,source:readingSource,autoGenerate:true}}/>);
  await click(node.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!);
  const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,fullRuleQuestion);
    field.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await click(btn('Отправить'));
  expect(node.querySelector('.grammar-chat-answer')?.textContent).toContain(relativeClauseLesson.analysis.rule);
  expect(node.querySelector('.grammar-chat-answer small')).toBeNull();
  expect(node.querySelector('mark')?.textContent).toBe(relativeClauseLesson.analysis.construction.text);
  capture('grammar-rule-relative-clause');
});

it('captures vertical reading before and after a click on blank paper inside the EPUB frame',async()=>{
  const {watchBookSurfaceTaps}=await import('../../apps/extension/src/readers/book-text-tap');
  const noop=()=>{};
  function VerticalScene(){
    const owner=React.useRef<HTMLDivElement>(null),dismiss=React.useRef<(()=>void)|null>(null);
    React.useLayoutEffect(()=>{
      const surface=owner.current!.closest<HTMLElement>('.rc-book-view')!,watch=watchBookSurfaceTaps(surface,dismiss);
      const sections=[
        '<h2>Contents</h2><p><a href="crossing.xhtml">The First Crossing</a></p><p><a href="copper.xhtml">The Copper Gate</a></p><p><a href="island.xhtml">The Last Island</a></p>',
        '<h1>The First Crossing</h1><p>At seven, the harbour was almost empty. A pair of gulls followed the first boat past the lighthouse.</p><p>Mara folded the map and slipped it into the blue envelope. A glimmer of light appeared beyond the harbour wall.</p><p>From the end of the pier, the open sea looked almost still.</p>'+
          Array.from({length:25},(_,i)=>'<p>On watch '+(i+1)+', the crew followed the pale channel markers. Each turn brought a new view of the coastal hills.</p>').join(''),
        '<h1>The Copper Gate</h1><p>The first copper compass lay beside a second copper compass.</p>'
      ];
      owner.current!.querySelectorAll('iframe').forEach((frame,i)=>{
        const doc=frame.contentDocument!;
        const clean=sanitizeChapter('<html><head><title>Coastal Review</title></head><body>'+sections[i]+'</body></html>','index.xhtml',new Map());
        const safe=new DOMParser().parseFromString(clean,'text/html');
        doc.body.replaceChildren(...Array.from(safe.body.childNodes,n=>doc.importNode(n,true)));
        applyBookStyle(doc,{kind:'epub',fontSize:20,lineHeight:1.7,width:'comfortable',theme:'light',publisher:true,flow:'scrolled'});
        frame.dataset.previewHtml=doc.documentElement.outerHTML;watch.addFrame(doc);
      });
      return ()=>watch.dispose();
    },[]);
    return <ReaderChrome className="er-epub-reader er-epub-scrolled" theme="white" onThemeChange={noop}
      title="Coastal Review" onBack={noop} chapter={{label:'Глава 1',title:'The First Crossing',previous:noop,next:noop}}
      page={{label:'Страница 3 из 49',previous:noop,next:noop}} progress={5} onSeek={noop} bookmarked={false} onBookmark={noop}
      textTapDismiss={dismiss} appearance={<ReflowControls fontSize={20} onFontSize={noop} lineHeight={1.7} onLineHeight={noop}
        spread={false} onSpread={noop} publisher onPublisher={noop} scrolling onScrolling={noop}/>} search={null} chapters={null} quotes={null}>
      <div ref={owner} className="er-epub-viewport"><div className="epub-container"><div className="epub-view"><iframe title="Contents"/></div>
        <div className="epub-view"><iframe title="The First Crossing"/></div><div className="epub-view"><iframe title="The Copper Gate"/></div></div></div>
    </ReaderChrome>;
  }
  await mount(<VerticalScene/>);await click(node.querySelector<HTMLButtonElement>('.rc-rail-appearance')!);
  expect(node.querySelector('.rc-panel')).toBeTruthy();
  capture('reader-vertical-appearance');
  const doc=node.querySelector('iframe')!.contentDocument!,win=doc.defaultView!;
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{
    await act(async()=>{
      for(const type of ['pointerdown','pointerup','click']){
        doc.body.dispatchEvent(new win.PointerEvent(type,{button:0,pointerId:1,pointerType:'mouse',isPrimary:true,detail:1,bubbles:true,cancelable:true}));
      }
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(node.querySelector('.rc-panel')).toBeNull();capture('reader-vertical-continuous');
  }finally{vi.useRealTimers();}
});


it('captures a standalone language lesson and a follow-up exercise from the Alt popup',async()=>{
  const lessonRequest='дай полное объяснение темы Present Perfect';
  const exerciseRequest='Дай упражнение по этой теме';
  const lesson='Present Perfect связывает прошлое с настоящим. Форма строится из have или has и третьей формы глагола.\n\nI have lost my key. Ключ всё ещё не найден. Если важен конкретный момент в прошлом, используйте Past Simple: I lost my key yesterday.';
  const exercise='Заполните пропуски.\n1. She ___ just finished the book.\n2. We ___ this story yesterday. Выберите read или have read.';
  const rpc=vi.fn(async(type:string,body:any)=>{
    if(type==='settings.getReader')return settings;
    if(type==='grammar.lookup')return harbourGrammar;
    if(type==='grammar.chat')return {grammarId:body.grammarId,turnId:body.turnId,kind:'answer',answer:body.question===lessonRequest?lesson:exercise};
    return {};
  }) as UiRpc;
  await mount(<GrammarPopup options={{rpc,payload:grammarPayload,source:readingSource,autoGenerate:true}} close={()=>{}}/>);
  await click(node.querySelector<HTMLButtonElement>('[aria-label="Открыть языковой чат"]')!);
  const field=node.querySelector<HTMLTextAreaElement>('#grammar-chat-question')!;
  for(const question of [lessonRequest,exerciseRequest]){
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,question);
      field.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await click(btn('Отправить'));
  }
  expect([...node.querySelectorAll('.language-chat-markdown')].map(text=>[...text.querySelectorAll('p,li')].map(row=>row.textContent))).toEqual([lesson.split('\n\n'), ['Заполните пропуски.', 'She ___ just finished the book.', 'We ___ this story yesterday. Выберите read или have read.']]);
  expect(node.querySelector('h2')?.textContent).toBe('Языковой чат');
  capture('language-chat-lesson');
});
