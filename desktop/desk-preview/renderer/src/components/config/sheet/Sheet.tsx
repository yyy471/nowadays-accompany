import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { T9 } from '../config-texts.js';
import { focusableControls } from '../../../ui/focus';
import { readMotionTime, readMotionValue } from '../../../ui';
import { SheetScrims } from './scrims';
import { useSheet, type SheetState } from './sheet-context';

/** ≤900 的 720 桶里纸笺从底部升起（M4），桌面从右侧滑出（M1/M3）。 */
function enterTransform(): string {
  return window.matchMedia('(max-width: 900px)').matches
    ? 'translateY(100%)'
    : 'translate(calc(100% + 32px), 10px)';
}

/**
 * 纸笺外框（规范 §7.1–§7.5）：完整 / 紧凑 / 确认三形态共用；
 * 负责模态语义、inert、焦点陷阱、Esc 阶梯、紧凑形态的顶边对齐，
 * 以及 M1–M4 的进入 / 退出动效（时长与曲线全部取自令牌，减少动效时令牌为 0 即直接出现）。
 */
export function Sheet({ children, footer, idPrefix }: { children: ReactNode; footer: ReactNode; idPrefix?: string }) {
  const { sheet, dirtyCount, busy, confirming, requestClose, resolveConfirm } = useSheet();
  // 多个分区各挂一张 Sheet：只有自己负责的纸笺编号才渲染，避免同时弹出空纸笺。
  const owned = sheet !== null && (idPrefix === undefined || sheet.id.startsWith(idPrefix)) ? sheet : null;
  const panel = useRef<HTMLElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  // 纸笺必须挂在右页（.config-leaf）下、正文之外：正文会被设为 inert，挂在其中会让纸笺自身不可聚焦。
  const [host, setHost] = useState<HTMLElement | null>(null);
  // 关闭时保留上一张纸笺做退出动画（M2），结束后再卸载。
  const [held, setHeld] = useState<SheetState | null>(null);
  // 首帧重渲染可能多次触发聚焦效应，用「同一纸笺只排一帧」去重。
  const pendingFocus = useRef<{ key: string; raf: number } | null>(null);
  useEffect(() => {
    setHost(probe.current?.closest<HTMLElement>('.config-leaf') ?? null);
  }, []);

  useEffect(() => {
    const body = document.querySelector<HTMLElement>('.config-leaf-body');
    const foot = document.querySelector<HTMLElement>('.config-leaf-foot');
    if (!owned) return;
    body?.setAttribute('inert', '');
    foot?.setAttribute('inert', '');
    return () => {
      body?.removeAttribute('inert');
      foot?.removeAttribute('inert');
    };
  }, [owned]);

  useEffect(() => {
    if (!owned) {
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
      const first = frame.querySelector<HTMLElement>('[data-sheet-focus]')
        ?? focusableControls(frame)[0]
        ?? frame;
      first.focus({ preventScroll: true });
      const group = owned.group ? frame.querySelector<HTMLElement>('[data-sheet-group]') : null;
      group?.scrollIntoView({ block: 'start' });
    });
    pendingFocus.current = { key, raf };
  }, [owned?.id, owned?.group, owned]);

  // M1 / M3 / M4：进入动画。令牌为 0（减少动效）时不建动画对象，满足「16ms 内 getAnimations() 为 0」。
  useEffect(() => {
    if (!owned) return;
    const frame = panel.current;
    if (!frame) return;
    const duration = readMotionTime(frame, '--nd-semantic-motion-page', 360);
    if (duration <= 0) return;
    const animation = frame.animate([
      { transform: enterTransform(), boxShadow: '0 2px 6px rgba(30,20,40,.12)' },
      { transform: 'none' },
    ], {
      duration,
      easing: readMotionValue(frame, '--nd-semantic-motion-ease-out', 'ease-out'),
      fill: 'both',
    });
    return () => animation.cancel();
  }, [owned?.id, owned?.group, owned?.shape, owned]);

  // M2：退出动画。关闭后保留一帧旧纸笺，动画结束即卸载（压暗层由 SheetScrims 自行淡出）。
  useEffect(() => {
    if (owned) {
      setHeld(owned);
      return;
    }
    if (!held) return;
    const frame = panel.current;
    if (!frame) {
      setHeld(null);
      return;
    }
    const duration = readMotionTime(frame, '--nd-semantic-motion-page-exit', 260);
    if (duration <= 0) {
      setHeld(null);
      return;
    }
    const animation = frame.animate([{ transform: 'none' }, { transform: enterTransform() }], {
      duration,
      easing: readMotionValue(frame, '--nd-semantic-motion-ease-in', 'ease-in'),
      fill: 'forwards',
    });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) setHeld(null);
    }, duration);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      animation.cancel();
    };
  }, [owned, held]);

  const active = owned ?? held;
  const exiting = !owned && !!held;

  let compactTop: number | undefined;
  const anchor = active?.anchor ?? null;
  if (active?.shape === 'compact' && anchor) {
    const leaf = panel.current?.closest<HTMLElement>('.config-leaf');
    if (leaf) {
      const row = anchor.getBoundingClientRect();
      const box = leaf.getBoundingClientRect();
      compactTop = Math.max(6, Math.round(row.top - box.top - 10));
    }
  }

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
      requestClose();
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
    </section>;
  // 纸笺内容与压暗层始终在同一位置渲染：若两个分支的子节点顺序不同，
  // React 会把 SheetScrims 重挂载，压暗层动画会从中断处重新开始。
  return <>
    <span ref={probe} hidden />
    {active ? (host ? createPortal(frame, host) : frame) : null}
    <SheetScrims idPrefix={idPrefix} />
  </>;
}
