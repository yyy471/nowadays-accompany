import { PaperSkeleton } from '../components/PaperSkeleton';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errorText } from '../lib/error-text';
import type { Outfit, RoleListItem } from '../types';
import { appearanceAssetUrl } from '../types';
import { Button, ControlButton, DropdownMenu, Icon, IconButton, Modal, UiThemeScope, readMotionTime, useMotionPolicy } from '../ui';
import { useThemePreset } from '../ui/presets';
import type { PerfScene, SceneLayerMode } from '../conversation/performance';
import type { PerfRow } from '../conversation/history';
import { dayKey, dateLabel } from '../conversation/history';
import { useWindowSession, type ConversationSnapshot, type SessionEvent } from '../conversation/use-window-session';
import { useSegmentVoice } from '../conversation/use-segment-voice';
import { sceneFeedback, sceneForEachReply, shouldClearRecoveredDraft } from '../conversation/window-model';
import { pickCancelableTask, taskCancelLabel, taskCancelNotice, taskCancelTitle, type CancelableTask } from '../conversation/task-actions';
import { ConversationStage, type StageSources } from '../conversation/ConversationStage';
import { ChatPane, type DialogueLocation } from '../conversation/ChatPane';
import { HistoryPanel } from '../conversation/HistoryPanel';
import scene from '../assets/themes/xiacheng/dialogue-day.webp';
import nightScene from '../assets/themes/xiacheng/dialogue-night.webp';

function readPreference(name: string): boolean {
  try { return localStorage.getItem(`nowadays-dialogue-${name}`) === '1'; } catch { return false; }
}
function savePreference(name: string, value: boolean): void {
  try { localStorage.setItem(`nowadays-dialogue-${name}`, value ? '1' : '0'); } catch { /* 本地偏好失效时忽略 */ }
}

function windowLabel(windowItem: { kind: string; source: string }, index: number): string {
  if (windowItem.kind === 'main') return '主对话';
  const source = windowItem.source === 'nowadays' ? '页面窗口' : windowItem.source === 'qq' ? 'QQ 窗口' : (windowItem.source || '自定义窗口');
  return `${source} ${index + 1}`;
}

