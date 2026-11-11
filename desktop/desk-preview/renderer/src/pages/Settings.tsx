import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';
import type { Outfit, RoleDetail, RoleListItem, RoleStateResponse } from '../types';
import { appearanceAssetUrl } from '../types';
import { Button, Field, Input, Select, Textarea, useMotionPolicy } from '../ui';
import type { MotionPreference } from '../ui/motion';
import { AppearancePanel } from '../components/appearance/AppearancePanel';
import { VoicePanel } from '../components/voice/VoicePanel';
import { ImagePanel } from '../components/image/ImagePanel';
import type { ConfigDraftState } from '../components/config-draft';
import { useThemePreset } from '../ui/presets';
import { ConfigThemeTransition } from '../ui/config-theme-transition';

type Resource = { resourceId: string; kind: 'model' | 'mcp' | 'skill'; name: string; enabled: boolean; config: Record<string, unknown>; credential?: { status: string; resolvable: boolean }; lastTest?: { ok: boolean; stale: boolean; modelName: string } | null };
type ImageService = { serviceId: string; name: string; enabled: boolean; config: { baseUrl: string }; credential: { status: string } };
type Binding = { capability: string; resourceId: string; modelName: string | null; enabled: boolean };
type Activity = { roleId: string; state: 'active' | 'stopping' | 'stopped'; running: boolean; initStatus: string };
type RoleSection = 'profile' | 'look' | 'models' | 'ext' | 'quota' | 'done';
type SettingsSection = 'model' | 'mcp' | 'skill' | 'roles' | 'local';
type Draft = { name: string; definition: string; revision: number; payload: Record<string, unknown> };
const roleSections: Array<[RoleSection, string, string]> = [['profile', '设定', '关于这个人'], ['look', '外观', '立绘与服饰'], ['models', '模型', '对话与演出'], ['ext', '扩展', '工具与知识'], ['quota', '自主额度', '属于自己的时间'], ['done', '完成度', '慢慢补全']];
const settingSections: Array<[SettingsSection, string, string]> = [['model', '模型', '服务与连接'], ['mcp', 'MCP', '工具服务'], ['skill', 'Skill', '方法与知识'], ['roles', '角色状态', '活动与停止'], ['local', '本机', '此设备的偏好']];
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const activityText = (a?: Activity) => !a ? '状态未获取' : a.state === 'active' ? (a.running ? '运行中' : '已启用') : a.state === 'stopping' ? '正在停止' : '已停止';

type ModelPart = 'chat' | 'memory' | 'voice' | 'image';
type RoleDirty = { profile: boolean; models: boolean; voice: boolean; image: boolean; ext: boolean; quota: boolean };
type RoleEditorState = { dirty: RoleDirty; busy: boolean; discard: () => void };
type ModelOrigin = { roleId: string; part: 'chat' | 'memory'; previousResource: string };
type Props = { page: string; roles: RoleListItem[]; currentId: string; roleListError: string; onRoleDeleted: (id: string) => void; onSelectCompanion: (id: string) => void; onRefresh: () => Promise<void>; onNavigate: (page: string) => void };

