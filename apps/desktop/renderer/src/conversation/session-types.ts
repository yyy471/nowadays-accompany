/**
 * 对话接入层的共享类型、常量与纯值工具。
 * 从 use-window-session 拆出，导出形状与行为保持不变。
 */
import type {
  ConversationWaitReason,
  FailedReplyView,
  MessageView,
  SceneTaskView,
  SegmentView,
  StreamEventView,
  WindowView
} from './api-types';
import type { PerfRow } from './history';
import type { PerformanceSnapshot } from './performance';
import type { RowIdRegistry, SceneRequestError } from './window-model';
import { mergeSegments, newerSceneTask, reconcileFinalSegments } from './window-model';

export type ConnectionState = 'connecting' | 'open' | 'retrying' | 'closed';
export type SessionEventReason = 'load' | 'send' | 'retryReply' | 'segment' | 'ready' | 'annotation' | 'terminal' | 'scene' | 'error' | 'connection' | 'history';

export interface SessionEvent {
  reason: SessionEventReason;
  /** 本次事件新增或推进到的演出行。 */
  row?: PerfRow;
  /** 需要提示的错误摘要（提交、过场图或连接）。 */
  message?: string;
  draft?: string;
}

export interface ConversationSnapshot extends PerformanceSnapshot {
  pendingReceipt?: string;
  roleId: string;
  sceneImagesAvailable: boolean;
  latestSceneTarget: string | null;
  sceneRequests: ReadonlySet<string>;
  sceneRequestErrors: ReadonlyMap<string, SceneRequestError>;
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
  /** 已收下但未安排回复的原因；null 表示正常排队或正在生成。 */
  waitReason: string | null;
  /** 本窗口主动提交的发信或重试，确认前不显示已送达。 */
  submission: { kind: SubmissionKind; awaitingReceipt: boolean } | null;
  failedReply: FailedReplyView | null;
  /** 最近一次发送因角色停止被拒绝：消息未入库，恢复后由用户再提交。 */
  roleRejected: boolean;
  /** 快照确认某条原提交已入库：页面据此收敛失败后恢复的草稿（283 §8 R02）。 */
  confirmedDraft: { content: string; sequence: number } | null;
}

export type SubmissionKind = 'send' | 'retry';

export interface PendingReply {
  receiptSummary?: string;
  submissionKind: SubmissionKind | null;
  executionId: string | null;
  replyMessageId: string | null;
  replySequence: number | null;
  replyCreatedAt: string | null;
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

export interface SessionState {
  windows: WindowView[];
  windowId: string | null;
  loading: boolean;
  loadError: string;
  connection: ConnectionState;
  messages: Map<string, { record: MessageView; segments: SegmentView[] }>;
  extraSegments: Map<string, SegmentView[]>;
  pending: PendingReply | null;
  scenes: Map<string, SceneTaskView>;
  sceneRequests: Set<string>;
  sceneRequestErrors: Map<string, SceneRequestError>;
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
  /** 已收下但未安排回复：显示可读原因并释放输入区等待。 */
  wait: {
    reason: ConversationWaitReason;
    submissionId: string;
    content: string;
    /** 原消息标识：对应执行真正开始后清除等待（283 §4 R02）。 */
    messageId: string;
    failedReply?: FailedReplyView;
  } | null;
  failedReply: FailedReplyView | null;
  /** 发送被角色停止拒绝：消息未入库，保留草稿与原提交标识。 */
  roleRejected: boolean;
  /** 快照确认的原提交；同一窗口重新载入时据此清除重复草稿。 */
  confirmedDraft: { content: string; sequence: number } | null;
}

/** 同一窗口的原提交记录，用于去重与快照确认。 */
export interface SubmissionRecord {
  content: string;
  submissionId: string;
  startCursor: number;
}

/** 拆出的模块共享同一份可变引用，调用时读取最新值。 */
export interface SessionContext {
  state: { current: SessionState };
  roleRef: { current: string };
  rowIds: { current: RowIdRegistry | null };
  source: { current: EventSource | null };
  submissions: { current: Map<string, SubmissionRecord> };
  draftConfirmationSequence: { current: number };
  emit: (event: SessionEvent) => void;
}

export type SegmentAnnotationItem = {
  segmentId: string;
  outfitId?: string | null;
  homeAssetId?: string | null;
  spriteAssetId?: string | null;
  voiceEmotion?: string | null;
};

export const LIMIT = 200;

export function createEmptyState(): SessionState {
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
    sceneRequests: new Set(),
    sceneRequestErrors: new Map(),
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
    historyError: '',
    wait: null,
    failedReply: null,
    roleRejected: false,
    confirmedDraft: null
  };
}

export function pendingSubmission(submissionKind: SubmissionKind | null = null): PendingReply {
  return {
    submissionKind,
    executionId: null, replyMessageId: null, replySequence: null, replyCreatedAt: null,
    submittedMessageId: null, messageRecord: null, segments: [], shown: 0, terminal: null,
    error: '', awaitingExecution: true, startedAt: Date.now(), awaitingSubmission: true, bufferedEvents: []
  };
}

export function rememberScene(current: SessionState, task: SceneTaskView): void {
  current.scenes.set(task.taskId, newerSceneTask(current.scenes.get(task.taskId), task));
}

export function syntheticReplyRecord(pending: PendingReply, fallbackSequence: number): MessageView {
  if (pending.messageRecord) return pending.messageRecord;
  const createdAt = pending.replyCreatedAt ?? new Date(pending.startedAt).toISOString();
  return {
    messageId: pending.replyMessageId ?? '',
    windowId: '',
    sender: 'assistant',
    content: '',
    sourcePlatform: 'nowadays',
    status: 'generating',
    sequence: pending.replySequence ?? fallbackSequence,
    submissionId: null,
    createdAt,
    updatedAt: createdAt
  };
}

/** 增量句段按 ID 合并；终态列表按原阅读进度收敛。 */
export function applySegmentPatch(
  existing: SegmentView[],
  incoming: SegmentView[],
  partial: boolean,
  shown = 0
): { segments: SegmentView[]; shown: number } {
  if (partial) return { segments: mergeSegments(existing, incoming), shown };
  return reconcileFinalSegments(existing, incoming, shown);
}

export function mergeSceneTask(previous: SceneTaskView | undefined, payload: StreamEventView, windowId: string): SceneTaskView {
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

export function parseDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function makeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
