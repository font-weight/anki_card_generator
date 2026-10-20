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
it('test endpoint is read-only and is never written into production settings', async () => {
  const rpc = vi.fn(async () => ({ hasOpenAIKey: false, ankiEndpoint: 'http://127.0.0.1:18765', defaultDeck: 'Test' })) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const endpoint = [...node.querySelectorAll<HTMLSelectElement>('select')].find(select => select.value === 'http://127.0.0.1:18765')!;
  expect(endpoint.disabled).toBe(true);
  expect(node.textContent).toContain('Тестовый режим: используется изолированный AnkiConnect');
  const save = [...node.querySelectorAll('button')].find(button => button.textContent === 'Сохранить настройки')!;
  await act(async () => save.click());
  const patch = vi.mocked(rpc).mock.calls.find(call => call[0] === 'settings.update')?.[1]?.patch as Record<string, unknown>;
  expect(patch).not.toHaveProperty('ankiEndpoint');
  expect(JSON.stringify(patch)).not.toContain('18765');
});
it('repair endpoint requires explicit acknowledgement and preserves queue review warning after save', async () => {
  const { attachRpcWarnings } = await import('../../apps/extension/src/runtime/rpc-metadata');
  const rpc = vi.fn(async (type: string) => attachRpcWarnings({ defaultDeck: 'Test', ankiEndpoint: 'http://127.0.0.1:8765', hasOpenAIKey: false }, type === 'settings.getPublic' ? ['SETTINGS_REPAIR_REQUIRED', 'ANKI_QUEUE_REVIEW_REQUIRED'] : ['ANKI_QUEUE_REVIEW_REQUIRED'])) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const save = [...node.querySelectorAll('button')].find(b => b.textContent === 'Сохранить настройки')!;
  const diagnose = [...node.querySelectorAll('button')].find(b => b.textContent === 'Проверить Anki и получить колоды')!;
  const createDeck = [...node.querySelectorAll('button')].find(b => b.textContent === 'Создать указанную колоду (явное действие)')!;
  expect(save.disabled).toBe(true); expect(diagnose.disabled).toBe(true); expect(createDeck.disabled).toBe(true);
  expect(node.textContent).toContain('а не активное подключение');
  const acknowledgement = [...node.querySelectorAll('label')].find(label => label.textContent?.includes('Я проверил выбранный адрес'))!.querySelector<HTMLInputElement>('input')!;
  await act(async () => acknowledgement.click());
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(node.textContent).not.toContain('Нужно восстановить настройки AnkiConnect');
  expect(node.textContent).toContain('Старые операции Anki требуют проверки');
  expect(diagnose.disabled).toBe(false);
  expect(vi.mocked(rpc).mock.calls.map(c => c[0])).toEqual(['settings.getPublic', 'settings.update']);
});
it('changing repair endpoint resets acknowledgement rather than approving a different destination', async () => {
  const { attachRpcWarnings } = await import('../../apps/extension/src/runtime/rpc-metadata');
  const rpc = vi.fn(async () => attachRpcWarnings({ defaultDeck: 'Test', ankiEndpoint: 'http://127.0.0.1:8765' }, ['SETTINGS_REPAIR_REQUIRED'])) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const save = [...node.querySelectorAll('button')].find(b => b.textContent === 'Сохранить настройки')!;
  const acknowledgement = [...node.querySelectorAll('label')].find(label => label.textContent?.includes('Я проверил выбранный адрес'))!.querySelector<HTMLInputElement>('input')!;
  await act(async () => acknowledgement.click());
  const endpoint = [...node.querySelectorAll<HTMLSelectElement>('select')].find(select => select.value === 'http://127.0.0.1:8765')!;
  await act(async () => { endpoint.value = 'http://localhost:8765'; endpoint.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(acknowledgement.checked).toBe(false); expect(save.disabled).toBe(true);
});
it('queue shows review warning, retains the original snapshot, and surfaces rejected retry', async () => {
  const { attachRpcWarnings } = await import('../../apps/extension/src/runtime/rpc-metadata');
  const item = { operationId: 'old-op', state: 'failed', draft: { expression: 'bank', deckName: 'Original deck', mode: 'recognition', selectedSense: { translations: ['берег'] }, context: { sentence: 'The bank was green.' }, source: { title: 'Original source' } }, lastError: { message: 'Старая операция требует проверки.' }, noteId: null };
  const original = JSON.stringify(item);
  const rpc = vi.fn(async (type: string) => { if (type === 'queue.retry') throw new Error('Повторная отправка заблокирована до проверки старой операции.'); return attachRpcWarnings({ items: [item], nextCursor: null }, ['ANKI_QUEUE_REVIEW_REQUIRED']); }) as UiRpc;
  await act(async () => root.render(<QueueApp rpc={rpc} />));
  expect(node.textContent).toContain('Это не обычная очередь для повторной отправки');
  expect(node.textContent).toContain('Original deck');
  expect(node.textContent).toContain('The bank was green.');
  const retry = [...node.querySelectorAll('button')].find(button => button.textContent === 'Повторить отправку')!;
  await act(async () => retry.click());
  expect(node.textContent).toContain('Повторная отправка заблокирована до проверки старой операции.');
  expect(node.textContent).toContain('Это не обычная очередь для повторной отправки');
  expect(JSON.stringify(item)).toBe(original);
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['queue.list', 'queue.retry']);
});
it('offers the canonical language registry and CEFR, including same-language study', async () => {
  const rpc = vi.fn(async () => ({ sourceLanguage: 'en', targetLanguage: 'ru', learnerLevel: 'B1', dialect: 'en-US', defaultDeck: 'Test' })) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const selectFor = (label: string) => [...node.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector<HTMLSelectElement>('select')!;
  const source = selectFor('Язык текста'); const target = selectFor('Язык перевода'); const level = selectFor('Уровень изучаемого языка (CEFR)');
  expect(source.options.length).toBe(17); expect(target.options.length).toBe(17); expect(level.options.length).toBe(6);
  await act(async () => { source.value = 'ar'; source.dispatchEvent(new Event('change', { bubbles: true })); target.value = 'ar'; target.dispatchEvent(new Event('change', { bubbles: true })); level.value = 'A2'; level.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(node.textContent).toContain('Одноязычный режим');
  expect(node.textContent).not.toContain('Произношение английского');
  expect(vi.mocked(rpc).mock.calls).toHaveLength(1);
  await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Сохранить настройки')!.click());
  expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'settings.update')?.[1]?.patch).toMatchObject({ sourceLanguage: 'ar', targetLanguage: 'ar', learnerLevel: 'A2', dialect: 'ar-SA' });
});

it('waits for settings hydration before allowing edits, save, or diagnostics', async () => {
  let resolve!: (value: unknown) => void;
  const rpc = vi.fn(() => new Promise(value => { resolve = value; })) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const save = [...node.querySelectorAll('button')].find(button => button.textContent === 'Сохранить настройки')!;
  const source = [...node.querySelectorAll('label')].find(label => label.firstChild?.textContent === 'Язык текста')!.querySelector('select')!;
  const check = [...node.querySelectorAll('button')].find(button => button.textContent === 'Проверить Anki и получить колоды')!;
  expect(source.matches(':disabled')).toBe(true);
  expect(check.matches(':disabled')).toBe(true);
  expect(save.disabled).toBe(true);
  await act(async () => { save.click(); check.click(); });
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic']);
  await act(async () => resolve({ sourceLanguage: 'ja', targetLanguage: 'ru', learnerLevel: 'A2', dialect: 'ja-JP', defaultDeck: 'Test' }));
  expect(source.value).toBe('ja');
  expect(source.matches(':disabled')).toBe(false);
  expect(save.disabled).toBe(false);
});

it('keeps failed settings reads gated and allows an explicit safe retry', async () => {
  const rpc = vi.fn().mockRejectedValueOnce(new Error('Настройки недоступны')).mockResolvedValue({ sourceLanguage: 'zh', targetLanguage: 'ar', learnerLevel: 'B2', dialect: 'zh-CN' }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const save = [...node.querySelectorAll('button')].find(button => button.textContent === 'Сохранить настройки')!;
  expect(save.disabled).toBe(true);
  expect(node.textContent).toContain('Настройки недоступны');
  await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Повторить загрузку настроек')!.click());
  expect(save.disabled).toBe(false);
  expect(node.textContent).not.toContain('Настройки недоступны');
  expect(node.textContent).toContain('стандартный мандаринский');
  expect(node.textContent).toContain('современный литературный арабский (MSA)');
  expect(node.textContent).toContain('не сертифицированная оценка');
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'settings.getPublic']);
});

it('explains cancelled queue operations as local only without promising remote deletion', async () => {
  const item = { operationId: 'local-cancelled', state: 'cancelled', draft: { expression: 'bank' } };
  const rpc = vi.fn(async () => ({ items: [item], nextCursor: null })) as UiRpc;
  await act(async () => root.render(<QueueApp rpc={rpc} />));
  expect(node.textContent).toContain('Отменено локально');
  expect(node.textContent).toContain('не проверяет, не изменяет и не удаляет заметку в Anki');
  expect(node.textContent).toContain('исходное место назначения');
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['queue.list']);
});

