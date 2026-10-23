import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './actions';

type Layer = { backdrop: HTMLDivElement; panel: HTMLDivElement; restoreFocus?: HTMLElement };
const layers: Layer[] = [];
const backgroundState = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
function isolateTopLayer() {
  for (const [element, previous] of backgroundState) {
    element.inert = previous.inert;
    if (previous.hidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', previous.hidden);
  }
  backgroundState.clear();
  const top = layers.at(-1);
  if (!top) return;
  layers.forEach((layer, index) => { layer.backdrop.style.zIndex = String(1000 + index * 10); });
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement) || child === top.backdrop || ['SCRIPT', 'STYLE'].includes(child.tagName)) continue;
    backgroundState.set(child, { inert: child.inert, hidden: child.getAttribute('aria-hidden') });
    child.inert = true;
    child.setAttribute('aria-hidden', 'true');
  }
}
const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** All application dialogs share isolation, focus trapping, Escape and focus restoration. */
export function Modal({ open, title, description, children, onClose, closeDisabled = false, className = '', backdropClassName = '', headerClassName = '', eyebrow, headerExtra, role = 'dialog' }: {
  open: boolean; title: ReactNode; description?: ReactNode; children: ReactNode; onClose: () => void;
  closeDisabled?: boolean; className?: string; backdropClassName?: string; headerClassName?: string;
  eyebrow?: string; headerExtra?: ReactNode; role?: 'dialog' | 'alertdialog';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const closeState = useRef({ onClose, closeDisabled });
  closeState.current = { onClose, closeDisabled };
  const id = useId();
  useEffect(() => {
    if (!open || !panel.current || !backdrop.current) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const layer: Layer = { panel: panel.current, backdrop: backdrop.current, restoreFocus: previous };
    layers.push(layer);
    isolateTopLayer();
    const frame = requestAnimationFrame(() => {
      (layer.panel.querySelector<HTMLElement>('[data-autofocus]') ?? layer.panel.querySelector<HTMLElement>(FOCUSABLE) ?? layer.panel).focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!closeState.current.closeDisabled) closeState.current.onClose();
      } else if (event.key === 'Tab') {
        const controls = [...layer.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.getClientRects().length > 0);
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
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      isolateTopLayer();
      const target = layer.restoreFocus;
      if (target?.isConnected && !target.closest('[inert]')) target.focus();
      else {
        const remaining = layers.at(-1);
        if (remaining && target?.isConnected) remaining.restoreFocus = target;
        remaining?.panel.focus();
      }
    };
  }, [open]);
  if (!open) return null;
  return createPortal(<div ref={backdrop} className={`ui-modal-backdrop ${backdropClassName}`} onMouseDown={(event) => {
    if (event.target === event.currentTarget && !closeDisabled) onClose();
  }}>
    <div ref={panel} className={`ui-modal-panel ${className}`} role={role} aria-modal="true" aria-busy={closeDisabled || undefined}
      aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} tabIndex={-1}>
      <header className={`ui-modal-header ${headerClassName}`}>
        <div>{eyebrow ? <span className="settings-dialog-eyebrow">{eyebrow}</span> : null}<h2 id={`${id}-title`}>{title}</h2>
          {description ? <p id={`${id}-description`}>{description}</p> : null}</div>
        {headerExtra}
        <IconButton icon="close" label="关闭弹窗" disabled={closeDisabled} onClick={onClose} />
      </header>
      {children}
    </div>
  </div>, document.body);
}
