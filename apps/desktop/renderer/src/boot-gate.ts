import { readThemePreset, syncWindowTheme } from './ui/theme-storage';
import { applyMotionPreference, readMotionPreference } from './preferences';
import lightMark from './assets/brand/fold-light.svg';
import darkMark from './assets/brand/fold-dark.svg';
import './ui/character-tokens.css';
import './ui/fonts.css';
import './styles/boot-gate.css';

const cover = document.querySelector<HTMLElement>('.boot-gate')!;
const status = cover.querySelector<HTMLElement>('[role="status"]')!;
const details = cover.querySelector<HTMLElement>('.boot-details')!;
const elapsed = cover.querySelector<HTMLElement>('.boot-elapsed')!;
const steps = cover.querySelectorAll<HTMLElement>('.boot-steps li');
const retry = cover.querySelector<HTMLButtonElement>('button')!;
const preset = readThemePreset();
cover.dataset.uiPreset = preset;
cover.querySelector<HTMLImageElement>('.boot-mark')!.src = preset === 'nightwave' ? darkMark : lightMark;
applyMotionPreference(readMotionPreference());

function advance(phase: 'service' | 'workspace', message: string) {
  cover.dataset.phase = phase;
  status.textContent = message;
  const current = phase === 'service' ? 1 : 2;
  steps.forEach((step, index) => {
    step.dataset.state = index < current ? 'done' : index === current ? 'now' : 'waiting';
    if (index === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

function turnPage() {
  cover.dataset.cover = 'opening';
  // 只等封面自己的淡出；减少动效时 CSS 不创建动画，同帧移除。
  const [fade] = cover.getAnimations();
  if (fade) void fade.finished.then(() => cover.remove(), () => cover.remove());
  else cover.remove();
}

async function openDesk() {
  retry.hidden = true;
  advance('service', '正在启动本机服务');
  elapsed.textContent = '';
  const start = performance.now();
  const ticker = window.setInterval(() => {
    elapsed.textContent = `已等待 ${Math.floor((performance.now() - start) / 1000)} 秒`;
  }, 1000);
  // CSSOM 将令牌的时间计算为秒。快启动取消显示，翻页期间也不会闪字。
  const delay = Number.parseFloat(getComputedStyle(details).transitionDelay) * 1000;
  const reveal = window.setTimeout(() => { cover.dataset.details = 'visible'; }, delay);
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
    advance('workspace', '本机服务已就绪，正在翻开资料');
    const { mountDesk } = await import('./main');
    mountDesk(skipRolePicker);
    requestAnimationFrame(() => requestAnimationFrame(turnPage));
  } catch (error) {
    const reason = error instanceof Error && /[\u3400-\u9fff]/u.test(error.message) ? error.message :
      cover.dataset.phase === 'workspace' ? '工作区未能载入，请重新连接。' : '本机服务未能启动，请重新连接。';
    cover.dataset.phase = 'failed';
    cover.dataset.details = 'visible';
    status.textContent = '书房启动失败。' + reason;
    elapsed.textContent = '';
    retry.hidden = false;
    retry.focus();
  } finally {
    window.clearInterval(ticker);
    window.clearTimeout(reveal);
  }
}
retry.addEventListener('click', () => void openDesk());
// 隐藏窗口先合成所选主题的第一帧，再显示并接通后端。
requestAnimationFrame(() => requestAnimationFrame(() => {
  syncWindowTheme(preset);
  void openDesk();
}));
