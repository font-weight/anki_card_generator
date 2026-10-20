export type ConfirmationKind = 'dictionary'|'cloud_audio'|'initialize_models'|'add_duplicate'|'paid_provider_test'|'create_deck';
const labels: Record<ConfirmationKind,string>={dictionary:'Разрешить отправлять выбранное слово в dictionaryapi.dev для транскрипции?',cloud_audio:'Разрешить платную генерацию аудио через OpenAI по вашему действию?',initialize_models:'Создать собственные типы заметок EnglishReader в Anki? Существующие несовместимые типы не будут изменены.',add_duplicate:'Добавить новую заметку, несмотря на найденный возможный дубликат?',paid_provider_test:'Запустить платный тест OpenAI? Расход будет списан с API-аккаунта, отдельно от подписки ChatGPT.',create_deck:'Создать указанную новую колоду в Anki?'};
type Pending={kind:ConfirmationKind;detail:string;resolve:(v:boolean)=>void;windowId?:number;expires:ReturnType<typeof setTimeout>};
const pending=new Map<string,Pending>();
export async function askConfirmation(kind:ConfirmationKind,detail=''):Promise<boolean>{
 const nonce=crypto.randomUUID();
 return new Promise(resolve=>{
  const expires=setTimeout(()=>finish(nonce,false),35000);
  pending.set(nonce,{kind,detail:detail.slice(0,300),resolve,expires});
  chrome.windows.create({url:chrome.runtime.getURL('confirm.html')+'#'+nonce,type:'popup',width:500,height:340}).then(w=>{const p=pending.get(nonce);if(p)p.windowId=w?.id;}).catch(()=>finish(nonce,false));
 });
}
function finish(nonce:string,accepted:boolean){const p=pending.get(nonce);if(!p)return;pending.delete(nonce);clearTimeout(p.expires);p.resolve(accepted);if(p.windowId!==undefined)void chrome.windows.remove(p.windowId).catch(()=>{});}
export function handleConfirmation(message:unknown,sender:chrome.runtime.MessageSender):unknown|undefined{
 if(!message||typeof message!=='object')return;
 const m=message as Record<string,unknown>;
 if(m.hostType!=='confirmation.read'&&m.hostType!=='confirmation.answer')return;
 if(sender.id!==chrome.runtime.id||!sender.url)return {error:'PERMISSION_DENIED'};
 let u:URL;try{u=new URL(sender.url);}catch{return {error:'PERMISSION_DENIED'};}if((u.protocol!=='chrome-extension:'||u.hostname!==chrome.runtime.id)||u.pathname!=='/confirm.html'||(sender.frameId!==undefined&&sender.frameId!==0))return {error:'PERMISSION_DENIED'};
 const nonce=typeof m.nonce==='string'?m.nonce:'';const p=pending.get(nonce);
 if(!p||u.hash!=='#'+nonce)return {error:'EXPIRED'};
 if(m.hostType==='confirmation.read')return {label:labels[p.kind]+(p.detail?"\n"+p.detail:""),kind:p.kind};
 if(typeof m.accepted!=='boolean')return {error:'INVALID_INPUT'};
 finish(nonce,m.accepted);return {ok:true};
}
