import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONFIG_WELL_SELECTORS, applySubtractMask, collectWellRects } from '../../../ui/dom-mask';
import { createMotionScope, readMotionTime, readMotionValue, useMotionPolicy } from '../../../ui';
import { useSheet } from './sheet-context';

/**
 * 双层压暗（规范 §7.1）：右页一层用于点击关闭，书本一层盖住左页与其他内容；
 * 两层都把图片框挖空，立绘始终由真实页面绘制。
 * 淡出（M6）与纸笺退场共用 Provider 的完成信号。
 */
export function SheetScrims({ idPrefix, enabled = true }: { idPrefix?: string; enabled?: boolean }) {
  const { sheet, closing, requestClose } = useSheet();
  const { reduced } = useMotionPolicy();
  const [entryMotion] = useState(createMotionScope);
  // 与 Sheet 同一归属规则：只压暗自己负责的纸笺，避免多分区各挂一层导致双重压暗；
  // 非激活角色（`enabled=false`）同样不认领，否则访问过多个角色时压暗层会叠加多层（R11-1）。
  const owned = enabled && sheet !== null && (idPrefix === undefined || sheet.id.startsWith(idPrefix)) ? sheet : null;
  const probe = useRef<HTMLSpanElement>(null);
  const [leaf, setLeaf] = useState<HTMLElement | null>(null);
  const [book, setBook] = useState<HTMLElement | null>(null);
  const leafScrim = useRef<HTMLDivElement>(null);
  const bookScrim = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    setLeaf(owned ? probe.current?.closest<HTMLElement>('.config-leaf') ?? null : null);
    setBook(owned ? probe.current?.closest<HTMLElement>('.config-book') ?? null : null);
  }, [owned]);

  useLayoutEffect(() => {
    if (!owned || !leaf || reduced) return;
    for (const node of [leafScrim.current, bookScrim.current]) {
      if (!node) continue;
      const duration = readMotionTime(node, '--nd-semantic-motion-component', 220);
      if (duration <= 0) continue;
      entryMotion.run(node, [{ opacity: 0 }, { opacity: 1 }], {
        duration, easing: readMotionValue(node, '--nd-semantic-motion-ease-out', 'ease-out'), fill: 'both',
      });
    }
    return () => entryMotion.cancelAll();
  }, [owned, leaf, reduced, entryMotion]);

  useEffect(() => {
    if (!owned || !book || closing) return;
    const dismissAt = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.config-sheet,.config-scrim,.config-tabs button,.config-index-item,.config-index-new,.config-kind-tabs button,.config-return-link')) return;
      event.preventDefault();
      requestClose();
    };
    book.addEventListener('pointerdown', dismissAt);
    return () => book.removeEventListener('pointerdown', dismissAt);
  }, [owned, book, closing, requestClose]);

  useLayoutEffect(() => {
    if (!owned || !leaf || !book) return;
    const paint = () => {
      const wells = collectWellRects(leaf, CONFIG_WELL_SELECTORS);
      if (leafScrim.current) applySubtractMask(leafScrim.current, wells);
      const leafBox = leaf.getBoundingClientRect();
      const outside = collectWellRects(book, CONFIG_WELL_SELECTORS).filter(box =>
        box.right <= leafBox.left || box.left >= leafBox.right || box.bottom <= leafBox.top || box.top >= leafBox.bottom,
      );
      if (bookScrim.current) applySubtractMask(bookScrim.current, [leafBox, ...outside]);
    };
    paint();
    // 页面进场的 transform 会移动图框但不触发 ResizeObserver；入场期间随帧追踪位置。
    let frame = 0;
    if (!reduced) {
      const end = performance.now() + readMotionTime(book, '--nd-semantic-motion-page', 360)
        + readMotionTime(book, '--nd-semantic-motion-page-exit', 260);
      const followEntrance = () => {
        paint();
        if (performance.now() < end) frame = requestAnimationFrame(followEntrance);
      };
      frame = requestAnimationFrame(followEntrance);
    }
    window.addEventListener('resize', paint);
    const observer = new ResizeObserver(paint);
    observer.observe(leaf);
    observer.observe(book);
    book.querySelectorAll<HTMLElement>(CONFIG_WELL_SELECTORS).forEach(element => observer.observe(element));
    // 图框可能在请求返回后才挂载，需重采样而不能只依赖右页尺寸变化。
    const mutations = new MutationObserver(() => {
      book.querySelectorAll<HTMLElement>(CONFIG_WELL_SELECTORS).forEach(element => observer.observe(element));
      paint();
    });
    mutations.observe(book, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', paint);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [owned, leaf, book, reduced]);

  return <>
    <span ref={probe} hidden />
    {leaf && owned && createPortal(<div ref={leafScrim} className="config-scrim on" aria-hidden="true" onPointerDown={() => requestClose()} />, leaf)}
    {book && owned && createPortal(<div ref={bookScrim} className="config-book-scrim on" aria-hidden="true" onPointerDown={() => requestClose()} />, book)}
  </>;
}
