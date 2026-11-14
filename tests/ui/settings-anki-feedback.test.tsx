import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsApp } from '../../apps/extension/src/ui/SettingsApp';
import { attachRpcWarnings } from '../../apps/extension/src/runtime/rpc-metadata';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

function ankiSection() {
  return [...node.querySelectorAll('fieldset')].find(fieldset => fieldset.querySelector('legend')?.textContent === '2. Anki и колода')!;
}
function checkButton() {
  return [...ankiSection().querySelectorAll('button')].find(button => button.textContent === 'Проверить Anki и получить колоды')!;
}

it('shows progress at the viewport top without a competing inline announcement, sending only one pending check', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(value => { resolve = value; });
  const rpc = vi.fn(async (type: string) => type === 'anki.configuration' ? pending : {}) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  expect(ankiSection().querySelector('[role=status]')).toBeNull();
  const button = checkButton();
  await act(async () => { button.click(); button.click(); });
  expect(button.matches(':disabled')).toBe(true);
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.nextElementSibling?.textContent).toBe('Проверяем Anki и получаем колоды…');
  expect(ankiSection().querySelector('[role=status]')).toBeNull();
  expect(node.querySelector('.settings-notifications [role=status]')?.textContent).toBe('Проверяем Anki и получаем колоды…');
  await act(async () => button.click());
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'anki.configuration']);
  await act(async () => resolve({ deckNames: ['Default'] }));
  expect(button.matches(':disabled')).toBe(false);
  expect(button.getAttribute('aria-busy')).toBe('false');
  expect(ankiSection().textContent).not.toContain('Проверяем Anki');
});

it.each([{ names: [] }, { names: ['Default', 'English::Reading'] }])('shows a non-live local deck count and announces the fixed success message: $names', async ({ names }) => {
  const rpc = vi.fn(async (type: string) => type === 'anki.configuration' ? { deckNames: names } : {}) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => checkButton().click());
  expect(checkButton().nextElementSibling?.textContent).toBe(`Соединение с Anki проверено. Колод получено: ${names.length}. Выберите колоду в поле ниже.`);
  expect([...ankiSection().querySelectorAll('datalist option')].map(option => option.getAttribute('value'))).toEqual(names);
  expect(node.querySelector('.settings-notifications [role=status]')?.textContent).toBe('Соединение с Anki проверено. Список колод обновлён.');
  expect(ankiSection().querySelector<HTMLInputElement>('input[list=reader-decks]')!.value).toBe('');
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'anki.configuration']);
});

it('shows a failed check locally but announces the fixed error only once, and allows an explicit retry', async () => {
  let checks = 0;
  const rpc = vi.fn(async (type: string) => {
    if (type !== 'anki.configuration') return {};
    if (++checks === 1) throw new Error('AnkiConnect недоступен.');
    return { deckNames: ['Default'] };
  }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => checkButton().click());
  expect(checkButton().nextElementSibling?.getAttribute('role')).toBeNull();
  expect(checkButton().nextElementSibling?.textContent).toBe('AnkiConnect недоступен.');
  expect(ankiSection().querySelector('[role=alert]')).toBeNull();
  expect(node.querySelector('.settings-notifications [role=alert]')?.textContent).toBe('AnkiConnect недоступен.');
  expect(ankiSection().querySelector('[role=status]')).toBeNull();
  expect(checkButton().matches(':disabled')).toBe(false);
  expect(checkButton().getAttribute('aria-busy')).toBe('false');
  expect(checks).toBe(1);
  await act(async () => checkButton().click());
  expect(ankiSection().querySelector('[role=alert]')).toBeNull();
  expect(checkButton().nextElementSibling?.textContent).toContain('Колод получено: 1.');
  expect(ankiSection().querySelector('[role=status]')).toBeNull();
  expect(node.querySelector('.settings-notifications [role=alert]')?.textContent).toBe('');
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'anki.configuration', 'anki.configuration']);
});

it('does not start a check or show check progress before settings are ready', async () => {
  let resolve!: (value: unknown) => void;
  const rpc = vi.fn(() => new Promise(value => { resolve = value; })) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => checkButton().click());
  expect(checkButton().matches(':disabled')).toBe(true);
  expect(ankiSection().querySelector('[role=status]')).toBeNull();
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic']);
  await act(async () => resolve({}));
});

it('keeps Anki checks blocked during endpoint repair without showing misleading progress', async () => {
  const rpc = vi.fn(async () => attachRpcWarnings({ ankiEndpoint: 'http://127.0.0.1:8765' }, ['SETTINGS_REPAIR_REQUIRED'])) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => checkButton().click());
  expect(checkButton().matches(':disabled')).toBe(true);
  expect(ankiSection().querySelector('[role=status]')).toBeNull();
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic']);
});
