import { useEffect, useRef } from 'react';
import { useThemePreset, useThemeTransitionStrategy } from './presets';
import { readMotionTime, readMotionValue } from './motion';
import { announceLive } from './live-announcer';
import type { ThemeTransitionStrategy } from './theme-transition';

/** v6 demo §5.3：旧配色副本整体淡出（theme-reveal / ease-standard），theme-total 时移除；
 *  图片框从副本中挖空，立绘全程只由真实页面绘制（不随主题重新着色）；
 *  切换期间的数据属性让真实页面关闭过渡，结束时不闪；连续点击由框架的 isCurrent/cleanup 裁决只保留最后一次。 */
const WELLS = '.config-portrait,.nd-outfit-thumb,.nd-import-thumb,.nd-image-figure img';

const configThemeTransition: ThemeTransitionStrategy = ({ from, to, commit, finish, isCurrent }) => {
  const shell = document.querySelector<HTMLElement>('.studio-shell');
  if (!shell) return;
  const height = window.innerHeight;
  const width = window.innerWidth;
  const veil = shell.cloneNode(true) as HTMLElement;
  veil.removeAttribute('id');
  veil.setAttribute('aria-hidden', 'true');
  veil.inert = true;
  veil.dataset.uiPreset = from;
  veil.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'));
  veil.querySelectorAll<HTMLElement>('[data-ui-preset]').forEach(element => { element.dataset.uiPreset = from; });
  Object.assign(veil.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '9000', pointerEvents: 'none', margin: '0' });

  // 副本只是旧配色的视觉快照：复制控件当前值与滚动位置，避免编辑中的草稿被重置。
  const source = shell.querySelectorAll<HTMLElement>('input,textarea,select');
  const copies = veil.querySelectorAll<HTMLElement>('input,textarea,select');
  source.forEach((element, index) => {
    const copy = copies[index];
    if (element instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      if (element.type !== 'file') copy.value = element.value;
      copy.checked = element.checked;
    } else if (element instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) copy.value = element.value;
    else if (element instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) copy.value = element.value;
  });
  const sourceAll = shell.querySelectorAll<HTMLElement>('*');
  const copyAll = veil.querySelectorAll<HTMLElement>('*');
  sourceAll.forEach((element, index) => {
    const other = copyAll[index];
    if (other && (element.scrollTop || element.scrollLeft)) {
      other.scrollTop = element.scrollTop;
      other.scrollLeft = element.scrollLeft;
    }
  });

  // 图片框挖空：subtract 掩掉每个立绘／缩略图，真实页面始终显示原图。
  const wells = [...shell.querySelectorAll<HTMLElement>(WELLS)]
    .map(element => element.getBoundingClientRect())
    .filter(box => box.width > 2 && box.height > 2 && box.bottom > 0 && box.top < height && box.right > 0 && box.left < width);
  if (wells.length) {
    veil.style.maskImage = ['linear-gradient(#000,#000)', ...wells.map(() => 'linear-gradient(#000,#000)')].join(',');
    veil.style.maskPosition = ['0 0', ...wells.map(box => `${Math.floor(box.left) - 1}px ${Math.floor(box.top) - 1}px`)].join(',');
    veil.style.maskSize = ['100% 100%', ...wells.map(box => `${Math.ceil(box.width) + 2}px ${Math.ceil(box.height) + 2}px`)].join(',');
    veil.style.maskComposite = ['subtract', ...wells.map(() => 'add')].join(',');
    veil.style.maskRepeat = 'no-repeat';
  }

  document.body.append(veil);
  document.documentElement.dataset.configSwitching = '';
  const reveal = readMotionTime(shell, '--nd-semantic-motion-theme-reveal', 400) || 400;
  const total = readMotionTime(shell, '--nd-semantic-motion-theme-total', 550) || 550;
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    animation?.cancel();
    window.clearTimeout(timer);
    veil.remove();
    delete document.documentElement.dataset.configSwitching;
  };
  const finishOnce = () => {
    if (!isCurrent()) { cleanup(); return; }
    cleanup();
    finish();
  };

  commit(to);
  // 整页副本 opacity 1 → 0，缓动取 ease-standard；theme-total 时移除副本并收尾。
  const animation = veil.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: reveal,
    easing: readMotionValue(shell, '--nd-semantic-motion-ease-standard', 'ease'),
    fill: 'forwards',
  });
  const timer = window.setTimeout(finishOnce, total);
  return cleanup;
};

/** 只在两个配置页可见时接管主题，其他页面保留各自策略。 */
export function ConfigThemeTransition() {
  useThemeTransitionStrategy(configThemeTransition);
  // 播报放在组件层监听 preset，覆盖正常过渡与 reduced 直切两条路径（demo 两者都 announce）。
  const { preset } = useThemePreset();
  const last = useRef(preset);
  useEffect(() => {
    if (last.current === preset) return;
    last.current = preset;
    announceLive(`已切换到${preset === 'nightwave' ? '夜间' : '日间'}`);
  }, [preset]);
  return null;
}
