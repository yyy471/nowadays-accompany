import { CancelButton, ControlButton } from './ui';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  apiBaseUrl,
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
import { OverviewPage } from './pages/Overview';
import { PolicyPage } from './pages/Policy';
import { SlotsPage } from './pages/Slots';
import { HomePage } from './pages/Home';
import { Icon, type IconName } from './ui';
import { SettingsDialog, type SettingsTab } from './components/SettingsDialog';

interface PageDef {
  id: string;
  label: string;
  icon: IconName;
  title: string;
  subtitle: string;
}

const PAGES: PageDef[] = [
  { id: 'home', label: '主页', icon: 'user', title: '主页', subtitle: '展示当前所选账号的本地资料' },
  { id: 'overview', label: '总览', icon: 'overview', title: '总览', subtitle: '检测 QQ 进程，选择账号并开始监听' },
  { id: 'instances', label: '实例与监听', icon: 'slots', title: '实例与监听', subtitle: '检测 QQ 状态；由你明确点击注入与监听' },
  { id: 'roles', label: '资料与角色', icon: 'accounts', title: '资料与角色', subtitle: '按账号、私聊或群聊显式绑定角色卡' },
  { id: 'plugins', label: '插件与Skill', icon: 'package', title: '插件与Skill', subtitle: '维护账号插件资料与可用 Skill' },
  { id: 'model-config', label: '模型配置', icon: 'shield', title: '模型配置', subtitle: '按账号配置五类服务并管理工具授权' },
  { id: 'diagnostics', label: '事件诊断', icon: 'activity', title: '事件诊断', subtitle: '检查本次运行的实例与通道事件' },
  { id: 'artifacts', label: '资源库', icon: 'artifacts', title: '资源库', subtitle: '管理角色卡与插件资源、版本和部署' }
];
const WORKBENCH_PAGES = PAGES.filter((item) => !['home', 'artifacts'].includes(item.id));

const STREAM_LABELS: Record<StreamStatus, string> = {
  connecting: '事件连接中',
  open: '事件实时',
  retrying: '事件重连中'
};

