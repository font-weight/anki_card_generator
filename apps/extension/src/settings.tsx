import React from 'react';
import { SettingsApp } from './ui';
import { mountPage } from './runtime/page';
import { rpc } from './runtime/rpc-client';
mountPage(<SettingsApp rpc={rpc}/>);
