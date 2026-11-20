import { expect, it, vi } from 'vitest';
import { TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { pdfSearchRange } from '../../apps/extension/src/readers/pdf-search-range';

it('maps duplicate UTF-16 matches onto actual PDF.js TextLayer runs across empty items, marked content and EOL breaks', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  // jsdom has no font metrics. PDF.js itself creates, orders and populates every text span and line break.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas:this, measureText: () => ({ width:45, fontBoundingBoxAscent:8, fontBoundingBoxDescent:2 }) } as unknown as CanvasRenderingContext2D;
  });
  const run = (str: string, hasEOL = false): TextItem => ({
    str, hasEOL, fontName:'f1', dir:'ltr', transform:[12,0,0,12,20,250], width:60, height:12,
  });
  const source: TextContent = {
    items:[run('', true), {type:'beginMarkedContentProps', id:'fragment'}, run('  😀Needle', true), run('\u00a0   YES'),
      {type:'endMarkedContent', id:''}, run(''), run('followed   by 😀needle'), run('yes!')],
    styles:{ f1:{ fontFamily:'sans-serif', ascent:.8, descent:-.2, vertical:false } }, lang:'en',
  };
  const viewport = { scale:1, rotation:0, rawDims:{ pageWidth:300, pageHeight:400, pageX:0, pageY:0 } };
  const layer = new TextLayer({ container, textContentSource:source, viewport:viewport as ConstructorParameters<typeof TextLayer>[0]['viewport'] });
  try {
    await layer.render();
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(layer.textDivs).toHaveLength(6);
    expect(layer.textDivs[0]!.isConnected).toBe(false);
    const normalized = source.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ').replace(/\s+/g, ' ');
    const matches = [...normalized.matchAll(/😀needle yes/giu)];
    expect(matches).toHaveLength(2);
    const ranges = matches.map(match => pdfSearchRange(layer.textDivs, match.index, match[0].length)!);
    expect(ranges[0]!.startContainer.parentElement?.closest('.markedContent')?.id).toBe('fragment');
    expect(ranges[0]!.toString()).toBe('😀Needle\u00a0   YES');
    expect(ranges[0]!.startOffset).toBe(2);
    expect(ranges[1]!.startContainer).toBe(layer.textDivs[4]!.firstChild);
    expect(ranges[1]!.startOffset).toBe('followed   by '.length);
    expect(ranges[1]!.endContainer).toBe(layer.textDivs[5]!.firstChild);
    expect(ranges[1]!.endOffset).toBe(3);
    expect(ranges[1]!.toString()).toBe('😀needleyes');
    expect(pdfSearchRange(layer.textDivs, normalized.length + 1, 3)).toBeNull();
  } finally {
    container.remove(); TextLayer.cleanup();
  }
});
