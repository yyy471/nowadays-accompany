import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider, ModalLayerProvider, MotionPolicyProvider } from './ui';
import { ThemePresetProvider } from './ui/presets';
import { App } from './App';
import { applyMotionPreference, readMotionPreference } from './preferences';
import './styles.css';
import './ui/theme.css';
import './ui/character-tokens.css';
import './ui/motion-reduced.css';
import './ui/character-theme.css';
import './styles/shell.css';
import './styles/home.css';
import './styles/appearance.css';
import './styles/voice.css';
import './styles/image.css';
import './styles/settings-workspace.css';
import './styles/relations-exlibris.css';
import './styles/conversation.css';
import './ui/preset-appearance.css';
import './ui/relationship-journal.css';
import './ui/relationship-journal-integration.css';
import './ui/relationship-journal-transition.css';
import './studio-overrides.css';

applyMotionPreference(readMotionPreference());
createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionPolicyProvider><ModalLayerProvider><ThemePresetProvider><ConfirmProvider><App /></ConfirmProvider></ThemePresetProvider></ModalLayerProvider></MotionPolicyProvider></StrictMode>
);
