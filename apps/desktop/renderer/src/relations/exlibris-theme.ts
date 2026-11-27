import type { ThemeTransitionStrategy } from '../ui/theme-transition';
import { remainingThemeTime } from '../ui/theme-deadline';
import { readMotionTime } from '../ui/motion';
import { buildFoldMarks } from './fold-marks';

function reduced(): boolean {
  const root = document.documentElement;
  return root.dataset.motion === 'reduced'
    || (root.dataset.motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 顶部主题胶囊走这条转场：纸背暖光掠过，横线收向书页内的刻度。不锁导航。 */
export const exlibrisThemeTransition: ThemeTransitionStrategy = (request) => {
  const page = document.querySelector<HTMLElement>('.exlibris');
  if (!page || !page.isConnected || reduced()) {
    request.commit(request.to);
    request.finish();
    return () => {};
  }
  const leaf = page.querySelector<HTMLElement>('.leaf.right');
  const strip = page.querySelector<HTMLElement>('.edition-strip');
  const morph = page.querySelector<HTMLElement>('.fold-morph');
  const toNight = request.to === 'nightwave';
  if (leaf && morph) {
    const leafRect = leaf.getBoundingClientRect();
    const stripRect = strip?.getBoundingClientRect();
    const ticks = Array.from(strip?.querySelectorAll('.scale-ticks i') ?? [])
      .map(tick => tick.getBoundingClientRect()).filter(rect => rect.width > 0);
    const marks = buildFoldMarks(leafRect, stripRect ?? null, ticks.length || 41);
    morph.replaceChildren(...marks.map(mark => {
      const tick = ticks[mark.index];
      const bar = document.createElement('i');
      bar.style.setProperty('--fold-order', String(mark.index / (marks.length - 1)));
      bar.style.setProperty('--line-x', `${mark.lineX}px`);
      bar.style.setProperty('--line-y', `${mark.lineY}px`);
      bar.style.setProperty('--line-w', String(mark.lineW));
      bar.style.setProperty('--tick-x', `${tick?.left ?? mark.tickX}px`);
      bar.style.setProperty('--tick-y', `${tick?.top ?? mark.tickY}px`);
      bar.style.setProperty('--tick-h', String(tick?.height ?? mark.tickH));
      return bar;
    }));
    morph.className = `fold-morph ${toNight ? 'to-night' : 'to-day'}`;
  }
  document.documentElement.dataset.themeTransition = 'relationship-journal';
  document.dispatchEvent(new CustomEvent('exlibris-fold', { detail: { on: true, reverse: !toNight } }));
  const scene = readMotionTime(page, '--nd-semantic-motion-scene', 900);
  const commitTimer = window.setTimeout(() => { if (request.isCurrent()) request.commit(request.to); },
    remainingThemeTime(request.startedAt, scene * 0.4));
  const finishTimer = window.setTimeout(request.finish, remainingThemeTime(request.startedAt, scene * 0.95));
  return () => {
    window.clearTimeout(commitTimer);
    window.clearTimeout(finishTimer);
    morph?.replaceChildren();
    if (morph) morph.className = 'fold-morph';
    delete document.documentElement.dataset.themeTransition;
    document.dispatchEvent(new CustomEvent('exlibris-fold', { detail: { on: false, reverse: false } }));
  };
};
