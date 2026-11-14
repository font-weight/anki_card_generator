import { extractBounded } from './archive';
self.onmessage=(event:MessageEvent<ArrayBuffer>)=>{
  try { const files=extractBounded(new Uint8Array(event.data));self.postMessage({ok:true,files}, {transfer:Object.values(files).map(x=>x.buffer as ArrayBuffer)}); }
  catch(error){ self.postMessage({ok:false,error:error instanceof Error?error.message:'Не удалось распаковать EPUB'}); }
};
