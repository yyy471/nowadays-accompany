import { useState } from 'react';
import '../styles/photo-development.css';

/** 相纸反馈可用于舞台与媒体预览，不负责发起请求。 */
export function PhotoDevelopment({ state, reason, onRetry, actionLabel, onAction, pendingLabel = '相纸显影中…', failureLabel = '过场图没有生成' }: {
  state: 'pending' | 'failed' | 'developed';
  reason?: string | null;
  onRetry?: () => void;
  actionLabel?: string;
  onAction?: () => void;
  pendingLabel?: string;
  failureLabel?: string;
}) {
  if (state === 'developed') return <span className="photo-development-reveal" aria-hidden="true" />;
  return <div className="photo-development" data-state={state} role={state === 'failed' ? 'alert' : 'status'}>
    {state === 'pending' ? <><span className="photo-development-light" aria-hidden="true" /><span>{pendingLabel}</span></> : <>
      <span>{failureLabel}：{reason || '暂时无法完成，请再试一次。'}</span>
      {onRetry && <button type="button" onClick={onRetry}>重试</button>}
      {onAction && actionLabel && <button type="button" onClick={onAction}>{actionLabel}</button>}
    </>}
  </div>;
}

/** 在已选素材成功解码后才显影。调用方按素材编号挂载新相纸。 */
export function PhotoImage({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  const [state, setState] = useState<'pending' | 'developed' | 'failed'>('pending');
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState('');
  const source = attempt > 0 && src.startsWith('/') ? `${src}${src.includes('?') ? '&' : '?'}previewRetry=${attempt}` : src;
  const fail = (message: string) => { setReason(message); setState('failed'); };
  return <div className={`photo-preview-frame ${className}`} data-photo-state={state}>
    <img key={attempt} src={source} alt={alt} aria-hidden={state !== 'developed' || undefined}
      onLoad={event => {
        const image = event.currentTarget;
        void image.decode().then(() => {
          if (image.isConnected) setState('developed');
        }, () => {
          if (image.isConnected) fail('图片无法解码。');
        });
      }}
      onError={() => fail('图片文件暂时无法读取。')} />
    <PhotoDevelopment state={state} failureLabel="预览不可用" reason={reason} onRetry={() => {
      setState('pending');
      setAttempt(value => value + 1);
    }} />
  </div>;
}
