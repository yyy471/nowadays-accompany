import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfirmProvider } from './ui';
import { applyMotionPreference, readMotionPreference } from './preferences';
import './styles.css';
import './ui/theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

applyMotionPreference(readMotionPreference());

createRoot(root).render(
  <StrictMode>
    <ConfirmProvider><App /></ConfirmProvider>
  </StrictMode>
);