function pageFromHash(): string {
  const id = window.location.hash.replace(/^#\/?/, '');
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

function isSettingsHash(): boolean {
  const id = window.location.hash.replace(/^#\/?/, '');
  return id === 'settings' || id === 'models';
}

function hashSettingsTab(): SettingsTab {
  return 'models';
}

function legacyHashNotice(): string | undefined {
  const id = window.location.hash.replace(/^#\/?/, '');
  if (id === 'messages') return '聊天历史与人工发送页面已移除。消息仍按账号与会话隔离保存；请从总览或事件诊断查看当前运行状态。';
  if (id === 'tasks') return '任务媒体历史页面已移除；当前模型配置页只管理账号服务、能力与工具授权。';
  return undefined;
}

export function App() {
  const [page, setPage] = useState(pageFromHash);
  const pageRef = useRef(page);
  const [settingsOpen, setSettingsOpen] = useState(isSettingsHash);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(hashSettingsTab);
  const [legacyNotice, setLegacyNotice] = useState(legacyHashNotice);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');

  const slots = usePoll<SlotsResponse>(hasToken ? '/slots' : null, 3000);
  const accounts = usePoll<AccountsResponse>(hasToken ? '/accounts?avatars=1' : null, 8000);
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
    if (isSettingsHash()) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/${pageRef.current}`);
    }
    const onHash = (): void => {
      if (isSettingsHash()) {
        setSettingsTab(hashSettingsTab());
        setSettingsOpen(true);
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/${pageRef.current}`);
        return;
      }
      const next = pageFromHash();
      pageRef.current = next;
      setPage(next);
      setSettingsOpen(false);
      setLegacyNotice(legacyHashNotice());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
  const onlineCount = (slots.data?.slots ?? []).filter((instance) => instance.state === 'online').length;
  const isWorkbench = !['home', 'artifacts'].includes(page);

  useEffect(() => {
    pageRef.current = page;
    document.title = `${current.title} · nowadays`;
  }, [current.title]);

  useEffect(() => {
    if (page === 'overview' || page === 'instances') void slots.refresh();
    if (page === 'overview' || page === 'roles' || page === 'plugins' || page === 'model-config') void accounts.refresh();
    if (page === 'overview' || page === 'roles' || page === 'plugins' || page === 'artifacts') void artifacts.refresh();
    if (settingsOpen || page === 'model-config' || page === 'overview') void providers.refresh();
  }, [page, settingsOpen, slots.refresh, accounts.refresh, artifacts.refresh, providers.refresh]);

  const navigate = (next: string): void => {
    if (next === 'settings') {
      openSettings('snowluma');
      return;
    }
    if (next === page) return;
    window.location.hash = `#/${next}`;
    setPage(next);
    pageRef.current = next;
    setSettingsOpen(false);
    setLegacyNotice(undefined);
  };

  const openSettings = (tab: SettingsTab = 'models'): void => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

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
    <div className="app-shell">
      <header className="app-global-header">
        <div className="brand">
          <img src="/nowadays-icon.png" alt="" width={34} height={34} />
          <div>
            <strong>nowadays</strong>
            <span>QQ 注入控制台</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          <ControlButton type="button" className={`primary-nav-item${page === 'home' ? ' active' : ''}`} onClick={() => navigate('home')}>
            <Icon name="user" size={17} /><span>主页</span>
          </ControlButton>
          <ControlButton type="button" className={`primary-nav-item${!['home', 'artifacts'].includes(page) ? ' active' : ''}`} onClick={() => navigate(!['home', 'artifacts'].includes(page) ? page : 'overview')}>
            <Icon name="overview" size={17} /><span>工作台</span>
          </ControlButton>
          <ControlButton type="button" className={`primary-nav-item${page === 'artifacts' ? ' active' : ''}`} onClick={() => navigate('artifacts')}>
            <Icon name="artifacts" size={17} /><span>资源</span>
          </ControlButton>
        </nav>
        <div className="app-global-meta">
          <span className={`stream-pill stream-${streamStatus}`}>
            <span className="stock-dot" />{STREAM_LABELS[streamStatus]}
          </span>
          <span className="online-pill"><strong>{onlineCount}</strong> 个实例在线</span>
          <span className="app-build mono">{appVersion === 'dev' ? 'dev build' : `v${appVersion}`}</span>
        </div>
      </header>

      <div className="app-workarea">
        {isWorkbench ? <aside className="sidebar">
          <nav className="nav" aria-label="工作台页面">
          {WORKBENCH_PAGES.map((item) => (
            <ControlButton
              type="button"
              key={item.id}
              className={`nav-item${item.id === page ? ' active' : ''}`}
              onClick={() => navigate(item.id)}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.id === 'instances' && onlineCount > 0 ? <span className="nav-badge">{onlineCount}</span> : null}
            </ControlButton>
          ))}
          </nav>
          <div className="sidebar-foot">
            <div className={`core-state ${slots.error ? 'is-bad' : 'is-ok'}`}>
              <span className="stock-dot" />
              <span>{slots.error ? '核心不可达' : '核心已连接'}</span>
            </div>
            <span className="muted mono">{apiBaseUrl.replace(/^http:\/\//, '')}</span>
          </div>
        </aside> : null}

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{current.title}</h1>
            <p>{current.subtitle}</p>
          </div>
        </header>

        <main className="content">
          {legacyNotice ? <div className="notice legacy-route-notice" role="status"><span>{legacyNotice}</span><CancelButton size="sm" onClick={() => setLegacyNotice(undefined)}>关闭</CancelButton></div> : null}
          {page === 'home' ? <HomePage accounts={accounts.data} /> : null}
          {page === 'overview' ? (
            <OverviewPage
              slots={slots.data}
              slotsError={slots.error}
              events={events}
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
          {page === 'roles' || page === 'plugins' ? (
            <AccountsPage
              view={page === 'roles' ? 'roles' : 'plugins'}
              accounts={accounts.data}
              accountsError={accounts.error}
              artifacts={artifacts.data}
              refresh={async () => {
                await Promise.all([accounts.refresh(), slots.refresh()]);
              }}
              onGoSlots={() => navigate('instances')}
            />
          ) : null}
          {page === 'model-config' ? (
            <PolicyPage
              providers={providers.data}
              accounts={accounts.data}
              slots={slots.data}
              onGoModels={() => openSettings('models')}
            />
          ) : null}
          {page === 'artifacts' ? (
            <ArtifactsPage data={artifacts.data} error={artifacts.error} refresh={artifacts.refresh} />
          ) : null}
          {page === 'diagnostics' ? (
            <ActivityPage events={events} status={streamStatus} onClear={() => setEvents([])} />
          ) : null}
        </main>
      </div>
      </div>
      <ControlButton type="button" className="global-settings-launcher" onClick={() => openSettings('models')} aria-haspopup="dialog" aria-expanded={settingsOpen}>
        <Icon name="settings" size={17} /><span>设置</span>
      </ControlButton>
      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        onRequestClose={() => setSettingsOpen(false)}
        providers={providers.data}
        providersError={providers.error}
        refreshProviders={providers.refresh}
      />
    </div>
  );
}
