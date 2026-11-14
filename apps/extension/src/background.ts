import {getServices} from './runtime/services';
import {handleConfirmation} from './runtime/confirmations';
import {activateReader,restoreReaderAccess,isRegisteredReader} from './runtime/reader-access';
import {classifySender} from './runtime/sender';
const initialized=Promise.all([
 chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
 chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
]).then(restoreReaderAccess);
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.target==='offscreen')return;
 if(sender.url?.startsWith(chrome.runtime.getURL(''))&&sender.frameId!==undefined&&sender.frameId!==0){respond({v:1,requestId:message?.requestId??'',ok:false,error:{code:'PERMISSION_DENIED',message:'Вложенный документ не имеет доступа к сервису.',retryable:false}});return;}
 if(message?.type==='anki.decks'&&classifySender(sender,chrome.runtime.id)!=='trusted'){respond({v:1,requestId:message?.requestId??'',ok:false,error:{code:'PERMISSION_DENIED',message:'Список колод доступен только в настройках расширения.',retryable:false}});return;}
 const confirmation=handleConfirmation(message,sender);
 if(confirmation!==undefined){respond(confirmation);return;}
 if(message?.hostType==='settings.open'){
  initialized.then(async()=>{if(classifySender(sender,chrome.runtime.id)!=='trusted'&&!isRegisteredReader(sender))throw Error('denied');await chrome.runtime.openOptionsPage();respond({ok:true});}).catch(()=>respond({ok:false,error:'Доступ запрещён.'}));return true;
 }
 if(message?.hostType==='reader.activate'){
  if(classifySender(sender,chrome.runtime.id)!=='trusted'||!sender.url?.startsWith(chrome.runtime.getURL('action.html'))){respond({ok:false,error:'Доступ запрещён.'});return;}
  initialized.then(()=>activateReader(message.tabId)).then(respond).catch(()=>respond({ok:false,error:'Не удалось включить чтение на этой странице.'}));return true;
 }
 initialized.then(getServices).then(services=>services.handleMessage(message,sender)).then(respond).catch(()=>respond({v:1,requestId:typeof message?.requestId==='string'?message.requestId:'',ok:false,error:{code:'INTERNAL_ERROR',message:'Сервис расширения временно недоступен. Проверьте диагностику.',retryable:true}}));return true;
});
chrome.runtime.onInstalled.addListener(details=>{
 chrome.contextMenus.removeAll(()=>chrome.contextMenus.create({id:'open-reader',title:'Открыть в Language Reader',contexts:['page','link']}));
 if(details.reason==='install')void chrome.tabs.create({url:chrome.runtime.getURL('settings.html')});
});
chrome.contextMenus.onClicked.addListener(info=>{if(info.menuItemId==='open-reader')void chrome.tabs.create({url:chrome.runtime.getURL('library.html')});});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='reader-queue')void initialized.then(getServices).then(s=>s.resumeQueue()).catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>{void initialized.then(getServices).then(s=>s.resumeQueue()).catch(()=>{});});
void initialized.then(getServices).then(s=>s.resumeQueue()).catch(()=>{});
