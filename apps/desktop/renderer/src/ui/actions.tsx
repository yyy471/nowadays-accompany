import { forwardRef } from 'react';
import { Button, type ButtonProps } from './foundation';
import { ControlButton, type ControlButtonProps } from './controls';
import { Icon, type IconName } from './icons';

export function ConfirmButton({ variant = 'primary', children = '确认', ...props }: ButtonProps) {
  return <Button {...props} variant={variant}>{children}</Button>;
}
export function CancelButton({ variant = 'default', children = '取消', ...props }: ButtonProps) {
  return <Button {...props} variant={variant}>{children}</Button>;
}
export const IconButton = forwardRef<HTMLButtonElement, Omit<ControlButtonProps, 'children'> & { icon: IconName; label: string; size?: number }>(
  ({ icon, label, size = 17, className, busy, ...props }, ref) => <ControlButton {...props} ref={ref} busy={busy}
    className={`ui-icon-button${className ? ` ${className}` : ''}`} aria-label={label} title={props.title ?? label}>
    {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name={icon} size={size} />}
  </ControlButton>
);
IconButton.displayName = 'IconButton';
