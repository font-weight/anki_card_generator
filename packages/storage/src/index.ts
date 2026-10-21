import type {LookupData,LookupPayload,Meta,OperationState,AudioMetadata} from '../../contracts/src/index.ts';
import {ServiceError,storageError} from '../../services/src/errors.ts';
export const DATABASE_NAME='english-reader';
export const DATABASE_VERSION=1;
export const ISOLATED_TEST_DATABASE_NAME='english-reader-isolated-anki-test-v1';
export const CACHE_LIMIT_BYTES=104857600;
export type LookupCacheEntry={key:string;lookupId:string;request:LookupPayload;data:LookupData;meta?:Meta;pronunciationProvenance?:{variants:unknown[];fetchedAt:string};byteLength:number;createdAt:string;lastAccessedAt:string};
export type AudioEntry={audioId:string;cacheKey:string;blob:Blob;metadata:AudioMetadata;byteLength:number;createdAt:string;lastAccessedAt:string};
export type StoredOperation={operationId:string;state:OperationState;audioId?:string|null;audioCacheKey?:string|null;revision:number;fingerprint:string;createdAt:string;nextAttemptAt?:string|null;[key:string]:unknown};
export type BookMetadata={documentId:string;kind:'pdf'|'epub'|'fb2';title:string;mimeType:string;byteLength:number;createdAt:string;updatedAt:string};
export type ReadingProgress={documentId:string;kind:'pdf';page:number;offset:number;updatedAt:string}|{documentId:string;kind:'epub'|'fb2';chapter:string|null;cfi:string;updatedAt:string};
type Estimate={usage?:number;quota?:number};
export type StorageOptions={indexedDB?:IDBFactory;name?:string;quotaEstimator?:()=>Promise<Estimate>;now?:()=>number};
const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
function checkedId(id:string){if(typeof id!=='string'||!id.length||id.length>128)throw new ServiceError('INVALID_INPUT');}
function txDone(tx:IDBTransaction):Promise<void>{return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(storageError(tx.error));tx.onerror=()=>{};});}
function request<T>(req:IDBRequest<T>):Promise<T>{return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(storageError(req.error));});}
export async function openReaderStorage(options:StorageOptions={}):Promise<ReaderStorage>{
 const factory=options.indexedDB??globalThis.indexedDB;if(!factory)throw new ServiceError('STORAGE_UNAVAILABLE');
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{
  const req=factory.open(options.name??DATABASE_NAME,DATABASE_VERSION);let settled=false;
  req.onupgradeneeded=()=>{const d=req.result;const t=req.transaction!;
   for(const [name,key] of [['lookupCache','key'],['audioCache','audioId'],['outbox','operationId'],['libraryBooks','documentId'],['readingProgress','documentId'],['metadata','key']] as const){if(!d.objectStoreNames.contains(name))d.createObjectStore(name,{keyPath:key});}
   const lookup=t.objectStore('lookupCache');if(!lookup.indexNames.contains('lookupId'))lookup.createIndex('lookupId','lookupId',{unique:false});
   const audio=t.objectStore('audioCache');if(!audio.indexNames.contains('cacheKey'))audio.createIndex('cacheKey','cacheKey',{unique:true});
   const outbox=t.objectStore('outbox');for(const name of ['state','createdAt','nextAttemptAt'])if(!outbox.indexNames.contains(name))outbox.createIndex(name,name,{unique:false});
  };
  req.onsuccess=()=>{if(settled){req.result.close();return;}settled=true;resolve(req.result);};
  req.onerror=()=>{settled=true;reject(storageError(req.error));};
  req.onblocked=()=>{settled=true;reject(new ServiceError('STORAGE_UNAVAILABLE','Storage upgrade blocked by another extension page.'));};
 });
 db.onversionchange=()=>db.close();return new ReaderStorage(db,options);
}
export class ReaderStorage{
 private db:IDBDatabase;private options:StorageOptions;private now:()=>number;
 get databaseName():string{return this.db.name;}
 constructor(db:IDBDatabase,options:StorageOptions={}){this.db=db;this.options=options;this.now=options.now??Date.now;}
 private iso(){return new Date(this.now()).toISOString();}
 private async read<T>(store:string,key:IDBValidKey):Promise<T|null>{try{const tx=this.db.transaction(store,'readonly');return (await request(tx.objectStore(store).get(key)))??null;}catch(e){throw storageError(e);}}
 private async all<T>(store:string):Promise<T[]>{try{const tx=this.db.transaction(store,'readonly');return await request(tx.objectStore(store).getAll());}catch(e){throw storageError(e);}}
 private async write(store:string,value:unknown){try{const tx=this.db.transaction(store,'readwrite');const done=txDone(tx);tx.objectStore(store).put(value);await done;}catch(e){throw storageError(e);}}
 async getLookup(key:string):Promise<LookupCacheEntry|null>{const value=await this.read<LookupCacheEntry>('lookupCache',key);if(value){value.lastAccessedAt=this.iso();await this.write('lookupCache',value);}return value;}
 async findLookup(lookupId:string):Promise<LookupCacheEntry|null>{try{const tx=this.db.transaction('lookupCache','readonly');const value=await request(tx.objectStore('lookupCache').index('lookupId').get(lookupId)) as LookupCacheEntry|undefined;if(value){value.lastAccessedAt=this.iso();await this.write('lookupCache',value);}return value??null;}catch(e){throw storageError(e);}}
 async putLookup(entry:LookupCacheEntry){const copy=structuredClone(entry);copy.byteLength=bytes({...copy,byteLength:0});await this.cacheWrite('lookupCache',copy);}
 async getAudio(audioId:string):Promise<AudioEntry|null>{const value=await this.read<AudioEntry>('audioCache',audioId);if(value){value.lastAccessedAt=this.iso();await this.write('audioCache',value);}return value;}
 async findAudio(cacheKey:string):Promise<AudioEntry|null>{try{const tx=this.db.transaction('audioCache','readonly');const value=await request(tx.objectStore('audioCache').index('cacheKey').get(cacheKey)) as AudioEntry|undefined;if(value){value.lastAccessedAt=this.iso();await this.write('audioCache',value);}return value??null;}catch(e){throw storageError(e);}}
 async putAudio(entry:AudioEntry){if(!(entry.blob instanceof Blob)||entry.blob.size<1||entry.blob.size>10485760)throw new ServiceError('INVALID_INPUT');await this.cacheWrite('audioCache',{...entry,byteLength:entry.blob.size});}
 private async cacheWrite(store:'lookupCache'|'audioCache',entry:LookupCacheEntry|AudioEntry){
  try{const tx=this.db.transaction(['lookupCache','audioCache','outbox'],'readwrite');const done=txDone(tx);
   const reads=await Promise.all([request(tx.objectStore('lookupCache').getAll()) as Promise<LookupCacheEntry[]>,request(tx.objectStore('audioCache').getAll()) as Promise<AudioEntry[]>,request(tx.objectStore('outbox').getAll()) as Promise<StoredOperation[]>]);
   const [lookups,audios,operations]=reads;const protectedOperations=operations.filter(o=>o.state!=='cancelled'&&o.state!=='synced');const pins=new Set(protectedOperations.map(o=>o.audioId).filter(Boolean));const pinnedKeys=new Set(protectedOperations.map(o=>o.audioCacheKey).filter(Boolean));
   const candidates=[...lookups.map(e=>({store:'lookupCache',key:e.key,entry:e})),...audios.map(e=>({store:'audioCache',key:e.audioId,entry:e}))].filter(e=>!(e.store===store&&e.key===(store==='lookupCache'?(entry as LookupCacheEntry).key:(entry as AudioEntry).audioId)));
   let total=candidates.reduce((sum,e)=>sum+e.entry.byteLength,0)+entry.byteLength;
   for(const e of [...candidates].sort((a,b)=>a.entry.lastAccessedAt.localeCompare(b.entry.lastAccessedAt))){if(total<=CACHE_LIMIT_BYTES)break;if(e.store==='audioCache'&&(pins.has(e.key)||pinnedKeys.has((e.entry as AudioEntry).cacheKey)))continue;tx.objectStore(e.store).delete(e.key);total-=e.entry.byteLength;}
   if(total>CACHE_LIMIT_BYTES){tx.abort();await done.catch(()=>{});throw new ServiceError('STORAGE_QUOTA');}
   tx.objectStore(store).put(entry);await done;
  }catch(e){throw storageError(e);}
 }
 async getOperation<T extends StoredOperation=StoredOperation>(id:string):Promise<T|null>{return this.read<T>('outbox',id);}
 async putOperation(record:StoredOperation){await this.write('outbox',record);}
 async createOperation<T extends StoredOperation>(record:T):Promise<{created:boolean;record:T}>{
  try{const tx=this.db.transaction('outbox','readwrite');const done=txDone(tx);const store=tx.objectStore('outbox');const old=await request(store.get(record.operationId)) as T|undefined;
   if(old&&old.fingerprint!==record.fingerprint){tx.abort();await done.catch(()=>{});throw new ServiceError('OPERATION_CONFLICT');}
   if(!old)store.add(record);await done;return{created:!old,record:old??record};
  }catch(e){throw storageError(e);}
 }
 async compareAndSwap<T extends StoredOperation>(id:string,revision:number,next:T):Promise<boolean>{
  try{const tx=this.db.transaction('outbox','readwrite');const done=txDone(tx);const store=tx.objectStore('outbox');const old=await request(store.get(id)) as T|undefined;
   if(!old||old.revision!==revision){await done;return false;}
   if(next.operationId!==id||next.fingerprint!==old.fingerprint||next.revision!==revision+1){tx.abort();await done.catch(()=>{});throw new ServiceError('OPERATION_CONFLICT');}
   store.put(next);await done;return true;
  }catch(e){throw storageError(e);}
 }
 async mutateOperation<T extends StoredOperation>(id:string,mutator:(record:T)=>T):Promise<T>{
  try{const tx=this.db.transaction('outbox','readwrite');const done=txDone(tx);const store=tx.objectStore('outbox');const old=await request(store.get(id)) as T|undefined;if(!old){tx.abort();await done.catch(()=>{});throw new ServiceError('INVALID_INPUT');}
   let next:T;try{next=mutator(structuredClone(old));}catch(e){tx.abort();await done.catch(()=>{});throw e;}
   if(next.operationId!==id||next.fingerprint!==old.fingerprint){tx.abort();await done.catch(()=>{});throw new ServiceError('OPERATION_CONFLICT');}store.put(next);await done;return next;
  }catch(e){throw storageError(e);}
 }
 async allOperations<T extends StoredOperation=StoredOperation>():Promise<T[]>{return this.all<T>('outbox');}
 async listOperations<T extends StoredOperation=StoredOperation>(options:{states?:OperationState[];limit?:number;cursor?:string}={}):Promise<{items:T[];nextCursor:string|null}>{
  const limit=options.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ServiceError('INVALID_INPUT');
  let rows=(await this.all<T>('outbox')).filter(o=>!options.states||options.states.includes(o.state)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.operationId.localeCompare(b.operationId));
  if(options.cursor){const i=rows.findIndex(x=>x.operationId===options.cursor);if(i<0)throw new ServiceError('INVALID_INPUT');rows=rows.slice(i+1);}return{items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1]!.operationId:null};
 }
 async saveBook(input:{blob:Blob;kind:'pdf'|'epub'|'fb2';title:string;mimeType:string}):Promise<BookMetadata>{
  if(!(input.blob instanceof Blob)||!['pdf','epub','fb2'].includes(input.kind)||typeof input.title!=='string'||input.title.length>500||input.blob.size<1||input.blob.size>250*1024*1024||input.mimeType!==(input.kind==='pdf'?'application/pdf':input.kind==='fb2'?'application/x-fictionbook+xml':'application/epub+zip'))throw new ServiceError('INVALID_INPUT');
  const digest=await crypto.subtle.digest('SHA-256',await input.blob.arrayBuffer());const documentId='sha256:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const existing=await this.getBook(documentId);if(existing){if(existing.metadata.kind!==input.kind||existing.metadata.mimeType!==input.mimeType)throw new ServiceError('OPERATION_CONFLICT');return existing.metadata;}
  await this.checkQuota(input.blob.size);const metadata:BookMetadata={documentId,kind:input.kind,title:input.title,mimeType:input.mimeType,byteLength:input.blob.size,createdAt:this.iso(),updatedAt:this.iso()};await this.write('libraryBooks',{documentId,metadata,blob:input.blob});return metadata;
 }
 async getBook(id:string):Promise<{metadata:BookMetadata;blob:Blob}|null>{checkedId(id);const b=await this.read<{documentId:string;metadata:BookMetadata;blob:Blob}>('libraryBooks',id);return b?{metadata:b.metadata,blob:b.blob}:null;}
 async listBooks():Promise<BookMetadata[]>{return (await this.all<{metadata:BookMetadata}>('libraryBooks')).map(b=>b.metadata);}
 async deleteBook(id:string){checkedId(id);try{const tx=this.db.transaction(['libraryBooks','readingProgress'],'readwrite');const done=txDone(tx);tx.objectStore('libraryBooks').delete(id);tx.objectStore('readingProgress').delete(id);await done;}catch(e){throw storageError(e);}}
 async saveProgress(progress:ReadingProgress){
  checkedId(progress.documentId);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(progress.updatedAt)||!Number.isFinite(Date.parse(progress.updatedAt)))throw new ServiceError('INVALID_INPUT');
  const book=await this.getBook(progress.documentId);if(!book||book.metadata.kind!==progress.kind)throw new ServiceError('INVALID_INPUT');
  if(progress.kind==='pdf'&&(!Number.isSafeInteger(progress.page)||progress.page<1||!Number.isFinite(progress.offset)||progress.offset<0||progress.offset>1)||(progress.kind==='epub'||progress.kind==='fb2')&&(typeof progress.cfi!=='string'||!progress.cfi.length||progress.cfi.length>2048||progress.chapter!==null&&(typeof progress.chapter!=='string'||progress.chapter.length>500)))throw new ServiceError('INVALID_INPUT');
  const allowed=progress.kind==='pdf'?['documentId','kind','page','offset','updatedAt']:['documentId','kind','chapter','cfi','updatedAt'];if(Object.keys(progress).some(k=>!allowed.includes(k)))throw new ServiceError('INVALID_INPUT');await this.write('readingProgress',progress);
 }
 async getProgress(id:string):Promise<ReadingProgress|null>{checkedId(id);return this.read('readingProgress',id);}
 async getMetadata<T>(key:string):Promise<T|null>{const record=await this.read<{key:string;value:T}>('metadata',key);return record?.value??null;}
 async setMetadata(key:string,value:unknown){if(/key|secret|token|password/i.test(key))throw new ServiceError('INVALID_INPUT');await this.write('metadata',{key,value});}
 async pruneCaches():Promise<{removedBytes:number}>{
  const before=(await this.estimateStorage()).cacheBytes;
  // Reuse transactional eviction; zero-size sentinel is removed immediately afterward.
  const sentinel:LookupCacheEntry={key:'__prune__',lookupId:'',request:{} as LookupPayload,data:{} as LookupData,byteLength:0,createdAt:this.iso(),lastAccessedAt:this.iso()};
  await this.cacheWrite('lookupCache',sentinel);const tx=this.db.transaction('lookupCache','readwrite');const done=txDone(tx);tx.objectStore('lookupCache').delete('__prune__');await done;return{removedBytes:Math.max(0,before-(await this.estimateStorage()).cacheBytes)};
 }
 async estimateStorage():Promise<{usage:number|null;quota:number|null;cacheBytes:number}>{let estimate:Estimate={};try{estimate=await (this.options.quotaEstimator?.()??globalThis.navigator?.storage?.estimate?.()??Promise.resolve({}));}catch{}const [l,a]=await Promise.all([this.all<LookupCacheEntry>('lookupCache'),this.all<AudioEntry>('audioCache')]);return{usage:estimate.usage??null,quota:estimate.quota??null,cacheBytes:[...l,...a].reduce((sum,x)=>sum+x.byteLength,0)};}
 private async checkQuota(add:number){const e=await this.estimateStorage();if(e.quota!==null&&e.usage!==null&&e.usage+add>e.quota)throw new ServiceError('STORAGE_QUOTA');}
 close(){this.db.close();}
}
