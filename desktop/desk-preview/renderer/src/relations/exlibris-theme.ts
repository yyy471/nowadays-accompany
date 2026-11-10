import type { ThemeTransitionStrategy } from '../ui/theme-transition';
import { buildFoldMarks } from './fold-marks.js';

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
    const marks = buildFoldMarks(leafRect, stripRect ?? null, (stripRect?.width ?? leafRect.width) < 400 ? 25 : 41);
    morph.replaceChildren(...marks.map(mark => {
      const bar = document.createElement('i');
      bar.style.setProperty('--i', String(mark.index));
      bar.style.setProperty('--line-x', `${mark.lineX}px`);
      bar.style.setProperty('--line-y', `${mark.lineY}px`);
      bar.style.setProperty('--line-w', String(mark.lineW));
      bar.style.setProperty('--tick-x', `${mark.tickX}px`);
      bar.style.setProperty('--tick-y', `${mark.tickY}px`);
      bar.style.setProperty('--tick-h', String(mark.tickH));
      return bar;
    }));
    morph.className = `fold-morph ${toNight ? 'to-night' : 'to-day'}`;
  }
  document.documentElement.dataset.themeTransition = 'relationship-journal';
  document.dispatchEvent(new CustomEvent('exlibris-fold', { detail: { on: true, reverse: !toNight } }));
  const commitTimer = window.setTimeout(() => { if (request.isCurrent()) request.commit(request.to); }, 520);
  const finishTimer = window.setTimeout(() => { if (request.isCurrent()) request.finish(); }, 1780);
  return () => {
    window.clearTimeout(commitTimer);
    window.clearTimeout(finishTimer);
    morph?.replaceChildren();
    if (morph) morph.className = 'fold-morph';
    delete document.documentElement.dataset.themeTransition;
    document.dispatchEvent(new CustomEvent('exlibris-fold', { detail: { on: false, reverse: false } }));
  };
};
