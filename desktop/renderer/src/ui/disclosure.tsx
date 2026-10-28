import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { ControlButton } from './controls';
import { Icon } from './icons';

/** Keep editor children mounted when folded; hidden excludes them from keyboard focus. */
export function Disclosure({ title, description, children, defaultOpen = false, open, onOpenChange, disabled = false }: {
  title: string; description?: string; children: ReactNode; defaultOpen?: boolean;
  open?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const expanded = open ?? internalOpen;
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  // inert 会在提交时先把内部焦点移走；用折叠前记录让焦点回到触发器。
  useLayoutEffect(() => {
    if (expanded) { hadFocus.current = false; return; }
    if (hadFocus.current) {
      hadFocus.current = false;
      trigger.current?.focus();
    }
  }, [expanded]);
  useEffect(() => {
    if (!expanded && body.current?.contains(document.activeElement)) trigger.current?.focus();
  }, [expanded]);
  const leave = (event: FocusEvent<HTMLElement>): void => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) hadFocus.current = false;
  };
  return <section className="ui-disclosure" data-open={expanded} onBlur={leave}>
    <h3><ControlButton ref={trigger} className="ui-disclosure-trigger" aria-expanded={expanded} aria-controls={id}
      disabled={disabled || (open !== undefined && !onOpenChange)} onClick={() => {
        if (body.current?.contains(document.activeElement)) trigger.current?.focus();
        if (open === undefined) setInternalOpen(!expanded);
        onOpenChange?.(!expanded);
      }}>
      <span>{title}{description ? <small>{description}</small> : null}</span><Icon name="chevron" size={20} />
    </ControlButton></h3>
    <div ref={body} id={id} className="ui-disclosure-body" inert={!expanded || undefined}
      onFocusCapture={() => { hadFocus.current = true; }}>
      <div className="ui-disclosure-inner"><div className="ui-disclosure-content">{children}</div></div>
    </div>
  </section>;
}
