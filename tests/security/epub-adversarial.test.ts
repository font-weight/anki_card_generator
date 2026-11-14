// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeChapter, resolveInternal } from '../../apps/extension/src/readers/epub-security';

describe('untrusted chapter active content', () => {
  const wrap = (body:string) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Book</title></head><body>${body}</body></html>`;
  it('removes executable nodes, handlers, CSS, remote images and navigation', () => {
    const input = wrap(`<script>alert(1)</script><style>@import 'https://evil.test/a.css';</style><iframe src="https://evil.test"/><object data="https://evil.test"/><form action="https://evil.test"><input/></form><meta http-equiv="refresh" content="0;url=https://evil.test"/><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg><p onclick="alert(1)" style="background:url(https://evil.test/a)">Read</p><img src="https://evil.test/pixel" srcset="https://evil.test/b 2x"/><a href="javascript:alert(1)" target="_top">bad</a>`);
    const clean = sanitizeChapter(input,'OPS/ch.xhtml',new Map());
    const doc = new DOMParser().parseFromString(clean,'application/xml');
    expect(doc.querySelectorAll('script,style,iframe,object,form,input,svg,[onclick],[style],[srcset],[target]').length).toBe(0);
    expect(doc.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(doc.querySelector('meta')?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
  });
  it('allows only parent-created image mapping and inert external-link metadata', () => {
    const doc = new DOMParser().parseFromString(sanitizeChapter(wrap('<img src="../images/a.png"/><a href="https://example.org/book">Source</a>'),'OPS/ch.xhtml',new Map([['images/a.png','blob:test-controlled']])),'application/xml');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('blob:test-controlled');
    expect(doc.querySelector('a')?.getAttribute('data-external-link')).toBe('https://example.org/book');
    expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
  });
  it.each(['https://evil.test/a','//evil.test/a','../../escape','data:text/html,hi','file:///C:/x'])('rejects unsafe resource %s', value => {
    expect(resolveInternal('OPS/ch.xhtml',value)).toBeNull();
  });
});
