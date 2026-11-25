import { forwardRef } from 'react';
import { ControlButton, type ControlButtonProps } from './controls';

export type SwitchProps = Omit<ControlButtonProps, 'onChange' | 'onClick' | 'role' | 'aria-checked' | 'children'> & {
  checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; layout?: 'leading' | 'trailing';
};

/** Controlled switch: busy remains focusable, while duplicate activation is blocked. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, busy = false, disabled, layout = 'leading', className = '', ...props }, ref) => {
    return <ControlButton {...props} ref={ref} type="button" role="switch" aria-label={label} aria-checked={checked}
      busy={busy} aria-disabled={disabled || props['aria-disabled']} disabled={disabled}
      className={`ui-switch${layout==='trailing'?' ui-switch-trailing':''} ${className}`} onClick={() => onCheckedChange(!checked)}>
      <span className="ui-switch-track" aria-hidden="true"><span className="ui-switch-thumb" /></span>
      <span className="ui-switch-label" aria-hidden="true">{label}</span>
      <span className="ui-switch-value" aria-hidden="true">{busy ? '更新中…' : checked ? '已开启' : '已暂停'}</span>
    </ControlButton>;
  }
);
Switch.displayName = 'Switch';
