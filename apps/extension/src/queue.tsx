import React from 'react';
import { QueueApp } from './ui/QueueApp';
import wordBaseCss from './ui/word-base.css?inline';
import { mountPage } from './runtime/page';
import { rpc } from './runtime/rpc-client';
function subscribe(refresh: () => void) {
  const onMessage = (message: {type?: string}, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && !sender.tab && message?.type === 'operation.updated') refresh();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  return () => chrome.runtime.onMessage.removeListener(onMessage);
}
mountPage(<QueueApp rpc={rpc} subscribe={subscribe}/>, wordBaseCss);
