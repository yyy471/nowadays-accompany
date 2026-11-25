import { useLayoutEffect } from 'react';
import { useThemePreset, useThemeTransitionStrategy } from './presets';
import { readMotionTime, readMotionValue } from './motion';
import { announceLive } from './live-announcer';
import type { ThemeTransitionStrategy } from './theme-transition';
import { applySubtractMask, collectWellRects, CONFIG_WELL_SELECTORS } from './dom-mask';

/** v6 demo §5.3：旧配色副本整体淡出（theme-reveal / ease-standard），theme-total 时移除；
 *  图片框从副本中挖空，立绘全程只由真实页面绘制（不随主题重新着色）；
 *  切换期间的数据属性让真实页面关闭过渡；完成当前揭开后再处理最终选择。 */
const configThemeTransition: ThemeTransitionStrategy = ({ from, to, commit, finish, isCurrent }) => {
  const shell = document.querySelector<HTMLElement>('.studio-shell:not(.config-theme-veil)');
  if (!shell) return;
  const root = document.documentElement;
  const height = window.innerHeight;
  const width = window.innerWidth;
  const veil = shell.cloneNode(true) as HTMLElement;
  veil.removeAttribute('id');
  veil.classList.add('config-theme-veil');
  veil.setAttribute('aria-hidden', 'true');
  veil.inert = true;
  veil.dataset.uiPreset = from;
  veil.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'));
  veil.querySelectorAll<HTMLElement>('[data-ui-preset]').forEach(element => { element.dataset.uiPreset = from; });
  Object.assign(veil.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: 'var(--nd-semantic-layer-theme-transition)', pointerEvents: 'none', margin: '0' });

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
  root.dataset.switching = '';
  root.dataset.configSwitching = '';
  document.body.append(veil);
  sourceAll.forEach((element, index) => {
    const other = copyAll[index];
    if (other && (element.scrollTop || element.scrollLeft)) {
      other.scrollTop = element.scrollTop;
      other.scrollLeft = element.scrollLeft;
    }
  });

  // 图片框挖空：subtract 掩掉每个立绘／缩略图，真实页面始终显示原图。
  const wells = collectWellRects(shell, CONFIG_WELL_SELECTORS, { width, height }, true);
  applySubtractMask(veil, wells);

  const reveal = readMotionTime(shell, '--nd-semantic-motion-theme-reveal', 400);
  const total = readMotionTime(shell, '--nd-semantic-motion-theme-total', 550);
  let frame = 0;
  let timer = 0;
  let animation: Animation | undefined;
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    cancelAnimationFrame(frame);
    animation?.cancel();
    window.clearTimeout(timer);
    window.removeEventListener('resize', finishOnce);
    veil.remove();
    void shell.offsetHeight;
    delete root.dataset.configSwitching;
    delete root.dataset.switching;
  };
  const finishOnce = () => {
    if (!isCurrent()) { cleanup(); return; }
    cleanup();
    finish();
  };
  window.addEventListener('resize', finishOnce);

  commit(to);
  // 保持首个绘制帧为完整旧配色，再揭开真实页面。
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      timer = window.setTimeout(finishOnce, total);
      animation = veil.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: reveal,
        easing: readMotionValue(shell, '--nd-semantic-motion-ease-standard', 'ease'),
        fill: 'forwards',
      });
    });
  });
  return cleanup;
};

configThemeTransition.queueChanges = true;
configThemeTransition.onSettled = preset => announceLive(`已切换到${preset === 'nightwave' ? '夜间' : '日间'}`);

/** 只在两个配置页可见时接管主题，其他页面保留各自策略。 */
export function ConfigThemeTransition() {
  useThemeTransitionStrategy(configThemeTransition);
  const { preset, requestedPreset } = useThemePreset();
  useLayoutEffect(() => {
    document.querySelectorAll<HTMLElement>('.config-theme-veil [data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === requestedPreset));
    });
  }, [preset, requestedPreset]);
  return null;
}
