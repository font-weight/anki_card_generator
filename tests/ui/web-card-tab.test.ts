import {act} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {exerciseTabReturn,openTestChat} from './card-tab-fixture';
import * as actions from '../../apps/extension/src/ui/user-actions';

beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  vi.spyOn(actions,'isTrustedUiEvent').mockReturnValue(true);
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',()=>1);
  vi.stubGlobal('cancelAnimationFrame',()=>{});
});
afterEach(async()=>{
  await act(async()=>window.dispatchEvent(new Event('pagehide')));
  document.body.replaceChildren();
  vi.restoreAllMocks();vi.unstubAllGlobals();
});

it('keeps the mounted website chat across a tab round trip; pagehide separately cancels and discards it',async()=>{
  // An inactive website tab has no tabs API. Simulate actual browser metadata
  // as well as its visibility, so the former forced-close path would be exercised.
  let active=true;
  vi.stubGlobal('chrome',{runtime:{id:'own',sendMessage:vi.fn(async()=>({active})),
    onMessage:{addListener:vi.fn(),removeListener:vi.fn()}}});
  const visible=vi.spyOn(document,'visibilityState','get');
  const hidden=vi.spyOn(document,'hidden','get');
  const card=await openTestChat(document,'bank');
  await exerciseTabReturn(card,away=>{
    active=!away;visible.mockReturnValue(away?'hidden':'visible');hidden.mockReturnValue(away);
    window.dispatchEvent(new Event(away?'blur':'focus'));document.dispatchEvent(new Event('visibilitychange'));
  });
  await card.send('Что дальше?');
  await act(async()=>window.dispatchEvent(new Event('pagehide')));
  expect(card.turns[2].signal?.aborted).toBe(true);
  expect(card.closed()).toBe(1);expect(card.host.isConnected).toBe(false);
  await card.finish(2,'Ответ после ухода со страницы');
  const reopened=await openTestChat(document,'bank');
  expect(reopened.shadow.querySelector('[role=log]')?.textContent).toBe('');
  expect(reopened.field.value).toBe('');
  await reopened.close();
});

it('replacing the card with a different word drops the draft and ignores the previous late answer',async()=>{
  const old=await openTestChat(document,'bank');
  await old.send('Раньше здесь был вопрос.');await old.edit('Старый черновик');
  const next=await openTestChat(document,'quay');
  expect(old.host.isConnected).toBe(false);expect(old.closed()).toBe(1);
  expect(old.turns[0].signal?.aborted).toBe(true);
  await old.finish(0,'Ответ старого слова');
  expect(next.field.value).toBe('');
  expect(next.shadow.querySelector('[role=log]')?.textContent).toBe('');
  expect(next.turns).toHaveLength(0);expect(next.closed()).toBe(0);
  await next.close();
});
