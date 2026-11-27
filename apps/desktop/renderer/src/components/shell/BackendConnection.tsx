import { useEffect, useState } from 'react';
import { api } from '../../api';

export async function backendReachable(signal: AbortSignal) {
  try {
    const health = await api<{ status: string }>('/v1/health', { signal });
    return health?.status === 'ok';
  } catch {
    return false;
  }
}

export function BackendConnection() {
  const [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    let pending = false;
    const check = async () => {
      if (document.hidden || pending) return;
      pending = true;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(4000)]);
      const ok = await backendReachable(signal);
      if (!lifetime.signal.aborted) setReachable(ok);
      pending = false;
    };
    void check();
    const timer = window.setInterval(check, 5000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      lifetime.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);
  const label = reachable === null ? '正在检查本机服务' : reachable ? '本机服务已连接' : '本机服务暂不可用';
  return <span className="studio-connection" data-state={reachable === null ? 'checking' : reachable ? 'online' : 'offline'}
    role="img" aria-label={label} title={label}/>;
}