/** 两页常驻以保留跨页草稿；编辑对象绝不隐式改变陪伴对象。 */
export function SettingsWorkspace({ page, roles, currentId, roleListError, onRoleDeleted, onSelectCompanion, onRefresh, onNavigate }: Props) {
  const motion = useMotionPolicy();
  const { preset } = useThemePreset();
  const [editId, setEditId] = useState('');
  const [visited, setVisited] = useState<string[]>([]);
  const [roleSection, setRoleSection] = useState<RoleSection>('profile');
  const [stagePreview, setStagePreview] = useState<{ roleId: string; assetId: string } | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('model');
  const [modelPart, setModelPart] = useState<ModelPart>('chat');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [roleDirty, setRoleDirty] = useState<Record<string, RoleDirty>>({});
  const [deleteNotice, setDeleteNotice] = useState('');
  const editorActions = useRef(new Map<string, RoleEditorState>());
  const [pendingRole, setPendingRole] = useState<{ roleId: string; button: HTMLButtonElement | null } | null>(null);
  const pendingPrompt = useRef<HTMLDivElement>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [removedResources, setRemovedResources] = useState<string[]>([]);
  const [resourceError, setResourceError] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityError, setActivityError] = useState('');
  const [activityReady, setActivityReady] = useState(false);
  const [activityBusy, setActivityBusy] = useState<Record<string, boolean>>({});
  const [activityOperationError, setActivityOperationError] = useState<Record<string, string>>({});
  const [showRoles, setShowRoles] = useState(false);
  const [creating, setCreating] = useState(false);
  const [creatingName, setCreatingName] = useState('');
  const [creatingDefinition, setCreatingDefinition] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const switchRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const roleFlight = useRef<{ animation: Animation; node: HTMLElement } | null>(null);
  const [selectedResource, setSelectedResource] = useState('');
  const [visitedResources, setVisitedResources] = useState<string[]>([]);
  const [modelKind, setModelKind] = useState<'chat' | 'memory' | 'image' | 'voice'>('chat');
  const [imageServices, setImageServices] = useState<ImageService[]>([]);
  const [imageServiceError, setImageServiceError] = useState('');
  const [newModel, setNewModel] = useState(false);
  const [newExtension, setNewExtension] = useState<'mcp' | 'skill' | null>(null);
  const [modelOrigin, setModelOrigin] = useState<ModelOrigin | null>(null);
  const modelOriginRef = useRef(modelOrigin);
  modelOriginRef.current = modelOrigin;
  const [modelPrefill, setModelPrefill] = useState<(ModelOrigin & { resourceId: string }) | null>(null);
  const [modelName, setModelName] = useState('');
  const [modelUrl, setModelUrl] = useState('');
  const [modelProtocol, setModelProtocol] = useState('openai-chat');
  const [modelSecret, setModelSecret] = useState('');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const roleActive = page === 'role-config';
  const settingsActive = page === 'settings';
  const viewRef = useRef({ roleActive, settingsActive, settingsSection, newModel, newExtension, showRoles, creating, editId });
  const updateEditorState = useCallback((roleId: string, value: RoleEditorState | null) => {
    if (!value) { editorActions.current.delete(roleId); return; }
    editorActions.current.set(roleId, value);
    setRoleDirty(previous => {
      const current = previous[roleId];
      return current && current.profile === value.dirty.profile && current.models === value.dirty.models && current.voice === value.dirty.voice && current.image === value.dirty.image && current.ext === value.dirty.ext && current.quota === value.dirty.quota ? previous : { ...previous, [roleId]: value.dirty };
    });
  }, []);
  viewRef.current = { roleActive, settingsActive, settingsSection, newModel, newExtension, showRoles, creating, editId };
  useEffect(() => { if (!settingsActive) setModelOrigin(null); }, [settingsActive]);
  useEffect(() => {
    if (!roles.some(role => role.roleId === editId)) setEditId(roles.find(role => role.roleId === currentId)?.roleId || roles[0]?.roleId || '');
  }, [roles, currentId, editId]);
  useEffect(() => { if (editId) setVisited(previous => previous.includes(editId) ? previous : [...previous, editId]); }, [editId]);
  useEffect(() => { if (pendingRole) pendingPrompt.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [pendingRole]);
  useEffect(() => {
    if (!roleActive && !settingsActive) return;
    let live = true;
    api<{ items: Resource[] }>('/v1/resources').then(result => { if (live) { setResources(result.items); setResourceError(''); } }).catch(e => { if (live) setResourceError(errorText(e)); });
    api<{ items: Activity[] }>('/v1/activities').then(result => { if (live) { setActivities(result.items); setActivityError(''); setActivityReady(true); } }).catch(e => { if (live) { setActivityError(errorText(e)); setActivityReady(false); } });
    api<{ items: ImageService[] }>('/v1/image-services').then(result => { if (live) { setImageServices(result.items); setImageServiceError(''); } }).catch(e => { if (live) setImageServiceError(errorText(e)); });
    return () => { live = false; };
  }, [page, refreshVersion]);
  useEffect(() => {
    if (!settingsActive || settingsSection !== 'roles' || !activities.some(item => item.state === 'stopping')) return;
    const timer = window.setInterval(() => setRefreshVersion(version => version + 1), 3000);
    return () => window.clearInterval(timer);
  }, [settingsActive, settingsSection, activities]);
  const openSettings = (section: SettingsSection) => { setModelOrigin(null); setSettingsSection(section); onNavigate('settings'); };
  const createModelForRole = (origin: ModelOrigin) => { setModelOrigin(origin); setModelKind(origin.part); setSettingsSection('model'); setNewModel(true); onNavigate('settings'); };
  const changeActivity = async (roleId: string, operation: 'stop' | 'resume') => {
    if (activityBusy[roleId]) return;
    setActivityBusy(previous => ({ ...previous, [roleId]: true }));
    setActivityOperationError(previous => ({ ...previous, [roleId]: '' }));
    try {
      const result = await api<{ activity: Activity }>(`/v1/roles/${encodeURIComponent(roleId)}/activity/${operation}`, { method: 'POST' });
      setActivities(previous => [...previous.filter(item => item.roleId !== roleId), result.activity]);
      setRefreshVersion(v => v + 1);
    } catch (e) { setActivityOperationError(previous => ({ ...previous, [roleId]: errorText(e) })); }
    finally { setActivityBusy(previous => ({ ...previous, [roleId]: false })); }
  };
  const createModel = async () => {
    if (modelBusy || !modelName.trim() || !modelUrl.trim()) return;
    setModelBusy(true); setModelError('');
    try {
      const resource = await api<Resource>('/v1/resources', { method: 'POST', body: { kind: 'model', name: modelName.trim(), config: { protocol: modelProtocol, baseUrl: modelUrl.trim() }, ...(modelSecret ? { secret: modelSecret } : {}) } });
      setResources(previous => [...previous.filter(item => item.resourceId !== resource.resourceId), resource]);
      setRefreshVersion(v => v + 1);
      if (viewRef.current.settingsActive && viewRef.current.settingsSection === 'model' && viewRef.current.newModel) {
        setSelectedResource(resource.resourceId); setNewModel(false);
        if (modelOrigin && modelOriginRef.current === modelOrigin && viewRef.current.editId === modelOrigin.roleId) {
          setModelPrefill({ ...modelOrigin, resourceId: resource.resourceId });
          setRoleSection('models'); setModelPart(modelOrigin.part); onNavigate('role-config');
        }
      }
      setModelOrigin(null);
      setModelName(''); setModelUrl(''); setModelSecret('');
    } catch (e) { setModelError(errorText(e)); } finally { setModelBusy(false); }
  };
  const closeRoles = () => { roleFlight.current?.animation.cancel(); roleFlight.current?.node.remove(); roleFlight.current = null; setPendingRole(null); setShowRoles(false); setCreating(false); requestAnimationFrame(() => switchRef.current?.focus()); };
  const chooseRole = (roleId: string, button: HTMLButtonElement | null, confirmed = false) => {
    if (roleFlight.current) return;
    if (roleId === editId) { closeRoles(); return; }
    if (!confirmed && Object.values(roleDirty[editId] || {}).some(Boolean)) { setPendingRole({ roleId, button }); return; }
    if (roleId === '__new') { setPendingRole(null); setCreating(true); return; }
    const source = button?.querySelector<HTMLElement>('.config-portrait');
    const target = document.querySelector<HTMLElement>('.config-stage .config-portrait');
    if (motion.reduced || !source || !target || !source.animate) { setEditId(roleId); closeRoles(); return; }
    const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
    const copy = source.cloneNode(true) as HTMLElement;
    copy.setAttribute('aria-hidden', 'true');
    Object.assign(copy.style, { position:'fixed', zIndex:'110', left:`${from.left}px`, top:`${from.top}px`, width:`${from.width}px`, height:`${from.height}px`, margin:'0', pointerEvents:'none' });
    document.querySelector('.config-workspace')?.append(copy);
    const animation = copy.animate([{ left:`${from.left}px`, top:`${from.top}px`, width:`${from.width}px`, height:`${from.height}px` }, { left:`${to.left}px`, top:`${to.top}px`, width:`${to.width}px`, height:`${to.height}px` }], { duration:560, easing:'cubic-bezier(.65,0,.25,1)', fill:'forwards' });
    roleFlight.current = { animation, node: copy };
    source.style.visibility = 'hidden';
    document.querySelector<HTMLElement>('.config-dialog-backdrop')?.animate([{opacity:1},{opacity:0}], { duration:420, delay:120, fill:'forwards', easing:'ease-in' });
    void animation.finished.then(() => { if (roleFlight.current?.animation !== animation) return; copy.remove(); roleFlight.current = null; setStagePreview(null); setEditId(roleId); closeRoles(); }).catch(() => { source.style.visibility = ''; });
  };
  const createRole = async () => {
    if (createBusy || !creatingName.trim() || !creatingDefinition.trim()) return;
    setCreateBusy(true); setCreateError('');
    try {
      const role = await api<RoleDetail>('/v1/roles', { method: 'POST', body: { displayName: creatingName.trim(), definition: { text: creatingDefinition.trim() } } });
      await onRefresh();
      setDrafts(previous => ({ ...previous, [role.roleId]: { name: role.displayName, definition: role.definition.text, revision: role.definitionRevision, payload: role.definition.payload } }));
      if (viewRef.current.roleActive && viewRef.current.showRoles && viewRef.current.creating) { setEditId(role.roleId); setRoleSection('profile'); closeRoles(); }
      setCreatingName(''); setCreatingDefinition(''); setCreating(false);
    } catch (e) { setCreateError(errorText(e)); } finally { setCreateBusy(false); }
  };
  const chosen = roles.find(role => role.roleId === editId);
  const changeSection = (id: string) => {
    if (roleActive) { setStagePreview(null); setRoleSection(id as RoleSection); }
    else setSettingsSection(id as SettingsSection);
    const content = contentRef.current;
    if (content) {
      content.scrollTop = 0;
      if (!motion.reduced) content.animate([{ opacity:0, transform:'translateX(8px)' }, { opacity:1, transform:'none' }], { duration:200, easing:'cubic-bezier(.2,.7,.2,1)' });
    }
  };
  const filtered = resources.filter(item => item.kind === settingsSection);
  useEffect(() => {
    if ((settingsSection === 'model' && (modelKind === 'chat' || modelKind === 'memory')) || settingsSection === 'mcp' || settingsSection === 'skill') {
      if (!filtered.some(item => item.resourceId === selectedResource)) setSelectedResource(filtered[0]?.resourceId || '');
    } else if (settingsSection === 'model' && modelKind === 'image') {
      if (!imageServices.some(item => item.serviceId === selectedResource)) setSelectedResource(imageServices[0]?.serviceId || '');
    }
  }, [settingsSection, resources, selectedResource, modelKind, imageServices]);
  useEffect(() => { if (resources.some(item => item.resourceId === selectedResource)) setVisitedResources(previous => previous.includes(selectedResource) ? previous : [...previous, selectedResource]); }, [resources, selectedResource]);
  const footerLeft = document.getElementById('config-footer-left');
  const footerRight = document.getElementById('config-footer-right');
  const sectionNumber = String((roleActive ? roleSections.findIndex(item => item[0] === roleSection) : settingSections.findIndex(item => item[0] === settingsSection)) + 1).padStart(2, '0');
  const sectionTitle = (roleActive ? roleSections : settingSections).find(item => item[0] === (roleActive ? roleSection : settingsSection))?.[1];
  const dirtyScopes = roleDirty[editId];
  const dirtyNames = dirtyScopes ? (Object.entries(dirtyScopes) as Array<[keyof RoleDirty, boolean]>).filter(([, dirty]) => dirty).map(([id]) => ({profile:'设定',models:'模型',voice:'语音',image:'生图',ext:'扩展',quota:'自主额度'}[id])) : [];
  return <div className="config-workspace" data-ui-preset={preset} hidden={!roleActive && !settingsActive}>
    {(roleActive || settingsActive) && <ConfigThemeTransition/>}
    {footerLeft && createPortal(roleActive ? <div className="config-footer-ident"><strong>{chosen?.displayName || '角色配置'}</strong><span>{activityError ? '状态获取失败' : activityText(activities.find(item => item.roleId === editId))}</span></div> : <div className="config-footer-ident"><strong>设置</strong><span>全局资源</span></div>, footerLeft)}
    {footerRight && createPortal(roleActive ? <div className="config-footer-tools"><span className="config-companion"><small>当前陪伴</small><b>{roles.find(role => role.roleId === currentId)?.displayName || '无'}</b></span>{editId && editId !== currentId && <button type="button" className="config-footer-button" onClick={() => onSelectCompanion(editId)}>设为当前陪伴</button>}<button ref={switchRef} type="button" className="config-footer-button config-switch-role" onClick={() => setShowRoles(true)}>切换角色 <span>{roles.length}</span></button></div> : <div className="config-footer-tools"><span>{activities.filter(item => item.state === 'active').length} 位角色启用中</span></div>, footerRight)}
    <div className="config-book" data-layout={settingsActive && settingsSection === 'roles' ? 'wide' : settingsActive ? 'catalog' : 'role'}>
      <div className="config-book-surface" aria-hidden="true"><div className="config-paper-left"/><div className="config-gutter"/><div className="config-paper-right"/><div className="config-grain"/><div className="config-thread"><i/><i/></div></div>
      {roleActive ? <aside className="config-stage"><figure className="config-plate"><div className="config-plate-mat"/><div className="config-stage-label"><span>人物档案 <b>{String(Math.max(0, roles.findIndex(role => role.roleId === editId)) + 1).padStart(2, '0')}</b></span><span>立绘</span></div>
        <RolePortrait roleId={editId} version={refreshVersion} cycle={roleSection} previewAssetId={stagePreview?.roleId === editId && roleSection === 'look' ? stagePreview.assetId : undefined} />
      </figure></aside> : <aside className="config-index"><div className="config-index-heading">
        {settingsSection === 'model' && <div className="config-kind-tabs" role="group" aria-label="模型分类">{([['chat','对话'],['memory','记忆'],['image','生图'],['voice','语音']] as const).map(([id,label]) => <button key={id} type="button" aria-pressed={modelKind === id} onClick={() => { setModelKind(id); setNewModel(false); setModelOrigin(null); }}>{label}</button>)}</div>}
        <small>{settingsSection === 'model' ? ({chat:'对话模型',memory:'记忆模型',image:'生图服务',voice:'角色语音'} as const)[modelKind] : settingSections.find(item => item[0] === settingsSection)?.[1]} · {settingsSection === 'model' && modelKind === 'image' ? imageServices.length : filtered.length} 项</small></div>
        {settingsSection === 'roles' ? null : settingsSection === 'local' ? <><button type="button" className="config-index-item" data-selected="true"><strong>外观与动效</strong><small>本机动效偏好</small></button><button type="button" className="config-index-item" onClick={() => document.getElementById('config-local-connection')?.scrollIntoView({block:'nearest'})}><strong>版本与连接</strong><small>后端状态</small></button></> : settingsSection === 'model' && modelKind === 'image' ? <>{imageServiceError && <p role="alert">{imageServiceError}</p>}{imageServices.map((item,index) => <button className="config-index-item" type="button" key={item.serviceId} onClick={() => setSelectedResource(item.serviceId)} data-selected={selectedResource === item.serviceId}><small>{String(index+1).padStart(2,'0')}</small><strong>{item.name}</strong><small>{item.config.baseUrl} · {item.enabled ? '已启用' : '已停用'}</small></button>)}{!imageServiceError && !imageServices.length && <p className="config-muted">还没有生图服务。</p>}</> : settingsSection === 'model' && modelKind === 'voice' ? <p className="config-muted">语音配置按角色保存，可在角色配置中管理。</p> : <>{resourceError && <p role="alert">{resourceError}</p>}{filtered.map((item,index) => <button className="config-index-item" type="button" key={item.resourceId} onClick={() => { setSelectedResource(item.resourceId); setNewModel(false); setModelOrigin(null); setNewExtension(null); }} data-selected={!newModel && newExtension !== item.kind && selectedResource === item.resourceId}><small>{String(index+1).padStart(2,'0')}</small><strong>{item.name}</strong><small>{typeof item.config.baseUrl === 'string' ? item.config.baseUrl : item.kind.toUpperCase()}</small><small>{item.enabled ? '已启用' : '已停用'}{item.lastTest ? item.lastTest.stale ? ' · 测试已过期' : item.lastTest.ok ? ' · 测试通过' : ' · 测试失败' : ''}</small></button>)}{!resourceError && !filtered.length && <p className="config-muted">还没有已保存的资源。</p>}{settingsSection === 'model' && <button type="button" className="config-index-new" onClick={() => { setModelOrigin(null); setNewModel(true); }}>＋ 添加模型服务</button>}{(settingsSection === 'mcp' || settingsSection === 'skill') && <button type="button" className="config-index-new" onClick={() => setNewExtension(settingsSection)}>＋ 添加 {settingsSection === 'mcp' ? 'MCP' : 'Skill'}</button>}</>}
      </aside>}
      <nav className="config-tabs" aria-label={roleActive ? '角色配置分区' : '设置分区'}>{(roleActive ? roleSections : settingSections).map(([id, title], index) => <button key={id} type="button" aria-current={(roleActive ? roleSection : settingsSection) === id ? 'page' : undefined} onClick={() => changeSection(id)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{id === 'quota' ? '额度' : id === 'done' ? '完成' : id === 'roles' ? '角色' : title}</strong>{roleActive && (dirtyScopes?.[id as keyof RoleDirty] || (id === 'models' && (dirtyScopes?.voice || dirtyScopes?.image))) && <i className="config-tab-led" aria-label="有未保存草稿"/>}</button>)}</nav>
      <section className="config-leaf">{roleActive && dirtyNames.length > 0 && <div className="config-dirty-ribbon" aria-label={`${dirtyNames.length} 处未保存`}>{dirtyNames.length}</div>}<header className="config-leaf-head"><div className="config-crumb">{roleActive ? <>角色配置 <i>/</i> {chosen?.displayName || '选择角色'} <i>/</i> <b>{sectionTitle}</b></> : <>设置 <i>/</i> <b>{sectionTitle}</b> <button type="button" className="config-return-link" onClick={() => onNavigate('role-config')}>返回角色配置</button></>}</div><span className="config-folio">{roleActive ? `档案 ${String(Math.max(0, roles.findIndex(role => role.roleId === editId)) + 1).padStart(2, '0')} / ` : '设置 · '}第 {sectionNumber} 页</span></header>
        <div className="config-leaf-body" ref={contentRef}>
          {roleListError && <p role="alert" className="config-delete-notice">角色列表同步失败：{roleListError} <button type="button" onClick={() => void onRefresh()}>重试读取角色列表</button></p>}
          {deleteNotice && roleActive && <p role="status" className="config-delete-notice">{deleteNotice}</p>}
          {visited.filter(id => roles.some(role => role.roleId === id)).map(id => <RoleEditor key={id} roleId={id} roleCount={roles.length} active={roleActive && editId === id} activity={activityError ? undefined : activities.find(item => item.roleId === id)} section={roleSection} modelPart={modelPart} setModelPart={setModelPart} draft={drafts[id]} setDraft={draft => setDrafts(previous => ({ ...previous, [id]: draft }))} resources={resources} removedResources={removedResources} resourceError={resourceError} onEditorState={updateEditorState} onOpenSettings={openSettings} onCreateModel={createModelForRole} modelPrefill={modelPrefill} onPrefillConsumed={() => setModelPrefill(null)} onPreviewOutfit={outfit => setStagePreview(outfit.home ? { roleId: id, assetId: outfit.home.assetId } : null)} onPreviewAsset={assetId => setStagePreview({ roleId: id, assetId })} onClearPreview={() => setStagePreview(previous => previous?.roleId === id ? null : previous)} onDeleted={async (roleId, keepHistory, filesRemoved) => { onRoleDeleted(roleId); setStagePreview(previous => previous?.roleId === roleId ? null : previous); setDeleteNotice(keepHistory ? '角色已移除，记忆与对话数据保留在本机目录。' : filesRemoved ? '角色及其本机数据已删除。' : '角色已移除，部分文件尚待清理，后端将继续处理。'); await onRefresh(); setDrafts(previous => { const next = { ...previous }; delete next[roleId]; return next; }); setRefreshVersion(v => v + 1); }} onRefresh={async () => { await onRefresh(); setRefreshVersion(v => v + 1); }} />)}
          {roleActive && !editId && <p>还没有角色，请先创建角色。</p>}
          {visitedResources.map(id => { const resource = resources.find(item => item.resourceId === id); if (!resource) return null; const visible = settingsActive && id === selectedResource && resource.kind === settingsSection && newExtension !== resource.kind && !(settingsSection === 'model' && (newModel || modelKind === 'image' || modelKind === 'voice')); return <ResourceDetail key={id} resource={resource} active={visible} canWrite={activityReady && roles.every(role => activities.find(item => item.roleId === role.roleId)?.state === 'stopped')} onRemoved={resourceId => setRemovedResources(previous => previous.includes(resourceId) ? previous : [...previous, resourceId])} onUpdated={() => setRefreshVersion(v => v + 1)} />; })}
          {(['mcp', 'skill'] as const).map(kind => <ExtensionCreate key={kind} kind={kind} active={settingsActive && settingsSection === kind && newExtension === kind} onCancel={() => setNewExtension(null)} onCreated={resource => { setResources(previous => [...previous, resource]); setRefreshVersion(v => v + 1); if (viewRef.current.settingsActive && viewRef.current.settingsSection === kind && viewRef.current.newExtension === kind) { setSelectedResource(resource.resourceId); setNewExtension(null); } }}/>) }
          {settingsActive && (settingsSection === 'mcp' || settingsSection === 'skill' || settingsSection === 'model' && (modelKind === 'chat' || modelKind === 'memory') && !newModel) && !filtered.length && <div className="config-prose"><ConfigHeading number="01" label="资源" english="RESOURCES" title="选择一项资源" description="从左页选择已保存的资源。"/></div>}
          {settingsActive && settingsSection === 'model' && modelKind === 'image' && <ImageServiceDetail key={selectedResource} service={imageServices.find(item => item.serviceId === selectedResource)} />}
          {settingsActive && settingsSection === 'model' && modelKind === 'voice' && <div className="config-prose"><ConfigHeading number="01" label="模型 · 语音" english="VOICE" title="角色语音" description="语音目前按角色保存一份配置；请在角色配置中选择音色并试听。"/><button type="button" onClick={() => onNavigate('role-config')}>回到角色配置</button></div>}
          <div hidden={!settingsActive || settingsSection !== 'model' || !newModel} className="config-prose"><h2>添加模型服务</h2><p>地址与密钥保存在本机；创建后可以读取模型列表或手动输入模型 ID 测试。</p><Field label="名称"><Input disabled={modelBusy} value={modelName} maxLength={200} onChange={event => setModelName(event.target.value)}/></Field><Field label="接口协议"><Select disabled={modelBusy} value={modelProtocol} onChange={event => setModelProtocol(event.target.value)}><option value="openai-chat">OpenAI Chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></Select></Field><Field label="服务地址"><Input disabled={modelBusy} value={modelUrl} placeholder="http://127.0.0.1:8000" onChange={event => setModelUrl(event.target.value)}/></Field><Field label="密钥" hint="选填。保存后不会显示密钥原文。"><Input disabled={modelBusy} type="password" autoComplete="off" value={modelSecret} onChange={event => setModelSecret(event.target.value)}/></Field>{modelError && <p role="alert">{modelError}</p>}<div className="config-actions"><Button disabled={modelBusy || !modelName.trim() || !modelUrl.trim()} onClick={() => void createModel()}>保存模型服务</Button><button type="button" onClick={() => { setModelOrigin(null); setNewModel(false); }}>返回目录</button></div></div>
          {settingsActive && settingsSection === 'roles' && <div className="config-prose"><ConfigHeading number="04" label="角色状态" english="ROLE STATUS" title="角色状态" description="停止角色后才能修改它的配置；后端确认停止前，正在进行的任务会继续推进到保存边界。"/>{activityError && <p role="alert">状态获取失败：{activityError}</p>}<div className="config-status-wall">{roles.map((role,index) => { const item = activityError ? undefined : activities.find(a => a.roleId === role.roleId); return <article className="config-status-poster" key={role.roleId} data-stopped={item?.state === 'stopped'}><div className="config-poster-top">人物档案 <b>{String(index+1).padStart(2,'0')}</b><span>立绘</span></div><RolePortrait roleId={role.roleId}/><strong>{role.displayName}</strong><small>初始化：{item?.initStatus || '未知'}</small><span className="config-status-stamp">{activityText(item)}</span><div className="config-status-actions">{item && <Button disabled={activityBusy[role.roleId] || item.state === 'stopping'} onClick={() => void changeActivity(role.roleId, item.state === 'stopped' ? 'resume' : 'stop')}>{item.state === 'stopped' ? '恢复活动' : item.state === 'stopping' ? '正在停止' : '停止活动'}</Button>}<button type="button" onClick={() => { setEditId(role.roleId); onNavigate('role-config'); }}>角色配置</button></div>{activityOperationError[role.roleId] && <p role="alert">{activityOperationError[role.roleId]}</p>}</article>; })}</div><button type="button" onClick={() => setRefreshVersion(v => v + 1)}>刷新状态</button></div>}
          {settingsActive && settingsSection === 'local' && <div className="config-prose"><ConfigHeading number="05" label="本机" english="THIS DEVICE" title="本机" description="只影响这台电脑，改动立即生效。"/><div className="config-ledger"><div className="config-ledger-label"><b>外观与动效</b></div><div><p>昼夜主题可在页面顶部切换。</p><Field label="动效偏好"><Select value={motion.preference} onChange={event => motion.select(event.target.value as MotionPreference)}><option value="system">跟随系统</option><option value="reduced">减少动效</option><option value="full">完整动效</option></Select></Field></div></div><div className="config-ledger" id="config-local-connection"><div className="config-ledger-label"><b>版本与连接</b></div><div>资源读取：{resourceError ? `失败（${resourceError}）` : '已连接'}</div></div></div>}
        </div>
        <footer className="config-leaf-foot" id="config-leaf-actions"><span>{settingsActive ? '✓　配置状态以已保存的数据为准' : dirtyNames.length ? `●　未保存：${dirtyNames.join('、')}` : '✓　已全部保存'}</span>{settingsActive && <button type="button" className="config-return-footer" onClick={() => onNavigate('role-config')}>返回 {chosen?.displayName || '角色配置'} · {roleSections.find(item => item[0] === roleSection)?.[1]}</button>}</footer>
      </section>
    </div>
    {showRoles && roleActive && <div className="config-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeRoles(); }}>
      <div className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-roles-title" onMouseDown={event => { if (event.target === event.currentTarget && !pendingRole) closeRoles(); }} onKeyDown={event => { if (event.key === 'Escape') { if (pendingRole) { const target = pendingRole.button; setPendingRole(null); requestAnimationFrame(() => target?.focus()); } else closeRoles(); } if (event.key === 'Tab') { const scope = pendingRole ? pendingPrompt.current : event.currentTarget; const controls = [...(scope?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') || [])]; const first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}>
        <header><div><small>藏书票墙 · {roles.length} 位角色</small><h2 id="config-roles-title">{creating ? '创建角色' : '切换角色'}</h2><p>选一张来编辑。切换只改变正在编辑的对象，不改变主页和对话里的陪伴角色。</p></div><button type="button" autoFocus onClick={closeRoles} aria-label="关闭">×</button></header>
        {creating ? <div className="config-create-form config-prose"><ConfigHeading number="＋" label="新建" english="NEW CHARACTER" title="新建角色" description="创建独立的角色实例，之后可继续配置外观与模型。"/><Field label="名字"><Input disabled={createBusy} value={creatingName} maxLength={200} onChange={event => setCreatingName(event.target.value)}/></Field><Field label="角色设定"><Textarea disabled={createBusy} rows={6} value={creatingDefinition} onChange={event => setCreatingDefinition(event.target.value)}/></Field>{createError && <p role="alert">{createError}</p>}<div className="config-actions"><Button disabled={createBusy || !creatingName.trim() || !creatingDefinition.trim()} onClick={() => void createRole()}>创建角色</Button><button type="button" onClick={() => setCreating(false)}>返回角色列表</button></div></div> : <div className="config-role-wall" role="list">{roles.map((role,index) => <article className="config-poster" key={role.roleId} role="listitem" data-selected={role.roleId === editId}>
          <button type="button" className="config-poster-hit" onClick={event => chooseRole(role.roleId, event.currentTarget)}><span className="config-poster-top">人物档案 <b>{String(index + 1).padStart(2,'0')}</b><span>立绘</span></span><RolePortrait roleId={role.roleId}/><strong>{role.displayName}</strong><small>{activityText(activities.find(a => a.roleId === role.roleId))}</small></button>
          {role.roleId === editId && <span className="config-poster-ribbon">编辑中</span>}
          <div className="config-poster-foot">{role.roleId === currentId ? <span>当前陪伴</span> : <button type="button" onClick={() => onSelectCompanion(role.roleId)}>设为陪伴</button>}</div>
        </article>)}<article className="config-poster config-poster-new"><button type="button" className="config-poster-hit config-create-role" onClick={event => chooseRole('__new', event.currentTarget)}><span className="config-poster-top">人物档案 <b>{String(roles.length + 1).padStart(2,'0')}</b><span>空白</span></span><span className="config-poster-empty"><i>＋</i><strong>新建角色</strong></span><strong>新的一页</strong><small>先填显示名和人设</small></button><div className="config-poster-foot">创建后再配外观与模型</div></article></div>}
        <p className="config-dialog-foot">Esc 或点空白处关闭 · 启用 / 停用在设置的角色状态中操作</p>
        {pendingRole && <div className="config-dirty-prompt" ref={pendingPrompt} role="alertdialog" aria-modal="true" aria-label="未保存的草稿"><p><b>{chosen?.displayName}</b> 还有 {dirtyNames.length} 处未保存：{dirtyNames.join('、')}。</p><p>切换前要怎么处理？</p><div className="config-actions"><Button onClick={() => { const target = pendingRole; setPendingRole(null); chooseRole(target.roleId, target.button, true); }}>保留草稿，切换</Button><Button disabled={editorActions.current.get(editId)?.busy} onClick={() => { const target = pendingRole; editorActions.current.get(editId)?.discard(); setPendingRole(null); chooseRole(target.roleId, target.button, true); }}>放弃改动，切换</Button><button type="button" onClick={() => { const target = pendingRole.button; setPendingRole(null); requestAnimationFrame(() => target?.focus()); }}>留在当前角色</button></div></div>}
      </div>
    </div>}
  </div>;
}

function RolePortrait({ roleId, version = 0, previewAssetId, cycle }: { roleId: string; version?: number; previewAssetId?: string; cycle?: RoleSection }) {
  const [url, setUrl] = useState('');
  const [previousUrl, setPreviousUrl] = useState('');
  const lastUrl = useRef('');
  const stageChoice = useRef<{ roleId: string; cycle?: RoleSection; assetId: string }>({ roleId: '', assetId: '' });
  const motion = useMotionPolicy();
  useEffect(() => {
    let live = true;
    if (previewAssetId) { stageChoice.current = { roleId, cycle, assetId: previewAssetId }; setUrl(appearanceAssetUrl(roleId, previewAssetId)); return; }
    if (stageChoice.current.roleId !== roleId) setUrl('');
    if (roleId) Promise.allSettled([api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`), api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`)]).then(([outfits, state]) => {
      if (!live || outfits.status !== 'fulfilled') return;
      const available = outfits.value.items.filter(item => item.home);
      const current = state.status === 'fulfilled' ? state.value.state.outfitId : null;
      const prior = stageChoice.current;
      const reroll = cycle !== undefined && prior.roleId === roleId && prior.cycle !== cycle;
      const pool = reroll && available.length > 1 ? available.filter(item => item.home?.assetId !== prior.assetId) : [];
      const picked = pool.length ? pool[Math.floor(Math.random() * pool.length)] : available.find(item => item.outfitId === current) || available[0];
      const asset = picked?.home;
      stageChoice.current = { roleId, cycle, assetId: asset?.assetId || '' };
      setUrl(asset ? appearanceAssetUrl(roleId, asset.assetId) : '');
    });
    return () => { live = false; };
  }, [roleId, version, previewAssetId, cycle]);
  useEffect(() => {
    const old = lastUrl.current; lastUrl.current = url;
    if (!url || !old || old === url || motion.reduced) { setPreviousUrl(''); return; }
    setPreviousUrl(old);
    const timer = window.setTimeout(() => setPreviousUrl(''), 240);
    return () => window.clearTimeout(timer);
  }, [url, motion.reduced]);
  return <div className="config-portrait">{url ? <><img src={url} alt="角色立绘"/>{previousUrl && <img className="config-portrait-old" src={previousUrl} alt="" aria-hidden="true"/>}</> : <span>还没有配置立绘</span>}</div>;
}

