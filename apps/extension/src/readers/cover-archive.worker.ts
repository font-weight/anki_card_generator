import {indexCoverArchive} from './cover-archive';

let read:ReturnType<typeof indexCoverArchive>;
self.onmessage=(event:MessageEvent<{source?:ArrayBuffer;path:string;limit:number}>)=>{
 try {
  const {source,path,limit}=event.data;
  if(source)read=indexCoverArchive(source);
  const bytes=read(path,limit);
  self.postMessage({bytes},{transfer:bytes?[bytes.buffer as ArrayBuffer]:[]});
 } catch {
  self.postMessage({error:true});
 }
};
