import { BrandMark, CancelButton, ControlButton, Modal, UiThemeProvider, UiThemeScope } from './ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  appVersion,
  hasToken,
  subscribeEvents,
  type StreamStatus
} from './api';
import { usePoll } from './hooks';
import type {
  AccountsResponse,
  ArtifactsResponse,
  InjectionResumeResponse,
  InjectionRuntimeResponse,
  InjectionSettingsResponse,
  ProvidersResponse,
  SlotsResponse,
  StreamEvent
} from './types';
import { AccountsPage } from './pages/Accounts';
import { ActivityPage } from './pages/Activity';
import { ArtifactsPage } from './pages/Artifacts';
import { ExtensionsPage } from './pages/Extensions';
import { OverviewPage } from './pages/Overview';
import { PolicyPage } from './pages/Policy';
import { SlotsPage } from './pages/Slots';
import { HomePage } from './pages/Home';
import { Icon } from './ui';
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog';
import { useDraftProtection } from './components/DraftProtectionProvider';
import { historyIndex, planHistoryGuard } from './lib/drafts/navigation-history';

import { PAGES } from './lib/navigation';
import { readHomeAccount, type BindingTarget } from './lib/home-presentation';
import { ThemeSwitcher } from './components/shell/ThemeSwitcher';
import { useThemePreset } from './ui/presets';
import { PageDock } from './components/shell/PageDock';

const STREAM_LABELS: Record<StreamStatus, string> = {
  connecting: '事件连接中',
  open: '事件实时',
  retrying: '事件重连中'
};

