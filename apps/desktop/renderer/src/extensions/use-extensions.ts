import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { backendBaseUrl, invalidateBackendBaseUrl } from '../conversation/backend-base';
import type { Extension } from './ExtensionSlotFrame';
import { createRepairSender } from './repair-request';

interface Notice { extId: string; version: string; message: string; receiptId: number }
type SnapshotItem = Omit<Extension, 'tools' | 'ui'> & { tools?: Extension['tools'] | null; ui?: Extension['ui'] | null };
export function parseExtensionSnapshot(data: string): Extension[] {
  return (JSON.parse(data) as SnapshotItem[]).map(item => ({ ...item, tools: item.tools ?? [], ui: item.ui ?? [] }));
}
export function useExtensions(onCoplayShare: (event: MessageEvent) => void) {
  const receiveShare = useEffectEvent(onCoplayShare);
  const [, refreshRepairs] = useState(0);
  const [repairs] = useState(() => createRepairSender(() => refreshRepairs(value => value + 1)));
  const [items, setItems] = useState<Extension[]>([]);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const nextReceipt = useRef(0);
  const [connection, setConnection] = useState<'loading' | 'ready' | 'reconnecting'>('loading');
  useEffect(() => {
    let active = true;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = (refresh: boolean) => {
      void backendBaseUrl(refresh ? { refresh: true } : undefined).then(base => {
        if (!active) return;
        const es = new EventSource((base ?? '') + '/v1/extension-events');
        source = es;
        es.addEventListener('coplay-share', receiveShare);
        es.addEventListener('snapshot', event => {
          if (source !== es) return;
          const next = parseExtensionSnapshot(event.data);
          repairs.reconcile(next);
          setItems(next);
          setNotices(previous => Object.fromEntries(Object.entries(previous).filter(([id, notice]) =>
            next.some(item => item.extId === id && item.version === notice.version && item.status === 'enabled'))));
          setConnection('ready');
        });
        es.addEventListener('notice', event => {
          if (source !== es) return;
          const payload: Omit<Notice, 'receiptId'> = JSON.parse(event.data);
          const notice = { ...payload, receiptId: ++nextReceipt.current };
          setNotices(previous => ({ ...previous, [notice.extId]: notice }));
        });
        es.onerror = () => {
          if (!active || source !== es) return;
          // 瞬断只标记重连：保留已挂载的扩展微页与挂件，等新快照到达再更新。
          invalidateBackendBaseUrl();
          setConnection('reconnecting');
          if (es.readyState !== EventSource.CLOSED) return;
          // 浏览器不会重连已关闭的流：重读地址后重建连接，避免沿用旧端口。
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { if (active) connect(true); }, 1000);
        };
      });
    };
    connect(false);
    return () => { active = false; clearTimeout(reconnectTimer); source?.close(); };
  }, [repairs]);
  return { items, connection, notices, repairs, dismiss(notice: Notice) {
    setNotices(previous => {
      if (previous[notice.extId]?.receiptId !== notice.receiptId) return previous;
      const next = { ...previous };
      delete next[notice.extId];
      return next;
    });
  } };
}
export type ExtensionState = ReturnType<typeof useExtensions>;
