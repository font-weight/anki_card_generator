import {LANGUAGE_CODES} from './languages.ts';
import {lessonTopic,splitLanguageTopicReset} from './language-topic.ts';
import {isLanguageChatText} from './language-chat-text.ts';
import {isGrammarPlainText,validateGrammarLookupData} from './grammar.ts';
import type {GrammarLookupPayload,GrammarLookupData} from './grammar.ts';
import {ContractValidationError,validateSchema,type Schema} from './validation.ts';

export type GrammarQuestionContext={input:GrammarLookupPayload;analysis:GrammarLookupData};
export type GrammarQuestionTurn={question:string;answer:string;scope?:'sentence'|'language';topicStart?:true};
export type GrammarQuestionResult=
 | {kind:'answer';answer:string;anchor:string;evidence:string}
 | {kind:'out_of_scope'}
 | {kind:'insufficient_evidence'};
export {GRAMMAR_QUESTION_LIMIT,GRAMMAR_ANSWER_LIMIT,GRAMMAR_CHAT_OUTPUT_TOKENS} from './grammar-chat-limits.ts';
import {GRAMMAR_QUESTION_LIMIT,GRAMMAR_ANSWER_LIMIT,GRAMMAR_CHAT_HISTORY_TURNS} from './grammar-chat-limits.ts';
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=(maxLength:number):Schema=>({type:'string',minLength:1,maxLength});
const answerFields={kind:{type:'string',enum:['answer']} as Schema,answer:text(GRAMMAR_ANSWER_LIMIT),anchor:text(500),evidence:text(500)};
const noAnswer=object({kind:{type:'string',enum:['out_of_scope','insufficient_evidence']}});
export const grammarQuestionOutputSchema=object({result:{anyOf:[
 object(answerFields),noAnswer,
]}});
export const languageTutorOutputSchema=object({result:{anyOf:[
 object({kind:answerFields.kind,answer:answerFields.answer}),noAnswer,
]}});
export type LanguageTutorResult={kind:'answer';answer:string;anchor?:never;evidence?:never} | Exclude<GrammarQuestionResult,{kind:'answer'}>;
export const grammarExampleOutputSchema=object({result:{anyOf:[
 object({...answerFields,variation:text(500)}),noAnswer,
]}});

function reject():never{throw new ContractValidationError('Invalid grammar question context or response');}
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replaceAll('ё','е').replace(/[’‘]/gu,"'").replace(/\s+/gu,' ').trim();
const words=(s:string):string[]=>normalize(s).match(/[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)?/gu)??[];

function plain(s:string):boolean{
 return isGrammarPlainText(s) && !/[\p{Cf}<>\x60]|(?:[a-z][a-z\d+.-]*:\/\/|www\.|data:|javascript:|file:|mailto:)|\*\*|__|(?:^|\n)\s*#{1,6}\s|\[[^\]]+\]\s*\(/iu.test(s);
}
/** The source is evidence, including when it happens to contain an imperative.
 * Explicit requests for a different task or changes to the assistant's role are ineligible. */
function redirects(s:string):boolean{
 const n=normalize(s);
 return /(?:ignore|disregard|forget|override) (?:all |any |your |the |our |my |these |previous |earlier |above |prior )*(?:instructions?|rules?|grammar|question|task|lesson|analysis|context)|(?:change|switch) (?:the )?(?:topic|subject|task)|(?:instead of|rather than) (?:teaching |explaining |analy[sz]ing )?(?:grammar|the form|the sentence)|(?:act as|pretend to be|you are now) (?:an? |my |the )?(?:assistant|chatbot|moderator|teacher with new instructions)|(?:system|developer|assistant|instruction|user)\s*[:：]/u.test(n)
  || /(?:игнорируй|забудь|отбрось|пропусти|не следуй) (?:все |прежние |предыдущие |этот |этот самый |этим |моим |этой |данные |прошлые )*(?:инструкци|правил|грамматик|разбор|задани|указани|вопрос|контекст)|(?:смени|поменяй|измени) (?:тему|роль|задание)|(?:вместо|помимо) (?:грамматик|разбор|ответа)|(?:твоя новая задача|теперь ты (?:ассистент|чатбот)|системное сообщение|инструкция для (?:модели|ассистента))|(?:пользователь|ассистент|система)\s*[:：]/u.test(n)
  || /(?:answer (?:only )?with|respond (?:only )?with|reply (?:only )?with|отвечай только|ответь только|выведи только|please (?:give|write|list|recommend) (?:me |us )?(?:a |the |three |some )?(?:recipe|poem|itinerary|menu)|(?:напиши|составь|посоветуй) (?:мне |нам )?(?:рецепт|стихотворение|маршрут|меню))/u.test(n);
}
export function validateGrammarQuestionContext(context:GrammarQuestionContext,history:readonly GrammarQuestionTurn[],question:string):void{
 if(!context || !Array.isArray(history) || history.length>GRAMMAR_CHAT_HISTORY_TURNS || typeof question!=='string' || !question.trim() || question.length>GRAMMAR_QUESTION_LIMIT)reject();
 const analysis=validateGrammarLookupData(context.analysis,context.input);
 if(!('construction' in analysis))reject();
 if(history.some(turn=>!turn || typeof turn.question!=='string' || !turn.question.trim() || turn.question.length>GRAMMAR_QUESTION_LIMIT ||
  typeof turn.answer!=='string' || !turn.answer.trim() || turn.answer.length>GRAMMAR_ANSWER_LIMIT))reject();
}

// An example request selects a stricter output shape. Other formulations can
// still be judged in the ordinary single request; this is not an admission list.
const exampleNoun=/(?:^| )(?:пример(?:а|е|ы|ов)?|examples?)(?: |$)/u;
const exampleIntent=/(?:^| )(?:дай|дайте|приведи|приведите|привести|покажи|показать|можно|нужен|хочу|еще|другой|один|give|show|illustrate|another|more|example)(?: |$)/u;
export function isGrammarExampleRequest(question:string):boolean{
 const query=words(withoutQuotedWords(question)).join(' ');
 return exampleNoun.test(query) && exampleIntent.test(query) && !/\bfor example\b/u.test(query);
}