function RoleEditor({ roleId, roleCount, active, activity, section, modelPart, setModelPart, draft, setDraft, resources, removedResources, resourceError, onEditorState, onOpenSettings, onCreateModel, modelPrefill, onPrefillConsumed, onPreviewOutfit, onPreviewAsset, onClearPreview, onDeleted, onRefresh }: { roleId: string; roleCount: number; active: boolean; activity?: Activity; section: RoleSection; modelPart: ModelPart; setModelPart: (part: ModelPart) => void; draft?: Draft; setDraft: (draft: Draft) => void; resources: Resource[]; removedResources: string[]; resourceError: string; onEditorState: (roleId: string, state: RoleEditorState | null) => void; onOpenSettings: (section: SettingsSection) => void; onCreateModel: (origin: ModelOrigin) => void; modelPrefill: (ModelOrigin & { resourceId: string }) | null; onPrefillConsumed: () => void; onPreviewOutfit: (outfit: Outfit) => void; onPreviewAsset: (assetId: string) => void; onClearPreview: () => void; onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [voiceDraft, setVoiceDraft] = useState<ConfigDraftState | null>(null);
  const [imageDraft, setImageDraft] = useState<ConfigDraftState | null>(null);
  const [detailError, setDetailError] = useState('');
  const [savedProfile, setSavedProfile] = useState<Draft | undefined>(draft);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [bindingLoaded, setBindingLoaded] = useState(false);
  const [bindingRevision, setBindingRevision] = useState('');
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingNotice, setBindingNotice] = useState('');
  const bindingLock = useRef(false);
  const syncedRemovals = useRef('');
  const [modelDraft, setModelDraft] = useState({ chatResource: '', chatModel: '', memoryResource: '', memoryModel: '' });
  useEffect(() => {
    if (!bindingLoaded || !modelPrefill || modelPrefill.roleId !== roleId) return;
    setModelDraft(previous => {
      if (modelPrefill.part === 'chat') return previous.chatResource === modelPrefill.previousResource ? { ...previous, chatResource: modelPrefill.resourceId, chatModel: '' } : previous;
      return previous.memoryResource === modelPrefill.previousResource ? { ...previous, memoryResource: modelPrefill.resourceId, memoryModel: '' } : previous;
    });
    onPrefillConsumed();
  }, [bindingLoaded, modelPrefill, roleId]);
  const [extensionDraft, setExtensionDraft] = useState<Record<string, boolean>>({});
  const [bindingError, setBindingError] = useState('');
  const [budget, setBudget] = useState<{ usedPoints: number; dailyLimit: number; unlimited: boolean; localDate: string }>();
  const [budgetError, setBudgetError] = useState('');
  const [budgetDraft, setBudgetDraft] = useState({ dailyLimit: 0, unlimited: false });
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [budgetNotice, setBudgetNotice] = useState('');
  const [outfitId, setOutfitId] = useState('');
  const [lookVersion, setLookVersion] = useState(0);
  const [loaded, setLoaded] = useState({ look: false, voice: false, image: false });
  // 每次重读都以读取前的已保存绑定为基线：未改字段跟随新值，草稿保留用户改动。
  const mergeRefreshedBindings = (before: Binding[], result: { items: Binding[]; revision: string }, removed: string[]) => {
    const model = (items: Binding[], capability: string) => items.find(item => item.capability === capability);
    setModelDraft(previous => {
      const next = { ...previous };
      for (const part of ['chat', 'memory'] as const) {
        const resourceKey = part === 'chat' ? 'chatResource' : 'memoryResource';
        const modelKey = part === 'chat' ? 'chatModel' : 'memoryModel';
        const capability = part === 'chat' ? 'chat_model' : 'memory_model';
        const old = model(before, capability), current = model(result.items, capability);
        if (previous[resourceKey] === (old?.resourceId || '') && (!previous[resourceKey] || previous[modelKey] === (old?.modelName || ''))) {
          next[resourceKey] = current?.resourceId || ''; next[modelKey] = current?.modelName || '';
        }
        if (removed.includes(next[resourceKey])) { next[resourceKey] = ''; next[modelKey] = ''; }
      }
      return next;
    });
    setExtensionDraft(previous => {
      const next = { ...previous };
      const ids = new Set([...Object.keys(previous), ...before.filter(item => item.capability === 'mcp' || item.capability === 'skill').map(item => item.resourceId), ...result.items.filter(item => item.capability === 'mcp' || item.capability === 'skill').map(item => item.resourceId)]);
      for (const id of ids) {
        const old = before.find(item => item.resourceId === id && (item.capability === 'mcp' || item.capability === 'skill'));
        const current = result.items.find(item => item.resourceId === id && (item.capability === 'mcp' || item.capability === 'skill'));
        if (!!previous[id] === !!old?.enabled) next[id] = !!current?.enabled;
        if (removed.includes(id)) delete next[id];
      }
      return next;
    });
    setBindings(result.items); setBindingRevision(result.revision);
  };
  useEffect(() => { if (draft && !savedProfile) setSavedProfile(draft); }, [draft, savedProfile]);
  useEffect(() => { if (!draft) { let live = true; api<RoleDetail>(`/v1/roles/${encodeURIComponent(roleId)}`).then(role => { if (live) setDraft({ name: role.displayName, definition: role.definition.text, revision: role.definitionRevision, payload: role.definition.payload }); }).catch(e => { if (live) setDetailError(errorText(e)); }); return () => { live = false; }; } }, [roleId]);
  useEffect(() => { let live = true; api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`).then(result => { if (live) { setBindings(result.items); setBindingRevision(result.revision || ''); const chat = result.items.find(item => item.capability === 'chat_model'); const memory = result.items.find(item => item.capability === 'memory_model'); setModelDraft({ chatResource: chat?.resourceId || '', chatModel: chat?.modelName || '', memoryResource: memory?.resourceId || '', memoryModel: memory?.modelName || '' }); setExtensionDraft(Object.fromEntries(result.items.filter(item => item.capability === 'mcp' || item.capability === 'skill').map(item => [item.resourceId, item.enabled]))); setBindingLoaded(true); } }).catch(e => { if (live) setBindingError(errorText(e)); }); api<NonNullable<typeof budget>>(`/v1/roles/${encodeURIComponent(roleId)}/autonomy/budget`).then(result => { if (live) { setBudget(result); setBudgetDraft({ dailyLimit: result.dailyLimit, unlimited: result.unlimited }); } }).catch(e => { if (live) setBudgetError(errorText(e)); }); return () => { live = false; }; }, [roleId]);
  useEffect(() => {
    const removalKey = removedResources.join('|');
    if (!bindingLoaded || bindingBusy || removedResources.length === 0 || syncedRemovals.current === removalKey) return;
    let live = true;
    const before = bindings;
    setBindingRevision('');
    api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`).then(result => {
      if (!live) return;
      mergeRefreshedBindings(before, result, removedResources); setBindingError('');
      syncedRemovals.current = removalKey;
    }).catch(reason => { if (live) setBindingError(`刷新资源绑定失败：${errorText(reason)}`); });
    return () => { live = false; };
  }, [roleId, bindingLoaded, bindingBusy, removedResources]);
  useEffect(() => { if (!active) return; if (section === 'look') setLoaded(v => ({ ...v, look: true })); if (section === 'models' && (modelPart === 'voice' || modelPart === 'image')) setLoaded(v => ({ ...v, [modelPart]: true })); }, [active, section, modelPart]);
  useEffect(() => { let live = true; api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`).then(result => { if (live) setOutfitId(typeof result.state.outfitId === 'string' ? result.state.outfitId : ''); }).catch(() => { if (live) setOutfitId(''); }); return () => { live = false; }; }, [roleId, lookVersion]);
  const extensions = bindings.filter(item => item.capability === 'mcp' || item.capability === 'skill');
  const saveProfile = async () => {
    if (!draft || saveBusy || activity?.state !== 'stopped' || !draft.name.trim() || !draft.definition.trim()) return;
    setSaveBusy(true); setDetailError(''); setSaveMessage('');
    try {
      const saved = await api<{ definitionRevision: number; updatedAt: string }>(`/v1/roles/${encodeURIComponent(roleId)}/definition`, { method: 'PATCH', body: { displayName: draft.name.trim(), definition: { text: draft.definition.trim(), payload: draft.payload }, expectedRevision: draft.revision } });
      const next = { name: draft.name.trim(), definition: draft.definition.trim(), payload: draft.payload, revision: saved.definitionRevision };
      setSavedProfile(next); setDraft(next);
      setSaveMessage('角色设定已保存。'); await onRefresh();
    } catch (e) { setDetailError(errorText(e)); } finally { setSaveBusy(false); }
  };
  const saveBindings = async (scope: 'models' | 'ext') => {
    if (bindingLock.current || activity?.state !== 'stopped' || !bindingRevision) return;
    if (scope === 'models' && ((modelDraft.chatResource && !modelDraft.chatModel.trim()) || (modelDraft.memoryResource && !modelDraft.memoryModel.trim()))) { setBindingError('已选择的模型服务需要填写模型 ID。'); return; }
    bindingLock.current = true; setBindingBusy(true); setBindingError(''); setBindingNotice('');
    try {
      const asInput = (item: Binding) => ({ capability: item.capability, resourceId: item.resourceId, enabled: item.enabled, ...(item.modelName ? { modelName: item.modelName } : {}) });
      const previous = bindings.filter(item => scope === 'models' ? item.capability !== 'chat_model' && item.capability !== 'memory_model' : item.capability !== 'mcp' && item.capability !== 'skill').map(asInput);
      const next = scope === 'models' ? [
        ...(modelDraft.chatResource ? [{ capability: 'chat_model', resourceId: modelDraft.chatResource, modelName: modelDraft.chatModel.trim(), enabled: bindings.find(item => item.capability === 'chat_model' && item.resourceId === modelDraft.chatResource)?.enabled ?? true }] : []),
        ...(modelDraft.memoryResource ? [{ capability: 'memory_model', resourceId: modelDraft.memoryResource, modelName: modelDraft.memoryModel.trim(), enabled: bindings.find(item => item.capability === 'memory_model' && item.resourceId === modelDraft.memoryResource)?.enabled ?? true }] : []),
      ] : [
        ...bindings.filter(item => (item.capability === 'mcp' || item.capability === 'skill') && !resources.some(resource => resource.resourceId === item.resourceId)).map(asInput),
        ...resources.filter(item => (item.kind === 'mcp' || item.kind === 'skill') && (extensionDraft[item.resourceId] || bindings.some(binding => binding.resourceId === item.resourceId && binding.capability === item.kind))).map(item => ({ capability: item.kind, resourceId: item.resourceId, enabled: !!extensionDraft[item.resourceId] })),
      ];
      const result = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, { method: 'PUT', body: { bindings: [...previous, ...next], expectedRevision: bindingRevision } });
      setBindings(result.items); setBindingRevision(result.revision); setBindingNotice(scope === 'models' ? '模型选择已保存。' : '扩展选择已保存。');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BINDING_REVISION_CONFLICT') {
        setBindingRevision('');
        setBindingError('绑定已被其他操作修改。请重新读取绑定后检查草稿，再保存。');
      } else setBindingError(errorText(e));
    } finally { bindingLock.current = false; setBindingBusy(false); }
  };
  const reloadBindings = async () => {
    if (bindingLock.current || bindingBusy) return;
    bindingLock.current = true; setBindingBusy(true); setBindingRevision(''); setBindingError('');
    const before = bindings;
    try {
      const result = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`);
      mergeRefreshedBindings(before, result, removedResources);
      setBindingLoaded(true);
      syncedRemovals.current = removedResources.join('|');
      setBindingNotice('已读取最新绑定；未保存的修改已保留，请检查后保存。');
    } catch (error) { setBindingError(`重新读取绑定失败：${errorText(error)}`); }
    finally { bindingLock.current = false; setBindingBusy(false); }
  };
  const saveBudget = async () => {
    if (budgetBusy || activity?.state !== 'stopped' || !Number.isInteger(budgetDraft.dailyLimit) || budgetDraft.dailyLimit < 1 || budgetDraft.dailyLimit > 1_000_000) return;
    setBudgetBusy(true); setBudgetError(''); setBudgetNotice('');
    try { const result = await api<NonNullable<typeof budget>>(`/v1/roles/${encodeURIComponent(roleId)}/autonomy/budget`, { method: 'PUT', body: budgetDraft }); setBudget(result); setBudgetDraft({ dailyLimit: result.dailyLimit, unlimited: result.unlimited }); setBudgetNotice('自主额度已保存。'); }
    catch (e) { setBudgetError(errorText(e)); } finally { setBudgetBusy(false); }
  };
  const savedChat = bindings.find(item => item.capability === 'chat_model');
  const savedMemory = bindings.find(item => item.capability === 'memory_model');
  const dirtyProfile = !!draft && !!savedProfile && (draft.name !== savedProfile.name || draft.definition !== savedProfile.definition);
  const dirtyModels = bindingLoaded && (modelDraft.chatResource !== (savedChat?.resourceId || '') || (!!modelDraft.chatResource && modelDraft.chatModel !== (savedChat?.modelName || '')) || modelDraft.memoryResource !== (savedMemory?.resourceId || '') || (!!modelDraft.memoryResource && modelDraft.memoryModel !== (savedMemory?.modelName || '')));
  const dirtyExt = bindingLoaded && resources.some(item => (item.kind === 'mcp' || item.kind === 'skill') && !!extensionDraft[item.resourceId] !== !!bindings.find(binding => binding.capability === item.kind && binding.resourceId === item.resourceId)?.enabled);
  const dirtyQuota = !!budget && (budgetDraft.dailyLimit !== budget.dailyLimit || budgetDraft.unlimited !== budget.unlimited);
  useEffect(() => {
    const discard = () => {
      if (savedProfile) setDraft(savedProfile);
      setModelDraft({ chatResource: savedChat?.resourceId || '', chatModel: savedChat?.modelName || '', memoryResource: savedMemory?.resourceId || '', memoryModel: savedMemory?.modelName || '' });
      setExtensionDraft(Object.fromEntries(bindings.filter(item => item.capability === 'mcp' || item.capability === 'skill').map(item => [item.resourceId, item.enabled])));
      if (budget) setBudgetDraft({ dailyLimit: budget.dailyLimit, unlimited: budget.unlimited });
      voiceDraft?.discard(); imageDraft?.discard();
      setDetailError(''); if (bindingRevision) setBindingError(''); setBudgetError('');
    };
    onEditorState(roleId, { dirty: { profile: dirtyProfile, models: dirtyModels, voice: !!voiceDraft?.dirty, image: !!imageDraft?.dirty, ext: dirtyExt, quota: dirtyQuota }, busy: saveBusy || bindingBusy || budgetBusy || !!voiceDraft?.busy || !!imageDraft?.busy, discard });
  }, [roleId, onEditorState, dirtyProfile, dirtyModels, dirtyExt, dirtyQuota, saveBusy, bindingBusy, bindingRevision, budgetBusy, savedProfile, bindings, budget, voiceDraft, imageDraft]);
  useEffect(() => () => onEditorState(roleId, null), [roleId, onEditorState]);
  const list = (items: Binding[]) => items.length ? items.map(item => <div className="config-row" key={`${item.capability}-${item.resourceId}`}><span><strong>{resources.find(resource => resource.resourceId === item.resourceId)?.name || item.resourceId}</strong><small>{item.capability}{item.modelName ? ` · ${item.modelName}` : ''}</small></span><span>{item.enabled ? '角色已开启' : '角色已关闭'}</span></div>) : <p className="config-muted">暂无绑定。</p>;
  const statusNote = activity?.state !== 'stopped' && <div className="config-active-note"><span>◉</span><p><b>{draft?.name || '角色'}{activity?.state === 'stopping' ? '正在停止' : activity ? '启用中' : '状态未获取'}</b>　可以先修改草稿；保存前需要在「设置 · 角色状态」确认停止。</p><button type="button" onClick={() => onOpenSettings('roles')}>去角色状态</button></div>;
  const footer = document.getElementById('config-leaf-actions');
  const selectedModel = (id: string) => resources.find(item => item.resourceId === id)?.name || (id ? '资源不可用' : '未选择');
  const modelOptions = resources.filter(item => item.kind === 'model');
  const needsBindingRead = !bindingRevision && (bindingLoaded || !!bindingError);
  const bindingProblem = bindingError || (needsBindingRead ? '绑定尚未同步，请重新读取。' : '');
  const bindingAlert = (bindingProblem || resourceError) && <p role="alert">{bindingProblem || resourceError}{needsBindingRead && <button type="button" disabled={bindingBusy} onClick={() => void reloadBindings()}>重试读取绑定</button>}</p>;
  return <><div hidden={!active} className="config-role-editor">
    <div hidden={section !== 'profile'} className="config-prose">
      <ConfigHeading number="01" label="设定" english="PROFILE" title="设定" description="显示名和人设直接参与提示词；修改是同一角色的修订，不会重建角色。"/>
      {statusNote}{detailError && <p role="alert">{detailError}</p>}{saveMessage && <p role="status">{saveMessage}</p>}
      {draft && <><div className="config-ledger"><div className="config-ledger-label"><b>显示名</b><small>对话、主页与日记里的称呼</small></div><div><Input aria-label="显示名" disabled={saveBusy} value={draft.name} maxLength={200} onChange={event => setDraft({ ...draft, name: event.target.value })}/></div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>人设</b><small>她是谁、怎么说话、在意什么<br/>{draft.definition.length} 字</small></div><div><Textarea aria-label="角色设定" className="config-ruled" disabled={saveBusy} rows={8} value={draft.definition} onChange={event => setDraft({ ...draft, definition: event.target.value })}/></div></div>
      <RoleDeletion roleId={roleId} roleName={draft.name} roleCount={roleCount} stopped={activity?.state === 'stopped'} onDeleted={onDeleted}/></>}
    </div>
    <div hidden={section !== 'look'} className="config-prose"><ConfigHeading number="02" label="外观" english="WARDROBE" title="衣柜" description="服饰的主页立绘与对话差分。点开一套服饰查看素材。"/>{statusNote}{loaded.look && <AppearancePanel roleId={roleId} currentOutfitId={outfitId} canWrite={activity?.state === 'stopped'} onPreview={onPreviewOutfit} onPreviewAsset={onPreviewAsset} onChanged={() => { onClearPreview(); setLookVersion(v => v + 1); void onRefresh(); }}/>}</div>
    <div hidden={section !== 'models'} className="config-prose"><ConfigHeading number="03" label="模型" english="MODELS" title="模型" description="模型列表和连接测试在设置里；这里配置角色使用的模型和演出。"/>{statusNote}{bindingAlert}
      <div className="config-model-head"><span>用途</span><span>所选模型</span><span>已保存</span><span>当前状态</span></div>
      {([['chat','对话'],['memory','记忆整理'],['image','生图'],['voice','语音']] as const).map(([id,label]) => <div className="config-model-row" key={id}>
        <button type="button" className="config-model-toggle" aria-expanded={modelPart === id} onClick={() => setModelPart(id)}><strong>{label}</strong><span>{id === 'chat' ? selectedModel(modelDraft.chatResource) : id === 'memory' ? (modelDraft.memoryResource ? selectedModel(modelDraft.memoryResource) : '跟随对话模型') : '角色配置'}</span><small>{id === 'chat' || id === 'memory' ? (bindings.some(item => item.capability === (id === 'chat' ? 'chat_model' : 'memory_model') && item.enabled) ? '已保存' : '未单独设置') : '查看配置'}</small><span>⌄</span></button>
        <div hidden={modelPart !== id} className="config-model-details">
          {id === 'chat' && bindingLoaded && <><Field label="对话模型：从设置里已保存的模型中选择"><Select disabled={bindingBusy} value={modelDraft.chatResource} onChange={event => setModelDraft(previous => ({ ...previous, chatResource: event.target.value }))}><option value="">未选择</option>{modelOptions.map(item => <option value={item.resourceId} key={item.resourceId}>{item.name}{item.enabled ? '' : '（全局已停用）'}</option>)}</Select></Field><Field label="模型 ID"><Input disabled={bindingBusy} value={modelDraft.chatModel} onChange={event => setModelDraft(previous => ({ ...previous, chatModel: event.target.value }))}/></Field></>}
          {id === 'memory' && bindingLoaded && <><Field label="记忆模型"><Select disabled={bindingBusy} value={modelDraft.memoryResource} onChange={event => setModelDraft(previous => ({ ...previous, memoryResource: event.target.value }))}><option value="">跟随对话模型</option>{modelOptions.map(item => <option value={item.resourceId} key={item.resourceId}>{item.name}{item.enabled ? '' : '（全局已停用）'}</option>)}</Select></Field>{modelDraft.memoryResource && <Field label="模型 ID"><Input disabled={bindingBusy} value={modelDraft.memoryModel} onChange={event => setModelDraft(previous => ({ ...previous, memoryModel: event.target.value }))}/></Field>}</>}
          {(id === 'chat' || id === 'memory') && <><button type="button" onClick={() => onOpenSettings('model')}>在设置中查看模型 →</button><button type="button" onClick={() => onCreateModel({ roleId, part: id, previousResource: id === 'chat' ? modelDraft.chatResource : modelDraft.memoryResource })}>＋ 新建模型服务</button>{bindingNotice && <p role="status">{bindingNotice}</p>}<Button disabled={bindingBusy || !bindingRevision || !!resourceError || activity?.state !== 'stopped'} onClick={() => void saveBindings('models')}>保存模型选择</Button></>}
          {id === 'voice' && loaded.voice && <VoicePanel roleId={roleId} active={active && section === 'models' && modelPart === 'voice'} onDraftStateChange={setVoiceDraft} onChanged={() => { void onRefresh(); }}/>} {id === 'image' && loaded.image && <ImagePanel roleId={roleId} onDraftStateChange={setImageDraft} onChanged={() => { void onRefresh(); }}/>}
        </div></div>)}
    </div>
    <div hidden={section !== 'ext'} className="config-prose"><ConfigHeading number="04" label="扩展" english="EXTENSIONS" title="扩展" description="设置里的 MCP 与 Skill 在这里按角色开启或关闭。"/>{statusNote}{bindingAlert}{(['mcp','skill'] as const).map(kind => <div className="config-ledger" key={kind}><div className="config-ledger-label"><b>{kind === 'mcp' ? 'MCP' : 'Skill'}</b><small>{resources.filter(item => item.kind === kind).length} 项</small></div><div>{resources.filter(item => item.kind === kind).map(item => <label className="config-row" key={item.resourceId}><span><strong>{item.name}</strong><small>{item.enabled ? '全局已启用' : '全局已停用'}</small></span><span><input type="checkbox" disabled={bindingBusy || !bindingLoaded} checked={extensionDraft[item.resourceId] || false} onChange={event => setExtensionDraft(previous => ({ ...previous, [item.resourceId]: event.target.checked }))}/> 角色开启</span></label>)}{!resources.some(item => item.kind === kind) && <p className="config-muted">暂无{kind === 'mcp' ? ' MCP' : ' Skill'}。</p>}</div></div>)}{!bindingLoaded && list(extensions)}{bindingNotice && <p role="status">{bindingNotice}</p>}<Button disabled={bindingBusy || !bindingRevision || !!resourceError || activity?.state !== 'stopped'} onClick={() => void saveBindings('ext')}>保存扩展</Button><button type="button" className="config-text-button" onClick={() => onOpenSettings('mcp')}>在设置中管理 →</button></div>
    <div hidden={section !== 'quota'} className="config-prose"><ConfigHeading number="05" label="自主额度" english="QUOTA" title="自主额度" description="角色后台活动所消耗的点数。"/>{statusNote}{budgetError && <p role="alert">{budgetError}</p>}{budget ? <><div className="config-ledger"><div className="config-ledger-label"><b>今日</b><small>{budget.localDate}</small></div><div><div className="config-quota-number">{budget.usedPoints} <small>/ {budget.unlimited ? '不限' : budget.dailyLimit} 点</small></div><div className="config-quota-track"><span style={{ width: budget.unlimited ? '0%' : `${Math.min(100, budget.dailyLimit ? budget.usedPoints / budget.dailyLimit * 100 : 0)}%` }}/></div></div></div><div className="config-ledger"><div className="config-ledger-label"><b>每日额度</b><small>角色自主活动</small></div><div><div className="config-quota-input"><Input type="number" min={1} max={1000000} disabled={budgetBusy || budgetDraft.unlimited} value={budgetDraft.dailyLimit} aria-label="每日额度" onChange={event => setBudgetDraft({ ...budgetDraft, dailyLimit: Number(event.target.value) })}/><label><input type="checkbox" disabled={budgetBusy} checked={budgetDraft.unlimited} onChange={event => setBudgetDraft({ ...budgetDraft, unlimited: event.target.checked })}/> 不限制</label></div><p className="config-muted">保存前需要后端确认角色已停止。</p><Button disabled={budgetBusy || activity?.state !== 'stopped' || !Number.isInteger(budgetDraft.dailyLimit) || budgetDraft.dailyLimit < 1 || budgetDraft.dailyLimit > 1_000_000} onClick={() => void saveBudget()}>保存额度</Button>{budgetNotice && <p role="status">{budgetNotice}</p>}</div></div></> : !budgetError && <p>正在读取额度…</p>}</div>
    <div hidden={section !== 'done'} className="config-prose"><ConfigHeading number="06" label="完成度" english="CHECKLIST" title="完成度" description="按已保存的配置查看当前状态；必需项仍待确认。"/>{[['设定',savedProfile?.definition ? '已保存' : '尚未读取'],['对话模型',bindings.some(item => item.capability === 'chat_model' && item.enabled) ? '已绑定' : '未绑定'],['记忆整理',bindings.some(item => item.capability === 'memory_model' && item.enabled) ? '已绑定' : '跟随对话模型'],['角色状态',activityText(activity)]].map(([label,value],i) => <div className="config-check-row" key={label}><small>{String(i+1).padStart(2,'0')}</small><b>{label}</b><i/><span>{value}</span></div>)}</div>
  </div>{active && section === 'profile' && draft && footer && createPortal(<>{dirtyProfile && <Button disabled={saveBusy} onClick={() => { if (savedProfile) setDraft(savedProfile); }}>放弃</Button>}<Button disabled={saveBusy || activity?.state !== 'stopped' || !draft.name.trim() || !draft.definition.trim()} onClick={() => void saveProfile()}>保存设定</Button></>, footer)}</>;
}

