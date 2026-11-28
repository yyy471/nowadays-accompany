/**
 * SSE 订阅与事件分发：维护 EventSource 生命周期、重连状态，
 * 并把流事件合并进 SessionState 后通过快照通知页面。
 */
import { api } from '../api';
import { errorDescriptions } from '../lib/error-descriptions';
import type { MessageDetailView, MessageView, SegmentView, StreamEventView } from './api-types';
import { backendBaseUrl, invalidateBackendBaseUrl } from './backend-base';
import { lastRowOf, mergeSegments, nextMessageSequence, reconcileFinalSegments, rowsForMessage } from './window-model';
import type {
  ConnectionState,
  PendingReply,
  SegmentAnnotationItem,
  SessionContext,
  SessionState
} from './session-types';
import { applySegmentPatch, mergeSceneTask, pendingSubmission, rememberScene, syntheticReplyRecord } from './session-types';
import { applyAnnotationUpdate, mergeTerminalReply } from './session-snapshot';

/** 读取实时事件游标后建立连接；地址解析失败时退回同源代理。 */
export function subscribeEvents(ctx: SessionContext, targetRole: string, targetWindow: string): void {
  if (typeof EventSource === 'undefined') return;
  const generation = ctx.state.current.generation;
  const path = `/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/events?after=${ctx.state.current.cursor}`;
  void backendBaseUrl().then(base => {
    if (ctx.state.current.generation !== generation) return;
    attachStream(ctx, base === null ? path : `${base}${path}`, generation);
  }).catch(() => {
    if (ctx.state.current.generation !== generation) return;
    attachStream(ctx, path, generation);
  });
}

function attachStream(ctx: SessionContext, url: string, generation: number): void {
  let stream: EventSource;
  try {
    stream = new EventSource(url);
  } catch {
    ctx.state.current.connection = 'closed';
    ctx.emit({ reason: 'connection' });
    return;
  }
  ctx.source.current = stream;
  stream.addEventListener('execution', event => {
    if (ctx.state.current.generation !== generation) return;
    let payload: StreamEventView;
    try {
      payload = JSON.parse((event as MessageEvent<string>).data) as StreamEventView;
    } catch {
      return;
    }
    handleStreamEvent(ctx, payload);
  });
  stream.onopen = () => {
    if (ctx.state.current.generation !== generation) return;
    if (ctx.state.current.connection !== 'open') {
      ctx.state.current.connection = 'open';
      ctx.emit({ reason: 'connection' });
    }
  };
  stream.onerror = () => {
    if (ctx.state.current.generation !== generation) return;
    const next: ConnectionState = stream.readyState === EventSource.CLOSED ? 'closed' : 'retrying';
    // 关闭后不会自动重连：丢弃地址缓存，用户重试时重新读取（后端重启可能换端口）。
    if (stream.readyState === EventSource.CLOSED) invalidateBackendBaseUrl();
    if (ctx.state.current.connection !== next) {
      ctx.state.current.connection = next;
      ctx.emit({ reason: 'connection', message: next === 'closed' ? '实时连接已断开。' : undefined });
    }
  };
}

function bindPending(current: SessionState, payload: Record<string, unknown>): PendingReply | null {
  const pending = current.pending;
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
  if (typeof payload.replySequence === 'number' && Number.isFinite(payload.replySequence)) {
    pending.replySequence = payload.replySequence;
  }
  if (typeof payload.replyCreatedAt === 'string' && payload.replyCreatedAt) {
    pending.replyCreatedAt = payload.replyCreatedAt;
  }
  return pending;
}

