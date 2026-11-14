const key='registeredReaderDocuments';
let documents=new Set<string>();
export async function restoreReaderAccess(){const stored=await chrome.storage.session.get(key);documents=new Set(Array.isArray(stored[key])?stored[key].filter((v:unknown)=>typeof v==='string'):[]);}
export function isRegisteredReader(sender:{id?:string;documentId?:string;url?:string}):boolean{return sender.id===chrome.runtime.id&&!!sender.documentId&&documents.has(sender.documentId)&&!!sender.url&&/^https?:\/\//.test(sender.url);}
export async function activateReader(tabId:number){
 if(!Number.isSafeInteger(tabId)||tabId<0)throw Error('Некорректная вкладка.');
 const tab=await chrome.tabs.get(tabId);if(!tab.url||!/^https?:\/\//.test(tab.url))throw Error('Эта страница недоступна для расширения.');
 const results=await chrome.scripting.executeScript({target:{tabId,allFrames:false},files:['content.js']});
 for(const result of results)if(result.documentId)documents.add(result.documentId);
 if(documents.size>500)documents=new Set([...documents].slice(-500));
 await chrome.storage.session.set({[key]:[...documents]});return {ok:true};
}
