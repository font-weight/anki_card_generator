import React from 'react';
import { createRoot } from 'react-dom/client';
import { ActionMenu } from './action/ActionMenu';
import './action/action.css';

createRoot(document.getElementById('root')!).render(<ActionMenu />);
