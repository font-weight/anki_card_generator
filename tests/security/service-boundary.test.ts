// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openReaderStorage } from '../../packages/storage/src/index';
import { createReaderServices, SecretVault } from '../../packages/services/src/index';
import { AnkiClient, validateAnkiEndpoint } from '../../packages/services/src/anki';
import { lookupPromptData } from '../../packages/services/src/prompts';
const id='abcdefghijklmnopabcdefghijklmnop';const requestId='00000000-0000-4000-8000-000000000001';
const page={id,url:`chrome-extension://${id}/settings.html`,frameId:0};
const apps:Array<ReturnType<typeof createReaderServices>>=[];
afterEach(()=>{apps.splice(0).forEach(app=>app.close());});
async function setup(){const area=()=>{const state:Record<string,unknown>={};return{get:async(key:string|string[])=>Object.fromEntries((typeof key==='string'?[key]:key).map(k=>[k,state[k]])),set:async(data:Record<string,unknown>)=>{Object.assign(state,data);},remove:async(key:string|string[])=>{for(const k of typeof key==='string'?[key]:key)delete state[k];},setAccessLevel:vi.fn().mockResolvedValue(undefined)};};const session=area(),local=area(),fetch=vi.fn().mockRejectedValue(new Error('network forbidden in test'));const storage=await openReaderStorage({indexedDB:new IDBFactory()});const app=createReaderServices({storage,secrets:new SecretVault({session,local}),fetch,runtime:{extensionId:id,allowedPageUrls:[page.url],isRegisteredReader:sender=>sender.documentId==='registered'}});apps.push(app);return{app,fetch,session,local};}
const request=(type:string,payload:unknown={})=>({v:1,requestId,type,payload});
describe('canonical service security integration',()=>{
 it('denies nested extension frame admin requests before secret mutation',async()=>{const{app,fetch}=await setup();const r=await app.handleMessage(request('secrets.setOpenAIKey',{key:'mock-not-real'}),{...page,frameId:4});expect(r.ok).toBe(false);if(!r.ok)expect(r.error.code).toBe('PERMISSION_DENIED');expect(fetch).not.toHaveBeenCalled();});
 it('denies unregistered and registered readers privileged settings',async()=>{const{app}=await setup();for(const documentId of ['registered','unknown']){const r=await app.handleMessage(request('settings.getPublic'),{id,url:'https://example.test',documentId,tab:{id:1},frameId:0});expect(r.ok).toBe(false);}});
 it('denies optional external services without host confirmation and sends nothing',async()=>{const{app,fetch}=await setup();for(const patch of [{dictionaryEnabled:true},{cloudAudioEnabled:true}]){const r=await app.handleMessage(request('settings.update',{patch}),page);expect(r.ok).toBe(false);}expect(fetch).not.toHaveBeenCalled();});
 it('restricts both secret areas and returns only status without key contents',async()=>{const{app,session,local}=await setup();const key='mock-sentinel-not-a-real-secret';const saved=await app.handleMessage(request('secrets.setOpenAIKey',{key}),page);expect(saved.ok).toBe(true);const settings=await app.handleMessage(request('settings.getPublic'),page);expect(settings.ok).toBe(true);expect(JSON.stringify([saved,settings])).not.toContain(key);expect(session.setAccessLevel).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});expect(local.setAccessLevel).toHaveBeenCalledWith({accessLevel:'TRUSTED_CONTEXTS'});});
 it.each(['http://evil.test:8765','https://127.0.0.1:8765','http://127.0.0.1:8765@evil.test','http://127.0.0.1:8765/redirect','http://127.0.0.1:8766','http://127.0.0.1:18765'])('rejects unsafe Anki endpoint %s', endpoint=>expect(()=>validateAnkiEndpoint(endpoint)).toThrow());
 it('prompt projection excludes accidental metadata and source secrets',()=>{const input={expression:'bank',context:{sentence:'The bank.',targetStart:4,targetEnd:8},sourceLanguage:'en' as const,targetLanguage:'ru' as const,learnerLevel:'B1' as const,dialect:'en-US' as const,source:{url:'https://site.test/?token=SENTINEL'},localPath:'C:\\Private\\book.pdf',apiKey:'SENTINEL'};const data=lookupPromptData(input);expect(data).not.toContain('SENTINEL');expect(data).not.toContain('Private');expect(JSON.parse(data).context).toEqual(input.context);});
 it('isolated client routes only to 18765 with no fallback after injected network failure',async()=>{
  const fetcher=vi.fn().mockRejectedValue(new Error('synthetic offline'));const client=new AnkiClient({isolatedTestMode:true,fetch:fetcher});await expect(client.version()).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:18765/');
  for(const endpoint of ['http://127.0.0.1:8765','http://localhost:18765','http://127.0.0.1:18765/redirect'])expect(()=>new AnkiClient({isolatedTestMode:true,endpoint,fetch:fetcher})).toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('web RPC cannot enable host-only isolated test mode',async()=>{const{app,fetch}=await setup();const r=await app.handleMessage(request('settings.update',{patch:{isolatedAnkiTestMode:true}}),page);expect(r.ok).toBe(false);expect(fetch).not.toHaveBeenCalled();});

});