function ConfigHeading({ number, label, english, title, description }: { number: string; label: string; english: string; title: string; description: string }) {
  return <header className="config-section-heading"><small><i>{number}</i> {label} · {english}</small><h2>{title}</h2><p>{description}</p></header>;
}

function RoleDeletion({ roleId, roleName, roleCount, stopped, onDeleted }: { roleId: string; roleName: string; roleCount: number; stopped: boolean; onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [choice, setChoice] = useState<'keep' | 'remove' | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (busy || !choice || !stopped || roleCount < 2) return;
    const keepHistory = choice === 'keep';
    setBusy(true); setError('');
    try {
      const result = await api<{ roleId: string; keepHistory: boolean; filesRemoved: boolean }>(`/v1/roles/${encodeURIComponent(roleId)}?keepHistory=${keepHistory ? '1' : '0'}`, { method: 'DELETE' });
      await onDeleted(result.roleId, result.keepHistory, result.filesRemoved);
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <div className="config-ledger"><div className="config-ledger-label"><b>删除角色</b></div><div>
    <Button disabled={!stopped || roleCount < 2 || busy} onClick={event => { trigger.current = event.currentTarget; setOpen(true); setChoice(''); setError(''); }}>删除角色</Button>
    {roleCount < 2 ? <small className="config-inline-hint">至少保留一个角色。</small> : !stopped ? <small className="config-inline-hint">请先在角色状态中停止该角色。</small> : null}
    {open && <fieldset className="config-delete-options"><legend>删除「{roleName}」</legend><p>请选择记忆、对话和角色目录的处理方式：</p>
      <label><input type="radio" name={`delete-${roleId}`} checked={choice === 'keep'} disabled={busy} onChange={() => setChoice('keep')}/> 保留本机数据（移除角色，保留目录；应用内无法读取已删除角色）</label>
      <label><input type="radio" name={`delete-${roleId}`} checked={choice === 'remove'} disabled={busy} onChange={() => setChoice('remove')}/> 一并删除本机数据（包括记忆、对话、工作区与素材副本）</label>
      <p>原始素材文件不会被删除。</p>{error && <p role="alert">{error}</p>}
      <div className="config-actions"><Button disabled={!choice || busy || !stopped || roleCount < 2} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</Button><button type="button" disabled={busy} onClick={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }}>取消</button></div>
    </fieldset>}
  </div></div>;
}

function ResourceDetail({ resource, active, canWrite, onRemoved, onUpdated }: { resource: Resource; active: boolean; canWrite: boolean; onRemoved: (id: string) => void; onUpdated: () => void }) {
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState(resource.name);
  const [draftProtocol, setDraftProtocol] = useState(String(resource.config.protocol || 'openai-chat'));
  const [draftUrl, setDraftUrl] = useState(String(resource.config.baseUrl || ''));
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>('keep');
  const [secret, setSecret] = useState('');
  const modelDirty = draftName !== resource.name || draftProtocol !== String(resource.config.protocol || 'openai-chat') || draftUrl !== String(resource.config.baseUrl || '') || keyMode !== 'keep';
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = async (kind: 'models' | 'model-test') => {
    if (busy || modelDirty || (kind === 'model-test' && !model.trim())) return;
    setBusy(true); setMessage('');
    try { const result = await api<{ models?: string[]; ok?: boolean; error?: { message: string } }>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/${kind}`, { method: 'POST', ...(kind === 'model-test' ? { body: { model: model.trim() } } : {}) }); if (!live.current) return; if (kind === 'models') { setModels(result.models || []); setMessage(`已获取 ${result.models?.length || 0} 个模型。`); } else { setMessage(result.ok ? '连接测试成功。' : `连接测试失败：${result.error?.message || '服务未返回成功结果'}`); onUpdated(); } } catch (e) { if (live.current) setMessage(errorText(e)); } finally { if (live.current) setBusy(false); }
  };
  const save = async () => {
    if (busy || !canWrite || !draftName.trim() || !draftUrl.trim() || (keyMode === 'replace' && !secret)) return;
    setBusy(true); setMessage('');
    try {
      const config: Record<string, unknown> = { ...resource.config, protocol: draftProtocol, baseUrl: draftUrl.trim() };
      if (keyMode !== 'keep') delete config.credentialRef;
      const result = await api<Resource>(`/v1/resources/${encodeURIComponent(resource.resourceId)}`, { method: 'PATCH', body: { name: draftName.trim(), config, ...(keyMode === 'replace' ? { secret } : keyMode === 'clear' ? { secret: null } : {}) } });
      if (!live.current) return;
      setDraftName(result.name); setDraftProtocol(String(result.config.protocol || '')); setDraftUrl(String(result.config.baseUrl || '')); setKeyMode('keep'); setSecret(''); setMessage('模型服务已保存。'); onUpdated();
    } catch (e) { if (live.current) setMessage(errorText(e)); } finally { if (live.current) setBusy(false); }
  };
  const subtitle = resource.kind === 'model' ? '角色在配置页选择已保存的模型服务。' : resource.kind === 'mcp' ? '本地 MCP 服务，在角色配置的扩展中开启。' : '本地 Skill 目录，在角色配置的扩展中开启。';
  return <div hidden={!active} className="config-prose"><ConfigHeading number={resource.kind === 'model' ? '01' : resource.kind === 'mcp' ? '02' : '03'} label={resource.kind === 'model' ? '模型 · 对话' : resource.kind === 'mcp' ? 'MCP' : 'Skill'} english="" title={resource.name} description={subtitle}/>
    <div className="config-ledger"><div className="config-ledger-label"><b>状态</b><small>全局</small></div><div>{resource.enabled ? '已启用' : '已停用'}</div></div>
    {resource.kind === 'model' ? <><div className="config-ledger"><div className="config-ledger-label"><b>名称</b><small>模型服务</small></div><div><Input disabled={busy} aria-label="模型服务名称" value={draftName} onChange={event => setDraftName(event.target.value)}/></div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>连接</b><small>协议与地址</small></div><div className="config-connection"><Field label="协议"><Select disabled={busy} value={draftProtocol} onChange={event => setDraftProtocol(event.target.value)}><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></Select></Field><Field label="服务地址"><Input disabled={busy} value={draftUrl} onChange={event => setDraftUrl(event.target.value)}/></Field></div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>密钥</b><small>只写</small></div><div><p>密钥状态：{resource.credential?.status || '未知'}；密钥原文不会显示。</p><div className="config-subtabs" role="group" aria-label="密钥操作">{([['keep','保留'],['replace','替换'],['clear','清除']] as const).map(([id,label]) => <button key={id} type="button" disabled={busy} aria-pressed={keyMode === id} onClick={() => { setKeyMode(id); setSecret(''); }}>{label}</button>)}</div>{keyMode === 'replace' && <Field label="新密钥"><Input type="password" autoComplete="off" disabled={busy} value={secret} onChange={event => setSecret(event.target.value)}/></Field>}</div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>模型</b><small>获取或手填</small></div><div><div className="config-actions"><Button disabled={busy || modelDirty} onClick={() => void run('models')}>读取模型列表</Button><Button disabled={busy || modelDirty || !model.trim()} onClick={() => void run('model-test')}>测试连接</Button></div>{modelDirty && <p className="config-muted">列表和测试使用已保存的服务配置，请先保存当前修改。</p>}<Field label="模型 ID（手填）"><Input value={model} list={`config-model-options-${resource.resourceId}`} onChange={event => setModel(event.target.value)}/></Field><datalist id={`config-model-options-${resource.resourceId}`}>{models.map(item => <option value={item} key={item}/>)}</datalist><p>最近测试：{!resource.lastTest ? '尚未测试' : resource.lastTest.stale ? '配置已改变，请重新测试' : resource.lastTest.ok ? `成功 · ${resource.lastTest.modelName}` : `失败 · ${resource.lastTest.modelName}`}</p></div></div><div className="config-ledger"><div className="config-ledger-label"><b>保存</b></div><div><Button disabled={busy || !canWrite || !draftName.trim() || !draftUrl.trim() || (keyMode === 'replace' && !secret)} onClick={() => void save()}>保存模型服务</Button>{!canWrite && <p className="config-muted">修改前需要在角色状态中确认所有角色已停止。</p>}</div></div>{message && <p role="status">{message}</p>}<ModelManagement resource={resource} active={active} canWrite={canWrite} onRemoved={onRemoved} onUpdated={onUpdated}/></> : <>
      {resource.kind === 'mcp' && <><div className="config-ledger"><div className="config-ledger-label"><b>启动命令</b><small>stdio</small></div><div><code>{String(resource.config.command || '')} {Array.isArray(resource.config.args) ? resource.config.args.join(' ') : ''}</code></div></div><div className="config-ledger"><div className="config-ledger-label"><b>环境变量</b></div><div><code>{Object.keys((resource.config.env || {}) as Record<string, unknown>).join('、') || '没有设置环境变量'}</code></div></div></>}
      {resource.kind === 'skill' && <div className="config-ledger"><div className="config-ledger-label"><b>来源目录</b></div><div><code>{String(resource.config.sourcePath || '')}</code></div></div>}
      <ExtensionManagement resource={resource} active={active} onRemoved={onRemoved} onUpdated={onUpdated}/>
    </>}</div>;
}

type ResourceReferences = { references: Array<{ roleId: string; reason: 'ROLE_BINDING' | 'TASK_CHAIN'; bindingEnabled: boolean | null; taskId?: string }>; canUpdate: boolean; canDisable: boolean; canDelete: boolean };

function ModelManagement({ resource, active, canWrite, onRemoved, onUpdated }: { resource: Resource; active: boolean; canWrite: boolean; onRemoved: (id: string) => void; onUpdated: () => void }) {
  const [report, setReport] = useState<ResourceReferences | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true; setReport(null); setError('');
    api<ResourceReferences>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/references`).then(value => { if (live) setReport(value); }).catch(reason => { if (live) setError(errorText(reason)); });
    return () => { live = false; };
  }, [active, resource.resourceId, version]);
  const change = async (remove: boolean) => {
    if (busy || !canWrite || !report || (remove && !report.canDelete) || (!remove && resource.enabled && !report.canDisable)) return;
    setBusy(true); setError('');
    try {
      await api(`/v1/resources/${encodeURIComponent(resource.resourceId)}`, remove ? { method: 'DELETE' } : { method: 'PATCH', body: { enabled: !resource.enabled } });
      if (remove) onRemoved(resource.resourceId); setConfirm(false); setVersion(value => value + 1); onUpdated();
    } catch (reason) { setError(errorText(reason)); setVersion(value => value + 1); } finally { setBusy(false); }
  };
  return <div className="config-ledger"><div className="config-ledger-label"><b>管理</b><small>全局模型服务</small></div><div>
    {!canWrite && <p>修改或删除模型前，需要所有角色停止。</p>}
    {report && report.references.length > 0 && <ul>{report.references.map((item, index) => <li key={`${item.roleId}-${item.taskId || index}`}>{item.roleId} · {item.reason === 'TASK_CHAIN' ? '任务仍在使用' : item.bindingEnabled ? '角色已选择并启用' : '角色已选择但关闭'}</li>)}</ul>}
    {report && !report.canDelete && <p>有角色或任务正在使用，请先解除占用。</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setVersion(value => value + 1)}>重试</button></p>}
    <div className="config-actions"><Button disabled={busy || !canWrite || !report || (resource.enabled && !report.canDisable)} onClick={() => void change(false)}>{resource.enabled ? '全局停用' : '全局启用'}</Button><Button disabled={busy || !canWrite || !report?.canDelete} onClick={() => setConfirm(true)}>删除模型服务</Button></div>
    {confirm && <div role="alert"><p>删除「{resource.name}」及其保存的密钥？此操作无法撤销。</p><Button disabled={busy || !canWrite || !report?.canDelete} onClick={() => void change(true)}>确认删除模型</Button> <button type="button" disabled={busy} onClick={() => setConfirm(false)}>取消</button></div>}
  </div></div>;
}

