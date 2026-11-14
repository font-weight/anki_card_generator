// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

const sourceCss = readFileSync(resolve('apps/extension/src/action/action.css'), 'utf8');
let compiledCss: string;

// A fresh in-memory production build verifies the CSS linked by action.html.
// Never inspect dist here: it may be stale or being built by another process.
beforeAll(async () => {
  const result = await build({
    configFile: false,
    root: resolve('apps/extension'),
    logLevel: 'silent',
    build: {
      target: 'chrome120', write: false, minify: true,
      rollupOptions: { input: resolve('apps/extension/action.html') },
    },
  });
  if (Array.isArray(result) || !('output' in result)) throw new Error('Expected a single action build');
  const styles = result.output.filter(asset => asset.type === 'asset' && asset.fileName.endsWith('.css'));
  expect(styles).toHaveLength(1);
  const style = styles[0];
  const html = result.output.find(asset => asset.type === 'asset' && asset.fileName === 'action.html');
  if (style.type !== 'asset' || html?.type !== 'asset') throw new Error('Missing built action assets');
  compiledCss = String(style.source);
  const builtDocument = new JSDOM(String(html.source));
  try {
    expect([...builtDocument.window.document.querySelectorAll('link[rel="stylesheet"]')]
      .map(link => link.getAttribute('href'))).toEqual([`/${style.fileName}`]);
    expect(builtDocument.window.document.querySelector('body > #root')).not.toBeNull();
  } finally { builtDocument.window.close(); }
});

const markup = `<div id="root"><main class="action-menu">
  <header class="action-header"><span class="action-brand-mark"><svg class="action-icon"></svg></span><div class="action-brand"><h1>Language Reader</h1></div></header>
  <section class="action-context"><div class="action-page-label"><svg class="action-icon"></svg><bdi>A very long current page label</bdi></div>
    <div class="action-readiness" role="alert"><h3>Не удалось проверить вкладку</h3><p tabindex="0">${'LongUnbrokenError'.repeat(100)}</p></div>
    <button class="action-primary"><span>Открываем библиотеку…</span><svg class="action-icon"></svg></button>
  </section>
  <p class="action-feedback is-error" tabindex="0">${'AnotherLongError'.repeat(100)}</p>
  <section class="action-shortcuts"><div><kbd>Shift</kbd><span>Перевод слова или выделения</span></div></section>
  <nav class="action-navigation"><div class="action-nav-pair">
    <button><svg class="action-icon"></svg><span>Настройки</span></button>
    <button><svg class="action-icon"></svg><span>Очередь Anki</span></button>
  </div></nav>
  <p class="action-footnote">Меню не отправляет запросы к моделям.</p>
</main></div>`;

function withStyles(css: string, initialWidth: number, check: (style: (selector: string) => CSSStyleDeclaration) => void) {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`);
  // JSDOM cannot lay out or autosize a popup. This mocked property only verifies
  // effective CSS declarations are not derived from the starting window width.
  Object.defineProperty(dom.window, 'innerWidth', { value: initialWidth, configurable: true });
  try {
    check(selector => dom.window.getComputedStyle(dom.window.document.querySelector(selector)!));
  } finally { dom.window.close(); }
}

for (const variant of ['source', 'production CSS'] as const) {
  describe(`${variant}: computed-declaration regressions, not browser layout validation`, () => {
    const css = () => variant === 'source' ? sourceCss : compiledCss;

    it.each([120, 180, 392])('gives every document root a 392px intrinsic sizing contract with mocked initial width %ipx', initialWidth => {
      withStyles(css(), initialWidth, style => {
        for (const selector of ['html', 'body', '#root']) {
          const root = style(selector);
          expect(root.width).toBe('392px');
          expect(root.minWidth).toBe('392px');
          expect(root.boxSizing).toBe('border-box');
          expect(root.margin).toBe('0px');
          expect(['', 'none']).toContain(root.maxWidth);
        }
        expect(style('.action-menu').width).toBe('100%');
        expect(style('.action-menu').boxSizing).toBe('border-box');
        expect(['', 'none']).toContain(style('.action-menu').maxWidth);
      });
      // Unlike mocked innerWidth, this catches CSS viewport coupling directly.
      expect(css()).not.toMatch(/\d(?:dvw|svw|lvw|vw|vh|vi|vb|vmin|vmax)\b/);
    });

    it('preserves document-flow controls with a bounded, scrollable overflow fallback', () => {
      withStyles(css(), 180, style => {
        const menu = style('.action-menu');
        expect(menu.maxHeight).toBe('580px');
        expect(menu.overflow).toBe('auto');
        expect(menu.padding).toBe('18px');
        for (const selector of ['.action-readiness p', '.action-feedback']) {
          expect(style(selector).maxHeight).toBe('108px');
          expect(style(selector).overflowY).toBe('auto');
          expect(style(selector).overflowWrap).toBe('anywhere');
        }
        for (const selector of ['html', 'body', '#root', '.action-menu', '.action-navigation', '.action-nav-pair', '.action-footnote']) {
          expect(['', 'static']).toContain(style(selector).position);
          expect(style(selector).overflow).not.toBe('hidden');
          expect(style(selector).overflowY).not.toBe('hidden');
        }
        expect(style('.action-nav-pair').gridTemplateColumns.replace(/\s/g, '')).toBe('repeat(2,minmax(0,1fr))');
      });
    });

    it('keeps icons intact and lets labels wrap instead of forcing controls past their grid cells', () => {
      withStyles(css(), 180, style => {
        for (const selector of ['.action-primary', '.action-primary > span', '.action-nav-pair button', '.action-nav-pair button > span', '.action-brand', '.action-shortcuts span']) {
          expect(['0', '0px']).toContain(style(selector).minWidth);
        }
        for (const selector of ['.action-primary > span', '.action-nav-pair button > span', '.action-brand h1', '.action-shortcuts span']) {
          expect(style(selector).overflowWrap).toBe('anywhere');
        }
        expect(style('.action-brand-mark').flexShrink).toBe('0');
        expect(style('.action-brand-mark').flexBasis).toBe('40px');
        expect(style('.action-icon').flexShrink).toBe('0');
        expect(style('.action-page-label bdi').textOverflow).toBe('ellipsis');
      });
    });
  });
}
