import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { T9 } from '../config-texts.js';
import { focusableControls } from '../../../ui/focus';
import { createMotionScope, readMotionTime, readMotionValue, useMotionPolicy } from '../../../ui';
import { SheetScrims } from './scrims';
import { sheetKeyframe } from './sheet-motion';
import { useSheet, type SheetState } from './sheet-context';

/**
 * 纸笺外框（规范 §7.1–§7.5）：完整 / 紧凑 / 确认三形态共用；
 * 负责模态语义、inert、焦点陷阱、Esc 阶梯、紧凑形态的顶边对齐，
 * 以及 M1–M4 的进入 / 退出动效（时长与曲线全部取自令牌，减少动效时令牌为 0 即直接出现）。
 */
export function Sheet({ children, footer, idPrefix, enabled = true, confirmationTitle, onCancelConfirmation }: {
  children: ReactNode; footer: ReactNode; idPrefix?: string; enabled?: boolean;
  confirmationTitle?: string; onCancelConfirmation?: () => void;
}) {
  const { sheet, dirtyCount, busy, confirming, closing, requestClose, resolveConfirm } = useSheet();
  const { reduced } = useMotionPolicy();
  const [entryMotion] = useState(createMotionScope);
  // 多个分区各挂一张 Sheet：只有自己负责的纸笺编号才渲染，避免同时弹出空纸笺。
  // `enabled` 用于「常驻但非激活」的角色编辑器：访问过的角色会保留组件以保住草稿，
  // 但只有激活角色才能认领纸笺，否则同一张纸笺会被多个角色实例各渲染一份（R11-1）。
  const owned = useMemo<SheetState | null>(() => {
    if (!enabled || !sheet || (idPrefix !== undefined && !sheet.id.startsWith(idPrefix))) return null;
    return confirmationTitle ? { ...sheet, title: confirmationTitle, shape: 'confirm' as const } : sheet;
  }, [enabled, sheet, idPrefix, confirmationTitle]);
  const panel = useRef<HTMLElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  // 纸笺必须挂在右页（.config-leaf）下、正文之外：正文会被设为 inert，挂在其中会让纸笺自身不可聚焦。
  const [host, setHost] = useState<HTMLElement | null>(null);
  const lastContents = useRef({ children, footer });
  if (owned && !closing) lastContents.current = { children, footer };
  // 首帧重渲染可能多次触发聚焦效应，用「同一纸笺只排一帧」去重。
  const pendingFocus = useRef<{ key: string; raf: number } | null>(null);
  useEffect(() => {
    setHost(probe.current?.closest<HTMLElement>('.config-leaf') ?? null);
  }, []);

  useLayoutEffect(() => {
    const body = document.querySelector<HTMLElement>('.config-leaf-body');
    const foot = document.querySelector<HTMLElement>('.config-leaf-foot');
    if (!owned) return;
    body?.setAttribute('inert', '');
    foot?.setAttribute('inert', '');
    return () => {
      body?.removeAttribute('inert');
      foot?.removeAttribute('inert');
    };
  }, [Boolean(owned)]);

  useLayoutEffect(() => {
    if (confirming && owned) panel.current?.querySelector<HTMLElement>('.config-sheet-confirm [data-sheet-focus]')?.focus({ preventScroll: true });
  }, [confirming, owned]);

  useEffect(() => {
    if (!owned || closing) {
      if (pendingFocus.current) {
        cancelAnimationFrame(pendingFocus.current.raf);
        pendingFocus.current = null;
      }
      return;
    }
    const frame = panel.current;
    if (!frame) return;
    // 等压暗层 portal 与纸笺内容同帧落定后再聚焦，避免被后续 DOM 插入夺走焦点。
    // 同一纸笺在首帧内可能因脏标记等状态再渲染一次；取消帧回调会让焦点永远落空，
    // 因此这里只校验节点仍在文档中，不做 cleanup；同一纸笺同一组只排一帧，避免累积冗余 focus。
    const key = `${owned.id}|${owned.group ?? ''}`;
    if (pendingFocus.current?.key === key) return;
    if (pendingFocus.current) cancelAnimationFrame(pendingFocus.current.raf);
    const raf = requestAnimationFrame(() => {
      pendingFocus.current = null;
      if (!frame.isConnected) return;
      const controls = focusableControls(frame);
      const first = controls.find(element => element.hasAttribute('data-sheet-focus'))
        ?? controls.find(element => element.closest('.config-sheet-body'))
        ?? controls.find(element => !element.classList.contains('config-sheet-x'))
        ?? frame;
      first.focus({ preventScroll: true });
      const group = owned.shape === 'full' && owned.group ? frame.querySelector<HTMLElement>('[data-sheet-group]') : null;
      const body = group?.closest<HTMLElement>('.config-sheet-body');
      if (group && body) body.scrollTop += group.getBoundingClientRect().top - body.getBoundingClientRect().top - (window.matchMedia('(max-width: 900px)').matches ? 4 : 2);
    });
    pendingFocus.current = { key, raf };
  }, [owned?.id, owned?.group, owned, host, closing]);

  // M1 / M3 / M4：进入动画。令牌为 0（减少动效）时不建动画对象，满足「16ms 内 getAnimations() 为 0」。
  useEffect(() => {
    if (!owned || reduced) return;
    const frame = panel.current;
    if (!frame) return;
    const duration = readMotionTime(frame, '--nd-semantic-motion-page', 360);
    if (duration <= 0) return;
    const animation = entryMotion.run(frame, [
      sheetKeyframe(frame),
      { transform: 'none', boxShadow: getComputedStyle(frame).boxShadow },
    ], {
      duration,
      easing: readMotionValue(frame, '--nd-semantic-motion-ease-out', 'ease-out'),
      fill: 'both',
    });
    return () => animation.cancel();
  }, [owned, entryMotion, reduced]);

  const active = owned;
  const exiting = closing && Boolean(owned);

  const [compactTop, setCompactTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const frame = panel.current;
    if (!active || active.shape === 'full' || !frame || !host) { setCompactTop(undefined); return; }
    const position = () => {
      const leafBox = host.getBoundingClientRect();
      const row = active.anchor?.getBoundingClientRect();
      const desired = row ? row.top - leafBox.top - 10 : 6;
      const top = Math.round(Math.max(6, Math.min(desired, leafBox.height - frame.offsetHeight - 8)));
      setCompactTop(top);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(frame); observer.observe(host);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [active?.id, active?.shape, active?.group, active?.anchor, host]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (exiting) return;
    const frame = panel.current;
    if (!frame) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (busy) return;
      if (confirming) {
        resolveConfirm(true);
        return;
      }
      if (onCancelConfirmation) onCancelConfirmation();
      else requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = focusableControls(frame);
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    const activeEl = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (activeEl === first || !frame.contains(activeEl))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeEl === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const frame = !active ? null : <section
      ref={panel}
      className={`config-sheet${active?.shape === 'full' ? '' : ' compact'}${exiting ? ' exiting' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="config-sheet-title"
      aria-busy={busy || undefined}
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
      data-shape={active?.shape}
      data-exiting={exiting || undefined}
      style={compactTop === undefined ? undefined : { top: `${compactTop}px` }}
      onKeyDown={onKeyDown}
    >
      <span className="config-sheet-grip" aria-hidden="true" />
      <header className="config-sheet-head">
        <h3 id="config-sheet-title">{active?.title}</h3>
        <button
          type="button"
          className="config-sheet-x"
          aria-label="关闭"
          disabled={busy}
          onClick={() => onCancelConfirmation ? onCancelConfirmation() : requestClose()}
        >×</button>
      </header>
      <div className="config-sheet-body" inert={confirming || busy || undefined}>{exiting ? lastContents.current.children : children}</div>
      <footer className="config-sheet-foot">
        {confirming
          ? <div className="config-sheet-confirm" role="alert">
            <p>{T9.text(dirtyCount)}</p>
            <div className="config-sheet-confirm-actions">
              <button type="button" data-sheet-focus onClick={() => resolveConfirm(true)}>{T9.keep}</button>
              <button type="button" className="danger" onClick={() => resolveConfirm(false)}>{T9.drop}</button>
            </div>
          </div>
          : exiting ? lastContents.current.footer : footer}
      </footer>
    </section>;
  // 纸笺内容与压暗层始终在同一位置渲染：若两个分支的子节点顺序不同，
  // React 会把 SheetScrims 重挂载，压暗层动画会从中断处重新开始。
  return <>
    <span ref={probe} hidden />
    {active ? (host ? createPortal(frame, host) : frame) : null}
    <SheetScrims idPrefix={idPrefix} enabled={enabled} />
  </>;
}
