import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick' | 'role' | 'aria-checked' | 'children'> & {
  checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; busy?: boolean; layout?: 'leading' | 'trailing';
};

/** Controlled switch: busy remains focusable, while duplicate activation is blocked. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, busy = false, disabled, layout = 'leading', className = '', ...props }, ref) => {
    const blocked = busy || disabled || props['aria-disabled'] === true || props['aria-disabled'] === 'true';
    return <button {...props} ref={ref} type="button" role="switch" aria-label={label} aria-checked={checked}
      aria-busy={busy || undefined} aria-disabled={blocked || undefined} disabled={disabled}
      className={`ui-switch${layout==='trailing'?' ui-switch-trailing':''} ${className}`} onClick={() => { if (!blocked) onCheckedChange(!checked); }}>
      <span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span>
      <span className="ui-switch-label" aria-hidden="true">{label}</span>
      <span className="ui-switch-value" aria-hidden="true">{busy ? '更新中…' : checked ? '已开启' : '已暂停'}</span>
    </button>;
  }
);
Switch.displayName = 'Switch';