export function handleStreamEvent(ctx: SessionContext, payload: StreamEventView): void {
  const current = ctx.state.current;
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
      const messageIds = Array.isArray(payload.messageIds) ? payload.messageIds.filter(item => typeof item === 'string') as string[] : [];
      const triggerType = typeof payload.triggerType === 'string' ? payload.triggerType : '';
      if (current.failedReply && messageIds.includes(current.failedReply.messageId) && triggerType === 'user_message') {
        if (current.pending?.terminal === 'failed') mergeTerminalReply(ctx);
        current.pending ??= { ...pendingSubmission(), submittedMessageId: current.failedReply.messageId, awaitingSubmission: false };
        current.failedReply = null;
        current.error = '';
      }
      // 原消息对应的执行真正开始：清除「等待处理」提示。其他窗口或自主
      // 消息不会出现在本窗口的 messageIds 里，不会提前清除（283 §4 R02）。
      let clearedWait = false;
      if (current.wait !== null && triggerType === 'user_message' && messageIds.includes(current.wait.messageId)) {
        // 原执行已被确认：结束对应的重试记录，之后同文本再发使用新标识。
        // 尚未确认的提交仍保留原标识用于去重（283 §6 R02）。
        const cleared = current.wait;
        current.wait = null;
        clearedWait = true;
        const key = JSON.stringify([ctx.roleRef.current, current.windowId]);
        if (ctx.submissions.current.get(key)?.submissionId === cleared.submissionId) {
          ctx.submissions.current.delete(key);
        }
      }
      const pending = current.pending;
      if (pending && typeof payload.receiptSummary === 'string' && messageIds.includes(pending.submittedMessageId ?? '')) {
        pending.receiptSummary = payload.receiptSummary;
      }
      if (pending !== null && pending.executionId === null) {
        const matches = pending.submittedMessageId !== null && messageIds.includes(pending.submittedMessageId);
        if (matches && triggerType === 'user_message') {
          pending.executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
          pending.awaitingExecution = false;
        }
      }
      if (clearedWait || pending?.executionId === payload.executionId) ctx.emit({ reason: 'ready' });
      return;
    }
    case 'message_delta': {
      bindPending(current, payload as Record<string, unknown>);
      // 增量文字只用于恢复生成中内容；逐句展示使用 message_segments。
      return;
    }
    case 'message_segments': {
      const segments = Array.isArray(payload.segments) ? payload.segments as SegmentView[] : [];
      const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
      const pending = bindPending(current, payload as Record<string, unknown>);
      if (pending !== null) {
        const before = pending.segments.length;
        if (payload.partial === true) {
          pending.segments = mergeSegments(pending.segments, segments);
        } else {
          const reconciled = reconcileFinalSegments(pending.segments, segments, pending.shown);
          pending.segments = reconciled.segments;
          pending.shown = reconciled.shown;
          if (pending.shown > 0) {
            const record = syntheticReplyRecord(pending, nextMessageSequence([...current.messages.values()].map(item => item.record)));
            current.current = lastRowOf(rowsForMessage({ ...record, status: 'generating' }, pending.segments.slice(0, pending.shown), ctx.rowIds.current!.id));
          } else {
            const previousRows = [...current.messages.values()].sort((a, b) => a.record.sequence - b.record.sequence)
              .flatMap(entry => rowsForMessage(entry.record, entry.segments, ctx.rowIds.current!.id));
            current.current = lastRowOf(previousRows);
          }
        }
        const added = pending.segments.length > before;
        if (pending.shown === 0 && pending.segments.length > 0) {
          pending.shown = 1;
          const record = syntheticReplyRecord(pending, nextMessageSequence([...current.messages.values()].map(item => item.record)));
          const row = lastRowOf(rowsForMessage({ ...record, status: 'generating' }, pending.segments.slice(0, 1), ctx.rowIds.current!.id));
          if (row) current.current = row;
          if (pending.terminal !== null && pending.shown >= pending.segments.length) mergeTerminalReply(ctx);
          ctx.emit({ reason: 'segment', row: row ?? undefined });
          return;
        }
        if (pending.terminal !== null && pending.shown >= pending.segments.length) {
          mergeTerminalReply(ctx);
          ctx.emit({ reason: 'terminal' });
        } else if (added || payload.partial !== true) ctx.emit({ reason: 'ready' });
        return;
      }
      if (replyMessageId !== null) {
        const existing = current.extraSegments.get(replyMessageId) ?? [];
        current.extraSegments.set(replyMessageId, applySegmentPatch(existing, segments, payload.partial === true).segments);
      }
      return;
    }
    case 'segment_annotations': {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (messageId === null) return;
      const items = Array.isArray(payload.items) ? payload.items as SegmentAnnotationItem[] : [];
      applyAnnotationUpdate(current, messageId, items);
      ctx.emit({ reason: 'annotation' });
      return;
    }
    case 'message_completed': {
      const pending = bindPending(current, payload as Record<string, unknown>);
      if (pending !== null) {
        pending.terminal = 'completed';
        if (payload.receiptReply === true) pending.shown = pending.segments.length;
        settlePending(ctx);
        return;
      }
      const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
      if (replyMessageId !== null) void ingestExtraMessage(ctx, replyMessageId, 'completed');
      return;
    }
    case 'message_interrupted': {
      const pending = bindPending(current, payload as Record<string, unknown>);
      if (pending !== null) {
        pending.terminal = 'interrupted';
        if (pending.segments.length === 0) pending.error = '这轮回复没有说完。';
        settlePending(ctx);
        return;
      }
      const replyMessageId = typeof payload.replyMessageId === 'string' ? payload.replyMessageId : null;
      if (replyMessageId !== null) void ingestExtraMessage(ctx, replyMessageId, 'interrupted');
      return;
    }
    case 'execution_superseded':
    case 'execution_paused':
    case 'execution_failed': {
      const pending = current.pending;
      const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
      if (payload.type === 'execution_failed' && typeof payload.failedMessageId === 'string' && typeof payload.deliveredReceipt === 'string') {
        const origin = current.messages.get(payload.failedMessageId);
        if (origin) origin.record = { ...origin.record, status: 'receipt_delivered', deliveredReceipt: payload.deliveredReceipt };
        else void ingestExtraMessage(ctx, payload.failedMessageId, 'receipt_delivered');
        current.failedReply = null;
        ctx.emit({ reason: 'ready' });
      } else if (payload.type === 'execution_failed' && executionId && typeof payload.failedMessageId === 'string') {
        current.failedReply = { executionId, messageId: payload.failedMessageId,
          errorCode: typeof payload.errorCode === 'string' ? payload.errorCode : 'EXECUTION_FAILED',
          ...(typeof payload.receiptSummary === 'string' ? { receiptSummary: payload.receiptSummary } : {}) };
        if (pending?.executionId !== executionId) ctx.emit({ reason: 'ready' });
      }
      if (pending === null) return;
      if (pending.executionId === null || executionId !== pending.executionId) return;
      if (payload.type === 'execution_superseded') {
        pending.terminal = 'superseded';
        if (pending.segments.length === 0) pending.error = '这轮回复被新的消息打断了。';
      } else if (payload.type === 'execution_paused') {
        pending.terminal = 'paused';
        if (pending.segments.length === 0) pending.error = '这轮回复暂时停了下来。';
      } else {
        pending.terminal = 'failed';
        if (payload.deliveredReceipt) pending.shown = pending.segments.length;
        if (pending.segments.length === 0 && !current.failedReply && !payload.deliveredReceipt) {
          const reason = errorDescriptions.get(typeof payload.errorCode === 'string' ? payload.errorCode : 'EXECUTION_FAILED');
          pending.error = reason ? `这轮回复暂时没有送达（${reason}）。` : '这轮回复暂时没有送达。';
        }
      }
      settlePending(ctx);
      return;
    }
    case 'scene_image_task': {
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
      if (taskId === null || messageId === null) return;
      const previous = current.scenes.get(taskId);
      const task = mergeSceneTask(previous, payload, current.windowId ?? '');
      rememberScene(current, task);
      ctx.emit({ reason: 'scene' });
      return;
    }
    default:
      return;
  }
}

