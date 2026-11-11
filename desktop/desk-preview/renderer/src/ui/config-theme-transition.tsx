import { useThemeTransitionStrategy } from './presets';
import type { ThemeTransitionStrategy } from './theme-transition';

/** 对照配置原型：从主题按钮扩散，图片区从遮罩中扣除。 */
const configThemeTransition: ThemeTransitionStrategy = ({ from, to, commit, finish, isCurrent }) => {
  const shell = document.querySelector<HTMLElement>('.studio-shell');
  const buttons = document.querySelectorAll<HTMLButtonElement>('.ui-theme-switcher button');
  const trigger = buttons[to === 'daylight' ? 0 : 1];
  if (!shell || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const width = window.innerWidth, height = window.innerHeight, feather = 64;
  const radius = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) + feather + 8;
  const clone = shell.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  clone.dataset.uiPreset = from;
  clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  clone.querySelectorAll<HTMLElement>('[data-ui-preset]').forEach(element => { element.dataset.uiPreset = from; });
  Object.assign(clone.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '9000', pointerEvents: 'none', margin: '0' });
  const source = shell.querySelectorAll('input,textarea,select');
  const copies = clone.querySelectorAll('input,textarea,select');
  source.forEach((element, index) => {
    const copy = copies[index];
    if (element instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      if (element.type !== 'file') copy.value = element.value;
      copy.checked = element.checked;
    } else if (element instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) copy.value = element.value;
    else if (element instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) copy.value = element.value;
  });
  const originalScroll = shell.querySelectorAll<HTMLElement>('*');
  const cloneScroll = clone.querySelectorAll<HTMLElement>('*');
  originalScroll.forEach((element, index) => { const other = cloneScroll[index]; if (other) { other.scrollTop = element.scrollTop; other.scrollLeft = element.scrollLeft; } });
  const wells = [...shell.querySelectorAll<HTMLElement>('.config-portrait,.nd-outfit-thumb,.nd-import-thumb,.nd-image-figure img')]
    .map(element => element.getBoundingClientRect())
    .filter(box => box.width > 2 && box.height > 2 && box.bottom > 0 && box.top < height && box.right > 0 && box.left < width);
  const masks = wells.map(() => 'linear-gradient(#000,#000)');
  const positions = wells.map(box => `${Math.floor(box.left) - 1}px ${Math.floor(box.top) - 1}px`);
  const sizes = wells.map(box => `${Math.ceil(box.width) + 2}px ${Math.ceil(box.height) + 2}px`);
  const setMask = (element: HTMLElement, radial: string) => {
    element.style.maskImage = [radial, ...masks].join(',');
    element.style.maskPosition = ['0 0', ...positions].join(',');
    element.style.maskSize = ['100% 100%', ...sizes].join(',');
    element.style.maskRepeat = 'no-repeat';
    element.style.maskComposite = wells.length ? ['subtract', ...wells.map(() => 'add')].join(',') : 'add';
  };
  const rim = document.createElement('div');
  Object.assign(rim.style, { position: 'fixed', inset: '0', zIndex: '9001', pointerEvents: 'none' });
  setMask(rim, 'linear-gradient(#000,#000)');
  document.body.append(clone, rim);
  document.documentElement.dataset.configSwitching = '';
  let frame = 0;
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    cancelAnimationFrame(frame);
    clone.remove(); rim.remove();
    delete document.documentElement.dataset.configSwitching;
  };
  const started = performance.now();
  const step = (now: number) => {
    if (!isCurrent()) { cleanup(); return; }
    const p = Math.min(1, (now - started) / 900);
    const ease = p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    const r = radius * ease, inner = Math.max(0, r - feather);
    setMask(clone, `radial-gradient(circle at ${cx}px ${cy}px,transparent ${inner}px,#000 ${r}px)`);
    const color = to === 'daylight' ? '255,214,158' : '176,198,255';
    const alpha = Math.max(0, Math.min(1, (.97 - p) / .3)) * (p < .04 ? p / .04 : 1);
    rim.style.background = `radial-gradient(circle at ${cx}px ${cy}px,rgba(${color},0) ${Math.max(0,inner-6)}px,rgba(${color},${.34*alpha}) ${inner+feather*.62}px,rgba(${color},${.12*alpha}) ${r}px,rgba(${color},0) ${r+18}px)`;
    if (p >= 1) { cleanup(); finish(); } else frame = requestAnimationFrame(step);
  };
  commit(to);
  frame = requestAnimationFrame(step);
  return cleanup;
};

/** 只在两个配置页可见时接管主题，其他页面保留各自策略。 */
export function ConfigThemeTransition() {
  useThemeTransitionStrategy(configThemeTransition);
  return null;
}
