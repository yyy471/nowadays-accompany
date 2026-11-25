import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Button, ControlButton, Icon, IconButton, Modal, StatusDot, UiThemeScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy, type DotStatus } from '../ui';
import { ConfigNotice } from '../components/config/ConfigNotice';
import { ConfigThemeTransition } from '../ui/config-theme-transition';
import { useThemePreset } from '../ui/presets';
import type { RoleListItem } from '../types';
import {
  loadFeed, loadUpcoming, loadTranscript, messageKey, type Exchange, type ExchangeTurn,
  type Activity, type FeedData, type MemoryBatch, type RoleActivity, type SharedMessage, type Task, type Wake,
} from '../feed/data';

type FeedType = 'exchange' | 'share' | 'activity' | 'wake' | 'system';
type FeedEvent = {
  id: string;
  roleId: string;
  at: string;
  type: FeedType;
  exchange?: Exchange;
  wake?: Wake;
  activity?: Activity;
  batch?: MemoryBatch;
  roleActivity?: RoleActivity;
};
type Range = 'today' | 'week' | 'all';
type LoadState<T> = { data: T | null; error: string; initialFailure?: boolean; loading: boolean; readStarted: number };
type RefreshResult = { id: number; ok: boolean };
type RefreshRequest = { feed?: number; upcoming?: number };
type RefreshNotice = { message: string; tone: 'success' | 'warning' | 'error' };
type Status = { status: DotStatus; label: string; bare?: boolean; faint?: boolean; pulse?: boolean };
type ChatTarget = { roleId: string; windowId: string; messageId?: string; eventId: string };

const types: Array<[FeedType | 'all', string]> = [
  ['all', '全部'], ['exchange', '往来'], ['share', '分享'], ['activity', '活动'], ['wake', '安排'], ['system', '系统'],
];
const ranges: Array<[Range, string]> = [['today', '今天'], ['week', '7 天'], ['all', '全部']];
const labels: Record<FeedType, string> = { exchange: '往来', share: '分享', activity: '活动', wake: '安排', system: '系统' };
const errorDescriptions: Record<string, string> = {
  ROLE_STOPPED: '角色已停止活动',
  ROLE_EXCHANGE_NO_REPLY: '角色结束了本次活动，未发送下一轮发言',
  EXECUTION_FAILED: '执行没有完成',
  MEMORY_MODEL_FAILED: '整理用的模型没有返回结果',
  MEMORY_CAPACITY_EXCEEDED: '这一批太长，只整理了一部分',
  AUTONOMY_BUDGET_EXHAUSTED: '今日额度用完',
  TASK_CIRCUIT_BREAKER: '连续失败，任务已暂停',
};

