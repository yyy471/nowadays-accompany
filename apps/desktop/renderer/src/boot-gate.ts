import { readThemePreset, syncWindowTheme } from './ui/theme-storage';
import './ui/character-tokens.css';
import './styles/boot-gate.css';

const cover = document.querySelector<HTMLElement>('.boot-gate')!;
const status = cover.querySelector<HTMLElement>('[role="status"]')!;
const retry = cover.querySelector<HTMLButtonElement>('button')!;
const preset = readThemePreset();
cover.dataset.uiPreset = preset;

async function openDesk() {
  retry.hidden = true;
  status.textContent = '正在连接本地服务…';
  try {
    let skipRolePicker = false;
    if (window.nowadaysDesk) {
      const result = await window.nowadaysDesk.boot();
      if (!result.ok) throw new Error(result.reason);
      skipRolePicker = result.skipRolePicker;
    } else if (location.protocol === 'desk:') {
      throw new Error('桌面连接尚未建立，请重新打开书房。');
    } else {
      const config = await fetch('/api-config.json').then(response => response.json()).catch(() => null);
      skipRolePicker = config?.skipRolePicker === true;
    }
    const { mountDesk } = await import('./main');
    mountDesk(skipRolePicker);
  } catch (error) {
    status.textContent = '书房启动失败。' + (error instanceof Error ? error.message : '请重试。');
    retry.hidden = false;
    retry.focus();
  }
}
retry.addEventListener('click', () => void openDesk());
// 隐藏窗口先合成所选主题的第一帧，再显示并接通后端。
requestAnimationFrame(() => requestAnimationFrame(() => {
  syncWindowTheme(preset);
  void openDesk();
}));
