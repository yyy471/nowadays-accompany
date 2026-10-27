import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ControlButton } from './controls';
import { Icon, type IconName } from './icons';

export type MenuItem = { id: string; label: string; icon?: IconName; disabled?: boolean; onSelect: () => void };

/** Action menu; account selection and page navigation have separate semantics. */
export function DropdownMenu({ label, items, currentLabel }: { label: string; items: MenuItem[]; currentLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const lastFirst = useRef(false);
  const search = useRef({ text: '', time: 0 });
  const id = useId();
  const controls = () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
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
    const scrolled = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) close(); };
    document.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', scrolled, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const entries = controls();
    // 底部菜单初次渲染时位置尚待布局更新；焦点不能让视口滚动并触发菜单自行关闭。
    (lastFirst.current ? entries.at(-1) : entries[0])?.focus({ preventScroll: true });
    if (panel.current) panel.current.scrollTop = lastFirst.current ? panel.current.scrollHeight : 0;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = controls();
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Tab') { close(); return; }
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
  return <div className="ui-menu" ref={root}>
    <ControlButton className="ui-menu-trigger" ref={trigger} data-current={currentLabel?true:undefined} aria-label={currentLabel?`${label}，当前页面：${currentLabel}`:undefined} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { lastFirst.current = false; setOpen(value => !value); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); lastFirst.current = event.key === 'ArrowUp'; setOpen(true); } }}>
      {label}<Icon name="chevron" size={16} />
    </ControlButton>
    {open ? <div className="ui-menu-panel" role="menu" aria-label={label} id={id} ref={panel} style={position} onKeyDown={keyboard}
      onBlur={event => { if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) close(); }}>
      {items.map(item => <ControlButton key={item.id} role="menuitem" tabIndex={-1} disabled={item.disabled} className="ui-menu-item"
        onClick={() => { close(true); item.onSelect(); }}>{item.icon ? <Icon name={item.icon} size={20} /> : null}{item.label}</ControlButton>)}
    </div> : null}
  </div>;
}
