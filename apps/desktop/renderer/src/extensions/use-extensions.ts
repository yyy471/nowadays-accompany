import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { backendBaseUrl } from '../conversation/backend-base';
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
    void backendBaseUrl().then(base => {
      if (!active) return;
      source = new EventSource((base ?? '') + '/v1/extension-events');
      source.addEventListener('coplay-share', receiveShare);
      source.addEventListener('snapshot', event => {
        const next = parseExtensionSnapshot(event.data);
        repairs.reconcile(next);
        setItems(next);
        setNotices(previous => Object.fromEntries(Object.entries(previous).filter(([id, notice]) =>
          next.some(item => item.extId === id && item.version === notice.version && item.status === 'enabled'))));
        setConnection('ready');
      });
      source.addEventListener('notice', event => {
        const payload: Omit<Notice, 'receiptId'> = JSON.parse(event.data);
        const notice = { ...payload, receiptId: ++nextReceipt.current };
        setNotices(previous => ({ ...previous, [notice.extId]: notice }));
      });
      source.onerror = () => { setItems([]); setNotices({}); setConnection('reconnecting'); };
    });
    return () => { active = false; source?.close(); };
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
