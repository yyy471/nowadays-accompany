import { createPortal } from 'react-dom';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './actions';
import { canReceiveFocus, focusableControls } from './focus';
import { useUiAppearance } from './appearance';
import { createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy, type MotionScope } from './motion';
import { createModalLayerManager, useModalLayerManager, type ModalLayer } from './modal-layers';

/**
 * All application dialogs share isolation, focus trapping, Escape and focus restoration.
 * 进退场由当前实例持有；退出结束前继续隔离并拦截重复关闭，完成后才恢复背景与焦点。
 */
export function Modal({ open, title, description, children, onClose, closeDisabled = false, className = '', backdropClassName = '', headerClassName = '', eyebrow, headerExtra, role = 'dialog', source, onExited }: {
  open: boolean; title: ReactNode; description?: ReactNode; children: ReactNode; onClose: () => void;
  closeDisabled?: boolean; className?: string; backdropClassName?: string; headerClassName?: string;
  eyebrow?: string; headerExtra?: ReactNode; role?: 'dialog' | 'alertdialog';
  /** 可选的真实触发点；缺省使用打开时的焦点元素，再退化为中心进入。 */
  source?: HTMLElement | null; onExited?: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [scope] = useState<MotionScope>(createMotionScope);
  const providerManager = useModalLayerManager();
  const [fallbackManager] = useState(createModalLayerManager);
  const manager = providerManager ?? fallbackManager;
  const policy = useMotionPolicy();
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(closing);
  closingRef.current = closing;
  const origin = useRef({ x: 0, y: 0 });
  const generation = useRef(0);
  const notified = useRef(false);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const exitedRef = useRef(onExited);
  exitedRef.current = onExited;
  const closeState = useRef({ onClose, closeDisabled, closing });
  closeState.current = { onClose, closeDisabled, closing };
  const id = useId();
  const appearance = useUiAppearance();

  const notifyExited = (): void => {
    if (notified.current) return;
    notified.current = true;
    exitedRef.current?.();
  };

  useEffect(() => {
    if (open) {
      notified.current = false;
      setPresent(true);
      setClosing(false);
      return;
    }
    if (!present) return;
    if (policy.reduced) {
      generation.current += 1;
      scope.cancelAll();
      setPresent(false);
      setClosing(false);
      notifyExited();
      return;
    }
    setClosing(true);
  }, [open, present, policy.reduced, scope]);

  useLayoutEffect(() => {
    if (!present || !open) return;
    const panelElement = panel.current;
    const backdropElement = backdrop.current;
    if (!panelElement || !backdropElement) return;
    const continuing = closingRef.current;
    const drawn = getComputedStyle(panelElement);
    const startTransform = continuing && drawn.transform !== 'none' ? drawn.transform : null;
    const startOpacity = continuing ? Number.parseFloat(drawn.opacity) : 0;
    scope.cancelAll();
    if (policy.reduced) return;
    const bounds = panelElement.getBoundingClientRect();
    const anchor = sourceRef.current ?? (typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
    let dx = 0;
    let dy = 0;
    if (anchor && anchor !== document.body && anchor.isConnected) {
      const box = anchor.getBoundingClientRect();
      const maxX = readMotionPx(panelElement, '--nd-component-motion-modal-offset-x', 18);
      const maxY = readMotionPx(panelElement, '--nd-component-motion-modal-offset-y', 12);
      dx = Math.max(-maxX, Math.min(maxX, (box.left + box.width / 2) - (bounds.left + bounds.width / 2)));
      dy = Math.max(-maxY, Math.min(maxY, (box.top + box.height / 2) - (bounds.top + bounds.height / 2)));
    }
    origin.current = { x: dx, y: dy };
    const scale = readMotionValue(panelElement, '--nd-component-motion-modal-scale', '0.97');
    const duration = readMotionTime(panelElement, '--nd-component-motion-surface-enter', 220);
    const ease = readMotionValue(panelElement, '--nd-component-motion-surface-ease', 'cubic-bezier(0.22, 0.61, 0.36, 1)');
    scope.run(panelElement, [
      { opacity: startTransform ? (Number.isFinite(startOpacity) ? startOpacity : 1) : 0, transform: startTransform ?? `translate(${dx}px, ${dy}px) scale(${scale})` },
      { opacity: 1, transform: 'translate(0px, 0px) scale(1)' }
    ], { duration, easing: ease, slot: 'visibility', fill: 'backwards' });
    const backdropStart = Number.parseFloat(getComputedStyle(backdropElement).opacity);
    scope.run(backdropElement, [
      { opacity: continuing && Number.isFinite(backdropStart) ? backdropStart : 0 },
      { opacity: 1 }
    ], { duration, easing: ease, slot: 'backdrop', fill: 'backwards' });
  }, [present, open, policy.reduced, scope]);

  useLayoutEffect(() => {
    if (!present || open || !closing) return;
    const panelElement = panel.current;
    const backdropElement = backdrop.current;
    const current = ++generation.current;
    const finish = (): void => {
      if (generation.current !== current) return;
      scope.cancelAll();
      setPresent(false);
      setClosing(false);
      notifyExited();
    };
    if (!panelElement || !backdropElement) { finish(); return; }
    if (policy.reduced) { finish(); return; }
    const drawn = getComputedStyle(panelElement);
    const fromTransform = drawn.transform === 'none' ? 'translate(0px, 0px) scale(1)' : drawn.transform;
    const fromOpacity = Number.parseFloat(drawn.opacity);
    const backdropOpacity = Number.parseFloat(getComputedStyle(backdropElement).opacity);
    scope.cancelAll();
    const duration = readMotionTime(panelElement, '--nd-component-motion-surface-exit', 160);
    const ease = readMotionValue(panelElement, '--nd-component-motion-surface-ease', 'cubic-bezier(0.22, 0.61, 0.36, 1)');
    const closeScale = readMotionValue(panelElement, '--nd-component-motion-modal-close-scale', '0.985');
    const { x, y } = origin.current;
    const animation = scope.run(panelElement, [
      { opacity: Number.isFinite(fromOpacity) ? fromOpacity : 1, transform: fromTransform },
      { opacity: 0, transform: `translate(${x * 0.35}px, ${y * 0.35}px) scale(${closeScale})` }
    ], { duration, easing: ease, slot: 'visibility', fill: 'both' });
    scope.run(backdropElement, [
      { opacity: Number.isFinite(backdropOpacity) ? backdropOpacity : 1 },
      { opacity: 0 }
    ], { duration, easing: ease, slot: 'backdrop', fill: 'both' });
    void animation.finished.then(finish).catch(() => undefined);
  }, [present, open, closing, policy.reduced, scope]);

  useEffect(() => {
    if (!present || !panel.current || !backdrop.current) return;
    const layer: ModalLayer = {
      panel: panel.current,
      backdrop: backdrop.current,
      restoreFocus: typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    };
    manager.push(layer);
    const frame = requestAnimationFrame(() => {
      if (!manager.isTop(layer) || !layer.panel.isConnected) return;
      const requested = layer.panel.querySelector<HTMLElement>('[data-autofocus]');
      (requested && canReceiveFocus(requested) ? requested : focusableControls(layer.panel)[0] ?? layer.panel).focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (!manager.isTop(layer)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!closeState.current.closeDisabled && !closeState.current.closing) closeState.current.onClose();
      } else if (event.key === 'Tab') {
        const controls = focusableControls(layer.panel);
        const first = controls[0], last = controls.at(-1);
        if (!first || !last) { event.preventDefault(); layer.panel.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !layer.panel.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !layer.panel.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown, true);
      manager.remove(layer);
      const target = layer.restoreFocus;
      if (target?.isConnected && canReceiveFocus(target)) target.focus();
      else {
        const remaining = manager.top();
        if (remaining && target?.isConnected) remaining.restoreFocus = target;
        remaining?.panel.focus();
      }
    };
  }, [present, manager]);

  useEffect(() => () => scope.cancelAll(), [scope]);

  if (!present) return null;
  return createPortal(<div ref={backdrop} data-ui-theme={appearance.theme} data-motion={appearance.motion} data-ui-preset={appearance.preset} data-closing={closing || undefined} className={`ui-modal-backdrop ${backdropClassName}`} onMouseDown={(event) => {
    if (event.target === event.currentTarget && !closeDisabled && !closing) onClose();
  }}>
    <div ref={panel} className={`ui-modal-panel ${className}`} role={role} aria-modal="true" aria-busy={closeDisabled || closing || undefined}
      aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} tabIndex={-1}>
      <header className={`ui-modal-header ${headerClassName}`}>
        <div>{eyebrow ? <span className="settings-dialog-eyebrow">{eyebrow}</span> : null}<h2 id={`${id}-title`}>{title}</h2>
          {description ? <p id={`${id}-description`}>{description}</p> : null}</div>
        {headerExtra}
        <IconButton icon="close" label="关闭弹窗" disabled={closeDisabled || closing} onClick={onClose} />
      </header>
      {children}
    </div>
  </div>, document.body);
}
