import { Unzip, UnzipInflate } from 'fflate';
export const ZIP_LIMITS = { archive:100*1024*1024, total:500*1024*1024, file:50*1024*1024, entries:10000, ratio:200 } as const;
export function safeArchivePath(name:string):string {
  if (!name || name.includes('\\') || name.includes(':') || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\u0000-\u001f]/.test(name)) throw new Error('Небезопасный путь ZIP');
  const parts=name.split('/');
  if(parts.some(p=>p==='..'||p==='.') || parts.slice(0,-1).some(p=>!p)) throw new Error('Небезопасный путь ZIP');
  return name.normalize('NFC');
}
/** Runs in a dedicated worker. Bounds are checked on emitted, actual bytes, not ZIP metadata. */
export function extractBounded(bytes:Uint8Array):Record<string,Uint8Array> {
  if(bytes.length>ZIP_LIMITS.archive) throw new Error('EPUB больше 100 MiB');
  const result:Record<string,Uint8Array>=Object.create(null), names=new Set<string>(), fileNames=new Set<string>(), directoryNames=new Set<string>();
  let count=0,total=0,active=0;
  const unzip=new Unzip(file=>{
    const name=safeArchivePath(file.name), key=name.toLocaleLowerCase('en-US').replace(/\/$/,'');
    if(++count>ZIP_LIMITS.entries || names.has(key)) throw new Error('Слишком много файлов или конфликт имён ZIP');
    names.add(key);
    const segments=key.split('/');
    for(let i=1;i<segments.length;i++){const parent=segments.slice(0,i).join('/');if(fileNames.has(parent))throw new Error('Конфликт файла и каталога ZIP');directoryNames.add(parent);}
    if(name.endsWith('/')){if(fileNames.has(key))throw new Error('Конфликт файла и каталога ZIP');directoryNames.add(key);}
    else {if(directoryNames.has(key))throw new Error('Конфликт файла и каталога ZIP');fileNames.add(key);}
    if(file.originalSize && file.originalSize>ZIP_LIMITS.file) throw new Error('Файл EPUB больше 50 MiB');
    if(file.compression!==0 && file.compression!==8) throw new Error('Неподдерживаемое сжатие ZIP');
    const chunks:Uint8Array[]=[];let size=0;active++;
    file.ondata=(error,chunk,final)=>{
      if(error) throw error;
      size+=chunk.length; total+=chunk.length;
      if(size>ZIP_LIMITS.file || total>ZIP_LIMITS.total || total>Math.max(bytes.length,1)*ZIP_LIMITS.ratio || (file.size!==undefined && size>Math.max(file.size,1)*ZIP_LIMITS.ratio)) {
        file.terminate();throw new Error('Превышен безопасный предел распаковки EPUB');
      }
      chunks.push(chunk);
      if(final){ const out=new Uint8Array(size);let pos=0;for(const c of chunks){out.set(c,pos);pos+=c.length;}if(!name.endsWith('/'))result[name]=out;active--; }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small input increments limit the size of each decompression allocation.
  for(let i=0;i<bytes.length;i+=1024)unzip.push(bytes.subarray(i,i+1024),i+1024>=bytes.length);
  if(active || !count) throw new Error('Неполный ZIP архив');
  return result;
}
