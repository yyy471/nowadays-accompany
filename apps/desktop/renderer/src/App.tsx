import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from './api';
import type { Outfit, RoleDetail, RoleListItem, RoleStateResponse } from './types';
import { appearanceAssetUrl } from './types';
import { BrandMark, Button, ControlButton, Icon, UiThemeProvider, UiThemeScope, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy } from './ui';
import { useThemePreset } from './ui/presets';
import { ThemeSwitcher } from './components/shell/ThemeSwitcher';
import { EngineeringCapsule } from './components/shell/EngineeringCapsule';
import { PageDock } from './components/shell/PageDock';
import { ExtensionsPage, ExtensionOverlays } from './extensions/ExtensionViews';
import { useExtensions } from './extensions/use-extensions';
import { ShareSlip } from './components/shell/ShareSlip';
import { HomePage } from './pages/Home';
import { Relations } from './pages/Relations';
import { SettingsWorkspace, type ConfigNavigationGuard } from './pages/Settings';
import { ConversationPage } from './pages/Conversation';
import { FeedPage } from './pages/Feed';
import { RoleEntry } from './pages/RoleEntry';
import { needsEntryPick } from './entry/role-entry';
import { createStateVersionGate } from './state-version';

export function App() {
  const extensions = useExtensions();
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  const [scope] = useState(createMotionScope);
  const pageBody = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState('home');
  const [conversationTarget, setConversationTarget] = useState<{ roleId: string; windowId: string; messageId?: string } | null>(null);
  const [conversationFromFeed, setConversationFromFeed] = useState(false);
  const [visibleWindow, setVisibleWindow] = useState<string | null>(null);
  const [feedVisited, setFeedVisited] = useState(false);
  const handleConversationTarget = useCallback(() => setConversationTarget(null), []);
  useEffect(() => { if (page === 'feed') setFeedVisited(true); }, [page]);
  useEffect(() => {
    if (page !== 'conversation') { setConversationTarget(null); setConversationFromFeed(false); }
  }, [page]);
  const [configFooterLeft, setConfigFooterLeft] = useState<HTMLDivElement | null>(null);
  const [configFooterRight, setConfigFooterRight] = useState<HTMLDivElement | null>(null);
  const configGuard = useRef<ConfigNavigationGuard | null>(null);
  const configSwap = useRef({ generation: 0, animations: [] as Animation[] });
  const feedTransition = useRef<{ transition: ViewTransition; release: () => void } | null>(null);
  const feedNavigationId = useRef(0);
  const feedOrigin = useRef<{ eventId: string; roleId: string; messageId?: string } | null>(null);
  const cancelFeedNavigation = () => {
    feedNavigationId.current += 1;
    const active = feedTransition.current;
    feedTransition.current = null;
    active?.release();
    active?.transition.skipTransition();
    delete document.documentElement.dataset.feedTransition;
  };
  const cancelConfigSwap = () => {
    const state = configSwap.current;
    state.generation += 1;
    state.animations.forEach(animation => animation.cancel());
    state.animations = [];
  };
  const applyPage = (next: string, after?: () => void, feedRequest?: number) => {
    if (feedRequest === undefined) cancelFeedNavigation();
    else if (feedRequest !== feedNavigationId.current) return;
    cancelConfigSwap();
    if (next === page) return;
    const apply = () => { after?.(); setPage(next); };
    const configPages = ['role-config', 'settings'];
    const state = configSwap.current;
    const generation = state.generation;
    if (motion.reduced || document.hidden || !configPages.includes(page) || !configPages.includes(next)) { apply(); return; }
    const targets = () => [...document.querySelectorAll<HTMLElement>(
      '.studio-shell:not(.config-theme-veil) :is(.config-stage,.config-index,.config-tabs,.config-leaf,#config-footer-left,#config-footer-right)',
    )].filter(element => element.offsetParent !== null);
    const previous = targets();
    state.animations = previous.map(element => element.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: readMotionTime(element, '--nd-semantic-motion-micro-exit', 90),
      easing: readMotionValue(element, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
    }));
    void Promise.allSettled(state.animations.map(animation => animation.finished)).then(() => {
      if (generation !== state.generation) return;
      flushSync(apply);
      state.animations.forEach(animation => animation.cancel());
      state.animations = targets().flatMap(element => {
        const duration = readMotionTime(element, '--nd-semantic-motion-component', 220);
        const offset = readMotionPx(element, '--nd-semantic-motion-detail-page-offset', 4);
        return duration <= 0 || document.hidden ? [] : [element.animate([{ opacity: 0, transform: `translateY(${offset}px)` }, { opacity: 1, transform: 'none' }], {
          duration, easing: readMotionValue(element, '--nd-semantic-motion-ease-out', 'ease-out'),
        })];
      });
    });
  };
  const navigate = (next: string, after?: () => void) => {
    if (next === page) { applyPage(next); return; }
    const proceed = () => applyPage(next, after);
    if ((page === 'role-config' || page === 'settings') && configGuard.current) configGuard.current(next, proceed);
    else proceed();
  };
  const navigateFeedChat = (next: 'feed' | 'conversation', target?: { roleId: string; windowId: string; messageId?: string; eventId: string }) => {
    cancelFeedNavigation();
    const request = feedNavigationId.current;
    if (target) feedOrigin.current = { eventId: target.eventId, roleId: target.roleId, messageId: target.messageId };
    const origin = feedOrigin.current;
    const feedCard = () => [...document.querySelectorAll<HTMLElement>('[data-feed-chat]')]
      .find(element => element.dataset.feedChat === origin?.eventId)?.closest<HTMLElement>('.feed-slip') ?? null;
    const old = next === 'conversation' ? feedCard() : [...document.querySelectorAll<HTMLElement>('.dialogue-message[data-message-id]')]
      .find(element => {
        const host = element.closest('.dialogue-messages')?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return origin?.roleId === currentId && element.dataset.messageId === origin.messageId && !!host && rect.bottom > host.top && rect.top < host.bottom;
      })?.querySelector<HTMLElement>('.dialogue-bubble') ?? null;
    const preview = next === 'conversation' ? old?.querySelector('.feed-letter-text')?.textContent : null;
    const apply = () => applyPage(next, target ? () => { setCurrentId(target.roleId); setConversationTarget(target); setConversationFromFeed(true); } : undefined, request);
    const root = document.documentElement;
    if (motion.reduced || document.hidden || root.hasAttribute('data-theme-transition') || root.hasAttribute('data-switching') || !document.startViewTransition) { apply(); return; }
    const scopeElement = old ?? pageBody.current;
    if (!scopeElement) { apply(); return; }
    root.dataset.feedTransition = '';
    root.style.setProperty('--feed-transition-duration', `${readMotionTime(scopeElement, next === 'feed' ? '--nd-semantic-motion-page-exit' : '--nd-semantic-motion-page', next === 'feed' ? 260 : 360)}ms`);
    root.style.setProperty('--feed-transition-ease', readMotionValue(scopeElement, next === 'feed' ? '--nd-semantic-motion-ease-in' : '--nd-semantic-motion-ease-out', 'ease'));
    if (old && origin?.messageId) old.style.viewTransitionName = 'feed-share';
    let incoming: HTMLElement | null = null;
    let proxyHost: HTMLElement | null = null;
    const update = () => {
      if (request !== feedNavigationId.current) return;
      if (old) old.style.viewTransitionName = '';
      flushSync(apply);
      if (!old || !origin?.messageId) return;
      if (next === 'feed') incoming = feedCard();
      else if (preview) {
        const pane = document.querySelector<HTMLElement>('.dialogue-pane');
        proxyHost = pane ?? document.querySelector<HTMLElement>('.dialogue-host');
        if (proxyHost) {
          incoming = document.createElement('div');
          incoming.className = `dialogue-bubble feed-transition-proxy${pane ? '' : ' feed-transition-proxy-fallback'}`;
          incoming.setAttribute('aria-hidden', 'true');
          incoming.textContent = preview;
          if (!pane) proxyHost.classList.add('feed-transition-host');
          proxyHost.append(incoming);
        }
      }
      if (incoming) incoming.style.viewTransitionName = 'feed-share';
    };
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (old) old.style.viewTransitionName = '';
      if (incoming?.classList.contains('feed-transition-proxy')) incoming.remove();
      else if (incoming) incoming.style.viewTransitionName = '';
      proxyHost?.classList.remove('feed-transition-host');
    };
    try {
      const transition = document.startViewTransition(update);
      feedTransition.current = { transition, release };
      void transition.ready.then(release, () => {});
      void transition.finished.catch(() => {}).finally(() => {
        release();
        if (feedTransition.current?.transition === transition) {
          feedTransition.current = null;
          delete root.dataset.feedTransition;
        }
      });
    } catch {
      release();
      delete root.dataset.feedTransition;
      apply();
    }
  };
  useEffect(() => {
    if (motion.reduced) {
      configSwap.current.animations.forEach(animation => animation.cancel());
      feedTransition.current?.transition.skipTransition();
    }
  }, [motion.reduced]);
  useEffect(() => {
    const finishHidden = () => {
      if (!document.hidden) return;
      configSwap.current.animations.forEach(animation => animation.cancel());
      feedTransition.current?.transition.skipTransition();
    };
    document.addEventListener('visibilitychange', finishHidden);
    return () => {
      document.removeEventListener('visibilitychange', finishHidden);
      cancelFeedNavigation();
      cancelConfigSwap();
    };
  }, []);
  // 冷启动先选角（DL-147）；自动化脚本可用 NOWADAYS_SKIP_ROLE_PICKER 直入工作区。
  const [entered, setEntered] = useState(false);
  const [skipEntry, setSkipEntry] = useState(false);
  // 启动配置读完前不渲染任何页面：避免选角页在跳过模式下闪现一下。
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api-config.json')
      .then(response => (response.ok ? response.json() as Promise<{ skipRolePicker?: boolean }> : null))
      .then(config => { if (live) { setSkipEntry(config?.skipRolePicker === true); setBooted(true); } })
      .catch(() => { if (live) setBooted(true); /* 非桌面壳环境没有这份配置，按正常冷启动处理。 */ });
    return () => { live = false; };
  }, []);
  const [workspaceRequest, setWorkspaceRequest] = useState<{ kind: 'section'; roleId: string; section: 'models'; key: number } | { kind: 'create'; key: number } | null>(null);
  const workspaceRequestSeq = useRef(0);
  const issueWorkspaceRequest = useCallback((req: { kind: 'section'; roleId: string; section: 'models' } | { kind: 'create' }) => {
    setWorkspaceRequest({ ...req, key: ++workspaceRequestSeq.current });
  }, []);
  const handleWorkspaceRequestHandled = useCallback((key: number) => {
    setWorkspaceRequest(prev => (prev?.key === key ? null : prev));
  }, []);
  const [settingsVisited, setSettingsVisited] = useState(false);
  useEffect(() => { if (page === 'settings' || page === 'role-config') setSettingsVisited(true); }, [page]);
  const [hideConversationDock, setHideConversationDock] = useState(() => {
    try { return localStorage.getItem('nowadays-dialogue-hide-dock') === '1'; } catch { return false; }
  });
  const [rolesVisit, setRolesVisit] = useState(0);
  const [roles, setRoles] = useState<RoleListItem[]>();
  const rolesRef = useRef<RoleListItem[]>([]);
  const removedRoles = useRef(new Set<string>());
  const roleListRequest = useRef(0);
  const [roleListError, setRoleListError] = useState('');
  const [retryingRoles, setRetryingRoles] = useState(false);
  const roleRetryToken = useRef(0);
  const [retryingDetail, setRetryingDetail] = useState(false);
  const detailRetry = useRef<string | null>(null);
  const [currentId, setCurrentId] = useState('');
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const [detail, setDetail] = useState<RoleDetail>();
  const [status, setStatus] = useState('');
  const [state, setState] = useState<Record<string, unknown>>({});
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [detailError, setDetailError] = useState('');
  const error = roleListError || detailError;
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  const stateGate = useRef(createStateVersionGate());
  const applySnapshot = useCallback((roleId: string, result: RoleStateResponse, wardrobe: Outfit[]) => {
    if (!stateGate.current.accept(roleId, result.stateVersion)) return false;
    setState(result.state);
    setOutfits(wardrobe);
    const data = result.state;
    const value = data.moodSummary || data.note || data.mood;
    setStatus(typeof value === 'string' ? value : '');
    return true;
  }, []);
  const refresh = useCallback(async (preferred?: string) => {
    const request = ++roleListRequest.current;
    try {
      const list = await api<{items: RoleListItem[]}>('/v1/roles');
      if (request !== roleListRequest.current) return;
      const items = list.items.filter(role => !removedRoles.current.has(role.roleId));
      rolesRef.current = items;
      setRoles(items);
      setRoleListError('');
      setCurrentId(previous => items.some(r => r.roleId === (preferred || previous)) ? (preferred || previous) : (items[0]?.roleId || ''));
      setRevision(value => value + 1);
    } catch (e) { if (request === roleListRequest.current) setRoleListError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const retryRoles = useCallback(async () => {
    const token = ++roleRetryToken.current;
    setRetryingRoles(true);
    try { await refresh(); } finally { if (token === roleRetryToken.current) setRetryingRoles(false); }
  }, [refresh]);
  const retryDetail = useCallback(async () => {
    if (roleListError) { await retryRoles(); return; }
    if (!currentId) return;
    requestId.current += 1;
    detailRetry.current = currentId;
    setRetryingDetail(true);
    setRevision(value => value + 1);
  }, [currentId, roleListError, retryRoles]);
  const removeRoleLocally = useCallback((roleId: string) => {
    removedRoles.current.add(roleId);
    roleListRequest.current += 1;
    const remaining = rolesRef.current.filter(role => role.roleId !== roleId);
    rolesRef.current = remaining;
    setRoles(remaining);
    setCurrentId(previous => previous === roleId ? (remaining[0]?.roleId || '') : previous);
    // 作废删除前发起的详情请求与轮询结果。
    if (detailRetry.current === roleId) { detailRetry.current = null; setRetryingDetail(false); }
    if (currentIdRef.current === roleId) {
      requestId.current += 1;
      stateGate.current.activate('');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const prevRoleId = useRef('');
  const [appearanceRoleId, setAppearanceRoleId] = useState<string | null>(null);
  const appearanceLoading = Boolean(currentId) && appearanceRoleId !== currentId;
  useEffect(() => {
    const request = ++requestId.current;
    const roleChanged = prevRoleId.current !== currentId;
    prevRoleId.current = currentId;
    stateGate.current.activate(currentId);
    if (roleChanged) {
      setDetail(undefined); setStatus(''); setState({}); setOutfits([]); setDetailError('');
    }
    if (detailRetry.current && detailRetry.current !== currentId) {
      detailRetry.current = null;
      setRetryingDetail(false);
    }
    if (!currentId) return;
    Promise.all([
      api<RoleDetail>(`/v1/roles/${encodeURIComponent(currentId)}`),
      api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(currentId)}/state`),
      api<{items: Outfit[]}>(`/v1/roles/${encodeURIComponent(currentId)}/appearance/outfits`)
    ]).then(([role, result, wardrobe]) => {
      if (request !== requestId.current) return;
      setDetail(role);
      applySnapshot(currentId, result, wardrobe.items);
      setAppearanceRoleId(currentId);
      setDetailError('');
      if (detailRetry.current === currentId) { detailRetry.current = null; setRetryingDetail(false); }
    }).catch(e => {
      if (request !== requestId.current) return;
      setAppearanceRoleId(currentId);
      setDetailError(e instanceof Error ? e.message : String(e));
      if (detailRetry.current === currentId) { detailRetry.current = null; setRetryingDetail(false); }
    });
  }, [currentId, revision, applySnapshot]);
  useEffect(() => {
    if (!currentId) return;
    const roleId = currentId;
    let active = true;
    let syncing = false;
    const sync = async () => {
      if (document.hidden || syncing) return;
      syncing = true;
      try {
        const [result, wardrobe] = await Promise.all([
          api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`),
          api<{items: Outfit[]}>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`)
        ]);
        if (!active) return;
        applySnapshot(roleId, result, wardrobe.items);
      } catch {
        // 后台刷新失败时保留当前画面。
      } finally {
        syncing = false;
      }
    };
    const onVisible = () => { if (!document.hidden) void sync(); };
    const timer = window.setInterval(() => { void sync(); }, 5000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [currentId]);
  useEffect(() => {
    scope.cancelAll();
    const element = pageBody.current;
    if (!element || page === 'home' || page === 'role-config' || page === 'settings' || motion.reduced) return;
    scope.run(element, [{ opacity: .35, transform: `translateY(${readMotionPx(element, '--nd-component-motion-page-offset', 4)}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: readMotionTime(element, '--nd-component-motion-page', 360), easing: readMotionValue(element, '--nd-component-motion-ease', 'cubic-bezier(0.2, 0.8, 0.2, 1)'), slot: 'page', fill: 'backwards' });
    return () => scope.cancelAll();
  }, [page, motion.reduced, scope]);
  const accounts = roles ? { accounts: roles.map(r => ({ accountId: r.roleId, nickname: r.displayName, signature: r.roleId === currentId ? status : '' })) } : undefined;
  const currentOutfit = outfits.find(outfit => outfit.outfitId === state.outfitId) ?? null;
  const outfitHomeUrl = currentOutfit?.home ? appearanceAssetUrl(currentId, currentOutfit.home.assetId) : null;
  const seat = roles?.find(role => role.isBuiltin && role.status === 'ready');
  const dockHidden = page === 'conversation' && hideConversationDock;
  const setConversationDockHidden = (hidden: boolean) => {
    setHideConversationDock(hidden);
    try { localStorage.setItem('nowadays-dialogue-hide-dock', hidden ? '1' : '0'); } catch { /* 本地偏好不可写时仅保留本次设置。 */ }
  };
  if (!booted) {
    return <UiThemeScope theme="xiacheng" preset={preset}><div className="studio-boot" role="status">正在打开书房…</div></UiThemeScope>;
  }
  if (!skipEntry && needsEntryPick({ loading: !roles && !error, roles, entered, error })) {
    return <RoleEntry
      roles={roles || []}
      loading={!roles && !error}
      error={error}
      errorSource={roleListError ? 'list' : 'details'}
      retrying={retryingRoles || retryingDetail} onRetry={() => void retryDetail()}
      onEnter={roleId => { setCurrentId(roleId); setEntered(true); setPage('home'); }}
      onCreate={() => { issueWorkspaceRequest({ kind: 'create' }); setEntered(true); setPage('role-config'); }}
    />;
  }
  return <div className="studio-shell" data-ui-palette="xiacheng" data-ui-preset={preset} data-page={page} data-dialogue-dock-hidden={dockHidden || undefined}>
    <UiThemeScope theme="xiacheng" className="studio-header-scope"><header className="studio-header">
      <ControlButton className="ui-studio-brand" aria-label="返回主页" onClick={() => navigate('home')}><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></ControlButton>
      <ThemeSwitcher/>
      {page === 'role-config' || page === 'settings' || page === 'feed' ? <div className="studio-header-actions">
        <ControlButton className="config-motion-toggle" aria-pressed={motion.reduced} aria-label="减少动效" title="减少动效"
          onClick={() => motion.select(motion.reduced ? 'full' : 'reduced')}><Icon name="tune" size={13}/><span>减少动效</span></ControlButton>
      </div> : <div className="studio-header-actions" aria-hidden="true"/>}
    </header></UiThemeScope>
    <main className="studio-content" tabIndex={-1} aria-label="当前页面内容"><UiThemeProvider theme="xiacheng">
      <div ref={pageBody} className={page === 'home' ? 'studio-home-content' : page === 'roles' ? 'studio-relations-content' : page === 'conversation' ? 'studio-conversation-content' : page === 'feed' ? 'studio-feed-content' : 'studio-legacy-page'}>
        {page === 'home' && <UiThemeScope theme="xiacheng"><HomePage accounts={accounts} selectedAccountId={currentId} outfitHomeUrl={outfitHomeUrl} outfitName={currentOutfit?.name ?? null} loading={!roles && !error} error={error} retrying={retryingRoles || retryingDetail} onRetry={retryDetail} onGoWorkbench={() => navigate('roles')} onCreateRole={() => navigate('role-config', () => issueWorkspaceRequest({ kind: 'create' }))}/></UiThemeScope>}
        {page === 'extensions' && <ExtensionsPage state={extensions}/>}
        {page === 'roles' && <Relations roles={roles || []} error={error} currentId={currentId} visit={rolesVisit} onSelect={setCurrentId} onOpenSettings={() => navigate('role-config')}/>}
        {page === 'conversation' && <ConversationPage roles={roles || []} currentId={currentId} currentOutfit={currentOutfit} outfits={outfits} outfitHomeUrl={outfitHomeUrl} appearanceLoading={appearanceLoading} loading={!roles && !error} error={error} hideDock={hideConversationDock} onHideDockChange={setConversationDockHidden} onSelectRole={id => { setCurrentId(id); setConversationTarget(null); }} onOpenRelations={() => navigate('roles')} onConfigureModel={() => navigate('role-config', () => issueWorkspaceRequest({ kind: 'section', roleId: currentId, section: 'models' }))} onCreateRole={() => navigate('role-config', () => issueWorkspaceRequest({ kind: 'create' }))} onRoleStateChanged={() => { void refresh(); }} initialTarget={conversationTarget} onVisibleWindow={setVisibleWindow} onTargetHandled={handleConversationTarget} onReturnFeed={conversationFromFeed ? () => navigateFeedChat('feed') : undefined}/>}
        {(page === 'feed' || feedVisited) && <div className="feed-mounted" hidden={page !== 'feed'}><FeedPage active={page === 'feed'} roles={roles || []} rolesLoading={!roles && !roleListError} roleError={roleListError} retryingRoles={retryingRoles} onRetryRoles={() => void retryRoles()} onOpenChat={target => navigateFeedChat('conversation', target)}/></div>}
        {settingsVisited && <SettingsWorkspace page={page} roles={roles || []} currentId={currentId} roleListError={roleListError} retryingRoles={retryingRoles} onRetryRoles={() => void retryRoles()} onRoleDeleted={removeRoleLocally} onRefresh={refresh} onNavigate={applyPage} navigationGuard={configGuard} footerLeft={configFooterLeft} footerRight={configFooterRight} workspaceRequest={workspaceRequest} onWorkspaceRequestHandled={handleWorkspaceRequestHandled} onStartConversation={roleId => navigate('conversation', () => setCurrentId(roleId))}/>}
      </div>
    </UiThemeProvider></main>
    {seat && <EngineeringCapsule/>}
    <ExtensionOverlays state={extensions}/>
    {seat && <ShareSlip key={seat.roleId} seat={seat} visibleWindow={page === 'conversation' && currentId === seat.roleId ? visibleWindow : null}
      onOpen={(notice, dismiss) => {
        const open = () => {
          setCurrentId(notice.roleId);
          setConversationTarget(notice);
          setConversationFromFeed(false);
          dismiss();
        };
        if (page === 'conversation') open();
        else navigate('conversation', open);
      }}/>}
    {!dockHidden && <UiThemeScope theme="xiacheng" className="studio-footer-scope"><footer className="studio-footer">
      {page === 'role-config' || page === 'settings' ? <div ref={setConfigFooterLeft} id="config-footer-left" className="config-footer-left"/> : page === 'feed' ? <span/> : <span className="studio-runtime">{error ? '资料暂时无法更新' : roles ? `${roles.length} 位角色` : '正在读取角色…'}</span>}
      <PageDock page={page} onNavigate={next => navigate(next, () => { if (next === 'roles') setRolesVisit(value => value + 1); })}/>{page === 'role-config' || page === 'settings' ? <div ref={setConfigFooterRight} id="config-footer-right" className="config-footer-right"/> : page === 'feed' ? <span/> : <span className="studio-edition">开发版</span>}
    </footer></UiThemeScope>}
  </div>;
}
