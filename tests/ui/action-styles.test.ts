import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('apps/extension/src/action/action.css'), 'utf8');
const entry = readFileSync(resolve('apps/extension/src/action.tsx'), 'utf8');
const root = css.match(/:root\s*\{([^}]+)\}/)![1];
const darkRules = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
const darkRoot = darkRules.match(/:root\s*\{([^}]+)\}/)![1];
function property(block: string, name: string) {
  const value = block.match(new RegExp(`(?:^|[;{])\\s*${name}:\\s*(#[a-f\\d]{3,6})`, 'i'))?.[1];
  if (!value) throw new Error(`No color for ${name}`);
  return value;
}
function luminance(hex: string) {
  const normalized = hex.length === 4 ? [...hex.slice(1)].map(digit => digit + digit).join('') : hex.slice(1);
  const rgb = [0, 2, 4].map(offset => {
    const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

describe('action-only layout and accessibility CSS contracts (not browser screenshots)', () => {
  it('uses its own root and reset, without shared page/shadow min-height styles', () => {
    expect(entry).toContain("import './action/action.css'");
    expect(entry).not.toContain('mountPage');
    expect(css).toMatch(/html, body, #root\s*\{[^}]*box-sizing:\s*border-box;[^}]*margin:\s*0;/);
    expect(css).not.toContain('min-height:100vh');
    expect(css).not.toContain('100vh');
  });

  it('lets the document drive popup width and bounds long feedback without relying on motion', () => {
    expect(css).toMatch(/html, body, #root\s*\{[^}]*width:\s*392px;[^}]*min-width:\s*392px;/);
    expect(css).not.toMatch(/\d(?:vw|vh|vi|vb|vmin|vmax)\b/);
    expect(css).toMatch(/\.action-feedback\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*max-height:\s*108px;[^}]*overflow-y:\s*auto;/);
    expect(css).toContain('text-overflow: ellipsis');
    expect(css).not.toMatch(/animation:|transition:|gradient\(/);
  });

  it('provides visible keyboard focus, dark and forced-color support', () => {
    expect(css).toMatch(/button:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--action-focus\);[^}]*outline-offset:\s*3px;/);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('outline-color: Highlight');
    expect(css).toContain('color: GrayText');
  });

  for (const [theme, block] of [['light', root], ['dark', darkRoot]]) {
    for (const foreground of ['--action-ink', '--action-muted']) {
      for (const background of ['background', '--action-surface', '--action-soft']) {
        it(`${theme} ${foreground} on ${background} meets WCAG AA normal-text contrast`, () => {
          expect(contrast(property(block, foreground), property(block, background))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${theme} primary button label meets normal-text contrast`, () => {
      const labelBlock = theme === 'light'
        ? css.match(/\.action-menu \.action-primary\s*\{([^}]+)\}/)![1]
        : darkRules.match(/\.action-brand-mark, \.action-menu \.action-primary\s*\{([^}]+)\}/)![1];
      expect(contrast(property(labelBlock, 'color'), property(block, '--action-accent'))).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme} focus outline contrasts against surrounding surfaces`, () => {
      for (const background of ['background', '--action-surface', '--action-soft']) {
        expect(contrast(property(block, '--action-focus'), property(block, background))).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
