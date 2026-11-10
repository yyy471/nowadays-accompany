import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  MessageDetailView,
  MessagePageView,
  MessageView,
  SceneTaskView,
  SegmentView,
  StreamEventView,
  SubmitMessageView,
  WindowView
} from './api-types';
import type { PerfRow } from './history.js';
import type { PerformanceSnapshot, SceneLayerMode } from './performance.js';
import { backendBaseUrl } from './backend-base';
import { applySegmentAnnotations, createRowIdRegistry, groupSegments, lastRowOf, mergeSegments, messageStatusOf, newerSceneTask, reconcileFinalSegments, rowsForMessage, sceneView } from './window-model.js';
import { createTypingState } from './typing-state.js';

export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'closed';
export type SessionEventReason = 'load' | 'send' | 'segment' | 'ready' | 'annotation' | 'terminal' | 'scene' | 'error' | 'connection' | 'history';

export interface SessionEvent {
  reason: SessionEventReason;
  /** 本次事件新增或推进到的演出行。 */
  row?: PerfRow;
  /** 需要提示的错误摘要（提交、过场图或连接）。 */
  message?: string;
  draft?: string;
}

export interface ConversationSnapshot extends PerformanceSnapshot {
  roleId: string;
  sceneImagesAvailable: boolean;
  connection: ConnectionState;
  loading: boolean;
  loadError: string;
  windowId: string | null;
  windows: WindowView[];
  hasOlder: boolean;
  loadingOlder: boolean;
  historyMessages: PerfRow[];
  historyLoading: boolean;
  historyComplete: boolean;
  historyError: string;
}

interface PendingReply {
  executionId: string | null;
  replyMessageId: string | null;
  submittedMessageId: string | null;
  messageRecord: MessageView | null;
  segments: SegmentView[];
  shown: number;
  terminal: string | null;
  error: string;
  awaitingExecution: boolean;
  startedAt: number;
  awaitingSubmission: boolean;
  bufferedEvents: StreamEventView[];
}

interface SessionState {
  windows: WindowView[];
  windowId: string | null;
  loading: boolean;
  loadError: string;
  connection: ConnectionState;
  messages: Map<string, { record: MessageView; segments: SegmentView[] }>;
  extraSegments: Map<string, SegmentView[]>;
  pending: PendingReply | null;
  scenes: Map<string, SceneTaskView>;
  sceneImagesAvailable: boolean;
  current: PerfRow | null;
  error: string;
  cursor: number;
  lastEventId: number;
  generation: number;
  nextBefore: number | null;
  loadingOlder: boolean;
  historyEntries: Map<string, { record: MessageView; segments: SegmentView[] }>;
  historyBefore: number | null;
  historyLoading: boolean;
  historyError: string;
}

const LIMIT = 200;

