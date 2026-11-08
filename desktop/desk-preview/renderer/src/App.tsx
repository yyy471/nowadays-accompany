import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Outfit, RoleDetail, RoleListItem, RoleStateResponse } from './types';
import { appearanceAssetUrl } from './types';
import { BrandMark, Button, ControlButton, Icon, UiThemeProvider, UiThemeScope, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy } from './ui';
import { useThemePreset } from './ui/presets';
import { ThemeSwitcher } from './components/shell/ThemeSwitcher';
import { PageDock } from './components/shell/PageDock';
import { HomePage } from './pages/Home';
import { Relations } from './Relations';
import { SettingsPage } from './pages/Settings';
import { createStateVersionGate } from './state-version.js';

export function App() {
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  const [scope] = useState(createMotionScope);
  const pageBody = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState('home');
  const [rolesVisit, setRolesVisit] = useState(0);
  const [roles, setRoles] = useState<RoleListItem[]>();
  const [currentId, setCurrentId] = useState('');
  const [detail, setDetail] = useState<RoleDetail>();
  const [status, setStatus] = useState('');
  const [state, setState] = useState<Record<string, unknown>>({});
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [error, setError] = useState('');
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
    stateGate.current.activate(currentId);
    setDetail(undefined); setStatus(''); setState({}); setOutfits([]);
    if (!currentId) return;
    Promise.all([
      api<RoleDetail>(`/v1/roles/${encodeURIComponent(currentId)}`),
      api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(currentId)}/state`),
      api<{items: Outfit[]}>(`/v1/roles/${encodeURIComponent(currentId)}/appearance/outfits`)
    ]).then(([role, result, wardrobe]) => {
      if (request !== requestId.current) return;
      setDetail(role);
      applySnapshot(currentId, result, wardrobe.items);
    }).catch(e => { if (request === requestId.current) setError(e instanceof Error ? e.message : String(e)); });
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
    if (!element || page === 'home' || motion.reduced) return;
    scope.run(element, [{ opacity: .35, transform: `translateY(${readMotionPx(element, '--nd-component-motion-page-offset', 4)}px)` }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: readMotionTime(element, '--nd-component-motion-page', 280), easing: readMotionValue(element, '--nd-component-motion-ease', 'cubic-bezier(0.2, 0, 0, 1)'), slot: 'page', fill: 'backwards' });
    return () => scope.cancelAll();
  }, [page, motion.reduced, scope]);
  const accounts = roles ? { accounts: roles.map(r => ({ accountId: r.roleId, nickname: r.displayName, signature: r.roleId === currentId ? status : '' })) } : undefined;
  const currentOutfit = outfits.find(outfit => outfit.outfitId === state.outfitId) ?? null;
  const outfitHomeUrl = currentOutfit?.home ? appearanceAssetUrl(currentId, currentOutfit.home.assetId) : null;
  return <div className="studio-shell" data-ui-palette="xiacheng" data-ui-preset={preset} data-page={page}>
    <UiThemeScope theme="xiacheng" className="studio-header-scope"><header className="studio-header">
      <ControlButton className="ui-studio-brand" aria-label="返回主页" onClick={() => setPage('home')}><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></ControlButton>
      <ThemeSwitcher/>
      <div className="studio-header-actions"><ControlButton className="ui-settings-launcher" aria-label="应用设置" onClick={() => setPage('settings')}><Icon name="settings" size={20}/></ControlButton></div>
    </header></UiThemeScope>
    <main className="studio-content" tabIndex={-1} aria-label="当前页面内容"><UiThemeProvider theme="xiacheng">
      <div ref={pageBody} className={page === 'home' ? 'studio-home-content' : page === 'roles' ? 'studio-relations-content' : 'studio-legacy-page'}>
        {page === 'home' && <UiThemeScope theme="xiacheng"><HomePage accounts={accounts} selectedAccountId={currentId} outfitHomeUrl={outfitHomeUrl} outfitName={currentOutfit?.name ?? null} loading={!roles && !error} error={error} onRetry={() => refresh()} onGoWorkbench={() => setPage('roles')}/></UiThemeScope>}
        {page === 'roles' && <Relations roles={roles || []} error={error} currentId={currentId} visit={rolesVisit} onSelect={setCurrentId} onOpenSettings={() => setPage('settings')}/>}
        {page === 'conversation' && <header className="studio-page-heading"><h1>对话</h1><p>这里会收留你们的对话。</p></header>}
        {page === 'settings' && <SettingsPage roles={roles || []} detail={detail} currentId={currentId} currentOutfitId={typeof state.outfitId === 'string' ? state.outfitId : ''} onSelect={setCurrentId} onRefresh={refresh}/>}
      </div>
    </UiThemeProvider></main>
    <UiThemeScope theme="xiacheng" className="studio-footer-scope"><footer className="studio-footer">
      <span className="studio-runtime">{error ? '连接状态待更新' : roles ? `${roles.length} 位角色 · 本地生活空间` : '正在连接'}</span>
      <PageDock page={page} onNavigate={next => { setPage(next); if (next === 'roles') setRolesVisit(value => value + 1); }}/><span className="studio-edition">CHARACTER STUDIO / 开发版</span>
    </footer></UiThemeScope>
  </div>;
}
