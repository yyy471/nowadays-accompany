import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { errorText } from '../lib/error-text';
import type {
  FailedReplyView,
  MessagePageView,
  MessageView,
  SceneTaskView,
  SubmitMessageView,
  ConversationWaitReason,
  WindowView
} from './api-types';
import { createRowIdRegistry, groupSegments, lastRowOf, nextMessageSequence, rowsForMessage } from './window-model';
import { createTypingState } from './typing-state';
import type { SceneLayerMode } from './performance';
import type { ConversationSnapshot, SessionContext, SessionEvent, SubmissionRecord } from './session-types';
import { createEmptyState, LIMIT, makeUuid, pendingSubmission, rememberScene, syntheticReplyRecord } from './session-types';
import { buildSnapshot, hydratePage, mergeMessageIntoState, mergeTerminalReply } from './session-snapshot';
import { handleStreamEvent, subscribeEvents } from './session-events';

export type { ConnectionState, SessionEventReason, SessionEvent, ConversationSnapshot } from './session-types';

/**
 * 窗口数据接入层：读取快照、订阅 SSE、提交消息、按句推进与过场图任务。
 * 页面只消费快照；切换角色/窗口、重连与迟到事件都在本层处理。
 * 快照投影、事件分发与合并逻辑已拆分到会话目录的兄弟模块。
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
  const state = useRef(createEmptyState());
  const generationCounter = useRef(0);
  const draftConfirmationSequence = useRef(0);
  const rowIds = useRef<ReturnType<typeof createRowIdRegistry> | null>(null);
  const source = useRef<EventSource | null>(null);
  const typing = useRef<ReturnType<typeof createTypingState> | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const submissions = useRef(new Map<string, SubmissionRecord>());
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

  const build = useCallback(
    (): ConversationSnapshot => buildSnapshot(state.current, rowIds.current?.id ?? ((_anchor: string) => 0), roleId),
    [roleId]
  );

  const emit = useCallback((event: SessionEvent) => {
    const next = build();
    setSnapshot(next);
    onEventRef.current(next, event);
  }, [build]);

  // 拆出的模块共享同一组可变引用；emit 每次渲染保持最新（与原有闭包语义一致）。
  const contextRef = useRef<SessionContext | null>(null);
  const ctx: SessionContext = contextRef.current ?? (contextRef.current = {
    state,
    roleRef,
    rowIds,
    source,
    submissions,
    draftConfirmationSequence,
    emit
  });
  ctx.emit = emit;

  // 角色切换：读取窗口列表并选定默认窗口。
  useEffect(() => {
    const targetRole = roleId;
    if (!targetRole) {
      state.current = createEmptyState();
      state.current.generation = ++generationCounter.current;
      setWindows([]);
      setWindowId(null);
      setSnapshot(null);
      return;
    }
    let active = true;
    state.current.windows = [];
    state.current.pending = null;
    state.current.failedReply = null;
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
      const wanted = result.items.find(item => item.windowId === preferred.current)?.windowId
        || result.items.find(item => item.kind === 'main')?.windowId || result.items[0]?.windowId || null;
      setWindowId(wanted);
    }).catch(error => {
      if (!active) return;
      state.current.loading = false;
      state.current.loadError = errorText(error);
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
    const fresh = createEmptyState();
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
      hydratePage(ctx, page);
      state.current.nextBefore = page.nextBefore;
      state.current.historyBefore = page.nextBefore;
      state.current.loading = false;
      state.current.cursor = page.cursor;
      emit({ reason: 'load' });
      subscribeEvents(ctx, targetRole, targetWindow);
    }).catch(error => {
      if (!active || state.current.generation !== generation) return;
      state.current.loading = false;
      state.current.loadError = errorText(error);
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

  const send = useCallback((text: string, failed?: FailedReplyView): boolean => {
    const targetRole = roleRef.current;
    const targetWindow = state.current.windowId;
    const content = text.trim();
    if (!targetRole || !targetWindow || (!content && !failed) || state.current.pending !== null) return false;
    state.current.error = '';
    state.current.wait = null;
    const pending = pendingSubmission(failed ? 'retry' : 'send');
    state.current.pending = pending;
    emit({ reason: failed ? 'retryReply' : 'send' });
    const submissionKey = JSON.stringify([targetRole, targetWindow]);
    const previous = failed ? undefined : submissions.current.get(submissionKey);
    const submissionId = previous?.content === content ? previous.submissionId : makeUuid();
    const startCursor = previous?.content === content ? previous.startCursor : state.current.cursor;
    if (!failed) submissions.current.set(submissionKey, { content, submissionId, startCursor });
    const generation = state.current.generation;
    const messagesUrl = `/v1/roles/${encodeURIComponent(targetRole)}/windows/${encodeURIComponent(targetWindow)}/messages`;
    void api<SubmitMessageView>(failed ? `${messagesUrl}/${encodeURIComponent(failed.messageId)}/retry` : messagesUrl, {
      method: 'POST',
      body: failed ? { executionId: failed.executionId } : { content, submissionId, source: 'nowadays' }
    }).then(result => {
      if (state.current.windowId !== targetWindow || state.current.generation !== generation || roleRef.current !== targetRole) return;
      const waitReason = result.waitReason ?? null;
      const releaseWaiting = result.decisionScheduled === false && (
        waitReason === 'ROLE_STOPPED' || waitReason === 'MODEL_MISSING' || waitReason === 'WINDOW_BLOCKED'
      );
      const message = result.message;
      if (!state.current.messages.has(message.messageId)) {
        state.current.messages.set(message.messageId, { record: message, segments: [] });
      }
      if (state.current.pending === pending) {
        state.current.failedReply = null;
        pending.submittedMessageId = message.messageId;
        pending.awaitingSubmission = false;
        // 响应晚于 SSE 时，缓冲里可能已经有原消息对应的执行与回复。
        // 这时以流事件为准，不能落入旧的等待提示而丢掉已到达的内容（283 §5 R02）。
        const bufferedHasExecution = pending.bufferedEvents.some(event =>
          event.type === 'execution_started' &&
          Array.isArray(event.messageIds) &&
          event.messageIds.includes(message.messageId)
        );
        const waitRejected = releaseWaiting && !bufferedHasExecution;
        state.current.roleRejected = false;
        if (!failed && !waitRejected && submissions.current.get(submissionKey)?.submissionId === submissionId) submissions.current.delete(submissionKey);
        if (waitRejected) {
          // 消息已收下但没有安排回复：显示原因、释放输入区，保留原提交标识供重试。
          state.current.wait = {
            reason: waitReason as ConversationWaitReason,
            submissionId: message.submissionId ?? submissionId,
            content: message.content,
            messageId: message.messageId,
            ...(failed ? { failedReply: failed } : {})
          };
          state.current.pending = null;
          pending.bufferedEvents = [];
        } else if (!failed && !bufferedHasExecution && result.duplicate) {
          // 上次请求可能已提交但响应丢失，重放原提交之前的游标以恢复执行归属。
          source.current?.close();
          source.current = null;
          state.current.cursor = startCursor;
          state.current.lastEventId = startCursor;
          state.current.connection = 'connecting';
          subscribeEvents(ctx, targetRole, targetWindow);
          pending.bufferedEvents = [];
        } else {
          for (const event of pending.bufferedEvents) handleStreamEvent(ctx, event);
          pending.bufferedEvents = [];
        }
      }
      typing.current?.stop();
      emit({ reason: 'ready' });
    }).catch(error => {
      if (state.current.generation !== generation || roleRef.current !== targetRole || state.current.windowId !== targetWindow) return;
      if (state.current.pending === pending) {
        state.current.pending = null;
        for (const event of pending.bufferedEvents) handleStreamEvent(ctx, event);
      }
      if (failed) {
        // 另一处已经领取或应答，以及已提交但回执丢失时，以窗口快照和其游标重新接续。
        if (error instanceof ApiError && error.code === 'REPLY_RETRY_STALE') {
          setReloadToken(value => value + 1);
        } else {
          state.current.failedReply ??= failed;
          state.current.error = errorText(error);
          emit({ reason: 'error', message: state.current.error });
        }
        return;
      }
      // 角色已停止会拒绝新消息：消息未入库，保留草稿并给出就地恢复入口（283 R07）。
      if (error instanceof ApiError && error.code === 'ROLE_ACTIVITY_STOPPED') {
        state.current.roleRejected = true;
        emit({ reason: 'error', draft: content });
        return;
      }
      state.current.error = errorText(error);
      emit({ reason: 'error', message: state.current.error, draft: content });
    });
    return true;
  }, [emit]);

  /** 等待原因解除后（恢复活动、补好模型）用原提交标识重试，避免重复入库。 */
  const retryWaiting = useCallback((): boolean => {
    const wait = state.current.wait;
    if (wait === null) return false;
    state.current.wait = null;
    return send(wait.content, wait.failedReply);
  }, [send]);

  const retryFailedReply = useCallback((): boolean => {
    const failed = state.current.failedReply;
    return failed !== null && send('', failed);
  }, [send]);

  /** 恢复活动成功后清掉「发送被拒绝」提示；消息仍由用户自己重新提交。 */
  const clearRejection = useCallback((): void => {
    if (!state.current.roleRejected) return;
    state.current.roleRejected = false;
    emit({ reason: 'ready' });
  }, [emit]);

  const advance = useCallback((): boolean => {
    const pending = state.current.pending;
    if (pending === null || pending.shown >= pending.segments.length) return false;
    pending.shown += 1;
    const record = syntheticReplyRecord(pending, nextMessageSequence([...state.current.messages.values()].map(item => item.record)));
    const effective: MessageView = { ...record, status: 'generating' };
    const row = lastRowOf(rowsForMessage(effective, pending.segments.slice(0, pending.shown), rowIds.current!.id));
    if (row) state.current.current = row;
    if (pending.terminal !== null && pending.shown >= pending.segments.length) mergeTerminalReply(ctx);
    emit({ reason: 'segment', row: row ?? undefined });
    return true;
  }, [emit]);

  const advanceAll = useCallback((): boolean => {
    const pending = state.current.pending;
    if (pending === null || pending.shown >= pending.segments.length) return false;
    pending.shown = pending.segments.length;
    const record = syntheticReplyRecord(pending, nextMessageSequence([...state.current.messages.values()].map(item => item.record)));
    const effective: MessageView = { ...record, status: 'generating' };
    const row = lastRowOf(rowsForMessage(effective, pending.segments, rowIds.current!.id));
    if (row) state.current.current = row;
    if (pending.terminal !== null) mergeTerminalReply(ctx);
    emit({ reason: 'segment', row: row ?? undefined });
    return true;
  }, [emit]);

  const requestScene = useCallback((messageId: string, mode: SceneLayerMode): void => {
    const targetRole = roleRef.current;
    const targetWindow = state.current.windowId;
    if (!targetRole || !targetWindow || !state.current.sceneImagesAvailable) return;
    const requests = state.current.sceneRequests;
    if (requests.has(messageId) || [...state.current.scenes.values()].some(task => task.messageId === messageId
      && ['queued', 'planning', 'generating'].includes(task.status))) return;
    requests.add(messageId);
    state.current.sceneRequestErrors.delete(messageId);
    emit({ reason: 'ready' });
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
      const message = errorText(error);
      const code = error instanceof ApiError ? error.code : undefined;
      state.current.sceneRequestErrors.set(messageId, { reason: message, mode, ...(code ? { code } : {}) });
      emit({ reason: 'error', message });
    }).finally(() => {
      requests.delete(messageId);
      if (state.current.generation === generation) emit({ reason: 'ready' });
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
        mergeMessageIntoState(state.current, message, grouped.get(message.messageId) ?? []);
      }
      for (const task of page.sceneImages ?? []) rememberScene(state.current, task);
      state.current.nextBefore = page.nextBefore;
      return true;
    } catch (error) {
      if (state.current.generation === generation && roleRef.current === targetRole) {
        emit({ reason: 'error', message: errorText(error) });
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
      if (!controller.signal.aborted && state.current.generation === generation) current.historyError = errorText(error);
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

  const locateMessage = useCallback(async (messageId: string): Promise<number | null> => {
    const generation = state.current.generation;
    const targetRole = roleRef.current;
    while (!state.current.messages.has(messageId)) {
      if (state.current.generation !== generation || roleRef.current !== targetRole) return null;
      if (!await loadOlder()) return null;
    }
    if (state.current.generation !== generation || roleRef.current !== targetRole) return null;
    return build().messages.find(row => row.messageId === messageId)?.id ?? null;
  }, [build, loadOlder]);

  const retry = useCallback(() => {
    if (windows.length === 0) setWindowsToken(value => value + 1);
    else setReloadToken(value => value + 1);
  }, [windows.length]);

  const noteTyping = useCallback(() => typing.current?.input(), []);
  return { snapshot, windows, windowId, selectWindow, retry, send, retryWaiting, retryFailedReply, clearRejection, advance, advanceAll, requestScene, noteTyping, loadOlder, loadHistory, cancelHistory, ensureVisible, locateMessage };
}
