import type { ThemeTransitionStrategy } from '../ui/theme-transition';

/**
 * 对话页换光：舞台先起光，纸面再按 14 档推进，最后一次性收束。
 * 时序与参考稿一致（stage 40 / palette 360 / end 1200），纸面推进占 820ms，
 * 因此收尾落在 1180ms，仍在换光保护期内，结束帧与过渡最后一帧相同。
 */
const PALETTE_MS = 360;
const END_MS = 1200;
const SWEEP_MS = 820;
const SWEEP_STEPS = 14;

function reduced(): boolean {
  const root = document.documentElement;
  return root.dataset.motion === 'reduced'
    || (root.dataset.motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 把子树钉在指定预置上：元素自带令牌，不跟随根节点的切换。 */
function pin(element: HTMLElement, preset: 'daylight' | 'nightwave'): void {
  element.classList.add('dlg-pal');
  element.dataset.uiTheme = 'xiacheng';
  element.dataset.uiPreset = preset;
}

function unpin(element: HTMLElement): void {
  element.classList.remove('dlg-pal', 'flipped');
  delete element.dataset.uiTheme;
  delete element.dataset.uiPreset;
}

/** 从页面读换色后的纸色；自定义属性已被 var() 替换成真实颜色。 */
function colorOf(element: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color)/.test(value) ? value : fallback;
}

interface SweepRow {
  element: HTMLElement;
  /** 行中点在面板里的相对位置，0 在顶、1 在底。 */
  at: number;
}

/** 只取此刻真正看得见的行：换光推进按读者眼前的顺序走。 */
function collectRows(pane: HTMLElement): { rows: SweepRow[]; history: boolean } {
  const box = pane.getBoundingClientRect();
  if (box.height <= 0) return { rows: [], history: false };
  const rows: SweepRow[] = [];
  const push = (element: Element | null) => {
    if (!(element instanceof HTMLElement) || element.hidden) return;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= box.top || rect.top >= box.bottom) return;
    rows.push({ element, at: clamp01(((rect.top + rect.bottom) / 2 - box.top) / box.height) });
  };
  const scroller = pane.querySelector('.dialogue-messages');
  const history = pane.querySelector<HTMLElement>('.dialogue-history');
  const historyOpen = !!history && !history.hidden;
  if (history && historyOpen) {
    // 历史层盖住整个面板时，逐行推进的是它的分区，而不是被盖住的聊天区。
    for (const child of Array.from(history.children)) push(child);
  } else {
    if (scroller) for (const child of Array.from(scroller.children)) push(child);
    push(pane.querySelector('.dialogue-latest'));
    push(pane.querySelector('.dialogue-date-notice'));
  }
  push(pane.querySelector('.dialogue-zone'));
  return { rows, history: historyOpen };
}

export const dialogueThemeTransition: ThemeTransitionStrategy = (request) => {
  const page = document.querySelector<HTMLElement>('.dialogue-page');
  if (!page || !page.isConnected || reduced()) {
    request.commit(request.to);
    request.finish();
    return () => {};
  }

  const pane = page.querySelector<HTMLElement>('.dialogue-pane');
  const toNight = request.to === 'nightwave';
  const life: number[] = [];
  const steps: number[] = [];
  let swept: HTMLElement[] = [];

  // 舞台先起光：太阳下沉或升起。属性值先清掉，第二次切换才会重新播放。
  delete page.dataset.lightDir;
  void page.offsetWidth;
  page.dataset.lighting = 'true';
  page.dataset.lightDir = toNight ? 'dusk' : 'dawn';

  /** 收尾：全部解钉在关闭过渡的同一帧里落地，颜色不会从旧预置再动画回去。 */
  const releaseSweep = () => {
    for (const id of steps) window.clearTimeout(id);
    steps.length = 0;
    if (!pane) return;
    pane.classList.add('sweep-settle');
    for (const element of swept) unpin(element);
    swept = [];
    pane.classList.remove('sweeping', 'dawn', 'sweeping-history');
    for (const name of ['--sweep-paper', '--sweep-rule', '--band']) pane.style.removeProperty(name);
    unpin(pane);
    void pane.offsetHeight;
    void getComputedStyle(pane).backgroundColor;
    pane.classList.remove('sweep-settle');
  };

  const cleanup = () => {
    for (const id of [...life, ...steps]) window.clearTimeout(id);
    life.length = 0;
    steps.length = 0;
    for (const element of swept) unpin(element);
    swept = [];
    if (pane) {
      pane.classList.remove('sweeping', 'dawn', 'sweeping-history', 'sweep-settle');
      for (const name of ['--sweep-paper', '--sweep-rule', '--band']) pane.style.removeProperty(name);
      unpin(pane);
    }
    delete page.dataset.lighting;
    delete page.dataset.lightDir;
  };

  life.push(window.setTimeout(() => {
    if (!request.isCurrent()) return;
    request.commit(request.to);
    if (!pane) return;
    const { rows, history } = collectRows(pane);
    const paper = colorOf(page, '--dlg-paper', toNight ? '#202836' : '#FFFCF7');
    const rule = colorOf(page, '--dlg-rule', toNight ? '#3D4657' : '#DDCFD0');
    // 面板整体先留在旧预置，纸面靠色带推进；每行在色带到达时才换成新预置，
    // 所以每一行要么是「旧纸旧字」、要么是「新纸新字」，不会出现灰字压灰纸。
    pin(pane, request.from);
    pane.style.setProperty('--sweep-paper', paper);
    pane.style.setProperty('--sweep-rule', rule);
    pane.classList.toggle('dawn', !toNight);
    // 历史层是整面板覆盖，推进期间要把下面的聊天区藏掉，色带才不会被两层内容叠住。
    pane.classList.toggle('sweeping-history', history);
    pane.classList.add('sweeping');
    const slot = SWEEP_MS / SWEEP_STEPS;
    const byStep: HTMLElement[][] = Array.from({ length: SWEEP_STEPS + 1 }, () => []);
    for (const row of rows) {
      const progress = toNight ? row.at : 1 - row.at;
      const step = Math.max(1, Math.min(SWEEP_STEPS, Math.ceil(progress * SWEEP_STEPS)));
      byStep[step].push(row.element);
      swept.push(row.element);
    }
    pane.style.setProperty('--band', '0%');
    for (let step = 1; step <= SWEEP_STEPS; step += 1) {
      steps.push(window.setTimeout(() => {
        if (!request.isCurrent()) return;
        pane.style.setProperty('--band', `${(step / SWEEP_STEPS * 100).toFixed(2)}%`);
        for (const element of byStep[step]) {
          pin(element, request.to);
          element.classList.add('flipped');
        }
        if (step === SWEEP_STEPS) releaseSweep();
      }, step * slot));
    }
  }, PALETTE_MS));

  life.push(window.setTimeout(() => {
    if (!request.isCurrent()) return;
    releaseSweep();
    request.finish();
  }, END_MS));

  return cleanup;
};
