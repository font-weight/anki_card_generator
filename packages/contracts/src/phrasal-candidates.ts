import { segmentSourceWords, sourceGraphemeBoundaries } from './words.ts';

/** Exact source spans, never a lemma substituted into the reader's text. */
export type PhrasalCandidate = { id:string; expression:string; targetStart:number; targetEnd:number; lemma:string };
export type ResolvedLookupTarget = { candidateId:string|null; targetStart:number; targetEnd:number };
type TargetContext = { sentence:string; targetStart:number; targetEnd:number };
export const PHRASAL_CANDIDATES_VERSION = 'contiguous-phrasal-v1';
export const MAX_PHRASAL_CANDIDATES = 8;

// A deliberately bounded, local lexicon. It proposes possibilities, not meanings:
// the SAME contextual lookup decides whether a candidate is actually a verb.
// Explicit forms avoid destructive stemming (e.g. "clouds" as a noun).
const families:readonly [string, string, string][] = [
 ['cloud','cloud clouds clouded clouding','over'],
 ['go','go goes going went gone','by|on|off|out|away|back|over|through|ahead|up|down|along with'],
 ['come','come comes coming came','back|in|out|over|up|down|across|along|up with'],
 ['get','get gets getting got gotten','up|down|in|out|on|off|over|away|back|through|along|around|away with'],
 ['give','give gives giving gave given','up|in|out|away|back'],
 ['take','take takes taking took taken','off|out|up|over|back|away|in|on|after'],
 ['put','put puts putting','on|off|out|away|up|down|back|up with'],
 ['turn','turn turns turning turned','on|off|up|down|out|around|back|in|into'],
 ['look','look looks looking looked','up|out|after|for|into|over|around|forward to|up to|down on'],
 ['bring','bring brings bringing brought','up|out|in|back|about|down'],
 ['break','break breaks breaking broke broken','down|up|out|in|off|through'],
 ['run','run runs running ran','out|away|into|over|out of'],
 ['set','set sets setting','up|off|out|aside|back'],
 ['pick','pick picks picking picked','up|out'],
 ['call','call calls calling called','off|back|up|on'],
 ['carry','carry carries carrying carried','on|out'],
 ['work','work works working worked','out|on'],
 ['find','find finds finding found','out'],
 ['make','make makes making made','up|out'],
 ['keep','keep keeps keeping kept','on|up|out|away|up with'],
 ['hold','hold holds holding held','on|up|back|out'],
 ['fall','fall falls falling fell fallen','down|over|apart|behind|for|out'],
 ['stand','stand stands standing stood','up|out|by|for'],
 ['sit','sit sits sitting sat','down|up'],
 ['show','show shows showing showed shown','up|off'],
 ['grow','grow grows growing grew grown','up'],
 ['wake','wake wakes waking woke woken','up'],
 ['leave','leave leaves leaving left','out|behind'],
 ['move','move moves moving moved','on|in|out'],
 ['pass','pass passes passing passed','away|out|by'],
 ['pay','pay pays paying paid','back|off'],
 ['try','try tries trying tried','on|out'],
 ['fill','fill fills filling filled','in|out|up'],
 ['end','end ends ending ended','up'],
 ['figure','figure figures figuring figured','out'],
 ['point','point points pointing pointed','out'],
 ['sort','sort sorts sorting sorted','out'],
 ['shut','shut shuts shutting','down|up'],
 ['cut','cut cuts cutting','off|out|down|back'],
 ['die','die dies dying died','out|down'],
];
const forms = new Map<string,{verb:string;particles:string[][]}>();
for (const [verb, inflections, particles] of families) {
 for (const form of inflections.split(' ')) forms.set(form,{verb,particles:particles.split('|').map(value=>value.split(' '))});
}
const adjacent = (sentence:string, end:number, start:number) => /^[ \t\u00a0]{1,8}$/u.test(sentence.slice(end,start));

