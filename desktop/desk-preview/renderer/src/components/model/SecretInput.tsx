import type { FocusEvent } from 'react';
import { Button, Input } from '../../ui';

export interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}

/**
 * 密钥输入框：默认掩码隐藏，最右侧提供「显示 / 隐藏」切换按钮。
 */
export function SecretInput({
  value,
  onChange,
  visible,
  onToggleVisible,
  onFocus,
  disabled = false,
  loading = false,
  placeholder,
  'aria-label': ariaLabel,
}: SecretInputProps) {
  return (
    <div className="nd-secret-row">
      <Input
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onFocus={onFocus}
        onChange={event => onChange(event.target.value)}
      />
      <Button
        size="sm"
        disabled={disabled || loading}
        aria-pressed={visible}
        onClick={onToggleVisible}
      >
        {loading ? '读取中…' : visible ? '隐藏' : '显示'}
      </Button>
    </div>
  );
}
