import React from 'react';
import { createRoot } from 'react-dom/client';
import { openReaderStorage } from '@english-reader/storage';
import { storageOptions } from './runtime/storage-config';
import { ActionMenu } from './action/ActionMenu';
import './action/action.css';

async function readGrammarEnabled() {
  const storage = await openReaderStorage(storageOptions);
  try {
    const preferences = await storage.getMetadata<{grammarEnabled?: boolean}>('preferences');
    return preferences?.grammarEnabled === true;
  } finally { storage.close(); }
}

createRoot(document.getElementById('root')!).render(<ActionMenu readGrammarEnabled={readGrammarEnabled} />);