function pageFromHashValue(hash: string): string {
  const id = hash.replace(/^#\/?/, '');
  const legacy: Record<string, string> = {
    slots: 'instances',
    accounts: 'roles',
    policy: 'model-config',
    tasks: 'model-config',
    models: 'overview',
    settings: 'overview',
    messages: 'overview'
  };
  if (legacy[id]) return legacy[id]!;
  return PAGES.some((page) => page.id === id) ? id : 'home';
}

function pageFromHash(): string {
  return pageFromHashValue(window.location.hash);
}

function isSettingsHashValue(hash: string): boolean {
  const id = hash.replace(/^#\/?/, '');
  return id === 'settings' || id === 'models';
}

function isSettingsHash(): boolean {
  return isSettingsHashValue(window.location.hash);
}

function hashSettingsTab(): SettingsTab {
  return 'models';
}

function legacyHashNoticeValue(hash: string): string | undefined {
  const id = hash.replace(/^#\/?/, '');
  if (id === 'messages') return '聊天历史与人工发送页面已移除。消息仍按账号与会话隔离保存；请从总览或事件诊断查看当前运行状态。';
  if (id === 'tasks') return '任务媒体历史页面已移除；当前模型配置页只管理账号服务与能力，插件、工具授权和 Skill 在“插件与Skill”页管理。';
  return undefined;
}

function legacyHashNotice(): string | undefined {
  return legacyHashNoticeValue(window.location.hash);
}

function urlForPage(page: string): string {
  const url = new URL(window.location.href);
  url.hash = `#/${page}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

function historyState(index: number): Record<string, unknown> {
  const current = window.history.state;
  return { ...(current && typeof current === 'object' ? current : {}), __nowadaysIndex: index };
}

export function App() {
  const { preset } = useThemePreset();
  const [page, setPage] = useState(pageFromHash);
  const pageRef = useRef(page);
  const contentRef = useRef<HTMLElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(isSettingsHash);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(hashSettingsTab);
  const [legacyNotice, setLegacyNotice] = useState(legacyHashNotice);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [focusDisplay, setFocusDisplay] = useState<{ accountId: string; requestId: number }>();
  const [focusBinding,setFocusBinding] = useState<BindingTarget>();
  const [selectedHomeAccount,setSelectedHomeAccount] = useState(readHomeAccount);
  const selectedHomeRef = useRef(selectedHomeAccount);
  selectedHomeRef.current = selectedHomeAccount;
  const [transitionNotice, setTransitionNotice] = useState<string>();
  const [quitPhase, setQuitPhase] = useState<'idle' | 'checking' | 'approved'>('idle');
  const focusRequestId = useRef(0);
  const lastCommitted = useRef({ index: 0, url: '', page: pageRef.current });
  const settingsOpenRef = useRef(settingsOpen);
  const quitPhaseRef = useRef(quitPhase);
  const quitRequestIdRef = useRef<string | undefined>(undefined);
  const pendingHistory = useRef<{ targetHash: string; delta?: number; kind: 'compensate' | 'restore' } | undefined>(undefined);
  const compensatingHistory = useRef(false);
  const replayHash = useRef<string | undefined>(undefined);
  const handleLocationRef = useRef<() => void>(() => {});
  const { registry, requestTransition, transitionPending } = useDraftProtection();

  const slots = usePoll<SlotsResponse>(hasToken ? '/slots' : null, 3000);
  const accounts = usePoll<AccountsResponse>(hasToken ? '/accounts?avatars=1' : null, 8000);
  const accountsRef = useRef(accounts.data);
  accountsRef.current = accounts.data;
  useEffect(()=>{
    if(!selectedHomeRef.current && accounts.data?.accounts.length) {
      selectedHomeRef.current=accounts.data.accounts[0]!.accountId;
      setSelectedHomeAccount(selectedHomeRef.current);
    }
  },[accounts.data]);
  const artifacts = usePoll<ArtifactsResponse>(hasToken ? '/artifacts' : null, 15000);
  const providers = usePoll<ProvidersResponse>(hasToken ? '/providers' : null, 8000);
  const injectionSettings = usePoll<InjectionSettingsResponse>(hasToken ? '/injection/settings' : null, 15000);
  const injectionRuntime = usePoll<InjectionRuntimeResponse>(hasToken ? '/injection/runtime' : null, 5000);
  const resumeKey = useRef<string | undefined>(undefined);
  const resumeEnabled = injectionSettings.data?.settings.resumeLastListen === true;
  const runtimeStatus = injectionRuntime.data?.runtime;

  useEffect(() => {
    if (!resumeEnabled || !runtimeStatus?.running) {
      resumeKey.current = undefined;
      return;
    }
    const key = `${runtimeStatus.baseUrl ?? ''}|${runtimeStatus.version ?? ''}`;
    if (resumeKey.current === key) return;
    resumeKey.current = key;
    void api<InjectionResumeResponse>('/injection/resume', { method: 'POST' })
      .then((result) => {
        if (result.resumed.length > 0) void slots.refresh();
      })
      .catch(() => {
        resumeKey.current = undefined;
      });
  }, [resumeEnabled, runtimeStatus?.running, runtimeStatus?.baseUrl, runtimeStatus?.version, slots.refresh]);

  useEffect(() => {
    if (!hasToken) return;
    return subscribeEvents(
      (event) => {
        setEvents((current) => {
          const next = [...current, event];
          return next.length > 400 ? next.slice(-400) : next;
        });
      },
      setStreamStatus
    );
  }, []);

  const current = PAGES.find((item) => item.id === page) ?? PAGES[0]!;
  const isPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview')==='1';
  const activeHomeAccount = selectedHomeAccount || accounts.data?.accounts[0]?.accountId || '';
  const onlineCount = (slots.data?.slots ?? []).filter((instance) => instance.state === 'online' && instance.connected).length;

  useEffect(() => {
    pageRef.current = page;
    document.title = `${current.title} · Nowadays`;
  }, [current.title]);

  useEffect(() => {
    if (page === 'overview' || page === 'instances') void slots.refresh();
    if (page === 'overview' || page === 'roles' || page === 'plugins' || page === 'model-config') void accounts.refresh();
    if (page === 'overview' || page === 'roles' || page === 'plugins' || page === 'artifacts') void artifacts.refresh();
    if (settingsOpen || page === 'model-config' || page === 'overview') void providers.refresh();
  }, [page, settingsOpen, slots.refresh, accounts.refresh, artifacts.refresh, providers.refresh]);

  const navigate = async (next: string, options: { focusAccountId?: string; focusBinding?: BindingTarget } = {}): Promise<void> => {
    if (quitPhaseRef.current !== 'idle') return;
    if (next === 'settings') {
      openSettings('snowluma');
      return;
    }
    if (next === pageRef.current && !options.focusAccountId) {
      contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const result = await requestTransition({ scope: transitionScope(), actionLabel: '切换页面' });
    if (!result.ok) {
      if (result.message) setTransitionNotice(result.message);
      return;
    }
    if(quitPhaseRef.current!=='idle')return;
    if(options.focusAccountId&&!accountsRef.current?.accounts.some(account=>account.accountId===options.focusAccountId)) {
      setTransitionNotice('目标账号已不在当前列表中，请重新选择。'); return;
    }
    applyRoute(next, { push: next!==pageRef.current, focusAccountId: options.focusAccountId, focusBinding:options.focusBinding });
  };

  const transitionScope = (): { kind: 'page' } | { kind: 'all' } =>
    settingsOpenRef.current ? { kind: 'all' } : { kind: 'page' };

  const applyRoute = (next: string, options: { push?: boolean; index?: number; focusAccountId?: string; focusBinding?: BindingTarget; notice?: string } = {}): void => {
    const url = urlForPage(next);
    let index = options.index;
    if (index === undefined) {
      if (options.push) {
        index = lastCommitted.current.index + 1;
        window.history.pushState(historyState(index), '', url);
      } else {
        index = lastCommitted.current.index;
        window.history.replaceState(historyState(index), '', url);
      }
    } else {
      window.history.replaceState(historyState(index), '', url);
    }
    lastCommitted.current = { index, url, page: next };
    settingsOpenRef.current = false;
    if (options.focusAccountId) {
      focusRequestId.current += 1;
      setFocusDisplay({ accountId: options.focusAccountId, requestId: focusRequestId.current });
    } else if (next !== 'roles') {
      setFocusDisplay(undefined);
    }
    pageRef.current = next;
    setPage(next);
    setSettingsOpen(false);
    setLegacyNotice(options.notice);
    setTransitionNotice(undefined);
    setFocusBinding(options.focusBinding);
    contentRef.current?.scrollTo({ top: 0 });
  };

  const requestHistoryTransition = async (pending: { targetHash: string; delta?: number; kind: 'compensate' | 'restore' }): Promise<void> => {
    const next = pageFromHashValue(pending.targetHash);
    const result = await requestTransition({ scope: transitionScope(), actionLabel: '切换页面' });
    if (!result.ok) {
      if (result.message) setTransitionNotice(result.message);
      return;
    }
    if (pending.kind === 'compensate' && pending.delta !== undefined) {
      replayHash.current = pending.targetHash;
      window.history.go(-pending.delta);
    } else {
      applyRoute(next, { push: true, notice: legacyHashNoticeValue(pending.targetHash) });
    }
  };

  const handleLocationChange = async (): Promise<void> => {
    const targetHash = window.location.hash;
    if (quitPhaseRef.current !== 'idle') {
      window.history.replaceState(historyState(lastCommitted.current.index), '', lastCommitted.current.url);
      return;
    }
    if (isSettingsHashValue(targetHash)) {
      window.history.replaceState(historyState(lastCommitted.current.index), '', lastCommitted.current.url);
      setSettingsTab(hashSettingsTab());
      setSettingsOpen(true);
      settingsOpenRef.current = true;
      return;
    }
    if (replayHash.current === targetHash) {
      replayHash.current = undefined;
      applyRoute(pageFromHashValue(targetHash), {
        index: historyIndex(window.history.state) ?? lastCommitted.current.index,
        notice: legacyHashNoticeValue(targetHash)
      });
      return;
    }
    if (compensatingHistory.current) {
      compensatingHistory.current = false;
      const pending = pendingHistory.current;
      pendingHistory.current = undefined;
      if (pending) await requestHistoryTransition(pending);
      return;
    }
    if (targetHash === new URL(lastCommitted.current.url, window.location.href).hash) return;
    if (transitionPending()) {
      window.history.replaceState(historyState(lastCommitted.current.index), '', lastCommitted.current.url);
      return;
    }
    const next = pageFromHashValue(targetHash);
    if (next === pageRef.current && !settingsOpenRef.current) {
      window.history.replaceState(historyState(lastCommitted.current.index), '', lastCommitted.current.url);
      return;
    }
    const plan = planHistoryGuard(lastCommitted.current.index, historyIndex(window.history.state));
    if (plan.kind === 'compensate') {
      pendingHistory.current = { targetHash, delta: plan.delta, kind: 'compensate' };
      compensatingHistory.current = true;
      window.history.go(plan.delta);
      return;
    }
    pendingHistory.current = { targetHash, kind: 'restore' };
    window.history.replaceState(historyState(lastCommitted.current.index), '', lastCommitted.current.url);
    await requestHistoryTransition(pendingHistory.current);
  };

  handleLocationRef.current = () => { void handleLocationChange(); };
  settingsOpenRef.current = settingsOpen;
  quitPhaseRef.current = quitPhase;

  useEffect(() => {
    const initialPage = pageRef.current;
    const settingsHash = isSettingsHash();
    const canonical = settingsHash || window.location.hash !== `#/${initialPage}` ? urlForPage(initialPage) : window.location.href;
    const index = historyIndex(window.history.state) ?? 0;
    window.history.replaceState(historyState(index), '', canonical);
    lastCommitted.current = { index, url: canonical, page: initialPage };
    if (settingsHash) {
      setSettingsTab(hashSettingsTab());
      setSettingsOpen(true);
      settingsOpenRef.current = true;
    }
    const onHash = (): void => handleLocationRef.current();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (quitPhaseRef.current === 'approved') return;
      if (!registry.hasPending()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [registry]);

  useEffect(() => {
    const bridge = window.nowadays ?? window.accompany;
    if (!bridge?.onQuitCheck) return;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let confirmation: AbortController | undefined;
    const isApproved = (): boolean => quitPhaseRef.current === 'approved';
    const stopHeartbeat = (): void => { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined; };
    const reset = (requestId: string): void => {
      if (quitRequestIdRef.current !== requestId) return;
      stopHeartbeat();
      confirmation?.abort();
      quitRequestIdRef.current = undefined;
      quitPhaseRef.current = 'idle';
      setQuitPhase('idle');
    };
    const approve = (): void => {
      stopHeartbeat();
      confirmation?.abort();
      quitPhaseRef.current = 'approved';
      setQuitPhase('approved');
    };
    const offState = bridge.onQuitState?.(({ requestId, state }) => {
      // A native fallback may approve after the original request was invalidated.
      if (state === 'shuttingDown') approve();
      else reset(requestId);
    });
    const offCheck = bridge.onQuitCheck(({ requestId }) => {
      void (async () => {
        if (quitPhaseRef.current !== 'idle') {
          await bridge.respondQuit?.(requestId, false).catch(() => undefined);
          return;
        }
        quitRequestIdRef.current = requestId;
        quitPhaseRef.current = 'checking';
        setQuitPhase('checking');
        confirmation = new AbortController();
        const acked = bridge.ackQuit ? await bridge.ackQuit(requestId).catch(() => false) : false;
        if (!acked || quitRequestIdRef.current !== requestId) {
          reset(requestId);
          return;
        }
        heartbeat = setInterval(() => {
          void bridge.keepQuitAlive?.(requestId).then((alive) => {
            if (!alive && quitPhaseRef.current !== 'approved') reset(requestId);
          }).catch(() => {
            if (quitPhaseRef.current !== 'approved') reset(requestId);
          });
        }, 2_000);
        let allowed = false;
        try {
          const result = await requestTransition({
            scope: { kind: 'all' },
            actionLabel: '退出应用',
            title: '退出 Nowadays？',
            confirmLabel: '放弃修改并退出',
            discardOnAccept: false,
            signal: confirmation.signal
          });
          allowed = result.ok;
          if (!result.ok && result.message) setTransitionNotice(result.message);
        } catch {
          allowed = false;
        }
        // 请求已被主进程作废（失联兜底等）时，迟到的决策不再放行。
        if (quitRequestIdRef.current !== requestId || isApproved()) return;
        const accepted = await bridge.respondQuit?.(requestId, allowed).catch(() => false);
        // The main state notification is authoritative if the IPC reply was lost.
        if (isApproved()) return;
        if (allowed && accepted === true) approve();
        else {
          reset(requestId);
          if (allowed) setTransitionNotice('退出请求未被接受，请重试。');
        }
      })();
    });
    return () => { stopHeartbeat(); confirmation?.abort(); offCheck(); offState?.(); };
  }, [requestTransition]);

  const openSettings = (tab: SettingsTab = settingsTab): void => {
    if (quitPhaseRef.current !== 'idle') return;
    setSettingsTab(tab);
    setSettingsOpen(true);
    settingsOpenRef.current = true;
  };

  const goAccountModels = async (): Promise<void> => {
    if (quitPhaseRef.current !== 'idle') return;
    const result = await requestTransition({ scope: { kind: 'all' }, actionLabel: '前往账号模型配置' });
    if (quitPhaseRef.current !== 'idle') return;
    if (!result.ok) {
      if (result.message) setTransitionNotice(result.message);
      return;
    }
    applyRoute('model-config', { push: pageRef.current !== 'model-config' });
  };

  const goPage = (next:string):void => { void navigate(next,next==='roles'&&accounts.data?.accounts.some(account=>account.accountId===selectedHomeAccount)?{focusAccountId:selectedHomeAccount}:{}); };

  if (!hasToken) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <img src="/nowadays-icon.png" alt="" width={56} height={56} />
          <h1>未获得本地访问令牌</h1>
          <p>
            桌面界面必须由 Electron 主进程打开，token 会通过 preload 注入。浏览器调试时可以在地址后追加
            <code>?token=&lt;token&gt;</code>。
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="studio-shell" data-ui-palette="xiacheng" data-ui-preset={preset} data-page={page} inert={quitPhase !== 'idle' || undefined}>
      <UiThemeScope theme="xiacheng" className="studio-header-scope">
      <ControlButton className="ui-skip-content" onClick={() => contentRef.current?.focus()}>跳到主内容</ControlButton>
      <header className="studio-header">
        <ControlButton className="ui-studio-brand" aria-label="Nowadays，返回主页" onClick={()=>goPage('home')}><BrandMark/><span>Nowadays<small>{isPreview?'隔离界面预览 / 样例数据':'A NOTE FOR YOUR EVERYDAY.'}</small></span></ControlButton>
        <ThemeSwitcher disabled={quitPhase!=='idle'}/>
        <div className="studio-header-actions"><ControlButton className="ui-settings-launcher" aria-label="应用设置" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={()=>openSettings()}><Icon name="settings" size={20}/></ControlButton></div>
      </header>
      </UiThemeScope>
        <main className="studio-content" ref={contentRef} tabIndex={-1} aria-label="当前页面内容">
          <UiThemeScope theme="xiacheng" className="studio-notices">
          {legacyNotice ? <div className="notice legacy-route-notice" role="status"><span>{legacyNotice}</span><CancelButton size="sm" onClick={() => setLegacyNotice(undefined)}>关闭</CancelButton></div> : null}
          {transitionNotice ? <div className="notice notice-warn" role="status"><span>{transitionNotice}</span><CancelButton size="sm" onClick={() => setTransitionNotice(undefined)}>关闭</CancelButton></div> : null}
          </UiThemeScope>
          <UiThemeProvider theme={page==='home'?'xiacheng':undefined}>
          <div className={page==='home'?'studio-home-content':'studio-legacy-page'}>
          {page!=='home'?<header className="studio-page-heading"><h1>{current.title}</h1><p>{current.subtitle}</p></header>:null}
          {page === 'home' ? (
            <UiThemeScope theme="xiacheng">
            <HomePage
              accounts={accounts.data}
              selectedAccountId={activeHomeAccount}
              loading={accounts.loading}
              error={accounts.error}
              locked={quitPhase!=='idle'}
              onRetry={accounts.refresh}
              onGoWorkbench={()=>goPage('overview')}
            />
            </UiThemeScope>
          ) : null}
          {page === 'overview' ? (
            <OverviewPage
              slots={slots.data}
              slotsLoading={slots.loading}
              slotsError={slots.error}
              onNavigate={navigate}
              refreshSlots={slots.refresh}
            />
          ) : null}
          {page === 'instances' ? (
            <SlotsPage
              data={slots.data}
              error={slots.error}
              refresh={slots.refresh}
              onSettings={() => navigate('settings')}
            />
          ) : null}
          {page === 'roles' ? (
            <AccountsPage
              locked={quitPhase !== 'idle'}
              accounts={accounts.data}
              accountsLoading={accounts.loading}
              accountsError={accounts.error}
              artifacts={artifacts.data}
              artifactsLoading={artifacts.loading}
              artifactsError={artifacts.error}
              refresh={async () => {
                await Promise.all([accounts.refresh(), slots.refresh()]);
              }}
              onRetryArtifacts={artifacts.refresh}
              onGoSlots={() => navigate('instances')}
              onGoArtifacts={() => navigate('artifacts')}
              focusDisplay={focusDisplay}
              focusBinding={focusBinding}
              onFocusBindingHandled={()=>setFocusBinding(undefined)}
              onFocusDisplayHandled={() => setFocusDisplay(undefined)}
            />
          ) : null}
          {page === 'plugins' ? (
            <ExtensionsPage
              locked={quitPhase !== 'idle'}
              accounts={accounts.data}
              accountsLoading={accounts.loading}
              accountsError={accounts.error}
              artifacts={artifacts.data}
              artifactsLoading={artifacts.loading}
              artifactsError={artifacts.error}
              refresh={async () => {
                await Promise.all([accounts.refresh(), slots.refresh()]);
              }}
              onRetryArtifacts={artifacts.refresh}
              onGoSlots={() => navigate('instances')}
            />
          ) : null}
          {page === 'model-config' ? (
            <PolicyPage
              initialAccountId={activeHomeAccount}
              providers={providers.data}
              providersLoading={providers.loading}
              providersError={providers.error}
              accounts={accounts.data}
              accountsLoading={accounts.loading}
              accountsError={accounts.error}
              slots={slots.data}
              slotsLoading={slots.loading}
              slotsError={slots.error}
              onGoModels={() => openSettings('models')}
              onGoConnections={() => navigate('instances')}
              onRetryAccounts={accounts.refresh}
              onRetrySlots={slots.refresh}
              onRetryProviders={providers.refresh}
            />
          ) : null}
          {page === 'artifacts' ? (
            <ArtifactsPage accounts={accounts.data} data={artifacts.data} loading={artifacts.loading} error={artifacts.error} refresh={artifacts.refresh} locked={quitPhase !== 'idle'} />
          ) : null}
          {page === 'diagnostics' ? (
            <ActivityPage events={events} status={streamStatus} onClear={() => setEvents([])} />
          ) : null}
          </div>
          </UiThemeProvider>
        </main>
      <UiThemeScope theme="xiacheng" className="studio-footer-scope"><footer className="studio-footer">
        <span className="studio-runtime">{slots.error?'连接状态待更新':!slots.data?'正在读取连接':`${onlineCount} 个实例已连接`} · {STREAM_LABELS[streamStatus]}</span>
        <PageDock page={page} onNavigate={goPage}/>
        <span className="studio-edition">CHARACTER STUDIO / {appVersion==='dev'?'开发版':`v${appVersion}`}</span>
      </footer></UiThemeScope>
      <UiThemeProvider>
      <SettingsDialog
        open={settingsOpen}
        locked={quitPhase !== 'idle'}
        initialTab={settingsTab}
        onTabChange={setSettingsTab}
        onGoAccountModels={() => void goAccountModels()}
        onRequestClose={() => { if (quitPhaseRef.current !== 'idle') return; settingsOpenRef.current = false; setSettingsOpen(false); }}
        providers={providers.data}
        providersError={providers.error}
        refreshProviders={providers.refresh}
      />
      </UiThemeProvider>
      </div>
      <Modal open={quitPhase === 'approved'} title="正在安全退出" className="quit-dialog" closeDisabled onClose={() => {}}>
        <p role="status" aria-live="polite">正在释放运行资源，请稍候…</p>
      </Modal>
    </>
  );
}