export function ConversationPage({
  roles,
  currentId,
  currentOutfit,
  outfits,
  outfitHomeUrl,
  appearanceLoading = false,
  loading,
  error,
  retrying,
  onRetry,
  hideDock,
  onHideDockChange,
  onSelectRole,
  onOpenRelations,
  onConfigureModel,
  onCreateRole,
  onRoleStateChanged,
  initialTarget,
  onTargetHandled,
  onVisibleWindow,
  onReturnFeed,
  onReturnDesk,
}: {
  roles: RoleListItem[];
  currentId: string;
  currentOutfit: Outfit | null;
  outfits: Outfit[];
  outfitHomeUrl: string | null;
  appearanceLoading?: boolean;
  loading: boolean;
  error: string;
  retrying: boolean;
  onRetry: () => void;
  hideDock: boolean;
  onHideDockChange: (hidden: boolean) => void;
  onSelectRole: (id: string) => void;
  onOpenRelations: () => void;
  onConfigureModel: () => void;
  onCreateRole: () => void;
  onRoleStateChanged?: () => void;
  initialTarget?: { roleId: string; windowId: string; messageId?: string } | null;
  onTargetHandled?: () => void;
  onVisibleWindow: (id: string | null) => void;
  onReturnDesk?: () => void;
  onReturnFeed?: () => void;
}) {
  const { preset } = useThemePreset();
  // 换光由本页接管：舞台光线 + 纸面逐行推进，不再退回整页天气动画。
  const night = preset === 'nightwave';
  const motion = useMotionPolicy();
  const role = roles.find(item => item.roleId === currentId);
  const roleName = role?.displayName?.trim() || '角色';

  const [roleActivity, setRoleActivity] = useState<{ state: string } | null>(null);
  const [resuming, setResuming] = useState(false);
  const currentRole = useRef<{ id: string; resuming: boolean } | null>(null);
  useLayoutEffect(() => {
    const scope = { id: currentId, resuming: false };
    currentRole.current = scope;
    setResuming(false);
    setRoleActivity(null);
    if (currentId) void api<{ activity: { state: string } }>(`/v1/roles/${encodeURIComponent(currentId)}/activity`)
      .then(result => {
        if (currentRole.current === scope) setRoleActivity(previous => previous ?? result.activity);
      }).catch(() => { /* 读取失败时可由发送回执识别停止态。 */ });
    return () => { currentRole.current = null; };
  }, [currentId]);

  const [liveRowId, setLiveRowId] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [historyLock, setHistoryLock] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [locatingHistory, setLocatingHistory] = useState(false);
  const [location, setLocation] = useState<DialogueLocation | null>(null);
  const [dateNotice, setDateNotice] = useState<string | null>(null);
  const [scenePreview, setScenePreview] = useState<PerfScene | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [sceneTarget, setSceneTarget] = useState<string | null>(null);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [voiceAuto, setVoiceAuto] = useState(() => readPreference('voice'));
  const [sceneAuto, setSceneAuto] = useState(() => readPreference('scene'));
  const [task, setTask] = useState<CancelableTask | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [requestDraftFocus, setRequestDraftFocus] = useState(0);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [cue, setCue] = useState(false);
  const [stageRow, setStageRow] = useState<PerfRow | null>(null);
  const [recoveredDraft, setRecoveredDraft] = useState<{ key: string; value: string; sequence: number } | null>(null);
  const recoverySequence = useRef(0);
  const drafts = useRef(new Map<string, string>());
  // 每次恢复草稿记下来源文本与是否被用户编辑；快照确认时据此决定是否清空（283 §9 R02）。
  const draftRecovery = useRef(new Map<string, { value: string; edited: boolean }>());
  const [clearDraft, setClearDraft] = useState<{ key: string; sequence: number } | null>(null);
  const clearDraftSequence = useRef(0);

  const prevActive = useRef<string | null>(null);
  const followRef = useRef(follow); followRef.current = follow;
  const historyOpenRef = useRef(historyOpen); historyOpenRef.current = historyOpen;
  const voiceAutoRef = useRef(voiceAuto); voiceAutoRef.current = voiceAuto;
  const reducedRef = useRef(motion.reduced); reducedRef.current = motion.reduced;
  const cueTimer = useRef<number | undefined>(undefined);
  const pageRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const locationSequence = useRef(0);
  const historyLocationRequest = useRef(0);
  const historyButton = useRef<HTMLButtonElement>(null);
  const frozenScene = useRef<PerfScene | null>(null);

  const restartToastTimer = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  const showToast = useCallback((message: string, error = true) => {
    if (!message) return;
    setToast({ message, error });
    restartToastTimer();
  }, [restartToastTimer]);
  const cancelRunningTask = useCallback(async () => {
    if (!task || cancelBusy) return;
    setCancelBusy(true);
    try {
      await api(`/v1/roles/${encodeURIComponent(currentId)}/tasks/${encodeURIComponent(task.taskId)}/cancel`, { method: 'POST', body: { reason: 'USER_CANCELLED' } });
      showToast(taskCancelNotice(task), false);
      setCancelOpen(false);
      setTask(null);
      onRoleStateChanged?.();
    } catch (error) {
      showToast(errorText(error));
    } finally {
      setCancelBusy(false);
    }
  }, [task, cancelBusy, currentId, showToast, onRoleStateChanged]);

  const handleEventRef = useRef<(snapshot: ConversationSnapshot, event: SessionEvent) => void>(() => {});
  const session = useWindowSession({
    roleId: currentId,
    preferredWindowId: initialTarget?.roleId === currentId ? initialTarget.windowId : role?.defaultWindowId ?? null,
    onEvent: (snapshot, event) => handleEventRef.current(snapshot, event)
  });
  const snapshot = session.snapshot;
  const readWindows = useRef(new Set<string>());
  const readRoles = useRef(new Set<string>());
  const readKey = JSON.stringify([currentId, session.windowId]);
  useEffect(() => {
    if (snapshot?.roleId !== currentId) return;
    if (snapshot.windowId || snapshot.loadError) readRoles.current.add(currentId);
    if (snapshot.windowId && !snapshot.loading) readWindows.current.add(JSON.stringify([currentId, snapshot.windowId]));
  }, [currentId, snapshot?.roleId, snapshot?.windowId, snapshot?.loading, snapshot?.loadError]);
  const placeLocation = useCallback((rowId: number) => {
    const fromHistory = historyOpenRef.current;
    if (fromHistory) {
      historyLocationRequest.current += 1;
      setLocatingHistory(false);
      setHistoryOpen(false);
      session.cancelHistory();
    }
    // 分页读取之后，保持回看位置并把焦点交给找到的消息。
    setFollow(false);
    setHistoryLock(true);
    setRequestDraftFocus(0);
    setLocation({ rowId, sequence: ++locationSequence.current, fromHistory });
  }, [session.cancelHistory]);
  const visibleWindow = snapshot?.roleId === currentId ? snapshot.windowId : null;
  useLayoutEffect(() => {
    onVisibleWindow(visibleWindow);
    return () => onVisibleWindow(null);
  }, [onVisibleWindow, visibleWindow]);
  const targetRequest = useRef(false);
  useEffect(() => {
    if (!initialTarget || initialTarget.roleId !== currentId || !snapshot || snapshot.roleId !== currentId || snapshot.loading || snapshot.loadError || targetRequest.current) return;
    if (snapshot.windowId !== initialTarget.windowId) {
      if (snapshot.windows.some(item => item.windowId === initialTarget.windowId)) {
        session.selectWindow(initialTarget.windowId);
        return;
      }
      showToast('暂时无法打开原对话。');
      onTargetHandled?.();
      return;
    }
    if (!initialTarget.messageId) { onTargetHandled?.(); return; }
    targetRequest.current = true;
    setFollow(false);
    setHistoryLock(true);
    let active = true;
    void session.locateMessage(initialTarget.messageId).then(row => {
      if (!active) return;
      if (row === null) showToast('暂时找不到这条分享，请在对话中再试一次。');
      else placeLocation(row);
      targetRequest.current = false;
      onTargetHandled?.();
    });
    return () => { active = false; targetRequest.current = false; };
  }, [initialTarget, currentId, snapshot?.roleId, snapshot?.windowId, snapshot?.loading, snapshot?.loadError, session.locateMessage, onTargetHandled, showToast, placeLocation]);
  // 办事任务可能在本页之外推进（自主唤醒、续行段），本轮只用 snapshot 判定刷新时机。
  useEffect(() => {
    if (!currentId) { setTask(null); return; }
    let live = true;
    const load = async () => {
      try {
        const result = await api<{ items: CancelableTask[] }>(`/v1/roles/${encodeURIComponent(currentId)}/tasks`);
        if (live) setTask(pickCancelableTask(result.items));
      } catch {
        // 读取失败时保留上一次结果，不影响对话本身。
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [currentId, snapshot?.activeId]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const resumeRole = async () => {
    const scope = currentRole.current;
    if (!scope || scope.id !== currentId || scope.resuming) return;
    scope.resuming = true;
    setResuming(true);
    try {
      await api(`/v1/roles/${encodeURIComponent(scope.id)}/activity/resume`, { method: 'POST' });
      if (currentRole.current !== scope) return;
      setRoleActivity({ state: 'active' });
      // 未入库的消息保留草稿，已入库等待中的消息沿用原提交标识。
      sessionRef.current.clearRejection();
      sessionRef.current.retryWaiting();
      onRoleStateChanged?.();
    } catch (error) {
      if (currentRole.current === scope) showToast(errorText(error));
    } finally {
      scope.resuming = false;
      if (currentRole.current === scope) setResuming(false);
    }
  };
  const voice = useSegmentVoice({ roleId: currentId, windowId: session.windowId, onToast: showToast });
  const prefetchRef = useRef(voice.prefetch);
  prefetchRef.current = voice.prefetch;

  // 预取当前台词与后续已就绪句段；失败静默，点播时再提示。
  const prefetchIds = [snapshot?.current?.id ?? 0, ...(snapshot?.upcoming ?? []).slice(0, 2).map(row => row.id)].join(',');
  useEffect(() => {
    if (!voiceAuto || !voice.available || !snapshot || snapshot.roleId !== currentId || snapshot.windowId !== session.windowId) return;
    const rows: PerfRow[] = [];
    if (snapshot.current) rows.push(snapshot.current);
    rows.push(...(snapshot.upcoming ?? []).slice(0, 2));
    prefetchRef.current(rows.slice(0, 3));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceAuto, voice.available, currentId, session.windowId, snapshot?.roleId, snapshot?.windowId, prefetchIds]);

  // 切换角色或窗口后重置页面阅读与演出状态。
  useEffect(() => {
    prevActive.current = null;
    setLiveRowId(null);
    setFollow(true);
    setHasNew(false);
    setHistoryLock(false);
    setHistoryOpen(false);
    historyLocationRequest.current += 1;
    setLocatingHistory(false);
    setLocation(null);
    setDateNotice(null);
    setScenePreview(null);
    frozenScene.current = null;
    setDismissed(new Set());
    setStageRow(null);
    setRequestDraftFocus(0);
  }, [currentId, session.windowId]);

  // 舞台只跟随实时演出；回看或历史定位期间冻结在离开实时位置时的句段。
  useEffect(() => {
    if (follow && !historyLock && !historyOpen) setStageRow(snapshot?.current ?? null);
  }, [follow, historyLock, historyOpen, snapshot?.current]);

  useEffect(() => () => {
    if (cueTimer.current) window.clearTimeout(cueTimer.current);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    if (!motion.reduced) return;
    window.clearTimeout(cueTimer.current);
    setCue(false);
  }, [motion.reduced]);

  function handleEvent(next: ConversationSnapshot, event: SessionEvent): void {
    const wasAdvancing = prevActive.current !== null;
    prevActive.current = next.activeId;
    if (event.reason === 'load') {
      setLiveRowId(null);
      setFollow(true);
      setHasNew(false);
      setHistoryLock(false);
      setLocation(null);
      setDateNotice(null);
      setScenePreview(null);
      frozenScene.current = null;
      setDismissed(new Set());
      setAnnounce('对话已打开。');
    } else if (event.reason === 'send' || event.reason === 'retryReply') {
      setLiveRowId(null);
      voice.cancelPending();
      if (event.reason === 'send' && session.windowId) draftRecovery.current.delete(`${currentId}:${session.windowId}`);
      if (!followRef.current) setHasNew(true);
      setAnnounce(event.reason === 'retryReply' ? '正在请求重新回复。' : '正在发送消息。');
    } else if (event.reason === 'segment') {
      const row = event.row;
      setLiveRowId(row?.id ?? null);
      if (row?.action) {
        voice.cancelPending();
        if (!reducedRef.current) {
          setCue(true);
          if (cueTimer.current) window.clearTimeout(cueTimer.current);
          cueTimer.current = window.setTimeout(() => setCue(false), readMotionTime(pageRef.current, '--nd-semantic-motion-scene', 900));
        }
      } else if (row?.text && voiceAutoRef.current && followRef.current && !historyOpenRef.current) {
        voice.play(row, true);
      }
      if (!followRef.current) setHasNew(true);
      setAnnounce(row?.action || row?.text || '');
    } else if (event.reason === 'terminal' && next.current?.status === 'interrupted') {
      setAnnounce('本轮回复未说完。');
    } else if (event.reason === 'error') {
      if (event.message) showToast(event.message);
      if (event.draft && session.windowId) {
        const key = `${currentId}:${session.windowId}`;
        drafts.current.set(key, event.draft);
        draftRecovery.current.set(key, { value: event.draft, edited: false });
        setRecoveredDraft({ key, value: event.draft, sequence: ++recoverySequence.current });
      }
    } else if (event.reason === 'connection' && event.message) {
      showToast(event.message);
    }
    if (event.reason === 'terminal' || event.reason === 'annotation' || (wasAdvancing && next.activeId === null)) {
      onRoleStateChanged?.();
    }
    if (wasAdvancing && next.activeId === null && !historyOpenRef.current && followRef.current) {
      setRequestDraftFocus(value => value + 1);
    }
  }
  handleEventRef.current = handleEvent;

  // 快照确认原提交已入库：只清理由那次恢复带来且未被编辑过的草稿（283 §9 R02）。
  const confirmedDraftSequence = snapshot?.confirmedDraft?.sequence ?? 0;
  useEffect(() => {
    if (confirmedDraftSequence <= 0 || !session.windowId || !snapshot?.confirmedDraft) return;
    const key = `${currentId}:${session.windowId}`;
    const record = draftRecovery.current.get(key);
    if (!shouldClearRecoveredDraft(record, snapshot.confirmedDraft.content)) return;
    draftRecovery.current.delete(key);
    drafts.current.set(key, '');
    setClearDraft({ key, sequence: ++clearDraftSequence.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedDraftSequence, currentId, session.windowId]);

  const visibleStageRow = stageRow
    ? snapshot?.messages.find(row => row.id === stageRow.id) ?? stageRow
    : null;
  const stageLive = follow && !historyLock && !historyOpen;
  const replyScenes = useMemo(() => sceneForEachReply(snapshot?.scenes ?? []), [snapshot?.scenes]);
  const candidate = visibleStageRow && replyScenes.get(visibleStageRow.messageId);
  const liveScene = stageLive && sceneAuto && visibleStageRow && candidate?.status === 'succeeded'
    && candidate.start <= visibleStageRow.ordinal && visibleStageRow.ordinal <= candidate.end && !dismissed.has(candidate.id) ? candidate : null;
  const preview = scenePreview && replyScenes.get(scenePreview.messageId);
  const visibleScene = scenePreview ? (preview?.status === 'succeeded' ? preview : scenePreview)
    : stageLive ? liveScene : frozenScene.current;
  const sceneState = visibleScene && snapshot ? sceneFeedback(snapshot.scenes, snapshot.sceneRequests, snapshot.sceneRequestErrors, visibleScene.messageId) : null;
  useLayoutEffect(() => {
    if (stageLive) frozenScene.current = visibleScene;
  }, [stageLive, visibleScene]);
  const segmentHomeUrl = visibleStageRow?.role === 'assistant' && visibleStageRow.homeAssetId
    ? appearanceAssetUrl(currentId, visibleStageRow.homeAssetId)
    : null;
  const hasOutfits = outfits.length > 0;
  const awaitingInitialOutfit = !appearanceLoading && hasOutfits && currentOutfit === null;
  const sources: StageSources = useMemo(() => ({
    backgroundUrl: night ? nightScene : scene,
    segmentHomeUrl,
    outfitUrl: outfitHomeUrl,
    // 无立绘的角色保持空态：只用书房背景，不回退到内置主题人物（DL-153）。
    themeUrl: null,
    resolveSprite: (assetId: string) => appearanceAssetUrl(currentId, assetId)
  }), [currentId, night, segmentHomeUrl, outfitHomeUrl, appearanceLoading, hasOutfits]);

  const send = (text: string) => {
    if (!session.send(text)) return false;
    setHistoryLock(false);
    setFollow(true);
    setHasNew(false);
    return true;
  };

  const advance = () => {
    setHistoryLock(false);
    setFollow(true);
    setHasNew(false);
    setScenePreview(null);
    session.advance();
  };

  const advanceAll = () => {
    setHistoryLock(false);
    setFollow(true);
    setHasNew(false);
    setScenePreview(null);
    session.advanceAll();
  };

  const openScene = (sceneView: PerfScene) => {
    setScenePreview(sceneView);
  };

  const dismissScene = () => {
    const visible = visibleScene;
    if (visible) setDismissed(current => new Set([...current, ...(snapshot?.scenes ?? [visible])
      .filter(scene => scene.messageId === visible.messageId).map(scene => scene.id)]));
    frozenScene.current = null;
    setScenePreview(null);
  };

  const onLatest = () => {
    setFollow(true);
    setHasNew(false);
    setHistoryLock(false);
    setScenePreview(null);
    setLocation(null);
  };

  const locate = async (targetId: number) => {
    const request = ++historyLocationRequest.current;
    setLocatingHistory(true);
    setFollow(false);
    setHistoryLock(true);
    setHasNew(snapshot?.activeId != null);
    const visible = await session.ensureVisible(targetId);
    if (historyLocationRequest.current !== request) return;
    setLocatingHistory(false);
    if (!visible) {
      showToast('暂时找不到这条消息，请再试一次。');
      return;
    }
    placeLocation(targetId);
    const row = snapshot?.historyMessages.find(item => item.id === targetId);
    const key = row ? dayKey(row.createdAt) : '';
    setDateNotice(key ? dateLabel(key) : '');
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setDateNotice(null), 1650);
  };

  const toggleHistory = () => {
    if (historyOpen) {
      historyLocationRequest.current += 1;
      setLocatingHistory(false);
      session.cancelHistory();
      setHistoryOpen(false);
    } else {
      setLocation(null);
      setHistoryOpen(true);
      void session.loadHistory();
      voice.cancelPending();
    }
  };

  const heading = <h1 className="sr-only">{role ? `与 ${roleName} 的对话` : '对话'}</h1>;
  if (loading && !roles.length) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host">{heading}<div className="dialogue-empty"><PaperSkeleton label="正在读取角色资料…"/></div></UiThemeScope>;
  }
  if (!currentId || !role) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host">{heading}<div className="dialogue-empty">
      <p>{error || '还没有可对话的角色。'}</p>
      <div className="dialogue-empty-actions">{error
        ? <Button busy={retrying} onClick={onRetry}>重试</Button>
        : <>{roles.length === 0 && <Button variant="entry" onClick={onCreateRole}>创建角色</Button>}<Button variant="entry" onClick={onOpenRelations}>查看关系</Button></>}</div>
    </div></UiThemeScope>;
  }
  if (!snapshot || snapshot.roleId !== currentId || (session.windowId !== null && snapshot.windowId !== session.windowId)) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host">{heading}<div className="dialogue-empty">{readRoles.current.has(currentId) ? <p role="status">正在打开对话窗口…</p> : <PaperSkeleton label="正在打开对话窗口…"/>}</div></UiThemeScope>;
  }
  if (snapshot.loadError) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host">{heading}<div className="dialogue-empty">
      <p>{snapshot.loadError}</p>
      <div className="dialogue-empty-actions">
        <Button onClick={session.retry}>重试</Button>
      </div>
    </div></UiThemeScope>;
  }

  const connectionText = snapshot.connection === 'open'
    ? '已连接'
    : snapshot.connection === 'retrying'
      ? '正在重新连接'
      : snapshot.connection === 'closed'
        ? '连接已断开'
        : '正在连接';

  const feedback = <div className="dialogue-toast" hidden={!toast} role="status" data-error={toast?.error || undefined}
    onPointerEnter={() => window.clearTimeout(toastTimer.current)} onPointerLeave={restartToastTimer}
    onFocus={() => window.clearTimeout(toastTimer.current)} onBlur={restartToastTimer}>{toast?.message}</div>;
  return <UiThemeScope theme="xiacheng" motion={motion.reduced ? 'reduced' : 'full'} className="dialogue-host">
    <div ref={pageRef} className="dialogue-page" data-theme={night ? 'night' : 'day'} data-motion={motion.reduced ? 'reduced' : 'full'}>
      {heading}
      <div className="dialogue-layout">
        <ConversationStage snapshot={snapshot} current={visibleStageRow} sources={sources}
          visibleScene={visibleScene} live={stageLive} cue={cue}
          waitingOutfit={appearanceLoading || awaitingInitialOutfit}
          waitingText={appearanceLoading ? '正在读取外观…' : `${roleName} 正在换装，即将赶来…`}
          onDismiss={dismissScene} regenerating={!!visibleScene && (!!snapshot?.sceneRequests.has(visibleScene.messageId)
            || !!snapshot?.scenes.some(s => s.messageId === visibleScene.messageId && s.status === 'generating'))}
          sceneFailure={sceneState?.error?.reason}
          onRegenerate={image => { setScenePreview(image); session.requestScene(image.messageId, sceneState?.error?.mode ?? image.mode); }} />
        <section ref={paneRef} className="dialogue-pane" aria-label={historyOpen ? '历史消息' : `与 ${roleName} 的对话`}>
        <div className="dialogue-pane-toolbar" inert={historyOpen} aria-hidden={historyOpen || undefined}>
          <div className="dialogue-pane-switches">
          {onReturnDesk && <ControlButton className="dialogue-role-button" onClick={onReturnDesk}><Icon name="chev-left" size={15}/><span>回到刚才的台面</span></ControlButton>}
          {onReturnFeed && <ControlButton className="dialogue-role-button" onClick={onReturnFeed}><Icon name="chev-left" size={15}/><span>返回动态</span></ControlButton>}
          {roles.length > 1 ? <div className="dialogue-role-switch">
            <DropdownMenu label="换一位" triggerAriaLabel={`换一位，当前${roleName}`} selectedPage={currentId}
              triggerIcon="person" triggerClassName="dialogue-role-button" boundaryRef={paneRef}
              items={roles.map(item => ({ id: item.roleId, label: item.displayName,
                onSelect: () => { if (item.roleId !== currentId) onSelectRole(item.roleId); } }))}/>
          </div> : null}
          {snapshot.windows.length > 1 ? <div className="dialogue-window-switch">
            <DropdownMenu label="换窗口" selectedPage={session.windowId ?? undefined}
              triggerIcon="messages" triggerClassName="dialogue-role-button" boundaryRef={paneRef}
              items={snapshot.windows.map((item, index) => ({ id: item.windowId, label: windowLabel(item, index),
                onSelect: () => { if (item.windowId !== session.windowId) session.selectWindow(item.windowId); } }))}/>
          </div> : null}
          </div>
          <div className="dialogue-pane-actions">
            {task ? <ControlButton type="button" className="dialogue-task-cancel" aria-label={taskCancelLabel(task)} title={taskCancelTitle(task)} onClick={() => setCancelOpen(true)}>
              <Icon name="close" size={14} /><span>{taskCancelLabel(task)}</span>
            </ControlButton> : null}
            <span className="dialogue-connection" data-state={snapshot.loading ? 'loading' : snapshot.connection} role="status" aria-label={snapshot.loading ? '读取中' : connectionText} title={snapshot.loading ? '读取中' : connectionText}><span className="sr-only">{snapshot.loading ? '读取中' : connectionText}</span></span>
            <IconButton className="dialogue-pane-icon" icon="tune" label="演出设置" onClick={() => setPerformanceOpen(true)} />
            <IconButton ref={historyButton} className="dialogue-pane-icon dialogue-history-button" icon="history" label="历史消息" aria-expanded={historyOpen} onClick={toggleHistory} />
          </div>
        </div>
          {!historyOpen && feedback}
          <div className="dialogue-chat-wrap" inert={historyOpen} aria-hidden={historyOpen || undefined}>
            {snapshot.loading && snapshot.messages.length === 0
              ? <div className="dialogue-chat-loading">{readWindows.current.has(readKey)
                  ? <span role="status">正在读取消息…</span> : <PaperSkeleton label="正在读取消息…"/>}</div>
              : <ChatPane key={`${currentId}:${session.windowId}`} snapshot={snapshot} pendingVoiceId={voice.pendingId} playingId={voice.playingId} follow={follow} hasNew={hasNew}
                  initialDraft={drafts.current.get(`${currentId}:${session.windowId}`) ?? ''}
                  onDraftChange={value => {
                    const key = `${currentId}:${session.windowId}`;
                    const record = draftRecovery.current.get(key);
                    if (record !== undefined && value !== record.value) record.edited = true;
                    drafts.current.set(key, value);
                  }}
                  recoveredDraft={recoveredDraft?.key === `${currentId}:${session.windowId}` ? recoveredDraft : null}
                  onRecoveredDraftApplied={() => setRecoveredDraft(null)}
                  clearDraft={clearDraft?.key === `${currentId}:${session.windowId}` ? clearDraft.sequence : null}
                  onClearDraftApplied={() => setClearDraft(null)}
                  liveRowId={liveRowId} location={location} dateNotice={dateNotice} requestDraftFocus={requestDraftFocus}
                  onDraftFocusHandled={() => setRequestDraftFocus(0)}
                  onScrollFollow={next => { setLocation(null); setFollow(next); if (next) { setHasNew(false); setHistoryLock(false); } }}
                  onLatest={onLatest} onSend={send} onTyping={session.noteTyping} onLoadOlder={() => void session.loadOlder()} onAdvance={advance} onAdvanceAll={advanceAll}
                  notice={!appearanceLoading && !hasOutfits ? '还没有主页立绘，可在角色配置的「外观」中添加服饰。' : currentOutfit && currentOutfit.sprites.length === 0 ? '这套服饰还没有对话表情，可在「外观」中添加差分。' : null}
                  waitReason={snapshot.waitReason}
                  roleStopped={roleActivity?.state === 'stopped'}
                  resuming={resuming} onResumeRole={resumeRole} voiceUnavailable={voice.available === false}
                  onConfigureModel={onConfigureModel}
                  onRetryWaiting={() => { session.retryWaiting(); }}
                  onRetryFailedReply={() => { session.retryFailedReply(); }}
                  onSpeaker={row => {
                    if (voice.playingId === row.id) voice.stop();
                    else if (voice.pendingId === row.id) voice.cancelPending();
                    else voice.play(row);
                  }} onGenerateScene={messageId => { setSceneTarget(messageId); setSceneOpen(true); }}
                  onRetryScene={(messageId, mode) => session.requestScene(messageId, mode)}
                  onOpenScene={openScene} />}
          </div>
          <HistoryPanel open={historyOpen} feedback={historyOpen ? feedback : null} messages={snapshot.historyMessages} scenes={snapshot.scenes}
            loading={snapshot.historyLoading} locating={locatingHistory} complete={snapshot.historyComplete} error={snapshot.historyError}
            openerRef={historyButton}
            onRetry={() => void session.loadHistory()} onOpenScene={openScene} onLocate={id => void locate(id)}
            onClose={() => { historyLocationRequest.current += 1; setLocatingHistory(false); session.cancelHistory(); setHistoryOpen(false); }} />
        </section>
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>

    <Modal open={cancelOpen} title={taskCancelLabel(task) || '取消任务'} onClose={() => setCancelOpen(false)} description={task ? taskCancelTitle(task) : ''}>
      <div className="dialogue-cancel-task">
        <p>取消会结束当前任务并保留已保存的进度笔记和工具结果，如需继续请重新提出请求。</p>
        <div className="dialogue-cancel-task-actions">
          <Button variant="danger" busy={cancelBusy} onClick={() => void cancelRunningTask()}>确认取消任务</Button>
          <Button onClick={() => setCancelOpen(false)}>继续办理</Button>
        </div>
      </div>
    </Modal>

    <Modal open={performanceOpen} title="演出设置" onClose={() => setPerformanceOpen(false)}>
      <div className="dialogue-settings-options">
        <label className="dialogue-option"><input type="checkbox" checked={hideDock} onChange={event => onHideDockChange(event.target.checked)} /><span>隐藏底部导航栏</span></label>
        <label className="dialogue-option"><input type="checkbox" checked={voiceAuto} onChange={event => {
          const next = event.target.checked;
          setVoiceAuto(next); savePreference('voice', next);
          if (!next) voice.cancelPending();
        }} /><span>自动播放新台词</span></label>
        {snapshot?.sceneImagesAvailable && <label className="dialogue-option"><input type="checkbox" checked={sceneAuto} onChange={event => {
          const next = event.target.checked;
          setSceneAuto(next); savePreference('scene', next);
        }} /><span>自动展示过场图</span></label>}
      </div>
    </Modal>

    <Modal open={sceneOpen} title="为这一轮生成过场图" onClose={() => setSceneOpen(false)} description="只换背景时会保留当前立绘。">
      <div className="dialogue-scene-options">
        <Button size="sm" onClick={() => { requestScene('background'); setSceneOpen(false); }}>只换背景</Button>
        <Button size="sm" onClick={() => { requestScene('full_scene'); setSceneOpen(false); }}>人物与背景</Button>
      </div>
    </Modal>
  </UiThemeScope>;

  function requestScene(mode: SceneLayerMode) {
    if (sceneTarget) session.requestScene(sceneTarget, mode);
  }
}