function useFeedRead<T>(roles: RoleListItem[], loader: (roles: RoleListItem[], signal: AbortSignal) => Promise<T>, activePage: boolean) {
  const [state, setState] = useState<LoadState<T>>({ data: null, error: '', loading: true, readStarted: 0 });
  const [retry, setRetry] = useState(0);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);
  const retrySeq = useRef(0);
  const pendingRetry = useRef(0);
  useEffect(() => {
    if (!activePage) { pendingRetry.current = 0; return; }
    let active = true;
    let running = false;
    const controller = new AbortController();
    const retryToken = pendingRetry.current === retry ? retry : 0;
    const isCurrent = () => active && retrySeq.current === retry;
    const read = async (entry = false) => {
      if (running || !isCurrent()) return;
      running = true;
      const readStarted = performance.now();
      let ok = false;
      try {
        const data = await loader(roles, controller.signal);
        ok = true;
        if (isCurrent()) setState({ data, error: '', loading: false, readStarted });
      } catch (error) {
        if (isCurrent()) {
          setState(previous => ({
            ...previous, loading: false, initialFailure: entry && previous.loading && !retryToken,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        running = false;
        if (isCurrent() && retryToken && pendingRetry.current === retryToken) {
          pendingRetry.current = 0;
          setRefreshResult({ id: retryToken, ok });
        }
      }
    };
    void read(true);
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 15000);
    const onVisible = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [roles, loader, retry, activePage]);
  return {
    ...state,
    refreshResult,
    retry: () => {
      const token = ++retrySeq.current;
      pendingRetry.current = token;
      setRetry(token);
      return token;
    },
  };
}

function eventList(data: FeedData): FeedEvent[] {
  const events: FeedEvent[] = [
    ...data.exchanges.map(exchange => ({
      id: JSON.stringify(['exchange', exchange.sessionId]), roleId: exchange.initiatorRoleId,
      at: exchange.startedAt, type: 'exchange' as const, exchange,
    })),
    ...data.wakes.map(wake => ({
      id: JSON.stringify([wake.roleId, 'wake', wake.wakeId]), roleId: wake.roleId,
      at: wake.createdAt, type: wake.kind === 'budget_resume' ? 'system' as const : 'wake' as const, wake,
    })),
    ...data.activities.map(activity => ({
      id: JSON.stringify([activity.roleId, 'activity', activity.activityId]), roleId: activity.roleId,
      at: data.messages[messageKey(activity.roleId, activity.sharedMessageId ?? '')]?.createdAt ?? activity.startedAt,
      type: activity.sharedMessageId ? 'share' as const : 'activity' as const, activity,
    })),
    ...data.batches.map(batch => ({
      id: JSON.stringify([batch.roleId, 'memory', batch.batchId]), roleId: batch.roleId,
      at: batch.finishedAt ?? batch.startedAt, type: 'system' as const, batch,
    })),
    ...data.roleActivities.filter(role => role.state === 'stopped' && role.confirmedAt).map(role => ({
      id: JSON.stringify([role.roleId, 'stop', role.confirmedAt]), roleId: role.roleId,
      at: role.confirmedAt!, type: 'system' as const, roleActivity: role,
    })),
  ];
  return events.filter(event => Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) <= Date.now())
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

function activityStatus(activity: Activity, task?: Task, role?: RoleActivity): Status {
  if (activity.status === 'running') return { status: 'off', label: '进行中', pulse: true };
  if (activity.status === 'failed') return { status: 'error', label: '失败' };
  if (activity.status === 'paused') {
    if (task?.waitReason === 'AWAITING_USER_INPUT') return { status: 'dirty', label: '等你回复' };
    if (task?.waitReason === 'CIRCUIT_BREAKER') return { status: 'error', label: '连续失败，已暂停' };
    if (task?.waitReason === 'AUTONOMY_BUDGET_EXHAUSTED') return { status: 'off', label: '额度用尽，已暂停' };
    if (role && role.state !== 'active') return { status: 'off', label: '角色已停止，已暂停' };
    return { status: 'off', label: '已暂停' };
  }
  return { status: 'ok', label: '已完成', bare: true, faint: true };
}
function wakeStatus(wake: Wake, role?: RoleActivity): Status {
  if (wake.status === 'cancelled') return { status: 'off', label: '已取消' };
  if (wake.status === 'pending') {
    return role && role.state !== 'active'
      ? { status: 'off', label: '不会执行' }
      : { status: 'follow', label: '待执行', bare: true };
  }
  if (wake.status === 'claimed') return { status: 'off', label: '执行中', pulse: true };
  if (wake.lastErrorCode) return { status: 'error', label: '执行失败' };
  return { status: 'ok', label: '已执行', bare: true, faint: true };
}
function batchStatus(batch: MemoryBatch): Status {
  if (batch.status === 'failed') return { status: 'error', label: '整理失败' };
  if (batch.status === 'partial') return { status: 'off', label: '部分未完成' };
  if (batch.status === 'running') return { status: 'off', label: '整理中', pulse: true };
  return { status: 'ok', label: '已整理', bare: true, faint: true };
}
function dateKey(value: string | Date): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function dateLabel(value: string | Date): string {
  return new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}
function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return `${dateLabel(value)} ${timeLabel(value)}`;
}
function duration(start: string, end: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function Face({ role, image }: { role?: RoleListItem; image?: string }) {
  return <span className="feed-face" aria-hidden="true">{image ? <img src={image} alt=""/> : <span>{role?.displayName?.slice(0, 1) || '·'}</span>}</span>;
}
function StatusView({ value, visible = false }: { value: Status; visible?: boolean }) {
  return <span className="feed-status" data-pulse={value.pulse || undefined}><StatusDot status={value.status} label={value.label} bare={!visible && value.bare} faint={value.faint}/></span>;
}
function Intent({ children }: { children: ReactNode }) {
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const requestedChange = useRef(false);
  const { reduced } = useMotionPolicy();
  useLayoutEffect(() => {
    const element = text.current;
    const changed = requestedChange.current;
    requestedChange.current = false;
    if (!element || !changed || reduced) return;
    const duration = readMotionTime(element, expanded ? '--nd-semantic-motion-component' : '--nd-semantic-motion-component-exit', expanded ? 220 : 160);
    const offset = readMotionPx(element, '--nd-semantic-motion-detail-page-offset', 4);
    const current = element.animate([{ opacity: .55, transform: `translateY(${expanded ? -offset : offset}px)` }, { opacity: 1, transform: 'none' }], {
      duration, easing: readMotionValue(element, expanded ? '--nd-semantic-motion-ease-out' : '--nd-semantic-motion-ease-in', 'ease'),
    });
    return () => current.cancel();
  }, [expanded, reduced]);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    let active = true;
    const measure = () => { if (active) setOverflow(element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    void document.fonts?.ready.then(measure);
    return () => { active = false; observer.disconnect(); };
  }, [children, expanded]);
  return <div className="feed-intent"><p id={id} ref={text} data-collapsed={!expanded || undefined}>{children}</p>
    {(overflow || expanded) && <ControlButton className="feed-expand" aria-controls={id} aria-expanded={expanded} onClick={() => {
      requestedChange.current = true;
      setExpanded(value => !value);
    }}>{expanded ? '收起' : '展开'}<Icon name="chevron" size={12}/></ControlButton>}
  </div>;
}

function ExchangeTranscript({ exchange }: { exchange: Exchange }) {
  const [turns, setTurns] = useState<ExchangeTurn[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void loadTranscript(exchange.sessionId, controller.signal).then(detail => {
      if (!controller.signal.aborted) setTurns(detail.turns);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [exchange.sessionId, exchange.turnCount, retry]);
  if (error) return <p role="alert">{error} <Button size="sm" onClick={() => setRetry(n => n + 1)}>重试</Button></p>;
  if (!turns) return <p role="status">正在读取聊天记录…</p>;
  return <ol className="feed-transcript" aria-label="完整聊天记录">{turns.map(turn => <li key={turn.exchangeId}>
    <strong>{turn.speakerName}</strong> · <time dateTime={turn.createdAt}>{dateTime(turn.createdAt)}</time>
    <p className="feed-letter-text">{turn.content}</p>
  </li>)}</ol>;
}

function EventContent({ event, message, task }: { event: FeedEvent; message?: SharedMessage; task?: Task }) {
  if (event.exchange) return <p>{event.exchange.topic} · {event.exchange.turnCount} 轮</p>;
  if (message) return <p className="feed-letter-text">{message.content}</p>;
  if (event.type === 'share') return <p className="feed-muted">分享原文不可用</p>;
  if (event.activity) {
    return <p className={!event.activity.summary ? 'feed-muted' : ''}>{event.activity.summary || task?.goal || '—'}</p>;
  }
  if (event.batch) {
    return <p>整理了一批记忆 <span className="feed-number">第 {event.batch.inputFromSequence}–{event.batch.inputToSequence} 条消息</span></p>;
  }
  if (event.roleActivity) return <p>不再产生新的活动，已排的安排保留</p>;
  if (event.wake?.kind === 'budget_resume') return <p>进度已保存，{dateTime(event.wake.scheduledAt)}继续</p>;
  if (event.wake) {
    return <Intent><span className="feed-number">{dateTime(event.wake.scheduledAt)}</span> {event.wake.intent}</Intent>;
  }
  return null;
}

function moveTimelineFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement)) return;
  const item = event.target.closest('.feed-event');
  const currentButton = item?.querySelector<HTMLButtonElement>('.feed-detail');
  if (!currentButton) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.feed-event .feed-detail')];
  const current = buttons.indexOf(currentButton);
  let next = current;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = buttons.length - 1;
  if (event.key === 'ArrowDown') next = Math.min(current + 1, buttons.length - 1);
  if (event.key === 'ArrowUp') next = Math.max(current - 1, 0);
  const button = buttons[next];
  if (!button) return;
  event.preventDefault();
  button.focus();
  button.closest('.feed-event')?.scrollIntoView({ block: 'nearest' });
}

function Upcoming({ wakes, roles, states, portraits, onOpen }: { wakes: Wake[]; roles: RoleListItem[]; states: RoleActivity[]; portraits: Record<string, string>; onOpen: (event: FeedEvent, source: HTMLElement) => void }) {
  if (!wakes.length) return <p className="feed-next-empty">暂无安排</p>;
  return <ul className="feed-next-list">{wakes.map(wake => {
    const role = roles.find(item => item.roleId === wake.roleId);
    const state = states.find(item => item.roleId === wake.roleId);
    const status = wakeStatus(wake, state);
    const item: FeedEvent = { id: JSON.stringify([wake.roleId, 'wake', wake.wakeId]), roleId: wake.roleId, at: wake.createdAt, type: 'wake', wake };
    return <li className="feed-next-item" key={item.id} onClick={event => {
      if ((event.target as Element).closest('button')) return;
      const trigger = event.currentTarget.querySelector<HTMLButtonElement>('.feed-next-open');
      if (trigger) onOpen(item, trigger);
    }}>
      <Face role={role} image={portraits[wake.roleId]}/>
      <div className="feed-next-heading"><ControlButton className="feed-next-open" onClick={event => onOpen(item, event.currentTarget)}>{role?.displayName || '角色'}</ControlButton>
        {wake.kind === 'budget_resume' && <span className="feed-kind">额度恢复后</span>}<time dateTime={wake.scheduledAt}>{dateTime(wake.scheduledAt)}</time></div>
      <Intent>{wake.intent}</Intent>{!status.bare && <StatusView value={status} visible/>}
    </li>;
  })}</ul>;
}

export function FeedPage({ active, roles, rolesLoading, roleError, retryingRoles, onRetryRoles, onOpenChat }: {
  active: boolean; roles: RoleListItem[]; rolesLoading: boolean; roleError: string; retryingRoles?: boolean; onRetryRoles: () => void; onOpenChat: (target: ChatTarget) => void;
}) {
  const { preset } = useThemePreset();
  const { reduced } = useMotionPolicy();
  const canRead = active && !rolesLoading && !roleError;
  const feed = useFeedRead(roles, loadFeed, canRead);
  const upcoming = useFeedRead(roles, loadUpcoming, canRead);
  const [roleId, setRoleId] = useState('all');
  const [type, setType] = useState<FeedType | 'all'>('all');
  const [range, setRange] = useState<Range>('week');
  const [selectedSnapshot, setSelected] = useState<FeedEvent | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [source, setSource] = useState<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [refreshRequest, setRefreshRequest] = useState<RefreshRequest | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<RefreshNotice | null>(null);
  const [locatedEvent, setLocatedEvent] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [fading, setFading] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const since = useRef<number | null>(null);
  const openedAt = useRef(0);
  const savedOpen = useRef(false);
  const pendingChat = useRef<ChatTarget | null>(null);
  const returnToEvent = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLDivElement>(null);
  const [displayedFilter, setDisplayedFilter] = useState({ roleId, type, range });
  const filterRef = useRef(displayedFilter);
  filterRef.current = displayedFilter;
  useEffect(() => {
    const visible = filterRef.current;
    if (roleId === visible.roleId && type === visible.type && range === visible.range) return;
    const next = { roleId, type, range };
    const targets = () => [listRef.current?.querySelector<HTMLElement>('.feed-filter-results'), nextRef.current]
      .filter((item): item is HTMLElement => !!item);
    const previous = targets();
    if (reduced || !previous.length) { setDisplayedFilter(next); return; }
    let cancelled = false;
    const departures = previous.map(element => element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: readMotionTime(element, '--nd-semantic-motion-micro-exit', 90),
      easing: readMotionValue(element, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
    }));
    let arrivals: Animation[] = [];
    void Promise.allSettled(departures.map(item => item.finished)).then(() => {
      if (cancelled) return;
      // 新列表与淡入起点同一帧提交，旧列表不会在离场后闪回。
      flushSync(() => setDisplayedFilter(next));
      if (cancelled) return;
      arrivals = targets().map(element => {
        const offset = readMotionPx(element, '--nd-semantic-motion-detail-page-offset', 4);
        return element.animate([{ opacity: 0, transform: `translateY(${offset}px)` }, { opacity: 1, transform: 'none' }], {
          duration: readMotionTime(element, '--nd-semantic-motion-component', 220),
          easing: readMotionValue(element, '--nd-semantic-motion-ease-out', 'ease-out'), fill: 'backwards',
        });
      });
      departures.forEach(item => item.cancel());
    });
    return () => { cancelled = true; [...departures, ...arrivals].forEach(item => item.cancel()); };
  }, [roleId, type, range, reduced]);
  useEffect(() => {
    if (since.current !== null) return;
    const time = Date.now();
    openedAt.current = time;
    try {
      const previous = Number(localStorage.getItem('nowadays-feed-last-open'));
      since.current = previous > 0 && previous <= time ? previous : time - 86400000;
    } catch { since.current = time - 86400000; }
  }, []);
  useEffect(() => {
    if (!canRead || !feed.data || savedOpen.current) return;
    savedOpen.current = true;
    try { localStorage.setItem('nowadays-feed-last-open', String(openedAt.current)); } catch { /* 本机偏好不可写时仅保留本次状态。 */ }
  }, [canRead, feed.data]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { if (roleId !== 'all' && !roles.some(role => role.roleId === roleId)) setRoleId('all'); }, [roles, roleId]);
  useLayoutEffect(() => {
    if (!active) { setLocatedEvent(null); return; }
    if (!returnToEvent.current) return;
    const id = returnToEvent.current;
    returnToEvent.current = null;
    const root = listRef.current;
    const card = [...(root?.querySelectorAll<HTMLElement>('[data-feed-event]') ?? [])]
      .find(element => element.dataset.feedEvent === id);
    if (!root || !card) {
      document.getElementById('feed-title')?.focus({ preventScroll: true });
      return;
    }
    const chatTrigger = card.querySelector<HTMLButtonElement>('button[data-feed-chat]:enabled');
    const focusTarget = chatTrigger ?? card.querySelector<HTMLButtonElement>('.feed-detail');
    const scrollTarget = card.offsetHeight < root.clientHeight ? card : focusTarget ?? card;
    scrollTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    focusTarget?.focus({ preventScroll: true });
    setLocatedEvent(id);
  }, [active]);
  useEffect(() => {
    if (!canRead) {
      setRefreshRequest(null);
      setRefreshNotice(null);
      return;
    }
    if (!refreshRequest) return;
    const feedResult = feed.refreshResult;
    const upcomingResult = upcoming.refreshResult;
    if (refreshRequest.feed && feedResult?.id !== refreshRequest.feed) return;
    if (refreshRequest.upcoming && upcomingResult?.id !== refreshRequest.upcoming) return;
    const feedOk = refreshRequest.feed ? feedResult?.ok : null;
    const upcomingOk = refreshRequest.upcoming ? upcomingResult?.ok : null;
    let notice: RefreshNotice = { message: '动态与安排已刷新', tone: 'success' };
    if (feedOk === false && upcomingOk === false) notice = { message: '动态与安排暂时无法刷新', tone: 'error' };
    else if (feedOk === false) notice = upcomingOk
      ? { message: '安排已刷新，动态暂时无法刷新', tone: 'warning' }
      : { message: '动态暂时无法刷新', tone: 'error' };
    else if (upcomingOk === false) notice = feedOk
      ? { message: '动态已刷新，安排暂时无法刷新', tone: 'warning' }
      : { message: '安排暂时无法刷新', tone: 'error' };
    else if (upcomingOk === null) notice = { message: '动态已刷新', tone: 'success' };
    else if (feedOk === null) notice = { message: '安排已刷新', tone: 'success' };
    setRefreshNotice(notice);
    setRefreshRequest(null);
  }, [canRead, feed.refreshResult, upcoming.refreshResult, refreshRequest]);
  const refresh = (scope?: keyof RefreshRequest) => {
    if (!canRead || refreshRequest) return;
    setRefreshNotice(null);
    setRefreshRequest({
      feed: scope !== 'upcoming' ? feed.retry() : undefined,
      upcoming: scope !== 'feed' ? upcoming.retry() : undefined,
    });
  };
  const events = useMemo(() => feed.data ? eventList(feed.data) : [], [feed.data]);
  const selected = useMemo(() => {
    if (!selectedSnapshot || (!selectedSnapshot.exchange && !roles.some(role => role.roleId === selectedSnapshot.roleId))) return null;
    if (selectedSnapshot.wake && upcoming.data && upcoming.readStarted >= feed.readStarted) {
      const wake = upcoming.data.wakes.find(item => item.roleId === selectedSnapshot.roleId && item.wakeId === selectedSnapshot.wake?.wakeId);
      return wake ? { ...selectedSnapshot, wake, type: wake.kind === 'budget_resume' ? 'system' as const : 'wake' as const } : null;
    }
    return feed.data ? events.find(event => event.id === selectedSnapshot.id) ?? null : selectedSnapshot;
  }, [selectedSnapshot, roles, upcoming.data, upcoming.readStarted, feed.data, feed.readStarted, events]);
  useEffect(() => {
    if (sheetOpen && selectedSnapshot && !selected) {
      setSheetOpen(false);
      setAnnouncement('这条记录已不可用');
    }
  }, [sheetOpen, selectedSnapshot, selected]);
  const filtered = events.filter(event => (displayedFilter.roleId === 'all' || event.roleId === displayedFilter.roleId || event.exchange?.targetRoleId === displayedFilter.roleId) && (displayedFilter.type === 'all' || event.type === displayedFilter.type)
    && (displayedFilter.range === 'all' || (displayedFilter.range === 'today' ? dateKey(event.at) === dateKey(new Date(now)) : now - Date.parse(event.at) <= 7 * 86400000)));
  const pending = (upcoming.data?.wakes ?? []).filter(wake => wake.status === 'pending' && (displayedFilter.roleId === 'all' || wake.roleId === displayedFilter.roleId))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const groups = filtered.reduce<Array<{ day: string; at: string; events: FeedEvent[] }>>((result, event) => {
    const key = dateKey(event.at);
    const last = result[result.length - 1];
    if (last?.day === key) last.events.push(event);
    else result.push({ day: key, at: event.at, events: [event] });
    return result;
  }, []);
  const filterKey = `${displayedFilter.roleId}:${displayedFilter.type}:${displayedFilter.range}`;
  useEffect(() => { if (feed.data) setAnnouncement(`显示 ${filtered.length} 条动态`); }, [filterKey]);
  useEffect(() => {
    const root = listRef.current;
    if (!active || !root || !feed.data || sheetOpen) return;
    const timers = new Map<string, number>();
    const queue: string[] = [];
    let fading = false;
    let fadeTimer = 0;
    const process = () => {
      const id = queue.shift();
      if (!id) { fading = false; return; }
      fading = true;
      setFading(previous => new Set(previous).add(id));
      fadeTimer = window.setTimeout(() => {
        setSeen(previous => new Set(previous).add(id));
        process();
      }, reduced ? 0 : readMotionTime(root, '--nd-semantic-motion-linger', 600));
    };
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      const id = (entry.target as HTMLElement).dataset.feedNew;
      if (!id) return;
      if (entry.isIntersecting && entry.intersectionRatio >= .6 && !timers.has(id)) {
        timers.set(id, window.setTimeout(() => { timers.delete(id); queue.push(id); if (!fading) process(); }, reduced ? 0 : 1500));
      } else if (!entry.isIntersecting || entry.intersectionRatio < .6) { window.clearTimeout(timers.get(id)); timers.delete(id); }
    }), { root, threshold: [0, .6, 1] });
    root.querySelectorAll<HTMLElement>('[data-feed-new]').forEach(node => observer.observe(node));
    return () => { observer.disconnect(); timers.forEach(timer => window.clearTimeout(timer)); window.clearTimeout(fadeTimer); };
  }, [active, feed.data, filterKey, sheetOpen, reduced]);

  const open = (event: FeedEvent, trigger: HTMLElement) => {
    setSelected(event);
    setSource(trigger);
    setSheetOpen(true);
  };
  const portraits = feed.data?.portraits ?? {};
  const currentData = feed.data;
  const roleFor = (id: string) => roles.find(role => role.roleId === id);
  const stateFor = (id: string) => (upcoming.data && upcoming.readStarted >= feed.readStarted ? upcoming.data.roleActivities : currentData?.roleActivities ?? upcoming.data?.roleActivities)?.find(role => role.roleId === id);
  const taskFor = (role: string, id?: string | null) => currentData?.tasks.find(task => task.roleId === role && task.taskId === id);
  const wakeFor = (role: string, id?: string | null) => currentData?.wakes.find(wake => wake.roleId === role && wake.wakeId === id);
  const showStatus = (event: FeedEvent): Status | null => {
    if (event.activity) return activityStatus(event.activity, taskFor(event.roleId, event.activity.taskId), stateFor(event.roleId));
    if (event.batch) return batchStatus(event.batch);
    if (event.roleActivity) return { status: 'off', label: '已停止' };
    if (event.wake?.kind === 'budget_resume') return { status: 'off', label: '额度用尽' };
    if (event.wake) return wakeStatus(event.wake, stateFor(event.roleId));
    return null;
  };
  const chatTarget = (event: FeedEvent): ChatTarget | null => {
    const role = roleFor(event.roleId);
    if (!event.activity || !role?.defaultWindowId) return null;
    if (event.type === 'share') {
      const message = currentData?.messages[messageKey(event.roleId, event.activity.sharedMessageId ?? '')];
      if (!message || message.windowId !== role.defaultWindowId) return null;
      return { roleId: event.roleId, windowId: role.defaultWindowId, messageId: message.messageId, eventId: event.id };
    }
    return { roleId: event.roleId, windowId: event.activity.windowId, eventId: event.id };
  };
  const goChat = (event: FeedEvent, fromSheet = false) => {
    const target = chatTarget(event);
    if (!target) {
      setAnnouncement('无法打开对话，窗口信息不可用');
      return;
    }
    returnToEvent.current = event.id;
    if (fromSheet) {
      pendingChat.current = target;
      setSheetOpen(false);
    } else onOpenChat(target);
  };
  const nextContent = <>
    {(roleError || upcoming.error) && <div className="feed-error" role={roleError || upcoming.initialFailure ? 'alert' : undefined}>
      读取失败：{roleError || upcoming.error}
      <Button size="sm" busy={roleError ? retryingRoles : refreshRequest?.upcoming !== undefined}
        aria-disabled={!roleError && refreshRequest !== null && refreshRequest.upcoming === undefined ? true : undefined}
        onClick={roleError ? onRetryRoles : () => refresh('upcoming')}>重试</Button>
    </div>}
    {!roleError && upcoming.loading && !upcoming.data
      ? <div className="feed-skeleton" aria-busy="true">正在读取安排…</div>
      : upcoming.data && <Upcoming wakes={pending} roles={roles} states={upcoming.data.roleActivities} portraits={portraits} onOpen={open}/>}
  </>;

  const detailRows: Array<[string, ReactNode]> = [];
  if (selected) {
    const status = showStatus(selected);
    if (selected.exchange) {
      const exchange = selected.exchange;
      detailRows.push(['话题', exchange.topic], ['状态', {active: '进行中', completed: '已结束', failed: '未完成', cancelled: '已取消'}[exchange.status]]);
      if (exchange.reason) detailRows.push(['原因', errorDescriptions[exchange.reason] || exchange.reason]);
    } else if (selected.activity) {
      const activity = selected.activity;
      const task = taskFor(selected.roleId, activity.taskId);
      const wake = wakeFor(selected.roleId, activity.wakeId);
      detailRows.push(
        ['任务目标', task?.goal || '—'], ['状态', status && <StatusView value={status} visible/>],
        ['开始', dateTime(activity.startedAt)], ['结束', dateTime(activity.finishedAt)],
      );
      if (activity.finishedAt) detailRows.push(['用时', duration(activity.startedAt, activity.finishedAt)]);
      detailRows.push(['摘要', activity.summary || '没有留下摘要']);
      if (selected.type === 'share' && !chatTarget(selected)) detailRows.push(['分享原文', '不可用']);
      const code = wake?.lastErrorCode || (task?.waitReason === 'CIRCUIT_BREAKER' ? task.endReason || 'TASK_CIRCUIT_BREAKER' : null);
      if (code) detailRows.push(['错误码', <><code>{code}</code> {errorDescriptions[code] || ''}</>]);
      if (wake) detailRows.push(['来自安排', `${dateTime(wake.scheduledAt)} · ${wake.intent}`]);
    } else if (selected.wake) {
      const wake = selected.wake;
      detailRows.push(
        ['意图', wake.intent], ['预定唤醒', dateTime(wake.scheduledAt)],
        ['安排于', dateTime(wake.createdAt)], ['状态', status && <StatusView value={status} visible/>],
      );
      if (wake.lastErrorCode) detailRows.push(['错误码', <><code>{wake.lastErrorCode}</code> {errorDescriptions[wake.lastErrorCode] || ''}</>]);
    } else if (selected.batch) {
      const batch = selected.batch;
      detailRows.push(
        ['范围', `第 ${batch.inputFromSequence}–${batch.inputToSequence} 条消息`],
        ['状态', status && <StatusView value={status} visible/>], ['尝试', `${batch.attemptCount} 次`],
        ['开始', dateTime(batch.startedAt)], ['结束', dateTime(batch.finishedAt)],
      );
      if (batch.lastErrorCode) detailRows.push(['错误码', <><code>{batch.lastErrorCode}</code> {errorDescriptions[batch.lastErrorCode] || ''}</>]);
    } else if (selected.roleActivity) {
      detailRows.push(
        ['请求停止', dateTime(selected.roleActivity.requestedAt)],
        ['确认停止', dateTime(selected.roleActivity.confirmedAt)], ['已排的安排', '保留，恢复后继续'],
      );
    }
  }

  return <UiThemeScope theme="xiacheng" motion={reduced ? 'reduced' : 'full'} className="feed-scope">
    {active && <ConfigThemeTransition/>}
    <div className="feed-book">
      <div className="feed-surface" aria-hidden="true"><div/><div/><div/></div>
      <section className="feed-leaf" aria-labelledby="feed-title">
        <header className="feed-mast">
          <span>{preset === 'nightwave' ? '晚风电台' : '白昼来信'}</span><i>·</i>
          <time dateTime={new Date(now).toISOString()}>{dateLabel(new Date(now))}</time>
        </header>
        <div className="feed-body">
          <div className="feed-heading">
            <div className="feed-heading-row">
              <h1 id="feed-title" tabIndex={-1}>动态</h1>
              <div className="feed-segment" role="group" aria-label="时间范围">
                {ranges.map(([value, label]) => <ControlButton key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</ControlButton>)}
              </div>
              <IconButton className="feed-refresh" icon="refresh" label="刷新动态" disabled={!canRead} busy={refreshRequest !== null} onClick={() => refresh()}/>
            </div>
            <div className="feed-filters">
              <div className="feed-roles" role="group" aria-label="角色筛选">
                <ControlButton className="feed-role-all" aria-pressed={roleId === 'all'} onClick={() => setRoleId('all')}>全部角色</ControlButton>
                {roles.map(role => {
                  const state = (upcoming.data?.roleActivities ?? currentData?.roleActivities)?.find(item => item.roleId === role.roleId);
                  const stopped = state?.state === 'stopped';
                  return <ControlButton key={role.roleId} className="feed-role" aria-pressed={roleId === role.roleId}
                    aria-label={`${role.displayName}${stopped ? '，已停止' : ''}`} title={`${role.displayName}${stopped ? ' · 已停止' : ''}`}
                    onClick={() => setRoleId(role.roleId)}>
                    <Face role={role} image={portraits[role.roleId]}/><span>{role.displayName}</span>
                    {stopped && <StatusDot status="off" label="已停止"/>}
                  </ControlButton>;
                })}
              </div>
              <div className="feed-segment" role="group" aria-label="类型筛选">
                {types.map(([value, label]) => <ControlButton key={value} aria-pressed={type === value} onClick={() => setType(value)}>{label}</ControlButton>)}
              </div>
            </div>
          </div>
        <div className="feed-scroll" ref={listRef} tabIndex={-1}
          aria-busy={rolesLoading || (!roleError && feed.loading && !currentData) || undefined} onKeyDown={moveTimelineFocus}>
          <div className="feed-filter-results"><section className="feed-next-strip" aria-label="接下来"><h2>接下来</h2>{nextContent}</section>
          {(roleError || feed.error) && <div className="feed-error" role={roleError || feed.initialFailure ? 'alert' : undefined}>
            读取失败：{roleError || feed.error}
            <Button size="sm" busy={roleError ? retryingRoles : refreshRequest?.feed !== undefined}
              aria-disabled={!roleError && refreshRequest !== null && refreshRequest.feed === undefined ? true : undefined}
              onClick={roleError ? onRetryRoles : () => refresh('feed')}>重试</Button>
          </div>}
          {(rolesLoading || (!roleError && feed.loading && !currentData)) && <div className="feed-skeleton" role="status">
            正在读取动态…<i/><i/><i/>
          </div>}
          {!rolesLoading && currentData && !filtered.length && <div className="feed-empty">
            <p>{events.length ? '没有符合条件的动态。' : '还没有动态。'}</p>
            {events.length > 0 && <Button size="sm" onClick={() => {
              setRoleId('all'); setType('all'); setRange('all'); setAnnouncement('已清除筛选');
              requestAnimationFrame(() => document.getElementById('feed-title')?.focus({ preventScroll: true }));
            }}>清除筛选</Button>}
          </div>}
          {groups.map(group => <section key={group.day} className="feed-day">
            <h2><b>{dateLabel(group.at)}</b>{group.day === dateKey(new Date(now)) && <em>今天</em>}</h2>
            <ol className="feed-events">{group.events.map(event => {
            const role = roleFor(event.roleId);
            const status = showStatus(event);
            const activity = event.activity;
            const task = taskFor(event.roleId, activity?.taskId);
            const message = currentData?.messages[messageKey(event.roleId, activity?.sharedMessageId ?? '')];
            const isNew = since.current !== null && Date.parse(event.at) > since.current && !seen.has(event.id);
            return <li className="feed-event" key={event.id}>
              <time dateTime={event.at}>{timeLabel(event.at)}</time>
              <Face role={role} image={portraits[event.roleId]}/>
              <div className={`feed-slip${event.type === 'share' ? ' feed-letter' : ''}${event.type === 'system' ? ' feed-system' : ''}`}
                data-feed-event={event.id} data-feed-new={isNew ? event.id : undefined} onClick={click => {
                  if ((click.target as Element).closest('button')) return;
                  const button = click.currentTarget.querySelector<HTMLButtonElement>('.feed-detail');
                  if (button) open(event, button);
                }}>
                <div className="feed-slip-main">
                  <div className="feed-event-title">
                    <strong>{event.exchange ? `${event.exchange.initiatorName} 与 ${event.exchange.targetName} 进行了对话` : role?.displayName || '角色'}</strong><span>· {labels[event.type]}</span>
                    {isNew && <span className="feed-new" data-fading={fading.has(event.id) || undefined}>新</span>}
                  </div>
                  <EventContent event={event} message={message} task={task}/>
                </div>
                <div className="feed-event-end">
                  {event.type !== 'share' && status && <StatusView value={status}/>}
                  <Button className="feed-detail" size="sm" aria-label={event.exchange ? `查看「${event.exchange.topic}」的完整聊天记录` : `${role?.displayName || '角色'}的${labels[event.type]}详情`}
                    onClick={click => open(event, click.currentTarget)}>详情</Button>
                </div>
                {activity && (event.type === 'share' || status?.label === '等你回复') && <div className="feed-letter-actions">
                  <Button size="sm" icon="messages" data-feed-chat={event.id} disabled={event.type === 'share' && !chatTarget(event)} onClick={() => goChat(event)}>打开对话</Button>
                  {event.type === 'share' && <span className="feed-stamp" aria-hidden="true"><Icon name="messages" size={14}/></span>}
                </div>}
                {locatedEvent === event.id && <span className="feed-return-ink" aria-hidden="true"/>}
              </div>
            </li>;
          })}</ol>
          </section>)}</div>
        </div></div>
      </section>
      <aside className="feed-next"><h2>接下来</h2><div ref={nextRef}>{nextContent}</div></aside>
    </div>
    <Modal open={sheetOpen} title={selected ? `${labels[selected.type]} · ${selected.exchange ? selected.exchange.initiatorName + ' 与 ' + selected.exchange.targetName : roleFor(selected.roleId)?.displayName || '角色'}` : '详情'}
      description={selected ? dateTime(selected.at) : undefined} source={source} className="feed-dialog"
      backdropClassName="feed-dialog-backdrop" onClose={() => setSheetOpen(false)} onExited={() => {
        if (!pendingChat.current) {
          if (active) requestAnimationFrame(() => requestAnimationFrame(() => {
            if (document.activeElement === document.body) document.getElementById('feed-title')?.focus({ preventScroll: true });
          }));
          return;
        }
        const target = pendingChat.current;
        pendingChat.current = null;
        onOpenChat(target);
      }}>
      <dl className="feed-detail-grid">
        {detailRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {sheetOpen && selected?.exchange && <ExchangeTranscript key={selected.exchange.sessionId} exchange={selected.exchange}/>}
      {selected?.activity && (selected.type === 'share' || showStatus(selected)?.label === '等你回复') && <div className="feed-dialog-actions">
        <Button variant="primary" size="sm" disabled={selected.type === 'share' && !chatTarget(selected)} onClick={() => goChat(selected, true)}>打开对话</Button>
      </div>}
    </Modal>
    <ConfigNotice message={refreshNotice?.message ?? ''} tone={refreshNotice?.tone} onDismiss={() => setRefreshNotice(null)}/>
    <div className="ui-live" role="status" aria-atomic="true">{refreshNotice?.message}</div>
    <div className="ui-live" aria-live="polite" aria-atomic="true">{announcement}</div>
  </UiThemeScope>;
}
