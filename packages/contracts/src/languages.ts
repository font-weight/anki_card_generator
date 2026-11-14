/** Deliberately finite language/locale allowlist; never accept provider or page-defined locales. */
export const LANGUAGE_CODES = ['en','ru','es','fr','de','it','pt','zh','ja','ko','ar','hi','tr','uk','pl','nl','kk'] as const;
export type LanguageCode = typeof LANGUAGE_CODES[number];
export const LEARNER_LEVELS = ['A1','A2','B1','B2','C1','C2'] as const;
export type LearnerLevel = typeof LEARNER_LEVELS[number];
export const DIALECTS = ['en-US','en-GB','ru-RU','es-ES','fr-FR','de-DE','it-IT','pt-BR','zh-CN','ja-JP','ko-KR','ar-SA','hi-IN','tr-TR','uk-UA','pl-PL','nl-NL','kk-KZ'] as const;
export type Dialect = typeof DIALECTS[number];
export type Language = {code:LanguageCode;name:string;nativeName:string;locale:Dialect;direction:'ltr'|'rtl'};
export const LANGUAGES: readonly Language[] = Object.freeze([
 {code:'en',name:'Английский',nativeName:'English',locale:'en-US',direction:'ltr'},
 {code:'ru',name:'Русский',nativeName:'Русский',locale:'ru-RU',direction:'ltr'},
 {code:'es',name:'Испанский',nativeName:'Español',locale:'es-ES',direction:'ltr'},
 {code:'fr',name:'Французский',nativeName:'Français',locale:'fr-FR',direction:'ltr'},
 {code:'de',name:'Немецкий',nativeName:'Deutsch',locale:'de-DE',direction:'ltr'},
 {code:'it',name:'Итальянский',nativeName:'Italiano',locale:'it-IT',direction:'ltr'},
 {code:'pt',name:'Португальский',nativeName:'Português',locale:'pt-BR',direction:'ltr'},
 {code:'zh',name:'Китайский',nativeName:'中文',locale:'zh-CN',direction:'ltr'},
 {code:'ja',name:'Японский',nativeName:'日本語',locale:'ja-JP',direction:'ltr'},
 {code:'ko',name:'Корейский',nativeName:'한국어',locale:'ko-KR',direction:'ltr'},
 {code:'ar',name:'Арабский',nativeName:'العربية',locale:'ar-SA',direction:'rtl'},
 {code:'hi',name:'Хинди',nativeName:'हिन्दी',locale:'hi-IN',direction:'ltr'},
 {code:'tr',name:'Турецкий',nativeName:'Türkçe',locale:'tr-TR',direction:'ltr'},
 {code:'uk',name:'Украинский',nativeName:'Українська',locale:'uk-UA',direction:'ltr'},
 {code:'pl',name:'Польский',nativeName:'Polski',locale:'pl-PL',direction:'ltr'},
 {code:'nl',name:'Нидерландский',nativeName:'Nederlands',locale:'nl-NL',direction:'ltr'},
 {code:'kk',name:'Казахский',nativeName:'Қазақша',locale:'kk-KZ',direction:'ltr'},
].map(language=>Object.freeze(language)) as Language[]);
export const isLanguageCode=(value:unknown):value is LanguageCode=>typeof value==='string'&&(LANGUAGE_CODES as readonly string[]).includes(value);
export const isLearnerLevel=(value:unknown):value is LearnerLevel=>typeof value==='string'&&(LEARNER_LEVELS as readonly string[]).includes(value);
export const isDialect=(value:unknown):value is Dialect=>typeof value==='string'&&(DIALECTS as readonly string[]).includes(value);
export function getLanguage(code:LanguageCode):Language {const language=LANGUAGES.find(item=>item.code===code);if(!language)throw new Error('Unsupported language');return language;}
export const defaultLocale=(code:LanguageCode):Dialect=>getLanguage(code).locale;
export const localeMatchesLanguage=(locale:unknown,code:LanguageCode):locale is Dialect=>isDialect(locale)&&locale.split('-')[0]===code;