/** Suggestions only populate the field. They refer to the immutable selection. */
export function grammarQuestionSuggestions(construction:string,hasAnswer:boolean):readonly string[]{
 if(hasAnswer)return ['Объясни последний ответ проще','Дай упражнение по этой теме'];
 const mention=construction.length<=45 && /^[\p{L}\p{M} ’'-]+$/u.test(construction);
 const first=mention?`Что показывает форма «${construction}» в этом предложении?`:'Объясни выделенную форму в предложении';
 return [first,'Дай полное объяснение темы Present Perfect','Дай упражнение на предлоги места'];
}

export type GrammarQuestionRoute='local_decline'|'sentence'|'uncertain'|'language'|'language_followup'|'language_sentence'|'card_lesson';

const quotations=/„([^“”]+)[“”]|«([^»]+)»|“([^”]+)”|‘([^’]+)’|"([^"]+)"|(?:^|\s)'([^']+)'(?=\s|[?.,!]|$)/gu;
function quotedWords(value:string):string[]{
 return [...value.matchAll(quotations)].map(match=>match[1]??match[2]??match[3]??match[4]??match[5]??match[6]);
}
function withoutQuotedWords(value:string):string{return value.replace(quotations,' ');}

// Detect the requested real-world action, rather than excluding book vocabulary
// such as "ticket" when the reader asks about that word's grammatical role.
const practicalIntent=[
 /сколько (?:рублей|евро|долларов|денег) (?:стоит|будет стоить)/u,
 /\b(?:how (?:much|many).{0,65}(?:cost|price)|(?:where|how) (?:can|could|do|should) (?:i|we|you) (?:buy|book|order|cook|plant)|(?:what|which).{0,50}(?:sold the most|best.sell|most popular))\b/u,
 /(?:сколько (?:стоит|стоят)|где (?:ближайш|можно (?:купить|заказать)|купить|заказать)|(?:как|какие|какую|что|чем) [^?.!]{0,40}(?:приготовить|испечь|подарить|заказать|забронировать|лучше посадить))/u,
 /\b(?:recommend|suggest|find|give|write|plan|list)\s+(?:(?:me|us|a|the|my|some|another|good|local|nearby|detailed|travel)\s+){0,4}(?:recipes?|menus?|picnic|restaurants?|hotels?|films?|itinerary|forecast|capital cities)\b/u,
 /(?:\btell (?:me|us) about (?:local |nearby )?(?:restaurants?|hotels?|the weather)\b|(?:подскажи|посоветуй|подбери|найди|назови|составь|напиши|перечисли|расскажи)\s+(?:(?:мне|пожалуйста|главные|крупные|местные|хороший|свой|про)\s+){0,4}(?:город[а-я]*|рецепт|маршрут|ресторан|фильм|меню|прогноз|столиц|достопримечательност))/u,
 /(?:\b(?:weather forecast|what(?:'s| is) the (?:weather|capital of)|where is the nearest|who (?:won|invented|founded))\b|какая (?:сегодня|завтра) погода|как(?:ая|ой) столиц|какая погода|(?:как[а-яё]*|что) [^?.!]{0,55}(?:прода[а-яё]* (?:лучше|больше) всего|лидиру[а-яё]* (?:в|по) продаж|сам[а-яё]* продаваем)|который час|какой сегодня день|кто (?:выиграл|основал|изобрел))/u,
 /(?:\b(?:what time|how often|where).{0,55}\b(?:the next|last|first) (?:bus|train|flight|ferry)\b|(?:во сколько|когда|откуда).{0,40}(?:следующ|последн)[а-яё]+ (?:автобус|поезд|рейс|электричк))/u,
 /(?:как[а-яё]* (?:фильм|сериал|песн|подкаст|ресторан)[а-яё]*.{0,35}(?:посмотр|послуш|выбра|пойти|сходить)|\b(?:what|which) (?:film|movie|show|restaurant|podcast).{0,35}(?:watch|listen|visit|choose)\b)/u,
];
const languageTopic=/\b(?:grammar|grammatical|rule|tense|aspect|clause|past|perfect|subject|object|word|phrase|sentence|pronoun|role|form|verb|preposition|participle|infinitive|construction|article|meaning|paraphrase)\b|граммат|правил|конструкци|предложени|артикл|местоимени|подлежащ|сказуем|предлог|дополнени|придаточн|инфинитив|глагол|падеж|причасти|форм[ауые]|слов[оаеу]|порядок событий/u;
const rephrasing=/(?:^| )(?:проще|попроще|понятнее|повтори|повторите|перефразируй|перефразируйте|упрости|simpler|simply|rephrase|restate)(?: |$)|простыми словами|другими словами/u;
const followupIntent=/(?:^| )(?:почему|проще|попроще|повторить|заново|пример(?:е|а)?|why|simpler|simply|again|example)(?: |$)/u;
const followupWords=new Set(('а и но почему если можно ли можешь можете еще один другой пожалуйста объяснить объясни поясни пояснить попроще проще словами просто это на примере пример повторить заново раз '+
 'and but why can could would may you me us i give show explain say it that this in more one another an a please again simpler simply words example is').split(' '));
const connective=/^(?:before|after|until|since|once)$/u;
function missingAssertedClue(question:string,source:string):boolean{
 const terms=words(question),sourceTerms=new Set(words(source));
 const absent=terms.some(word=>connective.test(word)&&!sourceTerms.has(word));
 // An explicit alternative may be absent by design, e.g. “Could I use after instead?”
 if(!absent||/(?:\b(?:instead|replace|substitute|add|insert)\b|вместо|замен|добав|встав)/u.test(question))return false;
 return /(?:\balready\b|уже (?:есть|задает|показывает|определяет|не задает|не показывает)|если.{0,20}уже есть)/u.test(question);
}

const acknowledgements=new Set(('спасибо благодарю понятно понял поняла ясно хорошо ладно отлично ок большое за ответ пояснение теперь ага '+
 'ok okay thanks thank you got it understood clear many so much for the explanation').split(' '));
const discourse=/(?:то есть|эти две части|по сюжету|здесь|в этом|получается|значит|верно|правильно|понятно|не уловил|не понимаю|я думал|мне кажется|выходит|связь|сначала|раньше|позже|мысль|другими словами|хочу (?:понять|уточнить)|\b(?:here|this|that|so|right|understand|reading|rephrase)\b)/u;
const requestVoice=/(?:^| )(?:почему|зачем|как|что|знаю|объясни|поясни|помоги|скажи|расскажи|покажи|подскажи|интересует|сомневаюсь|уточни|why|how|explain|clarify|help|wonder|understand)(?: |$)/u;
const commonWords=new Set(('the and this that which when can was are did for not with from what how she they my his its her has have была это как что его она для где').split(' '));

// A service's real opening/departure time is a practical lookup. The same
// words can describe a book event: keep it eligible when the source supports
// that reading and the question does not ask for a present-day place or date.
const servicePlaces=[
 /\blibrar(?:y|ies)\b|библиотек/u,/\bmuseums?\b|музе[йеяю]/u,/\bpharmac(?:y|ies)\b|аптек/u,/\bclinics?\b|поликлиник/u,
 /\b(?:shops?|stores?)\b|магазин/u,/\bpost offices?\b|почт[а-я]*/u,/\bbanks?\b|банк[а-я]*/u,/\bpools?\b|бассейн/u,
 /\b(?:stations?|trains?)\b|вокзал|поезд/u,/\b(?:bus|buses)\b|автобус/u,/\bferr(?:y|ies)\b|паром/u,
];
const serviceAction=/\b(?:open(?:s|ed|ing)?|clos(?:e|es|ed|ing)|operat(?:e|es|ing)|depart(?:s|ed|ure)?|leav(?:e|es|ing)|arriv(?:e|es|al)|runs?|sail(?:s|ing)?)\b|откр[ыо]|закр[ыо]|работа[а-я]*|отправ[а-я]*|прибы[а-я]*|ходи[а-я]*|отход[а-я]*/u;
const operatingHours=/\b(?:(?:opening|closing|operating|business|working) hours|hours of operation|timetables?|schedules?)\b|(?:часы|часов|график|режим) работы|расписани[а-я]*/u;
const asksAvailability=/\b(?:when|what time|how (?:late|early|often)|is|are|will)\b|(?:^|\s)(?:когда|во сколько|[дс]о скольки|до какого часа|в какое время|открыт[а-я]* ли|работа[а-я]* ли|ходит ли|можно ли попасть)(?:\s|$)/u;
const nearbyPlace=/\b(?:nearest|closest|nearby|near me|local)\b|ближайш|поблизости|рядом(?: со мной| уже| сейчас|$)|неподалеку/u;
const currentTime=/\b(?:today|tomorrow|tonight|right now|this morning|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b|сегодня|завтра|сейчас|выходн[а-я]*|суббот|воскресень|понедельник|вторник|средам|четверг|пятниц/u;
const narratedTime=/\b(?:in the (?:story|text|passage|book)|according to the (?:text|narrator)|does (?:this|that|it) mean|do i understand)\b|(?:по сюжету|в (?:этой |той )?(?:фразе|строке|истории|сцене|книге|рассказе)|в тексте|по тексту|по словам (?:автора|героя)|я (?:верно |правильно )?понимаю)/u;
function asksLiveSchedule(clause:string,bookText:string):boolean{
 if(narratedTime.test(clause))return false;
 const nearby=nearbyPlace.test(clause),live=nearby||currentTime.test(clause);
 const place=servicePlaces.find(category=>category.test(clause));
 const hours=operatingHours.test(clause);
 if(!place)return (hours&&live)||(nearby&&serviceAction.test(clause)&&asksAvailability.test(clause));
 if(!hours && !(serviceAction.test(clause)&&(asksAvailability.test(clause)||live)))return false;
 return live || !(place.test(bookText)&&(serviceAction.test(bookText)||operatingHours.test(bookText)));
}

function standaloneFactOrCalculation(query:string,sourceTerms:Set<string>):boolean{
 const arithmetic=/(?:сколько (?:будет|получится)|вычисл[а-яё]*|посчитай|\b(?:calculate|compute|what is|how much is)\b)/u.test(query) &&
  /(?:[\d+*/=×÷]|плюс|минус|умнож|раздел|\b(?:plus|minus|times|divided)\b)/u.test(query);
 if(arithmetic)return true;
 // An entity present in the source can be a genuine comprehension question.
 // A self-contained identity lookup for a new person is an external task.
 const identity=/^(?:(?:скажи|подскажи|расскажи)(?: мне)? |(?:please )?tell me )?(?:кто (?:такой|такая|такие) |who (?:is|was|are|were) )(.+)$/u.exec(query);
 if(!identity)return false;
 const subject=words(identity[1]).filter(w=>!['the','a','an','that','this'].includes(w));
 return subject.length>0 && !subject.some(w=>sourceTerms.has(w)) && !discourse.test(identity[1]);
}

// These cues select what the tutor needs, not which languages a reader may use.
// An unfamiliar language-learning question can always reach the general tutor without book data.
const textTask=/(?:перев(?:еди|едите|ести|од)|произно[сш]|произнес|ударени|правописани|транскрипци|орфограф|этимологи|синоним|антоним|лексик|склонени|спряжени|спряг|просклоня|идиом|словарн|фразеолог|сочинени|пунктуаци|диалект|стилистик|упражнен|придумай пример|напиши (?:письмо|диалог|текст)|как (?:сказать|пишется|пишут|прочитать)|исправь|отредактируй|перефразируй|перефразируйте|переформулируй|проверь (?:мой |мои |этот )?(?:текст|письмо|ошибки)|сравни (?:язык|английск|русск)|на (?:английском|испанском|немецком|французском|японском)|\b(?:translat(?:e|ion)|pronounc(?:e|ed)|pronunciation|stress pattern|rhym(?:e|es)|phonetics?|IPA|spell(?:ing)?(?! out)|synonyms?|antonyms?|vocabulary|idioms?|etymology|conjugat(?:e|ion)|declin(?:e|ation)|proofread|correct (?:my|this)|rewrite|rephrase|proofreading|draft (?:an? |my )?(?:email|letter)|write (?:an? |some )?(?:email|letter|dialogue)|exercises?|practice questions?|quiz|how (?:do|would) (?:you|i|we) say|in (?:English|French|Spanish|Japanese|German|Russian)|(?:English|French|Spanish|Japanese|German|Russian) (?:to|versus|vs))\b)/iu;
const generalLesson=/(?:для начинающих|(?:объясни|изуч|расскажи|хочу|учу|учишь|научи).{0,65}(?:язык|грамматик[ауи]|фонетик[ауи]|лексик[ауи]|синтаксис|лингвистик)|\b(?:learn|beginner|beginners|teaching|overview)\b|объяснение тем[ы]|обзор тем[ы]|по теме|на тему|\btopic\b|\bteach me\b|(?:объясни|расскажи|обзор|explain|teach|lesson (?:on|about)|how (?:do|does) (?:i|one|the)|when (?:to|should|do|is)|usage of|difference between).{0,95}(?:present|past|future|perfect|continuous|subjunctive|gerund|conditional|артикл|причасти|глагол|падеж|времен[аи]|наклонени)|^(?:present|past|future) (?:perfect|simple|continuous)|приведи.{0,18}пример.{0,10}(?:про|на тему)|example.{0,10}(?:about|set in))/iu;
const bookRef=/(?:в (?:этом |исходном |показанном |выделенном )(?:предложени|отрывке|тексте)|в (?:этой |исходной |показанной |выделенной )фразе|(?:этот|выделенный) (?:фрагмент|оборот|отрывок)|(?:это|выделенное|исходное) предложение|здесь|в тексте|\b(?:here|this (?:relative clause|construction|form|passage)|the (?:highlighted|original|selected|book) (?:sentence|text|passage|words?|phrase)|(?:in|translate|rewrite|read) this (?:sentence|passage|phrase))\b)/iu;
const continuation=/(?:^| )(?:это|этой|эту|этому|его|ее|их|этих|такое|еще|дальше|продолжи|проще|попроще|подробнее|предыдущ[а-я]*|а (?:почему|если|как|в)|simpler|elaborate|continue|again|another|more|it|those|them|previous)(?: |$)|^(?:дай|дайте|подбери|предложи|составь|give me|show me) (?:мне |us |some )?(?:упражнения|примеры|задания|вопросы|exercises|examples)$/u;
const newGrammarQuestion=/^(?:(?:пожалуйста|please) )?(?:что такое|что означает|как образуется|как употребляется|когда (?:используют|употребляют)|чем (?:отличается|отличаются)|в чем разница|какова разница|what (?:is|are)|what does|how (?:do you|is|are)|when (?:do|should|is)|explain (?:the difference|how to)|compare)(?: |$)/iu;
const unspecifiedTopic=/^(?:(?:дай|дайте|можно|хочу|give me|please give me) )?(?:(?:полное|подробное|полный|подробный|a full|a complete) )?(?:объяснение темы|обзор темы|explanation of (?:the|this) topic)$/iu;

function interpretsFormInContext(query:string):boolean{
 return /(?:к чему относится|роль (?:играет|слова)|какова роль|зачем |почему (?:не|нельзя)|обойтись без|раньше|после |перед |убрать |в контексте|полное правило|правило целиком|правил[оа] полностью|\b(?:why not|leave out|left out|the (?:grammar )?rule|which event|the subject of|the role of|role does)\b)/u.test(query);
}

const languageNames=new Intl.DisplayNames('en',{type:'language'});
const englishLanguageNames=new Set(LANGUAGE_CODES.map(code=>languageNames.of(code)?.toLowerCase()));

// An inventory needs a named domain (“in German”); a language name alone
// is a perfectly good follow-up to a translation. A purpose question can name
// its object directly (“Зачем нужен дательный падеж?”).
function namesGrammarSubject(query:string, original:string):boolean{
 const feature=/(?:^| )(?:падеж[а-я]*|род(?:а|ов|ы)?|времен[а-я]*|артикл[а-я]*|частиц[а-я]*|наклонени[а-я]*|местоимени[а-я]*|глагол[а-я]*|причасти[а-я]*|инфинитив[а-я]*|суффикс[а-я]*|предлог[а-я]*|алфавит[а-я]*|букв[а-я]*|звук[а-я]*|cases?|genders?|tenses?|articles?|particles?|moods?|pronouns?|verbs?|numbers?|vowels?|consonants?)(?: |$)/u;
 if(!feature.test(query))return false;
 const inventory=/^(?:(?:а|и|пожалуйста|and|please) )?(?:каки[ех]|сколько|есть ли|существуют ли|правда ли что|зачем|для чего|у .+ есть|how many|which|what|is there|are there|does|is it true that) /u;
 if(!inventory.test(query))return false;
 if(/(?:^| )во? (?:[а-я]+(?:ском|цком)|[а-я]+ языке)(?: |$)/u.test(query))return true;
 if(/^(?:а )?(?:зачем|для чего) (?:нужен|нужна|нужно|нужны) /u.test(query))return true;
 // Require a named object: “in German” and “in total” have the same shape.
 const domain=/(?:\b(?:in|does) ([a-z]+)(?: language)?(?:$| (?:have|use|distinguish)(?: |$))|^is it true that ([a-z]+) (?:has|uses|distinguishes) )/u.exec(query);
 const name=domain?.[1]??domain?.[2];
 return !!name && (englishLanguageNames.has(name) ||
  (original.match(/\b[A-Z][a-z]+\b/g)??[]).some(word=>word.toLowerCase()===name));
}

// Once there is an accepted language topic, keep it unless the reader supplies
// a new object of study. An elliptical request can change language, register,
// tense or task without restating the text; none requires a list of languages.
function suppliesNewSubject(query:string, hasMaterial:boolean, general:boolean, original:string):boolean{
 if(hasMaterial)return true;
 const referentText=query.replace(/^is it true that /u,'');
 const reference=/(?:^| )(?:эт[а-я]*|так|его|ее|них|предыдущ[а-я]*|it|this|that|these|those|them|previous|same|(?:the|both) (?:two )?(?:versions|variants|forms|options|examples)|обе версии|оба варианта)(?: |$)/u.test(referentText);
 // These pointers identify material shared in the conversation, even when
 // the follow-up also names a grammatical category (“в твоём примере”).
 const refersBack=/(?:^| )(?:здесь|тут|там|они|их|он[аи]?|нем|ней|того|той|том|тво[а-я]*|ваш[а-я]*|наш[а-я]*|выше|упомянут[а-я]*|показанн[а-я]*|приведенн[а-я]*|данно[а-я]*|the above|your|our|here|therein|above|earlier|mentioned)(?: |$)/u;
 if(namesGrammarSubject(query,original))return !reference&&!refersBack.test(referentText);
 // Filled comparison, definition, exercise or lesson arguments identify a subject.
 const comparison=/(?:чем отличаются|в чем разница между|разниц[ауы] между|\b(?:difference between|compare)\b|différence entre|diferencia entre)/u;
 const namedExercise=/(?:упражнен[а-я]*|пример[а-я]*) (?:на|по|про) |(?:examples?|exercises?) (?:about|on|for) /u;
 if(comparison.test(query)||namedExercise.test(query)||general)return !reference&&!unspecifiedTopic.test(query);
 // An explicit text after a translation/writing verb, or a named word after
 // a pronunciation question, is its own task even without quotation marks.
 const suppliedText=/(?:переведи(?:те)?|перевести|translate|traduce|traduis|как произносится|как пишется|что значит|(?:как |по [\p{L}]+ )сказать|как произнести|how to pronounce|how (?:do|can|would) (?:you|i|we) say) (.+)$/u.exec(query);
 if(suppliedText && !reference){
  // In an unquoted task remove a leading language modifier, not its object:
  // “на немецкий” is elliptical, “на немецкий я потерял ключ” supplies text.
  const operand=suppliedText[1].replace(/^(?:(?:по|на|in|into) [\p{L}]+)(?: |$)/u,'');
  if(operand && !/^(?:пожалуйста|please)$/u.test(operand))return true;
 }
 const declaredSubject=/(?:как правильно (?:[а-я]+ ){0,3}(?:объяснить|обратиться|оформить|попросить)|следующ[а-я]* (?:текст|реплик|фраз)|(?:как |какие |почему ).*(?:грамматик|частиц[а-я]*|артикл[а-я]*)|\bhow does .+ (?:change|affect|work)\b)/u;
 if(!reference && (newGrammarQuestion.test(query)||declaredSubject.test(query)))return true;
 return !reference && /(?:расскажи (?:о|об|про) |объясни (?:мне )?(?:правил[ао] |употребление |разницу |грамматик)|\b(?:tell me about|explain how|teach me about)\b)/u.test(query);
}

// A quotation copied from an answer is often the object of a follow-up
// explanation. Only match whole tokens in the latest accepted exchange.
function asksAboutPreviousWording(question:string, query:string, last:GrammarQuestionTurn):boolean{
 const explanation=/(?:^| )(?:почему|зачем|откуда|поясни|поясните|пояснить|пояснение|why|warum|wieso|pourquoi|perché|porque|значит|означает|meant|mean)(?: |$)/u;
 if(!explanation.test(query))return false;
 const fragments=[...quotedWords(question),...Array.from(question.matchAll(/[\x60*]([^\x60*\n]+)[\x60*]/gu),m=>m[1])];
 if(!fragments.length)return false;
 const previous=' '+words(last.question+' '+last.answer).join(' ')+' ';
 return fragments.some(fragment=>{
  const tokens=words(fragment);
  return tokens.length>0 && tokens.length<=12 && previous.includes(' '+tokens.join(' ')+' ');
 });
}

function chooseChatRoute(context:GrammarQuestionContext,history:readonly GrammarQuestionTurn[],question:string):GrammarQuestionRoute{
 const {input,analysis}=context;
 if(!isLanguageChatText(question)||question.length>GRAMMAR_QUESTION_LIMIT)return 'local_decline';
 const terms=words(question);
 if(!terms.length)return 'local_decline';
 const normalized=normalize(question),outside=normalize(withoutQuotedWords(question));
 if(terms.every(word=>acknowledgements.has(word)))return 'local_decline';
 const source=new Set(words(input.sentence));
 const query=terms.join(' ');
 const bookText=normalize(input.sentence+' '+analysis.translation);
 const clauses=outside.split(/(?:[?!;]+|\s+(?:и|а также|and|also)\s+)/u);
 const textOperation=textTask.test(outside);
 // Format preferences can be part of ordinary proofreading or translation. The
 // tutor still treats their wording and any quoted examples as untrusted data.
 const intent=outside.replace(/(?:ответь|отвечай|выведи) только (?:переводом|перевод|исправленным текстом)|(?:answer|respond|reply) (?:with )?only (?:with )?(?:the )?(?:translation|corrected text)/gu,'translate');
 const normalChange=intent.replace(/^(?:(?:давай(?:те)? )?(?:смени(?:м|те)?|поменяем) тему|(?:let's )?(?:change|switch) (?:the )?(?:topic|subject))[,.: ]+/u,'');
 if(redirects(normalChange)&&!textOperation)return 'local_decline';
 // The object of a translation or correction can be a question about absolutely anything.
 // Still reject a separate request to actually perform an unrelated task.
 const practical=clauses.some(clause=>!textTask.test(clause)&&!languageTopic.test(clause)&&
   (practicalIntent.some(intent=>intent.test(clause))||asksLiveSchedule(clause,bookText)||standaloneFactOrCalculation(clause.trim(),source)));
 if(practical)return 'local_decline';
 const last=history.at(-1),fromBook=bookRef.test(outside);
 const contextualWords=terms.filter(w=>w.length>2&&!commonWords.has(w)&&source.has(w));
 const hasOwnText=quotedWords(question).length>0 || /[:：„]/u.test(question) ||
   /(?:следующ[а-я]+ (?:реплик|фраз|предложен|текст)|(?:текст|письмо) ниже|\bthe following (?:lines|text|sentences|dialogue|email)\b)/u.test(outside);
 const formatted=/[<>`*_#\[\]]|:\/\//u.test(question);
 const general=generalLesson.test(outside);
 // A plain “here” in a follow-up refers to the latest answer. Explicit
 // references to the selected text keep the existing close-reading path.
 const namesBook=bookRef.test(outside.replace(/(?:здесь|\bhere\b)/gu,''))||
   /в книге|(?:из|по) книг[еи]|\b(?:in|from) the book\b/u.test(outside);
 const lesson=lessonTopic(question);
 if(lesson){
  const explicitBook=namesBook && !/^this (?:construction|form|relative clause)$/iu.test(bookRef.exec(outside)?.[0]??'');
  if(explicitBook)return 'card_lesson';
  if(lesson==='current')return last?.scope==='language'?'language_followup':'card_lesson';
  return 'language';
 }
 if(last?.scope==='language'&&!namesBook){
  if(asksAboutPreviousWording(question,query,last))return 'language_followup';
  const pastedText=quotedWords(question).length>0 || /[„\n]/u.test(question) ||
   (formatted && (textOperation || /выражени|формул|notation/u.test(outside))) || (textOperation && /[:：]\s*\S/u.test(question)) ||
   /следующ[а-я]+ (?:реплик|фраз|предложен|текст)|\bthe following (?:lines|text|sentences|dialogue|email)\b/u.test(outside);
  return suppliesNewSubject(query,pastedText,general,question)?'language':'language_followup';
 }
 const briefFollowup=followupIntent.test(query)&&terms.every(word=>followupWords.has(word));
 const referring=unspecifiedTopic.test(query)||continuation.test(query)||briefFollowup;
 const freshGrammar=newGrammarQuestion.test(query)&&!fromBook&&!quotedWords(question).some(quote=>input.sentence.includes(quote));
 if(formatted||textOperation || general || freshGrammar){
  // A named existing source word (“What is the subject of longed?”) is a close-reading
  // question. A common word shared by two texts does not tie a general topic to the book.
  const namesSourceFocus=/\b(?:role|subject|object|function) of\b|роль слова/u.test(query)&&contextualWords.length>0;
  if(namesSourceFocus&&!formatted&&!textOperation&&!general)return 'sentence';
  if(fromBook&&!hasOwnText)return 'language_sentence';
  if(last && !hasOwnText && referring && (!general||unspecifiedTopic.test(query)))return 'language_followup';
  return 'language';
 }
 if(last?.scope==='language'&&!fromBook && (referring||rephrasing.test(query)))return 'language_followup';
 const missing=missingAssertedClue(normalized,input.sentence);
 if(missing && !terms.some(word=>word.length>2 && !commonWords.has(word) && words(analysis.construction.text).includes(word)))return fromBook?'language_sentence':'language';

 if(missing)return 'uncertain';
 const standaloneFollowup=briefFollowup;
 // The original lesson already gives a simple restatement a referent. A bare
 // “why?” or “another example?” still needs a preceding accepted answer.
 const simpleRephrase=rephrasing.test(query)&&!hasOwnText&&!isGrammarExampleRequest(question);
 const followSourceRule=/это правило|полностью (?:это )?правило|полная формулировка/u.test(query);
 if(simpleRephrase||followSourceRule)return 'sentence';
 if(standaloneFollowup)return history.length?'sentence':'local_decline';
 const quoted=quotedWords(question).some(quote=>hasWholePassage(normalize(input.sentence),normalize(quote),input.sourceLanguage));
 // Apply source verification only to a deliberate reading of this passage.
 // “Как правильно обратиться к заказчику?” and an incidental shared word do not select it.
 const specificReference=fromBook||quoted||narratedTime.test(outside)||
   /(?:эту часть|эт[ои] (?:две )?части|выделенн|исходн|по сюжету|то есть|вы про то|правильно ли я понимаю|я (?:правильно|верно) понял|\b(?:in the story|in the text|as used here|does this mean)\b)/u.test(query);
 const closeFocus=interpretsFormInContext(query)||/относится|связыва[ею]т|\b(?:refer to|relate to|modify)\b/u.test(query);
 const originalTerm=terms.some(w=>words(analysis.construction.text).includes(w)&&!commonWords.has(w));
 if(quoted || (specificReference||closeFocus) && (contextualWords.length||originalTerm||languageTopic.test(normalized)))return 'sentence';
 if(languageTopic.test(normalized)&&closeFocus)return 'sentence';
 if(specificReference||contextualWords.length>0&&serviceAction.test(outside)&&asksAvailability.test(outside))return 'uncertain';
 return 'language';
}

export function classifyGrammarQuestion(context:GrammarQuestionContext,history:readonly GrammarQuestionTurn[],question:string):GrammarQuestionRoute{
 if(!isLanguageChatText(question)||question.length>GRAMMAR_QUESTION_LIMIT)return 'local_decline';
 const reset=splitLanguageTopicReset(question);
 if(reset){
  // A new user-specified topic does not implicitly refer back to the book.
  if(reset.task && chooseChatRoute(context,[],reset.task)==='local_decline')return 'local_decline';
  return 'language';
 }
 const route=chooseChatRoute(context,history,question);
 if(route==='sentence'||route==='uncertain'||route==='language_sentence'||route==='card_lesson'){
  const {analysis}=context;
  const lesson=[context.input.sentence,analysis.question,analysis.answer,analysis.rule,analysis.explanation??'-'];
  if(lesson.some(part=>!plain(part)||redirects(part)))return 'local_decline';
 }
 return route;
}

// Include only turns back to the start of the most recent topic. A fresh question
// never sends previous material, even when the application keeps it in its local history.
export function languageTutorHistory(context:GrammarQuestionContext,history:readonly GrammarQuestionTurn[]):GrammarQuestionTurn[]{
 if(!history.length)return [];
 let start=history.length-1;
 while(start>0 && !history[start].topicStart && history[start].scope==='language' && history[start-1].scope==='language')start--;
 // Upgraded sessions may have several old topics without recorded boundaries.
 // For new histories use the decision made when the answer was accepted.
 if(!history[start].topicStart){
  let cursor=history.length-1;
  while(cursor>start && !splitLanguageTopicReset(history[cursor].question) &&
    chooseChatRoute(context,history.slice(0,cursor),history[cursor].question)==='language_followup')cursor--;
  start=cursor;
 }
 return history.slice(start).map(({question,answer})=>({question,answer}));
}

export function isGrammarQuestionInScope(context:GrammarQuestionContext,history:readonly GrammarQuestionTurn[],question:string):boolean{
 return classifyGrammarQuestion(context,history,question)!=='local_decline';
}

function wholePassageStarts(sentence:string,passage:string,language:string):number[]{
 if(!passage || !sentence.includes(passage))return [];
 const boundaries=new Set([0,sentence.length]),starts:number[]=[];
 for(const token of new Intl.Segmenter(language,{granularity:'word'}).segment(sentence))boundaries.add(token.index);
 for(let at=sentence.indexOf(passage);at!==-1;at=sentence.indexOf(passage,at+1)){
  if(boundaries.has(at)&&boundaries.has(at+passage.length))starts.push(at);
 }
 return starts;
}
function hasWholePassage(sentence:string,passage:string,language:string):boolean{
 return wholePassageStarts(sentence,passage,language).length>0;
}

type GrammarOutputProblem='grammar_anchor'|'grammar_evidence'|'grammar_answer_length'|'grammar_answer_format';
export class GrammarQuestionOutputError extends ContractValidationError{
 readonly reason:GrammarOutputProblem;
 constructor(reason:GrammarOutputProblem){super('Invalid grammar answer');this.reason=reason;}
}
function invalidAnswer(reason:GrammarOutputProblem):never{throw new GrammarQuestionOutputError(reason);}
function validateAnswerShape(schema:Schema,value:unknown):void{
 try{validateSchema(schema,value);}catch{
  // Strict provider schemas do not enforce our local length constraints.
  const result=value&&typeof value==='object'&&'result' in value?value.result:null;
  if(result&&typeof result==='object'){
   for(const [key,limit] of [['answer',GRAMMAR_ANSWER_LIMIT],['anchor',500],['evidence',500],['variation',500]] as const){
    const field=Object.hasOwn(result,key)?(result as Record<string,unknown>)[key]:undefined;
    if(typeof field==='string'&&field.length>limit)invalidAnswer('grammar_answer_length');
   }
  }
  invalidAnswer('grammar_answer_format');
 }
}

/** A tutor may name just the relevant word of a long highlighted clause. A
 * short citation must be visible, exact, and inside both the same selection
 * occurrence and its source evidence. An incidental shared word is insufficient. */
function visibleSelectionCitation(visible:string,anchor:string,anchorOffsets:number[],evidence:string,evidenceStarts:number[],context:GrammarQuestionContext):string|undefined{
 const {sourceLanguage}=context.input,{construction}=context.analysis;
 const tokens=[...new Intl.Segmenter(sourceLanguage,{granularity:'word'}).segment(anchor)].filter(token=>token.isWordLike);
 if(tokens.length<2)return;
 const candidates=quotedWords(visible);
 // Plain prose sometimes leaves the leading grammatical marker unquoted.
 // Avoid treating an incidental pair such as "of the" as a citation.
 if(/^(?:who|whom|whose|which|that|had|have|has|would|could|should|might)$/iu.test(tokens[0].segment)){
  for(let last=Math.min(3,tokens.length)-1;last>=0;last--){
   candidates.push(anchor.slice(tokens[0].index,tokens[last].index+tokens[last].segment.length));
  }
 }
 const normalized=normalize(visible);
 for(const candidate of new Set(candidates)){
  if(!/\p{L}/u.test(candidate)||!hasWholePassage(normalized,normalize(candidate),sourceLanguage))continue;
  const positions=wholePassageStarts(anchor,candidate,sourceLanguage);
  for(const position of positions){
   for(const offset of anchorOffsets){
    const absolute=construction.targetStart+offset+position;
    if(evidenceStarts.some(start=>start<=absolute&&absolute+candidate.length<=start+evidence.length))return candidate;
   }
  }
 }
}

export function validateLanguageTutorOutput(value:unknown):LanguageTutorResult{
 validateAnswerShape(languageTutorOutputSchema,value);
 const {result}=value as {result:LanguageTutorResult};
 if(result.kind==='answer' && !isLanguageChatText(result.answer))invalidAnswer('grammar_answer_format');
 return result;
}

export function validateGrammarQuestionOutput(value:unknown,context:GrammarQuestionContext,question?:string):GrammarQuestionResult{
 validateAnswerShape(grammarQuestionOutputSchema,value);
 const {result}=value as {result:GrammarQuestionResult};
 if(result.kind!=='answer')return {kind:result.kind};
 const {sentence,sourceLanguage,explanationLanguage}=context.input,{construction}=context.analysis;
 const {anchor,evidence,answer}=result;
 if(!plain(answer)||!plain(anchor)||!plain(evidence)||redirects(answer)||anchor.trim()!==anchor||evidence.trim()!==evidence)invalidAnswer('grammar_answer_format');
 if(!/\p{L}/u.test(anchor)||!hasWholePassage(sentence,anchor,sourceLanguage))invalidAnswer('grammar_anchor');
 const starts=wholePassageStarts(sentence,evidence,sourceLanguage);
 if(!starts.length)invalidAnswer('grammar_evidence');
 const selected=anchor===construction.text;
 const withinSelection=wholePassageStarts(construction.text,anchor,sourceLanguage);
 if(!question&&!withinSelection.length)invalidAnswer('grammar_anchor');
 const anchored=hasWholePassage(evidence,anchor,sourceLanguage);
 // If the reader asks about the highlighted form, bind repeated words to the
 // actual highlighted occurrence. A question may explicitly shift to another word.
 const coversSelection=withinSelection.some(offset=>starts.some(start=>
  start<=construction.targetStart+offset&&construction.targetStart+offset+anchor.length<=start+evidence.length));
 let focus=anchor;
 const named=hasWholePassage(normalize(answer),normalize(anchor),sourceLanguage);
 if(withinSelection.length && (!named || selected&&!coversSelection)){
  const citation=visibleSelectionCitation(answer,anchor,withinSelection,evidence,starts,context);
  if(!citation)invalidAnswer(coversSelection?'grammar_anchor':'grammar_evidence');
  focus=citation;
 }else{
  if(!anchored || (!question&&!coversSelection))invalidAnswer('grammar_evidence');
  if(!named)invalidAnswer('grammar_anchor');
 }
 if(question){
  const explicit=quotedWords(question).filter(word=>hasWholePassage(normalize(sentence),normalize(word),sourceLanguage));
  if(explicit.length && !explicit.some(word=>hasWholePassage(normalize(evidence),normalize(word),sourceLanguage)))invalidAnswer('grammar_evidence');
 }
 const explanation=normalize(answer).replaceAll(normalize(focus),'').trim();
 if(explanation.replace(/[^\p{L}]/gu,'').length<3 || (explanationLanguage==='ru' && !/\p{Script=Cyrillic}/u.test(explanation)) ||
  (explanationLanguage==='en' && !/\p{Script=Latin}/u.test(explanation)) || sentence.includes(answer.trim()))invalidAnswer('grammar_answer_format');
 return {...result,anchor:focus};
}

const englishFunctionWords=new Set(('am is are was were be been being have has had do does did will would can could shall should may might must '+
 'a an the this that these those who whom whose which if unless when to not').split(' '));
function sameGrammaticalChange(original:string,changed:string,language:string):boolean{
 if(!/^[\p{L}\p{M} ’'’-]*$/u.test(changed))return false;
 const from=words(original),to=words(changed);
 // Strip the context shared by both versions of the selected construction.
 while(from.length && to.length && from[0]===to[0]){from.shift();to.shift();}
 while(from.length && to.length && from.at(-1)===to.at(-1)){from.pop();to.pop();}
 if(!from.length&&!to.length || Math.max(from.length,to.length)>2)return false;
 const lexical=(tokens:string[])=>language==='en'?tokens.filter(word=>!englishFunctionWords.has(word)):tokens;
 const oldWords=lexical(from),newWords=lexical(to);
 if(!oldWords.length&&!newWords.length)return true;
 if(oldWords.length!==1 || newWords.length!==1)return false;
 // A short inflection of the same lexical word is eligible. Replacing the
 // verb or noun with unrelated vocabulary would make a different example.
 const [oldWord]=oldWords,[newWord]=newWords;
 if(language!=='en'){
  // Other source languages can demonstrate a small aligned inflection as well.
  // The surrounding excerpt remains byte-for-byte unchanged in every language.
  const a=Array.from(oldWord),b=Array.from(newWord);
  let common=0;
  while(common<a.length && common<b.length && a[common]===b[common])common++;
  return common>=2 && common>=Math.min(a.length,b.length)-1 && Math.max(a.length,b.length)-common<=3;
 }
 const stem=(word:string)=>word.replace(/(?:ing|ied|ed|es|s)$/u,'').replace(/([^aeiou])\1$/u,'$1');
 const oldStem=stem(oldWord),newStem=stem(newWord);
 if(oldStem.length>=2 && oldStem===newStem)return true;
 const commonIrregulars=['go goes went gone','sit sits sitting sat','see sees saw seen','take takes took taken',
  'write writes wrote written','know knows knew known','come comes came','dream dreams dreamed dreamt'];
 return commonIrregulars.some(paradigm=>{const forms=paradigm.split(' ');return forms.includes(oldWord)&&forms.includes(newWord);});
}

function groundedVariation(context:GrammarQuestionContext,evidence:string,variation:string):boolean{
 const {input,analysis:{construction}}=context;
 if(!plain(variation) || redirects(variation) || variation===evidence)return false;
 // An exact excerpt must contain the actual selected occurrence, including
 // when the same words appear twice in the book sentence.
 for(let start=input.sentence.indexOf(evidence);start>=0;start=input.sentence.indexOf(evidence,start+1)){
  const at=construction.targetStart-start,end=construction.targetEnd-start;
  if(at<0 || end>evidence.length)continue;
  const before=evidence.slice(0,at),after=evidence.slice(end);
  if(variation.length<before.length+after.length || !variation.startsWith(before) || !variation.endsWith(after))continue;
  const replacement=variation.slice(before.length,variation.length-after.length);
  if(sameGrammaticalChange(construction.text,replacement,input.sourceLanguage))return true;
 }
 return false;
}

export function validateGrammarExampleOutput(value:unknown,context:GrammarQuestionContext):GrammarQuestionResult{
 validateAnswerShape(grammarExampleOutputSchema,value);
 const {result}=value as {result:{kind:'out_of_scope'|'insufficient_evidence'}|{kind:'answer';anchor:string;evidence:string;answer:string;variation:string}};
 if(result.kind!=='answer')return {kind:result.kind};
 const {variation,...answer}=result;
 const checked=validateGrammarQuestionOutput({result:answer},context);
 if(!groundedVariation(context,answer.evidence,variation))invalidAnswer('grammar_evidence');
 // A shortened form like "dreamed" could also be a substring of "had dreamed".
 // Require a visibly separate, exact example rather than a coincidental match.
 const quotes=[...answer.answer.matchAll(/«([^»]*)»|“([^”]*)”|"([^"]*)"/gu)].map(match=>match[1]??match[2]??match[3]);
 if(!quotes.includes(variation) || quotes.some(quote=>quote!==variation && !context.input.sentence.includes(quote) && !variation.includes(quote)))invalidAnswer('grammar_answer_format');
 return checked;
}
