import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsApp } from '../../apps/extension/src/ui/SettingsApp';
import { uiCss } from '../../apps/extension/src/ui/styles';
import { attachRpcWarnings } from '../../apps/extension/src/runtime/rpc-metadata';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';

let node: HTMLDivElement;
let style: HTMLStyleElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div');
  style = document.createElement('style');
  style.textContent = uiCss;
  document.head.append(style);
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove(); style.remove(); vi.useRealTimers();
});

const button = (name: string) => [...node.querySelectorAll('button')].find(item => item.textContent === name)!;
const toast = () => node.querySelector<HTMLElement>('.settings-notification');
const message = (role: 'status' | 'alert') => node.querySelector<HTMLElement>(`.settings-notifications [role=${role}]`)!;
const dismiss = () => node.querySelector<HTMLButtonElement>('[aria-label="Закрыть уведомление"]')!;

it('keeps save progress and success in a viewport-fixed, bounded, non-modal notification', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise(value => { resolve = value; });
  const rpc = vi.fn(async (type: string) => type === 'settings.update' ? pending : {}) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const save = button('Сохранить настройки');
  const scroll = vi.spyOn(window, 'scrollTo');
  save.focus();
  await act(async () => save.click());
  expect(message('status').textContent).toBe('Сохраняем настройки…');
  expect(message('alert').textContent).toBe('');
  expect(save.disabled).toBe(true);
  expect(dismiss().matches(':disabled')).toBe(false);
  expect(document.activeElement).toBe(save);
  const placement = getComputedStyle(node.querySelector('.settings-notifications')!);
  expect(placement.position).toBe('fixed');
  expect(placement.pointerEvents).toBe('none');
  expect(placement.left).toBe('12px'); expect(placement.right).toBe('12px');
  expect(uiCss).toContain('top:max(12px,env(safe-area-inset-top))');
  expect(getComputedStyle(toast()!).width).toBe('100%');
  expect(getComputedStyle(toast()!).maxWidth).toBe('810px');
  expect(node.querySelector('[aria-modal=true], dialog')).toBeNull();
  await act(async () => dismiss().click());
  expect(toast()).toBeNull();
  expect(save.disabled).toBe(true);
  await act(async () => resolve({}));
  expect(message('status').textContent).toBe('Настройки сохранены.');
  expect(toast()?.classList.contains('success')).toBe(true);
  expect(save.disabled).toBe(false);
  expect(scroll).not.toHaveBeenCalled();
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'settings.update']);
});

it('renders each identical save result as a new announcement, including after dismissal', async () => {
  const rpc = vi.fn(async () => ({})) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const statusRegion = message('status');
  await act(async () => button('Сохранить настройки').click());
  const firstMessage = statusRegion.firstElementChild;
  await act(async () => button('Сохранить настройки').click());
  expect(message('status')).toBe(statusRegion);
  expect(statusRegion.textContent).toBe('Настройки сохранены.');
  expect(statusRegion.firstElementChild).not.toBe(firstMessage);
  await act(async () => dismiss().click());
  expect(statusRegion.textContent).toBe('');
  await act(async () => button('Сохранить настройки').click());
  expect(toast()?.textContent).toContain('Настройки сохранены.');
  expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'settings.update')).toHaveLength(3);
});

it('keeps a long error readable and present until explicitly dismissed or replaced by another action', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const error = `Не удалось сохранить: ${'подробности '.repeat(100)}`;
  const rpc = vi.fn(async (type: string) => {
    if (type === 'settings.update' && ++attempts < 3) throw new Error(error);
    return {};
  }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => button('Сохранить настройки').click());
  const alertRegion = message('alert');
  const firstMessage = alertRegion.firstElementChild;
  expect(alertRegion.textContent).toBe(error);
  expect(message('status').textContent).toBe('');
  const body = node.querySelector<HTMLElement>('.settings-notification-message')!;
  expect(body.tabIndex).toBe(0);
  expect(getComputedStyle(body).overflow).toBe('auto');
  expect(getComputedStyle(body).overflowWrap).toBe('anywhere');
  expect(getComputedStyle(body).maxHeight).toBe('min(40vh,240px)');
  await act(async () => vi.advanceTimersByTime(300_000));
  expect(alertRegion.textContent).toBe(error);
  expect(button('Сохранить настройки').disabled).toBe(false);
  await act(async () => button('Сохранить настройки').click());
  expect(alertRegion.firstElementChild).not.toBe(firstMessage);
  await act(async () => dismiss().click());
  expect(toast()).toBeNull(); expect(alertRegion.textContent).toBe('');
  await act(async () => button('Сохранить настройки').click());
  expect(message('status').textContent).toBe('Настройки сохранены.');
  expect(alertRegion.textContent).toBe('');
});

it('uses the same notification for failed initial load and retry, keeping all settings gated', async () => {
  const rpc = vi.fn().mockRejectedValueOnce(new Error('Настройки недоступны.')).mockResolvedValue({}) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  expect(message('alert').textContent).toBe('Настройки недоступны.');
  expect(button('Сохранить настройки').disabled).toBe(true);
  await act(async () => dismiss().click());
  expect(button('Сохранить настройки').disabled).toBe(true);
  await act(async () => button('Повторить загрузку настроек').click());
  expect(toast()).toBeNull();
  expect(button('Сохранить настройки').disabled).toBe(false);
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'settings.getPublic']);
});

it.each([
  ['Удалить ключ', 'Ключ удалён.', 'secrets.clearOpenAIKey'],
  ['Удалить ключ AnkiConnect', 'Ключ AnkiConnect удалён.', 'settings.update'],
  ['Проверить подключение', 'Диагностика OpenAI завершена без платного тестового перевода.', 'providers.test'],
])('announces the result for %s once, not from a competing key badge', async (action, result, method) => {
  const rpc = vi.fn(async (type: string) => type === 'settings.getPublic' ? { hasOpenAIKey: true } : { ok: true }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => button(action).click());
  expect(message('status').textContent).toBe(result);
  expect([...node.querySelectorAll('[role=status]')].filter(region => region.textContent)).toHaveLength(1);
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', method]);
});

it('leaves repair and queue-review warnings in the page when a notification is dismissed', async () => {
  const rpc = vi.fn(async () => attachRpcWarnings({}, ['SETTINGS_REPAIR_REQUIRED', 'ANKI_QUEUE_REVIEW_REQUIRED'])) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => button('Удалить ключ').click());
  await act(async () => dismiss().click());
  expect(node.querySelector('main > section[role=alert]')?.textContent).toContain('Нужно восстановить настройки AnkiConnect');
  expect(node.querySelector('main > p[role=alert]')?.textContent).toContain('Старые операции Anki требуют проверки');
  expect(button('Сохранить настройки').disabled).toBe(true);
  expect(button('Проверить Anki и получить колоды').disabled).toBe(true);
});
