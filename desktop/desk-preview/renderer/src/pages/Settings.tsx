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
import { ModelNamePicker } from '../components/model/ModelNamePicker';
import { SecretInput } from '../components/model/SecretInput';
import { useModelProbe, type ModelProbeTarget } from '../components/model/use-model-probe';
import {
  applyRevealedSecret,
  createSecretDraft,
  GOOGLE_GEMINI_DEFAULT_BASE_URL,
  hideUneditedSecret,
  nextSecretDraftOnInput,
  resolveModelBaseUrlOnProtocolChange,
  SECRET_MASK_SENTINEL,
  secretOperationOf,
} from '../components/model/model-picker.js';
import { clearModelCache, providerCacheKey, writeModelCache } from '../components/model/model-cache.js';
import { mergeBindingDrafts } from '../components/model/binding-merge.js';
import type { ConfigDraftState } from '../components/config-draft';
import { ImageModelPicker } from '../components/image/ImageModelPicker';
import {
  clearImageModelCache,
  imageServiceCacheKey,
  writeImageModelCache,
} from '../components/image/image-cache.js';
import {
  useImageProbe,
  type ImageProbeTarget,
} from '../components/image/use-image-probe';
import {
  describeImageFailure,
  savedImageModelOf,
} from '../image-config.js';
import { useThemePreset } from '../ui/presets';
import { ConfigThemeTransition } from '../ui/config-theme-transition';

type Resource = { resourceId: string; kind: 'model' | 'mcp' | 'skill'; name: string; enabled: boolean; config: Record<string, unknown>; credential?: { status: string; reference?: string | null; resolvable: boolean }; lastTest?: { ok: boolean; stale: boolean; modelName: string } | null };

function savedModelNameOf(resource: Resource): string {
  if (typeof resource.config.modelName === 'string' && resource.config.modelName.trim()) {
    return resource.config.modelName.trim();
  }
  return resource.lastTest?.modelName ?? '';
}
type ImageService = {
  serviceId: string;
  name: string;
  enabled: boolean;
  updatedAt?: string;
  config: { protocol?: 'comfyui'; baseUrl: string; modelName?: string; credentialRef?: string; timeoutMs?: number };
  credential: { status: string; reference?: string | null; resolvable?: boolean };
};
type Binding = { capability: string; resourceId: string; modelName: string | null; enabled: boolean };
type Activity = { roleId: string; state: 'active' | 'stopping' | 'stopped'; running: boolean; initStatus: string };
type RoleSection = 'profile' | 'look' | 'models' | 'ext' | 'quota' | 'done';
type SettingsSection = 'model' | 'mcp' | 'skill' | 'roles' | 'local';
type OpenSettingsOptions = { modelKind?: 'model' | 'image'; resourceId?: string; newImageService?: boolean };
type Draft = { name: string; definition: string; revision: number; payload: Record<string, unknown> };
const roleSections: Array<[RoleSection, string, string]> = [['profile', '设定', '关于这个人'], ['look', '外观', '立绘与服饰'], ['models', '模型', '对话与演出'], ['ext', '扩展', '工具与知识'], ['quota', '自主额度', '属于自己的时间'], ['done', '完成度', '慢慢补全']];
const settingSections: Array<[SettingsSection, string, string]> = [['model', '模型', '服务与连接'], ['mcp', 'MCP', '工具服务'], ['skill', 'Skill', '方法与知识'], ['roles', '角色状态', '活动与停止'], ['local', '本机', '此设备的偏好']];
const MODEL_PROTOCOL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-gemini', label: 'Google Gemini / Vertex AI' },
];
const modelBaseUrlPlaceholder = (protocol: string) =>
  protocol === 'google-gemini'
    ? GOOGLE_GEMINI_DEFAULT_BASE_URL
    : 'http://127.0.0.1:8000';
const modelBaseUrlHint = (protocol: string) =>
  protocol === 'google-gemini'
    ? '选择 Gemini 时已自动填入 Vertex Express 默认路径；若改用 AI Studio 请填 https://generativelanguage.googleapis.com/v1beta。使用 Vertex Express API Key 时不支持自动拉取列表，请直接手填模型名（如 gemini-3.8-flash）后点击测试。'
    : undefined;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const imageErrorText = (e: unknown) => e instanceof ApiError ? describeImageFailure(e.code, e.message) : errorText(e);
/** 从保存失败的结构化详情里取出本次已暂停的角色（283 R05）。 */
const pausedRoleIdsOf = (e: unknown): string[] => {
  if (!(e instanceof ApiError)) return [];
  const details = e.details;
  if (details === null || typeof details !== 'object') return [];
  const maintenance = (details as { maintenance?: unknown }).maintenance;
  if (maintenance === null || typeof maintenance !== 'object') return [];
  const ids = (maintenance as { pausedRoleIds?: unknown }).pausedRoleIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
};
const activityText = (a?: Activity) => !a ? '状态未获取' : a.state === 'active' ? (a.running ? '运行中' : '已启用') : a.state === 'stopping' ? '正在停止' : '已停止';

type ModelPart = 'chat' | 'memory' | 'voice' | 'image';
type RoleDirty = { profile: boolean; models: boolean; voice: boolean; image: boolean; ext: boolean; quota: boolean };
type RoleEditorState = { dirty: RoleDirty; busy: boolean; discard: () => void };
type Props = { page: string; roles: RoleListItem[]; currentId: string; roleListError: string; onRoleDeleted: (id: string) => void; onSelectCompanion: (id: string) => void; onRefresh: () => Promise<void>; onNavigate: (page: string) => void; workspaceRequest?: { kind: 'section'; roleId: string; section: RoleSection; key: number } | { kind: 'create'; key: number } | null; onStartConversation?: (roleId: string) => void };

