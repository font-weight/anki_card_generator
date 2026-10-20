import React from 'react';
import { QueueApp } from './ui';
import { mountPage } from './runtime/page';
import { rpc } from './runtime/rpc-client';
mountPage(<QueueApp rpc={rpc}/>);
