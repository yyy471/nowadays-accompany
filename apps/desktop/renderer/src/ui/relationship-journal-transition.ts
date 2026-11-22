import type { ThemeTransitionStrategy } from './theme-transition';

type Rect = { x: number; y: number; w: number; h: number };
type Pair = { line: Rect; tick: Rect };

function cssNumber(value: string | null | undefined): number | undefined {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationMs(page: HTMLElement, name: string): number {
  const value = getComputedStyle(page).getPropertyValue(name).trim();
  const parsed = cssNumber(value);
  if (parsed === undefined) return 0;
  return value.endsWith('ms') ? parsed : parsed * 1000;
}

function rulePitch(image: string): number | undefined {
  if (!image.includes('repeating-linear-gradient')) return undefined;
  const rounded = image.match(/round\(\s*nearest\s*,\s*([\d.]+)px/i);
  if (rounded) return cssNumber(rounded[1]);
  const values = [...image.matchAll(/([\d.]+)px/g)].map((match) => cssNumber(match[1])).filter((value): value is number => value !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

function ruledLines(page: HTMLElement): Rect[] {
  const leaf = page.querySelector<HTMLElement>('.leaf.right');
  if (!leaf) return [];
  const box = leaf.getBoundingClientRect();
  const pseudo = getComputedStyle(leaf, '::before');
  const pitch = rulePitch(pseudo.backgroundImage);
  if (!pitch || pitch <= 0) return [];
  const topInset = cssNumber(pseudo.top) ?? 0;
  const rightInset = cssNumber(pseudo.right) ?? 0;
  const bottomInset = cssNumber(pseudo.bottom) ?? 0;
  const leftInset = cssNumber(pseudo.left) ?? 0;
  const lineBox = {
    x: box.left + leftInset,
    y: box.top + topInset,
    w: Math.max(0, box.width - leftInset - rightInset),
    h: Math.max(0, box.height - topInset - bottomInset)
  };
  const hairline = cssNumber(getComputedStyle(leaf).getPropertyValue('--hp')) ?? 1;
  const lines: Rect[] = [];
  for (let y = lineBox.y + pitch - hairline; y < lineBox.y + lineBox.h; y += pitch) {
    lines.push({ x: lineBox.x, y, w: lineBox.w, h: 1 });
  }
  return lines;
}

function ticks(page: HTMLElement): Array<{ rect: Rect; color: string }> {
  return [...page.querySelectorAll<HTMLElement>('.strip .tk')].map((tick) => {
    const rect = tick.getBoundingClientRect();
    return {
      rect: { x: rect.left, y: rect.top, w: Math.max(1, rect.width), h: Math.max(1, rect.height) },
      color: getComputedStyle(tick).backgroundColor
    };
  }).sort((a, b) => a.rect.x - b.rect.x);
}

function pairLines(lines: Rect[], marks: Array<{ rect: Rect; color: string }>): Pair[] {
  if (!lines.length || !marks.length) return [];
  const perLine = Math.ceil(marks.length / lines.length);
  const segments: Array<{ rect: Rect; center: number }> = [];
  lines.forEach((line) => {
    for (let index = 0; index < perLine; index++) {
      const rect = { ...line, x: line.x + line.w * index / perLine, w: line.w / perLine };
      segments.push({ rect, center: rect.x + rect.w / 2 });
    }
  });
  segments.sort((a, b) => a.center - b.center || a.rect.y - b.rect.y);
  return segments.slice(0, marks.length).map((segment, index) => ({ line: segment.rect, tick: marks[index]!.rect }));
}

function withPreset<T>(page: HTMLElement, preset: 'daylight' | 'nightwave', read: () => T): T {
  const current = page.dataset.uiPreset;
  page.dataset.uiPreset = preset;
  try { return read(); }
  finally {
    if (current) page.dataset.uiPreset = current;
    else delete page.dataset.uiPreset;
  }
}

function pageLineColor(page: HTMLElement): string {
  const leaf = page.querySelector<HTMLElement>('.leaf.right');
  if (!leaf) return getComputedStyle(page).getPropertyValue('--nd-semantic-color-line-decorative').trim();
  const probe = document.createElement('i');
  const xray = leaf.closest('.book')?.classList.contains('xray');
  probe.style.cssText = `position:absolute;width:1px;height:1px;pointer-events:none;background:${xray
    ? 'color-mix(in srgb,var(--carbon) 22%,transparent)'
    : 'color-mix(in srgb,var(--line) 85%,transparent)'}`;
  leaf.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

function place(element: HTMLElement, rect: Rect): void {
  element.style.transform = `translate(${rect.x}px,${rect.y}px) scale(${rect.w},${rect.h})`;
}

function frame(rect: Rect, color: string, opacity = 1, offset?: number): Keyframe {
  const keyframe: Keyframe = {
    transform: `translate(${rect.x}px,${rect.y}px) scale(${rect.w},${rect.h})`,
    backgroundColor: color,
    opacity
  };
  if (offset !== undefined) keyframe.offset = offset;
  return keyframe;
}

function shouldReduce(page: HTMLElement): boolean {
  const root = document.documentElement;
  const forcedColors = window.matchMedia('(forced-colors: active)').matches;
  const systemReduced = root.dataset.motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return forcedColors || root.dataset.motion === 'reduced' || page.dataset.motion === 'reduced' || systemReduced;
}

/**
 * 页面专属昼夜切换：主题状态即时提交，纸页仅在真实DOM上做明暗收束；
 * 右页横线与调频刻度按当前布局配对，执行冻结原稿的短划、升起与反向落线。
 */
export const relationshipJournalThemeTransition: ThemeTransitionStrategy = (request) => {
  const page = document.querySelector<HTMLElement>('.wj-journal');
  const toNight = request.to === 'nightwave';
  const noOp = () => {};
  const finishDirectly = () => {
    request.commit(request.to);
    if (page) page.dataset.uiPreset = request.to;
    request.finish();
    return noOp;
  };
  if (!page || !page.isConnected || document.hidden || shouldReduce(page)) return finishDirectly();

  const overview = !!page.querySelector('.ov');
  const pageDuration = durationMs(page, '--nd-component-relationship-journal-duration1500');
  const lineDuration = durationMs(page, '--nd-component-relationship-journal-duration900');
  const hold = durationMs(page, '--nd-component-relationship-journal-duration180');
  const waveDuration = durationMs(page, '--nd-component-relationship-journal-duration380');
  if (!pageDuration) return finishDirectly();

  const oldTicks = ticks(page);
  const targetDayLines = overview ? [] : toNight ? ruledLines(page) : withPreset(page, 'daylight', () => ruledLines(page));
  const initialPairs = pairLines(targetDayLines, oldTicks);
  const oldLineColor = toNight ? pageLineColor(page) : '';
  const bars: HTMLElement[] = [];
  const lineAnimations: Animation[] = [];
  const materialAnimations: Animation[] = [];
  const root = document.documentElement;
  let disposed = false;
  let motionObserver: MutationObserver | undefined;
  let detachmentObserver: MutationObserver | undefined;
  let layoutObserver: ResizeObserver | undefined;
  const onResize = () => { if (request.isCurrent()) request.finish(); };
  const layer = initialPairs.length ? document.createElement('div') : undefined;

  if (layer) {
    layer.className = 'wj-theme-morph';
    layer.setAttribute('aria-hidden', 'true');
    initialPairs.forEach((pair, index) => {
      const bar = document.createElement('i');
      place(bar, toNight ? pair.line : pair.tick);
      bar.style.backgroundColor = toNight ? oldLineColor : oldTicks[index]?.color ?? 'var(--nd-semantic-color-entry)';
      layer.append(bar);
      bars.push(bar);
    });
    document.body.append(layer);
  }

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    motionObserver?.disconnect();
    detachmentObserver?.disconnect();
    layoutObserver?.disconnect();
    window.removeEventListener('resize', onResize);
    for (const animation of [...materialAnimations, ...lineAnimations]) animation.cancel();
    layer?.remove();
    delete page.dataset.journalThemeTransition;
    if (root.dataset.themeTransition === 'relationship-journal') delete root.dataset.themeTransition;
  };

  root.dataset.themeTransition = 'relationship-journal';
  page.dataset.journalThemeTransition = toNight ? 'pre-to-night' : 'pre-to-day';
  const materialFrames: Keyframe[] = toNight
    ? [
        { filter: 'brightness(1) saturate(1)', opacity: 1, offset: 0 },
        { filter: 'brightness(.97) saturate(.97)', opacity: 1, offset: .16 },
        { filter: 'brightness(.55) saturate(.75)', opacity: 1, offset: .5 },
        { filter: 'brightness(.25) saturate(.6)', opacity: 0, offset: .72 },
        { filter: 'brightness(.58) saturate(.85)', opacity: 0, offset: .76 },
        { filter: 'brightness(1) saturate(1)', opacity: 1, offset: 1 }
      ]
    : [
        { filter: 'brightness(1) sepia(0)', opacity: 1, offset: 0 },
        { filter: 'brightness(1.04) sepia(.02)', opacity: 1, offset: .16 },
        { filter: 'brightness(1.35) sepia(.3) saturate(.85)', opacity: .9, offset: .55 },
        { filter: 'brightness(1.8) sepia(.45) saturate(.6)', opacity: 0, offset: .72 },
        { filter: 'brightness(1.5) sepia(.3) saturate(.8)', opacity: 0, offset: .76 },
        { filter: 'brightness(1) sepia(0) saturate(1)', opacity: 1, offset: 1 }
      ];

  try {
    // preset、主题按钮与原生窗口沿用同一个即时提交；页面效果只装饰其真实DOM。
    request.commit(request.to);
    page.dataset.journalThemeTransition = toNight ? 'to-night' : 'to-day';
    materialAnimations.push(page.animate(materialFrames, {
      duration: pageDuration,
      easing: 'cubic-bezier(.3,0,.2,1)',
      fill: 'both'
    }));
  } catch {
    cleanup();
    request.commit(request.to);
    page.dataset.uiPreset = request.to;
    request.finish();
    return noOp;
  }

  try {
    if (bars.length && lineDuration) {
      const endTicks = ticks(page);
      const mappedPairs = toNight ? pairLines(targetDayLines, endTicks) : pairLines(ruledLines(page), oldTicks);
      const startLineColor = toNight ? oldLineColor : '';
      const endLineColor = toNight ? '' : pageLineColor(page);
      const xPositions = mappedPairs.map((pair) => toNight ? pair.line.x : pair.tick.x);
      const minX = Math.min(...xPositions);
      const maxX = Math.max(...xPositions) || 1;
      mappedPairs.forEach((pair, index) => {
        const bar = bars[index];
        const sourceTick = oldTicks[index];
        const targetTick = endTicks.find((tick) => tick.rect.x === pair.tick.x);
        if (!bar) return;
        const tickColor = (toNight ? targetTick?.color : sourceTick?.color) || 'var(--nd-semantic-color-entry)';
        const from = toNight ? { ...pair.line, color: startLineColor } : { ...pair.tick, color: sourceTick?.color ?? tickColor };
        const to = toNight ? { ...pair.tick, color: tickColor } : { ...pair.line, color: endLineColor };
        const dash = toNight
          ? { x: pair.line.x + pair.line.w / 2 - 6, y: pair.line.y, w: 12, h: 1.5, color: startLineColor }
          : { x: pair.tick.x - 1, y: pair.tick.y + pair.tick.h + 14, w: 3, h: 2, color: tickColor };
        const lift = toNight
          ? { x: (pair.line.x + pair.tick.x) / 2, y: (pair.line.y + pair.tick.y) / 2 - 30, w: 2, h: 5, color: tickColor }
          : { x: (pair.line.x + pair.tick.x) / 2, y: (pair.line.y + pair.tick.y) / 2, w: 6, h: 1.5, color: endLineColor };
        const wave = ((toNight ? pair.line.x : pair.tick.x) - minX) / (maxX - minX || 1);
        const keyframes = [
          frame(from, from.color), frame(dash, dash.color, 1, .3), frame(lift, lift.color, 1, .62), frame(to, to.color)
        ];
        try {
          lineAnimations.push(bar.animate(keyframes, { duration: lineDuration, delay: hold + wave * waveDuration, easing: 'cubic-bezier(.5,0,.25,1)', fill: 'both' }));
        } catch { /* 页面明暗动画仍继续；清理时移除静态形变装饰。 */ }
      });
    }
  } catch {
    cleanup();
    page.dataset.uiPreset = request.to;
    request.finish();
    return noOp;
  }

  try {
    // 关系页有自己的动效偏好；路由外层只观察 html，必须监听本页 data-motion。
    motionObserver = new MutationObserver(() => {
      if (request.isCurrent() && shouldReduce(page)) request.finish();
    });
    motionObserver.observe(page, { attributes: true, attributeFilter: ['data-motion'] });
    // 页面分支、总览或书页节点在途变化时，旧测量不再代表当前布局。
    const measuredLeaf = page.querySelector('.leaf.right');
    const measuredStrip = page.querySelector('.strip');
    const measured = [measuredLeaf, measuredStrip].filter((node): node is HTMLElement => node !== null).map((node) => {
      const rect = node.getBoundingClientRect();
      return { node, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
    });
    const geometryChanged = () => measured.some(({ node, rect }) => {
      const next = node.getBoundingClientRect();
      return Math.abs(next.left - rect.x) > 0.5 || Math.abs(next.top - rect.y) > 0.5
        || Math.abs(next.width - rect.width) > 0.5 || Math.abs(next.height - rect.height) > 0.5;
    });
    const finishIfGeometryChanged = () => {
      if (!request.isCurrent()) return;
      if (!page.isConnected || page.querySelector('.leaf.right') !== measuredLeaf || page.querySelector('.strip') !== measuredStrip || geometryChanged()) request.finish();
    };
    detachmentObserver = new MutationObserver(finishIfGeometryChanged);
    detachmentObserver.observe(document.documentElement, { childList: true, subtree: true });
    detachmentObserver.observe(page, { childList: true, subtree: true });
    layoutObserver = new ResizeObserver(finishIfGeometryChanged);
    layoutObserver.observe(page);
    if (measuredLeaf) layoutObserver.observe(measuredLeaf);
    if (measuredStrip) layoutObserver.observe(measuredStrip);
    window.addEventListener('resize', onResize, { passive: true });
  } catch {
    cleanup();
    request.finish();
    return noOp;
  }

  void Promise.all([
    ...materialAnimations.map((animation) => animation.finished.catch(() => undefined)),
    ...lineAnimations.map((animation) => animation.finished.catch(() => undefined))
  ]).then(request.finish);
  return cleanup;
};
