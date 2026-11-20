// The reset is recognized only at the start of the reader's own message.
// Keep the supplied task verbatim; normalization is for matching commands only.
const resetCommand=/^\s*(?:(?:давай(?:те)?\s+)?(?:(?:начн[её]м|начни(?:те)?|начать)\s+(?:заново|с\s+чистого\s+листа)|(?:сменим|смени(?:те)?|поменяем|поменяй(?:те)?|переключимся\s+на\s+другую)\s+тему)|(?:новая|другая)\s+тема|(?:let['’]s\s+)?(?:(?:change|switch)\s+(?:the\s+)?(?:topic|subject)|start\s+(?:over|fresh|(?:a\s+)?new\s+topic))|new\s+(?:topic|subject)|neues\s+thema|nouveau\s+sujet|nuevo\s+tema)(?=\s*$|[\s,:;.!?…—–-])/iu;

export function splitLanguageTopicReset(question:string):{task:string}|undefined{
 const match=resetCommand.exec(question);
 if(!match)return undefined;
 const task=question.slice(match[0].length).replace(/^[\s,:;.!?…—–-]+/u,'').trim();
 return {task:/^(?:пожалуйста|please)[.?!…]*$/iu.test(task)?'':task};
}

// Only decide which material a lesson needs here. The tutor receives the
// original wording and chooses the depth, response language, and teaching style.
const lessonObject = /(?:^| )(?:правил(?:о|а|у|ом|е|ам|ами|ах)?|тем[ауые]|конструкци[а-я]*|оборот[а-я]*|форм[ауые]|rules?|topics?|constructions?|patterns?|forms?|tenses?|reglas?|règles?|regel|regola|reguł[ąćęłńóśźża-z]*)(?: |$)/u;
const teaching = /полн|целиком|подроб|деталь|кратк|объясн|поясн|разъясн|расскаж|разбер|обзор|формулировк|примен|использ|употреб|пример|упражнени|сравни|пошаг|дословно|\b(?:full|whole|complete|detail|explain|teach|use|apply|examples?|practice|exercises?|compare|step by step|briefly|brief|walk me through|verbatim|spell out)\b|explic|explíc|expliqu|erklär|ausführlich|spieg|wyjaśn/u;
const pointsBack = /(?:^| )(?:эт(?:о(?:т|й|му|го|м)?|а|у|и|им|их)|данн[а-я]*|предыдущ[а-я]*|ее|его|this|that|these|those|previous|same|your|mentioned|esta|este|esa|cette|ce|diese[nrms]?|questa|tę)(?: |$)/u;
const subjectName = /\b(?:(?:present|past|future) (?:perfect|simple|continuous|progressive)|(?:first|second|third|zero|mixed) conditional|relative clauses?|reported speech|indirect speech|modal verbs?|phrasal verbs?|word order|articles?|gerunds?|subjunctive)\b|(?:^| )(?:согласовани[ея]|герунди[йя]|сослагательн[а-я]+ наклонени[а-я]*|фразов[а-я]+ глагол[а-я]*|условн[а-я]+ предложени[а-я]*|порядок слов)(?: |$)/u;
const subjectIntro = /(?:^| )(?:по теме|на тему|про|насчет|касательно|о|об|по поводу|about|regarding|concerning|rules? (?:of|for)|topic of|sur (?:le|la|les)|sobre|zum thema|über|su) (.+)$/u;
const namedObject = /(?:^| )(?:тем[ауые]|правил[оа]|конструкци[юи]) (?:согласовани|склонени|спряжени|употреблени|образовани|построени|глагольн|временн|условн|артикл|причасти|падеж|герунди|предлог|местоимен)[\p{L}]*|(?:^| )(?:тему|темы) [а-я]+(?:ания|ения|ости|ции|ений|ельных|ских|ского|тельного)(?: |$)/u;
const manner = /^(?:целиком|полностью|в полном|шаг за|подробн|поподробн|максимально|кратк|проще|для начинающих|с примерами|на примерах|понятн|так чтобы|as if|in (?:full|detail)|step by step|as a beginner|in plain words|to a friend|with examples)/u;

export function lessonTopic(question: string): 'current' | 'named' | undefined {
  const words = question.normalize('NFKC').toLowerCase().replaceAll('ё','е').match(/[\p{L}\p{M}\p{N}]+/gu);
  const query = (words ?? []).join(' ');
  if (/(?:这|這)(?:个|個|条|條)?(?:语法|語法)?(?:规则|規則)|この(?:文法|ルール)/u.test(query)) return 'current';
  // A short request for greater depth has no new subject of its own.
  if (/^(?:(?:а |и |можно |пожалуйста |можешь |можете )*(?:объясни(?:те)? |расскажи(?:те)? |поясни(?:те)? )?(?:по)?подробнее|(?:(?:please |can you |could you )*)(?:explain (?:a (?:bit|little) )?more|go into (?:more )?detail|tell me more|elaborate))(?: пожалуйста| please)?$/u.test(query)) return 'current';
  const reference = pointsBack.test(query);
  const teach = teaching.test(query);
  const explainThis = /(?:объясн[а-я]*|разбер[а-я]*|поясн[а-я]*) (?:мне )?(?:это|его|ее)(?: |$)|\b(?:explain|unpack|teach|break down) (?:this|that|it)(?:$| (?:in|to|as|so|with|from|for|more) )/u.test(query);
  if (!explainThis && !(teach && lessonObject.test(query))) {
    if (teach && !reference && subjectName.test(query)) return 'named';
    return;
  }
  // A comparison can introduce a named alternative while still needing the
  // original side (“how does this rule differ from Second Conditional?”).
  if (reference && /сравни|сопостав|отлича|разниц|\b(?:compare|contrast|differs?|difference)\b/u.test(query)) return 'current';
  // A colon can supply the actual title after a demonstrative (“this topic:
  // Present Perfect”). An instruction about how to teach it still needs its referent.
  const title = /(?:тему|темы|правило|конструкцию|topic|rule|construction)\s*[:：]\s*([^:：\n]+)/iu.exec(question)?.[1]
    .normalize('NFKC').toLowerCase().trim();
  if (title && !manner.test(title) && !/^(?:с |как |когда |почему |дай |объясни|how |when |why |give |explain |with )/u.test(title)) return 'named';
  const supplied = subjectIntro.exec(query)?.[1];
  if (supplied && !pointsBack.test(supplied) && !manner.test(supplied)) return 'named';
  if (!reference && (subjectName.test(query) || namedObject.test(query))) return 'named';
  if (/[«„“‘"\x60]/u.test(question)) return 'named';
  return 'current';
}

export function asksForCardRuleQuotation(question: string): boolean {
  const q=question.normalize('NFKC').toLowerCase().replaceAll('ё','е').replace(/[.!?…,:]+/gu,' ').replace(/\s+/gu,' ').trim();
  return /^(?:(?:пожалуйста|можешь|можно) )?(?:повтори(?:те)?|процитируй(?:те)?|скопируй(?:те)?|покажи(?:те)?) (?:мне )?(?:дословно |точно )?(?:текст |формулировку )?правил[ао] (?:из (?:этой )?карточки|как (?:написано )?в карточке)(?: дословно| пожалуйста)?$/u.test(q) ||
    /^(?:(?:can|could) you |please )?(?:quote|copy|repeat|show) (?:me )?(?:the |this )?(?:exact |original )?(?:wording of the )?rule (?:from|on|as written on) (?:the |this )?card(?: verbatim| word for word| please)?$/u.test(q);
}