/** 两页常驻以保留跨页草稿；编辑对象绝不隐式改变陪伴对象。 */
export function SettingsWorkspace({ page, roles, currentId, roleListError, onRoleDeleted, onSelectCompanion, onRefresh, onNavigate, workspaceRequest, onStartConversation }: Props) {
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
  const [modelKind, setModelKind] = useState<'model' | 'image'>('model');
  const [imageServices, setImageServices] = useState<ImageService[]>([]);
  const [imageServiceError, setImageServiceError] = useState('');
  const [newModel, setNewModel] = useState(false);
  const [newImageService, setNewImageService] = useState(false);
  const [imageServiceVersion, setImageServiceVersion] = useState(0);
  const [imageServiceEpochs, setImageServiceEpochs] = useState<Record<string, number>>({});
  const bumpImageServiceEpoch = (serviceId?: string) => {
    if (!serviceId) return;
    setImageServiceEpochs(previous => ({ ...previous, [serviceId]: (previous[serviceId] ?? 0) + 1 }));
  };
  const [newExtension, setNewExtension] = useState<'mcp' | 'skill' | null>(null);
  const [modelName, setModelName] = useState('');
  const [newModelName, setNewModelName] = useState('');
  const [modelUrl, setModelUrl] = useState('');
  const [modelProtocol, setModelProtocol] = useState('openai-chat');
  const [modelSecret, setModelSecret] = useState('');
  const [showNewSecret, setShowNewSecret] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState('');
  const newModelProbe = useModelProbe(`${modelProtocol}|${modelUrl}|${modelSecret}`);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const roleActive = page === 'role-config';
  const settingsActive = page === 'settings';
  const newModelVisible = settingsActive && settingsSection === 'model' && modelKind === 'model' && newModel;
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
  useEffect(() => {
    if (!roles.some(role => role.roleId === editId)) setEditId(roles.find(role => role.roleId === currentId)?.roleId || roles[0]?.roleId || '');
  }, [roles, currentId, editId]);
  useEffect(() => { if (editId) setVisited(previous => previous.includes(editId) ? previous : [...previous, editId]); }, [editId]);
  useEffect(() => {
    if (!workspaceRequest || page !== 'role-config') return;
    if (workspaceRequest.kind === 'create') {
      setShowRoles(true);
      setCreating(true);
      return;
    }
    if (!roles.some(role => role.roleId === workspaceRequest.roleId)) return;
    setEditId(workspaceRequest.roleId);
    setRoleSection(workspaceRequest.section);
    if (workspaceRequest.section === 'models') setModelPart('chat');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRequest?.key, page, roles]);
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
  useEffect(() => {
    if (newModelVisible) return;
    newModelProbe.clearLog();
    setModelError('');
    setShowNewSecret(false);
  }, [newModelVisible, newModelProbe.clearLog]);
  const openSettings = (section: SettingsSection, options?: OpenSettingsOptions) => {
    setNewModel(false);
    setNewExtension(null);
    setNewImageService(Boolean(options?.newImageService));
    if (options?.modelKind) {
      setModelKind(options.modelKind);
    }
    if (options?.resourceId !== undefined) setSelectedResource(options.resourceId);
    setSettingsSection(section);
    onNavigate('settings');
  };
  const newModelTarget = (): ModelProbeTarget => ({ kind: 'draft', config: { protocol: modelProtocol, baseUrl: modelUrl.trim(), ...(modelSecret ? { secret: modelSecret } : {}) } });
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
    // 保存前的草稿候选与提交配置一致时，转给保存后的资源继续共享。
    const carriedModels = newModelProbe.listLoaded ? [...newModelProbe.models] : [];
    const trimmedModel = newModelName.trim();
    setModelBusy(true); setModelError('');
    try {
      const config: Record<string, unknown> = {
        protocol: modelProtocol,
        baseUrl: modelUrl.trim(),
        ...(trimmedModel ? { modelName: trimmedModel } : {}),
      };
      const resource = await api<Resource>('/v1/resources', { method: 'POST', body: { kind: 'model', name: modelName.trim(), config, ...(modelSecret ? { secret: modelSecret } : {}) } });
      if (carriedModels.length > 0) writeModelCache(providerCacheKey(resource), carriedModels);
      setResources(previous => [...previous.filter(item => item.resourceId !== resource.resourceId), resource]);
      setRefreshVersion(v => v + 1);
      if (viewRef.current.settingsActive && viewRef.current.settingsSection === 'model' && viewRef.current.newModel) {
        setSelectedResource(resource.resourceId); setNewModel(false);
      }
      setModelName(''); setModelProtocol('openai-chat'); setModelUrl(''); setModelSecret(''); setShowNewSecret(false); setNewModelName('');
      newModelProbe.reset();
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
    let settled = false;
    const finishFlight = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallbackTimer);
      source.style.visibility = '';
      if (roleFlight.current?.animation !== animation) { copy.remove(); return; }
      copy.remove(); roleFlight.current = null; setStagePreview(null); setEditId(roleId); closeRoles();
    };
    const fallbackTimer = window.setTimeout(finishFlight, 700);
    void animation.finished.then(finishFlight).catch(() => { finishFlight(); });
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
    if ((settingsSection === 'model' && modelKind === 'model') || settingsSection === 'mcp' || settingsSection === 'skill') {
      if (!filtered.some(item => item.resourceId === selectedResource)) setSelectedResource(filtered[0]?.resourceId || '');
    } else if (settingsSection === 'model' && modelKind === 'image') {
      if (!newImageService && !imageServices.some(item => item.serviceId === selectedResource)) {
        setSelectedResource(imageServices[0]?.serviceId || '');
      }
    }
  }, [settingsSection, resources, selectedResource, modelKind, imageServices, newImageService]);
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
        {settingsSection === 'model' && <div className="config-kind-tabs" role="group" aria-label="模型分类">{([['model','模型'],['image','生图']] as const).map(([id,label]) => <button key={id} type="button" aria-pressed={modelKind === id} onClick={() => { setModelKind(id); setNewModel(false); setNewImageService(false); }}>{label}</button>)}</div>}
        <small>{settingsSection === 'model' ? ({model:'模型服务',image:'生图服务'} as const)[modelKind] : settingSections.find(item => item[0] === settingsSection)?.[1]} · {settingsSection === 'model' && modelKind === 'image' ? imageServices.length : filtered.length} 项</small></div>
        {settingsSection === 'roles' ? null : settingsSection === 'local' ? <><button type="button" className="config-index-item" data-selected="true"><strong>外观与动效</strong><small>本机动效偏好</small></button><button type="button" className="config-index-item" onClick={() => document.getElementById('config-local-connection')?.scrollIntoView({block:'nearest'})}><strong>版本与连接</strong><small>后端状态</small></button></> : settingsSection === 'model' && modelKind === 'image' ? <>{imageServiceError && <p role="alert">{imageServiceError}</p>}{imageServices.map((item,index) => { const itemModel = savedImageModelOf(item); const sub = itemModel ? `${itemModel} · ${item.config.baseUrl}` : item.config.baseUrl; return <button className="config-index-item" type="button" key={item.serviceId} onClick={() => { setSelectedResource(item.serviceId); setNewImageService(false); }} data-selected={!newImageService && selectedResource === item.serviceId}><small>{String(index+1).padStart(2,'0')}</small><strong>{item.name}</strong><small>{sub}</small><small>{item.enabled ? '已启用' : '已停用'}</small></button>; })}{!imageServiceError && !imageServices.length && <p className="config-muted">还没有生图服务。</p>}<button type="button" className="config-index-new" onClick={() => setNewImageService(true)}>＋ 添加生图服务</button></> : <>{resourceError && <p role="alert">{resourceError}</p>}{filtered.map((item,index) => { const itemModel = item.kind === 'model' ? savedModelNameOf(item) : ''; const sub = typeof item.config.baseUrl === 'string' ? (itemModel ? `${itemModel} · ${item.config.baseUrl}` : item.config.baseUrl) : item.kind.toUpperCase(); return <button className="config-index-item" type="button" key={item.resourceId} onClick={() => { setSelectedResource(item.resourceId); setNewModel(false); setNewExtension(null); }} data-selected={!newModel && newExtension !== item.kind && selectedResource === item.resourceId}><small>{String(index+1).padStart(2,'0')}</small><strong>{item.name}</strong><small>{sub}</small><small>{item.enabled ? '已启用' : '已停用'}{item.lastTest ? item.lastTest.stale ? ' · 测试已过期' : item.lastTest.ok ? ' · 测试通过' : ' · 测试失败' : ''}</small></button>; })}{!resourceError && !filtered.length && <p className="config-muted">还没有已保存的资源。</p>}{settingsSection === 'model' && <button type="button" className="config-index-new" onClick={() => setNewModel(true)}>＋ 添加模型服务</button>}{(settingsSection === 'mcp' || settingsSection === 'skill') && <button type="button" className="config-index-new" onClick={() => setNewExtension(settingsSection)}>＋ 添加 {settingsSection === 'mcp' ? 'MCP' : 'Skill'}</button>}</>}
      </aside>}
      <nav className="config-tabs" aria-label={roleActive ? '角色配置分区' : '设置分区'}>{(roleActive ? roleSections : settingSections).map(([id, title], index) => <button key={id} type="button" aria-current={(roleActive ? roleSection : settingsSection) === id ? 'page' : undefined} onClick={() => changeSection(id)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{id === 'quota' ? '额度' : id === 'done' ? '完成' : id === 'roles' ? '角色' : title}</strong>{roleActive && (dirtyScopes?.[id as keyof RoleDirty] || (id === 'models' && (dirtyScopes?.voice || dirtyScopes?.image))) && <i className="config-tab-led" aria-label="有未保存草稿"/>}</button>)}</nav>
      <section className="config-leaf">{roleActive && dirtyNames.length > 0 && <div className="config-dirty-ribbon" aria-label={`${dirtyNames.length} 处未保存`}>{dirtyNames.length}</div>}<header className="config-leaf-head"><div className="config-crumb">{roleActive ? <>角色配置 <i>/</i> {chosen?.displayName || '选择角色'} <i>/</i> <b>{sectionTitle}</b></> : <>设置 <i>/</i> <b>{sectionTitle}</b> <button type="button" className="config-return-link" onClick={() => onNavigate('role-config')}>返回角色配置</button></>}</div><span className="config-folio">{roleActive ? `档案 ${String(Math.max(0, roles.findIndex(role => role.roleId === editId)) + 1).padStart(2, '0')} / ` : '设置 · '}第 {sectionNumber} 页</span></header>
        <div className="config-leaf-body" ref={contentRef}>
          {roleListError && <p role="alert" className="config-delete-notice">角色列表同步失败：{roleListError} <button type="button" onClick={() => void onRefresh()}>重试读取角色列表</button></p>}
          {deleteNotice && roleActive && <p role="status" className="config-delete-notice">{deleteNotice}</p>}
          {visited.filter(id => roles.some(role => role.roleId === id)).map(id => <RoleEditor key={id} roleId={id} roleCount={roles.length} active={roleActive && editId === id} activity={activityError ? undefined : activities.find(item => item.roleId === id)} imageServiceVersion={imageServiceVersion} imageServiceEpochs={imageServiceEpochs} section={roleSection} modelPart={modelPart} setModelPart={setModelPart} draft={drafts[id]} setDraft={draft => setDrafts(previous => ({ ...previous, [id]: draft }))} resources={resources} removedResources={removedResources} resourceError={resourceError} onEditorState={updateEditorState} onOpenSettings={openSettings} onStartConversation={onStartConversation} onPreviewOutfit={outfit => setStagePreview(outfit.home ? { roleId: id, assetId: outfit.home.assetId } : null)} onPreviewAsset={assetId => setStagePreview({ roleId: id, assetId })} onClearPreview={() => setStagePreview(previous => previous?.roleId === id ? null : previous)} onDeleted={async (roleId, keepHistory, filesRemoved) => { onRoleDeleted(roleId); setStagePreview(previous => previous?.roleId === roleId ? null : previous); setDeleteNotice(keepHistory ? '角色已移除，记忆与对话数据保留在本机目录。' : filesRemoved ? '角色及其本机数据已删除。' : '角色已移除，部分文件尚待清理，后端将继续处理。'); await onRefresh(); setDrafts(previous => { const next = { ...previous }; delete next[roleId]; return next; }); setRefreshVersion(v => v + 1); }} onRefresh={async () => { await onRefresh(); setRefreshVersion(v => v + 1); }} />)}
          {roleActive && !editId && <p>还没有角色，请先创建角色。</p>}
          {visitedResources.map(id => { const resource = resources.find(item => item.resourceId === id); if (!resource) return null; const visible = settingsActive && id === selectedResource && resource.kind === settingsSection && newExtension !== resource.kind && !(settingsSection === 'model' && (newModel || modelKind === 'image')); return <ResourceDetail key={id} resource={resource} roles={roles} active={visible} canWrite={true} onRemoved={resourceId => setRemovedResources(previous => previous.includes(resourceId) ? previous : [...previous, resourceId])} onUpdated={() => setRefreshVersion(v => v + 1)} />; })}
          {(['mcp', 'skill'] as const).map(kind => <ExtensionCreate key={kind} kind={kind} active={settingsActive && settingsSection === kind && newExtension === kind} onCancel={() => setNewExtension(null)} onCreated={resource => { setResources(previous => [...previous, resource]); setRefreshVersion(v => v + 1); if (viewRef.current.settingsActive && viewRef.current.settingsSection === kind && viewRef.current.newExtension === kind) { setSelectedResource(resource.resourceId); setNewExtension(null); } }}/>) }
          {settingsActive && (settingsSection === 'mcp' || settingsSection === 'skill' || (settingsSection === 'model' && modelKind === 'model' && !newModel)) && !filtered.length && <div className="config-prose"><ConfigHeading number="01" label="资源" english="RESOURCES" title="选择一项资源" description="从左页选择已保存的资源。"/></div>}
          {settingsActive && settingsSection === 'model' && modelKind === 'image' && (newImageService ? <ImageServiceCreate onCancel={() => setNewImageService(false)} onCreated={service => { bumpImageServiceEpoch(service.serviceId); setImageServices(previous => [...previous.filter(item => item.serviceId !== service.serviceId), service]); setSelectedResource(service.serviceId); setNewImageService(false); setImageServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}/> : <ImageServiceDetail key={selectedResource} service={imageServices.find(item => item.serviceId === selectedResource)} activities={activities} roles={roles} onUpdated={changedId => { bumpImageServiceEpoch(changedId); setImageServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }} onRemoved={removedId => { bumpImageServiceEpoch(removedId); setImageServices(previous => previous.filter(item => item.serviceId !== removedId)); setImageServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}/>)}
          <div hidden={!newModelVisible} className="config-prose"><h2>添加模型服务</h2><p>地址与密钥保存在本机；填写后即可读取模型列表，选择或输入模型名后可测试连接。保存与测试相互独立。</p><Field label="名称"><Input disabled={modelBusy} value={modelName} maxLength={200} onChange={event => setModelName(event.target.value)}/></Field><Field label="接口协议"><Select disabled={modelBusy} value={modelProtocol} onChange={event => { const nextProtocol = event.target.value; setModelProtocol(nextProtocol); setModelUrl(previous => resolveModelBaseUrlOnProtocolChange(previous, nextProtocol)); newModelProbe.reset(); }}>{MODEL_PROTOCOL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field><Field label="服务地址" hint={modelBaseUrlHint(modelProtocol)}><Input disabled={modelBusy} value={modelUrl} placeholder={modelBaseUrlPlaceholder(modelProtocol)} onChange={event => { setModelUrl(event.target.value); newModelProbe.reset(); }}/></Field><Field label="密钥" hint="选填。默认隐藏，可点击右侧「显示」查看。"><SecretInput disabled={modelBusy} value={modelSecret} visible={showNewSecret} onToggleVisible={() => setShowNewSecret(previous => !previous)} onChange={nextSecret => { setModelSecret(nextSecret); newModelProbe.reset(); }}/></Field><ModelNamePicker value={newModelName} onChange={setNewModelName} models={newModelProbe.models} listBusy={newModelProbe.listBusy} listError={newModelProbe.listError} listLoaded={newModelProbe.listLoaded} testBusy={newModelProbe.testBusy} testNote={newModelProbe.testModel === newModelName ? newModelProbe.testNote : ''} notice={newModelProbe.notice} onRefresh={() => { if (modelUrl.trim()) void newModelProbe.refresh(newModelTarget()); }} onTest={() => { if (modelUrl.trim() && newModelName.trim()) void newModelProbe.test(newModelTarget(), newModelName.trim()); }} testDisabled={!newModelName.trim() || !modelUrl.trim()} disabled={modelBusy}/>{modelError && <p role="alert">{modelError}</p>}<div className="config-actions"><Button disabled={modelBusy || !modelName.trim() || !modelUrl.trim()} onClick={() => void createModel()}>保存模型服务</Button><button type="button" onClick={() => setNewModel(false)}>返回目录</button></div></div>
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
          <div className="config-poster-foot">{role.roleId === currentId ? <span>当前陪伴</span> : <button type="button" onClick={() => onSelectCompanion(role.roleId)}>设为陪伴</button>}{role.roleId !== editId && Object.values(roleDirty[role.roleId] || {}).some(Boolean) && <span className="config-poster-dirty">未保存</span>}</div>
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

function RoleEditor({ roleId, roleCount, active, activity, imageServiceVersion = 0, imageServiceEpochs = {}, section, modelPart, setModelPart, draft, setDraft, resources, removedResources, resourceError, onEditorState, onOpenSettings, onStartConversation, onPreviewOutfit, onPreviewAsset, onClearPreview, onDeleted, onRefresh }: { roleId: string; roleCount: number; active: boolean; activity?: Activity; imageServiceVersion?: number; imageServiceEpochs?: Record<string, number>; section: RoleSection; modelPart: ModelPart; setModelPart: (part: ModelPart) => void; draft?: Draft; setDraft: (draft: Draft) => void; resources: Resource[]; removedResources: string[]; resourceError: string; onEditorState: (roleId: string, state: RoleEditorState | null) => void; onOpenSettings: (section: SettingsSection, options?: OpenSettingsOptions) => void; onStartConversation?: (roleId: string) => void; onPreviewOutfit: (outfit: Outfit) => void; onPreviewAsset: (assetId: string) => void; onClearPreview: () => void; onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [voiceDraft, setVoiceDraft] = useState<ConfigDraftState | null>(null);
  const [imageDraft, setImageDraft] = useState<ConfigDraftState | null>(null);
  const [detailError, setDetailError] = useState('');
  const [savedProfile, setSavedProfile] = useState<Draft | undefined>(draft);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  // 278 §1：应用内先暂停角色，后端确认 stopped 后再提交这次操作。
  const [pausedForWrite, setPausedForWrite] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [pauseNote, setPauseNote] = useState('');
  const ensureRoleStopped = async (): Promise<boolean> => {
    if (!activity) { setPauseNote('角色状态未获取，请稍后重试。'); return false; }
    try {
      // 以后端最新活动状态为准，避免刚刚「继续活动」后本地列表尚未刷新时误判为已停止。
      const latest = await api<{ items: Activity[] }>('/v1/activities');
      const liveState = latest.items.find(item => item.roleId === roleId)?.state ?? activity.state;
      if (liveState === 'stopped') return true;
      setPauseNote('正在暂停角色…');
      if (liveState !== 'stopping') {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/stop`, { method: 'POST' });
      }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const view = await api<{ activity: Activity }>(`/v1/roles/${encodeURIComponent(roleId)}/activity`);
        if (view.activity.state === 'stopped') {
          setPausedForWrite(true);
          setPauseNote('角色已暂停。保存完成后可按需继续活动。');
          await onRefresh();
          return true;
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
      setPauseNote('角色尚未确认停止，请稍后重试。');
      return false;
    } catch (e) {
      setPauseNote(`暂停角色失败：${errorText(e)}`);
      return false;
    }
  };
  // 供外观、语音、生图面板复用：写入前先暂停角色，失败则拒绝本次写入。
  const guardAction = async <T,>(action: () => Promise<T>): Promise<T> => {
    if (!(await ensureRoleStopped())) {
      throw new Error('角色尚未确认停止，请稍后重试。');
    }
    return action();
  };
  const resumeAfterWrite = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
      await onRefresh();
      setPausedForWrite(false);
      setPauseNote('角色已继续活动。');
    } catch (e) {
      setPauseNote(`继续活动失败：${errorText(e)}`);
    } finally {
      setResuming(false);
    }
  };
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [bindingLoaded, setBindingLoaded] = useState(false);
  const [bindingRevision, setBindingRevision] = useState('');
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingNotice, setBindingNotice] = useState('');
  const bindingLock = useRef(false);
  const syncedRemovals = useRef('');
  const [modelDraft, setModelDraft] = useState({ chatResource: '', chatModel: '', memoryResource: '', memoryModel: '' });
  const chatProvider = resources.find(item => item.kind === 'model' && item.resourceId === modelDraft.chatResource);
  const memoryProvider = resources.find(item => item.kind === 'model' && item.resourceId === modelDraft.memoryResource);
  const chatKey = chatProvider ? providerCacheKey(chatProvider) : '';
  const memoryKey = memoryProvider ? providerCacheKey(memoryProvider) : '';
  const chatProbe = useModelProbe(chatKey, { shared: true });
  const memoryProbe = useModelProbe(memoryKey, { shared: true });
  const chatModelTabActive = active && section === 'models' && modelPart === 'chat';
  const memoryModelTabActive = active && section === 'models' && modelPart === 'memory';
  useEffect(() => {
    if (!chatModelTabActive) chatProbe.clearLog();
  }, [chatModelTabActive, chatProbe.clearLog]);
  useEffect(() => {
    if (!memoryModelTabActive) memoryProbe.clearLog();
  }, [memoryModelTabActive, memoryProbe.clearLog]);
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
    if (!draft || saveBusy || !draft.name.trim() || !draft.definition.trim()) return;
    setSaveBusy(true); setDetailError(''); setSaveMessage('');
    try {
      if (!(await ensureRoleStopped())) return;
      const saved = await api<{ definitionRevision: number; updatedAt: string }>(`/v1/roles/${encodeURIComponent(roleId)}/definition`, { method: 'PATCH', body: { displayName: draft.name.trim(), definition: { text: draft.definition.trim(), payload: draft.payload }, expectedRevision: draft.revision } });
      const next = { name: draft.name.trim(), definition: draft.definition.trim(), payload: draft.payload, revision: saved.definitionRevision };
      setSavedProfile(next); setDraft(next);
      setSaveMessage('角色设定已保存。'); await onRefresh();
    } catch (e) { setDetailError(errorText(e)); } finally { setSaveBusy(false); }
  };
  const saveBindings = async (scope: 'models' | 'ext') => {
    if (bindingLock.current || !bindingRevision) return;
    if (scope === 'models' && ((modelDraft.chatResource && !modelDraft.chatModel.trim()) || (modelDraft.memoryResource && !modelDraft.memoryModel.trim()))) { setBindingError('已选择的模型服务需要填写模型 ID。'); return; }
    bindingLock.current = true; setBindingBusy(true); setBindingError(''); setBindingNotice('');
    const asInput = (item: Binding) => ({ capability: item.capability, resourceId: item.resourceId, enabled: item.enabled, ...(item.modelName ? { modelName: item.modelName } : {}) });
    const previous = bindings.filter(item => scope === 'models' ? item.capability !== 'chat_model' && item.capability !== 'memory_model' : item.capability !== 'mcp' && item.capability !== 'skill').map(asInput);
    const rawNext = scope === 'models' ? [
      ...(modelDraft.chatResource ? [{ capability: 'chat_model' as const, resourceId: modelDraft.chatResource, modelName: modelDraft.chatModel.trim(), enabled: bindings.find(item => item.capability === 'chat_model' && item.resourceId === modelDraft.chatResource)?.enabled ?? true }] : []),
      ...(modelDraft.memoryResource ? [{ capability: 'memory_model' as const, resourceId: modelDraft.memoryResource, modelName: modelDraft.memoryModel.trim(), enabled: bindings.find(item => item.capability === 'memory_model' && item.resourceId === modelDraft.memoryResource)?.enabled ?? true }] : []),
    ] : [
      ...bindings.filter(item => (item.capability === 'mcp' || item.capability === 'skill') && !resources.some(resource => resource.resourceId === item.resourceId)).map(asInput),
      ...resources.filter(item => (item.kind === 'mcp' || item.kind === 'skill') && (extensionDraft[item.resourceId] || bindings.some(binding => binding.resourceId === item.resourceId && binding.capability === item.kind))).map(item => ({ capability: item.kind, resourceId: item.resourceId, enabled: !!extensionDraft[item.resourceId] })),
    ];
    const next: Binding[] = rawNext.map(item => ({
      capability: item.capability as Binding['capability'],
      resourceId: item.resourceId,
      modelName: ('modelName' in item ? (item.modelName as string | undefined) ?? null : null),
      enabled: item.enabled,
    }));
    try {
      if (!(await ensureRoleStopped())) return;
      const result = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, { method: 'PUT', body: { bindings: [...previous, ...next.map(asInput)], expectedRevision: bindingRevision } });
      setBindings(result.items); setBindingRevision(result.revision); setBindingNotice(scope === 'models' ? '模型选择已保存。' : '扩展选择已保存。');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BINDING_REVISION_CONFLICT') {
        // 字段级合并：服务端变化与本次草稿修改不重叠时自动合并并重试一次。
        try {
          const latest = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`);
          const { items: mergedItems, conflicts } = mergeBindingDrafts({ base: bindings, draft: next, latest: latest.items, scope });
          if (conflicts.length > 0) {
            // 同一用途被两边改成不同目标：保留草稿，要求重新读取后再确认。
            setBindingRevision('');
            const labels = conflicts.map(key => scope === 'models'
              ? ({ chat_model: '对话模型', memory_model: '记忆模型' } as Record<string, string>)[key] ?? key
              : resources.find(item => item.resourceId === key.slice(key.indexOf(':') + 1))?.name ?? key);
            setBindingError(`绑定冲突：${labels.join('、')}。请重新读取绑定后检查草稿，再保存。`);
          } else {
            const retried = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, { method: 'PUT', body: { bindings: mergedItems.map(item => asInput(item as Binding)), expectedRevision: latest.revision } });
            mergeRefreshedBindings(bindings, retried, removedResources); setBindingNotice('已与最新绑定自动合并并保存。');
          }
        } catch (retryError) {
          if (retryError instanceof ApiError && retryError.code === 'BINDING_REVISION_CONFLICT') {
            setBindingRevision('');
            setBindingError('绑定仍在被其他操作修改。请重新读取绑定后检查草稿，再保存。');
          } else setBindingError(errorText(retryError));
        }
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
    if (budgetBusy || !Number.isInteger(budgetDraft.dailyLimit) || budgetDraft.dailyLimit < 1 || budgetDraft.dailyLimit > 1_000_000) return;
    setBudgetBusy(true); setBudgetError(''); setBudgetNotice('');
    try {
      if (!(await ensureRoleStopped())) return; const result = await api<NonNullable<typeof budget>>(`/v1/roles/${encodeURIComponent(roleId)}/autonomy/budget`, { method: 'PUT', body: budgetDraft }); setBudget(result); setBudgetDraft({ dailyLimit: result.dailyLimit, unlimited: result.unlimited }); setBudgetNotice('自主额度已保存。'); }
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
  const writeLabel = (text: string) => activity?.state === 'stopped' ? text : '暂停并保存';
  const pausedNote = pausedForWrite && activity?.state === 'stopped' && <div className="config-active-note"><span>◉</span><p><b>{draft?.name || '角色'}已暂停</b>　本次操作已完成或正在保存，可按需继续活动。</p><button type="button" disabled={resuming} onClick={() => void resumeAfterWrite()}>{resuming ? '正在继续…' : '继续活动'}</button></div>;
  const statusNote = (activity?.state !== 'stopped'
    ? <div className="config-active-note"><span>◉</span><p><b>{draft?.name || '角色'}{activity?.state === 'stopping' ? '正在停止' : activity ? '启用中' : '状态未获取'}</b>　可以先修改草稿；保存时会先暂停角色，后端确认后再提交这次操作。</p><button type="button" onClick={() => onOpenSettings('roles')}>去角色状态</button></div>
    : pausedNote) || (pauseNote ? <p role="status" className="config-muted">{pauseNote}</p> : null);
  const footer = document.getElementById('config-leaf-actions');
  const selectedModel = (id: string) => resources.find(item => item.resourceId === id)?.name || (id ? '资源不可用' : '未选择');
  const modelOptions = resources.filter(item => item.kind === 'model');
  const needsBindingRead = !bindingRevision && (bindingLoaded || !!bindingError);
  const bindingProblem = bindingError || (needsBindingRead ? '绑定尚未同步，请重新读取。' : '');
  const bindingAlert = (bindingProblem || resourceError) && <p role="alert">{bindingProblem || resourceError}{needsBindingRead && <button type="button" disabled={bindingBusy} onClick={() => void reloadBindings()}>重试读取绑定</button>}</p>;
  return <><div hidden={!active} className="config-role-editor">
    <div hidden={!active || section !== 'profile'} className="config-prose">
      <ConfigHeading number="01" label="设定" english="PROFILE" title="设定" description="显示名和人设直接参与提示词；修改是同一角色的修订，不会重建角色。"/>
      {statusNote}{detailError && <p role="alert">{detailError}</p>}{saveMessage && <p role="status">{saveMessage}</p>}
      {draft && <><div className="config-ledger"><div className="config-ledger-label"><b>显示名</b><small>对话、主页与日记里的称呼</small></div><div><Input aria-label="显示名" disabled={saveBusy} value={draft.name} maxLength={200} onChange={event => setDraft({ ...draft, name: event.target.value })}/></div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>人设</b><small>她是谁、怎么说话、在意什么<br/>{draft.definition.length} 字</small></div><div><Textarea aria-label="角色设定" className="config-ruled" disabled={saveBusy} rows={8} value={draft.definition} onChange={event => setDraft({ ...draft, definition: event.target.value })}/></div></div>
      <RoleDeletion roleId={roleId} roleName={draft.name} roleCount={roleCount} activityState={activity?.state} onPaused={() => setPausedForWrite(true)} onStatusRefresh={onRefresh} onDeleted={onDeleted}/></>}
    </div>
    <div hidden={!active || section !== 'look'} className="config-prose"><ConfigHeading number="02" label="外观" english="WARDROBE" title="衣柜" description="服饰的主页立绘与对话差分。点开一套服饰查看素材。"/>{statusNote}{loaded.look && <AppearancePanel roleId={roleId} currentOutfitId={outfitId} canWrite={!!activity} guardWrite={guardAction} pausedWrite={activity?.state !== 'stopped'} onPreview={onPreviewOutfit} onPreviewAsset={onPreviewAsset} onChanged={() => { onClearPreview(); setLookVersion(v => v + 1); void onRefresh(); }}/>}</div>
    <div hidden={!active || section !== 'models'} className="config-prose"><ConfigHeading number="03" label="模型" english="MODELS" title="模型" description="模型列表和连接测试在设置里；这里配置角色使用的模型和演出。"/>{statusNote}{bindingAlert}
      <div className="config-model-head"><span>用途</span><span>所选模型</span><span>已保存</span><span>当前状态</span></div>
      {([['chat','对话'],['memory','记忆整理'],['image','生图'],['voice','语音']] as const).map(([id,label]) => <div className="config-model-row" key={id}>
        <button type="button" className="config-model-toggle" aria-expanded={modelPart === id} onClick={() => setModelPart(id)}><strong>{label}</strong><span>{id === 'chat' ? selectedModel(modelDraft.chatResource) : id === 'memory' ? (modelDraft.memoryResource ? selectedModel(modelDraft.memoryResource) : '跟随对话模型') : '角色配置'}</span><small>{id === 'chat' || id === 'memory' ? (bindings.some(item => item.capability === (id === 'chat' ? 'chat_model' : 'memory_model') && item.enabled) ? '已保存' : '未单独设置') : '查看配置'}</small><span>⌄</span></button>
        <div hidden={!active || section !== 'models' || modelPart !== id} className="config-model-details">
          {id === 'chat' && bindingLoaded && <><Field label="对话模型：从设置里已保存的模型中选择"><Select disabled={bindingBusy} value={modelDraft.chatResource} onChange={event => { const resourceId = event.target.value; const picked = modelOptions.find(item => item.resourceId === resourceId); setModelDraft(previous => ({ ...previous, chatResource: resourceId, chatModel: picked ? savedModelNameOf(picked) : '' })); chatProbe.reset(); }}><option value="">未选择</option>{modelOptions.map(item => <option value={item.resourceId} key={item.resourceId}>{item.name}{item.enabled ? '' : '（全局已停用）'}</option>)}</Select></Field>{modelDraft.chatResource ? <ModelNamePicker value={modelDraft.chatModel} onChange={value => setModelDraft(previous => ({ ...previous, chatModel: value }))} models={chatProbe.models} listBusy={chatProbe.listBusy} listError={chatProbe.listError} listLoaded={chatProbe.listLoaded} testBusy={chatProbe.testBusy} testNote={chatProbe.testModel === modelDraft.chatModel ? chatProbe.testNote : ''} notice={chatProbe.notice} onRefresh={() => void chatProbe.refresh({ kind: 'saved', resourceId: modelDraft.chatResource, cacheKey: chatKey })} onTest={() => void chatProbe.test({ kind: 'saved', resourceId: modelDraft.chatResource, cacheKey: chatKey }, modelDraft.chatModel.trim())} testDisabled={!modelDraft.chatModel.trim()} disabled={bindingBusy}/> : <p className="config-muted">未选择对话模型；保存后角色无法开始对话。</p>}</>}
          {id === 'memory' && bindingLoaded && <><Field label="记忆模型"><Select disabled={bindingBusy} value={modelDraft.memoryResource} onChange={event => { const resourceId = event.target.value; const picked = modelOptions.find(item => item.resourceId === resourceId); setModelDraft(previous => ({ ...previous, memoryResource: resourceId, memoryModel: picked ? savedModelNameOf(picked) : '' })); memoryProbe.reset(); }}><option value="">跟随对话模型</option>{modelOptions.map(item => <option value={item.resourceId} key={item.resourceId}>{item.name}{item.enabled ? '' : '（全局已停用）'}</option>)}</Select></Field>{modelDraft.memoryResource ? <ModelNamePicker value={modelDraft.memoryModel} onChange={value => setModelDraft(previous => ({ ...previous, memoryModel: value }))} models={memoryProbe.models} listBusy={memoryProbe.listBusy} listError={memoryProbe.listError} listLoaded={memoryProbe.listLoaded} testBusy={memoryProbe.testBusy} testNote={memoryProbe.testModel === modelDraft.memoryModel ? memoryProbe.testNote : ''} notice={memoryProbe.notice} onRefresh={() => void memoryProbe.refresh({ kind: 'saved', resourceId: modelDraft.memoryResource, cacheKey: memoryKey })} onTest={() => void memoryProbe.test({ kind: 'saved', resourceId: modelDraft.memoryResource, cacheKey: memoryKey }, modelDraft.memoryModel.trim())} testDisabled={!modelDraft.memoryModel.trim()} disabled={bindingBusy}/> : <p className="config-muted">跟随对话模型：运行时继承已绑定的对话模型。</p>}</>}
          {(id === 'chat' || id === 'memory') && <><button type="button" onClick={() => { const resourceId = id === 'chat' ? modelDraft.chatResource : modelDraft.memoryResource; onOpenSettings('model', { modelKind: 'model', ...(resourceId ? { resourceId } : {}) }); }}>在设置中查看模型 →</button>{id === 'chat' && savedChat?.enabled && savedChat.modelName && onStartConversation ? <Button variant="primary" onClick={() => { void (async () => { if (activity?.state !== 'active') { try { await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' }); await onRefresh(); } catch { /* 状态由原页提示 */ } } onStartConversation(roleId); })(); }}>{activity?.state === 'stopped' ? '开始对话（先恢复活动）' : '开始对话'}</Button> : null}{bindingNotice && <p role="status">{bindingNotice}</p>}<Button disabled={bindingBusy || !bindingRevision || !!resourceError} onClick={() => void saveBindings('models')}>{writeLabel('保存模型选择')}</Button></>}
          {id === 'voice' && loaded.voice && <VoicePanel roleId={roleId} active={active && section === 'models' && modelPart === 'voice'} guardWrite={guardAction} pausedWrite={activity?.state !== 'stopped'} onDraftStateChange={setVoiceDraft} onChanged={() => { void onRefresh(); }}/>} {id === 'image' && loaded.image && <ImagePanel roleId={roleId} active={active && section === 'models' && modelPart === 'image'} serviceRefreshVersion={imageServiceVersion} serviceEpochs={imageServiceEpochs} outfitRefreshVersion={lookVersion} onOpenImageSettings={target => onOpenSettings('model', { modelKind: 'image', ...(target?.serviceId ? { resourceId: target.serviceId } : {}), ...(target?.createNew ? { newImageService: true } : {}) })} guardWrite={guardAction} pausedWrite={activity?.state !== 'stopped'} onDraftStateChange={setImageDraft} onChanged={() => { void onRefresh(); }}/>}
        </div></div>)}
    </div>
    <div hidden={!active || section !== 'ext'} className="config-prose"><ConfigHeading number="04" label="扩展" english="EXTENSIONS" title="扩展" description="设置里的 MCP 与 Skill 在这里按角色开启或关闭。"/>{statusNote}{bindingAlert}{(['mcp','skill'] as const).map(kind => <div className="config-ledger" key={kind}><div className="config-ledger-label"><b>{kind === 'mcp' ? 'MCP' : 'Skill'}</b><small>{resources.filter(item => item.kind === kind).length} 项</small></div><div>{resources.filter(item => item.kind === kind).map(item => <label className="config-row" key={item.resourceId}><span><strong>{item.name}</strong><small>{item.enabled ? '全局已启用' : '全局已停用'}</small></span><span><input type="checkbox" disabled={bindingBusy || !bindingLoaded} checked={extensionDraft[item.resourceId] || false} onChange={event => setExtensionDraft(previous => ({ ...previous, [item.resourceId]: event.target.checked }))}/> 角色开启</span></label>)}{!resources.some(item => item.kind === kind) && <p className="config-muted">暂无{kind === 'mcp' ? ' MCP' : ' Skill'}。</p>}</div></div>)}{!bindingLoaded && list(extensions)}{bindingNotice && <p role="status">{bindingNotice}</p>}<Button disabled={bindingBusy || !bindingRevision || !!resourceError} onClick={() => void saveBindings('ext')}>{writeLabel('保存扩展')}</Button><button type="button" className="config-text-button" onClick={() => onOpenSettings('mcp')}>在设置中管理 →</button></div>
    <div hidden={!active || section !== 'quota'} className="config-prose"><ConfigHeading number="05" label="自主额度" english="QUOTA" title="自主额度" description="角色后台活动所消耗的点数。"/>{statusNote}{budgetError && <p role="alert">{budgetError}</p>}{budget ? <><div className="config-ledger"><div className="config-ledger-label"><b>今日</b><small>{budget.localDate}</small></div><div><div className="config-quota-number">{budget.usedPoints} <small>/ {budget.unlimited ? '不限' : budget.dailyLimit} 点</small></div><div className="config-quota-track"><span style={{ width: budget.unlimited ? '0%' : `${Math.min(100, budget.dailyLimit ? budget.usedPoints / budget.dailyLimit * 100 : 0)}%` }}/></div></div></div><div className="config-ledger"><div className="config-ledger-label"><b>每日额度</b><small>角色自主活动</small></div><div><div className="config-quota-input"><Input type="number" min={1} max={1000000} disabled={budgetBusy || budgetDraft.unlimited} value={budgetDraft.dailyLimit} aria-label="每日额度" onChange={event => setBudgetDraft({ ...budgetDraft, dailyLimit: Number(event.target.value) })}/><label><input type="checkbox" disabled={budgetBusy} checked={budgetDraft.unlimited} onChange={event => setBudgetDraft({ ...budgetDraft, unlimited: event.target.checked })}/> 不限制</label></div><p className="config-muted">保存时会先暂停角色并由后端确认停止。</p><Button disabled={budgetBusy || !Number.isInteger(budgetDraft.dailyLimit) || budgetDraft.dailyLimit < 1 || budgetDraft.dailyLimit > 1_000_000} onClick={() => void saveBudget()}>{writeLabel('保存额度')}</Button>{budgetNotice && <p role="status">{budgetNotice}</p>}</div></div></> : !budgetError && <p>正在读取额度…</p>}</div>
    <div hidden={!active || section !== 'done'} className="config-prose"><ConfigHeading number="06" label="完成度" english="CHECKLIST" title="完成度" description="按已保存的配置查看当前状态；必需项仍待确认。"/>{[['设定',savedProfile?.definition ? '已保存' : '尚未读取'],['对话模型',bindings.some(item => item.capability === 'chat_model' && item.enabled) ? '已绑定' : '未绑定'],['记忆整理',bindings.some(item => item.capability === 'memory_model' && item.enabled) ? '已绑定' : '跟随对话模型'],['角色状态',activityText(activity)]].map(([label,value],i) => <div className="config-check-row" key={label}><small>{String(i+1).padStart(2,'0')}</small><b>{label}</b><i/><span>{value}</span></div>)}</div>
  </div>{active && section === 'profile' && draft && footer && createPortal(<>{dirtyProfile && <Button disabled={saveBusy} onClick={() => { if (savedProfile) setDraft(savedProfile); }}>放弃</Button>}<Button disabled={saveBusy || !draft.name.trim() || !draft.definition.trim()} onClick={() => void saveProfile()}>{writeLabel('保存设定')}</Button></>, footer)}</>;
}

function ConfigHeading({ number, label, english, title, description }: { number: string; label: string; english: string; title: string; description: string }) {
  return <header className="config-section-heading"><small><i>{number}</i> {label} · {english}</small><h2>{title}</h2><p>{description}</p></header>;
}

function RoleDeletion({ roleId, roleName, roleCount, activityState, onPaused, onStatusRefresh, onDeleted }: { roleId: string; roleName: string; roleCount: number; activityState?: 'active' | 'stopping' | 'stopped'; onPaused: () => void; onStatusRefresh: () => Promise<void>; onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void> }) {
  const stopped = activityState === 'stopped';
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [choice, setChoice] = useState<'keep' | 'remove' | ''>('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'idle' | 'pausing' | 'deleting'>('idle');
  const [error, setError] = useState('');
  // 278 §1.4：删除前按当前活动状态暂停角色，后端确认停止后再执行删除。
  const ensureStopped = async () => {
    if (stopped) return;
    if (activityState !== 'stopping') {
      await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/stop`, { method: 'POST' });
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const view = await api<{ activity: { state: string } }>(`/v1/roles/${encodeURIComponent(roleId)}/activity`);
      if (view.activity.state === 'stopped') {
        onPaused();
        await onStatusRefresh();
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
    throw new Error('角色尚未确认停止，请稍后重试。');
  };
  const remove = async () => {
    if (busy || !choice || roleCount < 2) return;
    const keepHistory = choice === 'keep';
    setBusy(true); setError('');
    try {
      setStep('pausing');
      await ensureStopped();
      setStep('deleting');
      const result = await api<{ roleId: string; keepHistory: boolean; filesRemoved: boolean }>(`/v1/roles/${encodeURIComponent(roleId)}?keepHistory=${keepHistory ? '1' : '0'}`, { method: 'DELETE' });
      await onDeleted(result.roleId, result.keepHistory, result.filesRemoved);
    } catch (reason) {
      setError(errorText(reason));
      // 暂停成功但删除失败时，刷新实际状态并在原处提供继续活动。
      try { await onStatusRefresh(); } catch { /* 状态由下次读取刷新 */ }
    } finally { setBusy(false); setStep('idle'); }
  };
  return <div className="config-ledger"><div className="config-ledger-label"><b>删除角色</b></div><div>
    <Button disabled={roleCount < 2 || busy} onClick={event => { trigger.current = event.currentTarget; setOpen(true); setChoice(''); setError(''); }}>{stopped ? '删除角色' : '暂停并删除角色'}</Button>
    {roleCount < 2 ? <small className="config-inline-hint">至少保留一个角色。</small> : !stopped ? <small className="config-inline-hint">{activityState === 'stopping' ? '角色正在停止，确认删除会等它停稳。' : '删除前会先暂停角色，后端确认停止后再执行。'}</small> : null}
    {open && <fieldset className="config-delete-options"><legend>删除「{roleName}」</legend><p>请选择记忆、对话和角色目录的处理方式：</p>
      <label><input type="radio" name={`delete-${roleId}`} checked={choice === 'keep'} disabled={busy} onChange={() => setChoice('keep')}/> 保留本机数据（移除角色，保留目录；应用内无法读取已删除角色）</label>
      <label><input type="radio" name={`delete-${roleId}`} checked={choice === 'remove'} disabled={busy} onChange={() => setChoice('remove')}/> 一并删除本机数据（包括记忆、对话、工作区与素材副本）</label>
      <p>原始素材文件不会被删除。</p>{error && <p role="alert">{error}</p>}
      <div className="config-actions"><Button disabled={!choice || busy || roleCount < 2} onClick={() => void remove()}>{busy ? (step === 'pausing' ? '正在暂停角色…' : '正在删除…') : stopped ? '确认删除' : '暂停并删除角色'}</Button><button type="button" disabled={busy} onClick={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }}>取消</button></div>
    </fieldset>}
  </div></div>;
}

function ResourceDetail({ resource, roles, active, canWrite, onRemoved, onUpdated }: { resource: Resource; roles: RoleListItem[]; active: boolean; canWrite: boolean; onRemoved: (id: string) => void; onUpdated: () => void }) {
  const [model, setModel] = useState(() => savedModelNameOf(resource));
  const savedModelRef = useRef(savedModelNameOf(resource));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState(resource.name);
  const [draftProtocol, setDraftProtocol] = useState(String(resource.config.protocol || 'openai-chat'));
  const [draftUrl, setDraftUrl] = useState(String(resource.config.baseUrl || ''));
  const [secretDraft, setSecretDraft] = useState(() => createSecretDraft(resource.credential?.status));
  const secretStatusRef = useRef(resource.credential?.status);
  const [secretVisible, setSecretVisible] = useState(false);
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretError, setSecretError] = useState('');
  const revealSeq = useRef(0);
  const [impact, setImpact] = useState<ResourceImpact | null>(null);
  const [impactError, setImpactError] = useState('');
  const [pausedRoleIds, setPausedRoleIds] = useState<string[]>([]);
  const [impactVersion, setImpactVersion] = useState(0);
  const savedProtocol = String(resource.config.protocol || 'openai-chat');
  const savedBaseUrl = String(resource.config.baseUrl || '');
  const savedKey = providerCacheKey(resource);
  const secretOp = secretOperationOf(secretDraft);
  const secretProbeKey = secretOp.action === 'replace' ? `replace:${secretOp.secret}` : secretOp.action;
  const probe = useModelProbe(`${savedKey}|${secretProbeKey}|${draftProtocol}|${draftUrl}`, { onSavedList: onUpdated, onSavedTest: onUpdated });
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const nextSavedModel = savedModelNameOf(resource);
    if (nextSavedModel !== savedModelRef.current) {
      if (model === savedModelRef.current) setModel(nextSavedModel);
      savedModelRef.current = nextSavedModel;
    }
  }, [resource.config.modelName, resource.lastTest?.modelName, model]);
  useEffect(() => {
    const nextStatus = resource.credential?.status;
    if (nextStatus !== secretStatusRef.current) {
      secretStatusRef.current = nextStatus;
      setSecretDraft(previous => (previous.dirty ? previous : createSecretDraft(nextStatus)));
    }
  }, [resource.credential?.status]);
  useEffect(() => {
    if (active) return;
    // 切换页面或切走当前模型后，读取/测试点击日志与未编辑的明文立即失效。
    revealSeq.current += 1;
    probe.clearLog();
    setSecretVisible(false);
    setSecretDraft(previous => hideUneditedSecret(previous));
    setSecretError('');
    setMessage('');
    setPausedRoleIds([]);
  }, [active, probe.clearLog]);
  useEffect(() => {
    if (!active || resource.kind !== 'model') return;
    let alive = true;
    setImpactError('');
    api<ResourceImpact>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/impact`)
      .then(value => { if (alive) setImpact(value); })
      .catch(reason => { if (alive) { setImpact(null); setImpactError(errorText(reason)); } });
    return () => { alive = false; };
  }, [active, resource.resourceId, impactVersion]);
  const toggleSecretVisible = async () => {
    if (busy || secretLoading) return;
    setSecretError('');
    if (secretVisible) {
      revealSeq.current += 1;
      setSecretVisible(false);
      setSecretDraft(previous => hideUneditedSecret(previous));
      return;
    }
    if (!secretDraft.hasExisting || secretDraft.dirty || secretDraft.baselineSecret !== null) {
      setSecretVisible(true);
      return;
    }
    const seq = ++revealSeq.current;
    setSecretLoading(true);
    try {
      const revealed = await api<{ status: 'stored' | 'reference' | 'missing'; secret?: string; reference?: string }>(
        `/v1/resources/${encodeURIComponent(resource.resourceId)}/secret/reveal`,
        { method: 'POST' },
      );
      if (!live.current || seq !== revealSeq.current) return;
      if (revealed.status === 'stored') {
        setSecretDraft(previous => applyRevealedSecret(previous, revealed.secret ?? ''));
      } else if (revealed.status === 'reference') {
        setSecretDraft(previous => applyRevealedSecret(previous, revealed.secret ?? revealed.reference ?? ''));
      } else {
        setSecretDraft(previous => (previous.dirty ? { ...previous, revealed: true } : { hasExisting: false, baselineSecret: null, dirty: false, value: '', revealed: true }));
      }
      setSecretVisible(true);
    } catch (error) {
      if (live.current && seq === revealSeq.current) {
        setSecretError(errorText(error));
      }
    } finally {
      if (live.current && seq === revealSeq.current) {
        setSecretLoading(false);
      }
    }
  };
  // 未保存的修改用草稿探测；保留密钥时按资源解析（后端核对协议与 origin）。
  const probeTarget = (): ModelProbeTarget => {
    const base = { protocol: draftProtocol, baseUrl: draftUrl.trim() };
    // 未改动的配置走按资源接口，结果写回资源摘要；其余用草稿探测。
    if (secretOp.action === 'keep' && draftProtocol === savedProtocol && draftUrl.trim() === savedBaseUrl) {
      return { kind: 'saved', resourceId: resource.resourceId, cacheKey: savedKey };
    }
    if (secretOp.action === 'replace') return { kind: 'draft', config: { ...base, secret: secretOp.secret } };
    if (secretOp.action === 'clear') return { kind: 'draft', config: base };
    return { kind: 'draft', config: { ...base, resourceId: resource.resourceId } };
  };
  const save = async () => {
    if (busy || !canWrite || !draftName.trim() || !draftUrl.trim()) return;
    // 提交配置与读取列表时一致才转交候选；换密钥先清理旧候选。
    const carriedModels = probe.listLoaded ? [...probe.models] : null;
    const trimmedModel = model.trim();
    setBusy(true); setMessage('');
    try {
      const config: Record<string, unknown> = { ...resource.config, protocol: draftProtocol, baseUrl: draftUrl.trim() };
      if (trimmedModel) {
        config.modelName = trimmedModel;
      } else {
        delete config.modelName;
      }
      if (secretOp.action !== 'keep') delete config.credentialRef;
      const result = await api<Resource & { maintenance?: { connectionChanged: boolean; pausedRoleIds: string[] } }>(
        `/v1/resources/${encodeURIComponent(resource.resourceId)}`,
        {
          method: 'PATCH',
          body: {
            name: draftName.trim(),
            config,
            ...(secretOp.action === 'replace' ? { secret: secretOp.secret } : secretOp.action === 'clear' ? { secret: null } : {}),
          },
        },
      );
      if (!live.current) return;
      setPausedRoleIds(result.maintenance?.pausedRoleIds ?? []);
      setImpactVersion(value => value + 1);
      const resultKey = providerCacheKey(result);
      if (secretOp.action !== 'keep') clearModelCache(resultKey);
      if (carriedModels !== null) writeModelCache(resultKey, carriedModels);
      const nextSavedModel = savedModelNameOf(result) || trimmedModel;
      savedModelRef.current = nextSavedModel;
      secretStatusRef.current = result.credential?.status;
      setDraftName(result.name);
      setDraftProtocol(String(result.config.protocol || ''));
      setDraftUrl(String(result.config.baseUrl || ''));
      setModel(nextSavedModel);
      setSecretDraft(createSecretDraft(result.credential?.status));
      setSecretVisible(false);
      setSecretError('');
      probe.reset();
      setMessage('模型服务已保存。');
      onUpdated();
    } catch (e) { if (live.current) {
      // 停止后保存失败：后端在错误详情里带回本次暂停的角色（283 R05）。
      const paused = pausedRoleIdsOf(e);
      if (paused.length > 0) { setPausedRoleIds(paused); setImpactVersion(value => value + 1); }
      setMessage(paused.length > 0
        ? `${errorText(e)}（本次已暂停相关角色，完成后可在下方继续活动）`
        : errorText(e));
    } } finally { if (live.current) setBusy(false); }
  };
  const resumePaused = async () => {
    const names: string[] = [];
    for (const roleId of pausedRoleIds) {
      try {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
        names.push(impact?.roles.find(item => item.roleId === roleId)?.displayName ?? roleId);
      } catch (reason) { setMessage(`继续活动失败：${errorText(reason)}`); }
    }
    setPausedRoleIds([]);
    setImpactVersion(value => value + 1);
    if (names.length > 0) setMessage(`已继续本次活动暂停的角色：${names.join('、')}。`);
    onUpdated();
  };
  const connectionDirty = secretOp.action !== 'keep' || draftProtocol !== savedProtocol || draftUrl.trim() !== savedBaseUrl;
  const secretHint = resource.credential?.status === 'stored'
    ? '已保存密钥；修改内容可替换，清空并保存可删除，未改动则保留原密钥。'
    : resource.credential?.status === 'reference'
      ? `当前使用外部引用（${resource.credential.reference ?? 'env/file'}）；修改并保存将替换为直填密钥，未改动则保留引用。`
      : resource.credential?.status === 'unavailable'
        ? '已保存的密钥在当前环境无法解密；可直接输入新密钥覆盖，或清空后保存。'
        : '当前未保存密钥；可在此填写，留空也可保存。';
  const usageLabel = (usage: 'chat' | 'memory' | 'task') => usage === 'chat' ? '对话' : usage === 'memory' ? '记忆整理' : '未结束任务';
  const subtitle = resource.kind === 'model' ? '角色在配置页选择已保存的模型服务。' : resource.kind === 'mcp' ? '本地 MCP 服务，在角色配置的扩展中开启。' : '本地 Skill 目录，在角色配置的扩展中开启。';
  return <div hidden={!active} className="config-prose"><ConfigHeading number={resource.kind === 'model' ? '01' : resource.kind === 'mcp' ? '02' : '03'} label={resource.kind === 'model' ? '模型 · 对话' : resource.kind === 'mcp' ? 'MCP' : 'Skill'} english="" title={resource.name} description={subtitle}/>
    <div className="config-ledger"><div className="config-ledger-label"><b>状态</b><small>全局</small></div><div>{resource.enabled ? '已启用' : '已停用'}</div></div>
    {resource.kind === 'model' ? <><div className="config-ledger"><div className="config-ledger-label"><b>名称</b><small>模型服务</small></div><div><Input disabled={busy} aria-label="模型服务名称" value={draftName} onChange={event => setDraftName(event.target.value)}/></div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>连接</b><small>协议与地址</small></div><div className="config-connection"><Field label="协议"><Select disabled={busy} value={draftProtocol} onChange={event => { const nextProtocol = event.target.value; setDraftProtocol(nextProtocol); setDraftUrl(previous => resolveModelBaseUrlOnProtocolChange(previous, nextProtocol)); probe.reset(); }}>{MODEL_PROTOCOL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></Field><Field label="服务地址" hint={modelBaseUrlHint(draftProtocol)}><Input disabled={busy} value={draftUrl} placeholder={modelBaseUrlPlaceholder(draftProtocol)} onChange={event => { setDraftUrl(event.target.value); probe.reset(); }}/></Field></div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>密钥</b><small>{secretDraft.hasExisting ? '已设置' : '未设置'}</small></div><div><SecretInput aria-label="模型密钥" disabled={busy} loading={secretLoading} value={secretDraft.value} visible={secretVisible} placeholder={secretDraft.hasExisting ? '留空后保存可清除密钥' : '选填，可直接填写密钥'} onFocus={event => { if (!secretDraft.dirty && secretDraft.baselineSecret === null && secretDraft.value === SECRET_MASK_SENTINEL) event.currentTarget.select(); }} onToggleVisible={() => void toggleSecretVisible()} onChange={nextValue => { setSecretDraft(previous => nextSecretDraftOnInput(previous, nextValue)); setSecretError(''); probe.reset(); }}/><p className="config-muted">{secretHint}</p>{secretError ? <p role="alert">{secretError}</p> : null}</div></div>
      <div className="config-ledger"><div className="config-ledger-label"><b>模型</b><small>获取或手填</small></div><div><ModelNamePicker value={model} onChange={setModel} models={probe.models} listBusy={probe.listBusy} listError={probe.listError} listLoaded={probe.listLoaded} testBusy={probe.testBusy} testNote={probe.testModel === model ? probe.testNote : ''} notice={probe.notice} onRefresh={() => { if (draftUrl.trim()) void probe.refresh(probeTarget()); }} onTest={() => { if (draftUrl.trim() && model.trim()) void probe.test(probeTarget(), model.trim()); }} testDisabled={!model.trim() || !draftUrl.trim()} disabled={busy}/><p>最近测试：{!resource.lastTest ? '尚未测试' : resource.lastTest.stale ? '配置已改变，请重新测试' : resource.lastTest.ok ? `成功 · ${resource.lastTest.modelName}` : `失败 · ${resource.lastTest.modelName}`}</p>{secretOp.action === 'keep' && <p className="config-muted">保留已保存密钥时，只有同协议、同站点的地址可复用；换站点请修改密钥或清空后保存。</p>}</div></div><div className="config-ledger"><div className="config-ledger-label"><b>影响范围</b><small>实际依赖</small></div><div>{impactError ? <p role="alert">影响范围读取失败：{impactError} <button type="button" onClick={() => setImpactVersion(value => value + 1)}>重试</button></p> : !impact ? <p className="config-muted">正在读取影响范围…</p> : (impact?.roles.length ?? 0) === 0 ? <p className="config-muted">当前没有角色或未结束任务依赖这个服务。</p> : <ul>{(impact?.roles ?? []).map(item => <li key={item.roleId}>{item.displayName} · {item.usages.map(usageLabel).join(' / ')} · {item.state === 'active' ? '启用中' : item.state === 'stopping' ? '正在停止' : '已停止'}{item.taskIds.length > 0 ? ` · ${item.taskIds.length} 个未结束任务` : ''}</li>)}</ul>}{connectionDirty && (impact?.roles ?? []).some(item => item.state !== 'stopped') ? <p className="config-muted">保存连接参数或密钥时会先暂停启用中的依赖角色，其他角色可继续。</p> : null}</div></div><div className="config-ledger"><div className="config-ledger-label"><b>保存</b></div><div><Button disabled={busy || !draftName.trim() || !draftUrl.trim()} onClick={() => void save()}>{connectionDirty && impact !== null && (impact?.roles ?? []).some(item => item.state !== 'stopped') ? '暂停相关角色并保存' : '保存模型服务'}</Button></div></div>{pausedRoleIds.length > 0 && <p role="status">已暂停 {pausedRoleIds.map(id => impact?.roles.find(item => item.roleId === id)?.displayName ?? id).join('、')}。 <button type="button" onClick={() => void resumePaused()}>继续本次活动暂停的角色</button></p>}{message && <p role="status">{message}</p>}<ModelManagement resource={resource} roles={roles} active={active} canWrite={canWrite} onRemoved={onRemoved} onUpdated={onUpdated}/></> : <>
      {resource.kind === 'mcp' && <><div className="config-ledger"><div className="config-ledger-label"><b>启动命令</b><small>stdio</small></div><div><code>{String(resource.config.command || '')} {Array.isArray(resource.config.args) ? resource.config.args.join(' ') : ''}</code></div></div><div className="config-ledger"><div className="config-ledger-label"><b>环境变量</b></div><div><code>{Object.keys((resource.config.env || {}) as Record<string, unknown>).join('、') || '没有设置环境变量'}</code></div></div></>}
      {resource.kind === 'skill' && <div className="config-ledger"><div className="config-ledger-label"><b>来源目录</b></div><div><code>{String(resource.config.sourcePath || '')}</code></div></div>}
      <ExtensionManagement resource={resource} roles={roles} active={active} onRemoved={onRemoved} onUpdated={onUpdated}/>
    </>}</div>;
}

type ResourceReferences = { references: Array<{ roleId: string; reason: 'ROLE_BINDING' | 'TASK_CHAIN' | 'INFLIGHT_CALL'; bindingEnabled: boolean | null; taskId?: string }>; canUpdate: boolean; canDisable: boolean; canDelete: boolean };
type ResourceImpact = { roles: Array<{ roleId: string; displayName: string; usages: Array<'chat' | 'memory' | 'task'>; taskIds: string[]; state: string; running: boolean }>; blockingTasks: number };

/** 资源详情中的任务终结：只结束指定任务的后续执行（278 §3）。 */
async function finishTaskForResource(roleId: string, taskId: string): Promise<void> {
  await api(`/v1/roles/${encodeURIComponent(roleId)}/tasks/${encodeURIComponent(taskId)}/finish`, {
    method: 'POST',
    body: { status: 'completed', endReason: '用户在资源详情中结束任务' },
  });
}

/** 将角色 ID 解析为用户可读的展示名，缺失时退回 ID。 */
function roleDisplayName(roles: RoleListItem[], roleId: string): string {
  return roles.find(item => item.roleId === roleId)?.displayName || roleId;
}

/** 关闭某角色对目标资源的绑定：需要时先暂停该角色，写入后恢复本次暂停。 */
async function closeRoleResourceBinding(roleId: string, resourceId: string, roleLabel?: string): Promise<void> {
  const before = await api<{ activity: { state: string } }>(`/v1/roles/${encodeURIComponent(roleId)}/activity`);
  let paused = false;
  if (before.activity.state !== 'stopped') {
    if (before.activity.state === 'active') {
      await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/stop`, { method: 'POST' });
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const view = await api<{ activity: { state: string } }>(`/v1/roles/${encodeURIComponent(roleId)}/activity`);
      if (view.activity.state === 'stopped') { paused = true; break; }
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
    if (!paused) throw new Error(`角色 ${roleLabel || roleId} 尚未确认停止，请稍后重试。`);
  }
  const current = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`);
  const next = current.items.map(item => ({
    capability: item.capability,
    resourceId: item.resourceId,
    enabled: item.resourceId === resourceId ? false : item.enabled,
    ...(item.modelName ? { modelName: item.modelName } : {}),
  }));
  await api(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, {
    method: 'PUT',
    body: { bindings: next, expectedRevision: current.revision },
  });
  if (paused) {
    await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
  }
}

function ModelManagement({ resource, roles, active, canWrite, onRemoved, onUpdated }: { resource: Resource; roles: RoleListItem[]; active: boolean; canWrite: boolean; onRemoved: (id: string) => void; onUpdated: () => void }) {
  const [report, setReport] = useState<ResourceReferences | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [closingBindings, setClosingBindings] = useState(false);
  const endTask = async (roleId: string, taskId: string) => {
    if (!window.confirm(`结束任务 ${taskId}？后续步骤不再执行，已发出的调用按原任务结算。`)) return;
    try {
      await finishTaskForResource(roleId, taskId);
      setVersion(value => value + 1); onUpdated();
    } catch (reason) { setError(errorText(reason)); }
  };
  const closeBinding = async (roleId: string) => {
    if (closingBindings) return;
    setClosingBindings(true); setError('');
    try {
      await closeRoleResourceBinding(roleId, resource.resourceId, roleDisplayName(roles, roleId));
      setVersion(value => value + 1); onUpdated();
    } catch (reason) { setError(errorText(reason)); }
    finally { setClosingBindings(false); }
  };
  const closeAllBindings = async () => {
    const roleIds = [...new Set((report?.references ?? []).filter(item => item.reason === 'ROLE_BINDING' && item.bindingEnabled === true).map(item => item.roleId))];
    if (roleIds.length === 0 || closingBindings) return;
    setClosingBindings(true); setError('');
    const failures: string[] = [];
    for (const roleId of roleIds) {
      const label = roleDisplayName(roles, roleId);
      try { await closeRoleResourceBinding(roleId, resource.resourceId, label); }
      catch (reason) { failures.push(`${label}：${errorText(reason)}`); }
    }
    if (failures.length > 0) setError(failures.join('；'));
    setVersion(value => value + 1); onUpdated();
    setClosingBindings(false);
  };
  // 轮询请求互不取消：慢响应仍可应用；切换资源或卸载后旧响应全部丢弃（283 §10 R01）。
  const referenceQuery = useRef({ token: 0, seq: 0, applied: 0, mounted: true });
  useEffect(() => {
    referenceQuery.current.mounted = true;
    return () => { referenceQuery.current.mounted = false; };
  }, []);
  useEffect(() => {
    referenceQuery.current.token += 1;
    referenceQuery.current.applied = 0;
  }, [active, resource.resourceId]);
  useEffect(() => {
    if (!active) return;
    // 刷新时保留上一份占用报告，避免在途轮询造成「正在读取」闪烁。
    const query = referenceQuery.current;
    const token = query.token;
    const seq = ++query.seq;
    const apply = (action: () => void) => {
      if (!query.mounted || query.token !== token || seq < query.applied) return;
      query.applied = seq;
      action();
    };
    api<ResourceReferences>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/references`)
      .then(value => apply(() => { setReport(value); setError(''); }))
      .catch(reason => apply(() => setError(errorText(reason))));
  }, [active, resource.resourceId, version]);
  const hasInflight = !!report?.references.some(item => item.reason === 'INFLIGHT_CALL');
  useEffect(() => {
    // 在途调用结算后占用会自动解除；详情保持打开时轮询刷新（283 §9 R01）。
    if (!active || !hasInflight) return;
    const timer = window.setInterval(() => setVersion(value => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [active, hasInflight, resource.resourceId]);
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
    {report && report.references.length > 0 && <ul>{report.references.map((item, index) => <li key={`${item.roleId}-${item.taskId || index}`}>{roleDisplayName(roles, item.roleId)} · {item.reason === 'TASK_CHAIN' ? '任务仍在使用' : item.reason === 'INFLIGHT_CALL' ? '后台调用进行中，稍后重试' : item.bindingEnabled ? '角色已选择并启用' : '角色已选择但关闭'}{item.reason === 'TASK_CHAIN' && item.taskId ? <> <button type="button" disabled={busy} onClick={() => void endTask(item.roleId, item.taskId!)}>结束任务</button></> : null}{item.reason === 'ROLE_BINDING' && item.bindingEnabled ? <> <button type="button" disabled={busy || closingBindings} onClick={() => void closeBinding(item.roleId)}>关闭该角色绑定</button></> : null}</li>)}</ul>}
    {report && report.references.some(item => item.reason === 'ROLE_BINDING' && item.bindingEnabled) ? <button type="button" disabled={busy || closingBindings} onClick={() => void closeAllBindings()}>{closingBindings ? '正在关闭绑定…' : '关闭全部启用绑定'}</button> : null}
    {report && !report.canDelete && <p>有角色、任务或后台调用正在使用，请先解除占用。 <button type="button" disabled={busy} onClick={() => setVersion(value => value + 1)}>重新检查占用</button></p>}
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

function ExtensionManagement({ resource, roles, active, onRemoved, onUpdated }: { resource: Resource; roles: RoleListItem[]; active: boolean; onRemoved: (id: string) => void; onUpdated: () => void }) {
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
  const [closingBindings, setClosingBindings] = useState(false);
  const endTask = async (roleId: string, taskId: string) => {
    if (!window.confirm(`结束任务 ${taskId}？后续步骤不再执行，已发出的调用按原任务结算。`)) return;
    try {
      await finishTaskForResource(roleId, taskId);
      setVersion(value => value + 1); onUpdated();
    } catch (reason) { setMessage(errorText(reason)); }
  };
  const closeBinding = async (roleId: string) => {
    if (closingBindings) return;
    setClosingBindings(true); setMessage('');
    try {
      await closeRoleResourceBinding(roleId, resource.resourceId, roleDisplayName(roles, roleId));
      setVersion(value => value + 1); onUpdated();
    } catch (reason) { setMessage(errorText(reason)); }
    finally { setClosingBindings(false); }
  };
  const closeAllBindings = async () => {
    const roleIds = [...new Set((report?.references ?? []).filter(item => item.reason === 'ROLE_BINDING' && item.bindingEnabled === true).map(item => item.roleId))];
    if (roleIds.length === 0 || closingBindings) return;
    setClosingBindings(true); setMessage('');
    const failures: string[] = [];
    for (const roleId of roleIds) {
      const label = roleDisplayName(roles, roleId);
      try { await closeRoleResourceBinding(roleId, resource.resourceId, label); }
      catch (reason) { failures.push(`${label}：${errorText(reason)}`); }
    }
    if (failures.length > 0) setMessage(failures.join('；'));
    setVersion(value => value + 1); onUpdated();
    setClosingBindings(false);
  };
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
    {reportError ? <p role="alert">无法读取占用情况：{reportError} <button type="button" onClick={() => setVersion(value => value + 1)}>重试</button></p> : !report ? <p>正在读取占用情况…</p> : <>{report.references.length > 0 ? <ul>{report.references.map((item, index) => <li key={`${item.roleId}-${item.reason}-${item.taskId || index}`}>{roleDisplayName(roles, item.roleId)} · {item.reason === 'TASK_CHAIN' ? `任务仍在使用${item.taskId ? `（${item.taskId}）` : ''}` : item.reason === 'INFLIGHT_CALL' ? '后台调用进行中，稍后重试' : item.bindingEnabled ? '角色已开启' : '角色已关闭'}{item.reason === 'TASK_CHAIN' && item.taskId ? <> <button type="button" disabled={busy} onClick={() => void endTask(item.roleId, item.taskId!)}>结束任务</button></> : null}{item.reason === 'ROLE_BINDING' && item.bindingEnabled ? <> <button type="button" disabled={busy || closingBindings} onClick={() => void closeBinding(item.roleId)}>关闭该角色绑定</button></> : null}</li>)}</ul> : <p className="config-muted">当前没有角色或任务引用。</p>}{report.references.some(item => item.reason === 'ROLE_BINDING' && item.bindingEnabled) ? <button type="button" disabled={busy || closingBindings} onClick={() => void closeAllBindings()}>{closingBindings ? '正在关闭绑定…' : '关闭全部启用绑定'}</button> : null}{!report.canUpdate && <p className="config-muted">角色已开启或任务仍在使用，请先关闭角色开关并等待任务结束。</p>}</>}
    <div className="config-actions"><Button disabled={busy || !report?.canUpdate} onClick={() => setEditing(value => !value)}>{editing ? '收起编辑' : '编辑'}</Button><Button disabled={busy || !report || (resource.enabled && !report.canDisable)} onClick={() => void run(resource.enabled ? 'disable' : 'enable')}>{resource.enabled ? '全局停用' : '全局启用'}</Button><Button disabled={busy || !report?.canDelete} onClick={() => setConfirmDelete(true)}>删除</Button></div>
    {editing && <div><Field label="名称"><Input value={name} disabled={busy} onChange={event => setName(event.target.value)}/></Field>{resource.kind === 'mcp' ? <><Field label="启动命令"><Input value={command} disabled={busy} onChange={event => setCommand(event.target.value)}/></Field><Field label="启动参数" hint="每行一个参数。"><Textarea rows={3} value={args} disabled={busy} onChange={event => setArgs(event.target.value)}/></Field><Field label="环境变量" hint="JSON 对象；*** 表示保留原值。"><Textarea rows={4} value={env} disabled={busy} onChange={event => setEnv(event.target.value)}/></Field></> : <Field label="来源目录"><Input value={sourcePath} disabled={busy} onChange={event => setSourcePath(event.target.value)}/></Field>}<Button disabled={busy || !report?.canUpdate} onClick={() => void run('save')}>保存资源</Button></div>}
    {confirmDelete && <div role="alert"><p>删除「{resource.name}」及其已关闭的角色绑定？</p><Button disabled={busy || !report?.canDelete} onClick={() => void run('delete')}>确认删除</Button> <button type="button" onClick={() => setConfirmDelete(false)}>取消</button></div>}
    {message && <p role="status">{message}</p>}
  </div></div>;
}

/** 修改全局生图服务前需要全部角色处于停止态：现查最新活动状态后顺序暂停，出错时带回已暂停角色。 */
async function stopActiveRolesForGlobalWrite(roles: RoleListItem[] = []): Promise<{ pausedIds: string[]; error?: unknown }> {
  const pausedIds: string[] = [];
  try {
    const latest = await api<{ items: Activity[] }>('/v1/activities');
    const targets = latest.items.filter(item => item.state !== 'stopped');
    for (const item of targets) {
      if (item.state === 'active') {
        await api(`/v1/roles/${encodeURIComponent(item.roleId)}/activity/stop`, { method: 'POST' });
        pausedIds.push(item.roleId);
      }
      const deadline = Date.now() + 20_000;
      let stopped = false;
      while (Date.now() < deadline) {
        const view = await api<{ activity: Activity }>(`/v1/roles/${encodeURIComponent(item.roleId)}/activity`);
        if (view.activity.state === 'stopped') {
          stopped = true;
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
      if (!stopped) throw new Error(`角色 ${roleDisplayName(roles, item.roleId)} 尚未确认停止，请稍后重试。`);
    }
    return { pausedIds };
  } catch (error) {
    return { pausedIds, error };
  }
}

function ImageServiceCreate({ onCancel, onCreated }: { onCancel: () => void; onCreated: (service: ImageService) => void }) {
  const [name, setName] = useState('本机 ComfyUI');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8188');
  const [secret, setSecret] = useState('');
  const [timeoutText, setTimeoutText] = useState('');
  const [modelName, setModelName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const probe = useImageProbe(`new-image|${baseUrl}|${secret}|${timeoutText}`, {
    onBeforeProbe: () => setError(''),
  });
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const parseTimeoutMs = (): number | undefined | null => {
    const trimmed = timeoutText.trim();
    if (!trimmed) return undefined;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 5000 || value > 900000) return null;
    return value;
  };

  const draftProbeTarget = (): ImageProbeTarget | null => {
    if (!baseUrl.trim()) return null;
    const timeoutMs = parseTimeoutMs();
    if (timeoutMs === null) {
      setError('等待上限需为 5000～900000 之间的整数毫秒。');
      return null;
    }
    return {
      kind: 'draft',
      config: {
        baseUrl,
        secret,
        timeoutMs,
        ...(modelName.trim() ? { modelName: modelName.trim() } : {}),
      },
    };
  };

  const create = async () => {
    if (busy || !name.trim() || !baseUrl.trim()) return;
    const timeoutMs = parseTimeoutMs();
    if (timeoutMs === null) { setError('等待上限需为 5000～900000 之间的整数毫秒。'); return; }
    const carriedModels = probe.listLoaded ? [...probe.models] : null;
    const trimmedModel = modelName.trim();
    setBusy(true); setError('');
    try {
      const result = await api<{ service: ImageService }>('/v1/image-services', {
        method: 'POST',
        body: {
          name: name.trim(),
          config: {
            protocol: 'comfyui',
            baseUrl: baseUrl.trim(),
            ...(trimmedModel ? { modelName: trimmedModel } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
      });
      if (!live.current) return;
      if (carriedModels !== null) {
        writeImageModelCache(imageServiceCacheKey(result.service), carriedModels);
      }
      onCreated(result.service);
    } catch (reason) {
      if (live.current) setError(imageErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return <div className="config-prose">
    <ConfigHeading number="＋" label="模型 · 生图" english="NEW IMAGE SERVICE" title="添加生图服务" description="全局维护 ComfyUI 连接、凭据与默认模型；读取列表后可在角色配置中直接选用。" />
    <Field label="名称"><Input value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)} /></Field>
    <Field label="服务地址" hint="ComfyUI 默认 http://127.0.0.1:8188。"><Input value={baseUrl} disabled={busy} onChange={event => { setBaseUrl(event.target.value); probe.reset(); }} /></Field>
    <Field label="令牌（可选）" hint="仅反向代理要求认证时填写；保存后不会回显。"><Input type="password" autoComplete="off" value={secret} disabled={busy} onChange={event => { setSecret(event.target.value); probe.reset(); }} /></Field>
    <Field label="生成等待上限（毫秒，可选）" hint="5000～900000，留空使用服务端默认值。"><Input type="number" min={5000} max={900000} value={timeoutText} disabled={busy} onChange={event => setTimeoutText(event.target.value)} /></Field>
    <ImageModelPicker
      label="默认模型（可选）"
      hint="点击下方「读取模型列表」或「测试连接」获取 ComfyUI 模型后选择，也可手填；创建后角色配置会默认选用。"
      value={modelName}
      onChange={setModelName}
      models={probe.models}
      listBusy={probe.listBusy}
      testBusy={probe.testBusy}
      notice={probe.notice}
      onRefresh={() => { const target = draftProbeTarget(); if (target) void probe.refresh(target); }}
      onTest={() => { const target = draftProbeTarget(); if (target) void probe.test(target, modelName); }}
      probeDisabled={!baseUrl.trim()}
      disabled={busy}
    />
    {error && <p role="alert">{error}</p>}
    <div className="config-actions">
      <Button disabled={busy || !name.trim() || !baseUrl.trim()} onClick={() => void create()}>{busy ? '正在保存…' : '保存生图服务'}</Button>
      <button type="button" disabled={busy} onClick={onCancel}>返回目录</button>
    </div>
  </div>;
}

function ImageServiceDetail({
  service,
  activities,
  roles,
  onUpdated,
  onRemoved,
}: {
  service?: ImageService;
  activities: Activity[];
  roles: RoleListItem[];
  onUpdated: (changedServiceId?: string) => void;
  onRemoved: (serviceId: string) => void;
}) {
  const [draftName, setDraftName] = useState(service?.name ?? '');
  const [draftUrl, setDraftUrl] = useState(service?.config.baseUrl ?? '');
  const [modelName, setModelName] = useState(() => savedImageModelOf(service));
  const [timeoutText, setTimeoutText] = useState(
    typeof service?.config.timeoutMs === 'number' ? String(service.config.timeoutMs) : '',
  );
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>('keep');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pausedRoleIds, setPausedRoleIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const savedKey = service ? imageServiceCacheKey(service) : '';
  const secretProbeKey = keyMode === 'replace' ? `replace:${secret}` : keyMode;
  const savedTimeout = typeof service?.config.timeoutMs === 'number' ? service.config.timeoutMs : undefined;
  const parseTimeoutMs = (): number | undefined | null => {
    const trimmed = timeoutText.trim();
    if (!trimmed) return undefined;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 5000 || value > 900000) return null;
    return value;
  };
  const currentTimeout = parseTimeoutMs();
  const matchesSaved =
    Boolean(service) &&
    keyMode === 'keep' &&
    draftUrl.trim() === service!.config.baseUrl &&
    currentTimeout === savedTimeout;
  const probe = useImageProbe(
    matchesSaved ? savedKey : `${savedKey}|draft|${secretProbeKey}|${draftUrl}|${timeoutText}`,
    {
      shared: matchesSaved,
      onBeforeProbe: () => { setError(''); setMessage(''); },
    },
  );
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => () => { probe.clearLog(); }, [probe.clearLog]);

  if (!service) return <div className="config-prose"><ConfigHeading number="01" label="模型 · 生图" english="IMAGE" title="生图服务" description="选择或添加一个生图服务；角色的提示词与工作流在角色配置中管理。"/></div>;

  const hasActiveRoles = activities.some(item => item.state !== 'stopped');

  const probeTarget = (): ImageProbeTarget | null => {
    if (!draftUrl.trim()) return null;
    const timeoutMs = parseTimeoutMs();
    if (timeoutMs === null) {
      setError('等待上限需为 5000～900000 之间的整数毫秒。');
      return null;
    }
    if (keyMode === 'replace' && !secret.trim()) {
      setError('请填写新令牌后再测试连接。');
      return null;
    }
    if (matchesSaved) {
      return { kind: 'savedService', serviceId: service.serviceId, cacheKey: savedKey };
    }
    return {
      kind: 'draft',
      config: {
        ...(keyMode === 'keep'
          ? { serviceId: service.serviceId, credentialRef: service.config.credentialRef }
          : {}),
        baseUrl: draftUrl,
        ...(modelName.trim() ? { modelName: modelName.trim() } : {}),
        ...(keyMode === 'replace' ? { secret } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
    };
  };

  const ensurePaused = async (): Promise<string[] | null> => {
    const stopped = await stopActiveRolesForGlobalWrite(roles);
    if (stopped.pausedIds.length > 0 && live.current) {
      setPausedRoleIds(previous => [...new Set([...previous, ...stopped.pausedIds])]);
    }
    if (stopped.error) {
      if (live.current) setError(imageErrorText(stopped.error));
      return null;
    }
    return stopped.pausedIds;
  };

  const save = async () => {
    if (busy || !draftName.trim() || !draftUrl.trim() || (keyMode === 'replace' && !secret.trim())) return;
    const timeoutMs = parseTimeoutMs();
    if (timeoutMs === null) { setError('等待上限需为 5000～900000 之间的整数毫秒。'); return; }
    let nextOrigin: string;
    try {
      const parsed = new URL(draftUrl.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setError('服务地址必须使用 http:// 或 https:// 协议。');
        return;
      }
      nextOrigin = parsed.origin;
    } catch {
      setError('服务地址格式不正确。');
      return;
    }
    const prevOrigin = (() => { try { return new URL(service.config.baseUrl).origin; } catch { return service.config.baseUrl; } })();
    const hasCredential = service.credential.status === 'stored' || Boolean(service.config.credentialRef);
    if (keyMode === 'keep' && hasCredential && nextOrigin !== prevOrigin) {
      // 保留凭据换站点会被后端拒绝；提前提示，避免先停活跃角色再失败。
      setError(describeImageFailure('RESOURCE_CREDENTIAL_STALE', ''));
      return;
    }
    const carriedModels = probe.listLoaded ? [...probe.models] : null;
    const trimmedModel = modelName.trim();
    setBusy(true); setError(''); setMessage('');
    try {
      const paused = await ensurePaused();
      if (paused === null) return;
      const config: Record<string, unknown> = {
        protocol: 'comfyui',
        baseUrl: draftUrl.trim(),
        ...(trimmedModel ? { modelName: trimmedModel } : {}),
        ...(keyMode === 'keep' && service.config.credentialRef ? { credentialRef: service.config.credentialRef } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const result = await api<{ service: ImageService }>(`/v1/image-services/${encodeURIComponent(service.serviceId)}`, {
        method: 'PATCH',
        body: {
          name: draftName.trim(),
          config,
          ...(keyMode === 'replace' ? { secret: secret.trim() } : keyMode === 'clear' ? { secret: null } : {}),
        },
      });
      if (!live.current) return;
      const nextKey = imageServiceCacheKey(result.service);
      if (keyMode !== 'keep' || nextKey !== savedKey) clearImageModelCache(savedKey);
      if (keyMode !== 'keep') clearImageModelCache(nextKey);
      if (carriedModels !== null) writeImageModelCache(nextKey, carriedModels);
      setDraftName(result.service.name);
      setDraftUrl(result.service.config.baseUrl);
      setModelName(savedImageModelOf(result.service));
      setTimeoutText(typeof result.service.config.timeoutMs === 'number' ? String(result.service.config.timeoutMs) : '');
      setKeyMode('keep');
      setSecret('');
      probe.clearLog();
      setMessage('生图服务已保存。');
      onUpdated(service.serviceId);
    } catch (reason) {
      if (live.current) setError(imageErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const paused = await ensurePaused();
      if (paused === null) return;
      await api<{ service: ImageService }>(`/v1/image-services/${encodeURIComponent(service.serviceId)}`, {
        method: 'PATCH',
        body: { enabled: !service.enabled },
      });
      if (service.enabled) clearImageModelCache(savedKey);
      probe.clearLog();
      if (!live.current) return;
      setMessage(service.enabled ? '生图服务已全局停用。' : '生图服务已全局启用。');
      onUpdated(service.serviceId);
    } catch (reason) {
      if (live.current) setError(imageErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const paused = await ensurePaused();
      if (paused === null) return;
      await api(`/v1/image-services/${encodeURIComponent(service.serviceId)}`, { method: 'DELETE' });
      clearImageModelCache(savedKey);
      for (const roleId of paused) {
        try { await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' }); } catch { /* 删除成功后尽力恢复，其余角色可在状态页恢复 */ }
      }
      if (!live.current) return;
      onRemoved(service.serviceId);
    } catch (reason) {
      if (live.current) setError(imageErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const resumePaused = async () => {
    if (busy || pausedRoleIds.length === 0) return;
    const names: string[] = [];
    for (const roleId of pausedRoleIds) {
      try {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
        names.push(roles.find(item => item.roleId === roleId)?.displayName ?? roleId);
      } catch (reason) {
        if (live.current) setError(`继续活动失败：${imageErrorText(reason)}`);
      }
    }
    if (!live.current) return;
    setPausedRoleIds([]);
    if (names.length > 0) setMessage(`已继续本次活动暂停的角色：${names.join('、')}。`);
    onUpdated();
  };

  const probeDisabled = !draftUrl.trim() || (keyMode === 'replace' && !secret.trim());

  return <div className="config-prose">
    <ConfigHeading number="01" label="模型 · 生图" english="IMAGE" title={service.name} description="全局维护 ComfyUI 地址、凭据与默认模型；角色配置默认继承此处所选模型，也可按角色覆盖。" />
    <div className="config-ledger"><div className="config-ledger-label"><b>状态</b><small>全局</small></div><div>{service.enabled ? '已启用' : '已停用'}</div></div>
    <div className="config-ledger"><div className="config-ledger-label"><b>名称</b><small>生图服务</small></div><div><Input aria-label="生图服务名称" disabled={busy} value={draftName} maxLength={200} onChange={event => setDraftName(event.target.value)} /></div></div>
    <div className="config-ledger"><div className="config-ledger-label"><b>连接</b><small>地址与超时</small></div><div className="config-connection"><Field label="服务地址"><Input disabled={busy} value={draftUrl} onChange={event => { setDraftUrl(event.target.value); probe.clearLog(); }} /></Field><Field label="等待上限（毫秒）" hint="5000～900000，留空为默认"><Input type="number" min={5000} max={900000} disabled={busy} value={timeoutText} onChange={event => setTimeoutText(event.target.value)} /></Field></div></div>
    <div className="config-ledger"><div className="config-ledger-label"><b>密钥</b><small>只写</small></div><div><p>密钥状态：{service.credential.status || '未知'}；密钥原文不会显示。</p><div className="config-subtabs" role="group" aria-label="生图密钥操作">{([['keep', '保留'], ['replace', '替换'], ['clear', '清除']] as const).map(([id, label]) => <button key={id} type="button" disabled={busy} aria-pressed={keyMode === id} onClick={() => { setKeyMode(id); setSecret(''); probe.clearLog(); }}>{label}</button>)}</div>{keyMode === 'replace' && <Field label="新令牌"><Input type="password" autoComplete="off" disabled={busy} value={secret} onChange={event => { setSecret(event.target.value); probe.clearLog(); }} /></Field>}{keyMode === 'keep' && <p className="config-muted">保留已保存密钥时，仅同站点同端口可复用；更换站点请改为替换或先清除密钥。</p>}</div></div>
    <div className="config-ledger"><div className="config-ledger-label"><b>默认模型</b><small>与连接测试</small></div><div><ImageModelPicker label="默认生图模型" hint="可从探测列表选择或在需要时手填；保存后角色配置默认使用此模型。" value={modelName} onChange={setModelName} models={probe.models} listBusy={probe.listBusy} testBusy={probe.testBusy} notice={probe.notice} onRefresh={() => { const target = probeTarget(); if (target) void probe.refresh(target); }} onTest={() => { const target = probeTarget(); if (target) void probe.test(target, modelName); }} probeDisabled={probeDisabled} disabled={busy} /></div></div>
    <div className="config-ledger"><div className="config-ledger-label"><b>管理</b><small>修改前需全员停止</small></div><div>
      {hasActiveRoles && <p className="config-muted">当前有启用中的角色；保存、启停或删除时会先暂停活跃角色，完成后可一键继续。</p>}
      <div className="config-actions">
        <Button disabled={busy || !draftName.trim() || !draftUrl.trim() || (keyMode === 'replace' && !secret.trim())} onClick={() => void save()}>{hasActiveRoles ? '暂停活跃角色并保存' : '保存生图服务'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void toggleEnabled()}>{service.enabled ? (hasActiveRoles ? '暂停并停用' : '全局停用') : (hasActiveRoles ? '暂停并启用' : '全局启用')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>删除生图服务</Button>
      </div>
      {confirmDelete && <div role="alert"><p>确认删除生图服务「{service.name}」及其保存的密钥？已选用该服务的角色需重新指定。</p><Button disabled={busy} onClick={() => void remove()}>{hasActiveRoles ? '暂停并删除' : '确认删除'}</Button> <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div>}
    </div></div>
    {pausedRoleIds.length > 0 && <p role="status">已暂停 {pausedRoleIds.map(id => roles.find(item => item.roleId === id)?.displayName ?? id).join('、')}。 <button type="button" onClick={() => void resumePaused()}>继续本次暂停的角色</button></p>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
