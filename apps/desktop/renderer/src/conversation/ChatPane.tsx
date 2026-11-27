import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Button, Icon, useMotionPolicy } from '../ui';
import { errorDescriptions } from '../lib/error-descriptions';
import { VoiceWave } from '../ui/voice-wave';
import { dayKey, dateLabel } from './history';
import type { PerfRow } from './history';
import type { PerfScene } from './performance';
import { ReplyContent } from './ReplyContent';
import { sceneFeedback, sceneForEachReply } from './window-model';
import { syncMessageFeather } from './message-scroll';
import type { SceneLayerMode } from './performance';
import type { ConversationSnapshot } from './use-window-session';
import { shouldAdvanceFromClick, shouldAdvanceFromKey } from './advance';
import '../styles/conversation-feedback.css';
import { PhotoDevelopment } from '../ui/photo-development';

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function dateCaption(key: string): string {
  return `${key === dayKey(Date.now()) ? '今天 · ' : ''}${dateLabel(key)}`;
}

export type DialogueLocation = { rowId: number; sequence: number; fromHistory: boolean };

export function ChatPane({
  snapshot,
  pendingVoiceId,
  playingId,
  follow,
  hasNew,
  liveRowId,
  location,
  dateNotice,
  requestDraftFocus,
  initialDraft,
  onDraftChange,
  recoveredDraft,
  onRecoveredDraftApplied,
  clearDraft,
  onClearDraftApplied,
  onDraftFocusHandled,
  onScrollFollow,
  onLatest,
  onSend,
  onTyping,
  onLoadOlder,
  onAdvance,
  onAdvanceAll,
  onSpeaker,
  onGenerateScene,
  onRetryScene,
  onOpenScene,
  notice,
  waitReason,
  roleStopped,
  resuming,
  voiceUnavailable,
  onResumeRole,
  onConfigureModel,
  onRetryWaiting,
  onRetryFailedReply,
}: {
  snapshot: ConversationSnapshot;
  pendingVoiceId: number | null;
  playingId: number | null;
  follow: boolean;
  hasNew: boolean;
  liveRowId: number | null;
  location: DialogueLocation | null;
  dateNotice: string | null;
  requestDraftFocus: number;
  initialDraft: string;
  onDraftChange: (value: string) => void;
  recoveredDraft: { value: string; sequence: number } | null;
  onRecoveredDraftApplied: () => void;
  /** 快照确认原提交已入库且草稿未被编辑：清空输入区（283 §9 R02）。 */
  clearDraft: number | null;
  /** 清空信号已消费：父页面据此丢弃它，切回窗口时不重放（283 §10 R02）。 */
  onClearDraftApplied: () => void;
  onDraftFocusHandled: () => void;
  onScrollFollow: (follow: boolean) => void;
  onLatest: () => void;
  onSend: (text: string) => boolean;
  onTyping: () => void;
  onLoadOlder: () => void;
  onAdvance: () => void;
  onAdvanceAll?: () => void;
  onSpeaker: (row: PerfRow) => void;
  onGenerateScene: (messageId: string) => void;
  onRetryScene: (messageId: string, mode: SceneLayerMode) => void;
  onOpenScene: (scene: PerfScene) => void;
  /** 衣柜与当前穿着的提示，例如未选择服饰或服饰没有差分。 */
  notice?: string | null;
  /** 已收下但未安排回复的原因；显示等待原因与恢复入口。 */
  waitReason: string | null;
  /** 页面已知角色处于停止状态；发送被拒绝时也会进入同一恢复入口。 */
  roleStopped: boolean;
  resuming: boolean;
  voiceUnavailable: boolean;
  onResumeRole: () => void;
  onConfigureModel: () => void;
  onRetryWaiting: () => void;
  onRetryFailedReply: () => void;
}) {
  const policy = useMotionPolicy();
  const scroller = useRef<HTMLDivElement>(null);
  const draft = useRef<HTMLTextAreaElement>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const composing = useRef(false);
  const focusAdvance = useRef(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const placedLocation = useRef<DialogueLocation | null>(null);
  const locationScroll = useRef<number | null>(null);
  const [draftValue, setDraftValue] = useState(initialDraft);
  const recoveredSequence = useRef(0);
  const confirmedSequence = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;
  const advancing = snapshot.activeId !== null;

  useEffect(() => {
    if (!recoveredDraft || recoveredDraft.sequence <= recoveredSequence.current) return;
    recoveredSequence.current = recoveredDraft.sequence;
    setDraftValue(recoveredDraft.value);
    onRecoveredDraftApplied();
  }, [recoveredDraft, onRecoveredDraftApplied]);

  useEffect(() => {
    if (!clearDraft || clearDraft <= confirmedSequence.current) return;
    confirmedSequence.current = clearDraft;
    setDraftValue('');
    window.requestAnimationFrame(() => {
      if (draft.current) resizeDraft(draft.current);
    });
    onClearDraftApplied();
  }, [clearDraft, onClearDraftApplied]);

  const scenesByReply = sceneForEachReply(snapshot.scenes);
  const lastOfRound = new Map<string, number>();
  for (const row of snapshot.messages) lastOfRound.set(row.messageId, row.id);

  useLayoutEffect(() => {
    if (olderAnchor.current && !snapshot.loadingOlder && scroller.current) {
      scroller.current.scrollTop = olderAnchor.current.top + scroller.current.scrollHeight - olderAnchor.current.height;
      olderAnchor.current = null;
      return;
    }
    if (followRef.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [snapshot.messages, snapshot.loadingOlder, follow]);

  useLayoutEffect(() => {
    if (!focusAdvance.current) return;
    focusAdvance.current = false;
    // 发送后把焦点交给消息区：按 Enter 继续下一句，不再依赖底部按钮。
    scroller.current?.focus({ preventScroll: true });
  });

  useLayoutEffect(() => {
    if (!location || placedLocation.current === location) return;
    const element = rows.current.get(location.rowId);
    const host = scroller.current;
    if (!element || !host) return;
    placedLocation.current = location;
    const previousTop = host.scrollTop;
    const top = element.getBoundingClientRect().top - host.getBoundingClientRect().top + previousTop - 18;
    // 定位落位的滚动事件不应把阅读位置切回实时跟随。
    olderAnchor.current = null;
    host.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    locationScroll.current = host.scrollTop === previousTop ? null : host.scrollTop;
    element.focus({ preventScroll: true });
  }, [location, snapshot.messages]);

  useEffect(() => {
    if (requestDraftFocus <= 0) return;
    draft.current?.focus({ preventScroll: true });
    onDraftFocusHandled();
  }, [requestDraftFocus, onDraftFocusHandled]);

  useLayoutEffect(() => {
    if (scroller.current) syncMessageFeather(scroller.current);
  }, [snapshot.messages, snapshot.loadingOlder, follow, location]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    syncMessageFeather(element);
    const placedTop = locationScroll.current;
    locationScroll.current = null;
    if (placedTop !== null && element.scrollTop === placedTop) return;
    const next = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    onScrollFollow(next);
  };

  const resizeDraft = (element: HTMLTextAreaElement) => {
    element.style.height = '';
    const { minHeight, maxHeight } = getComputedStyle(element);
    const height = Math.max(Number.parseFloat(minHeight), element.scrollHeight);
    element.style.height = `${Math.min(Number.parseFloat(maxHeight), height)}px`;
  };

  const send = () => {
    const value = draftValue.trim();
    if (!value || composing.current || advancing) return;
    if (!onSend(value)) return;
    setDraftValue('');
    onDraftChange('');
    if (draft.current) resizeDraft(draft.current);
    focusAdvance.current = true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
      event.preventDefault();
      if (!event.repeat) send();
    }
  };

  const submission = snapshot.submission;
  const firstReplyText = submission?.kind === 'retry'
    ? submission.awaitingReceipt ? '正在请求重新回复…' : '正在重新生成回复…'
    : submission?.kind === 'send'
      ? submission.awaitingReceipt ? '正在发送消息…' : '消息已接收，正在组织回复…'
      : '正在组织回复…';
  // 请求回执与首句等待分开，已展示的回复继续使用逐句反馈。
  const waitingText = !advancing
    ? null
    : snapshot.awaiting || !snapshot.current
      ? snapshot.pendingReceipt ? `${snapshot.pendingReceipt} 正在整理回复…` : firstReplyText
      : !snapshot.canAdvance
        ? '下一句还在准备…'
        : null;

  /** 点击消息区推进下一段；不吞掉按钮、链接、输入与选中文字的操作。 */
  const advanceFromClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!snapshot.canAdvance) return;
    const selection = window.getSelection();
    const hasSelection = selection !== null && !selection.isCollapsed;
    if (!shouldAdvanceFromClick(event.target, hasSelection)) return;
    onAdvance();
  };

  /** 焦点在消息区时，Enter 或空格推进下一段。 */
  const advanceFromKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!snapshot.canAdvance) return;
    if (!shouldAdvanceFromKey(event.key, event.target, event.currentTarget)) return;
    event.preventDefault();
    onAdvance();
  };

  let lastDay = '';
  // 已停止、等待恢复或发送被拒绝都提供同一处恢复入口（283 §4 R07）。
  const stoppedNotice = roleStopped || waitReason === 'ROLE_STOPPED' || snapshot.roleRejected;
  const replyError = snapshot.failedReply && errorDescriptions.get(snapshot.failedReply.errorCode);
  return <div className="dialogue-chat">
    <div className="dialogue-messages-wrap">
    <div className="dialogue-messages" ref={scroller} onScroll={onScroll}
      onClick={advanceFromClick} onKeyDown={advanceFromKey}
      role="log" aria-live="off" tabIndex={0}
      data-can-advance={snapshot.canAdvance ? 'true' : undefined}
      aria-keyshortcuts={snapshot.canAdvance ? 'Enter Space' : undefined}
      aria-label={snapshot.canAdvance ? '对话记录，可上下滚动；点击或按 Enter 继续下一句' : '对话记录，可上下滚动'}>
      {snapshot.hasOlder && <button type="button" className="dialogue-scene-chip" disabled={snapshot.loadingOlder} onClick={() => {
        if (scroller.current) olderAnchor.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop };
        onScrollFollow(false);
        onLoadOlder();
      }}>{snapshot.loadingOlder ? '正在读取…' : '读取更早的消息'}</button>}
      {!snapshot.messages.length && !snapshot.loadingOlder && !waitingText &&
        <p className="dialogue-messages-empty">{stoppedNotice ? '恢复活动后，就能在这里聊聊天。' : '还没有对话，写一句开头慢慢说。'}</p>}
      {snapshot.messages.map((row) => {
        const key = dayKey(row.createdAt);
        const divider = key !== lastDay;
        lastDay = key;
        const isLive = liveRowId === row.id;
        const atEnd = row.role === 'assistant' && lastOfRound.get(row.messageId) === row.id && snapshot.activeId !== row.messageId && snapshot.availableRounds.has(row.messageId);
        const scene = atEnd ? scenesByReply.get(row.messageId) : undefined;
        const feedback = sceneFeedback(snapshot.scenes, snapshot.sceneRequests, snapshot.sceneRequestErrors, row.messageId);
        const pending = atEnd && feedback.pending;
        const failure = atEnd ? feedback.error : null;
        const canDraw = atEnd && snapshot.sceneImagesAvailable && !!row.segmentId;
        let sceneControl: ReactNode = null;
        if (scene?.status === 'succeeded' || pending || failure || canDraw) sceneControl = <>
          {scene?.status === 'succeeded' && <button type="button" className="dialogue-scene-chip" onClick={() => onOpenScene(scene)}>查看{scene.mode === 'background' ? '背景图' : '人物场景图'}</button>}
          {pending ? <PhotoDevelopment state="pending" /> : failure ? <PhotoDevelopment state="failed" reason={failure.reason} onRetry={canDraw ? () => onRetryScene(row.messageId, failure.mode) : undefined} />
            : !scene && canDraw ? <button type="button" className="dialogue-scene-chip" data-history-generate={row.messageId !== snapshot.latestSceneTarget || undefined} onClick={() => onGenerateScene(row.messageId)}><Icon name="image" size={15} />生成过场图</button> : null}
        </>;
        const located = location?.rowId === row.id ? location : null;
        const parts: ReactNode[] = [];
        if (row.action) {
          parts.push(<div key={`action-${row.id}`} className="dialogue-direction" data-reveal={isLive ? '' : undefined}>
            <span className="cue-line" aria-hidden="true" />
            <span className="sr-only">动作：</span><span className="cue-text">{row.action}</span>
          </div>);
        } else {
          const voiceState = playingId === row.id ? 'playing' : pendingVoiceId === row.id ? 'synthesizing' : null;
          const voiceAction = voiceState === 'playing' ? '停止播放这句' : voiceState === 'synthesizing' ? '合成中，可取消' : '播放这句';
          parts.push(<div key={`speech-${row.id}`} className="dialogue-speech" data-live={isLive ? '' : undefined}>
            <div className="dialogue-bubble"><ReplyContent row={row} /></div>
            {row.role === 'assistant' && !row.format && row.segmentId && <button type="button" className="dialogue-speaker" aria-label={`${voiceAction}：${row.text.slice(0, 28)}`} title={voiceUnavailable ? '尚未配置音色' : voiceAction}
              aria-disabled={voiceUnavailable || undefined}
              aria-busy={voiceState === 'synthesizing' || undefined} data-playing={voiceState === 'playing' ? '' : undefined} data-voice={voiceState ?? undefined} onClick={() => onSpeaker(row)}>
              {voiceState ? <>
                <VoiceWave state={voiceState} />
                <span aria-hidden="true">{voiceState === 'playing' ? '停止' : '合成中'}</span>
              </> : <Icon name="speaker" size={16} />}
            </button>}
          </div>);
        }
        if (row.status === 'interrupted') {
          parts.push(<div key={`status-${row.id}`} className="dialogue-status dialogue-interrupted"><Icon name="warning" size={13} />未说完</div>);
        }
        return <article key={row.id} className={`dialogue-message ${row.role}`} data-segment-id={row.segmentId} data-message-id={row.messageId}
          ref={element => { if (element) rows.current.set(row.id, element); else rows.current.delete(row.id); }}
          tabIndex={-1}
          data-live={isLive ? '' : undefined} data-located={located?.sequence}
          aria-label={`${row.role === 'user' ? '你' : '角色'}，${dateCaption(key)} ${timeLabel(row.createdAt)}`}>
          {divider ? <div className="dialogue-date" aria-hidden="true">{dateCaption(key)}</div> : null}
          <div className="dialogue-message-content">
            {parts}
            {row.deliveredReceipt && <div className="dialogue-status" role="status">系统回执 · {row.deliveredReceipt}</div>}
            {sceneControl && <div className="dialogue-round-tools" data-tools>{sceneControl}</div>}
            <time className="dialogue-time" title={`${dateCaption(key)} ${timeLabel(row.createdAt)}`}>{timeLabel(row.createdAt)}</time>
            {located && <span key={located.sequence} className="dialogue-location-ink" data-from-history={located.fromHistory || undefined} aria-hidden="true" />}
          </div>
        </article>;
      })}
      {waitingText ? <div className="dialogue-waiting" data-submitting={submission?.awaitingReceipt || undefined}
        role={submission?.awaitingReceipt ? undefined : 'status'}>
        <span>{waitingText}</span>
        {!policy.reduced ? <span className="dialogue-waiting-dots" aria-hidden="true"><i /><i /><i /></span> : null}
      </div> : null}
    </div>
    <div className="dialogue-date-notice" hidden={!dateNotice} role="status">{dateNotice}</div>
    <button type="button" className="dialogue-latest" hidden={follow} data-new={hasNew ? '' : undefined} onClick={onLatest}>
      <Icon name="down" size={15} /><span>回到最新</span><i aria-hidden="true" />
    </button>
    </div>
    <div className="dialogue-zone">
      {snapshot.failedReply && !advancing && !waitReason && <div className="dialogue-wait-notice" role="status" data-failed-message-id={snapshot.failedReply.messageId}>
        <span title={snapshot.failedReply.errorCode}>{snapshot.failedReply.receiptSummary
          ? `${snapshot.failedReply.receiptSummary}角色的完整回复暂未送达。`
          : '上一条消息已保存，回复中断了。'}{replyError && <small>（{replyError}）</small>}</span>
        {!snapshot.failedReply.receiptSummary && <button type="button" onClick={onRetryFailedReply} disabled={stoppedNotice}>重新回复</button>}
      </div>}
      {waitReason || roleStopped || snapshot.roleRejected ? <div className="dialogue-wait-notice" role="status">
        <span>{waitReason === 'MODEL_MISSING'
          ? '消息已接收，但还没有可用的对话模型。'
          : waitReason === 'ROLE_STOPPED'
            ? '消息已接收。角色已停止，恢复活动后会继续处理。'
            : waitReason === 'WINDOW_BLOCKED'
              ? '消息已接收；这个窗口当前无法继续。'
              : waitReason
                ? '消息已接收，正在等待处理。'
                : snapshot.roleRejected
                  ? '角色已停止，消息还没有发送。恢复活动后请再发送一次。'
                  : '角色已停止，恢复活动后即可继续对话。'}</span>
        {stoppedNotice ? <Button size="sm" busy={resuming} onClick={onResumeRole}>恢复活动</Button> : null}
        {waitReason === 'MODEL_MISSING' ? <button type="button" onClick={onConfigureModel}>配置对话模型</button> : null}
        {waitReason ? <button type="button" onClick={onRetryWaiting}>重试</button> : null}
      </div> : null}
      {notice ? <p className="dialogue-outfit-notice" role="status">{notice}</p> : null}
      {advancing ? <div className="dialogue-advance-bar">
        {snapshot.canAdvance && !snapshot.awaiting ? <>
          <span className="dialogue-advance-meta">
            <span>还有 {snapshot.upcoming?.length ?? 0} 句</span>
            <small>点对话框、按 Enter 或点击右侧继续</small>
          </span>
          <div className="dialogue-advance-actions">
            {onAdvanceAll && (snapshot.upcoming?.length ?? 0) > 1 ? <button type="button" className="dialogue-advance-secondary" onClick={onAdvanceAll}>全部展开</button> : null}
            <button type="button" className="dialogue-advance-primary" onClick={onAdvance}>继续下一句</button>
          </div>
        </> : <span className="dialogue-advance-meta">
          <span>{waitingText || '正在组织回复…'}</span>
        </span>}
      </div> : <form className="dialogue-composer" onSubmit={submit}>
            <div className="dialogue-writing">
              <label className="sr-only" htmlFor="dialogue-draft">输入消息</label>
              <textarea ref={draft} id="dialogue-draft" rows={2} maxLength={2000} placeholder="想说什么，就慢慢说。"
                aria-describedby="dialogue-composer-hint"
                spellCheck={false} value={draftValue} onChange={event => { setDraftValue(event.target.value); onDraftChange(event.target.value); resizeDraft(event.target); onTyping(); }}
                onInput={event => resizeDraft(event.currentTarget)}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={event => { composing.current = false; resizeDraft(event.currentTarget); }}
                onKeyDown={onKeyDown} />
              <div className="dialogue-composer-row">
                <span className="dialogue-composer-hint" id="dialogue-composer-hint">Enter 发送 · Shift + Enter 换行</span>
                <button type="submit" className="dialogue-send" disabled={!draftValue.trim()} aria-disabled={!draftValue.trim()}>
                  <span>发送</span><Icon name="send" size={16} />
                </button>
              </div>
            </div>
            {snapshot.error ? <p className="dialogue-reply-error" role="status">{snapshot.error}</p> : null}
          </form>}
    </div>
  </div>;
}
