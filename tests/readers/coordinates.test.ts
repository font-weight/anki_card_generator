// @vitest-environment jsdom
import {beforeEach,describe,it,expect} from 'vitest';
import {readerAnchor} from '../../apps/extension/src/readers/coordinates';
function makeRange(doc:Document,rect:DOMRect):Range{const p=doc.createElement('p');p.textContent='bank';doc.body.append(p);const range=doc.createRange();range.selectNodeContents(p);range.getBoundingClientRect=()=>rect;return range;}
beforeEach(()=>document.body.replaceChildren());
describe('reader popup coordinate mapping',()=>{
 it('keeps top-level PDF coordinates',()=>{const rect=new DOMRect(30,40,50,20);expect(readerAnchor(makeRange(document,rect))).toEqual(rect);});
 it('maps iframe offsets, borders and scaling to top-level viewport',()=>{const frame=document.createElement('iframe');document.body.append(frame);frame.getBoundingClientRect=()=>new DOMRect(100,200,800,600);Object.defineProperties(frame,{offsetWidth:{value:400},offsetHeight:{value:300},clientLeft:{value:2},clientTop:{value:3}});const range=makeRange(frame.contentDocument!,new DOMRect(10,20,30,15));const result=readerAnchor(range)!;expect([result.x,result.y,result.width,result.height]).toEqual([124,246,60,30]);});
 it('closes anchors outside the iframe viewport',()=>{const frame=document.createElement('iframe');document.body.append(frame);expect(readerAnchor(makeRange(frame.contentDocument!,new DOMRect(10,900,30,10)))).toBeNull();});
 it('closes detached range anchors',()=>{const range=makeRange(document,new DOMRect(1,1,10,10));document.body.replaceChildren();expect(readerAnchor(range)).toBeNull();});
});
