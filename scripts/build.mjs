import { build } from 'vite';
import { resolve } from 'node:path';
import { mkdir, cp, writeFile, rm } from 'node:fs/promises';
const root = process.cwd();
const isolated=process.env.VITE_ISOLATED_ANKI_TEST==='1';
const out = resolve(root,isolated?'dist/english-reader-test':'dist/english-reader');
await rm(out,{recursive:true,force:true});
const alias = Object.fromEntries(['contracts','services','storage','note-templates'].map(n=>[`@english-reader/${n}`,resolve(root,`packages/${n}/src/index.ts`)]));
const common={configFile:false,define:{'import.meta.env.VITE_ISOLATED_ANKI_TEST':JSON.stringify(isolated?'1':'0')},resolve:{alias},build:{target:'chrome120',outDir:out,emptyOutDir:false,sourcemap:false,minify:true}};
await build({...common,root:resolve(root,'apps/extension'),build:{...common.build,rollupOptions:{input:Object.fromEntries(['settings','library','queue','action','confirm','offscreen'].map(n=>[n,resolve(root,`apps/extension/${n}.html`)])),output:{entryFileNames:'assets/[name].js',chunkFileNames:'assets/[name]-[hash].js'}}}});
await build({...common,build:{...common.build,lib:{entry:resolve(root,'apps/extension/src/background.ts'),formats:['es'],fileName:()=> 'background.js'}}});
await build({...common,build:{...common.build,lib:{entry:resolve(root,'apps/extension/src/content.ts'),name:'EnglishReader',formats:['iife'],fileName:()=> 'content.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
const {readFile}=await import('node:fs/promises');
const manifest=JSON.parse(await readFile(resolve(root,'apps/extension/manifest.json'),'utf8'));
if(isolated){manifest.name+=' — isolated test';manifest.content_security_policy.extension_pages=manifest.content_security_policy.extension_pages.replaceAll('http://127.0.0.1:8765','http://127.0.0.1:18765').replace(' http://localhost:8765','').replace(' http://[::1]:8765','');manifest.host_permissions=manifest.host_permissions.filter(x=>!x.includes('localhost')&&!x.includes('[::1]'));}
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2));
for(const resource of ['cmaps','standard_fonts','wasm']) await cp(resolve(root,`node_modules/pdfjs-dist/${resource}`),resolve(out,`pdfjs/${resource}`),{recursive:true});
console.log(`Built ${out}`);
const {readdir,readFile:readBytes}=await import('node:fs/promises');
const {zipSync}=await import('fflate');
const notices=[];
async function collectNotices(modules){
 for(const dir of await readdir(modules,{withFileTypes:true}).catch(()=>[])){
  if(!dir.isDirectory()||dir.name.startsWith('.'))continue;
  const path=resolve(modules,dir.name);
  if(dir.name.startsWith('@')){await collectNotices(path);continue;}
  try{const pkg=JSON.parse(await readBytes(resolve(path,'package.json'),'utf8'));const files=await readdir(path);for(const file of files.filter(n=>/^(licen[cs]e|copying|notice)(\.|$)/i.test(n))){try{notices.push(`\n===== ${pkg.name}@${pkg.version}: ${file} =====\n`+await readBytes(resolve(path,file),'utf8'));}catch{}}}catch{}
  await collectNotices(resolve(path,'node_modules'));
 }
}
await collectNotices(resolve(root,'node_modules'));
await writeFile(resolve(out,'THIRD_PARTY_NOTICES.txt'),notices.join('\n'));
const archiveEntries={};
async function collect(directory,prefix){for(const entry of await readdir(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())await collect(path,prefix+entry.name+'/');else archiveEntries[prefix+entry.name]=new Uint8Array(await readBytes(path));}}
await collect(out,(isolated?'english-reader-test':'english-reader')+'/');
await writeFile(resolve(root,isolated?'dist/english-reader-test.zip':'dist/english-reader.zip'),zipSync(archiveEntries,{level:6}));
