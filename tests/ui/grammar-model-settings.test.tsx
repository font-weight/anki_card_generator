import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsApp } from '../../apps/extension/src/ui/SettingsApp';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';

let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
const section = () => [...node.querySelectorAll('fieldset')].find(field => field.querySelector('legend')?.textContent === '5. Грамматика (эксперимент)')!;
const button = () => [...section().querySelectorAll('button')].find(item => item.textContent === 'Подготовить тип грамматики')!;
const consent = () => [...section().querySelectorAll('label')].find(item => item.textContent?.startsWith('Разрешаю создать отдельный тип'))!.querySelector<HTMLInputElement>('input')!;

it('v2 setup is explicit, describes unchanged existing models, and does not run on page load or repeated pending clicks', async () => {
  let resolve!: (value: unknown) => void;
  const rpc = vi.fn(async (type: string) => type === 'grammar.initializeModel' ? new Promise(value => { resolve = value; }) : {}) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  expect(section().textContent).toContain('LanguageReader.Grammar.v1');
  expect(section().textContent).toContain('LanguageReader.Grammar.v2');
  expect(section().textContent).toContain('несовместимые типы и существующие карточки не изменяются');
  expect(button().disabled).toBe(true);
  await act(async () => button().click());
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic']);
  await act(async () => consent().click());
  await act(async () => { button().click(); button().click(); });
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'grammar.initializeModel']);
  expect(button().matches(':disabled')).toBe(true);
  await act(async () => resolve({ created: ['LanguageReader.Grammar.v2'], existing: [] }));
  expect(node.querySelector('[role="status"]')?.textContent).toContain('Вернитесь к открытой карточке');
  expect(button().matches(':disabled')).toBe(false);
});

it('a conflicting recovery model is explained without claiming success or an automatic rewrite', async () => {
  const rpc = vi.fn(async (type: string) => {
    if (type === 'grammar.initializeModel') throw Object.assign(new Error('Generic'), { code: 'ANKI_SCHEMA_MISMATCH' });
    return {};
  }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => consent().click());
  await act(async () => button().click());
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('существующий несовместимый тип не перезаписывается');
  expect(node.querySelector('[role="status"]')?.textContent).not.toContain('подготовлен');
  expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'grammar.initializeModel')).toHaveLength(1);
});
