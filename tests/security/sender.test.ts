import { describe, expect, it } from 'vitest';
import { classifySender } from '../../apps/extension/src/runtime/sender';
const id = 'a'.repeat(32);
const extension = (url:string, frameId?:number):chrome.runtime.MessageSender => ({id,url:`chrome-extension://${id}${url}`,frameId});
describe('RPC sender trust boundary', () => {
  it.each(['/settings.html','/library.html','/queue.html','/action.html'])('trusts only allowed extension page %s', path => {
    expect(classifySender(extension(path,0),id)).toBe('trusted');
    expect(classifySender(extension(path),id)).toBe('trusted');
  });
  it('never treats same-extension content script identity as admin authority', () => {
    expect(classifySender({id,url:'https://example.org/settings.html',tab:{id:1} as chrome.tabs.Tab,frameId:0},id)).toBe('content');
  });
  it.each(['/book.xhtml','/settings.html/evil','/offscreen.html'])('rejects nonallowlisted extension page %s', path => expect(classifySender(extension(path,0),id)).toBe('rejected'));
  it('rejects nested frame as privileged page', () => expect(classifySender(extension('/settings.html',1),id)).toBe('rejected'));
  it('rejects another extension, missing identity, malformed or absent URL', () => {
    for (const sender of [{id:'b'.repeat(32),url:`chrome-extension://${id}/settings.html`,frameId:0},{url:`chrome-extension://${id}/settings.html`,frameId:0},{id,url:'not a url'},{id}]) expect(classifySender(sender,id)).toBe('rejected');
  });
  it('requires a tab for external content and rejects file/data URLs', () => {
    for (const url of ['https://example.org','data:text/html,hello','file:///C:/book.html']) expect(classifySender({id,url},id)).toBe('rejected');
  });
});
