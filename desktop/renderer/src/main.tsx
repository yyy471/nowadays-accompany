import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfirmProvider } from './ui';
import { ThemePresetProvider } from './ui/presets';
import { DraftProtectionProvider } from './components/DraftProtectionProvider';
import { applyMotionPreference, readMotionPreference } from './preferences';
import './styles.css';
import './ui/theme.css';
import './ui/character-tokens.css';
import './ui/character-theme.css';
import './styles/shell.css';
import './styles/home.css';
import './ui/preset-appearance.css';

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

applyMotionPreference(readMotionPreference());

createRoot(root).render(
  <StrictMode>
    <ThemePresetProvider><ConfirmProvider><DraftProtectionProvider><App /></DraftProtectionProvider></ConfirmProvider></ThemePresetProvider>
  </StrictMode>
);
