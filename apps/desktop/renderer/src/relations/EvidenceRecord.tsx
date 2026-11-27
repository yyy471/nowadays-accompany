import { errorText } from '../lib/error-text';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api';

type EvidenceRecordState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; content: string; occurredAt: string };

const localDateTime: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
};

export function EvidenceRecord({ id, roleId, evidenceId, trigger }: {
  id: string;
  roleId: string;
  evidenceId?: string;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const [record, setRecord] = useState<EvidenceRecordState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const occurredAt = record.status === 'ready' && typeof record.occurredAt === 'string' ? record.occurredAt.trim() : '';
  const timestamp = /^\d{4}-\d{2}-\d{2}T/.test(occurredAt) ? Date.parse(occurredAt) : NaN;

  useEffect(() => {
    if (!evidenceId) return;
    const controller = new AbortController();
    void api<{ content: string; occurredAt: string }>(
      `/v1/roles/${encodeURIComponent(roleId)}/memory/evidence/${encodeURIComponent(evidenceId)}`,
      { signal: controller.signal }
    ).then(evidence => {
      if (!controller.signal.aborted) setRecord({ status: 'ready', ...evidence });
    }).catch(reason => {
      if (!controller.signal.aborted) setRecord({ status: 'failed', message: errorText(reason) });
    });
    return () => controller.abort();
  }, [roleId, evidenceId, attempt]);

  useLayoutEffect(() => {
    const element = panel.current;
    const focused = document.activeElement;
    if (!element || (focused !== trigger.current && focused !== document.body && !element.contains(focused))) return;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    if (record.status === 'ready') element.focus({ preventScroll: true });
  }, [record.status, trigger]);

  return <div id={id} className="evidence" ref={panel} tabIndex={-1} role="region" aria-label="原始记录" data-state={evidenceId ? record.status : 'unavailable'}>
    {!evidenceId ? <p>这条经历没有留下原始记录。</p> : record.status === 'loading' ? <p className="evidence-loading" role="status">
      <span className="spinner" aria-hidden="true" />正在读取原始记录…
    </p> : record.status === 'failed' ? <>
      <p role="alert">{record.message}</p>
      <button type="button" className="evidence-button" onClick={() => {
        panel.current?.focus({ preventScroll: true });
        setRecord({ status: 'loading' });
        setAttempt(value => value + 1);
      }}>重试读取</button>
    </> : <>
      <span className="evidence-location-ink" aria-hidden="true" />
      {Number.isFinite(timestamp)
        ? <time className="evidence-time" dateTime={occurredAt}>{new Date(timestamp).toLocaleString('zh-CN', localDateTime)}</time>
        : <span className="evidence-time">时间未记</span>}
      <blockquote>{record.content}</blockquote>
      <cite>来自保存的原始记录。</cite>
    </>}
  </div>;
}
