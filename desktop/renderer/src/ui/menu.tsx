import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { ControlButton } from './controls';
import { Icon, type IconName } from './icons';
import { createMotionScope, readMotionTime, readMotionValue, useMotionPolicy } from './motion';

export type MenuItem = { id: string; label: string; icon?: IconName; disabled?: boolean; onSelect: () => void };

/** Action menu; account selection and page navigation have separate semantics. */
export function DropdownMenu({ label, items, currentLabel, triggerIcon, triggerRef, triggerClassName, triggerLayout = 'inline', triggerDecoration }: {
  label: string; items: MenuItem[]; currentLabel?: string;
  /** 公共触发器扩展：Dock等场景可提供图标、布局与装饰，不复制菜单。 */
  triggerIcon?: IconName; triggerRef?: Ref<HTMLButtonElement>; triggerClassName?: string;
  triggerLayout?: 'inline' | 'stacked'; triggerDecoration?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [closing, setClosing] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastFirst = useRef(false);
  const search = useRef({ text: '', time: 0 });
  const [scope] = useState(createMotionScope);
  const policy = useMotionPolicy();
  const reduced = useRef(policy.reduced);
  reduced.current = policy.reduced;
  const openRef = useRef(open);
  openRef.current = open;
  const presentRef = useRef(present);
  presentRef.current = present;
  const resume = useRef<{ opacity: number; transform: string } | null>(null);
  const generation = useRef(0);
  const id = useId();
  const controls = () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  const finishClose = useCallback(() => {
    generation.current += 1;
    scope.cancelAll();
    setPresent(false);
    setClosing(false);
  }, [scope]);
  const requestClose = useCallback((restore = false) => {
    if (!openRef.current) return;
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
    if (!presentRef.current) return;
    if (reduced.current || !panel.current) { finishClose(); return; }
    setClosing(true);
  }, [finishClose]);
  const requestOpen = useCallback((last = false) => {
    if (openRef.current) return;
    lastFirst.current = last;
    // 退出途中重开时，取消前先拷贝当前绘制值；取消后计算样式已回到基础值。
    const element = presentRef.current ? panel.current : null;
    if (element) {
      const drawn = getComputedStyle(element);
      const opacity = Number.parseFloat(drawn.opacity);
      resume.current = {
        opacity: Number.isFinite(opacity) ? opacity : 1,
        transform: drawn.transform === 'none' ? 'translateY(0)' : drawn.transform
      };
    } else {
      resume.current = null;
    }
    generation.current += 1;
    scope.cancelAll();
    setPresent(true);
    setClosing(false);
    setOpen(true);
  }, [scope]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current || !root.current) return;
      const anchor = trigger.current.getBoundingClientRect(), container = root.current.getBoundingClientRect();
      const below = innerHeight - anchor.bottom - 16, above = anchor.top - 16;
      const upward = below < 200 && above > below;
      const left = Math.max(16, Math.min(anchor.right - panel.current.offsetWidth, innerWidth - panel.current.offsetWidth - 16)) - container.left;
      setPosition({ left, right: 'auto', top: upward ? 'auto' : 'calc(100% + 8px)', bottom: upward ? 'calc(100% + 8px)' : 'auto', maxHeight: Math.max(40, Math.min(420, (upward ? above : below) - 8)) });
    };
    place(); window.addEventListener('resize', place);
    const scrolled = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) requestClose(); };
    document.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', scrolled, true); };
  }, [open, requestClose]);

  useLayoutEffect(() => {
    if (!present || !open) return;
    const element = panel.current;
    if (!element) return;
    const snapshot = resume.current;
    resume.current = null;
    const start = snapshot ?? { opacity: 0, transform: 'translateY(4px)' };
    scope.cancelAll();
    if (reduced.current) return;
    const duration = readMotionTime(element, '--nd-component-motion-control', 160);
    const ease = readMotionValue(element, '--nd-component-motion-surface-ease', 'cubic-bezier(0.22, 0.61, 0.36, 1)');
    scope.run(element, [start, { opacity: 1, transform: 'translateY(0)' }], { duration, easing: ease, slot: 'menu', fill: 'backwards' });
  }, [present, open, scope]);

  useLayoutEffect(() => {
    if (!closing) return;
    const element = panel.current;
    const current = ++generation.current;
    if (!element) { finishClose(); return; }
    if (reduced.current) { finishClose(); return; }
    const drawn = getComputedStyle(element);
    const from = { opacity: Number.parseFloat(drawn.opacity), transform: drawn.transform === 'none' ? 'translateY(0)' : drawn.transform };
    scope.cancelAll();
    const duration = readMotionTime(element, '--nd-component-motion-control', 160);
    const ease = readMotionValue(element, '--nd-component-motion-surface-ease', 'cubic-bezier(0.22, 0.61, 0.36, 1)');
    const animation = scope.run(element, [from, { opacity: 0, transform: 'translateY(-2px)' }], { duration, easing: ease, slot: 'menu', fill: 'both' });
    void animation.finished.then(() => { if (generation.current === current) finishClose(); }).catch(() => undefined);
  }, [closing, finishClose, scope]);

  useEffect(() => {
    if (closing && policy.reduced) finishClose();
  }, [closing, policy.reduced, finishClose]);

  useEffect(() => {
    // 进入途中切到减少动效：取消WAAPI后基础样式即终态，不回退到动画起点的透明/位移。
    if (present && open && policy.reduced) scope.cancelAll();
  }, [present, open, policy.reduced, scope]);

  useEffect(() => {
    if (!open) return;
    const entries = controls();
    // 底部菜单初次渲染时位置尚待布局更新；焦点不能让视口滚动并触发菜单自行关闭。
    (lastFirst.current ? entries.at(-1) : entries[0])?.focus({ preventScroll: true });
    if (panel.current) panel.current.scrollTop = lastFirst.current ? panel.current.scrollHeight : 0;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) requestClose(); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); requestClose(true); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, requestClose]);

  useEffect(() => () => scope.cancelAll(), [scope]);

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = controls();
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Tab') { requestClose(); return; }
    const target = event.key === 'ArrowDown' ? (index + 1) % entries.length
      : event.key === 'ArrowUp' ? (index - 1 + entries.length) % entries.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : undefined;
    if (target !== undefined) { event.preventDefault(); entries[target]?.focus(); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      const now = Date.now();
      search.current = { text: (now - search.current.time < 650 ? search.current.text : '') + event.key.toLocaleLowerCase(), time: now };
      const ordered = [...entries.slice(index + 1), ...entries.slice(0, index + 1)];
      ordered.find(entry => entry.textContent?.trim().toLocaleLowerCase().startsWith(search.current.text))?.focus();
    }
  };
  const setTrigger = (node: HTMLButtonElement | null): void => {
    trigger.current = node;
    if (typeof triggerRef === 'function') triggerRef(node);
    else if (triggerRef) (triggerRef as { current: HTMLButtonElement | null }).current = node;
  };
  return <div className="ui-menu" ref={root}>
    <ControlButton className={`ui-menu-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`} ref={setTrigger} data-current={currentLabel ? true : undefined} aria-label={currentLabel ? `${label}，当前页面：${currentLabel}` : undefined} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (open) requestClose(); else requestOpen(false); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); requestOpen(event.key === 'ArrowUp'); } }}>
      {triggerIcon ? <span className="ui-menu-trigger-icon" aria-hidden="true"><Icon name={triggerIcon} size={20} /></span> : null}
      <span className="ui-menu-trigger-label">{label}</span>
      {triggerIcon || triggerLayout === 'stacked' ? null : <Icon name="chevron" size={16} />}
      {triggerDecoration}
    </ControlButton>
    {present ? <div className="ui-menu-panel" role="menu" aria-label={label} id={id} ref={panel} style={position} onKeyDown={keyboard}
      data-closing={closing || undefined} inert={closing || undefined} aria-hidden={closing || undefined}
      onBlur={event => { if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) requestClose(); }}>
      {items.map(item => <ControlButton key={item.id} role="menuitem" tabIndex={-1} disabled={item.disabled} className="ui-menu-item"
        onClick={() => { requestClose(true); item.onSelect(); }}>{item.icon ? <Icon name={item.icon} size={20} /> : null}{item.label}</ControlButton>)}
    </div> : null}
  </div>;
}
