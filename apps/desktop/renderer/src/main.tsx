import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider, ModalLayerProvider, MotionPolicyProvider } from './ui';
import { ThemePresetProvider } from './ui/presets';
import { App } from './App';
import './styles.css';
import './ui/theme.css';
import './ui/fonts.css';
import './ui/character-tokens.css';
import './ui/motion-reduced.css';
import './ui/character-theme.css';
import './styles/shell.css';
import './styles/home.css';
import './styles/appearance.css';
import './styles/voice.css';
import './styles/image.css';
import './styles/settings-workspace.css';
import './styles/settings-catalog.css';
import './styles/token-usage.css';
import './styles/role-entry.css';
import './styles/relations-exlibris.css';
import './styles/conversation.css';
import './styles/feed.css';
import './ui/preset-appearance.css';
import './ui/status-dot.css';

export function mountDesk(skipRolePicker: boolean) {
  const root = createRoot(document.getElementById('root')!);
  // 封面翻开前，确保其下方已有 React 提交的工作区或选角页。
  flushSync(() => root.render(
    <StrictMode><MotionPolicyProvider><ModalLayerProvider><ThemePresetProvider><ConfirmProvider><App skipEntry={skipRolePicker}/></ConfirmProvider></ThemePresetProvider></ModalLayerProvider></MotionPolicyProvider></StrictMode>
  ));
}
