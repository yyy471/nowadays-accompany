import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
  useEffect(() => { if (!expanded && body.current?.contains(document.activeElement)) trigger.current?.focus(); }, [expanded]);
  return <section className="ui-disclosure">
    <h3><ControlButton ref={trigger} className="ui-disclosure-trigger" aria-expanded={expanded} aria-controls={id}
      disabled={disabled || (open !== undefined && !onOpenChange)} onClick={() => { if (open === undefined) setInternalOpen(!expanded); onOpenChange?.(!expanded); }}>
      <span>{title}{description ? <small>{description}</small> : null}</span><Icon name="chevron" size={20} />
    </ControlButton></h3>
    <div ref={body} id={id} hidden={!expanded} className="ui-disclosure-body">{children}</div>
  </section>;
}
