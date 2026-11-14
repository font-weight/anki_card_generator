import {PDFWorker} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
/** MV3 requires worker-src 'self'. Passing an explicit port avoids PDF.js's
 * opaque chrome-extension origin check and its automatic blob/CDN wrapper. */
export function createLocalPdfWorker(){
 const port=new Worker(workerUrl,{type:'module',name:'english-reader-pdf'});
 try {
  // PDFWorker.create forwards this fresh explicit port to its constructor. The
  // constructor's generated declaration incorrectly restricts port to null.
  const worker=PDFWorker.create({port});let destroyed=false;
  return {worker,port,destroy(){if(destroyed)return;destroyed=true;try{worker.destroy();}catch{/* Teardown failure must not keep a native worker alive. */}finally{try{port.terminate();}catch{/* Native termination is best-effort and idempotent. */}}}};
 }catch(error){port.terminate();throw error;}
}
export function disposePdfLoading(task:{destroy():Promise<void>}|undefined,owned:ReturnType<typeof createLocalPdfWorker>|undefined):void{
 if(!owned)return;
 // A failed worker may never acknowledge PDF.js teardown. Always terminate the
 // owned native port, while allowing healthy document transports to clean up.
 const timeout=setTimeout(()=>owned.destroy(),1000);
 Promise.resolve().then(()=>task?.destroy()).catch(()=>{}).finally(()=>{clearTimeout(timeout);owned.destroy();});
}
