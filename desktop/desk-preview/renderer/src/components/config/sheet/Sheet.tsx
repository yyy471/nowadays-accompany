import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { T9 } from '../config-texts.js';
import { focusableControls } from '../../../ui/focus';
import { SheetScrims } from './scrims';
import { useSheet } from './sheet-context';

/**
 * 纸笺外框（规范 §7.1–§7.5）：完整 / 紧凑 / 确认三形态共用；
 * 负责模态语义、inert、焦点陷阱、Esc 阶梯与紧凑形态的顶边对齐。
 */
export function Sheet({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  const { sheet, dirtyCount, busy, confirming, requestClose, resolveConfirm } = useSheet();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const body = document.querySelector<HTMLElement>('.config-leaf-body');
    const foot = document.querySelector<HTMLElement>('.config-leaf-foot');
    if (!sheet) return;
    body?.setAttribute('inert', '');
    foot?.setAttribute('inert', '');
    return () => {
      body?.removeAttribute('inert');
      foot?.removeAttribute('inert');
    };
  }, [sheet]);

  useEffect(() => {
    if (!sheet) return;
    const frame = panel.current;
    if (!frame) return;
    const first = frame.querySelector<HTMLElement>('[data-sheet-focus]')
      ?? focusableControls(frame)[0]
      ?? frame;
    first.focus({ preventScroll: true });
    const group = sheet.group ? frame.querySelector<HTMLElement>('[data-sheet-group]') : null;
    group?.scrollIntoView({ block: 'start' });
  }, [sheet?.id, sheet?.group, sheet]);

  if (!sheet) {
    return <SheetScrims />;
  }

  let compactTop: number | undefined;
  if (sheet.shape === 'compact' && sheet.anchor) {
    const leaf = panel.current?.closest<HTMLElement>('.config-leaf');
    if (leaf) {
      const row = sheet.anchor.getBoundingClientRect();
      const box = leaf.getBoundingClientRect();
      compactTop = Math.max(6, Math.round(row.top - box.top - 10));
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const frame = panel.current;
    if (!frame) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (busy) return;
      if (confirming) {
        resolveConfirm(true);
        return;
      }
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = focusableControls(frame);
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !frame.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <>
    <SheetScrims />
    <section
      ref={panel}
      className={`config-sheet${sheet.shape === 'compact' ? ' compact' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="config-sheet-title"
      aria-busy={busy || undefined}
      data-shape={sheet.shape}
      style={compactTop === undefined ? undefined : { top: `${compactTop}px` }}
      onKeyDown={onKeyDown}
    >
      <span className="config-sheet-grip" aria-hidden="true" />
      <header className="config-sheet-head">
        <h3 id="config-sheet-title">{sheet.title}</h3>
        <button
          type="button"
          className="config-sheet-x"
          aria-label="关闭"
          disabled={busy}
          onClick={() => requestClose()}
        >×</button>
      </header>
      <div className="config-sheet-body">{children}</div>
      <footer className="config-sheet-foot">
        {confirming
          ? <div className="config-sheet-confirm" role="alert">
            <p>{T9.text(dirtyCount)}</p>
            <div className="config-sheet-confirm-actions">
              <button type="button" data-sheet-focus onClick={() => resolveConfirm(true)}>{T9.keep}</button>
              <button type="button" className="danger" onClick={() => resolveConfirm(false)}>{T9.drop}</button>
            </div>
          </div>
          : footer}
      </footer>
    </section>
  </>;
}
