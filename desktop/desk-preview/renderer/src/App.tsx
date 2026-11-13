import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Outfit, RoleDetail, RoleListItem, RoleStateResponse } from './types';
import { appearanceAssetUrl } from './types';
import { BrandMark, Button, ControlButton, UiThemeProvider, UiThemeScope, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy } from './ui';
import { useThemePreset } from './ui/presets';
import { ThemeSwitcher } from './components/shell/ThemeSwitcher';
import { PageDock } from './components/shell/PageDock';
import { HomePage } from './pages/Home';
import { Relations } from './Relations';
import { SettingsWorkspace } from './pages/Settings';
import { ConversationPage } from './pages/Conversation';
import { createStateVersionGate } from './state-version.js';

export function App() {
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  const [scope] = useState(createMotionScope);
  const pageBody = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState('home');
  const [workspaceRequest, setWorkspaceRequest] = useState<{ kind: 'section'; roleId: string; section: 'models'; key: number } | { kind: 'create'; key: number } | null>(null);
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
  const [currentId, setCurrentId] = useState('');
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
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
    const request = ++roleListRequest.current;
    try {
      const list = await api<{items: RoleListItem[]}>('/v1/roles');
      if (request !== roleListRequest.current) return;
      const items = list.items.filter(role => !removedRoles.current.has(role.roleId));
      rolesRef.current = items;
      setRoles(items);
      setRoleListError('');
      setError('');
      setCurrentId(previous => items.some(r => r.roleId === (preferred || previous)) ? (preferred || previous) : (items[0]?.roleId || ''));
      setRevision(value => value + 1);
    } catch (e) { if (request === roleListRequest.current) { const message = e instanceof Error ? e.message : String(e); setError(message); setRoleListError(message); } }
  }, []);
  const removeRoleLocally = useCallback((roleId: string) => {
    removedRoles.current.add(roleId);
    roleListRequest.current += 1;
    const remaining = rolesRef.current.filter(role => role.roleId !== roleId);
    rolesRef.current = remaining;
    setRoles(remaining);
    setCurrentId(previous => previous === roleId ? (remaining[0]?.roleId || '') : previous);
    // 作废删除前发起的详情请求与轮询结果。
    if (currentIdRef.current === roleId) {
      requestId.current += 1;
      stateGate.current.activate('');
    }
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
      { duration: readMotionTime(element, '--nd-component-motion-page', 360), easing: readMotionValue(element, '--nd-component-motion-ease', 'cubic-bezier(0.2, 0.8, 0.2, 1)'), slot: 'page', fill: 'backwards' });
    return () => scope.cancelAll();
  }, [page, motion.reduced, scope]);
  const accounts = roles ? { accounts: roles.map(r => ({ accountId: r.roleId, nickname: r.displayName, signature: r.roleId === currentId ? status : '' })) } : undefined;
  const currentOutfit = outfits.find(outfit => outfit.outfitId === state.outfitId) ?? null;
  const outfitHomeUrl = currentOutfit?.home ? appearanceAssetUrl(currentId, currentOutfit.home.assetId) : null;
  const dockHidden = page === 'conversation' && hideConversationDock;
  const setConversationDockHidden = (hidden: boolean) => {
    setHideConversationDock(hidden);
    try { localStorage.setItem('nowadays-dialogue-hide-dock', hidden ? '1' : '0'); } catch { /* 本地偏好不可写时仅保留本次设置。 */ }
  };
  return <div className="studio-shell" data-ui-palette="xiacheng" data-ui-preset={preset} data-page={page} data-dialogue-dock-hidden={dockHidden || undefined}>
    <UiThemeScope theme="xiacheng" className="studio-header-scope"><header className="studio-header">
      <ControlButton className="ui-studio-brand" aria-label="返回主页" onClick={() => setPage('home')}><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></ControlButton>
      <ThemeSwitcher/>
      <div className="studio-header-actions" aria-hidden="true" />
    </header></UiThemeScope>
    <main className="studio-content" tabIndex={-1} aria-label="当前页面内容"><UiThemeProvider theme="xiacheng">
      <div ref={pageBody} className={page === 'home' ? 'studio-home-content' : page === 'roles' ? 'studio-relations-content' : page === 'conversation' ? 'studio-conversation-content' : 'studio-legacy-page'}>
        {page === 'home' && <UiThemeScope theme="xiacheng"><HomePage accounts={accounts} selectedAccountId={currentId} outfitHomeUrl={outfitHomeUrl} outfitName={currentOutfit?.name ?? null} loading={!roles && !error} error={error} onRetry={() => refresh()} onGoWorkbench={() => setPage('roles')} onCreateRole={() => { setWorkspaceRequest({ kind: 'create', key: Date.now() }); setPage('role-config'); }}/></UiThemeScope>}
        {page === 'roles' && <Relations roles={roles || []} error={error} currentId={currentId} visit={rolesVisit} onSelect={setCurrentId} onOpenSettings={() => setPage('role-config')}/>}
        {page === 'conversation' && <ConversationPage roles={roles || []} currentId={currentId} currentOutfit={currentOutfit} outfits={outfits} outfitHomeUrl={outfitHomeUrl} loading={!roles && !error} error={error} hideDock={hideConversationDock} onHideDockChange={setConversationDockHidden} onSelectRole={setCurrentId} onOpenRelations={() => setPage('roles')} onConfigureModel={() => { setWorkspaceRequest({ kind: 'section', roleId: currentId, section: 'models', key: Date.now() }); setPage('role-config'); }} onCreateRole={() => { setWorkspaceRequest({ kind: 'create', key: Date.now() }); setPage('role-config'); }}/>}
        {settingsVisited && <SettingsWorkspace page={page} roles={roles || []} currentId={currentId} roleListError={roleListError} onRoleDeleted={removeRoleLocally} onSelectCompanion={setCurrentId} onRefresh={refresh} onNavigate={setPage} workspaceRequest={workspaceRequest} onStartConversation={roleId => { setCurrentId(roleId); setPage('conversation'); }}/>}
      </div>
    </UiThemeProvider></main>
    {!dockHidden && <UiThemeScope theme="xiacheng" className="studio-footer-scope"><footer className="studio-footer">
      {page === 'role-config' || page === 'settings' ? <div id="config-footer-left" className="config-footer-left"/> : <span className="studio-runtime">{error ? '连接状态待更新' : roles ? `${roles.length} 位角色 · 本地生活空间` : '正在连接'}</span>}
      <PageDock page={page} onNavigate={next => { setPage(next); if (next === 'roles') setRolesVisit(value => value + 1); }}/>{page === 'role-config' || page === 'settings' ? <div id="config-footer-right" className="config-footer-right"/> : <span className="studio-edition">CHARACTER STUDIO / 开发版</span>}
    </footer></UiThemeScope>}
  </div>;
}
