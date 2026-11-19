import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONFIG_WELL_SELECTORS, applySubtractMask, clearSubtractMask, collectWellRects } from '../../../ui/dom-mask';
import { useSheet } from './sheet-context';

/**
 * 双层压暗（规范 §7.1）：右页一层用于点击关闭，书本一层盖住左页与其他内容；
 * 两层都把图片框挖空，立绘始终由真实页面绘制。
 */
export function SheetScrims() {
  const { sheet, requestClose } = useSheet();
  const probe = useRef<HTMLSpanElement>(null);
  const [leaf, setLeaf] = useState<HTMLElement | null>(null);
  const [book, setBook] = useState<HTMLElement | null>(null);
  const leafScrim = useRef<HTMLDivElement>(null);
  const bookScrim = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sheet) { setLeaf(null); setBook(null); return; }
    setLeaf(probe.current?.closest<HTMLElement>('.config-leaf') ?? null);
    setBook(probe.current?.closest<HTMLElement>('.config-book') ?? null);
  }, [sheet]);

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