function ExtensionCreate({ kind, active, onCancel, onCreated }: { kind: 'mcp' | 'skill'; active: boolean; onCancel: () => void; onCreated: (resource: Resource) => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('{}');
  const [sourcePath, setSourcePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    if (busy || !name.trim()) return;
    let config: Record<string, unknown>;
    if (kind === 'mcp') {
      let variables: unknown;
      try { variables = JSON.parse(env); } catch { setError('环境变量需要是 JSON 对象。'); return; }
      if (!command.trim() || !variables || typeof variables !== 'object' || Array.isArray(variables) || Object.values(variables).some(value => typeof value !== 'string')) { setError('请填写启动命令，环境变量的值须为字符串。'); return; }
      config = { command: command.trim(), args: args.split('\n').filter(Boolean), env: variables };
    } else {
      if (!sourcePath.trim()) { setError('请填写来源目录。'); return; }
      config = { sourcePath: sourcePath.trim() };
    }
    setBusy(true); setError('');
    try {
      const result = await api<Resource>('/v1/resources', { method: 'POST', body: { kind, name: name.trim(), config } });
      setName(''); setCommand(''); setArgs(''); setEnv('{}'); setSourcePath(''); onCreated(result);
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <div className="config-prose" hidden={!active}><ConfigHeading number="＋" label={kind === 'mcp' ? 'MCP' : 'Skill'} english="NEW RESOURCE" title={`添加 ${kind === 'mcp' ? 'MCP' : 'Skill'}`} description="保存后可在角色配置的扩展中选择。"/><Field label="名称"><Input value={name} disabled={busy} onChange={event => setName(event.target.value)}/></Field>{kind === 'mcp' ? <><Field label="启动命令"><Input value={command} disabled={busy} onChange={event => setCommand(event.target.value)}/></Field><Field label="启动参数" hint="每行一个参数。"><Textarea rows={3} value={args} disabled={busy} onChange={event => setArgs(event.target.value)}/></Field><Field label="环境变量" hint="使用 JSON 对象填写，保存后只显示占位符。"><Textarea rows={4} value={env} disabled={busy} onChange={event => setEnv(event.target.value)}/></Field></> : <Field label="来源目录"><Input value={sourcePath} disabled={busy} onChange={event => setSourcePath(event.target.value)}/></Field>}{error && <p role="alert">{error}</p>}<div className="config-actions"><Button disabled={busy || !name.trim()} onClick={() => void create()}>保存资源</Button><button type="button" onClick={onCancel}>返回目录</button></div></div>;
}

function ExtensionManagement({ resource, active, onRemoved, onUpdated }: { resource: Resource; active: boolean; onRemoved: (id: string) => void; onUpdated: () => void }) {
  const [report, setReport] = useState<ResourceReferences | null>(null);
  const [reportError, setReportError] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(resource.name);
  const [command, setCommand] = useState(String(resource.config.command || ''));
  const [args, setArgs] = useState(Array.isArray(resource.config.args) ? resource.config.args.join('\n') : '');
  const [env, setEnv] = useState(JSON.stringify(resource.config.env || {}, null, 2));
  const [sourcePath, setSourcePath] = useState(String(resource.config.sourcePath || ''));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true; setReport(null); setReportError('');
    api<ResourceReferences>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/references`).then(value => { if (live) setReport(value); }).catch(error => { if (live) setReportError(errorText(error)); });
    return () => { live = false; };
  }, [active, resource.resourceId, version]);
  const run = async (operation: 'save' | 'enable' | 'disable' | 'delete') => {
    if (busy || !report || (operation === 'save' && !report.canUpdate) || (operation === 'disable' && !report.canDisable) || (operation === 'delete' && !report.canDelete)) return;
    let body: Record<string, unknown> | undefined;
    if (operation === 'save') {
      if (!name.trim()) { setMessage('请填写名称。'); return; }
      if (resource.kind === 'mcp') {
        let variables: unknown;
        try { variables = JSON.parse(env); } catch { setMessage('环境变量需要是 JSON 对象。'); return; }
        if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.values(variables).some(value => typeof value !== 'string') || !command.trim()) { setMessage('请填写启动命令，环境变量的值须为字符串。'); return; }
        body = { name: name.trim(), config: { command: command.trim(), args: args.split('\n').filter(Boolean), env: variables } };
      } else {
        if (!sourcePath.trim()) { setMessage('请填写来源目录。'); return; }
        body = { name: name.trim(), config: { sourcePath: sourcePath.trim() } };
      }
    } else if (operation !== 'delete') body = { enabled: operation === 'enable' };
    setBusy(true); setMessage('');
    try {
      const updated = await api<Resource>(`/v1/resources/${encodeURIComponent(resource.resourceId)}`, { method: operation === 'delete' ? 'DELETE' : 'PATCH', ...(body ? { body } : {}) });
      if (operation === 'save' && resource.kind === 'mcp') setEnv(JSON.stringify(updated.config.env || {}, null, 2));
      if (operation === 'delete') onRemoved(resource.resourceId);
      setEditing(false); setConfirmDelete(false); setMessage(operation === 'delete' ? '资源已删除。' : operation === 'save' ? '资源已保存。' : operation === 'enable' ? '已全局启用。' : '已全局停用。');
      setVersion(value => value + 1); onUpdated();
    } catch (error) { setMessage(errorText(error)); setVersion(value => value + 1); }
    finally { setBusy(false); }
  };
  return <div className="config-ledger"><div className="config-ledger-label"><b>管理</b><small>资源与占用</small></div><div>
    {reportError ? <p role="alert">无法读取占用情况：{reportError} <button type="button" onClick={() => setVersion(value => value + 1)}>重试</button></p> : !report ? <p>正在读取占用情况…</p> : <>{report.references.length > 0 ? <ul>{report.references.map((item, index) => <li key={`${item.roleId}-${item.reason}-${item.taskId || index}`}>{item.roleId} · {item.reason === 'TASK_CHAIN' ? `任务仍在使用${item.taskId ? `（${item.taskId}）` : ''}` : item.bindingEnabled ? '角色已开启' : '角色已关闭'}</li>)}</ul> : <p className="config-muted">当前没有角色或任务引用。</p>}{!report.canUpdate && <p className="config-muted">角色已开启或任务仍在使用，请先关闭角色开关并等待任务结束。</p>}</>}
    <div className="config-actions"><Button disabled={busy || !report?.canUpdate} onClick={() => setEditing(value => !value)}>{editing ? '收起编辑' : '编辑'}</Button><Button disabled={busy || !report || (resource.enabled && !report.canDisable)} onClick={() => void run(resource.enabled ? 'disable' : 'enable')}>{resource.enabled ? '全局停用' : '全局启用'}</Button><Button disabled={busy || !report?.canDelete} onClick={() => setConfirmDelete(true)}>删除</Button></div>
    {editing && <div><Field label="名称"><Input value={name} disabled={busy} onChange={event => setName(event.target.value)}/></Field>{resource.kind === 'mcp' ? <><Field label="启动命令"><Input value={command} disabled={busy} onChange={event => setCommand(event.target.value)}/></Field><Field label="启动参数" hint="每行一个参数。"><Textarea rows={3} value={args} disabled={busy} onChange={event => setArgs(event.target.value)}/></Field><Field label="环境变量" hint="JSON 对象；*** 表示保留原值。"><Textarea rows={4} value={env} disabled={busy} onChange={event => setEnv(event.target.value)}/></Field></> : <Field label="来源目录"><Input value={sourcePath} disabled={busy} onChange={event => setSourcePath(event.target.value)}/></Field>}<Button disabled={busy || !report?.canUpdate} onClick={() => void run('save')}>保存资源</Button></div>}
    {confirmDelete && <div role="alert"><p>删除「{resource.name}」及其已关闭的角色绑定？</p><Button disabled={busy || !report?.canDelete} onClick={() => void run('delete')}>确认删除</Button> <button type="button" onClick={() => setConfirmDelete(false)}>取消</button></div>}
    {message && <p role="status">{message}</p>}
  </div></div>;
}

function ImageServiceDetail({ service }: { service?: ImageService }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const probe = async () => {
    if (!service || busy) return;
    setBusy(true); setMessage('');
    try { const result = await api<{ probe: { reachable: boolean; workflowReady: boolean; missingNodes: string[] } }>(`/v1/image-services/${encodeURIComponent(service.serviceId)}/probe`, { method: 'POST' }); if (live.current) setMessage(!result.probe.reachable ? '服务不可达。' : result.probe.workflowReady ? '已连接，工作流节点就绪。' : `已连接，缺少工作流节点：${result.probe.missingNodes.join('、') || '未知'}`); }
    catch (e) { if (live.current) setMessage(errorText(e)); } finally { if (live.current) setBusy(false); }
  };
  if (!service) return <div className="config-prose"><ConfigHeading number="01" label="模型 · 生图" english="IMAGE" title="生图服务" description="选择已保存的生图服务；角色的提示词与工作流在角色配置中管理。"/></div>;
  return <div className="config-prose"><ConfigHeading number="01" label="模型 · 生图" english="IMAGE" title={service.name} description="ComfyUI 生图服务。"/><div className="config-ledger"><div className="config-ledger-label"><b>连接</b><small>服务地址</small></div><div><Input value={service.config.baseUrl} readOnly/></div></div><div className="config-ledger"><div className="config-ledger-label"><b>密钥</b></div><div>{service.credential.status}</div></div><div className="config-ledger"><div className="config-ledger-label"><b>测试</b></div><div><Button disabled={busy} onClick={() => void probe()}>{busy ? '正在测试…' : '测试连接'}</Button>{message && <p role="status">{message}</p>}</div></div></div>;
}
