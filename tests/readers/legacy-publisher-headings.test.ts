import { afterEach, expect, it } from 'vitest';
import { applyBookStyle, pageColors } from '../../apps/extension/src/readers/epub-format';
import { sanitizeChapter } from '../../apps/extension/src/readers/epub-security';

const chapter = (body: string, head = '') => sanitizeChapter(
  '<html xmlns="http://www.w3.org/1999/xhtml"><head>'+head+'</head><body>'+body+'</body></html>', 'OPS/preface.xhtml', new Map()
);
function frame(markup: string) {
  const iframe=document.createElement('iframe'); document.body.append(iframe);
  const doc=iframe.contentDocument!; doc.open(); doc.write(markup); doc.close();
  return { doc, computed:(element:Element)=>iframe.contentWindow!.getComputedStyle(element) };
}
afterEach(()=>document.querySelectorAll('iframe').forEach(node=>node.remove()));

it.each(['p','h2'])('shows a compact publisher opener and a neutral version without altering the original %s nodes', tag=>{
  const cssClass=tag==='h2'?'heading2':'calibre9';
  const block=(id:string,text:string)=>'<' + tag + ' id="'+id+'" class="'+cssClass+'">'+text+'</'+tag+'>';
  const body=block('label','<i>Preface</i>')+'<p><br/></p>'+block('title','How This Book Was')+
    block('line','Written and Why')+'<p><br/></p><p id="body">Years ago, I returned to the quiet street where this story began.</p>';
  const {doc,computed}=frame(chapter(body));
  const [label,title,line,prose]=['label','title','line','body'].map(id=>doc.getElementById(id)!);
  expect([label,title,line,prose].map(el=>el.getAttribute('data-reader-heading'))).toEqual(['label','title','line',null]);
  expect(doc.querySelectorAll('[data-reader-heading-gap]')).toHaveLength(2);
  expect(title.hasAttribute('data-reader-heading-more')).toBe(true);
  const original=doc.body.innerHTML, originalNode=line.firstChild;
  const range=doc.createRange();range.selectNodeContents(line);
  for(const theme of ['light','cream','dark'] as const) {
    for(const publisher of [true,false]) {
      applyBookStyle(doc,{kind:'epub',theme,fontSize:20,lineHeight:1.5,publisher});
      expect(computed(label).textAlign).toBe(publisher?'center':'start');
      expect(computed(label).fontStyle).toBe(publisher?'italic':'normal');
      expect(computed(title).textAlign).toBe(publisher?'center':'start');
      expect(computed(line).fontSize).toBe(computed(title).fontSize);
      expect(computed(label).fontSize===computed(title).fontSize).toBe(!publisher);
      expect(computed(title).marginBlockEnd).toMatch(/^0(px)?$/);
      expect(computed(doc.querySelector('[data-reader-heading-gap]')!).display).toBe('none');
      expect(doc.body.innerHTML).toBe(original);expect(line.firstChild).toBe(originalNode);
      expect(range.toString()).toBe('Written and Why');
      expect(doc.querySelectorAll('style[data-reader-format]')).toHaveLength(1);
      const luminance=(hex:string)=>hex.slice(1).match(/../g)!.map(channel=>{
        const value=parseInt(channel,16)/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
      }).reduce((sum,value,i)=>sum+value*[.2126,.7152,.0722][i]!,0);
      const {paper,muted,text}=pageColors[theme],bg=luminance(paper);
      for(const color of [muted,text]) {
        const fg=luminance(color);expect((Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

it('keeps distinct part and chapter headings in the original semantic hierarchy',()=>{
  const {doc}=frame(chapter('<h1>Part One</h1><h2>Chapter 3</h2><h3>Arrival</h3><p>Before dawn, the boat came in.</p>'));
  expect(doc.body.querySelectorAll('[data-reader-heading]')).toHaveLength(0);
  expect(Array.from(doc.body.children,el=>el.localName)).toEqual(['h1','h2','h3','p']);
});

it('preserves explicit and inline heading clues without treating ordinary prose or a partial inline emphasis as a heading',()=>{
  const {doc}=frame(chapter('<p>Regular opening paragraph.</p>'+
    '<p id="label" class="chapter-number">III</p><p id="title"><span class="chapter_title">A New Shore<br/>Before Sunrise</span></p>'+
    '<p id="sub" class="sub-heading">At daybreak</p><p id="old" align="center"><span style="font-size:18pt">The Crossing</span></p>'+
    '<p id="prose">An ordinary <span class="chapter-title">emphasis</span> inside a sentence.</p>'+
    '<blockquote><p id="quote" class="title">A brief quotation</p></blockquote>'));
  expect(['label','title','sub','old','prose','quote'].map(id=>doc.getElementById(id)!.getAttribute('data-reader-heading')))
    .toEqual(['label','title','subtitle','title',null,null]);
  expect(doc.querySelector('#title br')).not.toBeNull();
  expect(doc.querySelector('[class],[style],[align]')).toBeNull();
});

it('keeps chapter styling inert, ignores forged hints and leaves unmarked opening prose alone',()=>{
  const body='<p class="calibre3">A cold wind</p><p class="calibre3">Across the harbour</p>'+
    '<p id="forged" data-reader-heading="title" data-reader-heading-gap="" class="chapter-title-remote" '+
    'style="text-align:var(--evil);font-size:calc(100em);background-image:url(https://remote.example/x);" onclick="untrusted()">A forged title</p>'+
    '<p align="center" style="font-size:9999px">Unbounded size</p>';
  const {doc}=frame(chapter(body,'<style>.calibre3{font-family:secret}</style><link rel="stylesheet" href="https://remote.example/style"/><script>untrusted()</script>'));
  expect(doc.querySelector('[data-reader-heading],[data-reader-heading-gap],script,style,link,[style],[class],[onclick]')).toBeNull();
  expect(doc.head.querySelector('meta')?.content).toContain("connect-src 'none'");
  applyBookStyle(doc,{kind:'epub',theme:'dark',fontSize:20,lineHeight:1.5,publisher:true});
  expect(doc.documentElement.innerHTML).not.toMatch(/remote\.example|secret|untrusted\(\)|9999px/);
});