/** Only an exact hovered token is eligible. Manual selections must not call this. */
export function enumeratePhrasalCandidates(context:TargetContext):PhrasalCandidate[] {
 const {sentence,targetStart,targetEnd}=context;
 if(typeof sentence!=='string'||sentence.length>1500||!Number.isInteger(targetStart)||!Number.isInteger(targetEnd)||targetStart<0||targetEnd<=targetStart||targetEnd>sentence.length)return [];
 const words=segmentSourceWords(sentence,'en');
 const boundaries=sourceGraphemeBoundaries(sentence,'en');
 if(!words||!boundaries?.has(targetStart)||!boundaries.has(targetEnd))return [];
 const hovered=words.findIndex(word=>word.start===targetStart&&word.end===targetEnd);
 if(hovered<0)return [];
 const candidates:PhrasalCandidate[]=[];
 // At most two particles and three nearby starting positions. Never bridge an
 // intervening object: "turn it off" cannot produce an invented "turn off" span.
 for(let index=Math.max(0,hovered-2);index<=hovered;index++){
  const first=words[index]!,family=forms.get(first.text.toLowerCase());
  if(!family)continue;
  for(const particles of family.particles){
   const lastIndex=index+particles.length,last=words[lastIndex];
   if(!last||hovered>lastIndex)continue;
   if(!particles.every((particle,offset)=>{
    const previous=words[index+offset]!,word=words[index+offset+1]!;
    return word.text.toLowerCase()===particle&&adjacent(sentence,previous.end,word.start);
   }))continue;
   const previous=words[index-1],prior=words[index-2];
   const nounDeterminer=/^(?:a|an|the|this|that|these|those|some|any|each|every|my|your|his|her|its|our|their)$/i;
   // Obvious noun/literal negatives are excluded locally as well as in the prompt.
   if(family.verb==='cloud'&&/^(?:cloud|clouds)$/i.test(first.text)&&previous&&adjacent(sentence,previous.end,first.start)&&
    (nounDeterminer.test(previous.text)||(/^(?:dark|black|white|thick|heavy|ominous|low|storm)$/i.test(previous.text)&&prior&&nounDeterminer.test(prior.text)&&adjacent(sentence,prior.end,previous.start))))continue;
   if(family.verb==='go'&&particles.join(' ')==='by'){
    const next=words[lastIndex+1],following=words[lastIndex+2];
    if(next&&adjacent(sentence,last.end,next.start)&&(/^(?:bus|train|car|plane|air|boat|ship|taxi|cab|bike|bicycle|motorcycle|coach|tram|metro|subway|rail|road|sea)$/i.test(next.text)||
     (/^(?:a|an|the)$/i.test(next.text)&&following&&adjacent(sentence,next.end,following.start)&&/^(?:bus|train|car|plane|boat|ship|taxi|cab|bike|bicycle|coach|tram)$/i.test(following.text))))continue;
   }
   const lemma=`${family.verb} ${particles.join(' ')}`;
   candidates.push({id:`pv1:${first.start}:${last.end}:${lemma.replaceAll(' ','_')}`,expression:sentence.slice(first.start,last.end),targetStart:first.start,targetEnd:last.end,lemma});
  }
 }
 return candidates.sort((a,b)=>a.targetStart-b.targetStart||b.targetEnd-a.targetEnd||a.lemma.localeCompare(b.lemma)).slice(0,MAX_PHRASAL_CANDIDATES);
}

/** Canonical re-enumeration, not trust in page-supplied offsets, lemma or IDs. */
export function validPhrasalCandidates(value:unknown,context:TargetContext,sourceLanguage:string):value is PhrasalCandidate[] {
 if(sourceLanguage!=='en'||!Array.isArray(value)||value.length<1||value.length>MAX_PHRASAL_CANDIDATES)return false;
 const expected=enumeratePhrasalCandidates(context);
 return value.length===expected.length&&value.every((entry,index)=>{
  const candidate=expected[index]!;
  return entry&&typeof entry==='object'&&!Array.isArray(entry)&&(Object.getPrototypeOf(entry)===Object.prototype||Object.getPrototypeOf(entry)===null)&&Object.keys(entry).length===5&&
   Object.keys(candidate).every(key=>Object.hasOwn(entry,key)&&entry[key]===candidate[key as keyof PhrasalCandidate]);
 });
}
