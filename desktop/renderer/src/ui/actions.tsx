import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Button, type ButtonProps } from './foundation';
import { ControlButton } from './controls';
import { Icon, type IconName } from './icons';

export function ConfirmButton({ variant = 'primary', children = '确认', ...props }: ButtonProps) {
  return <Button {...props} variant={variant}>{children}</Button>;
}
export function CancelButton({ variant = 'default', children = '取消', ...props }: ButtonProps) {
  return <Button {...props} variant={variant}>{children}</Button>;
}
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { icon: IconName; label: string; size?: number }>(
  ({ icon, label, size = 17, className, ...props }, ref) => <ControlButton {...props} ref={ref}
    className={`ui-icon-button${className ? ` ${className}` : ''}`} aria-label={label} title={props.title ?? label}>
    <Icon name={icon} size={size} />
  </ControlButton>
);
IconButton.displayName = 'IconButton';
