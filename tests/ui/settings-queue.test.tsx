import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsApp } from '../../apps/extension/src/ui/SettingsApp';
import { QueueApp } from '../../apps/extension/src/ui/QueueApp';
import type { UiRpc } from '../../apps/extension/src/ui/interfaces';
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
it('does not trigger diagnostics, model creation or paid providers on settings mount', async () => {
  const rpc = vi.fn(async () => ({})) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  expect(vi.mocked(rpc).mock.calls.map(c => c[0])).toEqual(['settings.getPublic']);
  const checkboxes = node.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
  expect([...checkboxes].every(c => !c.checked)).toBe(true);
  const models = [...node.querySelectorAll('button')].find(b => b.textContent === 'Создать собственные типы заметок');
  expect(models?.disabled).toBe(true);
});
it('queue shows stored pending state rather than successful add', async () => {
  const rpc = vi.fn(async () => ({ items: [{ operationId: 'test-op', state: 'pending', draft: { expression: 'bank' } }] })) as UiRpc;
  await act(async () => root.render(<QueueApp rpc={rpc} />));
  expect(node.textContent).toContain('Ожидает отправки — не добавлено');
  expect(node.textContent).not.toContain('Добавлено в Anki');
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'queue.list')).toHaveLength(2);
});
it('queue refetches on operation notification instead of trusting transient event payloads', async () => {
  const rpc = vi.fn(async () => ({ items: [] })) as UiRpc;
  let notify: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribe = (callback: () => void) => { notify = callback; return unsubscribe; };
  await act(async () => root.render(<QueueApp rpc={rpc} subscribe={subscribe} />));
  await act(async () => notify?.());
  expect(vi.mocked(rpc).mock.calls).toHaveLength(2);
  await act(async () => root.render(<div />));
  expect(unsubscribe).toHaveBeenCalled();
});

it('resolves queued duplicate with the immutable snapshot and rereads queue', async () => {
  const item = { operationId: 'saved-operation', state: 'awaiting_duplicate_decision', draft: { expression: 'bank' }, includeAudio: true, audioId: 'saved-audio' };
  const rpc = vi.fn(async (type: string) => type === 'queue.list' ? { items: [item], nextCursor: null } : {}) as UiRpc;
  await act(async () => root.render(<QueueApp rpc={rpc} />));
  const confirm = [...node.querySelectorAll('button')].find(b => b.textContent === 'Подтверждаю: добавить новую заметку несмотря на дубликат')!;
  await act(async () => confirm.click());
  expect(vi.mocked(rpc).mock.calls.find(c => c[0] === 'anki.addNote')?.[1]).toEqual({ operationId: item.operationId, draft: item.draft, includeAudio: true, audioId: item.audioId, duplicateAction: 'add_new' });
  expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'queue.list')).toHaveLength(2);
});

it('AnkiConnect key uses session default and clears trusted input without readback', async () => {
  const rpc = vi.fn(async () => ({})) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const input = node.querySelector<HTMLInputElement>('input[name=anki-key]')!;
  input.value = 'mock-test-only-key';
  await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(input.value).toBe('');
  expect(vi.mocked(rpc).mock.calls.find(c => c[0] === 'settings.update')?.[1]).toEqual({ patch: {}, ankiKey: 'mock-test-only-key', persistAnkiKey: false });
  const clear = [...node.querySelectorAll('button')].find(b => b.textContent === 'Удалить ключ AnkiConnect')!;
  await act(async () => clear.click());
  expect(vi.mocked(rpc).mock.calls.filter(c => c[0] === 'settings.update').at(-1)?.[1]).toEqual({ patch: {}, ankiKey: null });
  expect(node.textContent).not.toContain('mock-test-only-key');
});
it('OpenAI key setup is simple, safe, and never tests the provider automatically', async () => {
  const rpc = vi.fn(async (type: string) => type === 'settings.getPublic' ? { hasOpenAIKey: false } : type === 'providers.test' ? { ok: true, error: null } : { configured: true }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  expect(node.textContent).toContain('Ключ не настроен');
  const input = node.querySelector<HTMLInputElement>('input[name=openai-key]')!;
  const check = [...input.form!.querySelectorAll('button')].find(b => b.textContent === 'Проверить подключение')!;
  expect(check.disabled).toBe(true);
  input.value = 'mock-openai-key-not-a-secret';
  await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(input.value).toBe('');
  expect(node.textContent).toContain('Ключ настроен (значение скрыто)');
  expect(node.textContent).not.toContain('mock-openai-key-not-a-secret');
  expect(vi.mocked(rpc).mock.calls.map(c => c[0])).toEqual(['settings.getPublic', 'secrets.setOpenAIKey']);
  expect(vi.mocked(rpc).mock.calls[1][1]).toEqual({ key: 'mock-openai-key-not-a-secret', persist: false });
  expect(check.disabled).toBe(false);
  await act(async () => check.click());
  expect(vi.mocked(rpc).mock.calls.at(-1)).toEqual(['providers.test', { provider: 'openai', allowPaidTest: false }]);
  const clear = [...input.form!.querySelectorAll('button')].find(b => b.textContent === 'Удалить ключ')!;
  await act(async () => clear.click());
  expect(node.textContent).toContain('Ключ не настроен');
  expect(check.disabled).toBe(true);
});
it('shows configured status from safe public metadata without key readback', async () => {
  const rpc = vi.fn(async () => ({ hasOpenAIKey: true })) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  expect(node.textContent).toContain('Ключ настроен (значение скрыто)');
  expect(node.querySelector<HTMLInputElement>('input[name=openai-key]')!.value).toBe('');
  expect(vi.mocked(rpc).mock.calls.map(c => c[0])).toEqual(['settings.getPublic']);
});
