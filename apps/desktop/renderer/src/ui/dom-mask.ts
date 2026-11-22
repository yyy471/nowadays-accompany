/**
 * 图片框挖空遮罩（v6 规范 §7.1 / §5.3）：压暗层与主题过渡副本共用。
 * 含图片的图框在遮罩上被整体减去，图片全程只由真实页面绘制，不被压暗或重新着色。
 */

/** 收集作用域内可见图框的视口矩形。selectorList 形如 '.config-portrait,.nd-outfit-thumb'。 */
export function collectWellRects(
  scope: ParentNode | null,
  selectorList: string,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
  includeSheet = false,
): DOMRect[] {
  if (!scope) return [];
  return Array.from(scope.querySelectorAll<HTMLElement>(selectorList))
    .filter(element => element.offsetParent !== null && (includeSheet || !element.closest('.config-sheet')))
    .map(element => element.getBoundingClientRect())
    .filter(box =>
      box.width > 2 && box.height > 2
      && box.bottom > 0 && box.top < viewport.height
      && box.right > 0 && box.left < viewport.width,
    );
}

/** 把一组视口矩形从遮罩元素上减去；rects 为空时清除遮罩。 */
export function applySubtractMask(element: HTMLElement, rects: DOMRect[]): void {
  const base = element.getBoundingClientRect();
  const inner = rects
    .map(rect => ({ left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height }))
    .filter(rect =>
      rect.width > 2 && rect.height > 2
      && rect.left + rect.width > 0 && rect.top + rect.height > 0
      && rect.left < base.width && rect.top < base.height,
    );
  if (inner.length === 0) {
    element.style.maskImage = '';
    element.style.webkitMaskImage = '';
    return;
  }
  const layers = ['linear-gradient(#000,#000)', ...inner.map(() => 'linear-gradient(#000,#000)')];
  const positions = ['0 0', ...inner.map(rect => `${Math.floor(rect.left)}px ${Math.floor(rect.top)}px`)];
  const sizes = ['100% 100%', ...inner.map(rect => `${Math.ceil(rect.width) + 1}px ${Math.ceil(rect.height) + 1}px`)];
  element.style.maskImage = layers.join(',');
  element.style.maskPosition = positions.join(',');
  element.style.maskSize = sizes.join(',');
  element.style.maskRepeat = 'no-repeat';
  element.style.maskComposite = ['subtract', ...inner.map(() => 'add')].join(',');

}

/** 清除 applySubtractMask 留下的所有遮罩样式。 */
export function clearSubtractMask(element: HTMLElement): void {
  element.style.maskImage = '';
  element.style.maskPosition = '';
  element.style.maskSize = '';
  element.style.maskRepeat = '';
  element.style.maskComposite = '';
  element.style.webkitMaskImage = '';
  element.style.webkitMaskPosition = '';
  element.style.webkitMaskSize = '';
  element.style.webkitMaskRepeat = '';
}

/** 配置页的图框选择器族：立绘、服饰缩略、差分、试生图、角色状态卡画框。 */
export const CONFIG_WELL_SELECTORS = '.config-portrait:has(img),.config-outfit-thumb:has(img),.config-outfit-hero-thumb:has(img),.config-face:has(img),.nd-outfit-thumb:has(img),.nd-import-thumb:has(img),.nd-image-figure:has(img),.ui-poster-well:has(img),.feed-face:has(img)';