it('warns about the original Anki destination before locally cancelling uncertain operations', async () => {
  const item = { operationId: 'uncertain', state: 'failed', draft: { expression: 'bank' } };
  const rpc = vi.fn(async (type: string) => type === 'queue.list' ? { items: [item], nextCursor: null } : {}) as UiRpc;
  await act(async () => root.render(<QueueApp rpc={rpc} />));
  expect(node.textContent).toContain('проверьте исходный адрес AnkiConnect и колоду');
  await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Отменить локальную операцию')!.click());
  expect(vi.mocked(rpc).mock.calls.find(call => call[0] === 'queue.cancel')?.[1]).toEqual({ operationId: 'uncertain' });
});

it('requires independent explicit consent for legacy v1 setup while ordinary setup remains v2', async () => {
  const rpc = vi.fn(async () => ({})) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const v2 = [...node.querySelectorAll('button')].find(button => button.textContent === 'Создать собственные типы заметок')!;
  const v1 = [...node.querySelectorAll('button')].find(button => button.textContent === 'Создать прежние типы v1 для старой очереди')!;
  const consent = (version: 1 | 2) => [...node.querySelectorAll('label')].find(label => label.textContent?.includes(version === 1 ? 'Отдельно разрешаю создать отсутствующие прежние типы' : 'Разрешаю создать многоязычные типы'))!.querySelector<HTMLInputElement>('input')!;
  expect(v1.disabled).toBe(true); expect(v2.disabled).toBe(true);
  const recovery = v1.closest('details')!;
  expect(recovery.open).toBe(false);
  await act(async () => { recovery.open = true; v1.click(); v2.click(); });
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic']);
  await act(async () => consent(2).click());
  expect(v2.disabled).toBe(false); expect(v1.disabled).toBe(true);
  await act(async () => v2.click());
  expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.initializeModels').map(call => call[1])).toEqual([{ modelVersion: 2 }]);
  expect(consent(1).checked).toBe(false);
  await act(async () => { consent(2).click(); consent(1).click(); });
  expect(v1.disabled).toBe(false); expect(v2.disabled).toBe(true);
  await act(async () => v1.click());
  expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.initializeModels').map(call => call[1])).toEqual([{ modelVersion: 2 }, { modelVersion: 1 }]);
  expect(node.textContent).toContain('не преобразует сохранённые операции и не отправляет очередь автоматически');
  expect(node.textContent).toContain('Прежние типы v1 подготовлены');
  expect(vi.mocked(rpc).mock.calls.some(call => ['queue.retry', 'anki.addNote', 'settings.update'].includes(call[0]))).toBe(false);
});

