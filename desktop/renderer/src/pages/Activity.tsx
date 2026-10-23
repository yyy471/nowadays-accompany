import { useMemo, useState } from 'react';
import type { StreamEvent } from '../types';
import type { StreamStatus } from '../api';
import { Button, Card, Empty, SearchInput, Select, Tag, formatTime } from '../ui';

interface ActivityPageProps {
  events: StreamEvent[];
  status: StreamStatus;
  onClear: () => void;
}

const STATUS_LABELS: Record<StreamStatus, string> = {
  connecting: '连接中',
  open: '实时',
  retrying: '重连中'
};

function eventSummary(event: StreamEvent): string {
  const payload = event.payload;
  if (event.type === 'instance:state') {
    return `${String(payload.from ?? '?')} → ${String(payload.to ?? '?')}`;
  }
  if (event.type === 'instance:error') {
    return `${String(payload.code ?? 'error')}: ${String(payload.message ?? '')}`;
  }
  if (event.type === 'instance:profile') {
    const roleCard = payload.roleCard as { id?: string } | undefined;
    return `档案 ${String(payload.state ?? '?')}${roleCard?.id ? ` · 角色卡 ${roleCard.id}` : ''}`;
  }
  if (event.type === 'channel:inbound') {
    const inbound = payload.event as
      | { type?: string; kind?: string; peerId?: string; senderId?: string }
      | undefined;
    const scope = inbound?.kind ? ` · ${inbound.kind}:${inbound.peerId ?? ''}` : '';
    const sender = inbound?.senderId ? ` · ${inbound.senderId}` : '';
    return `${inbound?.type ?? 'event'}${scope}${sender}`;
  }
  if (event.type === 'channel:outbound') {
    const conversation = payload.conversation as { kind?: string; peerId?: string } | undefined;
    return `发送 ${conversation?.kind ?? ''}:${conversation?.peerId ?? ''}${payload.messageId ? ` · ${String(payload.messageId)}` : ''}`;
  }
  if (event.type === 'channel:status') {
    return payload.connected ? `已连接${payload.selfId ? ` · ${String(payload.selfId)}` : ''}` : '连接断开';
  }
  return String(payload.message ?? payload.code ?? '');
}

export function ActivityPage({ events, status, onClear }: ActivityPageProps) {
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const [pausedAt, setPausedAt] = useState<number>();

  const visible = useMemo(() => {
    const source = pausedAt === undefined ? events : events.filter((event) => event.id <= pausedAt);
    const needle = query.trim().toLowerCase();
    return [...source]
      .reverse()
      .filter((event) => {
        if (scope !== 'all' && !event.type.startsWith(scope)) return false;
        if (!needle) return true;
        return (
          event.type.toLowerCase().includes(needle) ||
          JSON.stringify(event.payload).toLowerCase().includes(needle)
        );
      });
  }, [events, pausedAt, query, scope]);

  return (
    <div className="page-stack">
      <div className="activity-toolbar">
        <div className="toolbar-group">
          <span className={`stock-dot status-${status}`} />
          <span className="muted">{STATUS_LABELS[status]}</span>
          <span className="muted">· {events.length} 条本次会话事件</span>
        </div>
        <div className="toolbar-group">
          <Select aria-label="事件类型" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="all">全部事件</option>
            <option value="instance">实例</option>
            <option value="channel">通道</option>
          </Select>
          <SearchInput
            label="过滤事件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="过滤类型或内容"
          />
          <Button
            size="sm"
            variant={pausedAt === undefined ? 'default' : 'primary'}
            onClick={() =>
              setPausedAt((current) => (current === undefined ? (events.at(-1)?.id ?? 0) : undefined))
            }
          >
            {pausedAt === undefined ? '暂停' : '继续'}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={onClear}>
            清空
          </Button>
        </div>
      </div>

      <Card>
        {visible.length === 0 ? (
          <Empty
            icon="activity"
            title="没有匹配的事件"
            description="实例状态、通道收发、档案切换都会实时出现在这里。事件流断线后会自动从最后的事件 ID 续传。"
          />
        ) : (
          <div className="event-list">
            {visible.slice(0, 300).map((event) => (
              <details className="event-row" key={`${event.id}-${event.type}`}>
                <summary>
                  <span className="event-time mono">{formatTime(event.at)}</span>
                  <Tag tone={event.type.startsWith('instance:error') ? 'bad' : event.type.startsWith('channel') ? 'ok' : 'idle'}>
                    {event.type}
                  </Tag>
                  <span className="event-instance mono">
                    {String(event.payload.instanceId ?? event.payload.accountId ?? '')}
                  </span>
                  <span className="event-summary">{eventSummary(event)}</span>
                  <span className="event-id mono muted">#{event.id}</span>
                </summary>
                <pre className="snippet">{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
