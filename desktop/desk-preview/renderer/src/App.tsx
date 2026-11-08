import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { RoleDetail, RoleListItem } from './types';
import { BrandMark, Button, ControlButton, Icon, UiThemeProvider, UiThemeScope, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy } from './ui';
import { useThemePreset } from './ui/presets';
import { ThemeSwitcher } from './components/shell/ThemeSwitcher';
import { PageDock } from './components/shell/PageDock';
import { HomePage } from './pages/Home';
import { Relations } from './Relations';

export function App() {
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  const [scope] = useState(createMotionScope);
  const pageBody = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState('home');
  const [roles, setRoles] = useState<RoleListItem[]>();
  const [currentId, setCurrentId] = useState('');
  const [detail, setDetail] = useState<RoleDetail>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  const refresh = useCallback(async (preferred?: string) => {
    try {
      const list = await api<{items: RoleListItem[]}>('/v1/roles');
      setRoles(list.items);
      setError('');
      setCurrentId(previous => list.items.some(r => r.roleId === (preferred || previous)) ? (preferred || previous) : (list.items[0]?.roleId || ''));
      setRevision(value => value + 1);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const request = ++requestId.current;
    setDetail(undefined); setStatus('');
    if (!currentId) return;
    Promise.all([api<RoleDetail>(`/v1/roles/${encodeURIComponent(currentId)}`), api<{state: Record<string, unknown>}>(`/v1/roles/${encodeURIComponent(currentId)}/state`)]).then(([role, result]) => {
      if (request !== requestId.current) return;
      setDetail(role);
      const data = result.state;
      const value = data.moodSummary || data.note || data.mood;
      setStatus(typeof value === 'string' ? value : '');
    }).catch(e => { if (request === requestId.current) setError(e instanceof Error ? e.message : String(e)); });
  }, [currentId, revision]);
  useEffect(() => {
    scope.cancelAll();
    const element = pageBody.current;
    if (!element || page === 'home' || motion.reduced) return;
    scope.run(element, [{ opacity: .35, transform: `translateY(${readMotionPx(element, '--nd-component-motion-page-offset', 4)}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: readMotionTime(element, '--nd-component-motion-page', 280), easing: readMotionValue(element, '--nd-component-motion-ease', 'cubic-bezier(0.2, 0, 0, 1)'), slot: 'page', fill: 'backwards' });
    return () => scope.cancelAll();
  }, [page, motion.reduced, scope]);
  const accounts = roles ? { accounts: roles.map(r => ({ accountId: r.roleId, nickname: r.displayName, signature: r.roleId === currentId ? status : '' })) } : undefined;
  return <div className="studio-shell" data-ui-palette="xiacheng" data-ui-preset={preset} data-page={page}>
    <UiThemeScope theme="xiacheng" className="studio-header-scope"><header className="studio-header">
      <ControlButton className="ui-studio-brand" aria-label="返回主页" onClick={() => setPage('home')}><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></ControlButton>
      <ThemeSwitcher/>
      <div className="studio-header-actions"><ControlButton className="ui-settings-launcher" aria-label="应用设置" onClick={() => setPage('settings')}><Icon name="settings" size={20}/></ControlButton></div>
    </header></UiThemeScope>
    <main className="studio-content" tabIndex={-1} aria-label="当前页面内容"><UiThemeProvider theme="xiacheng">
      <div ref={pageBody} className={page === 'home' ? 'studio-home-content' : page === 'roles' ? 'studio-relations-content' : 'studio-legacy-page'}>
        {page === 'home' && <UiThemeScope theme="xiacheng"><HomePage accounts={accounts} selectedAccountId={currentId} loading={!roles && !error} error={error} onRetry={() => refresh()} onGoWorkbench={() => setPage('roles')}/></UiThemeScope>}
        {page === 'roles' && <Relations roles={roles || []} detail={detail} status={status} error={error} currentId={currentId} onSelect={setCurrentId} onRefresh={refresh}/>}
        {page === 'conversation' && <header className="studio-page-heading"><h1>对话</h1><p>这里会收留你们的对话。</p></header>}
        {page === 'settings' && <header className="studio-page-heading"><h1>设置</h1><p>这里会收纳应用设置。</p></header>}
      </div>
    </UiThemeProvider></main>
    <UiThemeScope theme="xiacheng" className="studio-footer-scope"><footer className="studio-footer">
      <span className="studio-runtime">{error ? '连接状态待更新' : roles ? `${roles.length} 位角色 · 本地生活空间` : '正在连接'}</span>
      <PageDock page={page} onNavigate={setPage}/><span className="studio-edition">CHARACTER STUDIO / 开发版</span>
    </footer></UiThemeScope>
  </div>;
}
