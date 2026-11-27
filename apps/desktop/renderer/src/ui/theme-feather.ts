import type { ThemeTransitionStrategy } from './theme-transition';
import { readMotionTime } from './motion';
import { applySubtractMask, collectWellRects, CONFIG_WELL_SELECTORS } from './dom-mask';
import { remainingThemeTime } from './theme-deadline';

/** 只复制旧纸面的可见分支，活动微页留在真实页面。 */
export const featherThemeTransition: ThemeTransitionStrategy = ({ startedAt, from, to, commit, finish }) => {
  const shell = document.querySelector<HTMLElement>('.studio-shell');
  if (!shell) return;
  const root = document.documentElement;
  const total = Math.min(550, readMotionTime(shell, '--nd-semantic-motion-theme-total', 550));
  const reveal = readMotionTime(shell, '--nd-semantic-motion-theme-reveal', 400);
  const cleanupDeadline = total - 48;
  if (remainingThemeTime(startedAt, cleanupDeadline) === 0) return;
  const layer = document.createElement('div');
  layer.className = 'theme-snapshot';
  layer.inert = true;
  layer.dataset.uiPalette = 'xiacheng';
  layer.dataset.uiPreset = from;
  layer.setAttribute('aria-hidden', 'true');
  const feather = document.createElement('div');
  feather.className = 'theme-feather';
  feather.dataset.direction = to === 'daylight' ? 'down' : 'up';
  const veil = shell.cloneNode(false) as HTMLElement;
  veil.classList.add('config-theme-veil');
  veil.dataset.uiPreset = from;
  const scrollPositions: Array<{ copy: Element; top: number; left: number }> = [];
  function copyChildren(source: Element, target: Element) {
    for (const node of source.childNodes) {
      if (!(node instanceof Element)) {
        target.append(node.cloneNode(false));
        continue;
      }
      if (node.hasAttribute('hidden')) continue;
      if (node instanceof HTMLIFrameElement) {
        const space = document.createElement('span');
        const { width, height } = node.getBoundingClientRect();
        Object.assign(space.style, { display: 'inline-block', width: width + 'px', height: height + 'px' });
        target.append(space);
        continue;
      }
      const copy = node.cloneNode(false) as Element;
      copy.removeAttribute('id');
      copyChildren(node, copy);
      if (node instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
        if (node.type !== 'file') copy.value = node.value;
        copy.checked = node.checked;
      } else if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
        (copy as HTMLTextAreaElement | HTMLSelectElement).value = node.value;
      }
      const top = node.scrollTop, left = node.scrollLeft;
      if (top || left) scrollPositions.push({ copy, top, left });
      target.append(copy);
    }
  }
  copyChildren(shell, veil);
  const wells = collectWellRects(shell, CONFIG_WELL_SELECTORS + ',iframe', undefined, true);
  layer.append(feather);
  feather.append(veil);

  const cleanup = () => {
    window.clearTimeout(timer);
    window.removeEventListener('resize', finish);
    layer.remove();
    delete root.dataset.configSwitching;
    delete root.dataset.switching;
  };
  // 给事件循环留出收尾余量；正常动画在 400ms 终帧即移除。
  const timer = window.setTimeout(finish, remainingThemeTime(startedAt, cleanupDeadline));
  try {
    root.dataset.switching = '';
    root.dataset.configSwitching = '';
    document.body.append(layer);
    for (const { copy, top, left } of scrollPositions) copy.scrollTo(left, top);
    if (wells.length) applySubtractMask(layer, wells);
    commit(to);
    const duration = Math.min(reveal, remainingThemeTime(startedAt, cleanupDeadline));
    if (duration <= 0) { cleanup(); finish(); return cleanup; }
    const animation = feather.animate([{ '--theme-edge': '-8%' }, { '--theme-edge': '108%' }],
      { duration, easing: 'linear', fill: 'both' });
    animation.onfinish = () => { if (layer.isConnected) finish(); };
    window.addEventListener('resize', finish);
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
};
