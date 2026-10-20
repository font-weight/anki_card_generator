import {isolatedAnkiTestMode,storageOptions} from './storage-config';
import {createReaderServices,SecretVault} from '@english-reader/services';
import {openReaderStorage} from '@english-reader/storage';
import {askConfirmation} from './confirmations';
import {isRegisteredReader} from './reader-access';
import {listVoices,speakLocal,playCached} from './playback';
let singleton:Promise<ReturnType<typeof createReaderServices>>|undefined;
export function getServices(){
 if(!singleton)singleton=(async()=>{
  const storage=await openReaderStorage(storageOptions);
  const secrets=new SecretVault({session:chrome.storage.session,local:chrome.storage.local});
  await secrets.init();
  return createReaderServices({storage,secrets,...(isolatedAnkiTestMode?{isolatedAnkiTestMode:true}:{}),
   runtime:{extensionId:chrome.runtime.id,allowedPageUrls:['settings','library','queue','action'].map(n=>chrome.runtime.getURL(n+'.html')),isRegisteredReader},
   confirmations:{requireConsent:async(kind,context)=>{
    // Each invocation has a distinct private pending callback; UI can only consume its nonce once.
    if(kind==='paid_provider_test')return false; // No live-cost budget/key validation harness authorized here.
    const payload=context.request.payload as Record<string,unknown>;
    const detail=kind==='create_deck'&&typeof payload.deckName==='string'?payload.deckName:kind==='add_duplicate'&&payload.draft&&typeof payload.draft==='object'?String((payload.draft as {expression?:unknown}).expression??''):'';
    return askConfirmation(kind,detail);
   }},
   playback:{listVoices,speakLocal,playMp3:async(entry)=>{const result=await playCached(entry.metadata.audioId);if(!result?.played)throw Error('Не удалось воспроизвести аудио.');}},
   onOperationUpdated:event=>{void chrome.runtime.sendMessage(event).catch(()=>{});},
   scheduleQueueWake:async timestamp=>{if(timestamp===null)await chrome.alarms.clear('reader-queue');else await chrome.alarms.create('reader-queue',{when:timestamp});},
  });
 })().catch(error=>{singleton=undefined;throw error;});
 return singleton;
}
