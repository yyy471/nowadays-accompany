import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Outfit, RoleListItem } from '../types';
import { appearanceAssetUrl } from '../types';
import { Button, ControlButton, Icon, IconButton, Modal, UiThemeScope, useMotionPolicy } from '../ui';
import { useThemePreset, useThemeTransitionStrategy } from '../ui/presets';
import { dialogueThemeTransition } from '../conversation/dialogue-theme';
import type { PerfScene, SceneLayerMode } from '../conversation/performance.js';
import type { PerfRow } from '../conversation/history.js';
import { dayKey, dateLabel } from '../conversation/history.js';
import { useWindowSession, type ConversationSnapshot, type SessionEvent } from '../conversation/use-window-session';
import { useSegmentVoice } from '../conversation/use-segment-voice';
import { ConversationStage, type StageSources } from '../conversation/ConversationStage';
import { ChatPane } from '../conversation/ChatPane';
import { HistoryPanel } from '../conversation/HistoryPanel';
import character from '../assets/themes/xiacheng/character.png';
import nightCharacter from '../assets/themes/xiacheng/character-night.png';
import scene from '../assets/themes/xiacheng/scene-ink.png';
import nightScene from '../assets/themes/xiacheng/scene-night.png';

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
  loading,
  error,
  hideDock,
  onHideDockChange,
  onSelectRole,
  onOpenRelations,
}: {
  roles: RoleListItem[];
  currentId: string;
  currentOutfit: Outfit | null;
  outfits: Outfit[];
  outfitHomeUrl: string | null;
  loading: boolean;
  error: string;
  hideDock: boolean;
  onHideDockChange: (hidden: boolean) => void;
  onSelectRole: (id: string) => void;
  onOpenRelations: () => void;
}) {
  const { preset } = useThemePreset();
  // 换光由本页接管：舞台光线 + 纸面逐行推进，不再退回整页天气动画。
  useThemeTransitionStrategy(dialogueThemeTransition);
  const night = preset === 'nightwave';
  const motion = useMotionPolicy();
  const role = roles.find(item => item.roleId === currentId);
  const roleName = role?.displayName?.trim() || '角色';

  const [liveRowId, setLiveRowId] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [historyLock, setHistoryLock] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [locatingHistory, setLocatingHistory] = useState(false);
  const [locatedRow, setLocatedRow] = useState<number | null>(null);
  const [dateNotice, setDateNotice] = useState<string | null>(null);
  const [scenePreview, setScenePreview] = useState<PerfScene | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [sceneTarget, setSceneTarget] = useState<string | null>(null);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [voiceAuto, setVoiceAuto] = useState(() => readPreference('voice'));
  const [sceneAuto, setSceneAuto] = useState(() => readPreference('scene'));
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [requestDraftFocus, setRequestDraftFocus] = useState(0);
  const [toastText, setToastText] = useState('');
  const [cue, setCue] = useState(false);
  const [stageRow, setStageRow] = useState<PerfRow | null>(null);
  const [recoveredDraft, setRecoveredDraft] = useState<{ key: string; value: string; sequence: number } | null>(null);
  const recoverySequence = useRef(0);
  const drafts = useRef(new Map<string, string>());

  const prevActive = useRef<string | null>(null);
  const followRef = useRef(follow); followRef.current = follow;
  const historyOpenRef = useRef(historyOpen); historyOpenRef.current = historyOpen;
  const voiceAutoRef = useRef(voiceAuto); voiceAutoRef.current = voiceAuto;
  const reducedRef = useRef(motion.reduced); reducedRef.current = motion.reduced;
  const cueTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const locatedTimer = useRef<number | undefined>(undefined);
  const historyLocationRequest = useRef(0);
  const historyButton = useRef<HTMLButtonElement>(null);
  const frozenScene = useRef<PerfScene | null>(null);

  const showToast = useCallback((message: string) => {
    setToastText(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastText(''), 3200);
  }, []);

  const handleEventRef = useRef<(snapshot: ConversationSnapshot, event: SessionEvent) => void>(() => {});
  const session = useWindowSession({
    roleId: currentId,
    preferredWindowId: role?.defaultWindowId ?? null,
    onEvent: (snapshot, event) => handleEventRef.current(snapshot, event)
  });
  const snapshot = session.snapshot;
  const voice = useSegmentVoice({ roleId: currentId, windowId: session.windowId, onToast: showToast });
  const prefetchRef = useRef(voice.prefetch);
  prefetchRef.current = voice.prefetch;

  // 预取当前台词与后续已就绪句段；失败静默，点播时再提示。
  const prefetchIds = [snapshot?.current?.id ?? 0, ...(snapshot?.upcoming ?? []).slice(0, 2).map(row => row.id)].join(',');
  useEffect(() => {
    if (!snapshot) return;
    const rows: PerfRow[] = [];
    if (snapshot.current) rows.push(snapshot.current);
    rows.push(...(snapshot.upcoming ?? []).slice(0, 2));
    prefetchRef.current(rows.slice(0, 3));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, session.windowId, prefetchIds]);

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
    setLocatedRow(null);
    setDateNotice(null);
    setScenePreview(null);
    frozenScene.current = null;
    setDismissed(new Set());
    setStageRow(null);
    setRoleMenuOpen(false);
    setWindowMenuOpen(false);
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
    if (locatedTimer.current) window.clearTimeout(locatedTimer.current);
  }, []);

  useEffect(() => {
    if (!roleMenuOpen && !windowMenuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (roleMenuOpen && !event.target.closest('.dialogue-role-switch')) setRoleMenuOpen(false);
      if (windowMenuOpen && !event.target.closest('.dialogue-window-switch')) setWindowMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRoleMenuOpen(false);
      setWindowMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [roleMenuOpen, windowMenuOpen]);

  function handleEvent(next: ConversationSnapshot, event: SessionEvent): void {
    const wasAdvancing = prevActive.current !== null;
    prevActive.current = next.activeId;
    if (event.reason === 'load') {
      setLiveRowId(null);
      setFollow(true);
      setHasNew(false);
      setHistoryLock(false);
      setLocatedRow(null);
      setDateNotice(null);
      setScenePreview(null);
      frozenScene.current = null;
      setDismissed(new Set());
      setAnnounce('对话窗口已载入。');
    } else if (event.reason === 'send') {
      setLiveRowId(null);
      voice.cancelPending();
      if (!followRef.current) setHasNew(true);
      setAnnounce('消息已发送，等对方开口。');
    } else if (event.reason === 'segment') {
      const row = event.row;
      setLiveRowId(row?.id ?? null);
      if (row?.action) {
        voice.cancelPending();
        if (!reducedRef.current) {
          setCue(true);
          if (cueTimer.current) window.clearTimeout(cueTimer.current);
          cueTimer.current = window.setTimeout(() => setCue(false), 760);
        }
      } else if (row?.text && voiceAutoRef.current && followRef.current && !historyOpenRef.current) {
        voice.play(row, true);
      }
      if (!followRef.current) setHasNew(true);
      setAnnounce(row?.action || row?.text || '');
    } else if (event.reason === 'error') {
      if (event.message) showToast(event.message);
      if (event.draft && session.windowId) {
        const key = `${currentId}:${session.windowId}`;
        drafts.current.set(key, event.draft);
        setRecoveredDraft({ key, value: event.draft, sequence: ++recoverySequence.current });
      }
    } else if (event.reason === 'connection' && event.message) {
      showToast(event.message);
    }
    if (wasAdvancing && next.activeId === null && !historyOpenRef.current && followRef.current) {
      setRequestDraftFocus(value => value + 1);
    }
  }
  handleEventRef.current = handleEvent;

  const visibleStageRow = stageRow
    ? snapshot?.messages.find(row => row.id === stageRow.id) ?? stageRow
    : null;
  const stageLive = follow && !historyLock && !historyOpen;
  const liveScene = stageLive && sceneAuto && visibleStageRow && snapshot
    ? snapshot.scenes.slice().reverse().find(item => item.status === 'succeeded' && item.messageId === visibleStageRow.messageId
      && item.start <= visibleStageRow.ordinal && visibleStageRow.ordinal <= item.end && !dismissed.has(item.id)) ?? null
    : null;
  const visibleScene = scenePreview ?? (stageLive ? liveScene : frozenScene.current);
  useLayoutEffect(() => {
    if (stageLive) frozenScene.current = visibleScene;
  }, [stageLive, visibleScene]);
  const segmentHomeUrl = visibleStageRow?.role === 'assistant'
    ? (visibleStageRow.homeAssetId ? appearanceAssetUrl(currentId, visibleStageRow.homeAssetId) : null)
    : outfitHomeUrl ?? (night ? nightCharacter : character);
  const sources: StageSources = useMemo(() => ({
    backgroundUrl: night ? nightScene : scene,
    characterUrl: segmentHomeUrl,
    resolveSprite: (assetId: string) => appearanceAssetUrl(currentId, assetId)
  }), [currentId, night, segmentHomeUrl]);

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

  const openScene = (sceneView: PerfScene) => {
    setScenePreview(sceneView);
  };

  const dismissScene = () => {
    const visible = visibleScene;
    if (visible) setDismissed(current => new Set(current).add(visible.id));
    if (!scenePreview || frozenScene.current?.id === scenePreview.id) frozenScene.current = null;
    setScenePreview(null);
  };

  const onLatest = () => {
    setFollow(true);
    setHasNew(false);
    setHistoryLock(false);
    setScenePreview(null);
    setLocatedRow(null);
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
      showToast('无法定位这条消息，请重试。');
      return;
    }
    setHistoryOpen(false);
    session.cancelHistory();
    setLocatedRow(targetId);
    const row = snapshot?.historyMessages.find(item => item.id === targetId);
    const key = row ? dayKey(row.createdAt) : '';
    setDateNotice(key ? dateLabel(key) : '');
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setDateNotice(null), 1650);
    if (locatedTimer.current) window.clearTimeout(locatedTimer.current);
    locatedTimer.current = window.setTimeout(() => setLocatedRow(null), 2200);
  };

  const toggleHistory = () => {
    if (historyOpen) {
      historyLocationRequest.current += 1;
      setLocatingHistory(false);
      session.cancelHistory();
      setHistoryOpen(false);
    } else {
      setHistoryOpen(true);
      void session.loadHistory();
      voice.cancelPending();
    }
  };

  if (loading && !roles.length) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host"><div className="dialogue-empty"><p>正在读取角色资料…</p></div></UiThemeScope>;
  }
  if (!currentId || !role) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host"><div className="dialogue-empty">
      <p>{error ? `角色资料更新失败${roles.length ? '，当前显示上次资料' : ''}。` : '还没有可对话的角色。'}</p>
      <Button variant="entry" onClick={onOpenRelations}>查看关系</Button>
    </div></UiThemeScope>;
  }
  if (!snapshot || snapshot.roleId !== currentId || (session.windowId !== null && snapshot.windowId !== session.windowId)) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host"><div className="dialogue-empty"><p>正在打开对话窗口…</p></div></UiThemeScope>;
  }
  if (snapshot.loadError) {
    return <UiThemeScope theme="xiacheng" className="dialogue-host"><div className="dialogue-empty">
      <p>{snapshot.loadError}</p>
      <div className="dialogue-empty-actions">
        <Button onClick={session.retry}>重试</Button>
        <Button variant="entry" onClick={onOpenRelations}>查看关系</Button>
      </div>
    </div></UiThemeScope>;
  }

  const connectionText = snapshot.connection === 'open'
    ? '实时连接'
    : snapshot.connection === 'retrying'
      ? '正在重连'
      : snapshot.connection === 'closed'
        ? '连接已断开'
        : '正在连接';

  return <UiThemeScope theme="xiacheng" motion={motion.reduced ? 'reduced' : 'full'} className="dialogue-host">
    <div className="dialogue-page" data-theme={night ? 'night' : 'day'} data-motion={motion.reduced ? 'reduced' : 'full'}>
      <main className="dialogue-layout">
        <ConversationStage snapshot={snapshot} current={visibleStageRow} sources={sources}
          visibleScene={visibleScene} live={stageLive} cue={cue} onDismiss={dismissScene} />
        <section className="dialogue-pane" aria-label={historyOpen ? '历史消息' : `与 ${roleName} 的对话`}>
        <div className="dialogue-pane-toolbar" inert={historyOpen} aria-hidden={historyOpen || undefined}>
          <div className="dialogue-pane-switches">
          {roles.length > 1 ? <div className="dialogue-role-switch">
            <ControlButton type="button" className="dialogue-role-button" aria-label={`切换角色，当前${roleName}`} aria-expanded={roleMenuOpen} aria-haspopup="menu" onClick={() => setRoleMenuOpen(value => !value)}>
              <Icon name="person" size={15} /><span>换一位</span>
            </ControlButton>
            {roleMenuOpen ? <div className="dialogue-role-menu" role="menu">
              {roles.map(item => <button key={item.roleId} type="button" role="menuitem" aria-pressed={item.roleId === currentId}
                onClick={() => { if (item.roleId !== currentId) onSelectRole(item.roleId); setRoleMenuOpen(false); }}>
                <span>{item.displayName}</span>{item.roleId === currentId ? <Icon name="check" size={14} /> : null}
              </button>)}
            </div> : null}
          </div> : null}
          {snapshot.windows.length > 1 ? <div className="dialogue-window-switch">
            <ControlButton type="button" className="dialogue-role-button" aria-expanded={windowMenuOpen} aria-haspopup="menu" onClick={() => setWindowMenuOpen(value => !value)}>
              <Icon name="messages" size={15} /><span>换窗口</span>
            </ControlButton>
            {windowMenuOpen ? <div className="dialogue-role-menu" role="menu">
              {snapshot.windows.map((item, index) => <button key={item.windowId} type="button" role="menuitem" aria-pressed={item.windowId === session.windowId}
                onClick={() => { if (item.windowId !== session.windowId) session.selectWindow(item.windowId); setWindowMenuOpen(false); }}>
                <span>{windowLabel(item, index)}</span>{item.windowId === session.windowId ? <Icon name="check" size={14} /> : null}
              </button>)}
            </div> : null}
          </div> : null}
          </div>
          <div className="dialogue-pane-actions">
            <span className="dialogue-connection" data-state={snapshot.loading ? 'loading' : snapshot.connection} role="status" aria-label={snapshot.loading ? '读取中' : connectionText} title={snapshot.loading ? '读取中' : connectionText}><span className="sr-only">{snapshot.loading ? '读取中' : connectionText}</span></span>
            <IconButton className="dialogue-pane-icon" icon="tune" label="演出设置" onClick={() => setPerformanceOpen(true)} />
            <IconButton ref={historyButton} className="dialogue-pane-icon dialogue-history-button" icon="history" label="历史消息" aria-expanded={historyOpen} onClick={toggleHistory} />
          </div>
        </div>
          <div className="dialogue-chat-wrap" inert={historyOpen} aria-hidden={historyOpen || undefined}>
            {snapshot.loading && snapshot.messages.length === 0
              ? <div className="dialogue-chat-loading"><span className="spinner" aria-hidden="true" />正在读取这个窗口的消息…</div>
              : <ChatPane key={`${currentId}:${session.windowId}`} snapshot={snapshot} playingId={voice.playingId} follow={follow} hasNew={hasNew}
                  initialDraft={drafts.current.get(`${currentId}:${session.windowId}`) ?? ''}
                  onDraftChange={value => { drafts.current.set(`${currentId}:${session.windowId}`, value); }}
                  recoveredDraft={recoveredDraft?.key === `${currentId}:${session.windowId}` ? recoveredDraft : null}
                  onRecoveredDraftApplied={() => setRecoveredDraft(null)}
                  liveRowId={liveRowId} locatedRowId={locatedRow} dateNotice={dateNotice} requestDraftFocus={requestDraftFocus}
                  onDraftFocusHandled={() => setRequestDraftFocus(0)}
                  onScrollFollow={next => { setFollow(next); if (next) { setHasNew(false); setHistoryLock(false); } }}
                  onLatest={onLatest} onSend={send} onTyping={session.noteTyping} onLoadOlder={() => void session.loadOlder()} onAdvance={advance}
                  onSpeaker={row => voice.play(row, false)} onGenerateScene={messageId => { setSceneTarget(messageId); setSceneOpen(true); }}
                  onOpenScene={openScene} />}
          </div>
          <HistoryPanel open={historyOpen} messages={snapshot.historyMessages} scenes={snapshot.scenes}
            loading={snapshot.historyLoading || locatingHistory} complete={snapshot.historyComplete} error={snapshot.historyError}
            openerRef={historyButton}
            onRetry={() => void session.loadHistory()} onOpenScene={openScene} onLocate={id => void locate(id)}
            onClose={() => { historyLocationRequest.current += 1; setLocatingHistory(false); session.cancelHistory(); setHistoryOpen(false); }} />
        </section>
      </main>
      <div className="dialogue-toast" hidden={!toastText} role="status">{toastText}</div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>

    <Modal open={performanceOpen} title="演出设置" onClose={() => setPerformanceOpen(false)} description="调整对话页面的演出与显示方式。">
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
        }} /><span>过场图就绪时自动演示</span></label>}
      </div>
    </Modal>

    <Modal open={sceneOpen} title="为这一轮生成过场图" onClose={() => setSceneOpen(false)} description="由后端规划画面并生成本地样例图；只换背景会保留当前立绘。">
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
