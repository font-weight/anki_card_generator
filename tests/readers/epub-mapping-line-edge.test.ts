import {EpubCFI, Layout, Rendition, type Contents} from 'epubjs';
import {expect, it} from 'vitest';
import {directionalPercent, type MeasuredProgress} from '../../apps/extension/src/readers/epub-scroll-edges';

it('reproduces the epub.js 0.3.93 CFI reversal when the viewport cuts through the last line of a paragraph', () => {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = '<p>Mara walked down the long road at dawn.</p><p>She returned home before noon.</p>';
  const [first, next] = [...doc.querySelectorAll('p')].map(p => p.firstChild as Text);
  const newRange = doc.createRange.bind(doc);
  // jsdom has no layout. Supply just the measured rectangles: four lines
  // in the first paragraph, then the following paragraph starting at y=90.
  doc.createRange = () => {
    const range = newRange();
    range.getBoundingClientRect = () => {
      const line = (offset: number) => {
        if (range.startContainer === next) return 90;
        if (offset < 12) return 0;
        if (offset < 21) return 20;
        return offset < 31 ? 40 : 60;
      };
      const top = line(range.startOffset);
      const bottom = line(Math.max(range.startOffset, range.endOffset - 1)) + 16;
      return new DOMRect(0, top, 80, bottom - top);
    };
    return range;
  };

  const Manager = Rendition.prototype.requireManager('continuous');
  const manager = new Manager({settings: {axis: 'vertical', direction: 'ltr'}});
  manager.setLayout(new Layout({layout: 'reflowable', spread: 'none', minSpreadWidth: 560, evenSpreads: false}));
  const contents = {document: doc} as Contents;
  function firstVisibleWord(top: number): [string, number] {
    const {start} = manager.mapping.page(contents, '/6/2', top, top + 100);
    const position = new EpubCFI(start).toRange(doc);
    return [position.startContainer === first ? 'first' : 'next', position.startOffset];
  }

  const offsets = [39, 55, 60, 61, 70, 76];
  const rawLocations = [['first', 21], ['first', 31], ['first', 31], ['first', 0], ['first', 0], ['next', 0]];
  expect(offsets.map(firstVisibleWord)).toEqual(rawLocations);
  const upwards = [...offsets].reverse();
  expect(upwards.map(firstVisibleWord)).toEqual([...rawLocations].reverse());

  function reportedPositions(positions: number[]) {
    let previous: MeasuredProgress | undefined;
    return positions.map(offset => {
      const [paragraph, character] = firstVisibleWord(offset);
      const textOffset = (paragraph === 'first' ? 0 : first.length) + character;
      const rawPercent = 100 * textOffset / (first.length + next.length);
      const sample = {section: 0, offset, height: 200, width: 640, viewportHeight: 100};
      const percent = directionalPercent(previous, sample, rawPercent);
      previous = {...sample, percent};
      return percent;
    });
  }
  const down = reportedPositions(offsets), up = reportedPositions(upwards);
  expect(down).toEqual([...down].sort((a, b) => a - b));
  expect(up).toEqual([...up].sort((a, b) => b - a));
  expect(down.at(-1)).toBeGreaterThan(down[0]);
  expect(up.at(-1)).toBeLessThan(up[0]);
});
