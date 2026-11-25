import '../../styles/config-probe.css';

export type ProbeFeedbackNotice = {
  role: 'status' | 'alert';
  text: string;
  source?: 'list' | 'test';
  attempt?: number;
};

export function ProbeFeedback({ busy, notice, testAnnouncedExternally, reserveSpace, className }: {
  busy?: boolean;
  notice?: ProbeFeedbackNotice | null;
  testAnnouncedExternally?: boolean;
  reserveSpace?: boolean;
  className?: string;
}) {
  const text = busy ? '正在测试连接…' : notice?.text;
  if (!text && !reserveSpace) return null;
  const state = busy ? 'busy' : !notice ? 'idle' : notice.role === 'alert' ? 'error' : notice.source === 'list' ? 'info' : 'success';
  const role = busy ? 'status' : testAnnouncedExternally && notice?.source !== 'list' ? undefined : notice?.role;
  return <p className={className ? `config-probe-feedback ${className}` : 'config-probe-feedback'} data-state={state} role={role}>
    {state === 'success' && <span key={notice?.attempt} className="config-probe-sweep" aria-hidden="true"/>}
    {(state === 'busy' || state === 'success' || state === 'error') && <span className="config-probe-marker" aria-hidden="true"/>}
    {text && <span className="config-probe-copy">{text}</span>}
  </p>;
}