function emptyState(): SessionState {
  return {
    windows: [],
    windowId: null,
    loading: false,
    loadError: '',
    connection: 'connecting',
    messages: new Map(),
    extraSegments: new Map(),
    pending: null,
    scenes: new Map(),
    sceneImagesAvailable: false,
    current: null,
    error: '',
    cursor: 0,
    lastEventId: 0,
    generation: 0,
    nextBefore: null,
    loadingOlder: false,
    historyEntries: new Map(),
    historyBefore: null,
    historyLoading: false,
    historyError: ''
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function rememberScene(current: SessionState, task: SceneTaskView): void {
  current.scenes.set(task.taskId, newerSceneTask(current.scenes.get(task.taskId), task));
}

function syntheticReplyRecord(pending: PendingReply): MessageView {
  return pending.messageRecord ?? {
    messageId: pending.replyMessageId ?? '',
    windowId: '',
    sender: 'assistant',
    content: '',
    sourcePlatform: 'nowadays',
    status: 'generating',
    sequence: Number.MAX_SAFE_INTEGER,
    submissionId: null,
    createdAt: new Date(pending.startedAt).toISOString(),
    updatedAt: new Date(pending.startedAt).toISOString()
  };
}

/**
 * 窗口数据接入层：读取快照、订阅 SSE、提交消息、按句推进与过场图任务。
 * 页面只消费快照；切换角色/窗口、重连与迟到事件都在本层处理。
 */
export function useWindowSession({
  roleId,
  preferredWindowId,
  onEvent
}: {
  roleId: string;
  preferredWindowId?: string | null;
  onEvent: (snapshot: ConversationSnapshot, event: SessionEvent) => void;
}) {
  const state = useRef<SessionState>(emptyState());
  const generationCounter = useRef(0);
  const rowIds = useRef<ReturnType<typeof createRowIdRegistry> | null>(null);
  const source = useRef<EventSource | null>(null);
  const typing = useRef<ReturnType<typeof createTypingState> | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const submissions = useRef(new Map<string, { content: string; submissionId: string; startCursor: number }>());
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [windows, setWindows] = useState<WindowView[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [windowsToken, setWindowsToken] = useState(0);
  const preferred = useRef(preferredWindowId);
  preferred.current = preferredWindowId;
  const roleRef = useRef(roleId);
  roleRef.current = roleId;

  useEffect(() => {
    if (!roleId || !windowId) return;
    const clientId = makeUuid();
    const path = `/v1/roles/${encodeURIComponent(roleId)}/windows/${encodeURIComponent(windowId)}/input-state`;
    const input = createTypingState({
      update: value => api(path, { method: 'POST', body: { clientId, typing: value } }),
      clear: () => api(`${path}?clientId=${encodeURIComponent(clientId)}`, { method: 'DELETE' })
    });
    typing.current = input;
    return () => {
      if (typing.current === input) typing.current = null;
      void input.close();
    };
  }, [roleId, windowId]);

  const build = useCallback((): ConversationSnapshot => {
    const current = state.current;
    const rows: PerfRow[] = [];
    const segmentsByMessage = new Map<string, SegmentView[]>();
    const entries = [...current.messages.values()].sort((left, right) => left.record.sequence - right.record.sequence);
    const idFor = rowIds.current?.id ?? ((anchor: string) => 0);
    for (const entry of entries) {
      segmentsByMessage.set(entry.record.messageId, entry.segments);
      if (current.pending?.replyMessageId === entry.record.messageId) continue;
      rows.push(...rowsForMessage(entry.record, entry.segments, idFor));
    }
    const historyEntries = new Map(current.historyEntries);
    for (const entry of entries) {
      if (entry.record.status !== 'generating') historyEntries.set(entry.record.messageId, entry);
    }
    const historyMessages = [...historyEntries.values()]
      .sort((left, right) => left.record.sequence - right.record.sequence)
      .flatMap(entry => {
        segmentsByMessage.set(entry.record.messageId, entry.segments);
        return rowsForMessage(entry.record, entry.segments, idFor);
      });
    let upcoming: PerfRow[] = [];
    if (current.pending !== null) {
      const pending = current.pending;
      if (pending.replyMessageId !== null) {
        segmentsByMessage.set(pending.replyMessageId, pending.segments);
        const record = syntheticReplyRecord(pending);
        const effective: MessageView = {
          ...record,
          // 生成中的末段不提前显示「未说完」；终态在收尾写入保存消息时生效。
          status: 'generating'
        };
        const shownSegments = pending.segments.slice(0, pending.shown);
        if (shownSegments.length > 0) {
          rows.push(...rowsForMessage(effective, shownSegments, idFor));
        }
        const all = rowsForMessage(effective, pending.segments, idFor);
        upcoming = all.slice(pending.shown);
      }
    }
    const currentRow = current.current ?? lastRowOf(rows);
    const scenes = [...current.scenes.values()].map(task => sceneView(task, segmentsByMessage, roleId));
    const availableRounds = new Set(
      entries
        .filter(entry => entry.record.sender === 'assistant' && entry.record.status !== 'generating')
        .map(entry => entry.record.messageId)
    );
    return {
      messages: rows,
      activeId: current.pending === null ? null : (current.pending.replyMessageId ?? '__reply__'),
      canAdvance: current.pending !== null && current.pending.shown < current.pending.segments.length,
      current: currentRow,
      error: current.pending?.error || current.error,
      scenes,
      sceneImagesAvailable: current.sceneImagesAvailable,
      availableRounds,
      upcoming,
      awaiting: current.pending !== null && current.pending.segments.length === 0,
      roleId,
      connection: current.connection,
      loading: current.loading,
      loadError: current.loadError,
      windowId: current.windowId,
      windows: current.windows,
      hasOlder: current.nextBefore !== null,
      loadingOlder: current.loadingOlder,
      historyMessages,
      historyLoading: current.historyLoading,
      historyComplete: current.historyBefore === null,
      historyError: current.historyError
    };
  }, [roleId]);

  const emit = useCallback((event: SessionEvent) => {
    const next = build();
    setSnapshot(next);
    onEventRef.current(next, event);
  }, [build]);

  // 角色切换：读取窗口列表并选定默认窗口。
  useEffect(() => {
    const targetRole = roleId;
    if (!targetRole) {
      state.current = emptyState();
      state.current.generation = ++generationCounter.current;
      setWindows([]);
      setWindowId(null);
      setSnapshot(null);
      return;
    }
    let active = true;
    state.current.windows = [];
    state.current.pending = null;
    state.current.messages = new Map();
    state.current.scenes = new Map();
    state.current.error = '';
    state.current.loading = true;
    setWindows([]);
    setWindowId(null);
    void api<{ items: WindowView[] }>(`/v1/roles/${encodeURIComponent(targetRole)}/windows`).then(result => {
      if (!active) return;
      state.current.windows = result.items;
      setWindows(result.items);
      if (result.items.length === 0) {
        state.current.loading = false;
        state.current.loadError = '这个角色还没有对话窗口。';
        emit({ reason: 'error', message: state.current.loadError });
        return;
      }
      const wanted = preferred.current || result.items.find(item => item.kind === 'main')?.windowId || result.items[0]?.windowId || null;
      setWindowId(wanted);
    }).catch(error => {
      if (!active) return;
      state.current.loading = false;
      state.current.loadError = describeError(error);
      emit({ reason: 'error', message: state.current.loadError });
    });
    return () => { active = false; };
  }, [roleId, emit, windowsToken]);

  // 窗口数据加载：快照 + SSE 游标。
  useEffect(() => {
    const targetRole = roleId;
    const targetWindow = windowId;
    if (!targetRole || !targetWindow) return;
    if (!windows.some(item => item.windowId === targetWindow)) return;
    const generation = ++generationCounter.current;
    source.current?.close();
    source.current = null;
    const fresh = emptyState();
    fresh.generation = generation;
    fresh.windows = windows;
    fresh.windowId = targetWindow;
    fresh.loading = true;
    fresh.connection = 'connecting';
    state.current = fresh;
    rowIds.current = createRowIdRegistry();
    emit({ reason: 'load' });
    let active = true;
    void api<MessagePageView>(`/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/messages?limit=${LIMIT}`).then(page => {
      if (!active || state.current.generation !== generation) return;
      ingestPage(page);
      state.current.nextBefore = page.nextBefore;
      state.current.historyBefore = page.nextBefore;
      state.current.loading = false;
      state.current.cursor = page.cursor;
      emit({ reason: 'load' });
      openStream(targetRole, targetWindow);
    }).catch(error => {
      if (!active || state.current.generation !== generation) return;
      state.current.loading = false;
      state.current.loadError = describeError(error);
      emit({ reason: 'error', message: state.current.loadError });
    });
    return () => {
      active = false;
      historyRequest.current?.abort();
      historyRequest.current = null;
      state.current.generation = ++generationCounter.current;
      source.current?.close();
      source.current = null;
    };
    // windows 数组只在角色切换或重试时更换；避免因引用变化重复加载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, windowId, windows, reloadToken]);

  function ingestPage(page: MessagePageView): void {
    const current = state.current;
    const grouped = groupSegments(page.segments);
    const activeReply = page.activeReply;
    for (const message of page.items) {
      const segments = grouped.get(message.messageId) ?? [];
      if (activeReply !== null && activeReply.messageId === message.messageId) {
        current.pending = {
          executionId: activeReply.executionId,
          replyMessageId: message.messageId,
          submittedMessageId: null,
          messageRecord: message,
          segments,
          shown: segments.length,
          terminal: null,
          error: '',
          awaitingExecution: false,
          startedAt: parseDate(message.createdAt),
          awaitingSubmission: false,
          bufferedEvents: []
        };
        const shownRows = rowsForMessage(message, segments, rowIds.current!.id);
        current.current = lastRowOf(shownRows) ?? current.current;
        continue;
      }
      current.messages.set(message.messageId, { record: message, segments });
    }
    current.sceneImagesAvailable = Array.isArray(page.sceneImages);
    for (const task of page.sceneImages ?? []) rememberScene(current, task);
    if (current.pending === null) {
      const entries = [...current.messages.values()].sort((left, right) => left.record.sequence - right.record.sequence);
      const last = entries.at(-1);
      if (last !== undefined) {
        const rows = rowsForMessage(last.record, last.segments, rowIds.current!.id);
        current.current = lastRowOf(rows) ?? current.current;
      }
    }
  }

  function openStream(targetRole: string, targetWindow: string): void {
    if (typeof EventSource === 'undefined') return;
    const generation = state.current.generation;
    const path = `/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/events?after=${state.current.cursor}`;
    void backendBaseUrl().then(base => {
      if (state.current.generation !== generation) return;
      attachStream(base === null ? path : `${base}${path}`, generation);
    }).catch(() => {
      if (state.current.generation !== generation) return;
      attachStream(path, generation);
    });
  }

  function attachStream(url: string, generation: number): void {
    let stream: EventSource;
    try {
      stream = new EventSource(url);
    } catch {
      state.current.connection = 'closed';
      emit({ reason: 'connection' });
      return;
    }
    source.current = stream;
    stream.addEventListener('execution', event => {
      if (state.current.generation !== generation) return;
      let payload: StreamEventView;
      try {
        payload = JSON.parse((event as MessageEvent<string>).data) as StreamEventView;
      } catch {
        return;
      }
      handleStreamEvent(payload);
    });
    stream.onopen = () => {
      if (state.current.generation !== generation) return;
      if (state.current.connection !== 'open') {
        state.current.connection = 'open';
        emit({ reason: 'connection' });
      }
    };
    stream.onerror = () => {
      if (state.current.generation !== generation) return;
      const next: ConnectionState = stream.readyState === EventSource.CLOSED ? 'closed' : 'retrying';
      if (state.current.connection !== next) {
        state.current.connection = next;
        emit({ reason: 'connection', message: next === 'closed' ? '实时连接已断开。' : undefined });
      }
    };
  }

  function bindPending(payload: Record<string, unknown>): PendingReply | null {
    const pending = state.current.pending;
    if (pending === null) return null;
    const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
    const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
    if (pending.replyMessageId !== null && replyMessageId !== null && replyMessageId !== pending.replyMessageId) {
      return null;
    }
    // 尚未收到 execution_started 时不认领事件，避免把同窗口的主动分享挂到本次发送上。
    if (pending.executionId === null) return null;
    if (executionId !== null && executionId !== pending.executionId) return null;
    if (replyMessageId !== null) pending.replyMessageId = replyMessageId;
    return pending;
  }

  function handleStreamEvent(payload: StreamEventView): void {
    const current = state.current;
    if (current.pending?.awaitingSubmission) {
      current.pending.bufferedEvents.push(payload);
      return;
    }
    if (typeof payload.streamEventId === 'number') {
      if (payload.streamEventId <= current.lastEventId) return;
      current.lastEventId = payload.streamEventId;
      current.cursor = Math.max(current.cursor, payload.streamEventId);
    }
    switch (payload.type) {
      case 'execution_started': {
        const pending = current.pending;
        if (pending === null || pending.executionId !== null) return;
        const messageIds = Array.isArray(payload.messageIds) ? payload.messageIds.filter(item => typeof item === 'string') as string[] : [];
        const triggerType = typeof payload.triggerType === 'string' ? payload.triggerType : '';
        const matches = pending.submittedMessageId !== null && messageIds.includes(pending.submittedMessageId);
        if (matches && triggerType === 'user_message') {
          pending.executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
          pending.awaitingExecution = false;
        }
        return;
      }
      case 'message_delta': {
        bindPending(payload as Record<string, unknown>);
        // 增量文字只用于恢复生成中内容；逐句展示使用 message_segments。
        return;
      }
      case 'message_segments': {
        const segments = Array.isArray(payload.segments) ? payload.segments as SegmentView[] : [];
        const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
        const pending = bindPending(payload as Record<string, unknown>);
        if (pending !== null) {
          const before = pending.segments.length;
          if (payload.partial === true) {
            pending.segments = mergeSegments(pending.segments, segments);
          } else {
            const reconciled = reconcileFinalSegments(pending.segments, segments, pending.shown);
            pending.segments = reconciled.segments;
            pending.shown = reconciled.shown;
            if (pending.shown > 0) {
              const record = syntheticReplyRecord(pending);
              current.current = lastRowOf(rowsForMessage({ ...record, status: 'generating' }, pending.segments.slice(0, pending.shown), rowIds.current!.id));
            } else {
              const previousRows = [...current.messages.values()].sort((a, b) => a.record.sequence - b.record.sequence)
                .flatMap(entry => rowsForMessage(entry.record, entry.segments, rowIds.current!.id));
              current.current = lastRowOf(previousRows);
            }
          }
          const added = pending.segments.length > before;
          if (pending.shown === 0 && pending.segments.length > 0) {
            pending.shown = 1;
            const record = syntheticReplyRecord(pending);
            const row = lastRowOf(rowsForMessage({ ...record, status: 'generating' }, pending.segments.slice(0, 1), rowIds.current!.id));
            if (row) current.current = row;
            if (pending.terminal !== null && pending.shown >= pending.segments.length) finalizePending();
            emit({ reason: 'segment', row: row ?? undefined });
            return;
          }
          if (pending.terminal !== null && pending.shown >= pending.segments.length) {
            finalizePending();
            emit({ reason: 'terminal' });
          } else if (added || payload.partial !== true) emit({ reason: 'ready' });
          return;
        }
        if (replyMessageId !== null) {
          const existing = current.extraSegments.get(replyMessageId) ?? [];
          current.extraSegments.set(replyMessageId, payload.partial === true ? mergeSegments(existing, segments) : reconcileFinalSegments(existing, segments, 0).segments);
        }
        return;
      }
      case 'segment_annotations': {
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
        if (messageId === null) return;
        const items = Array.isArray(payload.items) ? payload.items as Array<{ segmentId: string; outfitId?: string | null; spriteAssetId?: string | null }> : [];
        if (current.pending?.replyMessageId === messageId) {
          current.pending.segments = applySegmentAnnotations(current.pending.segments, items);
        }
        const entry = current.messages.get(messageId);
        if (entry !== undefined) entry.segments = applySegmentAnnotations(entry.segments, items);
        const historyEntry = current.historyEntries.get(messageId);
        if (historyEntry !== undefined && historyEntry !== entry) {
          historyEntry.segments = applySegmentAnnotations(historyEntry.segments, items);
        }
        emit({ reason: 'annotation' });
        return;
      }
      case 'message_completed': {
        const pending = bindPending(payload as Record<string, unknown>);
        if (pending !== null) {
          pending.terminal = 'completed';
          settlePending();
          return;
        }
        const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
        if (replyMessageId !== null) void ingestExtraMessage(replyMessageId, 'completed');
        return;
      }
      case 'message_interrupted': {
        const pending = bindPending(payload as Record<string, unknown>);
        if (pending !== null) {
          pending.terminal = 'interrupted';
          if (pending.segments.length === 0) pending.error = '这轮回复没有说完。';
          settlePending();
          return;
        }
        const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
        if (replyMessageId !== null) void ingestExtraMessage(replyMessageId, 'interrupted');
        return;
      }
      case 'execution_superseded':
      case 'execution_paused':
      case 'execution_failed': {
        const pending = current.pending;
        if (pending === null) return;
        const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
        if (pending.executionId === null || executionId !== pending.executionId) return;
        if (payload.type === 'execution_superseded') {
          pending.terminal = 'superseded';
          if (pending.segments.length === 0) pending.error = '这轮回复被新的消息打断了。';
        } else if (payload.type === 'execution_paused') {
          pending.terminal = 'paused';
          if (pending.segments.length === 0) pending.error = '这轮回复暂时停了下来。';
        } else {
          pending.terminal = 'failed';
          const code = typeof payload.errorCode === 'string' ? payload.errorCode : 'EXECUTION_FAILED';
          if (pending.segments.length === 0) pending.error = `这轮回复暂时没有送达（${code}）。`;
        }
        settlePending();
        return;
      }
      case 'scene_image_task': {
        const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
        if (taskId === null || messageId === null) return;
        const previous = current.scenes.get(taskId);
        const task = mergeSceneTask(previous, payload, current.windowId ?? '');
        rememberScene(current, task);
        emit({ reason: 'scene' });
        return;
      }
      default:
        return;
    }
  }

  function settlePending(): void {
    const pending = state.current.pending;
    if (pending === null) return;
    if (pending.terminal !== null && pending.shown >= pending.segments.length) {
      finalizePending();
      emit({ reason: 'terminal' });
      return;
    }
    emit({ reason: 'ready' });
  }

  function finalizePending(): void {
    const current = state.current;
    const pending = current.pending;
    if (pending === null) return;
    current.pending = null;
    if (pending.error) current.error = pending.error;
    if (pending.replyMessageId === null) return;
    const record = syntheticReplyRecord(pending);
    current.messages.set(pending.replyMessageId, {
      record: {
        ...record,
        status: pending.terminal === null ? 'completed' : messageStatusOf(pending.terminal)
      },
      segments: pending.segments
    });
    if (pending.segments.length > 0) {
      const rows = rowsForMessage({ ...record, status: messageStatusOf(pending.terminal) }, pending.segments, rowIds.current!.id);
      current.current = lastRowOf(rows) ?? current.current;
    }
  }

  async function ingestExtraMessage(messageId: string, status: string): Promise<void> {
    const generation = state.current.generation;
    try {
      const detail = await api<MessageDetailView>(`/v1/roles/${encodeURIComponent(roleRef.current)}/windows/${encodeURIComponent(state.current.windowId ?? '')}/messages/${encodeURIComponent(messageId)}`);
      if (state.current.generation !== generation) return;
      if (state.current.messages.has(messageId)) return;
      state.current.messages.set(messageId, { record: { ...detail.message, status }, segments: detail.segments });
      for (const task of detail.sceneImages ?? []) rememberScene(state.current, task);
      const rows = rowsForMessage({ ...detail.message, status }, detail.segments, rowIds.current!.id);
      state.current.current = lastRowOf(rows) ?? state.current.current;
      emit({ reason: 'ready' });
    } catch {
      const segments = state.current.extraSegments.get(messageId);
      if (!segments || segments.length === 0) return;
      const record: MessageView = {
        messageId,
        windowId: state.current.windowId ?? '',
        sender: 'assistant',
        content: segments.filter(segment => segment.kind === 'speech').map(segment => segment.text).join('\n\n'),
        sourcePlatform: 'nowadays',
        status,
        sequence: Number.MAX_SAFE_INTEGER,
        submissionId: null,
        createdAt: segments[0].createdAt,
        updatedAt: segments[0].createdAt
      };
      state.current.messages.set(messageId, { record, segments });
      state.current.current = lastRowOf(rowsForMessage(record, segments, rowIds.current!.id)) ?? state.current.current;
      emit({ reason: 'ready' });
    }
  }

  const send = useCallback((text: string): boolean => {
    const targetRole = roleRef.current;
    const targetWindow = state.current.windowId;
    const content = text.trim();
    if (!targetRole || !targetWindow || !content || state.current.pending !== null) return false;
    state.current.error = '';
    const pending: PendingReply = {
      executionId: null,
      replyMessageId: null,
      submittedMessageId: null,
      messageRecord: null,
      segments: [],
      shown: 0,
      terminal: null,
      error: '',
      awaitingExecution: true,
      startedAt: Date.now(),
      awaitingSubmission: true,
      bufferedEvents: []
    };
    state.current.pending = pending;
    emit({ reason: 'send' });
    const submissionKey = JSON.stringify([targetRole, targetWindow]);
    const previous = submissions.current.get(submissionKey);
    const submissionId = previous?.content === content ? previous.submissionId : makeUuid();
    const startCursor = previous?.content === content ? previous.startCursor : state.current.cursor;
    submissions.current.set(submissionKey, { content, submissionId, startCursor });
    const generation = state.current.generation;
    void api<SubmitMessageView>(`/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/messages`, {
      method: 'POST',
      body: { content, submissionId, source: 'nowadays' }
    }).then(result => {
      if (state.current.windowId !== targetWindow || state.current.generation !== generation || roleRef.current !== targetRole) return;
      if (submissions.current.get(submissionKey)?.submissionId === submissionId) submissions.current.delete(submissionKey);
      const message = result.message;
      if (!state.current.messages.has(message.messageId)) {
        state.current.messages.set(message.messageId, { record: message, segments: [] });
      }
      if (state.current.pending === pending) {
        pending.submittedMessageId = message.messageId;
        pending.awaitingSubmission = false;
        if (result.duplicate) {
          // 上次请求可能已提交但响应丢失，重放原提交之前的游标以恢复执行归属。
          source.current?.close();
          source.current = null;
          state.current.cursor = startCursor;
          state.current.lastEventId = startCursor;
          state.current.connection = 'connecting';
          openStream(targetRole, targetWindow);
        } else {
          for (const event of pending.bufferedEvents) handleStreamEvent(event);
        }
        pending.bufferedEvents = [];
      }
      typing.current?.stop();
      emit({ reason: 'ready' });
    }).catch(error => {
      if (state.current.generation !== generation || roleRef.current !== targetRole || state.current.windowId !== targetWindow) return;
      if (state.current.pending === pending) {
        state.current.pending = null;
        for (const event of pending.bufferedEvents) handleStreamEvent(event);
      }
      state.current.error = describeError(error);
      emit({ reason: 'error', message: state.current.error, draft: content });
    });
    return true;
  }, [emit]);

  const advance = useCallback((): boolean => {
    const pending = state.current.pending;
    if (pending === null || pending.shown >= pending.segments.length) return false;
    pending.shown += 1;
    const record = syntheticReplyRecord(pending);
    const effective: MessageView = { ...record, status: 'generating' };
    const row = lastRowOf(rowsForMessage(effective, pending.segments.slice(0, pending.shown), rowIds.current!.id));
    if (row) state.current.current = row;
    if (pending.terminal !== null && pending.shown >= pending.segments.length) finalizePending();
    emit({ reason: 'segment', row: row ?? undefined });
    return true;
  }, [emit]);

  const requestScene = useCallback((messageId: string, mode: SceneLayerMode): void => {
    const targetRole = roleRef.current;
    const targetWindow = state.current.windowId;
    if (!targetRole || !targetWindow || !state.current.sceneImagesAvailable) return;
    const generation = state.current.generation;
    void api<{ task: SceneTaskView; duplicate: boolean }>(`/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/messages/${encodeURIComponent(messageId)}/scene-images`, {
      method: 'POST',
      body: { idempotencyKey: makeUuid(), layerMode: mode }
    }).then(result => {
      if (state.current.generation !== generation || roleRef.current !== targetRole || state.current.windowId !== targetWindow) return;
      rememberScene(state.current, result.task);
      emit({ reason: 'scene' });
    }).catch(error => {
      if (state.current.generation !== generation || roleRef.current !== targetRole || state.current.windowId !== targetWindow) return;
      emit({ reason: 'error', message: describeError(error) });
    });
  }, [emit]);

  const selectWindow = useCallback((nextWindowId: string) => {
    if (nextWindowId === state.current.windowId) return;
    setWindowId(nextWindowId);
  }, []);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const current = state.current;
    const before = current.nextBefore;
    const targetRole = roleRef.current;
    const targetWindow = current.windowId;
    const generation = current.generation;
    if (before === null || current.loadingOlder || !targetRole || !targetWindow) return false;
    current.loadingOlder = true;
    emit({ reason: 'ready' });
    try {
      const page = await api<MessagePageView>(`/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/messages?before=${before}&limit=${LIMIT}`);
      if (state.current.generation !== generation || roleRef.current !== targetRole) return false;
      const grouped = groupSegments(page.segments);
      for (const message of page.items) {
        if (!state.current.messages.has(message.messageId)) {
          state.current.messages.set(message.messageId, { record: message, segments: grouped.get(message.messageId) ?? [] });
        }
      }
      for (const task of page.sceneImages ?? []) rememberScene(state.current, task);
      state.current.nextBefore = page.nextBefore;
      return true;
    } catch (error) {
      if (state.current.generation === generation && roleRef.current === targetRole) {
        emit({ reason: 'error', message: describeError(error) });
      }
      return false;
    } finally {
      if (state.current.generation === generation && roleRef.current === targetRole) {
        state.current.loadingOlder = false;
        emit({ reason: 'ready' });
      }
    }
  }, [emit]);

  const loadHistory = useCallback(async () => {
    const current = state.current;
    const targetRole = roleRef.current;
    const targetWindow = current.windowId;
    const generation = current.generation;
    if (!targetRole || !targetWindow || current.historyLoading || current.historyBefore === null) return;
    const controller = new AbortController();
    historyRequest.current = controller;
    current.historyLoading = true;
    current.historyError = '';
    emit({ reason: 'history' });
    try {
      while (current.historyBefore !== null) {
        const before: number = current.historyBefore;
        const page: MessagePageView = await api<MessagePageView>(`/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/messages?before=${before}&limit=${LIMIT}`, { signal: controller.signal });
        if (controller.signal.aborted || state.current.generation !== generation || roleRef.current !== targetRole) return;
        if (page.nextBefore !== null && page.nextBefore >= before) throw new Error('历史分页游标没有向前推进');
        const grouped = groupSegments(page.segments);
        for (const message of page.items) {
          current.historyEntries.set(message.messageId, { record: message, segments: grouped.get(message.messageId) ?? [] });
        }
        for (const task of page.sceneImages ?? []) rememberScene(current, task);
        current.historyBefore = page.nextBefore;
        emit({ reason: 'history' });
      }
    } catch (error) {
      if (!controller.signal.aborted && state.current.generation === generation) current.historyError = describeError(error);
    } finally {
      if (historyRequest.current === controller) {
        historyRequest.current = null;
        if (state.current.generation === generation) {
          current.historyLoading = false;
          emit({ reason: 'history' });
        }
      }
    }
  }, [emit]);

  const cancelHistory = useCallback(() => {
    const controller = historyRequest.current;
    if (!controller) return;
    historyRequest.current = null;
    controller.abort();
    state.current.historyLoading = false;
    emit({ reason: 'history' });
  }, [emit]);

  const ensureVisible = useCallback(async (rowId: number): Promise<boolean> => {
    const generation = state.current.generation;
    const targetRole = roleRef.current;
    const target = build().historyMessages.find(row => row.id === rowId);
    if (!target) return false;
    while (!state.current.messages.has(target.messageId)) {
      if (state.current.generation !== generation || roleRef.current !== targetRole) return false;
      if (!await loadOlder()) return false;
    }
    return true;
  }, [build, loadOlder]);

  const retry = useCallback(() => {
    if (windows.length === 0) setWindowsToken(value => value + 1);
    else setReloadToken(value => value + 1);
  }, [windows.length]);

  const noteTyping = useCallback(() => typing.current?.input(), []);
  return { snapshot, windows, windowId, selectWindow, retry, send, advance, requestScene, noteTyping, loadOlder, loadHistory, cancelHistory, ensureVisible };
}

function mergeSceneTask(previous: SceneTaskView | undefined, payload: StreamEventView, windowId: string): SceneTaskView {
  const status = typeof payload.status === 'string' ? payload.status as SceneTaskView['status'] : previous?.status ?? 'queued';
  return {
    taskId: String(payload.taskId),
    roleId: previous?.roleId ?? '',
    windowId: previous?.windowId ?? windowId,
    messageId: String(payload.messageId),
    executionId: previous?.executionId ?? '',
    trigger: payload.trigger === 'auto' ? 'auto' : 'manual',
    layerMode: payload.layerMode === 'full_scene' ? 'full_scene' : 'background',
    startSegmentId: String(payload.startSegmentId ?? previous?.startSegmentId ?? ''),
    endSegmentId: String(payload.endSegmentId ?? previous?.endSegmentId ?? ''),
    status,
    attempt: typeof payload.attempt === 'number' ? payload.attempt : previous?.attempt ?? 1,
    plan: (payload.plan as SceneTaskView['plan'] | null | undefined) ?? previous?.plan ?? null,
    errorCode: typeof payload.errorCode === 'string' ? payload.errorCode : payload.errorCode === null ? null : previous?.errorCode ?? null,
    errorSummary: typeof payload.errorSummary === 'string' ? payload.errorSummary : payload.errorSummary === null ? null : previous?.errorSummary ?? null,
    result: (payload.result as SceneTaskView['result'] | null | undefined) ?? previous?.result ?? null,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function parseDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
