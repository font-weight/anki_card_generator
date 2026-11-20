import type {PDFDocumentProxy} from 'pdfjs-dist/legacy/build/pdf.mjs';
export interface PdfChapter {id:string;title:string;level:number;page:number;}
/** External actions never enter the table of contents. Only local PDF destinations are followed. */
export async function pdfChapters(pdf:PDFDocumentProxy, alive:()=>boolean):Promise<PdfChapter[]> {
  const outline=await pdf.getOutline();
  const stack=(outline||[]).map(item=>({item,level:0})).reverse(), rows:PdfChapter[]=[];
  for(let inspected=0;stack.length&&inspected<1000&&alive();inspected++){
    const {item,level}=stack.pop()!;
    const children=(item.items||[]).slice(0,1000-inspected);
    for(let i=children.length-1;i>=0;i--)stack.push({item:children[i]!,level:level+1});
    if(!item.dest||!item.title?.trim())continue;
    try{
      const dest=typeof item.dest==='string'?await pdf.getDestination(item.dest):item.dest;
      if(!alive()||!Array.isArray(dest)||dest[0]==null)continue;
      const index=Number.isInteger(dest[0])?dest[0]:await pdf.getPageIndex(dest[0]);
      if(Number.isInteger(index)&&index>=0&&index<pdf.numPages)rows.push({id:String(inspected),title:item.title.trim(),level,page:index+1});
    }catch{/* A malformed destination does not prevent the remaining outline from opening. */}
  }
  return rows;
}