function settlePending(ctx: SessionContext): void {
  const pending = ctx.state.current.pending;
  if (pending === null) return;
  if (pending.terminal !== null && pending.shown >= pending.segments.length) {
    mergeTerminalReply(ctx);
    ctx.emit({ reason: 'terminal' });
    return;
  }
  ctx.emit({ reason: 'ready' });
}

async function ingestExtraMessage(ctx: SessionContext, messageId: string, status: string): Promise<void> {
  const generation = ctx.state.current.generation;
  try {
    const detail = await api<MessageDetailView>(`/v1/roles/${encodeURIComponent(ctx.roleRef.current)}/windows/${encodeURIComponent(ctx.state.current.windowId ?? '')}/messages/${encodeURIComponent(messageId)}`);
    if (ctx.state.current.generation !== generation) return;
    if (ctx.state.current.messages.has(messageId)) return;
    ctx.state.current.messages.set(messageId, { record: { ...detail.message, status }, segments: detail.segments });
    for (const task of detail.sceneImages ?? []) rememberScene(ctx.state.current, task);
    const rows = rowsForMessage({ ...detail.message, status }, detail.segments, ctx.rowIds.current!.id);
    ctx.state.current.current = lastRowOf(rows) ?? ctx.state.current.current;
    ctx.emit({ reason: 'ready' });
  } catch {
    const segments = ctx.state.current.extraSegments.get(messageId);
    if (!segments || segments.length === 0) return;
    const record: MessageView = {
      messageId,
      windowId: ctx.state.current.windowId ?? '',
      sender: 'assistant',
      content: segments.filter(segment => segment.kind === 'speech').map(segment => segment.text).join('\n\n'),
      sourcePlatform: 'nowadays',
      status,
      sequence: nextMessageSequence([...ctx.state.current.messages.values()].map(item => item.record)),
      submissionId: null,
      createdAt: segments[0].createdAt,
      updatedAt: segments[0].createdAt
    };
    ctx.state.current.messages.set(messageId, { record, segments });
    ctx.state.current.current = lastRowOf(rowsForMessage(record, segments, ctx.rowIds.current!.id)) ?? ctx.state.current.current;
    ctx.emit({ reason: 'ready' });
  }
}
