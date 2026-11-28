/**
 * 快照投影与消息合并：把 SessionState 映射成页面消费的快照，
 * 并处理分页/事件抵达后的消息与句段合并。保持纯逻辑，便于测试。
 */
import type { MessagePageView, MessageView, SegmentView } from './api-types';
import type { PerfRow } from './history';
import {
  applySegmentAnnotations,
  groupSegments,
  isSubmissionConfirmed,
  lastRowOf,
  latestSceneTarget,
  messageStatusOf,
  nextMessageSequence,
  rowsForMessage,
  sceneView
} from './window-model';
import type {
  ConversationSnapshot,
  SegmentAnnotationItem,
  SessionContext,
  SessionState
} from './session-types';
import { parseDate, pendingSubmission, rememberScene, syntheticReplyRecord } from './session-types';

/** 把接入层状态投影成页面快照；行标识由调用方提供以保持稳定。 */
export function buildSnapshot(
  current: SessionState,
  idFor: (anchor: string) => number,
  roleId: string
): ConversationSnapshot {
  const rows: PerfRow[] = [];
  const segmentsByMessage = new Map<string, SegmentView[]>();
  const entries = [...current.messages.values()].sort((left, right) => left.record.sequence - right.record.sequence);
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
      const record = syntheticReplyRecord(pending, nextMessageSequence(entries.map(item => item.record)));
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
  // 历史分页可能在实时事件之后返回，按任务创建时间决定哪张属于最新版本。
  const scenes = [...current.scenes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(task => sceneView(task, segmentsByMessage, roleId)).filter(scene => scene !== null);
  const availableRounds = new Set(
    entries
      .filter(entry => entry.record.sender === 'assistant' && entry.record.status !== 'generating')
      .map(entry => entry.record.messageId)
  );
  // 自动任务的排队／规划阶段尚无可展示的图，但该轮已不能再发起生成。
  const excluded = new Set([...current.sceneRequests, ...current.sceneRequestErrors.keys()]);
  for (const task of current.scenes.values()) {
    if (task.status !== 'skipped') excluded.add(task.messageId);
  }
  if (current.pending?.replyMessageId) excluded.add(current.pending.replyMessageId);
  return {
    latestSceneTarget: current.sceneImagesAvailable ? latestSceneTarget(entries, excluded) : null,
    messages: rows,
    activeId: current.pending === null ? null : (current.pending.replyMessageId ?? '__reply__'),
    canAdvance: current.pending !== null && current.pending.shown < current.pending.segments.length,
    current: currentRow,
    error: current.pending?.error || current.error,
    scenes,
    sceneImagesAvailable: current.sceneImagesAvailable,
    sceneRequests: new Set(current.sceneRequests),
    sceneRequestErrors: new Map(current.sceneRequestErrors),
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
    historyError: current.historyError,
    waitReason: current.wait?.reason ?? null,
    submission: current.pending?.submissionKind ? {
      kind: current.pending.submissionKind,
      awaitingReceipt: current.pending.awaitingSubmission,
    } : null,
    failedReply: current.failedReply,
    pendingReceipt: current.pending?.receiptSummary,
    roleRejected: current.roleRejected,
    confirmedDraft: current.confirmedDraft
  };
}

/** 初次加载窗口快照：合并历史消息、活动回复与过场图任务。 */
export function hydratePage(ctx: SessionContext, page: MessagePageView): void {
  const current = ctx.state.current;
  current.failedReply = page.failedReply ?? null;
  // 读取快照时对照原提交：同一提交标识的消息已入库就结束重试记录，
  // 并通知页面收敛失败后恢复的草稿（283 §7 R02、§8 R02）。
  const submissionKey = JSON.stringify([ctx.roleRef.current, current.windowId]);
  const submissionRecord = ctx.submissions.current.get(submissionKey);
  if (submissionRecord !== undefined && isSubmissionConfirmed(submissionRecord, page.items)) {
    ctx.submissions.current.delete(submissionKey);
    current.confirmedDraft = {
      content: submissionRecord.content,
      sequence: ++ctx.draftConfirmationSequence.current
    };
  }
  const grouped = groupSegments(page.segments);
  const activeReply = page.activeReply;
  for (const message of page.items) {
    const segments = grouped.get(message.messageId) ?? [];
    if (activeReply !== null && activeReply.messageId === message.messageId) {
      current.pending = {
        submissionKind: null,
        executionId: activeReply.executionId,
        replyMessageId: message.messageId,
        replySequence: message.sequence,
        replyCreatedAt: message.createdAt,
        submittedMessageId: page.awaitingReply?.messageId ?? null,
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
      const shownRows = rowsForMessage(message, segments, ctx.rowIds.current!.id);
      current.current = lastRowOf(shownRows) ?? current.current;
      continue;
    }
    current.messages.set(message.messageId, { record: message, segments });
  }
  if (!current.pending && page.awaitingReply) {
    current.pending = { ...pendingSubmission(), executionId: page.awaitingReply.executionId,
      submittedMessageId: page.awaitingReply.messageId, awaitingSubmission: false, awaitingExecution: false };
  }
  current.sceneImagesAvailable = Array.isArray(page.sceneImages);
  if (current.pending && page.awaitingReply?.receiptSummary) current.pending.receiptSummary = page.awaitingReply.receiptSummary;
  for (const task of page.sceneImages ?? []) rememberScene(current, task);
  if (current.pending === null) {
    const entries = [...current.messages.values()].sort((left, right) => left.record.sequence - right.record.sequence);
    const last = entries.at(-1);
    if (last !== undefined) {
      const rows = rowsForMessage(last.record, last.segments, ctx.rowIds.current!.id);
      current.current = lastRowOf(rows) ?? current.current;
    }
  }
}

/** 向前补页时只新增本地没有的消息，已有记录由实时事件维护。 */
export function mergeMessageIntoState(current: SessionState, message: MessageView, segments: SegmentView[]): void {
  if (!current.messages.has(message.messageId)) {
    current.messages.set(message.messageId, { record: message, segments });
  }
}

/** 把终态回复从 pending 并入已保存消息，并推进当前行。 */
export function mergeTerminalReply(ctx: SessionContext): void {
  const current = ctx.state.current;
  const pending = current.pending;
  if (pending === null) return;
  current.pending = null;
  if (pending.error) current.error = pending.error;
  if (pending.replyMessageId === null) return;
  const record = syntheticReplyRecord(pending, nextMessageSequence([...current.messages.values()].map(item => item.record)));
  current.messages.set(pending.replyMessageId, {
    record: {
      ...record,
      status: pending.terminal === null ? 'completed' : messageStatusOf(pending.terminal)
    },
    segments: pending.segments
  });
  if (pending.segments.length > 0) {
    const rows = rowsForMessage({ ...record, status: messageStatusOf(pending.terminal) }, pending.segments, ctx.rowIds.current!.id);
    current.current = lastRowOf(rows) ?? current.current;
  }
}

/** 晚到标注同时作用于生成中回复、当前消息与历史副本。 */
export function applyAnnotationUpdate(current: SessionState, messageId: string, items: SegmentAnnotationItem[]): void {
  if (current.pending?.replyMessageId === messageId) {
    current.pending.segments = applySegmentAnnotations(current.pending.segments, items);
  }
  const entry = current.messages.get(messageId);
  if (entry !== undefined) entry.segments = applySegmentAnnotations(entry.segments, items);
  const historyEntry = current.historyEntries.get(messageId);
  if (historyEntry !== undefined && historyEntry !== entry) {
    historyEntry.segments = applySegmentAnnotations(historyEntry.segments, items);
  }
}
