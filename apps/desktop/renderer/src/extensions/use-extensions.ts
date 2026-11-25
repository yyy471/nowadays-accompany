import { useEffect, useState } from 'react';
import { backendBaseUrl } from '../conversation/backend-base';
import type { Extension } from './ExtensionSlotFrame';

interface Notice { extId: string; version: string; message: string }
export function useExtensions() {
  const [items, setItems] = useState<Extension[]>([]);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const [status, setStatus] = useState('正在读取扩展…');
  useEffect(() => {
    let active = true;
    let source: EventSource | undefined;
    void backendBaseUrl().then(base => {
      if (!active) return;
      source = new EventSource((base ?? '') + '/v1/extension-events');
      source.addEventListener('snapshot', event => {
        const next: Extension[] = JSON.parse(event.data);
        setItems(next);
        setNotices(previous => Object.fromEntries(Object.entries(previous).filter(([id, notice]) =>
          next.some(item => item.extId === id && item.version === notice.version && item.status === 'enabled'))));
        setStatus('');
      });
      source.addEventListener('notice', event => {
        const notice: Notice = JSON.parse(event.data);
        setNotices(previous => ({ ...previous, [notice.extId]: notice }));
      });
      source.onerror = () => { setItems([]); setNotices({}); setStatus('扩展连接中断，正在重连…'); };
    });
    return () => { active = false; source?.close(); };
  }, []);
  return { items, status, notices, dismiss(id: string) {
    setNotices(previous => { const next = { ...previous }; delete next[id]; return next; });
  } };
}
export type ExtensionState = ReturnType<typeof useExtensions>;
