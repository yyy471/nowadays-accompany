import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONFIG_WELL_SELECTORS, applySubtractMask, clearSubtractMask, collectWellRects } from '../../../ui/dom-mask';
import { readMotionTime, readMotionValue } from '../../../ui';
import { useSheet } from './sheet-context';

/** 压暗层淡入（M5：component 220 / ease-out）与淡出（M6：page-exit 260 / ease-in）。 */
function fade(node: HTMLElement | null, from: number, to: number, timeToken: string, easeToken: string, fallbackTime: number, fallbackEase: string): Animation | null {
  if (!node) return null;
  const duration = readMotionTime(node, timeToken, fallbackTime);
  if (duration <= 0) return null;
  return node.animate([{ opacity: from }, { opacity: to }], {
    duration,
    easing: readMotionValue(node, easeToken, fallbackEase),
    fill: 'both',
  });
}

/**
 * 双层压暗（规范 §7.1）：右页一层用于点击关闭，书本一层盖住左页与其他内容；
 * 两层都把图片框挖空，立绘始终由真实页面绘制。
 * 关闭时先淡出（M6）再卸载，避免压暗层瞬间消失。
 */
export function SheetScrims() {
  const { sheet, requestClose } = useSheet();
  const probe = useRef<HTMLSpanElement>(null);
  const [leaf, setLeaf] = useState<HTMLElement | null>(null);
  const [book, setBook] = useState<HTMLElement | null>(null);
  const leafScrim = useRef<HTMLDivElement>(null);
  const bookScrim = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    if (sheet) {
      mounted.current = true;
      setLeaf(probe.current?.closest<HTMLElement>('.config-leaf') ?? null);
      setBook(probe.current?.closest<HTMLElement>('.config-book') ?? null);
      return;
    }
    if (!mounted.current) return;
    mounted.current = false;
    const nodes = [leafScrim.current, bookScrim.current].filter((node): node is HTMLDivElement => node !== null);
    if (nodes.length === 0) return;
    const exits = nodes.map(node => fade(node, 1, 0, '--nd-semantic-motion-page-exit', '--nd-semantic-motion-ease-in', 260, 'ease-in'));
    const duration = readMotionTime(nodes[0], '--nd-semantic-motion-page-exit', 260);
    if (duration <= 0 || exits.every(animation => animation === null)) {
      setLeaf(null);
      setBook(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setLeaf(null);
      setBook(null);
    }, duration);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sheet]);

  useEffect(() => {
    if (!sheet || !leaf) return;
    const enters = [
      fade(leafScrim.current, 0, 1, '--nd-semantic-motion-component', '--nd-semantic-motion-ease-out', 220, 'ease-out'),
      fade(bookScrim.current, 0, 1, '--nd-semantic-motion-component', '--nd-semantic-motion-ease-out', 220, 'ease-out'),
    ].filter((animation): animation is Animation => animation !== null);
    return () => enters.forEach(animation => animation.cancel());
  }, [sheet, leaf]);

  useEffect(() => {
    if (!sheet || !leaf || !book) return;
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
    window.addEventListener('resize', paint);
    const observer = new ResizeObserver(paint);
    observer.observe(leaf);
    return () => {
      window.removeEventListener('resize', paint);
      observer.disconnect();
      if (leafScrim.current) clearSubtractMask(leafScrim.current);
      if (bookScrim.current) clearSubtractMask(bookScrim.current);
    };
  }, [sheet, leaf, book]);

  return <>
    <span ref={probe} hidden />
    {leaf && createPortal(<div ref={leafScrim} className="config-scrim on" aria-hidden="true" onPointerDown={() => requestClose()} />, leaf)}
    {book && createPortal(<div ref={bookScrim} className="config-book-scrim on" aria-hidden="true" onPointerDown={() => requestClose()} />, book)}
  </>;
}
