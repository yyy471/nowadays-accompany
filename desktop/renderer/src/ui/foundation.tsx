import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { InstanceState } from '../types';
import { Icon, type IconName } from './icons';
import { ControlButton } from './controls';
import { useUiAppearance } from './appearance';
const STATE_LABELS: Record<InstanceState, string> = {
  provisioning: '准备中',
  starting: '启动中',
  awaiting_login: '等待登录',
  online: '在线',
  degraded: '降级',
  awaiting_profile: '待配置档案',
  stopping: '停止中',
  stopped: '已停止',
  failed: '失败'
};

const STATE_TONES: Record<InstanceState, string> = {
  provisioning: 'tone-busy',
  starting: 'tone-busy',
  awaiting_login: 'tone-warn',
  online: 'tone-ok',
  degraded: 'tone-warn',
  awaiting_profile: 'tone-warn',
  stopping: 'tone-busy',
  stopped: 'tone-idle',
  failed: 'tone-bad'
};

export function stateLabel(state: InstanceState): string {
  return STATE_LABELS[state] ?? state;
}

export function StatePill({ state, dot = true }: { state: InstanceState; dot?: boolean }) {
  return (
    <span className={`pill ${STATE_TONES[state] ?? 'tone-idle'}`}>
      {dot ? <span className="pill-dot" /> : null}
      {stateLabel(state)}
    </span>
  );
}

export function Tag({ children, tone = 'idle' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'entry';
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: IconName;
  feedback?: 'error' | 'success';
};

export function Button({
  variant = 'default',
  size = 'md',
  busy = false,
  icon,
  children,
  className,
  disabled,
  feedback,
  onClick,
  style,
  ...rest
}: ButtonProps) {
  const appearance = useUiAppearance();
  const element = useRef<HTMLButtonElement>(null);
  const restingWidth = useRef(0);
  useLayoutEffect(() => {
    if (appearance.theme === 'xiacheng' && !busy && element.current) restingWidth.current = element.current.getBoundingClientRect().width;
  }, [appearance.theme, busy, children, size, variant]);
  const blocked = disabled || busy || rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  const leading = busy ? <span className="spinner" aria-hidden="true" /> : feedback ? <Icon name={feedback === 'error' ? 'warning' : 'check'} size={16} /> : icon ? <Icon name={icon} size={appearance.theme === 'xiacheng' ? 16 : 15} /> : null;
  return (
    <ControlButton
      {...rest}
      ref={element}
      style={appearance.theme === 'xiacheng' && busy && restingWidth.current ? { ...style, minWidth: restingWidth.current } : style}
      aria-busy={busy || undefined}
      disabled={disabled || (busy && appearance.theme !== 'xiacheng')}
      aria-disabled={blocked || undefined}
      aria-invalid={rest['aria-invalid'] ?? (feedback === 'error' || undefined)}
      data-feedback={feedback}
      onClick={(event) => { if (blocked) { event.preventDefault(); event.stopPropagation(); return; } onClick?.(event); }}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}
    >
      {appearance.theme === 'xiacheng' ? <span className="ui-button-leading" aria-hidden="true">{leading}</span> : leading}
      {variant === 'entry' ? <><span className="ui-button-label">{children}</span><span className="ui-button-end" aria-hidden="true"><Icon name="chevron" size={20} /></span></> : children}
    </ControlButton>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {title || actions ? (
        <header className="card-head">
          <div>
            {title ? <h3>{title}</h3> : null}
            {subtitle ? <p className="card-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Empty({
  icon = 'package',
  title,
  description,
  action
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h4>{title}</h4>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <Icon name="warning" size={16} />
      <span>{message}</span>
      {onRetry ? (
        <ControlButton type="button" className="link-btn" onClick={onRetry}>
          重试
        </ControlButton>
      ) : null}
    </div>
  );
}

export function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function relativeTime(value: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