it('does not initialize missing v1 or v2 models merely by inspecting Anki configuration', async () => {
  const rpc = vi.fn(async (type: string) => type === 'anki.configuration' ? { deckNames: ['Test'], models: ['EnglishReader.Recognition.v1', 'EnglishReader.Cloze.v1', 'LanguageReader.Recognition.v2', 'LanguageReader.Cloze.v2'].map(modelName => ({ modelName, exists: false, compatible: false })) } : {}) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Проверить Anki и получить колоды')!.click());
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic', 'anki.configuration']);
  expect([...node.querySelectorAll<HTMLInputElement>('label input[type=checkbox]')].every(input => !input.checked)).toBe(true);
});

it('keeps legacy model setup blocked while the saved Anki destination requires repair', async () => {
  const { attachRpcWarnings } = await import('../../apps/extension/src/runtime/rpc-metadata');
  const rpc = vi.fn(async () => attachRpcWarnings({ ankiEndpoint: 'http://127.0.0.1:8765' }, ['SETTINGS_REPAIR_REQUIRED'])) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const consent = [...node.querySelectorAll('label')].find(label => label.textContent?.includes('Отдельно разрешаю создать отсутствующие прежние типы'))!.querySelector<HTMLInputElement>('input')!;
  const v1 = [...node.querySelectorAll('button')].find(button => button.textContent === 'Создать прежние типы v1 для старой очереди')!;
  await act(async () => consent.click());
  expect(v1.disabled).toBe(true);
  await act(async () => v1.click());
  expect(vi.mocked(rpc).mock.calls.map(call => call[0])).toEqual(['settings.getPublic']);
});

it('shows a legacy model conflict without changing version or retrying setup automatically', async () => {
  const rpc = vi.fn(async (type: string) => { if (type === 'anki.initializeModels') throw new Error('Конфликт существующего типа v1: схема оставлена без изменений.'); return {}; }) as UiRpc;
  await act(async () => root.render(<SettingsApp rpc={rpc} />));
  const consent = [...node.querySelectorAll('label')].find(label => label.textContent?.includes('Отдельно разрешаю создать отсутствующие прежние типы'))!.querySelector<HTMLInputElement>('input')!;
  await act(async () => consent.click());
  await act(async () => [...node.querySelectorAll('button')].find(button => button.textContent === 'Создать прежние типы v1 для старой очереди')!.click());
  expect(node.textContent).toContain('Конфликт существующего типа v1');
  expect(node.textContent).not.toContain('Прежние типы v1 подготовлены');
  expect(vi.mocked(rpc).mock.calls.filter(call => call[0] === 'anki.initializeModels').map(call => call[1])).toEqual([{ modelVersion: 1 }]);
});
