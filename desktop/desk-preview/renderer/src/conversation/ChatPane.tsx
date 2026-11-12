import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Icon, useMotionPolicy } from '../ui';
import { dayKey, dateLabel } from './history.js';
import type { PerfRow } from './history.js';
import type { PerfScene } from './performance.js';
import type { ConversationSnapshot } from './use-window-session';
import { shouldAdvanceFromClick, shouldAdvanceFromKey } from './advance.js';

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function dateCaption(key: string): string {
  return `${key === dayKey(Date.now()) ? '今天 · ' : ''}${dateLabel(key)}`;
}

export function ChatPane({
  snapshot,
  playingId,
  follow,
  hasNew,
  liveRowId,
  locatedRowId,
  dateNotice,
  requestDraftFocus,
  initialDraft,
  onDraftChange,
  recoveredDraft,
  onRecoveredDraftApplied,
  onDraftFocusHandled,
  onScrollFollow,
  onLatest,
  onSend,
  onTyping,
  onLoadOlder,
  onAdvance,
  onSpeaker,
  onGenerateScene,
  onOpenScene,
  notice,
}: {
  snapshot: ConversationSnapshot;
  playingId: number | null;
  follow: boolean;
  hasNew: boolean;
  liveRowId: number | null;
  locatedRowId: number | null;
  dateNotice: string | null;
  requestDraftFocus: number;
  initialDraft: string;
  onDraftChange: (value: string) => void;
  recoveredDraft: { value: string; sequence: number } | null;
  onRecoveredDraftApplied: () => void;
  onDraftFocusHandled: () => void;
  onScrollFollow: (follow: boolean) => void;
  onLatest: () => void;
  onSend: (text: string) => boolean;
  onTyping: () => void;
  onLoadOlder: () => void;
  onAdvance: () => void;
  onSpeaker: (row: PerfRow) => void;
  onGenerateScene: (messageId: string) => void;
  onOpenScene: (scene: PerfScene) => void;
  /** 衣柜与当前穿着的提示，例如未选择服饰或服饰没有差分。 */
  notice?: string | null;
}) {
  const policy = useMotionPolicy();
  const scroller = useRef<HTMLDivElement>(null);
  const draft = useRef<HTMLTextAreaElement>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const composing = useRef(false);
  const focusAdvance = useRef(false);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const [draftValue, setDraftValue] = useState(initialDraft);
  const recoveredSequence = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;
  const advancing = snapshot.activeId !== null;

  useEffect(() => {
    if (!recoveredDraft || recoveredDraft.sequence <= recoveredSequence.current) return;
    recoveredSequence.current = recoveredDraft.sequence;
    setDraftValue(recoveredDraft.value);
    onRecoveredDraftApplied();
  }, [recoveredDraft, onRecoveredDraftApplied]);

  const scenesByAnchor = new Map<string, PerfScene[]>();
  const anchors = new Set(snapshot.messages.filter(row => row.role === 'assistant' && row.segmentId).map(row => JSON.stringify([row.messageId, row.segmentId])));
  const unanchoredScenes: PerfScene[] = [];
  for (const scene of snapshot.scenes) {
    const key = JSON.stringify([scene.messageId, scene.startSegmentId]);
    if (!anchors.has(key)) {
      if (snapshot.availableRounds.has(scene.messageId)) unanchoredScenes.push(scene);
      continue;
    }
    const list = scenesByAnchor.get(key) ?? [];
    list.push(scene);
    scenesByAnchor.set(key, list);
  }
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
    if (!locatedRowId) return;
    const element = rows.current.get(locatedRowId);
    const host = scroller.current;
    if (!element || !host) return;
    const top = element.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop - 18;
    host.scrollTo({ top: Math.max(0, top), behavior: policy.reduced ? 'auto' : 'smooth' });
    element.focus({ preventScroll: true });
  }, [locatedRowId, policy.reduced]);

  useEffect(() => {
    if (requestDraftFocus <= 0) return;
    draft.current?.focus({ preventScroll: true });
    onDraftFocusHandled();
  }, [requestDraftFocus, onDraftFocusHandled]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const next = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    onScrollFollow(next);
  };

  const resizeDraft = (element: HTMLTextAreaElement) => {
    element.style.height = '';
    const min = window.innerWidth <= 760 ? (window.innerHeight <= 700 ? 32 : 41) : 46;
    element.style.height = `${Math.min(window.innerWidth <= 760 ? 76 : 92, Math.max(min, element.scrollHeight))}px`;
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

  const sceneControl = (scene: PerfScene) => scene.status === 'generating'
    ? <span key={scene.id} className="dialogue-scene-pending" role="status">{scene.mode === 'background' ? '背景图' : '人物场景图'}生成中…</span>
    : scene.status === 'failed'
      ? <span key={scene.id} className="dialogue-scene-pending" role="status">{scene.mode === 'background' ? '背景图' : '人物场景图'}生成失败</span>
      : <button key={scene.id} type="button" className="dialogue-scene-chip" onClick={() => onOpenScene(scene)}>查看{scene.mode === 'background' ? '背景图' : '人物场景图'}</button>;

  // 首句等待与「已展示到最后一段、模型仍在生成」都给出等待反馈。
  const waitingText = !advancing
    ? null
    : snapshot.awaiting || !snapshot.current
      ? '正在组织回复…'
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
      {snapshot.messages.map((row) => {
        const key = dayKey(row.createdAt);
        const divider = key !== lastDay;
        lastDay = key;
        const isLive = liveRowId === row.id;
        const roundScenes = scenesByAnchor.get(JSON.stringify([row.messageId, row.segmentId])) ?? [];
        const canDraw = snapshot.sceneImagesAvailable && row.role === 'assistant' && !!row.segmentId && lastOfRound.get(row.messageId) === row.id && snapshot.availableRounds.has(row.messageId);
        const located = locatedRowId === row.id;
        const parts: ReactNode[] = [];
        if (row.action) {
          parts.push(<div key={`action-${row.id}`} className="dialogue-direction" data-reveal={isLive ? '' : undefined}>
            <span className="cue-line" aria-hidden="true" />
            <span className="sr-only">动作：</span><span className="cue-text">{row.action}</span>
          </div>);
        } else {
          parts.push(<div key={`speech-${row.id}`} className="dialogue-speech" data-live={isLive ? '' : undefined}>
            <div className="dialogue-bubble">{row.text}</div>
            {row.role === 'assistant' && row.segmentId && <button type="button" className="dialogue-speaker" aria-label={`播放这句：${row.text.slice(0, 28)}`} title="播放这句"
              aria-pressed={playingId === row.id} data-playing={playingId === row.id ? '' : undefined} onClick={() => onSpeaker(row)}>
              <Icon name="speaker" size={16} />
            </button>}
          </div>);
        }
        if (row.status === 'interrupted') parts.push(<div key={`status-${row.id}`} className="dialogue-status">未说完</div>);
        return <article key={row.id} className={`dialogue-message ${row.role}`} data-segment-id={row.segmentId}
          ref={element => { if (element) rows.current.set(row.id, element); else rows.current.delete(row.id); }}
          tabIndex={located ? -1 : undefined}
          data-live={isLive ? '' : undefined} data-located={located ? '' : undefined}
          aria-label={`${row.role === 'user' ? '你' : '角色'}，${dateCaption(key)} ${timeLabel(row.createdAt)}`}>
          {divider ? <div className="dialogue-date" aria-hidden="true">{dateCaption(key)}</div> : null}
          {parts}
          {row.role === 'assistant' && (canDraw || roundScenes.length) ? <div className="dialogue-round-tools" data-tools>
            {roundScenes.map(sceneControl)}
            {canDraw ? <button type="button" className="dialogue-scene-chip" onClick={() => onGenerateScene(row.messageId)}><Icon name="image" size={15} />生成过场图</button> : null}
          </div> : null}
          <time className="dialogue-time" title={`${dateCaption(key)} ${timeLabel(row.createdAt)}`}>{timeLabel(row.createdAt)}</time>
        </article>;
      })}
      {unanchoredScenes.length > 0 && <div className="dialogue-round-tools" aria-label="未能定位句段的过场图">
        <span className="dialogue-scene-pending">未找到对应句段</span>{unanchoredScenes.map(sceneControl)}
      </div>}
      {waitingText ? <div className="dialogue-waiting" role="status">
        <span>{waitingText}</span>
        {!policy.reduced ? <span className="dialogue-waiting-dots" aria-hidden="true"><i /><i /><i /></span> : null}
      </div> : null}
      {advancing && snapshot.canAdvance && !snapshot.awaiting ? <p className="dialogue-advance-hint" aria-hidden="true">点击对话框或按 Enter 继续</p> : null}
    </div>
    <div className="dialogue-date-notice" hidden={!dateNotice} role="status">{dateNotice}</div>
    <button type="button" className="dialogue-latest" hidden={follow} data-new={hasNew ? '' : undefined} onClick={onLatest}>
      <Icon name="down" size={15} /><span>回到最新</span><i aria-hidden="true" />
    </button>
    </div>
    <div className="dialogue-zone">
      {notice ? <p className="dialogue-outfit-notice" role="status">{notice}</p> : null}
      {advancing ? null : <form className="dialogue-composer" onSubmit={submit}>
            <div className="dialogue-writing">
              <label className="sr-only" htmlFor="dialogue-draft">输入消息</label>
              <textarea ref={draft} id="dialogue-draft" rows={2} maxLength={2000} placeholder="想说什么，就慢慢说。"
                spellCheck={false} value={draftValue} onChange={event => { setDraftValue(event.target.value); onDraftChange(event.target.value); resizeDraft(event.target); onTyping(); }}
                onInput={event => resizeDraft(event.currentTarget)}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={event => { composing.current = false; resizeDraft(event.currentTarget); }}
                onKeyDown={onKeyDown} />
              <div className="dialogue-composer-row">
                <span className="dialogue-demo-label">按句演出 · 本地后端</span>
                <button type="submit" className="dialogue-send" disabled={!draftValue.trim()} aria-disabled={!draftValue.trim()} title="Enter 发送；Shift + Enter 换行">
                  <span>发送</span><Icon name="send" size={16} />
                </button>
              </div>
            </div>
            {snapshot.error ? <p className="dialogue-reply-error" role="status">{snapshot.error}</p> : null}
          </form>}
    </div>
  </div>;
}
