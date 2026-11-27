import { ExtensionCreate, ExtensionFields, SavedMcpProbe, parseExtensionEnv } from '../components/config/ExtensionImport';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { api, ApiError } from '../api';
import type { Outfit, RoleDetail, RoleListItem } from '../types';
import { Button, ControlButton, Field, Icon, Input, LiveAnnouncer, Select, StatusDot, Switch, Textarea, announceLive, readMotionTime, readMotionValue, useMotionPolicy } from '../ui';
import { readMotionPx, type MotionPreference } from '../ui/motion';
import { AppearancePanel } from '../components/appearance/AppearancePanel';
import { RolePortrait } from '../components/RolePortrait';
import { SheetProvider, useSheet, type SheetContextValue } from '../components/config/sheet/sheet-context';
import { WriteProvider, WriteResultNotice, useWrite } from '../components/config/write-runner';
import { RoleSheetHost } from '../components/config/role/RoleSheetHost';
import { ProbeFeedback } from '../components/config/ProbeFeedback';
import { WorldbooksPanel } from '../components/config/role/WorldbooksPanel';
import { Sheet } from '../components/config/sheet/Sheet';
import { chatRowStatus, memoryRowStatus, quotaLimitBad, rowDotVisible } from '../components/config/summary';
import { MediaGroup, MediaStateRow, RoleSaveActions, type MediaSummaryStatus } from '../components/config/MediaSheet';
import {
  ServiceDeleteEntry, ServiceDeleteSheet, ServiceHeading, ServiceIndex, ServiceIndexState, ServiceManagementRow,
  ServiceProbeAction, ServiceRow, ServiceSheet, ServiceSheetActions, ServiceUseRow,
  serviceHost, serviceMaintenanceOf, serviceProbeNotice, serviceStatus, serviceWriteFailure, useServiceSheetExit, type ServiceIndexEntry, type ServiceKind,
} from '../components/config/ServiceParts';
import { captureSavedSummary, sweepSavedElement } from '../components/config/sheet/save-feedback';
import { T1, T2, T6, T7, T8, T19, T10, T12, T16, T20, T21, T23, T25, T26, T28, T29, T30, T31, T32, T33, T34, T36, T37, T38 } from '../components/config/config-texts';
import { VoicePanel } from '../components/voice/VoicePanel';
import { VoiceServiceCreate, VoiceServiceDetail } from '../components/voice/VoiceServiceEditor';
import { ImagePanel } from '../components/image/ImagePanel';
import { ImageServiceCreate, ImageServiceDetail, type ImageService } from '../components/image/ImageServiceEditor';
import { type VoiceServiceItem } from '../voice-config';
import { ModelNamePicker } from '../components/model/ModelNamePicker';
import { SecretInput } from '../components/model/SecretInput';
import { useModelProbe, type ModelProbeTarget } from '../components/model/use-model-probe';
import {
  applyRevealedSecret,
  createSecretDraft,
  defaultModelBaseUrl,
  MODEL_ADAPTER_OPTIONS,
  modelAdapterOf,
  modelConnectionFields,
  parseVertexLocation, vertexLocationAddress, type VertexLocation,
  hasVertexSafety, vertexSafetyOf, type VertexSafetyLevel,
  modelCredentialScope,
  modelPresets,
  hideUneditedSecret,
  nextSecretDraftOnInput,
  resolveModelBaseUrlOnProtocolChange,
  SECRET_MASK_SENTINEL,
  secretOperationOf,
  visibleProbeNotice,
} from '../components/model/model-picker';
import { clearModelCache, providerCacheKey, writeModelCache } from '../components/model/model-cache';
import { mergeBindingDrafts } from '../components/model/binding-merge';
import type { ConfigDraftState } from '../components/config-draft';
import { savedImageModelOf } from '../image-config';
import { useThemePreset } from '../ui/presets';
import { ConfigThemeTransition } from '../ui/config-theme-transition';
import { TokenUsageSection } from '../components/config/TokenUsageSection';
import { EngineeringSection } from '../components/config/EngineeringSection';
import { isOrdinaryResource } from '../components/config/engineering-settings';

type Resource = { resourceId: string; adminSeatOnly?: boolean; kind: 'model' | 'mcp' | 'skill'; name: string; enabled: boolean; config: Record<string, unknown>; credential?: { status: string; reference?: string | null; resolvable: boolean }; lastTest?: { ok: boolean; stale: boolean; modelName: string } | null };

function savedModelNameOf(resource: Resource): string {
  if (typeof resource.config.modelName === 'string' && resource.config.modelName.trim()) {
    return resource.config.modelName.trim();
  }
  return resource.lastTest?.modelName ?? '';
}
type Binding = { capability: string; resourceId: string; modelName: string | null; enabled: boolean };
type Activity = { roleId: string; state: 'active' | 'stopping' | 'stopped'; running: boolean; initStatus: string };
type RoleSection = 'profile' | 'look' | 'models' | 'ext' | 'quota' | 'done';
type SettingsSection = 'model' | 'mcp' | 'skill' | 'roles' | 'usage' | 'local' | 'engineering';
type OpenSettingsOptions = {
  modelKind?: 'model' | 'voice' | 'image';
  resourceId?: string;
  newImageService?: boolean;
  newVoiceService?: boolean;
};
type Draft = { name: string; definition: string; revision: number; payload: Record<string, unknown>; isBuiltin: boolean; bio: string };
const roleSections: Array<[RoleSection, string, string]> = [['profile', '设定', '关于这个人'], ['look', '外观', '立绘与服饰'], ['models', '模型', '对话与演出'], ['ext', '扩展', '工具与知识'], ['quota', '自主额度', '属于自己的时间'], ['done', '完成度', '慢慢补全']];
const settingSections: Array<[SettingsSection, string, string]> = [['model', '模型', '服务与连接'], ['mcp', 'MCP', '工具服务'], ['skill', 'Skill', '方法与知识'], ['roles', '角色状态', '活动与停止'], ['usage', '用量', 'Token 消耗'], ['local', '本机', '此设备的偏好'], ['engineering', '工程', '工程模型与调度']];
const wideSection = (id: string) => id === 'roles' || id === 'usage' || id === 'engineering';
const modelBaseUrlPlaceholder = (adapter: string) => defaultModelBaseUrl(adapter) || 'https://…/v1';
const modelAdapterLabel = (adapter: string) => MODEL_ADAPTER_OPTIONS.find(option => option.value === adapter)?.label ?? adapter;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

type RoleDirty = { profile: boolean; models: boolean; voice: boolean; image: boolean; ext: boolean; quota: boolean };
type RoleEditorState = { dirty: RoleDirty; busy: boolean; profileCount: number; discardProfile: () => void; discard: () => void };
export type WorkspaceRequest = { kind: 'create' } | { kind: 'section'; section: 'models'; roleId: string }
  | { kind: 'section'; section: 'ext'; roleId: string; resourceId: string };
export type ConfigNavigationGuard = (next: string, proceed: () => void) => void;
type Props = { page: string; roles: RoleListItem[]; currentId: string; roleListError: string; retryingRoles: boolean; onRetryRoles: () => void; onRoleDeleted: (id: string) => void; onRefresh: () => Promise<void>; onNavigate: (page: string) => void; navigationGuard?: MutableRefObject<ConfigNavigationGuard | null>; footerLeft?: HTMLElement | null; footerRight?: HTMLElement | null; workspaceRequest?: (WorkspaceRequest & { key: number }) | null; onConfigureResource: (roleId: string, resourceId: string) => void; onWorkspaceRequestHandled?: (key: number) => void; onStartConversation?: (roleId: string) => void };

/** 两页常驻以保留跨页草稿；编辑对象绝不隐式改变当前角色（DL-147）。 */
export function SettingsWorkspace({ page, roles, currentId, roleListError, retryingRoles, onRetryRoles, onRoleDeleted, onRefresh, onNavigate, navigationGuard, footerLeft, footerRight, workspaceRequest, onConfigureResource, onWorkspaceRequestHandled, onStartConversation }: Props) {
  const motion = useMotionPolicy();
  const { preset } = useThemePreset();
  const [editId, setEditId] = useState('');
  const [visited, setVisited] = useState<string[]>([]);
  const [roleSection, setRoleSection] = useState<RoleSection>('profile');
  // 底栏角色下拉的目标：脏改动时先出 T37 确认，再把切换交给纸笺回调（规范 §7.9）。
  const [pendingSwitch, setPendingSwitch] = useState<{ roleId: string; to: string; count: number } | null>(null);
  // 纸笺状态在 Provider 内，页签在工作区层：用控制器引用跨层读取（仅用于切换前的关闭规则）。
  const sheetController = useRef<SheetContextValue | null>(null);
  const [stagePreview, setStagePreview] = useState<{ roleId: string; assetId: string | null } | null>(null);
  const [stageOutfitName, setStageOutfitName] = useState('');
  // 切换编辑对象时先清空立绘框上方的服饰名，等新角色读取完成再填。
  useEffect(() => { setStageOutfitName(''); }, [editId]);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('model');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [roleDirty, setRoleDirty] = useState<Record<string, RoleDirty>>({});
  const [profileCounts, setProfileCounts] = useState<Record<string, number>>({});
  const editorActions = useRef(new Map<string, RoleEditorState>());
  const [allResources, setResources] = useState<Resource[]>([]);
  const resources = useMemo(() => allResources.filter(isOrdinaryResource), [allResources]);
  const [removedResources, setRemovedResources] = useState<string[]>([]);
  const [resourceError, setResourceError] = useState('');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityError, setActivityError] = useState('');
  const [activityReady, setActivityReady] = useState(false);
  const [activityRefreshing, setActivityRefreshing] = useState(false);
  const handledWorkspaceKey = useRef<number | null>(null);
  const switchRef = useRef<HTMLButtonElement | HTMLSelectElement>(null);
  const roleFocus = useRef<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<HTMLElement>(null);
  const lastIndexSection = useRef<SettingsSection | null>(null);
  const sectionAnimations = useRef<Animation[]>([]);
  const sectionSequence = useRef(0);
  // 分区／页面切换后的焦点接管：纸笺关闭（R12-1）与「角色配置 → 设置」跳转共用同一落点，
  // 双帧等目标分区标题渲染完成；标题均带 tabIndex={-1}，可直接接收焦点。
  const focusSectionHeading = () => {
    const content = contentRef.current;
    if (!content) return;
    // 分区用 hidden 切换，只挑当前可见的标题（角色分区 .config-sec-head，设置分区 ConfigHeading）。
    const heading = [...content.querySelectorAll<HTMLElement>('h2')].find(item => item.offsetParent !== null);
    heading?.focus({ preventScroll: true });
  };
  const focusSectionHeadingSoon = (sequence?: number) => requestAnimationFrame(() => requestAnimationFrame(() => {
    if ((sequence === undefined || sequence === sectionSequence.current) && !sheetController.current?.sheet) focusSectionHeading();
  }));
  const [selectedResource, setSelectedResource] = useState('');
  const lastCatalogSelection = useRef<Partial<Record<ServiceKind, string>>>({});
  const [visitedResources, setVisitedResources] = useState<string[]>([]);
  const [modelKind, setModelKind] = useState<'model' | 'voice' | 'image'>('model');
  const [voiceServices, setVoiceServices] = useState<VoiceServiceItem[]>([]);
  const [voiceServiceError, setVoiceServiceError] = useState('');
  const [newVoiceService, setNewVoiceService] = useState(false);
  const [catalogReady, setCatalogReady] = useState({ resources: false, voice: false, image: false });
  const [localAnchor, setLocalAnchor] = useState('appearance');
  const [catalogTests, setCatalogTests] = useState<Record<string, boolean | null>>({});
  const rememberTest = (id: string, next: boolean | null) => setCatalogTests(previous => previous[id] === next ? previous : { ...previous, [id]: next });
  const addTrigger = useRef<HTMLElement | null>(null);
  const catalogFocus = useRef<{ id: string; sweep: boolean } | null>(null);
  const [voiceServiceVersion, setVoiceServiceVersion] = useState(0);
  const [voiceServiceEpochs, setVoiceServiceEpochs] = useState<Record<string, number>>({});
  const bumpVoiceServiceEpoch = (serviceId?: string) => {
    if (!serviceId) return;
    setVoiceServiceEpochs(previous => ({ ...previous, [serviceId]: (previous[serviceId] ?? 0) + 1 }));
  };
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
  const [modelSafety, setModelSafety] = useState<VertexSafetyLevel>('default');
  const newAddress = useModelAddress('');
  const { url: modelUrl, setAddress: setModelUrl } = newAddress;
  const [modelAdapter, setModelAdapter] = useState('openai-chat');
  const [modelSecret, setModelSecret] = useState('');
  const [showNewSecret, setShowNewSecret] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState('');
  const [newModelProbePrompt, setNewModelProbePrompt] = useState<ReturnType<typeof serviceProbeNotice>>(null);
  const writeController = useRef<ReturnType<typeof useWrite> | null>(null);
  const hasDrafts = () => !!sheetController.current?.dirty || [...editorActions.current.values()].some(item => Object.values(item.dirty).some(Boolean));
  useLayoutEffect(() => {
    if (!navigationGuard) return;
    navigationGuard.current = (next, proceed) => {
      const controller = sheetController.current;
      if (controller?.busy || controller?.closing || writeController.current?.busy || [...editorActions.current.values()].some(item => item.busy)) return;
      if (next === 'role-config' || next === 'settings') {
        if (controller?.sheet) controller.requestClose(() => { proceed(); focusSectionHeadingSoon(); });
        else proceed();
        return;
      }
      if (hasDrafts() && !window.confirm('还有改动没保存，要放弃修改并离开配置页吗？')) return;
      const leave = () => { editorActions.current.forEach(item => { if (Object.values(item.dirty).some(Boolean)) item.discard(); }); proceed(); };
      if (controller?.sheet) controller.discardNow(leave);
      else leave();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDrafts() && !writeController.current?.busy) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const checkDrafts = (event: Event) => {
      if (hasDrafts() || writeController.current?.busy) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('nowadays:check-drafts', checkDrafts);
    return () => {
      navigationGuard.current = null;
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('nowadays:check-drafts', checkDrafts);
    };
  }, [navigationGuard]);
  const newModelProbe = useModelProbe(`${modelAdapter}|${modelUrl}|${modelSafety}|${newAddress.manualExpress}|${modelSecret}`);
  const changeNewModelAdapter = (next: string) => {
    const url = resolveModelBaseUrlOnProtocolChange(modelUrl, next, modelAdapter);
    if (modelCredentialScope(next, url) !== modelCredentialScope(modelAdapter, modelUrl)) {
      setModelSecret('');
      setShowNewSecret(false);
    }
    setModelAdapter(next);
    setModelUrl(url);
    newModelProbe.reset();
  };
  const closeNewModelDraft = () => {
    setNewModel(false);
    setModelName('');
    setModelAdapter('openai-chat');
    setModelSafety('default');
    setModelUrl('');
    setModelSecret('');
    setShowNewSecret(false);
    setNewModelName('');
    setModelError('');
    newModelProbe.reset();
  };
  const [refreshVersion, setRefreshVersion] = useState(0);
  const roleActive = page === 'role-config';
  const settingsActive = page === 'settings';
  const newModelVisible = settingsActive && settingsSection === 'model' && modelKind === 'model' && newModel;
  const viewRef = useRef({ roleActive, settingsActive, settingsSection, newModel, newExtension, editId });
  const updateEditorState = useCallback((roleId: string, value: RoleEditorState | null) => {
    if (!value) { editorActions.current.delete(roleId); return; }
    editorActions.current.set(roleId, value);
    setProfileCounts(previous => previous[roleId] === value.profileCount ? previous : { ...previous, [roleId]: value.profileCount });
    setRoleDirty(previous => {
      const current = previous[roleId];
      return current && current.profile === value.dirty.profile && current.models === value.dirty.models && current.voice === value.dirty.voice && current.image === value.dirty.image && current.ext === value.dirty.ext && current.quota === value.dirty.quota ? previous : { ...previous, [roleId]: value.dirty };
    });
  }, []);
  viewRef.current = { roleActive, settingsActive, settingsSection, newModel, newExtension, editId };
  useEffect(() => {
    if (!roles.some(role => role.roleId === editId)) setEditId(roles.find(role => role.roleId === currentId)?.roleId || roles[0]?.roleId || '');
  }, [roles, currentId, editId]);
  useEffect(() => { if (editId) setVisited(previous => previous.includes(editId) ? previous : [...previous, editId]); }, [editId]);
  useEffect(() => {
    if (!workspaceRequest || page !== 'role-config') return;
    if (handledWorkspaceKey.current === workspaceRequest.key) return;
    if (workspaceRequest.kind === 'create') {
      handledWorkspaceKey.current = workspaceRequest.key;
      sheetController.current?.open({ id: 'create-role', title: '新建角色', shape: 'full' });
      onWorkspaceRequestHandled?.(workspaceRequest.key);
      return;
    }
    if (!roles.some(role => role.roleId === workspaceRequest.roleId)) return;
    handledWorkspaceKey.current = workspaceRequest.key;
    setEditId(workspaceRequest.roleId);
    setRoleSection(workspaceRequest.section);
    if (workspaceRequest.section === 'ext') {
      const resource = resources.find(item => item.resourceId === workspaceRequest.resourceId);
      if (resource && resource.kind !== 'model') sheetController.current?.open({
        id: 'ext:' + resource.kind, title: resource.kind === 'mcp' ? 'MCP' : 'Skill',
        shape: 'full', resourceId: resource.resourceId
      });
    }
    onWorkspaceRequestHandled?.(workspaceRequest.key);
  }, [workspaceRequest, page, roles, resources, onWorkspaceRequestHandled]);
  const activityRead = useRef(0);
  const requestedStops = useRef(new Set<string>());
  const readActivities = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++activityRead.current;
    setActivityRefreshing(true);
    try {
      const result = await api<{ items: Activity[] }>('/v1/activities', { signal });
      if (signal?.aborted || sequence !== activityRead.current) return false;
      setActivities(result.items);
      setActivityError('');
      setActivityReady(true);
      return true;
    } catch (error) {
      if (signal?.aborted || sequence !== activityRead.current) return false;
      setActivityError(errorText(error));
      return false;
    } finally {
      if (sequence === activityRead.current) setActivityRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (!roleActive && !settingsActive) return;
    const request = new AbortController();
    const { signal } = request;
    void readActivities(signal);
    api<{ items: Resource[] }>('/v1/resources', { signal }).then(result => { if (!signal.aborted) { setResources(result.items); setResourceError(''); } }).catch(e => { if (!signal.aborted) setResourceError(errorText(e)); }).finally(() => { if (!signal.aborted) setCatalogReady(previous => ({ ...previous, resources: true })); });
    api<{ items: VoiceServiceItem[] }>('/v1/voice-services', { signal }).then(result => { if (!signal.aborted) { setVoiceServices(result.items); setVoiceServiceError(''); } }).catch(e => { if (!signal.aborted) setVoiceServiceError(errorText(e)); }).finally(() => { if (!signal.aborted) setCatalogReady(previous => ({ ...previous, voice: true })); });
    api<{ items: ImageService[] }>('/v1/image-services', { signal }).then(result => { if (!signal.aborted) { setImageServices(result.items); setImageServiceError(''); } }).catch(e => { if (!signal.aborted) setImageServiceError(errorText(e)); }).finally(() => { if (!signal.aborted) setCatalogReady(previous => ({ ...previous, image: true })); });
    return () => request.abort();
  }, [page, refreshVersion, readActivities]);
  useEffect(() => {
    if (!activities.some(item => item.state === 'stopping') || (requestedStops.current.size === 0 && (!settingsActive || settingsSection !== 'roles'))) return;
    const request = new AbortController();
    const timer = window.setInterval(() => void readActivities(request.signal), 750);
    return () => { window.clearInterval(timer); request.abort(); };
  }, [settingsActive, settingsSection, activities, readActivities]);
  useEffect(() => {
    const confirmed: string[] = [];
    for (const item of activities) {
      if (item.state === 'stopped' && requestedStops.current.delete(item.roleId)) confirmed.push(roleDisplayName(roles, item.roleId));
    }
    if (confirmed.length) writeController.current?.reportResult(`${confirmed.join('、')} 已停止`);
  }, [activities, roles]);
  useLayoutEffect(() => {
    const previous = lastIndexSection.current;
    lastIndexSection.current = settingsActive ? settingsSection : null;
    if (!settingsActive || !previous || previous === settingsSection || wideSection(previous) || wideSection(settingsSection)) return;
    const element = indexRef.current;
    if (!element) return;
    const duration = readMotionTime(element, '--nd-semantic-motion-component', 220);
    if (duration <= 0) return;
    const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: readMotionValue(element, '--nd-semantic-motion-ease-out', 'ease-out') });
    return () => animation.cancel();
  }, [settingsActive, settingsSection, motion.reduced]);
  useEffect(() => {
    if (newModelVisible) return;
    newModelProbe.clearLog();
    setModelError('');
    setShowNewSecret(false);
  }, [newModelVisible, newModelProbe.clearLog]);
  const openSettings = (section: SettingsSection, options?: OpenSettingsOptions) => {
    setNewModel(false);
    setNewExtension(null);
    setNewVoiceService(Boolean(options?.newVoiceService));
    setNewImageService(Boolean(options?.newImageService));
    if (options?.modelKind) {
      setModelKind(options.modelKind);
    }
    if (options?.resourceId !== undefined) setSelectedResource(options.resourceId);
    setSettingsSection(section);
    onNavigate('settings');
    // 跨页跳转后原按钮随角色页面卸载，焦点会落回 body；交给设置分区的标题（R12-1 同类）。
    focusSectionHeadingSoon();
  };
  useEffect(() => setNewModelProbePrompt(null), [modelUrl, modelAdapter, modelSafety, newAddress.manualExpress, modelSecret, newModelName, newModelVisible]);
  const newModelTarget = (): ModelProbeTarget => ({ kind: 'draft', config: { ...modelConnectionFields(modelAdapter, modelUrl, undefined, modelSafety, newAddress.manualExpress), ...(modelSecret ? { secret: modelSecret } : {}) } });
  const runNewModelProbe = (action: 'test' | 'list') => {
    const required = newAddress.error || (!modelUrl.trim() ? T16.needUrl : action === 'test' && !newModelName.trim() ? T16.needModel : '');
    setNewModelProbePrompt(required ? { source: action, role: 'alert', text: required } : null);
    if (required) { newModelProbe.clearLog(); return; }
    if (action === 'list') void newModelProbe.refresh(newModelTarget());
    else void newModelProbe.test(newModelTarget(), newModelName.trim());
  };
  const newModelNotice = newModelProbePrompt ?? serviceProbeNotice(newModelProbe.notice, newModelProbe.models.length);
  const createModel = async () => {
    if (modelBusy || !modelName.trim() || !modelUrl.trim()) return;
    // 保存前的草稿候选与提交配置一致时，转给保存后的资源继续共享。
    const carriedModels = newModelProbe.listLoaded ? [...newModelProbe.models] : [];
    const trimmedModel = newModelName.trim();
    const carriedTestCallId = newModelProbe.testModel === trimmedModel ? newModelProbe.draftTestCallId : undefined;
    const finish = writeController.current?.beginWrite();
    if (!finish) return;
    setModelBusy(true); setModelError('');
    try {
      const config: Record<string, unknown> = {
        ...modelConnectionFields(modelAdapter, modelUrl, undefined, modelSafety, newAddress.manualExpress),
        ...(trimmedModel ? { modelName: trimmedModel } : {}),
      };
      const resource = await api<Resource>('/v1/resources', {
        method: 'POST',
        body: {
          kind: 'model',
          name: modelName.trim(),
          config,
          ...(modelSecret ? { secret: modelSecret } : {}),
          ...(carriedTestCallId ? { draftTestCallId: carriedTestCallId } : {}),
          ...(newModelProbe.draftRouteTestIds.length ? { draftRouteTestIds: newModelProbe.draftRouteTestIds } : {}),
        },
      });
      if (newModelProbe.listLoaded) writeModelCache(providerCacheKey(resource), carriedModels);
      if (newModelProbe.notice?.source === 'test' && newModelProbe.testModel === trimmedModel) rememberTest(resource.resourceId, newModelProbe.notice.role === 'status');
      setResources(previous => [...previous.filter(item => item.resourceId !== resource.resourceId), resource]);
      setRefreshVersion(v => v + 1);
      const message = `${resource.name} 已添加`;
      if (viewRef.current.settingsActive && viewRef.current.settingsSection === 'model' && viewRef.current.newModel) {
        sheetController.current?.closeNow(() => {
          selectAfterChange(resource.resourceId, true);
          closeNewModelDraft();
        }, message);
      } else writeController.current?.reportResult(message);
    } catch (e) { setModelError(T32.saveFail('添加', errorText(e))); } finally { setModelBusy(false); finish(); }
  };
  const chosen = roles.find(role => role.roleId === editId);
  const applyRole = (roleId: string) => {
    if (roleId === '__new') {
      sheetController.current?.open({ id: 'create-role', title: '新建角色', shape: 'full' });
      return;
    }
    if (roleId === editId) return;
    setStagePreview(null);
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setVisited(previous => previous.includes(roleId) ? previous : [...previous, roleId]);
    setEditId(roleId);
  };
  const applyRoleAndFocus = (roleId: string) => {
    if (roleId !== '__new') roleFocus.current = roleId;
    applyRole(roleId);
  };
  useLayoutEffect(() => {
    if (!roleActive || roleFocus.current !== editId) return;
    roleFocus.current = null;
    focusSectionHeading();
  }, [editId, roleActive]);
  const switchRole = (roleId: string) => {
    if (roleId === editId) return;
    const afterClose = () => {
      const count = editorActions.current.get(editId)?.profileCount ?? 0;
      if (roleId !== '__new' && count > 0) {
        const to = roles.find(role => role.roleId === roleId)?.displayName || '该角色';
        setPendingSwitch({ roleId, to, count });
        sheetController.current?.open({ id: 'switch-role', title: '切换角色', shape: 'confirm', focusReturn: switchRef.current });
      } else applyRoleAndFocus(roleId);
    };
    const controller = sheetController.current;
    if (controller?.sheet) controller.requestClose(afterClose);
    else if (!controller?.closing && !writeController.current?.busy && !editorActions.current.get(editId)?.busy) afterClose();
  };
  const cancelWorkspaceMotion = () => {
    const sequence = ++sectionSequence.current;
    sectionAnimations.current.forEach(animation => animation.cancel());
    sectionAnimations.current = [];
    return sequence;
  };
  const animateWorkspaceChange = (targets: () => HTMLElement[], commit: (sequence: number) => void) => {
    const visible = targets().map(element => ({ element, opacity: getComputedStyle(element).opacity }));
    const sequence = cancelWorkspaceMotion();
    const exit = readMotionTime(contentRef.current, '--nd-semantic-motion-micro-exit', 0);
    if (exit <= 0) { commit(sequence); return; }
    sectionAnimations.current = visible.map(({ element, opacity }) => element.animate([{ opacity }, { opacity: 0 }], {
      duration: exit, easing: readMotionValue(element, '--nd-semantic-motion-ease-in', 'ease-in'), fill: 'forwards',
    }));
    void Promise.allSettled(sectionAnimations.current.map(animation => animation.finished)).then(() => {
      if (sequence !== sectionSequence.current) return;
      flushSync(() => commit(sequence));
      sectionAnimations.current.forEach(animation => animation.cancel());
      sectionAnimations.current = targets().flatMap(element => {
        const duration = readMotionTime(element, '--nd-semantic-motion-component', 220);
        if (duration <= 0) return [];
        const offset = readMotionPx(element, '--nd-semantic-motion-detail-page-offset', 4);
        return [element.animate([{ opacity: 0, transform: `translateY(${offset}px)` }, { opacity: 1, transform: 'none' }], {
          duration, easing: readMotionValue(element, '--nd-semantic-motion-ease-out', 'ease-out'),
        })];
      });
    });
  };
  // 书脊普通切换只过渡正文；设置角色状态改变整本书的列宽，因此连同书脊与底栏一起过渡。
  const changeSection = (id: string) => {
    const apply = (takeFocus = false) => {
      const currentSection = roleActive ? roleSection : settingsSection;
      if (currentSection === id) { cancelWorkspaceMotion(); return; }
      const content = contentRef.current;
      const currentWide = wideSection(currentSection);
      const nextWide = wideSection(id);
      const full = settingsActive && currentWide !== nextWide;
      const targets = () => full ? [...document.querySelectorAll<HTMLElement>('.studio-shell:not(.config-theme-veil) :is(.config-stage,.config-index,.config-tabs,.config-leaf,#config-footer-left,#config-footer-right)')].filter(item => item.offsetParent !== null) : content ? [content] : [];
      animateWorkspaceChange(targets, sequence => {
        if (roleActive) { setStagePreview(null); setRoleSection(id as RoleSection); }
        else setSettingsSection(id as SettingsSection);
        if (content) content.scrollTop = 0;
        if (takeFocus) focusSectionHeadingSoon(sequence);
      });
    };
    const current = sheetController.current;
    if (current?.sheet) current.requestClose(() => apply(true));
    else if (!current?.closing && !writeController.current?.busy) apply();
  };
  useLayoutEffect(() => { if (motion.reduced) sectionAnimations.current.forEach(animation => animation.cancel()); }, [motion.reduced]);
  const lastPage = useRef(page);
  useLayoutEffect(() => {
    const previous = lastPage.current;
    lastPage.current = page;
    cancelWorkspaceMotion();
    if ((roleActive || settingsActive) && (previous === 'role-config' || previous === 'settings') && previous !== page) {
      if (contentRef.current) contentRef.current.scrollTop = 0;
      focusSectionHeading();
    }
  }, [page]);

  // 新建角色纸笺创建成功：刷新列表、建立草稿并切到新角色。
  const createFromSheet = async (role: RoleDetail) => {
    await onRefresh();
    setRefreshVersion(v => v + 1);
    setDrafts(previous => ({ ...previous, [role.roleId]: { name: role.displayName, definition: role.definition.text, revision: role.definitionRevision, payload: role.definition.payload, isBuiltin: role.isBuiltin === true, bio: role.bio ?? '' } }));
    setEditId(role.roleId);
    setRoleSection('profile');
    requestAnimationFrame(() => switchRef.current?.focus({ preventScroll: true }));
  };
  const filtered = resources.filter(item => item.kind === settingsSection);
  const catalogKind: ServiceKind | null = settingsSection === 'model' ? modelKind : settingsSection === 'mcp' || settingsSection === 'skill' ? settingsSection : null;
  useEffect(() => {
    if (!catalogKind) return;
    const ids = catalogKind === 'voice' ? voiceServices.map(item => item.serviceId) : catalogKind === 'image' ? imageServices.map(item => item.serviceId)
      : resources.filter(item => item.kind === catalogKind).map(item => item.resourceId);
    if (ids.includes(selectedResource)) {
      lastCatalogSelection.current[catalogKind] = selectedResource;
      return;
    }
    const previous = lastCatalogSelection.current[catalogKind];
    setSelectedResource(previous && ids.includes(previous) ? previous : ids[0] || '');
  }, [catalogKind, resources, selectedResource, voiceServices, imageServices]);
  useEffect(() => { if (resources.some(item => item.resourceId === selectedResource)) setVisitedResources(previous => previous.includes(selectedResource) ? previous : [...previous, selectedResource]); }, [resources, selectedResource]);
  const catalogSource = catalogKind === 'voice' || catalogKind === 'image' ? catalogKind : 'resources';
  const catalogError = catalogSource === 'voice' ? voiceServiceError : catalogSource === 'image' ? imageServiceError : resourceError;
  const catalogLoading = !catalogReady[catalogSource];
  const indexEntries: ServiceIndexEntry[] = catalogKind === 'voice' ? voiceServices.map(item => ({
    id: item.serviceId, name: item.name, subtitle: `${item.config.defaultEngine || '自动引擎'} · ${serviceHost(item.config.baseUrl)}`, status: serviceStatus(item.enabled, catalogTests[item.serviceId] ?? undefined),
  })) : catalogKind === 'image' ? imageServices.map(item => ({
    id: item.serviceId, name: item.name, subtitle: `${savedImageModelOf(item).replace(/\.safetensors$/, '') || '未设默认模型'} · ${serviceHost(item.config.baseUrl)}`, status: serviceStatus(item.enabled, catalogTests[item.serviceId] ?? null),
  })) : filtered.map(item => ({
    id: item.resourceId, name: item.name,
    subtitle: item.kind === 'model' ? `${savedModelNameOf(item) || '未选模型'} · ${serviceHost(String(item.config.baseUrl ?? ''))}`
      : item.kind === 'mcp' ? `stdio · ${String(item.config.command ?? '')}`
      : String(item.config.sourcePath ?? '').split(/[\\/]/).filter(Boolean).slice(-2).join('\\'),
    status: serviceStatus(item.enabled, item.kind === 'model' ? item.resourceId in catalogTests ? catalogTests[item.resourceId] : item.lastTest && !item.lastTest.stale ? item.lastTest.ok : null : undefined),
  }));
  const afterSheetClose = (action: () => void) => {
    const sheet = sheetController.current;
    if (sheet?.sheet) sheet.requestClose(action);
    else if (!sheet?.closing && !writeController.current?.busy) action();
  };
  const changeServiceKind = (kind: typeof modelKind) => {
    if (kind === modelKind) { cancelWorkspaceMotion(); return; }
    afterSheetClose(() => {
      const surfaces = () => [contentRef.current, indexRef.current?.querySelector<HTMLElement>('.config-index-list')]
        .filter((item): item is HTMLElement => Boolean(item));
      animateWorkspaceChange(surfaces, () => {
        setModelKind(kind);
        setNewModel(false);
        setNewVoiceService(false);
        setNewImageService(false);
        for (const element of surfaces()) element.scrollTop = 0;
      });
    });
  };
  const selectAfterChange = (id: string, sweep: boolean) => {
    catalogFocus.current = { id, sweep };
    setSelectedResource(id);
  };
  useEffect(() => {
    const next = catalogFocus.current;
    if (!settingsActive || !next || selectedResource !== next.id) return;
    catalogFocus.current = null;
    requestAnimationFrame(() => {
      const entry = next.id ? document.querySelector<HTMLElement>(`.config-index-item[data-resource-id="${CSS.escape(next.id)}"]`) : document.querySelector<HTMLElement>('.config-leaf-body h2');
      entry?.scrollIntoView({ block: 'nearest' });
      entry?.focus({ preventScroll: true });
      if (next.sweep) {
        sweepSavedElement(entry);
        sweepSavedElement(document.querySelector<HTMLElement>('.config-prose:not([hidden]) .config-service-head'));
      }
    });
  }, [settingsActive, selectedResource]);
  const removeCatalogItem = (id: string) => {
    const index = indexEntries.findIndex(entry => entry.id === id);
    if (index >= 0) writeController.current?.reportResult(`已删除「${indexEntries[index].name}」`);
    const next = indexEntries[index + 1]?.id ?? indexEntries[index - 1]?.id ?? '';
    selectAfterChange(next, false);
  };
  const addCatalogItem = (anchor: HTMLElement) => {
    afterSheetClose(() => {
      addTrigger.current = anchor;
      if (catalogKind === 'model') setNewModel(true);
      else if (catalogKind === 'voice') setNewVoiceService(true);
      else if (catalogKind === 'image') setNewImageService(true);
      else if (catalogKind) setNewExtension(catalogKind);
    });
  };
  const sectionTitle = (roleActive ? roleSections : settingSections).find(item => item[0] === (roleActive ? roleSection : settingsSection))?.[1];
  const dirtyScopes = roleDirty[editId];
  return <WriteProvider roleName={id => roleDisplayName(roles, id)} onActivityChanged={() => setRefreshVersion(v => v + 1)}><SheetProvider controller={sheetController}><div className="config-workspace" data-ui-theme="xiacheng" data-ui-preset={preset} hidden={!roleActive && !settingsActive}>
    <LiveAnnouncer/>
    <WriteResultNotice/>
    {(roleActive || settingsActive) && <ConfigThemeTransition/>}
    <PausedRolesFooter roles={roles} controller={writeController}/>
    {footerLeft && roleActive && createPortal(<RoleFooterIdentity role={chosen} activity={activities.find(item => item.roleId === editId)} error={!!activityError} englishName={drafts[editId]?.payload.englishName}/>, footerLeft)}
    {footerRight && roleActive && createPortal( <div className="config-footer-tools"><select ref={switchRef as React.RefObject<HTMLSelectElement>} className="config-role-switch" aria-label="切换角色" value={editId} onChange={event => { const next = event.target.value; event.target.value = editId; switchRole(next); }}>
      {roles.map(role => { const state = activities.find(item => item.roleId === role.roleId)?.state; return <option key={role.roleId} value={role.roleId}>{role.displayName}{state === 'stopped' ? '（已停止）' : ''}</option>; })}
      <option value="__new">＋ 新建角色…</option>
    </select></div>, footerRight)}
    <div className="config-book" data-layout={settingsActive && wideSection(settingsSection) ? 'wide' : settingsActive ? 'catalog' : 'role'}>
      <div className="config-book-surface" aria-hidden="true"><div className="config-paper-left"/><div className="config-gutter"/><div className="config-paper-right"/><div className="config-grain"/><div className="config-thread"><i/><i/></div></div>
      {roleActive ? <aside className="config-stage"><figure className="config-plate"><div className="config-plate-mat"/><div className="config-stage-label" data-testid="stage-label" title={stageOutfitName}><span>{stageOutfitName}</span></div>
        <RolePortrait roleId={editId} version={refreshVersion} previewAssetId={stagePreview?.roleId === editId && roleSection === 'look' ? stagePreview.assetId : undefined} onOutfitName={setStageOutfitName} />
      </figure></aside> : <aside className="config-index" ref={indexRef}>
        {settingsSection === 'model' && <div className="config-index-heading"><div className="config-kind-tabs" role="group" aria-label="模型分类" data-active={modelKind}><i aria-hidden="true"/>{([['model', '模型'], ['voice', '语音'], ['image', '生图']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={modelKind === id} onClick={() => changeServiceKind(id)}>{label}</button>)}</div></div>}
        {settingsSection === 'local' ? <div className="config-index-list">{([['appearance','外观与动效'], ['connection','版本与连接']] as const).map(([id, label], index) => <button key={id} type="button" className="config-index-item config-local-anchor" data-selected={localAnchor === id} aria-current={localAnchor === id ? 'true' : undefined} onClick={() => { setLocalAnchor(id); document.getElementById(`config-local-${id}`)?.scrollIntoView({ block: 'start' }); }}><small>{String(index + 1).padStart(2, '0')}</small><strong>{label}</strong></button>)}</div>
          : catalogKind && <ServiceIndex kind={catalogKind} entries={indexEntries} selected={selectedResource} loading={catalogLoading} onSelect={id => { if (id !== selectedResource) afterSheetClose(() => setSelectedResource(id)); }} onAdd={addCatalogItem}/>}
      </aside>}
      <nav className="config-tabs" aria-label={roleActive ? '角色配置分区' : '设置分区'} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault(); tabs[next]?.focus();
      }}>{(roleActive ? roleSections : settingSections).map(([id, title], index) => <button key={id} type="button" aria-current={(roleActive ? roleSection : settingsSection) === id ? 'page' : undefined} aria-label={`${id === 'quota' ? '额度' : id === 'done' ? '完成' : id === 'roles' ? '角色' : title}${roleActive && (dirtyScopes?.[id as keyof RoleDirty] || (id === 'models' && (dirtyScopes?.voice || dirtyScopes?.image))) ? '，有未保存的改动' : ''}`} onClick={() => changeSection(id)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{id === 'quota' ? '额度' : id === 'done' ? '完成' : id === 'roles' ? '角色' : title}</strong>{roleActive && (dirtyScopes?.[id as keyof RoleDirty] || (id === 'models' && (dirtyScopes?.voice || dirtyScopes?.image))) && <i className="tab-dot" aria-hidden="true"/>}</button>)}</nav>
      <section className="config-leaf"><header className="config-leaf-head">{roleActive ? <div className="config-crumb">角色配置 <i>/</i> <span className="config-crumb-role" title={chosen?.displayName}>{chosen?.displayName || '选择角色'}</span> <i>/</i> <b>{sectionTitle}</b></div> : <button type="button" className="config-return-link" onClick={() => afterSheetClose(() => { onNavigate('role-config'); focusSectionHeadingSoon(); })}><Icon name="chev-left" size={14}/>返回角色配置</button>}</header>
        <div className="config-leaf-body" ref={contentRef}>
          {roleListError && <p role="alert" className="config-delete-notice">角色列表同步失败：{roleListError} <button type="button" disabled={retryingRoles} aria-busy={retryingRoles} onClick={onRetryRoles}>重试读取角色列表</button></p>}
          {visited.filter(id => roles.some(role => role.roleId === id)).map(id => <RoleEditor key={id} roleId={id} roleCount={roles.length} active={roleActive && editId === id} activity={activityError ? undefined : activities.find(item => item.roleId === id)} activityLoading={!activityError && (!activityReady || activityRefreshing)} voiceServiceVersion={voiceServiceVersion} voiceServiceEpochs={voiceServiceEpochs} imageServiceVersion={imageServiceVersion} imageServiceEpochs={imageServiceEpochs} section={roleSection} draft={drafts[id]} setDraft={draft => setDrafts(previous => ({ ...previous, [id]: draft }))} resources={resources} removedResources={removedResources} resourceError={resourceError} onEditorState={updateEditorState} onOpenSettings={openSettings} onStartConversation={onStartConversation} onPreviewOutfit={outfit => { setStageOutfitName(outfit.name); setStagePreview({ roleId: id, assetId: outfit.home?.assetId ?? null }); }} onPreviewAsset={assetId => setStagePreview({ roleId: id, assetId })} onClearPreview={() => setStagePreview(previous => previous?.roleId === id ? null : previous)} onChangeSection={changeSection} onDeleted={async (roleId, keepHistory, filesRemoved) => { const removedIndex = roles.findIndex(item => item.roleId === roleId); const nextRole = roles[removedIndex + 1] ?? roles[removedIndex - 1]; if (nextRole) setEditId(nextRole.roleId); onRoleDeleted(roleId); setStagePreview(previous => previous?.roleId === roleId ? null : previous); const message = keepHistory ? '角色已移除，记忆与对话数据保留在本机目录。' : filesRemoved ? '角色及其本机数据已删除。' : '角色已移除，部分文件尚待清理，后端将继续处理。'; writeController.current?.reportResult(message, !keepHistory && !filesRemoved ? 'warning' : 'success'); await onRefresh(); setDrafts(previous => { const next = { ...previous }; delete next[roleId]; return next; }); setRefreshVersion(v => v + 1); focusSectionHeadingSoon(); }} onRefresh={async () => { await onRefresh(); setRefreshVersion(v => v + 1); }} />)}
          {roleActive && !editId && <p>还没有角色，可以从下方新建一位。</p>}
          {visitedResources.map(id => {
            const resource = resources.find(item => item.resourceId === id);
            if (!resource) return null;
            const visible = settingsActive && !catalogError && id === selectedResource && resource.kind === catalogKind;
            return <ResourceDetail key={id} resource={resource}
              onConfigure={editId ? () => onConfigureResource(editId, id) : undefined} roles={roles} activities={activities} active={visible} canWrite={true} testedOverride={catalogTests[id]} onTested={tested => rememberTest(id, tested)}
              onRemoved={resourceId => { removeCatalogItem(resourceId); setResources(previous => previous.filter(item => item.resourceId !== resourceId)); setRemovedResources(previous => previous.includes(resourceId) ? previous : [...previous, resourceId]); }}
              onUpdated={item => { if (item) setResources(previous => previous.map(existing => existing.resourceId === item.resourceId ? item : existing)); setRefreshVersion(v => v + 1); }}/>;
          })}
          {(['mcp', 'skill'] as const).map(kind => <ExtensionCreate key={kind} kind={kind} active={settingsActive && settingsSection === kind && newExtension === kind} trigger={addTrigger.current}
            onCancel={() => setNewExtension(null)}
            onCreated={(added: Resource[]) => { const resource = added[0]!; setResources(previous => [...previous, ...added]); setRefreshVersion(v => v + 1); if (viewRef.current.settingsActive && viewRef.current.settingsSection === kind && viewRef.current.newExtension === kind) { selectAfterChange(resource.resourceId, true); setNewExtension(null); } }}/>)}
          {settingsActive && catalogKind && (catalogLoading || catalogError || !indexEntries.length) && <ServiceIndexState kind={catalogKind} loading={catalogLoading} error={catalogError} onRetry={() => {
            setCatalogReady(previous => ({ ...previous, [catalogSource]: false }));
            setRefreshVersion(v => v + 1);
          }}/>}
          {settingsActive && catalogKind === 'voice' && !catalogError && voiceServices.some(item => item.serviceId === selectedResource) && <VoiceServiceDetail key={selectedResource} service={voiceServices.find(item => item.serviceId === selectedResource)} activities={activities} roles={roles}
            tested={catalogTests[selectedResource]} onTested={tested => rememberTest(selectedResource, tested)}
            onUpdated={(changedId, updated) => { if (updated) setVoiceServices(previous => previous.map(item => item.serviceId === updated.serviceId ? updated : item)); bumpVoiceServiceEpoch(changedId); setVoiceServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}
            onRemoved={removedId => { removeCatalogItem(removedId); bumpVoiceServiceEpoch(removedId); setVoiceServices(previous => previous.filter(item => item.serviceId !== removedId)); setVoiceServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}/>}
          {settingsActive && catalogKind === 'image' && !catalogError && imageServices.some(item => item.serviceId === selectedResource) && <ImageServiceDetail key={selectedResource} service={imageServices.find(item => item.serviceId === selectedResource)} activities={activities} roles={roles}
            tested={catalogTests[selectedResource]} onTested={tested => rememberTest(selectedResource, tested)}
            onUpdated={(changedId, updated) => { if (updated) setImageServices(previous => previous.map(item => item.serviceId === updated.serviceId ? updated : item)); bumpImageServiceEpoch(changedId); setImageServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}
            onRemoved={removedId => { removeCatalogItem(removedId); bumpImageServiceEpoch(removedId); setImageServices(previous => previous.filter(item => item.serviceId !== removedId)); setImageServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}/>}
          {settingsActive && catalogKind === 'voice' && newVoiceService && <VoiceServiceCreate trigger={addTrigger.current} onCancel={() => setNewVoiceService(false)} onCreated={(service, tested) => { if (tested !== undefined) rememberTest(service.serviceId, tested); bumpVoiceServiceEpoch(service.serviceId); setVoiceServices(previous => [...previous.filter(item => item.serviceId !== service.serviceId), service]); selectAfterChange(service.serviceId, true); setNewVoiceService(false); setVoiceServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}/>}
          {settingsActive && catalogKind === 'image' && newImageService && <ImageServiceCreate trigger={addTrigger.current} onCancel={() => setNewImageService(false)} onCreated={(service, tested) => { if (tested !== undefined) rememberTest(service.serviceId, tested); bumpImageServiceEpoch(service.serviceId); setImageServices(previous => [...previous.filter(item => item.serviceId !== service.serviceId), service]); selectAfterChange(service.serviceId, true); setNewImageService(false); setImageServiceVersion(v => v + 1); setRefreshVersion(v => v + 1); }}/>}
          <NewModelSheet active={newModelVisible} trigger={addTrigger.current}
            count={[modelName.trim(), modelUrl.trim(), modelSecret, newModelName.trim(), modelAdapter !== 'openai-chat', hasVertexSafety(modelAdapter, modelUrl) && modelSafety !== 'default'].filter(Boolean).length}
            busy={modelBusy} invalid={!modelName.trim() ? T10.name : newAddress.error || (!modelUrl.trim() ? T10.url : '')}
            error={modelError} onSave={() => void createModel()} onCancel={closeNewModelDraft}>
            {group => <>
              <MediaGroup title="名称" group={group}>
                <div className="config-service-field-one"><Field label="模型服务名称"><Input disabled={modelBusy} value={modelName} maxLength={200} placeholder="起一个好认的名字" onChange={event => setModelName(event.target.value)}/></Field></div>
              </MediaGroup>
              <MediaGroup title="连接" group={group}>
                <ModelConnectionInputs safety={modelSafety} onSafety={setModelSafety} adapter={modelAdapter} address={newAddress} disabled={modelBusy} onAdapter={changeNewModelAdapter}
                  onAddress={value => { setModelUrl(value); newModelProbe.reset(); }}/>
              </MediaGroup>
              <MediaGroup title="密钥" group={group}>
                <SecretInput aria-label="模型密钥" placeholder="选填" disabled={modelBusy} value={modelSecret} visible={showNewSecret}
                  onToggleVisible={() => setShowNewSecret(previous => !previous)} onChange={next => { setModelSecret(next); newModelProbe.reset(); }}/>
              </MediaGroup>
              <MediaGroup title="模型" group={group}>
                <ModelNamePicker settings value={newModelName} onChange={value => { setNewModelName(value); newModelProbe.invalidateTest(); }}
                  presets={modelPresets(modelAdapter, modelUrl)} models={newModelProbe.models} listBusy={newModelProbe.listBusy} listError={newModelProbe.listError}
                  listLoaded={newModelProbe.listLoaded} testBusy={newModelProbe.testBusy} testNote={newModelProbe.testModel === newModelName ? newModelProbe.testNote : ''}
                  notice={newModelNotice} onRefresh={() => runNewModelProbe('list')} onTest={() => runNewModelProbe('test')} disabled={modelBusy}/>
              </MediaGroup>
            </>}
          </NewModelSheet>
          {settingsActive && settingsSection === 'roles' && <RoleStatusCards roles={roles} activities={activities} loading={!activityReady || activityRefreshing} error={activityError}
            onRefresh={readActivities} onRolesChanged={onRefresh}
            onChanged={item => { if (item.state === 'stopping') requestedStops.current.add(item.roleId); activityRead.current += 1; setActivityRefreshing(false); setActivities(previous => [...previous.filter(value => value.roleId !== item.roleId), item]); }}
            onConfigure={roleId => { setEditId(roleId); setRoleSection('profile'); onNavigate('role-config'); focusSectionHeadingSoon(); }}/>}
          {settingsActive && settingsSection === 'usage' && <TokenUsageSection active={true} />}
          {settingsActive && settingsSection === 'engineering' && <EngineeringSection models={resources.filter(item => item.kind === 'model' && item.enabled)}
            catalogError={resourceError} catalogReady={catalogReady.resources} onAddService={() => {
              setModelKind('model'); changeSection('model'); setNewModel(true);
            }}/>}
          {settingsActive && settingsSection === 'local' && <div className="config-prose config-local-page"><header className="config-sec-head"><h2 tabIndex={-1}>本机</h2></header>
            <div className="config-grp" id="config-local-appearance"><div className="config-grp-label"><b>外观与动效</b></div><div className="config-grp-fields"><Field label="动效偏好"><Select value={motion.preference} onChange={event => motion.select(event.target.value as MotionPreference)}><option value="system">跟随系统</option><option value="reduced">减少动效</option><option value="full">完整动效</option></Select></Field></div></div>
            <div className="config-grp" id="config-local-connection"><div className="config-grp-label"><b>版本与连接</b></div><div className="config-grp-fields config-local-values">
              <div><span>资源读取</span><StatusDot status={resourceError ? 'error' : catalogReady.resources ? 'ok' : 'off'} label={resourceError ? T26.failed : catalogReady.resources ? T26.connected : '正在读取…'}/><SettingsRefresh label="刷新资源读取" success="资源读取已刷新" disabled={!catalogReady.resources} onRefresh={async signal => {
                setCatalogReady(previous => ({ ...previous, resources: false }));
                try {
                  const response = await api<{ items: Resource[] }>('/v1/resources', { signal });
                  if (signal.aborted) return false;
                  setResources(response.items); setResourceError('');
                  return true;
                } catch (error) { if (!signal.aborted) setResourceError(errorText(error)); return false; }
                finally { setCatalogReady(previous => ({ ...previous, resources: true })); }
              }}/></div><div><span>版本</span><b>{T26.version}</b></div>
            </div></div></div>}

        </div>
        <footer className="config-leaf-foot" id="config-leaf-actions" data-empty={!roleActive || !dirtyScopes?.profile ? 'true' : undefined}><span className="config-leaf-foot-label">{roleActive && dirtyScopes?.profile ? roleSection === 'profile' ? T6.state(profileCounts[editId] ?? 0) : T7(['设定']) : ''}</span>{roleActive && dirtyScopes?.profile && roleSection !== 'profile' && <button type="button" className="config-sheet-link" onClick={() => changeSection('profile')}>回去保存</button>}</footer>
        {/* 工作区级纸笺（T37／新建角色）挂在右页内：与分区纸笺共用双层压暗、右页承载与外部点击关闭（R11-3）。 */}
        <WorkspaceSheets pendingSwitch={pendingSwitch} clearPendingSwitch={() => setPendingSwitch(null)} onSwitch={roleId => { editorActions.current.get(editId)?.discardProfile(); applyRoleAndFocus(roleId); }} onCreated={createFromSheet}/>
      </section>
    </div>
  </div></SheetProvider></WriteProvider>;
}

function RoleFooterIdentity({ role, activity, error, englishName }: { role?: RoleListItem; activity?: Activity; error: boolean; englishName?: unknown }) {
  const write = useWrite();
  const resuming = role && write.resuming && write.pausedRoleIds.includes(role.roleId);
  const stopping = role && activity?.state !== 'stopped' && write.pendingPauseIds.includes(role.roleId);
  const state = resuming ? 'resuming' : stopping ? 'stopping' : activity?.state;
  const label = error ? '状态获取失败' : state ? T19[state] : '正在读取状态';
  const subtitle = typeof englishName === 'string' && englishName.trim() ? englishName.trim() : '';
  return <div className="config-footer-ident"><strong title={role?.displayName}>{role?.displayName || '角色配置'}</strong>
    <span data-activity={state}><StatusDot status={error ? 'error' : state === 'active' ? 'ok' : 'off'} label={label}/></span>
    {subtitle && <small title={subtitle}>{subtitle}</small>}
  </div>;
}

function RoleEditor({ roleId, roleCount, active, activity, activityLoading = false, voiceServiceVersion = 0, voiceServiceEpochs = {}, imageServiceVersion = 0, imageServiceEpochs = {}, section, draft, setDraft, resources, removedResources, resourceError, onEditorState, onOpenSettings, onStartConversation, onPreviewOutfit, onPreviewAsset, onClearPreview, onDeleted, onRefresh, onChangeSection }: { roleId: string; roleCount: number; active: boolean; activity?: Activity; activityLoading?: boolean; voiceServiceVersion?: number; voiceServiceEpochs?: Record<string, number>; imageServiceVersion?: number; imageServiceEpochs?: Record<string, number>; section: RoleSection; draft?: Draft; setDraft: (draft: Draft) => void; resources: Resource[]; removedResources: string[]; resourceError: string; onEditorState: (roleId: string, state: RoleEditorState | null) => void; onOpenSettings: (section: SettingsSection, options?: OpenSettingsOptions) => void; onStartConversation?: (roleId: string) => void; onPreviewOutfit: (outfit: Outfit) => void; onPreviewAsset: (assetId: string) => void; onClearPreview: () => void; onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void>; onRefresh: () => Promise<void>; onChangeSection: (section: RoleSection) => void }) {

  const write = useWrite();
  const sheetApi = useSheet();
  // 扩展与自主额度都按「一行 = 一张紧凑纸笺」打开（规范 §二.3 点击映射）。
  const openExtension = (kind: 'mcp' | 'skill', trigger: HTMLElement) => sheetApi.open({ id: `ext:${kind}`, title: kind === 'mcp' ? 'MCP' : 'Skill', shape: 'compact', anchor: trigger.closest<HTMLElement>('.config-sum') ?? trigger, focusReturn: trigger });
  const openQuota = (anchor: HTMLElement) => sheetApi.open({ id: 'quota', title: '自主额度 · 每日额度', shape: 'compact', anchor: anchor.closest<HTMLElement>('.config-sum') ?? anchor, focusReturn: anchor });
  // 对话：值与协议 → 紧凑「服务」，整行 / 编辑 → 完整；记忆：整行 → 紧凑整份（规范 §二.3）。
  const openChat = (group?: '服务' | '连接测试', anchor?: HTMLElement) => sheetApi.open({
    id: group === undefined ? 'model:chat' : `model:chat:${group === '服务' ? 'service' : 'test'}`,
    title: group === undefined ? '编辑对话' : `对话 · ${group}`,
    shape: group === undefined ? 'full' : 'compact',
    ...(group === undefined ? {} : { group, anchor: anchor?.closest<HTMLElement>('.config-sum') ?? null, focusReturn: anchor ?? null }),
  });
  const openMemory = (anchor?: HTMLElement) => sheetApi.open({ id: 'model:memory', title: '记忆整理', shape: 'compact', anchor: anchor?.closest<HTMLElement>('.config-sum') ?? anchor, focusReturn: anchor });
  const [voiceDraft, setVoiceDraft] = useState<ConfigDraftState | null>(null);
  const [imageDraft, setImageDraft] = useState<ConfigDraftState | null>(null);
  const [worldbookDraft, setWorldbookDraft] = useState<ConfigDraftState | null>(null);
  const [voiceSummary, setVoiceSummary] = useState<MediaSummaryStatus>();
  const [imageSummary, setImageSummary] = useState<MediaSummaryStatus>();

  const clearPreview = useRef(onClearPreview);
  clearPreview.current = onClearPreview;
  useEffect(() => {
    if (active && sheetApi.closedId?.startsWith('outfit:')) clearPreview.current();
  }, [sheetApi.discardToken]);
  const [detailError, setDetailError] = useState('');
  const [detailRead, setDetailRead] = useState(0);
  const [budgetRead, setBudgetRead] = useState(0);
  const [savedProfile, setSavedProfile] = useState<Draft | undefined>(draft);
  const [saveBusy, setSaveBusy] = useState(false);
  const guardAction = async <T,>(action: () => Promise<T>, verb = '保存配置', announceSuccess = true): Promise<T> => {
    let response: T | undefined;
    const result = await write.runWrite({ roleIds: [roleId], verb, announceSuccess, commit: async () => { response = await action(); } });
    if (!result.ok) throw new Error(result.failure.message);
    return response as T;
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
  const chatProbe = useModelProbe(chatKey, { shared: true, scope: 'role' });
  const memoryProbe = useModelProbe(memoryKey, { shared: true, scope: 'role' });
  const chatModelTabActive = active && section === 'models' && Boolean(sheetApi.sheet?.id.startsWith('model:chat'));
  const memoryModelTabActive = active && section === 'models' && sheetApi.sheet?.id === 'model:memory';
  useEffect(() => {
    if (!chatModelTabActive) chatProbe.cancelPending();
  }, [chatModelTabActive, chatProbe.cancelPending]);
  useEffect(() => {
    if (!memoryModelTabActive) memoryProbe.cancelPending();
  }, [memoryModelTabActive, memoryProbe.cancelPending]);
  useEffect(() => { if (chatModelTabActive && chatProbe.notice?.source === 'test') announceLive(chatProbe.notice.text); }, [chatModelTabActive, chatProbe.notice]);
  useEffect(() => { if (memoryModelTabActive && memoryProbe.notice?.source === 'test') announceLive(memoryProbe.notice.text); }, [memoryModelTabActive, memoryProbe.notice]);
  const [extensionDraft, setExtensionDraft] = useState<Record<string, boolean>>({});
  const [bindingError, setBindingError] = useState('');
  const [budget, setBudget] = useState<{ usedPoints: number; dailyLimit: number; unlimited: boolean; localDate: string }>();
  const [budgetError, setBudgetError] = useState('');
  const [budgetDraft, setBudgetDraft] = useState({ dailyLimit: 0, unlimited: false });
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [budgetNotice, setBudgetNotice] = useState('');
  const [lookVersion, setLookVersion] = useState(0);
  const [loaded, setLoaded] = useState({ look: false, voice: false, image: false });
  // 纸笺关闭（含「放弃修改」）后清掉上一次保存失败的原因，避免草稿已回滚却仍显示旧报错。
  useEffect(() => {
    if (!active || !sheetApi.discardToken) return;
    if (sheetApi.closedId?.startsWith('model:') || sheetApi.closedId?.startsWith('ext:')) {
      if (bindingRevision) setBindingError('');
      setBindingNotice('');
    }
    if (sheetApi.closedId === 'quota') { setBudgetError(''); setBudgetNotice(''); }
  }, [active, sheetApi.discardToken, sheetApi.closedId]);
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
  useEffect(() => {
    if (draft) return;
    const controller = new AbortController();
    setDetailError('');
    void api<RoleDetail>(`/v1/roles/${encodeURIComponent(roleId)}`, { signal: controller.signal }).then(role => {
      if (!controller.signal.aborted) setDraft({ name: role.displayName, definition: role.definition.text, revision: role.definitionRevision, payload: role.definition.payload, isBuiltin: role.isBuiltin === true, bio: role.bio ?? '' });
    }).catch(e => { if (!controller.signal.aborted) setDetailError(errorText(e)); });
    return () => controller.abort();
  }, [roleId, detailRead]);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      mergeRefreshedBindings([], result, []);
      setBindingLoaded(true);
    }).catch(e => { if (!controller.signal.aborted) setBindingError(errorText(e)); });
    return () => controller.abort();
  }, [roleId]);
  useEffect(() => {
    const controller = new AbortController();
    setBudgetError('');
    void api<NonNullable<typeof budget>>(`/v1/roles/${encodeURIComponent(roleId)}/autonomy/budget`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setBudget(result); setBudgetDraft({ dailyLimit: result.dailyLimit, unlimited: result.unlimited });
    }).catch(e => { if (!controller.signal.aborted) setBudgetError(errorText(e)); });
    return () => controller.abort();
  }, [roleId, budgetRead]);
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
  useEffect(() => { if (!active) return; if (section === 'look') setLoaded(v => ({ ...v, look: true })); if (section === 'models' || section === 'done') setLoaded(v => ({ ...v, voice: true, image: true })); }, [active, section]);
  const saveProfile = async () => {
    if (!draft || saveBusy || !draft.name.trim() || !draft.definition.trim()) return;
    setSaveBusy(true); setDetailError('');
    try {
      const result = await write.runWrite({
        roleIds: [roleId],
        verb: '保存设定',
        commit: async () => {
          const saved = await api<{ definitionRevision: number; updatedAt: string }>(`/v1/roles/${encodeURIComponent(roleId)}/definition`, { method: 'PATCH', body: { displayName: draft.name.trim(), ...(draft.isBuiltin ? { bio: draft.bio } : {}), definition: { text: draft.definition.trim(), payload: draft.payload }, expectedRevision: draft.revision } });
          const next = { ...draft, name: draft.name.trim(), definition: draft.definition.trim(), payload: draft.payload, revision: saved.definitionRevision };
          await onRefresh().catch(() => { /* 保存已完成，列表同步提示由工作区显示。 */ });
          setSavedProfile(next); setDraft(next);
        },
      });
      if (!result.ok) setDetailError(result.failure.message);
    } finally { setSaveBusy(false); }
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
      const result = await guardAction(async () => {
        try {
          return await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, { method: 'PUT', body: { bindings: [...previous, ...next.map(asInput)], expectedRevision: bindingRevision } });
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'BINDING_REVISION_CONFLICT') throw error;
          const latest = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`);
          const { items: mergedItems, conflicts } = mergeBindingDrafts({ base: bindings, draft: next, latest: latest.items, scope });
          if (conflicts.length > 0) {
            setBindingRevision('');
            const labels = conflicts.map(key => scope === 'models'
              ? ({ chat_model: '对话模型', memory_model: '记忆模型' } as Record<string, string>)[key] ?? key
              : resources.find(item => item.resourceId === key.slice(key.indexOf(':') + 1))?.name ?? key);
            throw new Error(`${labels.join('、')}已被修改，请重新读取绑定并核对草稿后再保存。`);
          }
          try {
            const retried = await api<{ items: Binding[]; revision: string }>(`/v1/roles/${encodeURIComponent(roleId)}/bindings`, { method: 'PUT', body: { bindings: mergedItems.map(item => asInput(item as Binding)), expectedRevision: latest.revision } });
            mergeRefreshedBindings(bindings, retried, removedResources);
            return retried;
          } catch (retryError) {
            if (!(retryError instanceof ApiError) || retryError.code !== 'BINDING_REVISION_CONFLICT') throw retryError;
            setBindingRevision('');
            throw new Error('另一个操作仍在修改绑定，请重新读取并核对草稿后再保存。');
          }
        }
      }, scope === 'models' ? '保存模型选择' : '保存扩展选择', false);
      setBindings(result.items); setBindingRevision(result.revision);
      sheetApi.closeNow(undefined, scope === 'models' ? '已保存模型选择' : '已保存扩展选择');
    } catch (e) {
      setBindingError(errorText(e));
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
      write.reportResult('已读取最新绑定，原有草稿可核对后保存。');
    } catch (error) { setBindingError(`重新读取绑定失败：${errorText(error)}`); }
    finally { bindingLock.current = false; setBindingBusy(false); }
  };
  const saveBudget = async () => {
    if (budgetBusy || !budget || quotaLimitBad(budgetDraft)) return;
    setBudgetBusy(true); setBudgetError(''); setBudgetNotice('');
    try {
      const body = { ...budgetDraft, dailyLimit: quotaLimitBad({ ...budgetDraft, unlimited: false }) ? budget.dailyLimit : budgetDraft.dailyLimit };
      const result = await guardAction(() => api<NonNullable<typeof budget>>(`/v1/roles/${encodeURIComponent(roleId)}/autonomy/budget`, { method: 'PUT', body }), '保存自主额度', false);
      setBudget(result); setBudgetDraft({ dailyLimit: result.dailyLimit, unlimited: result.unlimited });
      sheetApi.closeNow(undefined, '已保存自主额度');
    }
    catch (e) { setBudgetError(errorText(e)); } finally { setBudgetBusy(false); }
  };
  const savedChat = bindings.find(item => item.capability === 'chat_model');
  const savedMemory = bindings.find(item => item.capability === 'memory_model');
  // 设定字段的改动细线（M19）：逐字段比较，不共用整体 dirty 标记。
  const nameDirty = !!draft && !!savedProfile && draft.name !== savedProfile.name;
  const definitionDirty = !!draft && !!savedProfile && draft.definition !== savedProfile.definition;
  const bioDirty = !!draft && !!savedProfile && draft.bio !== savedProfile.bio;
  const profileCount = Number(nameDirty) + Number(definitionDirty) + Number(bioDirty);
  const dirtyProfile = profileCount > 0;
  // 人设自动增高（§5）：最小 136，上限 max(140, 窗口高×0.4 与正文可视高−120 的较小者)。
  const definitionRef = useRef<HTMLTextAreaElement>(null);
  const growDefinition = useCallback(() => {
    const node = definitionRef.current;
    if (!node) return;
    const pane = node.closest<HTMLElement>('.config-prose');
    const cap = Math.max(140, Math.round(Math.min(window.innerHeight * 0.4, (pane?.clientHeight ?? 0) - 120)));
    node.style.height = 'auto';
    const need = node.scrollHeight + 2;
    node.style.height = `${Math.min(Math.max(need, 136), cap)}px`;
    node.style.overflowY = need > cap ? 'auto' : 'hidden';
    node.toggleAttribute('data-capped', need > cap);
  }, []);
  useEffect(() => {
    if (!active || section !== 'profile') return;
    growDefinition();
    window.addEventListener('resize', growDefinition);
    void (document.fonts?.ready ?? Promise.resolve()).then(() => growDefinition());
    return () => window.removeEventListener('resize', growDefinition);
  }, [active, section, draft?.definition, growDefinition]);
  const dirtyModels = bindingLoaded && (modelDraft.chatResource !== (savedChat?.resourceId || '') || (!!modelDraft.chatResource && modelDraft.chatModel !== (savedChat?.modelName || '')) || modelDraft.memoryResource !== (savedMemory?.resourceId || '') || (!!modelDraft.memoryResource && modelDraft.memoryModel !== (savedMemory?.modelName || '')));
  const dirtyExt = bindingLoaded && resources.some(item => (item.kind === 'mcp' || item.kind === 'skill') && !!extensionDraft[item.resourceId] !== !!bindings.find(binding => binding.capability === item.kind && binding.resourceId === item.resourceId)?.enabled);
  const dirtyQuota = !!budget && (budgetDraft.dailyLimit !== budget.dailyLimit || budgetDraft.unlimited !== budget.unlimited);
  useEffect(() => {
    const discardProfile = () => {
      if (savedProfile) setDraft(savedProfile);
      setDetailError('');
    };
    const discard = () => {
      discardProfile();
      setModelDraft({ chatResource: savedChat?.resourceId || '', chatModel: savedChat?.modelName || '', memoryResource: savedMemory?.resourceId || '', memoryModel: savedMemory?.modelName || '' });
      setExtensionDraft(Object.fromEntries(bindings.filter(item => item.capability === 'mcp' || item.capability === 'skill').map(item => [item.resourceId, item.enabled])));
      if (budget) setBudgetDraft({ dailyLimit: budget.dailyLimit, unlimited: budget.unlimited });
      voiceDraft?.discard(); imageDraft?.discard(); worldbookDraft?.discard();
      if (bindingRevision) setBindingError(''); setBudgetError('');
    };
    onEditorState(roleId, { dirty: { profile: dirtyProfile, models: dirtyModels, voice: !!voiceDraft?.dirty, image: !!imageDraft?.dirty, ext: dirtyExt || !!worldbookDraft?.dirty, quota: dirtyQuota }, busy: saveBusy || bindingBusy || budgetBusy || !!voiceDraft?.busy || !!imageDraft?.busy || !!worldbookDraft?.busy, profileCount, discardProfile, discard });
  }, [roleId, onEditorState, dirtyProfile, dirtyModels, dirtyExt, dirtyQuota, saveBusy, bindingBusy, bindingRevision, budgetBusy, savedProfile, bindings, budget, voiceDraft, imageDraft, worldbookDraft]);
  useEffect(() => () => onEditorState(roleId, null), [roleId, onEditorState]);
  const footer = document.getElementById('config-leaf-actions');
  const needsBindingRead = !bindingRevision && (bindingLoaded || !!bindingError);
  const bindingProblem = bindingError || (needsBindingRead ? '请重新读取绑定后再保存。' : '');
  const firstReadError = (bindingLoaded ? '' : bindingError) || resourceError;
  const bindingAlert = !sheetApi.sheet && (firstReadError
    ? <MediaStateRow label="服务绑定" loading={false} error={firstReadError} onRetry={() => void (resourceError ? onRefresh() : reloadBindings())}/>
    : bindingProblem && <p role="alert">{bindingProblem}{needsBindingRead && <button type="button" disabled={bindingBusy} onClick={() => void reloadBindings()}>重试读取绑定</button>}</p>);
  const profileActions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const actions = profileActions.current;
    if (!dirtyProfile || !actions) return;
    const duration = readMotionTime(actions, '--nd-semantic-motion-component', 220);
    if (duration <= 0) return;
    const animation = actions.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
      duration, easing: readMotionValue(actions, '--nd-semantic-motion-ease-out', 'ease-out'),
    });
    return () => animation.cancel();
  }, [dirtyProfile]);
  const profilePausing = saveBusy && activity?.state !== 'stopped' && write.phase === 'pause';
  const storedChat = savedChat ? resources.find(item => item.resourceId === savedChat.resourceId) ?? null : null;
  const storedMemory = savedMemory ? resources.find(item => item.resourceId === savedMemory.resourceId) ?? null : null;
  const chatStatus = chatRowStatus(savedChat ? { service: storedChat } : null);
  const memoryStatus = memoryRowStatus(savedMemory ? { service: storedMemory } : null, !savedMemory);
  const activityState = write.resuming && write.pausedRoleIds.includes(roleId) ? 'resuming' : write.pendingPauseIds.includes(roleId) ? 'stopping' : activity?.state;
  const completion: { label: string; status: Parameters<typeof StatusDot>[0]['status']; note: string; target: RoleSection | 'roles' }[] = [
    { label: '设定', status: dirtyProfile ? 'dirty' : draft ? 'ok' : 'none', note: dirtyProfile ? '有改动未保存' : draft ? '已保存' : '尚未读取', target: 'profile' },
    { label: '对话模型', status: chatStatus.status, note: chatStatus.status === 'ok' && storedChat ? `已绑定 · ${storedChat.name}` : !savedChat ? '未绑定' : chatStatus.label, target: 'models' },
    { label: '记忆整理', status: memoryStatus.status, note: memoryStatus.status === 'ok' && storedMemory ? `已绑定 · ${storedMemory.name}` : memoryStatus.label, target: 'models' },
    { label: '生图', status: imageSummary?.status ?? 'none', note: imageSummary?.status === 'ok' ? '已配置' : imageSummary?.label ?? '正在读取…', target: 'models' },
    { label: '语音', status: voiceSummary?.status ?? 'none', note: voiceSummary?.label ?? '正在读取…', target: 'models' },
    { label: '角色状态', status: !activityState ? 'none' : activityState === 'active' ? 'ok' : 'off', note: activityState ? T19[activityState] : '正在读取状态', target: 'roles' },
  ];
  return <><div hidden={!active} className="config-role-editor">
    <div hidden={!active || section !== 'profile'} className="config-prose">
      <header className="config-sec-head"><h2 tabIndex={-1}>设定</h2></header>
      {!draft && <MediaStateRow label="设定" loading={!detailError} error={detailError} onRetry={() => setDetailRead(previous => previous + 1)}/>}
      {draft && <><div className="config-ledger"><div className="config-ledger-label"><b>显示名</b></div><div><div className="config-ctl" data-dirty={nameDirty || undefined}><Input aria-label="显示名" aria-describedby={draft.isBuiltin ? `config-builtin-name-${roleId}` : undefined} disabled={saveBusy} value={draft.name} maxLength={200} onChange={event => setDraft({ ...draft, name: event.target.value })}/></div>{draft.isBuiltin && <small className="config-inline-hint" id={`config-builtin-name-${roleId}`}>常驻主角色 · 默认保留</small>}</div></div>
      {draft.isBuiltin && <div className="config-ledger"><div className="config-ledger-label"><b>人物介绍</b></div><div className="config-ctl" data-dirty={bioDirty || undefined}><Textarea aria-label="人物介绍" disabled={saveBusy} rows={3} value={draft.bio} onChange={event => setDraft({ ...draft, bio: event.target.value })}/></div></div>}
      <div className="config-ledger"><div className="config-ledger-label"><b>人设</b></div><div><div className="config-ctl" data-dirty={definitionDirty || undefined}><Textarea ref={definitionRef} aria-label="角色设定" aria-describedby="config-definition-count" className="config-ruled" disabled={saveBusy} rows={4} value={draft.definition} onChange={event => setDraft({ ...draft, definition: event.target.value })}/></div><div className="config-field-foot"><span/><span className="config-count" id="config-definition-count"><b>{draft.definition.length}</b> 字</span></div></div></div>
      <RoleDeleteEntry roleCount={roleCount} isBuiltin={draft.isBuiltin}/>
      <RoleSheetHost active={active} roleId={roleId} roleName={draft.name} roleCount={roleCount} needsPause={activity?.state !== 'stopped'} onDeleted={onDeleted}/></>}
    </div>
    <div hidden={!active || section !== 'look'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>衣柜</h2></header>{loaded.look && <AppearancePanel active={active} roleId={roleId} canWrite={!!activity || activityLoading} pausedWrite={activity?.state !== 'stopped'} onPreview={onPreviewOutfit} onPreviewAsset={onPreviewAsset} onOpenImageSettings={() => onOpenSettings('model', { modelKind: 'image' })} onChanged={() => { onClearPreview(); setLookVersion(v => v + 1); void onRefresh(); }}/>}</div>
    <div hidden={!active || section !== 'models'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>模型</h2></header>
      {bindingAlert}
      {!firstReadError && (bindingLoaded || !bindingProblem) && <><ModelRow kind="chat" bindings={bindings} resources={resources} draft={modelDraft} loaded={bindingLoaded} onOpen={openChat}/>
      <ModelRow kind="memory" bindings={bindings} resources={resources} draft={modelDraft} loaded={bindingLoaded} onOpen={(_group, anchor) => openMemory(anchor)}/></>}
      <ModelSheetHost active={active && section === 'models'} draft={modelDraft} setDraft={setModelDraft} resources={resources} bindings={bindings} loaded={bindingLoaded} notice={bindingNotice} error={bindingError} chatProbe={chatProbe} memoryProbe={memoryProbe} chatKey={chatKey} memoryKey={memoryKey} onOpenSettings={onOpenSettings} pause={activity?.state !== "stopped"} busy={bindingBusy} onReload={needsBindingRead ? reloadBindings : undefined} onSave={saveBindings}/>
      {loaded.image && <ImagePanel roleId={roleId} active={active && section === 'models'} serviceRefreshVersion={imageServiceVersion} serviceEpochs={imageServiceEpochs} outfitRefreshVersion={lookVersion} onOpenImageSettings={target => sheetApi.requestClose(() => onOpenSettings('model', { modelKind: 'image', ...(target?.serviceId ? { resourceId: target.serviceId } : {}), ...(target?.createNew ? { newImageService: true } : {}) }))} guardWrite={guardAction} pausedWrite={activity?.state !== 'stopped'} onSummaryStatus={setImageSummary} onDraftStateChange={setImageDraft} onChanged={() => { void onRefresh(); }}/>}
      {loaded.voice && <VoicePanel roleId={roleId} active={active && section === 'models'} serviceRefreshVersion={voiceServiceVersion} serviceEpochs={voiceServiceEpochs} onOpenVoiceSettings={target => sheetApi.requestClose(() => onOpenSettings('model', { modelKind: 'voice', ...(target?.serviceId ? { resourceId: target.serviceId } : {}), ...(target?.createNew ? { newVoiceService: true } : {}) }))} guardWrite={guardAction} pausedWrite={activity?.state !== 'stopped'} onSummaryStatus={setVoiceSummary} onDraftStateChange={setVoiceDraft} onChanged={() => { void onRefresh(); }}/>}
    </div>
    <div hidden={!active || section !== 'ext'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>扩展</h2></header>
      <WorldbooksPanel roleId={roleId} active={active && section === 'ext'} pausedWrite={activity?.state !== 'stopped'} guardWrite={guardAction} onDraftChange={setWorldbookDraft}/>
      {bindingAlert}
      {!firstReadError && (['mcp','skill'] as const).map(kind => <ExtensionRow key={kind} kind={kind} resources={resources.filter(item => item.kind === kind)} draft={extensionDraft} bindings={bindings} loaded={bindingLoaded} busy={bindingBusy || !bindingRevision || !!resourceError} onOpen={trigger => openExtension(kind, trigger)}/>)}
      {bindingNotice && <p role="status">{bindingNotice}</p>}
      <ExtSheetHosts active={active && section === 'ext'} resources={resources} draft={extensionDraft} setDraft={setExtensionDraft} bindings={bindings} loaded={bindingLoaded} notice={bindingNotice} error={bindingError} pause={activity?.state !== "stopped"} busy={bindingBusy} onReload={needsBindingRead ? reloadBindings : undefined} onSave={saveBindings} onManage={onOpenSettings}/>
    </div>
    <div hidden={!active || section !== 'quota'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>自主额度</h2></header>
      {budget ? <><div className="config-sum" data-edit="quota" onClick={event => openQuota(event.currentTarget.querySelector<HTMLElement>('.config-sum-edit') ?? event.currentTarget)}>
        <span className="config-sum-name"><strong>今日</strong></span>
        <span className="config-sum-val"><b>今日已用 {budget.usedPoints} / {budget.unlimited ? '不限' : budget.dailyLimit} 点</b><span className="config-sum-keys"><span>{budget.unlimited ? '不限额' : `每日 ${budget.dailyLimit} 点`}</span><span>{budget.localDate}</span><span>本机 00:00 重置</span></span></span>
        <span className="config-sum-end"><StatusDot status="ok" label="生效中" bare faint/><span className="config-sum-slot"><button type="button" className="config-sum-edit" onClick={event => { event.stopPropagation(); openQuota(event.currentTarget); }} aria-label="编辑今日额度"><Icon name="edit" size={13}/>编辑</button><span className="config-sum-slot-ghost" aria-hidden="true"><Icon name="edit" size={13}/>编辑</span></span></span>
      </div>
      <QuotaSheetHost active={active && section === 'quota'} budget={budget} draft={budgetDraft} setDraft={setBudgetDraft} notice={budgetNotice} error={budgetError} pause={activity?.state !== "stopped"} busy={budgetBusy} onSave={saveBudget}/></> : <MediaStateRow label="自主额度" loading={!budgetError} error={budgetError} onRetry={() => setBudgetRead(previous => previous + 1)}/>}
    </div>
    <div hidden={!active || section !== 'done'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>完成度</h2></header>
      <div className="config-check-list">{completion.map(({ label, status, note, target }) => <div className="config-check-row" key={label}>
        <b>{label}</b><i aria-hidden="true"/><StatusDot status={status} label={note}/><button type="button" className="config-check-view" onClick={() => target === 'roles' ? onOpenSettings('roles') : onChangeSection(target)}>查看</button>
      </div>)}</div>
    </div>
  </div>{active && section === 'profile' && draft && dirtyProfile && footer && createPortal(<>
    {(detailError || saveBusy) && <span className={`config-profile-write-status${detailError ? ' config-sheet-error' : ''}`} role={detailError ? 'alert' : undefined}>{detailError || (profilePausing ? write.pauseNotice || T29.pausing : T29.saving)}</span>}
    <div className="config-profile-actions" ref={profileActions}>
      <Button variant="ghost" disabled={saveBusy || write.busy} onClick={() => { if (savedProfile) setDraft(savedProfile); }}>{T6.discard}</Button>
      <Button busy={saveBusy} disabled={!saveBusy && (write.busy || write.resuming || !draft.name.trim() || !draft.definition.trim())} onClick={() => void saveProfile()}>
        {saveBusy ? profilePausing ? T29.pausing : T29.saving : detailError ? T29.retry('保存') : activity?.state === 'stopped' ? T6.save(profileCount) : T6.pauseAndSave(profileCount)}
      </Button>
    </div>
  </>, footer)}</>;
}

/** 扩展摘要行（规范 §二.2）：值写已开启数，第二行写开启 / 停用名单；状态点 bare。 */
function ExtensionRow({ kind, resources, draft, bindings, loaded, busy, onOpen }: { kind: 'mcp' | 'skill'; resources: Resource[]; draft: Record<string, boolean>; bindings: Binding[]; loaded: boolean; busy: boolean; onOpen: (trigger: HTMLElement) => void }) {
  const label = kind === 'mcp' ? 'MCP' : 'Skill';
  if (!loaded) return <MediaStateRow label={label} loading error="" onRetry={() => {}}/>;
  const selected = (id: string) => bindings.some(item => item.capability === kind && item.resourceId === id && item.enabled);
  const on = resources.filter(item => selected(item.resourceId) && item.enabled);
  const off = resources.filter(item => selected(item.resourceId) && !item.enabled);
  const dirty = resources.some(item => !!draft[item.resourceId] !== selected(item.resourceId));
  const value = !loaded ? '正在读取…' : resources.length === 0 ? T36.settingsKind(label) : `已为角色开启 ${on.length} / ${resources.filter(item => item.enabled).length}`;
  const status = !loaded ? 'none' : dirty ? 'dirty' : resources.length === 0 ? 'none' : off.length > 0 ? 'off' : on.length > 0 ? 'ok' : 'off';
  const stateText = !loaded ? '同步中' : dirty ? '有改动未保存' : resources.length === 0 ? '无可选项' : off.length > 0 ? '有服务已停用' : on.length > 0 ? '生效中' : '全部关闭';
  return <div className="config-sum" data-edit={`ext:${kind}`} onClick={event => { if (!busy) onOpen(event.currentTarget.querySelector<HTMLElement>('.config-sum-edit') ?? event.currentTarget); }}>
    <span className="config-sum-name"><strong>{label}</strong></span>
    <span className="config-sum-val"><b>{value}</b><span className="config-sum-keys"><span>开启 {on.map(item => item.name).join('、') || T23.none}</span>{off.length > 0 && <span>停用 {off.map(item => item.name).join('、')}（已全局停用）</span>}</span></span>
    <span className="config-sum-end"><StatusDot status={status} label={stateText} bare={!rowDotVisible(status)} faint={!rowDotVisible(status)}/><span className="config-sum-slot"><button type="button" className="config-sum-edit" disabled={busy} onClick={event => { event.stopPropagation(); onOpen(event.currentTarget); }} aria-label={`编辑${label}`}><Icon name="edit" size={13}/>编辑</button><span className="config-sum-slot-ghost" aria-hidden="true"><Icon name="edit" size={13}/>编辑</span></span></span>
  </div>;
}

/** 扩展纸笺：一行一个开关；全局停用的项禁用并说明原因（T33）。 */
function ExtSheetHosts({ active, resources, draft, setDraft, bindings, loaded, notice, error, pause, busy, onReload, onSave, onManage }: {
  active: boolean; resources: Resource[]; draft: Record<string, boolean>; setDraft: (next: Record<string, boolean>) => void;
  bindings: Binding[]; loaded: boolean; notice: string; error: string; pause: boolean; busy: boolean;
  onReload?: () => Promise<void>; onSave: (scope: 'models' | 'ext') => Promise<void>; onManage: (kind: 'mcp' | 'skill') => void;
}) {
  const { sheet, requestClose, setDirty, setBusy, discardToken, closedId } = useSheet();
  const kind = active && sheet?.id.startsWith('ext:') ? sheet.id.slice(4) as 'mcp' | 'skill' : null;
  const list = kind ? resources.filter(item => item.kind === kind) : [];
  const count = list.filter(item => !!draft[item.resourceId] !== !!bindings.find(binding => binding.capability === kind && binding.resourceId === item.resourceId)?.enabled).length;
  useEffect(() => { if (kind) { setDirty(count > 0, count); setBusy(busy); } }, [kind, count, busy, setDirty, setBusy]);
  const savedBindings = useRef(bindings);
  savedBindings.current = bindings;
  useEffect(() => {
    if (!active || !discardToken || !closedId?.startsWith('ext:')) return;
    const targetKind = closedId.slice(4);
    const next = { ...draft };
    resources.filter(item => item.kind === targetKind).forEach(item => { next[item.resourceId] = false; });
    savedBindings.current.filter(item => item.capability === targetKind).forEach(item => { next[item.resourceId] = item.enabled; });
    setDraft(next);
  }, [discardToken]);
  return <Sheet idPrefix="ext:" enabled={active} footer={<RoleSaveActions count={count} pause={pause} busy={busy} invalid={!loaded || !!onReload} error={error} onSave={() => void onSave('ext')}/>}>
    {kind && <div className="config-sheet-groups">
      <div className="config-grp" data-sheet-group>
        <div className="config-grp-label"><b>{kind === 'mcp' ? 'MCP' : 'Skill'}</b></div>
        <div>
          {list.length === 0 ? <p className="config-sheet-note">{T36.settingsKind(kind === 'mcp' ? 'MCP' : 'Skill')}</p> : <div className="config-toggle-list">
            {list.map(item => <div className="config-toggle-row" data-unavailable={!item.enabled || undefined} key={item.resourceId}
              data-located={sheet?.resourceId === item.resourceId || undefined}
              data-sheet-focus={sheet?.resourceId === item.resourceId || undefined}
              tabIndex={sheet?.resourceId === item.resourceId ? 0 : undefined}
              onFocus={event => { if (sheet?.resourceId === item.resourceId) event.currentTarget.scrollIntoView({ block: 'nearest' }); }}>
              <span><strong>{item.name}</strong>{typeof item.config.description === 'string' && item.config.description && <small>{item.config.description}</small>}{!item.enabled && <small id={`extension-disabled-${item.resourceId}`}>{T33.switchNote}</small>}</span>
              <Switch checked={!!draft[item.resourceId]} disabled={!item.enabled || !loaded} aria-describedby={!item.enabled ? `extension-disabled-${item.resourceId}` : undefined} label={`为角色开启${item.name}`} onCheckedChange={checked => setDraft({ ...draft, [item.resourceId]: checked })}/>
            </div>)}
          </div>}
          {onReload && <Button size="sm" disabled={busy} onClick={() => void onReload()}>重试读取绑定</Button>}
          <p className="config-sheet-note"><button type="button" className="config-sheet-link" onClick={() => requestClose(() => onManage(kind))}>{list.length ? T25.manage : T25.add}</button></p>
          {notice && <p className="config-sheet-note" role="status">{notice}</p>}
        </div>
      </div>
    </div>}
  </Sheet>;
}

/** 自主额度纸笺：紧凑形态只含「每日额度」组，含 T28 校验与「不限制」。 */
function QuotaSheetHost({ active, budget, draft, setDraft, notice, error, pause, busy, onSave }: { active: boolean; budget: { usedPoints: number; dailyLimit: number; unlimited: boolean; localDate: string }; draft: { dailyLimit: number; unlimited: boolean }; setDraft: (next: { dailyLimit: number; unlimited: boolean }) => void; notice: string; error: string; pause: boolean; busy: boolean; onSave: () => Promise<void> }) {
  const { sheet, setDirty, setBusy, discardToken, closedId } = useSheet();
  const open = active && sheet?.id === 'quota';
  const invalid = quotaLimitBad(draft);
  const count = Number(!draft.unlimited && draft.dailyLimit !== budget.dailyLimit) + Number(draft.unlimited !== budget.unlimited);
  useEffect(() => { if (open) { setDirty(count > 0, count); setBusy(busy); } }, [open, count, busy, setDirty, setBusy]);
  useEffect(() => {
    if (!active || !discardToken || closedId !== 'quota') return;
    setDraft({ dailyLimit: budget.dailyLimit, unlimited: budget.unlimited });
  }, [discardToken]);
  return <Sheet idPrefix="quota" enabled={active} footer={<RoleSaveActions count={count} pause={pause} busy={busy} invalid={invalid} error={error} onSave={() => void onSave()}/>}>
    {open && <div className="config-sheet-groups">
      <div className="config-grp" data-sheet-group>
        <div className="config-grp-label"><b>每日额度</b><small>{budget.localDate} · 本机 00:00 重置</small></div>
        <div>
          <div className="config-quota-input">
            <Input type="number" min={1} max={1000000} step={1} disabled={busy || draft.unlimited} value={draft.dailyLimit === 0 ? '' : String(draft.dailyLimit)} aria-label="每日额度" aria-invalid={invalid || undefined} aria-describedby={invalid ? 'quota-error' : undefined} data-sheet-focus onChange={event => setDraft({ ...draft, dailyLimit: Number(event.target.value) })}/>
            <label className="config-sheet-check"><input type="checkbox" disabled={busy} checked={draft.unlimited} onChange={event => setDraft({ ...draft, unlimited: event.target.checked })}/> 不限制</label>
          </div>
          {invalid && <p className="config-sheet-error" id="quota-error">{T28}</p>}
          {notice && <p className="config-sheet-note" role="status">{notice}</p>}
        </div>
      </div>
    </div>}
  </Sheet>;
}

type ModelDraftState = { chatResource: string; chatModel: string; memoryResource: string; memoryModel: string };
type ModelProbeState = ReturnType<typeof useModelProbe>;

/** 模型摘要行（规范 §二.2）：值 =「服务 · 模型」，第二行写协议或继承关系；状态点 bare。 */
function ModelRow({ kind, bindings, resources, draft, loaded, onOpen }: { kind: 'chat' | 'memory'; bindings: Binding[]; resources: Resource[]; draft: ModelDraftState; loaded: boolean; onOpen: (group?: '服务' | '连接测试', anchor?: HTMLElement) => void }) {
  const label = kind === 'chat' ? '对话' : '记忆整理';
  const capability = kind === 'chat' ? 'chat_model' : 'memory_model';
  const resourceId = kind === 'chat' ? draft.chatResource : draft.memoryResource;
  const modelName = kind === 'chat' ? draft.chatModel : draft.memoryModel;
  const resource = resources.find(item => item.resourceId === resourceId);
  const chatBinding = bindings.find(item => item.capability === 'chat_model');
  const protocolLabel = resource ? modelAdapterLabel(modelAdapterOf(resource.config)) : '';
  const follows = kind === 'memory' && resourceId === '';
  const deleted = resourceId !== '' && resource === undefined;
  const value = !loaded ? '正在读取…'
    : deleted ? T34.value
      : follows ? '跟随对话模型'
        : resourceId === '' ? T2.value
          : `${resource?.name ?? ''} · ${modelName || T23.unset}`;
  // 摘要第二行（demo 对齐）：对话显示「协议 · 值」，记忆跟随显示「运行时 · 继承 …」，
  // 记忆自带服务时 demo 为空，不重复显示协议（§17.6 观察项 2）。
  const key = !loaded ? '' : deleted ? ''
    : follows ? chatBinding?.modelName ? `继承 ${chatBinding.modelName}` : '对话模型未设置'
      : resourceId === '' ? T2.hint
        : kind === 'memory' ? '' : protocolLabel;
  const status: 'ok' | 'follow' | 'off' | 'error' | 'none' = !loaded ? 'none'
    : deleted ? 'error'
      : follows ? 'follow'
        : resourceId === '' || !modelName ? 'off'
          : resource?.enabled === false ? 'off' : 'ok';
  const stateText = !loaded ? '同步中' : deleted ? '原服务已删除' : follows ? '跟随对话模型' : resourceId === '' ? '未设置' : resource?.enabled === false ? '服务已停用' : !modelName ? '未设置' : '生效中';
  if (!loaded) return <MediaStateRow label={label} loading error="" onRetry={() => {}}/>;
  return <div className="config-sum" data-edit={`model:${kind}`} onClick={event => onOpen(undefined, event.currentTarget.querySelector<HTMLElement>('.config-sum-edit') ?? event.currentTarget)}>
    <span className="config-sum-name"><strong>{label}</strong></span>
    <span className="config-sum-val">
      <b>{kind === 'chat' ? <button type="button" className="config-chip-v" onClick={event => { event.stopPropagation(); onOpen('服务', event.currentTarget); }}>{value}</button> : value}</b>
      {key && <span className="config-sum-keys">{kind === 'chat' && resourceId ? <button type="button" className="config-chip-k" onClick={event => { event.stopPropagation(); onOpen('服务', event.currentTarget); }}>{key}</button> : <span>{key}</span>}</span>}
    </span>
    <span className="config-sum-end"><StatusDot status={status} label={stateText} bare={!rowDotVisible(status)} faint={!rowDotVisible(status)}/><span className="config-sum-slot"><button type="button" className="config-sum-edit" onClick={event => { event.stopPropagation(); onOpen(undefined, event.currentTarget); }} aria-label={`编辑${label}`}><Icon name="edit" size={13}/>编辑</button><span className="config-sum-slot-ghost" aria-hidden="true"><Icon name="edit" size={13}/>编辑</span></span></span>
  </div>;
}

/**
 * 对话 / 记忆纸笺（规范 §二.2／§二.4）：对话分「服务」「连接测试」两组，
 * 值或协议打开紧凑「服务」，编辑打开完整；记忆整行打开紧凑整份。
 */
function ModelSheetHost({ active, draft, setDraft, resources, bindings, loaded, notice, error, chatProbe, memoryProbe, chatKey, memoryKey, onOpenSettings, pause, busy, onReload, onSave }: {
  active: boolean;
  draft: ModelDraftState;
  setDraft: (updater: (previous: ModelDraftState) => ModelDraftState) => void;
  resources: Resource[];
  bindings: Binding[];
  loaded: boolean;
  notice: string;
  error: string;
  chatProbe: ModelProbeState;
  memoryProbe: ModelProbeState;
  chatKey: string;
  memoryKey: string;
  onOpenSettings: (section: SettingsSection, options?: OpenSettingsOptions) => void;
  pause: boolean;
  busy: boolean;
  onReload?: () => Promise<void>;
  onSave: (scope: 'models' | 'ext') => Promise<void>;
}) {
  const { sheet, requestClose, setDirty, setBusy, discardToken, closedId } = useSheet();
  const kind = active && sheet !== null && sheet.id.startsWith('model:') ? (sheet.id.startsWith('model:chat') ? 'chat' : 'memory') : null;
  const group = kind === 'chat' ? (sheet?.id === 'model:chat:test' ? 'test' : sheet?.id === 'model:chat:service' ? 'service' : null) : null;
  const saved = bindings.find(item => item.capability === (kind === 'chat' ? 'chat_model' : 'memory_model'));
  const dirty = kind === 'chat'
    ? draft.chatResource !== (saved?.resourceId || '') || (!!draft.chatResource && draft.chatModel !== (saved?.modelName || ''))
    : kind === 'memory'
      ? draft.memoryResource !== (saved?.resourceId || '') || (!!draft.memoryResource && draft.memoryModel !== (saved?.modelName || ''))
      : false;
  const count = !kind ? 0 : kind === 'chat'
    ? Number(draft.chatResource !== (saved?.resourceId || '')) + Number(Boolean(draft.chatResource) && draft.chatModel !== (saved?.modelName || ''))
    : Number(draft.memoryResource !== (saved?.resourceId || '')) + Number(Boolean(draft.memoryResource) && draft.memoryModel !== (saved?.modelName || ''));
  useEffect(() => { if (kind) { setDirty(dirty, count); setBusy(busy); } }, [kind, dirty, count, busy, setDirty, setBusy]);
  useEffect(() => {
    if (!active || !discardToken || !closedId?.startsWith('model:')) return;
    const chat = bindings.find(item => item.capability === 'chat_model');
    const memory = bindings.find(item => item.capability === 'memory_model');
    setDraft(previous => closedId.startsWith('model:chat')
      ? { ...previous, chatResource: chat?.resourceId || '', chatModel: chat?.modelName || '' }
      : { ...previous, memoryResource: memory?.resourceId || '', memoryModel: memory?.modelName || '' });
  }, [discardToken]);
  const options = resources.filter(item => item.kind === 'model');
  const probe = kind === 'chat' ? chatProbe : memoryProbe;
  const resourceId = kind === 'chat' ? draft.chatResource : draft.memoryResource;
  const modelName = kind === 'chat' ? draft.chatModel : draft.memoryModel;
  const cacheKey = kind === 'chat' ? chatKey : memoryKey;
  const pick = (id: string) => {
    const picked = options.find(item => item.resourceId === id);
    const nextName = picked ? savedModelNameOf(picked) : '';
    setDraft(previous => kind === 'chat' ? { ...previous, chatResource: id, chatModel: nextName } : { ...previous, memoryResource: id, memoryModel: nextName });
    probe.reset();
  };
  const setName = (name: string) => { probe.invalidateTest(); setDraft(previous => kind === 'chat' ? { ...previous, chatModel: name } : { ...previous, memoryModel: name }); };
  const service = options.find(item => item.resourceId === resourceId);
  const missing = !!resourceId && !service;
  const serviceGroup = kind !== null && <div className="config-grp config-role-model-service" data-sheet-group={group === 'service' ? '' : undefined}>
    <div className="config-grp-label"><b>服务</b></div>
    <div className="config-grp-fields">
      <Field label={kind === 'chat' ? '对话模型' : '记忆模型'}>
        <Select disabled={!loaded || busy} value={resourceId} onChange={event => pick(event.target.value)}>
          {missing && <option value={resourceId} disabled>{T34.option}</option>}
          <option value="">{kind === 'chat' ? '未选择' : '跟随对话模型'}</option>
          {options.map(item => <option value={item.resourceId} key={item.resourceId} disabled={!item.enabled}>{item.name}{item.enabled ? '' : T33.optionSuffix}</option>)}
        </Select>
      </Field>
      {loaded && options.every(item => !item.enabled) && <p className="config-sheet-note"><button type="button" className="config-sheet-link" onClick={() => requestClose(() => onOpenSettings('model', { modelKind: 'model' }))}>{T25.add}</button></p>}
      {kind === 'chat' && !resourceId && <p className="config-sheet-note">{T1}</p>}
      {missing && <p className="config-sheet-error" role="alert">{T34.value}</p>}
      {service?.enabled === false && <p className="config-sheet-note" data-warning>{T33.selectedNote}</p>}
      {service?.enabled && <ModelNamePicker presets={modelPresets(service.config.protocol, service.config.baseUrl)} roleLayout={kind === 'chat' ? 'service' : 'memory'} value={modelName} onChange={setName} models={probe.models} listBusy={probe.listBusy} listError={probe.listError} listLoaded={probe.listLoaded} testBusy={probe.testBusy} testNote={probe.testModel === modelName ? probe.testNote : ''} notice={kind === 'chat' && probe.notice?.source === 'test' ? null : probe.notice} onRefresh={() => void probe.refresh({ kind: 'saved', resourceId, cacheKey })} onTest={() => void probe.test({ kind: 'saved', resourceId, cacheKey }, modelName.trim())} testDisabled={!modelName.trim()} disabled={!loaded}/>}
    </div>
  </div>;
  return <Sheet idPrefix="model:" enabled={active} footer={<RoleSaveActions count={count} pause={pause} busy={busy} invalid={!loaded || !!onReload || Boolean(resourceId && !modelName.trim())} error={error} onSave={() => void onSave('models')}/>}>
    {kind !== null && <div className="config-sheet-groups">
      {group !== 'test' && serviceGroup}
      {kind === 'chat' && service?.enabled && group !== 'service' && <div className="config-grp" data-sheet-group={group === 'test' ? '' : undefined}>
        <div className="config-grp-label"><b>连接测试</b></div>
        <div>
          <div className="config-sheet-row config-model-test">
            <Button size="sm" disabled={!resourceId || !modelName.trim() || probe.listBusy} busy={probe.testBusy} onClick={() => void probe.test({ kind: 'saved', resourceId, cacheKey }, modelName.trim())}>测试</Button>
            <ProbeFeedback busy={probe.testBusy} notice={visibleProbeNotice(probe.notice?.source === 'test' ? probe.notice : null, modelName)} testAnnouncedExternally/>
          </div>
          <p className="config-sheet-note"><button type="button" className="config-sheet-link" onClick={() => requestClose(() => onOpenSettings('model', resourceId ? { modelKind: 'model', resourceId } : { modelKind: 'model' }))}>{T25.viewModel}</button></p>
        </div>
      </div>}
      {onReload && <Button size="sm" disabled={busy} onClick={() => void onReload()}>重试读取绑定</Button>}
      {notice && <p className="config-sheet-note" role="status">{notice}</p>}
    </div>}
  </Sheet>;
}

/** 工作区级纸笺：T37 切换角色确认与「＋ 新建角色…」（规范 §7.9）。 */
function WorkspaceSheets({ pendingSwitch, clearPendingSwitch, onSwitch, onCreated }: { pendingSwitch: { roleId: string; to: string; count: number } | null; clearPendingSwitch: () => void; onSwitch: (roleId: string) => void; onCreated: (role: RoleDetail) => Promise<void> }) {
  const { sheet, requestClose, closeNow, setBusy, setDirty, discardToken, closedId } = useSheet();
  const write = useWrite();
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [busy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const openSwitch = sheet?.id === 'switch-role';
  const openCreate = sheet?.id === 'create-role';
  const count = Number(name.length > 0) + Number(definition.length > 0);
  useEffect(() => { if (openCreate) setDirty(count > 0, count); }, [openCreate, count, setDirty]);
  // 关闭（含「放弃修改」）后清空新建角色的草稿，避免下次打开残留上次输入（R11-2）。
  useEffect(() => {
    if (!discardToken || closedId !== 'create-role') return;
    setName('');
    setDefinition('');
    setError('');
  }, [discardToken, closedId]);
  const create = async () => {
    if (busy || !name.trim() || !definition.trim()) return;
    setLocalBusy(true); setError('');
    setBusy(true);
    try {
      let role: RoleDetail | undefined;
      const result = await write.runWrite({ verb: '创建角色', announceSuccess: false, commit: async () => {
        role = await api<RoleDetail>('/v1/roles', { method: 'POST', body: { displayName: name.trim(), definition: { text: definition.trim() } } });
      } });
      if (!result.ok) { setError(result.failure.message); return; }
      if (role) { const created = role; closeNow(() => { void onCreated(created); }, '已创建角色'); }
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setLocalBusy(false); }
  };
  return <>
    <Sheet idPrefix="switch-role" footer={openSwitch ? <div className="config-sheet-actions">
      <span className="config-sheet-spacer"/>
      <button type="button" data-sheet-focus onClick={() => { clearPendingSwitch(); requestClose(); }}>{T37.cancel}</button>
      <Button variant="danger" onClick={() => { const target = pendingSwitch?.roleId; requestClose(() => { clearPendingSwitch(); if (target) onSwitch(target); }); }}>{T37.confirm}</Button>
    </div> : null}>
      {openSwitch && pendingSwitch && <div className="config-sheet-groups">
        <div className="config-grp" data-sheet-group>
          <div className="config-grp-label"><b>切换</b></div>
          <div><p className="config-sheet-ask">{T37.text(pendingSwitch.count, '设定', pendingSwitch.to)}</p></div>
        </div>
      </div>}
    </Sheet>
    <Sheet idPrefix="create-role" footer={openCreate ? <div className="config-sheet-actions">
      {error && <p className="config-sheet-error" role="alert">{error}</p>}
      <span className="config-sheet-spacer">{!error && (busy ? T29.saving : count ? T8.filled(count) : '')}</span>
      <button type="button" disabled={busy} onClick={() => requestClose()}>{T37.cancel}</button>
      <Button disabled={!busy && (!name.trim() || !definition.trim())} busy={busy} onClick={() => void create()}>创建角色</Button>
    </div> : null}>
      {openCreate && <div className="config-sheet-groups">
        <div className="config-grp" data-sheet-group>
          <div className="config-grp-label"><b>新角色</b></div>
          <div className="config-grp-fields">
            <Field label="名字"><Input data-sheet-focus value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)}/></Field>
            <Field label="角色设定"><Textarea rows={6} value={definition} disabled={busy} onChange={event => setDefinition(event.target.value)}/></Field>
          </div>
        </div>
      </div>}
    </Sheet>
  </>;
}

function useModelAddress(initial: string, initialRouting?: unknown) {
  const [raw, setRaw] = useState(initial);
  const [routing, setRouting] = useState(initialRouting);
  const [edited, setLocation] = useState<VertexLocation>();
  const parsed = parseVertexLocation(raw);
  const location = edited ?? (parsed && !parsed.region && routing === 'manual' ? { ...parsed, region: 'express' } : parsed);
  const { url, error } = edited ? vertexLocationAddress(edited) : { url: raw, error: '' };
  const setAddress = (value: string, mode?: unknown) => { setRaw(value); setRouting(mode); setLocation(undefined); };
  return { url, error, location, manualExpress: location?.region.trim() === 'express', setAddress, setLocation };
}

function ModelConnectionInputs({ adapter, address, safety, disabled, onAdapter, onAddress, onSafety }: {
  safety: VertexSafetyLevel; onSafety: (value: VertexSafetyLevel) => void;
  adapter: string; address: ReturnType<typeof useModelAddress>; disabled: boolean; onAdapter: (value: string) => void; onAddress: (value: string) => void;
}) {
  const regions = useId();
  const location = adapter === 'google-gemini' ? address.location : undefined;
  const addressField = <Field label="服务地址"><Input disabled={disabled} value={address.url} placeholder={address.error ? '填写地区和项目后生成地址' : modelBaseUrlPlaceholder(adapter)}
    onChange={event => onAddress(event.target.value)}/></Field>;
  return <div className="config-connection">
    <Field label="协议"><Select disabled={disabled} value={adapter} onChange={event => onAdapter(event.target.value)}>
      {MODEL_ADAPTER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select></Field>
    {location ? <details><summary>高级设置 · {location.region || '自动选择入口'}</summary>
      <Field label="地区" hint="留空时，测试连接会为该模型寻找可用入口。指定地区后始终直连。"><Input disabled={disabled} list={regions} value={location.region} placeholder="自动选择"
        onChange={event => address.setLocation({ ...location, region: event.target.value })}/>
        <datalist id={regions}>{['express', 'global', 'us-central1', 'europe-west4', 'asia-northeast1'].map(region => <option key={region} value={region}/>)}</datalist>
      </Field>
      {location.region.trim() && location.region.trim() !== 'express' && <Field label="Google Cloud 项目"><Input disabled={disabled} value={location.project} placeholder="项目 ID 或项目编号"
        onChange={event => address.setLocation({ ...location, project: event.target.value })}/></Field>}
      {addressField}
    </details> : addressField}
    {(location || hasVertexSafety(adapter, address.url)) && <Field label="安全阈值"><Select aria-label="安全阈值" disabled={disabled} value={safety} onChange={event => onSafety(vertexSafetyOf(event.target.value))}>
      <option value="high">高</option><option value="default">默认</option><option value="off">关闭</option>
    </Select></Field>}
  </div>;
}

function NewModelSheet({ active, trigger, count, busy, invalid, error, onSave, onCancel, children }: { active: boolean; trigger: HTMLElement | null; count: number; busy: boolean; invalid: string; error: string; onSave: () => void; onCancel: () => void; children: (group?: string) => ReactNode }) {
  const sheet = useSheet();
  useEffect(() => { if (active) sheet.open({ id: 'new-model-service', title: '添加模型服务', shape: 'full', focusReturn: trigger }); }, [active]);
  return <ServiceSheet id="new-model-service" active={active} count={count} busy={busy} onDiscard={onCancel} footer={<ServiceSheetActions creating count={count} busy={busy} invalid={invalid} error={error} onSubmit={onSave}/>}>{children}</ServiceSheet>;
}

function SettingsRefresh({ label, success, disabled, onRefresh }: { label: string; success: string; disabled?: boolean; onRefresh: (signal: AbortSignal) => Promise<boolean> }) {
  const { reportResult } = useWrite();
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  return <ControlButton className="config-status-refresh" aria-label={label} title={label} busy={busy} disabled={disabled} onClick={async () => {
    if (request.current) return;
    const task = new AbortController();
    request.current = task;
    setBusy(true);
    try {
      if (await onRefresh(task.signal) && !task.signal.aborted) reportResult(success);
    } finally {
      if (!task.signal.aborted) setBusy(false);
      if (request.current === task) request.current = null;
    }
  }}><span><Icon name="refresh" size={15}/></span></ControlButton>;
}

function RoleStatusCards({ roles, activities, loading, error, onRefresh, onRolesChanged, onChanged, onConfigure }: {
  roles: RoleListItem[]; activities: Activity[]; loading: boolean; error: string;
  onRefresh: (signal: AbortSignal) => Promise<boolean>; onRolesChanged: () => Promise<void>;
  onChanged: (activity: Activity) => void; onConfigure: (roleId: string) => void;
}) {
  const write = useWrite();
  const [pending, setPending] = useState<Record<string, 'stop' | 'resume'>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const change = async (roleId: string, operation: 'stop' | 'resume') => {
    const finish = write.beginWrite();
    if (!finish) return;
    setPending(previous => ({ ...previous, [roleId]: operation }));
    setErrors(previous => ({ ...previous, [roleId]: '' }));
    try {
      const roleUrl = `/v1/roles/${encodeURIComponent(roleId)}`;
      const retryInit = operation === 'resume' && (activities.find(item => item.roleId === roleId)?.initStatus === 'failed' || roles.find(item => item.roleId === roleId)?.status === 'failed');
      if (retryInit) await api(`${roleUrl}/initialize`, { method: 'POST' });
      const result = await api<{ activity: Activity }>(`${roleUrl}/activity/${operation}`, { method: 'POST' });
      onChanged(result.activity);
      if (retryInit) void onRolesChanged();
      if (result.activity.state === 'active') write.forgetPaused(roleId);
      if (result.activity.state === (operation === 'stop' ? 'stopped' : 'active')) {
        write.reportResult(`${roleDisplayName(roles, roleId)} ${operation === 'stop' ? '已停止' : '已恢复活动'}`);
      }
    } catch (reason) {
      setErrors(previous => ({ ...previous, [roleId]: T32.toggleFail(operation === 'stop' ? '停止活动' : '恢复活动', errorText(reason)) }));
    } finally {
      setPending(previous => { const next = { ...previous }; delete next[roleId]; return next; });
      finish();
    }
  };
  return <div className="config-prose config-status-page"><header className="config-sec-head"><h2 tabIndex={-1}>角色状态</h2><SettingsRefresh label="刷新状态" success="状态已刷新" disabled={write.busy || write.resuming} onRefresh={onRefresh}/></header>
    {error && <p role="alert">状态获取失败：{error}</p>}
    <div className="config-status-wall">{roles.map(role => {
      const activity = activities.find(item => item.roleId === role.roleId);
      const action = pending[role.roleId];
      const initFailed = activity ? activity.initStatus === 'failed' : role.status === 'failed';
      const state = action === 'resume' || (write.resuming && write.pausedRoleIds.includes(role.roleId)) ? 'resuming'
        : action === 'stop' || write.pendingPauseIds.includes(role.roleId) ? 'stopping' : initFailed ? 'stopped' : activity?.state;
      const failed = state === 'stopped' && initFailed;
      const moving = state === 'stopping' || state === 'resuming';
      const status = failed ? 'error' : state === 'active' ? 'ok' : moving ? 'dirty' : 'off';
      const label = failed ? '初始化失败' : state ? T20.state[state] : loading ? '正在读取…' : '状态获取失败';
      const activityLabel = state === 'resuming' ? T20.resuming : state === 'stopping' ? T20.stopping : state === 'stopped' ? T20.resume : T20.stop;
      return <article className="config-status-poster" data-role={role.roleId} data-state={state} key={role.roleId}>
        <RolePortrait roleId={role.roleId}/><strong className="config-status-name" title={role.displayName}>{role.displayName}</strong>
        <span className="config-status-state"><StatusDot status={status} label={label}/></span>
        {failed && <small className="config-status-error">{T21(role.initError || '初始化失败')}</small>}
        <div className="config-status-actions">{(activity || failed) && <Button size="sm" busy={moving} disabled={!moving && (write.busy || write.resuming)} onClick={() => void change(role.roleId, state === 'stopped' ? 'resume' : 'stop')}>{activityLabel}</Button>}
          <button type="button" className="config-status-link" aria-label={`${role.displayName}的角色配置`} onClick={() => onConfigure(role.roleId)}>{T20.configure}</button></div>
        {errors[role.roleId] && <small className="config-status-error" role="alert">{errors[role.roleId]}</small>}
      </article>;
    })}</div>
  </div>;
}

function ConfigHeading({ number, label, english, title, description }: { number: string; label: string; english: string; title: string; description: string }) {
  return <header className="config-section-heading"><small><i>{number}</i> {label} · {english}</small><h2 tabIndex={-1}>{title}</h2><p>{description}</p></header>;
}

/** 为保存而暂停的角色提供一键恢复（T30），两页页脚右侧共用。 */
function PausedRolesFooter({ roles, controller }: { roles: RoleListItem[]; controller: React.MutableRefObject<ReturnType<typeof useWrite> | null> }) {
  const write = useWrite();
  useEffect(() => { controller.current = write; return () => { if (controller.current === write) controller.current = null; }; }, [controller, write]);
  const target = document.getElementById('config-leaf-actions');
  if ((!write.pausedRoleIds.length && !write.statusError && !write.pendingPauseIds.length) || !target) return null;
  const names = write.pausedRoleIds.map(id => roleDisplayName(roles, id));
  return createPortal(<div className="config-pause-feedback">
    {write.statusError ? <span className="config-sheet-error config-write-error" role="alert">{write.statusError}</span>
      : write.pendingPauseIds.length > 0 ? <span className="config-write-error">{T29.pausingRoles(write.pendingPauseIds.map(id => roleDisplayName(roles, id)))}</span> : null}
    {names.length > 0 && <div className="config-pause-resume" role="status"><span title={names.join('、')}>{T30.text(names)}</span><ControlButton className="config-resume-save" busy={write.resuming} disabled={write.busy} onClick={() => void write.resumePaused()}>{write.resuming && <span className="spinner" aria-hidden="true"/>}{write.resuming ? T30.resuming : T30.resume}</ControlButton></div>}
  </div>, target);
}

/** 设定分区的删除入口：打开删除确认纸笺（§7.7）；实际写入在 RoleSheetHost。 */
function RoleDeleteEntry({ roleCount, isBuiltin }: { roleCount: number; isBuiltin: boolean }) {
  const { open } = useSheet();
  const reasonId = useId();
  const write = useWrite();
  const reason = isBuiltin ? '常驻主角色会始终保留。' : roleCount < 2 ? T38 : '';
  return <div className="config-ledger"><div className="config-ledger-label"><b>{T31.role.title}</b></div><div className="config-role-delete-entry">
    <Button variant="default" size="sm" className="config-role-delete-button" disabled={Boolean(reason) || write.busy}
      aria-describedby={reason ? reasonId : undefined} onClick={event => open({ id: 'delete-role', title: T31.role.title, shape: 'confirm', anchor: event.currentTarget })}>{T31.role.title}</Button>
    {reason && <small className="config-inline-hint" id={reasonId}>{reason}</small>}
  </div></div>;
}

function ResourceDetail({ resource, onConfigure, roles, activities, active, canWrite, testedOverride, onTested, onRemoved, onUpdated }: { resource: Resource; onConfigure?: () => void; roles: RoleListItem[]; activities: Activity[]; active: boolean; canWrite: boolean; testedOverride?: boolean | null; onTested: (tested: boolean | null) => void; onRemoved: (id: string) => void; onUpdated: (resource?: Resource) => void }) {
  const sheetApi = useSheet();
  const write = useWrite();
  const savedRef = useRef(resource);
  const [model, setModel] = useState(() => savedModelNameOf(resource));
  const savedModelRef = useRef(savedModelNameOf(resource));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState(resource.name);
  const [draftAdapter, setDraftAdapter] = useState(modelAdapterOf(resource.config));
  const [draftSafety, setDraftSafety] = useState(() => vertexSafetyOf(resource.config.vertexSafety));
  const draftAddress = useModelAddress(String(resource.config.baseUrl || ''), resource.config.vertexRouting);
  const { url: draftUrl, setAddress: setDraftUrl } = draftAddress;
  const [secretDraft, setSecretDraft] = useState(() => createSecretDraft(resource.credential?.status));
  const secretStatusRef = useRef(resource.credential?.status);
  const [secretVisible, setSecretVisible] = useState(false);
  const [secretLoading, setSecretLoading] = useState(false);
  const [secretError, setSecretError] = useState('');
  const revealSeq = useRef(0);
  const [impact, setImpact] = useState<ResourceImpact | null>(null);
  const [impactError, setImpactError] = useState('');
  const [impactVersion, setImpactVersion] = useState(0);
  const [secretUpdated, setSecretUpdated] = useState(false);
  const [probePrompt, setProbePrompt] = useState<ReturnType<typeof serviceProbeNotice>>(null);
  const [probeGroup, setProbeGroup] = useState<'connection' | 'model'>('model');
  const savedAdapter = modelAdapterOf(resource.config);
  const savedBaseUrl = String(resource.config.baseUrl || '');
  const savedKey = providerCacheKey(resource);
  const secretOp = secretOperationOf(secretDraft);
  const secretProbeKey = secretOp.action === 'replace' ? `replace:${secretOp.secret}` : secretOp.action;
  const safetyDirty = hasVertexSafety(draftAdapter, draftUrl) && draftSafety !== vertexSafetyOf(resource.config.vertexSafety);
  const routingDirty = draftAddress.manualExpress !== (resource.config.vertexRouting === 'manual');
  const sameConnection = !routingDirty && !safetyDirty && secretOp.action === 'keep' && draftAdapter === savedAdapter && draftUrl.trim() === savedBaseUrl;
  const probe = useModelProbe(sameConnection ? savedKey : `${savedKey}|${secretProbeKey}|${draftAdapter}|${draftUrl}|${draftSafety}|${draftAddress.manualExpress}`, {
    shared: sameConnection, onSavedList: () => onUpdated(), onSavedTest: () => onUpdated(),
  });
  const changeDraftAdapter = (next: string) => {
    const url = resolveModelBaseUrlOnProtocolChange(draftUrl, next, draftAdapter);
    if (modelCredentialScope(next, url, resource.config.provider) !== modelCredentialScope(draftAdapter, draftUrl, resource.config.provider)) {
      revealSeq.current += 1;
      setSecretLoading(false);
      setSecretVisible(false);
      setSecretDraft(createSecretDraft(resource.credential?.status));
    }
    setDraftAdapter(next);
    setDraftUrl(url);
    probe.reset();
  };
  useEffect(() => {
    if (sameConnection && probe.notice?.source === 'test' && probe.testModel === savedModelNameOf(resource)) {
      onTested(probe.notice.role === 'status');
    }
  }, [probe.notice, sameConnection]);
  const sheetId = `model-form:${resource.resourceId}`;
  useServiceSheetExit(sheetId, () => {
    revealSeq.current += 1;
    setSecretLoading(false);
    setProbePrompt(null);
    setSecretVisible(false);
    setSecretDraft(previous => hideUneditedSecret(previous));
    probe.cancelPending();
  });
  useEffect(() => { savedRef.current = resource; }, [resource]);
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
  }, [active, probe.clearLog]);
  useEffect(() => {
    if (!active || resource.kind !== 'model') return;
    let alive = true;
    setImpactError('');
    api<ResourceImpact>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/impact`)
      .then(value => { if (alive) setImpact(value); })
      .catch(reason => { if (alive) { setImpact(null); setImpactError(errorText(reason)); } });
    return () => { alive = false; };
  }, [active, resource.resourceId, impactVersion, activities]);
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
  const probeTarget = (forTest = false): ModelProbeTarget => {
    const base = modelConnectionFields(draftAdapter, draftUrl, resource.config.provider, draftSafety, draftAddress.manualExpress);
    // 未改动的配置走按资源接口，结果写回资源摘要；其余用草稿探测。
    if (sameConnection && (!forTest || (draftAddress.location && !draftAddress.location.region && draftAdapter === 'google-gemini') || model.trim() === savedModelNameOf(resource))) {
      return { kind: 'saved', resourceId: resource.resourceId, cacheKey: savedKey };
    }
    if (secretOp.action === 'replace') return { kind: 'draft', config: { ...base, secret: secretOp.secret } };
    if (secretOp.action === 'clear' || !secretDraft.hasExisting) return { kind: 'draft', config: base };
    return { kind: 'draft', config: { ...base, resourceId: resource.resourceId } };
  };
  useEffect(() => setProbePrompt(null), [draftUrl, draftAdapter, draftSafety, draftAddress.manualExpress, secretProbeKey, model]);
  const connectionDirty = routingDirty || secretOp.action !== 'keep' || draftAdapter !== savedAdapter || draftUrl.trim() !== savedBaseUrl;
  const activeDeps = (impact?.roles ?? []).filter(item => item.state !== 'stopped' && item.usages.some(usage => usage !== 'task'));
  const pauseNames = connectionDirty ? activeDeps.map(item => item.displayName) : [];
  const staleSite = !!draftUrl.trim() && secretDraft.hasExisting && secretOp.action === 'keep' &&
    modelCredentialScope(draftAdapter, draftUrl, resource.config.provider) !== modelCredentialScope(savedAdapter, savedBaseUrl, resource.config.provider);
  const credentialNotice = serviceHost(draftUrl) === serviceHost(savedBaseUrl) ? '服务商或协议已更换，请重新填写密钥。' : T12;
  const runProbe = (action: 'test' | 'list', group: 'connection' | 'model' = 'model') => {
    setProbeGroup(group);
    const problem = draftAddress.error || (!draftUrl.trim() ? T16.needUrl : action === 'test' && !model.trim() ? T16.needModel : staleSite ? credentialNotice : '');
    setProbePrompt(problem ? { source: action, role: 'alert', text: problem } : null);
    if (problem) { probe.clearLog(); return; }
    if (action === 'list') void probe.refresh(probeTarget());
    else void probe.test(probeTarget(true), model.trim());
  };
  const probeNotice = probePrompt ?? serviceProbeNotice(probe.notice, probe.models.length);
  const count = [routingDirty, safetyDirty, draftName !== resource.name, draftAdapter !== savedAdapter, draftUrl.trim() !== savedBaseUrl, model.trim() !== savedModelNameOf(resource), secretOp.action !== 'keep'].filter(Boolean).length;
  const save = async () => {
    if (busy || !canWrite || !count || !draftName.trim() || !draftUrl.trim() || staleSite) return;
    const finish = write.beginWrite(connectionDirty ? activeDeps.map(item => item.roleId) : []);
    if (!finish) return;
    // 提交配置与读取列表时一致才转交候选；换密钥先清理旧候选。
    const carriedModels = probe.listLoaded ? [...probe.models] : null;
    const trimmedModel = model.trim();
    const carriedTestCallId = probe.testModel === trimmedModel ? probe.draftTestCallId : undefined;
    const carriedResult = probe.notice?.source === 'test' && probe.testModel === trimmedModel ? probe.notice.role === 'status' : undefined;
    setBusy(true); setMessage('');
    try {
      const config: Record<string, unknown> = { ...resource.config, ...modelConnectionFields(draftAdapter, draftUrl, resource.config.provider, draftSafety, draftAddress.manualExpress) };
      if (!draftAddress.manualExpress) delete config.vertexRouting;
      if (!hasVertexSafety(draftAdapter, draftUrl)) delete config.vertexSafety;
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
            ...(carriedTestCallId ? { draftTestCallId: carriedTestCallId } : {}),
            ...(probe.draftRouteTestIds.length ? { draftRouteTestIds: probe.draftRouteTestIds } : {}),
          },
        },
      );
      write.recordPaused(result.maintenance?.pausedRoleIds ?? []);
      savedRef.current = result;
      if (!live.current) return;
      setImpactVersion(value => value + 1);
      const resultKey = providerCacheKey(result);
      if (secretOp.action !== 'keep') { clearModelCache(resultKey); setSecretUpdated(secretOp.action === 'replace'); }
      if (carriedModels !== null) writeModelCache(resultKey, carriedModels);
      const nextSavedModel = savedModelNameOf(result) || trimmedModel;
      savedModelRef.current = nextSavedModel;
      secretStatusRef.current = result.credential?.status;
      setDraftName(result.name);
      setDraftAdapter(modelAdapterOf(result.config));
      setDraftSafety(vertexSafetyOf(result.config.vertexSafety));
      setDraftUrl(String(result.config.baseUrl || ''), result.config.vertexRouting);
      setModel(nextSavedModel);
      setSecretDraft(createSecretDraft(result.credential?.status));
      setSecretVisible(false);
      setSecretError('');
      if (carriedResult !== undefined) onTested(carriedResult);
      else if (!sameConnection || model.trim() !== savedModelNameOf(resource)) onTested(null);
      setMessage('');
      sheetApi.closeNow(undefined, `${result.name} 已保存`);
      onUpdated(result);
    } catch (e) { if (live.current) {
      const maintenance = serviceMaintenanceOf(e);
      write.recordPaused(maintenance.paused);
      if (maintenance.paused.length) setImpactVersion(value => value + 1);
      setMessage(serviceWriteFailure(e, '保存', errorText(e), id => roleDisplayName(roles, id)));
    } } finally { if (live.current) setBusy(false); finish(); }
  };
  if (resource.kind !== 'model') return <ExtensionManagement onConfigure={onConfigure} resource={resource} roles={roles} activities={activities} active={active} onRemoved={onRemoved} onUpdated={onUpdated}/>;
  const open = (group?: string, trigger?: HTMLElement) => sheetApi.open({ id: sheetId, title: group ? `${resource.name} · ${group}` : `编辑「${resource.name}」`, shape: group ? 'compact' : 'full', group, anchor: trigger?.closest<HTMLElement>('.config-sum') ?? trigger, focusReturn: trigger?.matches('button') ? trigger : trigger?.querySelector<HTMLElement>('.config-sum-edit') });
  const discard = () => { const saved = savedRef.current; setDraftName(saved.name); setDraftSafety(vertexSafetyOf(saved.config.vertexSafety)); setDraftAdapter(modelAdapterOf(saved.config)); setDraftUrl(String(saved.config.baseUrl || ''), saved.config.vertexRouting); setModel(savedModelNameOf(saved)); setSecretDraft(createSecretDraft(saved.credential?.status)); setSecretVisible(false); setSecretError(''); setMessage(''); probe.cancelPending(); };
  const secretStatus = !resource.credential?.status || resource.credential.status === 'missing' ? 'none' : resource.credential?.status === 'unavailable' ? 'error' : 'ok';
  const tested = testedOverride !== undefined ? testedOverride : resource.lastTest && !resource.lastTest.stale ? resource.lastTest.ok : null;
  return <div hidden={!active} className="config-prose">
    <ServiceHeading title={resource.name} address={String(resource.config.baseUrl || '')} enabled={resource.enabled} tested={tested} onEdit={trigger => open(undefined, trigger)}/>
    <ServiceRow label="连接" value={modelAdapterLabel(savedAdapter)} keys={[String(resource.config.baseUrl || '')]} onOpen={trigger => open('连接', trigger)}/>
    <ServiceRow label="密钥" keys={secretUpdated ? ['刚刚更新'] : []} value={secretStatus === 'none' ? '未设置' : secretStatus === 'error' ? '不可用' : '已设置'} status={secretStatus} statusText={secretStatus === 'none' ? '未设置（选填）' : secretStatus === 'error' ? '密钥不可用' : '已设置'} onOpen={trigger => open('密钥', trigger)}/>
    <ServiceRow label="模型" value={savedModelNameOf(resource) || '未选择'} keys={sameConnection && probe.listLoaded ? [`${probe.models.length} 个可选`] : []} status={tested === null ? 'off' : tested ? 'ok' : 'error'} statusText={tested === null ? '尚未测试' : tested ? '连接正常' : '连接失败'} onOpen={trigger => open('模型', trigger)}/>
    <ModelManagement resource={resource} roles={roles} activities={activities} impact={impact} active={active} canWrite={canWrite} onRemoved={onRemoved} onUpdated={onUpdated}/>
    <ServiceSheet id={sheetId} active={active} count={count} busy={busy} onDiscard={discard}
      footer={<ServiceSheetActions count={count} busy={busy} invalid={!draftName.trim() ? T10.name : draftAddress.error || (!draftUrl.trim() ? T10.url : !!staleSite)} error={message} pauseNames={pauseNames} onSubmit={() => void save()}/>}>
      {group => <>
        <MediaGroup title="名称" group={group}><div className="config-service-field-one"><Field label="模型服务名称"><Input aria-label="模型服务名称" maxLength={200} disabled={busy} value={draftName} onChange={event => setDraftName(event.target.value)}/></Field></div></MediaGroup>
        <MediaGroup title="连接" group={group}>
          <ModelConnectionInputs safety={draftSafety} onSafety={setDraftSafety} adapter={draftAdapter} address={draftAddress} disabled={busy} onAdapter={changeDraftAdapter}
            onAddress={value => { setDraftUrl(value); probe.reset(); }}/>
          {group === '连接' && <ServiceProbeAction busy={probe.testBusy} disabled={busy || probe.listBusy} notice={probeGroup === 'connection' ? probeNotice : null} onClick={() => runProbe('test', 'connection')}/>}
          <div className="config-connection-feedback">{staleSite && <p className="config-service-form-note">{credentialNotice}</p>}
            {impactError && connectionDirty && <p role="alert">影响范围读取失败：{impactError}</p>}</div></MediaGroup>
        <MediaGroup title="密钥" group={group}><SecretInput aria-label="模型密钥" disabled={busy} loading={secretLoading} value={secretDraft.value} visible={secretVisible} placeholder={secretDraft.hasExisting ? '留空则保留原密钥' : '选填'} onFocus={event => { if (!secretDraft.dirty && secretDraft.baselineSecret === null && secretDraft.value === SECRET_MASK_SENTINEL) event.currentTarget.select(); }} onToggleVisible={() => void toggleSecretVisible()} onChange={nextValue => { setSecretDraft(previous => nextSecretDraftOnInput(previous, nextValue)); setSecretError(''); probe.reset(); }}/>{secretError && <p role="alert">{secretError}</p>}</MediaGroup>
        <MediaGroup title="模型" group={group}><ModelNamePicker settings presets={modelPresets(draftAdapter, draftUrl)} value={model} onChange={value => { setModel(value); probe.invalidateTest(); }} models={probe.models} listBusy={probe.listBusy} listError={probe.listError} listLoaded={probe.listLoaded} testBusy={probe.testBusy} testNote={probe.testModel === model ? probe.testNote : ''} notice={probeGroup === 'model' ? probeNotice : null} onRefresh={() => runProbe('list')} onTest={() => runProbe('test')} disabled={busy}/></MediaGroup>
      </>}
    </ServiceSheet>
  </div>;
}

type ResourceReferences = { references: Array<{ roleId: string; capability?: string | null; reason: 'ROLE_BINDING' | 'TASK_CHAIN' | 'INFLIGHT_CALL'; bindingEnabled: boolean | null; taskId?: string }>; canUpdate: boolean; canDisable: boolean; canDelete: boolean };
type ResourceImpact = { roles: Array<{ roleId: string; displayName: string; usages: Array<'chat' | 'memory' | 'task'>; taskIds: string[]; state: string; running: boolean }>; blockingTasks: number };

function referenceUsers(entries: ResourceReferences['references'], roles: RoleListItem[], activities: Activity[], useLabel: (entry: ResourceReferences['references'][number]) => string) {
  const byId = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.reason !== 'ROLE_BINDING' || !entry.bindingEnabled) continue;
    const usage = useLabel(entry);
    const usages = byId.get(entry.roleId) ?? [];
    if (!usages.includes(usage)) usages.push(usage);
    byId.set(entry.roleId, usages);
  }
  return [...byId].map(([roleId, usages]) => ({
    roleId, usages, name: roleDisplayName(roles, roleId), state: activities.find(activity => activity.roleId === roleId)?.state,
  }));
}

function ResourceUseDetails({ entries, roles, busy, pending, closeBindings, endTask }: {
  entries: ResourceReferences['references']; roles: RoleListItem[]; busy: boolean; pending: string | null;
  closeBindings: (roleIds: string[], key: string) => Promise<void>; endTask: (roleId: string, taskId: string) => Promise<void>;
}) {
  if (!entries.length) return null;
  const boundRoles = [...new Set(entries.filter(item => item.reason === 'ROLE_BINDING' && item.bindingEnabled).map(item => item.roleId))];
  return <details className="config-occupancy-details"><summary>查看占用详情</summary>
    <ul>
      {boundRoles.map(roleId => <li key={roleId}>{roleDisplayName(roles, roleId)} · 已绑定
        <Button size="sm" busy={pending === `binding:${roleId}`} disabled={busy} onClick={() => void closeBindings([roleId], `binding:${roleId}`)}>关闭该角色绑定</Button>
      </li>)}
      {entries.filter(item => item.reason !== 'ROLE_BINDING').map((item, index) => <li key={`${item.reason}-${item.roleId}-${item.taskId ?? index}`}>
        {roleDisplayName(roles, item.roleId)} · {item.reason === 'TASK_CHAIN' ? '任务仍在使用' : '后台调用进行中'}
        {item.reason === 'TASK_CHAIN' && item.taskId && <Button size="sm" busy={pending === `task:${item.roleId}:${item.taskId}`} disabled={busy} onClick={() => void endTask(item.roleId, item.taskId!)}>结束任务</Button>}
      </li>)}
    </ul>
    {boundRoles.length > 1 && <Button size="sm" busy={pending === 'all-bindings'} disabled={busy} onClick={() => void closeBindings(boundRoles, 'all-bindings')}>关闭全部启用绑定</Button>}
  </details>;
}

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
async function closeRoleResourceBinding(roleId: string, resourceId: string, roleLabel: string, recordPaused: () => void): Promise<void> {
  const activityPath = `/v1/roles/${encodeURIComponent(roleId)}/activity`;
  const before = await api<{ activity: { state: string } }>(activityPath);
  const ownStop = before.activity.state === 'active';
  let stopped = before.activity.state === 'stopped';
  if (before.activity.state !== 'stopped') {
    if (ownStop) await api(`${activityPath}/stop`, { method: 'POST' });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const view = await api<{ activity: { state: string } }>(activityPath);
      if (view.activity.state === 'stopped') { stopped = true; break; }
      await new Promise(resolve => window.setTimeout(resolve, 250));
    }
    if (!stopped) throw new Error(`角色 ${roleLabel} 尚未确认停止，请稍后重试。`);
  }
  let updated = false;
  try {
    const path = `/v1/roles/${encodeURIComponent(roleId)}/bindings`;
    const current = await api<{ items: Binding[]; revision: string }>(path);
    const next = current.items.map(item => ({
      capability: item.capability,
      resourceId: item.resourceId,
      enabled: item.resourceId === resourceId ? false : item.enabled,
      ...(item.modelName ? { modelName: item.modelName } : {}),
    }));
    await api(path, { method: 'PUT', body: { bindings: next, expectedRevision: current.revision } });
    updated = true;
  } finally {
    if (ownStop) {
      try { await api(`${activityPath}/resume`, { method: 'POST' }); }
      catch (error) {
        recordPaused();
        if (updated) throw new Error(`已关闭绑定，恢复活动失败：${errorText(error)}`);
      }
    }
  }
}

function useResourceUseActions(resourceId: string, roles: RoleListItem[], onChanged: () => void) {
  const write = useWrite();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const run = async (key: string, action: () => Promise<void>) => {
    const finish = write.beginWrite();
    if (!finish) return;
    setPending(key); setError('');
    try { await action(); }
    catch (reason) { setError(errorText(reason)); }
    finally { onChanged(); setPending(null); finish(); }
  };
  const closeBindings = (roleIds: string[], key: string) => run(key, async () => {
    const failures: string[] = [];
    const closed: string[] = [];
    for (const roleId of roleIds) {
      const name = roleDisplayName(roles, roleId);
      try {
        await closeRoleResourceBinding(roleId, resourceId, name, () => write.recordPaused([roleId]));
        closed.push(name);
      } catch (reason) { failures.push(`${name}：${errorText(reason)}`); }
    }
    if (closed.length > 0) write.reportResult(`已关闭${closed.join('、')}的绑定`, failures.length ? 'warning' : 'success');
    if (failures.length > 0) setError(failures.join('；'));
  });
  const endTask = async (roleId: string, taskId: string) => {
    if (!window.confirm(`结束任务 ${taskId}？后续步骤不再执行，已发出的调用按原任务结算。`)) return;
    await run(`task:${roleId}:${taskId}`, async () => {
      await finishTaskForResource(roleId, taskId);
      write.reportResult('已结束任务');
    });
  };
  return { pending, error, closeBindings, endTask };
}

function ModelManagement({ resource, roles, activities, impact, active, canWrite, onRemoved, onUpdated }: { resource: Resource; roles: RoleListItem[]; activities: Activity[]; impact: ResourceImpact | null; active: boolean; canWrite: boolean; onRemoved: (id: string) => void; onUpdated: (resource?: Resource) => void }) {
  const [report, setReport] = useState<ResourceReferences | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sheetApi = useSheet();
  const write = useWrite();
  const [deleteError, setDeleteError] = useState('');
  const [toggleBusy, setToggleBusy] = useState(false);
  const useActions = useResourceUseActions(resource.resourceId, roles, () => { setVersion(value => value + 1); onUpdated(); });
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
  const entries = (report?.references ?? []).filter(item => item.reason !== 'ROLE_BINDING' || item.bindingEnabled);
  const selected = impact ? impact.roles.flatMap(item => {
    const usages = item.usages.flatMap(usage => usage === 'chat' ? ['对话'] : usage === 'memory' ? ['记忆整理'] : []);
    return usages.length ? [{ roleId: item.roleId, state: item.state, name: item.displayName, usages }] : [];
  }) : referenceUsers(entries, roles, activities, reference => reference.capability === 'memory_model' ? '记忆整理' : '对话');
  const activeUsers = selected.filter(item => item.state !== 'stopped');
  const names = selected.map(item => `${item.name} · ${item.usages.join('、')}`);
  const deleteId = `model-delete:${resource.resourceId}`;
  const path = `/v1/resources/${encodeURIComponent(resource.resourceId)}`;
  const toggle = async (enabled: boolean) => {
    if (busy || !canWrite || !report || (resource.enabled && !report.canDisable)) return;
    const feedback = captureSavedSummary();
    setToggleBusy(true);
    const result = await write.runWrite({
      roleIds: enabled ? [] : activeUsers.map(item => item.roleId), verb: enabled ? '启用' : '停用', toggle: true, announceSuccess: false,
      commit: async () => {
        const updated = await api<Resource>(path, { method: 'PATCH', body: { enabled } });
        onUpdated(updated);
        setVersion(value => value + 1);
        feedback();
      },
    });
    if (result.ok) write.reportResult(`${resource.name} ${enabled ? '已全局启用' : '已全局停用'}`);
    else if (result.failure.message) write.reportFailure(result.failure.message);
    setToggleBusy(false);
  };
  const remove = async () => {
    if (busy || !report?.canDelete || activeUsers.length) return;
    const finish = write.beginWrite();
    if (!finish) return;
    setBusy(true);
    setDeleteError('');
    try {
      await api(path, { method: 'DELETE' });
      sheetApi.closeNow(() => { onRemoved(resource.resourceId); onUpdated(); });
    } catch (reason) {
      setDeleteError(T32.saveFail('删除', errorText(reason)));
      setVersion(value => value + 1);
    } finally { setBusy(false); finish(); }
  };
  useServiceSheetExit(deleteId, () => setDeleteError(''));
  return <>
    <ServiceManagementRow name={resource.name} enabled={resource.enabled} busy={toggleBusy} disabled={write.busy || write.resuming || !report || (resource.enabled && !report.canDisable)} onChange={enabled => void toggle(enabled)}/>
    <ServiceUseRow entries={names} loading={!report} error={error}/>
    <ResourceUseDetails entries={entries} roles={roles} {...useActions} busy={write.busy || write.resuming}/>
    {useActions.error && <p role="alert">{useActions.error}</p>}
    <ServiceDeleteEntry id={deleteId} kind="model" disabled={busy || write.busy || !canWrite || !report?.canDelete} activeNames={activeUsers.map(item => item.name)}
      blocker={report && !report.canDelete ? '资源仍在使用，请查看占用详情。' : undefined}/>
    <ServiceDeleteSheet id={deleteId} active={active} name={resource.name} occupied={names} busy={busy} disabled={!report?.canDelete || activeUsers.length > 0} error={deleteError} onRemove={() => void remove()}/>
  </>;
}

function sameExtensionEnv(next: Record<string, string>, saved: unknown): boolean {
  const baseline = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  const keys = Object.keys(next);
  return keys.length === Object.keys(baseline).length && keys.every(key => Object.hasOwn(baseline, key) && baseline[key] === next[key]);
}

function ExtensionManagement({ resource, onConfigure, roles, activities, active, onRemoved, onUpdated }: { resource: Resource; onConfigure?: () => void; roles: RoleListItem[]; activities: Activity[]; active: boolean; onRemoved: (id: string) => void; onUpdated: (resource?: Resource) => void }) {
  const [report, setReport] = useState<ResourceReferences | null>(null);
  const [reportError, setReportError] = useState('');
  const sheetApi = useSheet();
  const write = useWrite();
  const savedRef = useRef(resource);
  useEffect(() => { savedRef.current = resource; }, [resource]);
  const [name, setName] = useState(resource.name);
  const [command, setCommand] = useState(String(resource.config.command || ''));
  const [args, setArgs] = useState(Array.isArray(resource.config.args) ? resource.config.args.join('\n') : '');
  const [env, setEnv] = useState(JSON.stringify(resource.config.env || {}, null, 2));
  const [sourcePath, setSourcePath] = useState(String(resource.config.sourcePath || ''));
  const [busy, setBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [version, setVersion] = useState(0);
  const useActions = useResourceUseActions(resource.resourceId, roles, () => { setVersion(value => value + 1); onUpdated(); });
  useEffect(() => {
    if (!active) return;
    let live = true; setReport(null); setReportError('');
    api<ResourceReferences>(`/v1/resources/${encodeURIComponent(resource.resourceId)}/references`).then(value => { if (live) setReport(value); }).catch(error => { if (live) setReportError(errorText(error)); });
    return () => { live = false; };
  }, [active, resource.resourceId, version]);
  const sheetId = `extension-form:${resource.resourceId}`;
  const deleteId = `extension-delete:${resource.resourceId}`;
  const isMcp = resource.kind === 'mcp';
  const kind = isMcp ? 'mcp' : 'skill';
  const variables = parseExtensionEnv(env);
  const invalid = !name.trim() ? T10.name : isMcp ? !command.trim() ? T10.command : variables ? '' : T10.env : !sourcePath.trim() ? T10.source : '';
  const argsText = Array.isArray(resource.config.args) ? resource.config.args.join('\n') : '';
  const envSaved = JSON.stringify(resource.config.env || {}, null, 2);
  const envChanged = variables ? !sameExtensionEnv(variables, resource.config.env) : env !== envSaved;
  const connectionChanges = isMcp ? [command.trim() !== String(resource.config.command || ''), args !== argsText, envChanged] : [];
  const count = [name.trim() !== resource.name, ...connectionChanges, !isMcp && sourcePath.trim() !== String(resource.config.sourcePath || '')].filter(Boolean).length;
  const entries = (report?.references ?? []).filter(item => item.reason !== 'ROLE_BINDING' || item.bindingEnabled);
  const users = referenceUsers(entries, roles, activities, () => '已开启');
  const activeUsers = users.filter(item => item.state !== 'stopped');
  const names = users.map(item => `${item.name} · ${item.usages.join('、')}`);
  const pauseNames = connectionChanges.some(Boolean) ? activeUsers.map(item => item.name) : [];
  const path = `/v1/resources/${encodeURIComponent(resource.resourceId)}`;
  const run = async (operation: 'save' | 'enable' | 'disable' | 'delete') => {
    if (busy || !report || (operation === 'save' && (!report.canUpdate || invalid || !count)) || (operation === 'disable' && !report.canDisable) || (operation === 'delete' && (!report.canDelete || activeUsers.length))) return;
    if (operation === 'enable' || operation === 'disable') {
      setToggleBusy(true);
      const enabled = operation === 'enable';
      const feedback = captureSavedSummary();
      const result = await write.runWrite({
        roleIds: enabled ? [] : activeUsers.map(item => item.roleId), verb: enabled ? '启用' : '停用', toggle: true, announceSuccess: false,
        commit: async () => {
          const updated = await api<Resource>(path, { method: 'PATCH', body: { enabled } });
          onUpdated(updated);
          setVersion(value => value + 1);
          feedback();
        },
      });
      if (result.ok) write.reportResult(`${resource.name} ${enabled ? '已全局启用' : '已全局停用'}`);
      else if (result.failure.message) write.reportFailure(result.failure.message);
      setToggleBusy(false);
      return;
    }
    const finish = write.beginWrite();
    if (!finish) return;
    setBusy(true);
    setDeleteError('');
    setWriteError('');
    try {
      if (operation === 'delete') {
        await api(path, { method: 'DELETE' });
        sheetApi.closeNow(() => { onRemoved(resource.resourceId); onUpdated(); });
        return;
      }
      const config = isMcp
        ? { ...resource.config, command: command.trim(), args: args === argsText ? resource.config.args : args ? args.split('\n') : [], env: variables }
        : { ...resource.config, sourcePath: sourcePath.trim(), description: sourcePath.trim() === resource.config.sourcePath ? resource.config.description : undefined };
      const updated = await api<Resource>(path, { method: 'PATCH', body: { name: name.trim(), config } });
      savedRef.current = updated;
      sheetApi.closeNow(undefined, `${updated.name} 已保存`);
      onUpdated(updated);
    } catch (error) {
      if (operation === 'delete') setDeleteError(T32.saveFail('删除', errorText(error)));
      else setWriteError(T32.saveFail('保存', errorText(error)));
    } finally { setVersion(value => value + 1); setBusy(false); finish(); }
  };
  useServiceSheetExit(deleteId, () => setDeleteError(''));
  const open = (group?: string, trigger?: HTMLElement) => sheetApi.open({ id: sheetId, title: group ? `${resource.name} · ${group}` : `编辑「${resource.name}」`, shape: group ? 'compact' : 'full', group, anchor: trigger?.closest<HTMLElement>('.config-sum') ?? trigger, focusReturn: trigger?.matches('button') ? trigger : trigger?.querySelector<HTMLElement>('.config-sum-edit') });
  const discard = () => {
    const saved = savedRef.current;
    setName(saved.name); setCommand(String(saved.config.command || '')); setArgs(Array.isArray(saved.config.args) ? saved.config.args.join('\n') : '');
    setEnv(JSON.stringify(saved.config.env || {}, null, 2)); setSourcePath(String(saved.config.sourcePath || '')); setWriteError('');
  };
  const address = isMcp ? `stdio · ${String(resource.config.command || '')}` : String(resource.config.sourcePath || '');
  const envKeys = Object.keys((resource.config.env || {}) as Record<string, unknown>);
  return <div hidden={!active} className="config-prose">
    <ServiceHeading title={resource.name} address={address} enabled={resource.enabled} onEdit={trigger => open(undefined, trigger)}/>
    {onConfigure && <div className="config-actions"><Button size="sm" onClick={onConfigure}>去角色配置启用</Button></div>}
    {isMcp && active && <SavedMcpProbe key={version} resourceId={resource.resourceId} enabled={resource.enabled}/>}
    {isMcp ? <><ServiceRow label="启动" value={`${String(resource.config.command || '')} ${argsText.replaceAll('\n', ' ')}`.trim()} keys={['stdio']} onOpen={trigger => open('启动', trigger)}/><ServiceRow label="环境变量" value={envKeys.join('、') || '无'} status={envKeys.length ? 'ok' : 'none'} statusText={envKeys.length ? '值已保存' : '未设置'} onOpen={trigger => open('环境变量', trigger)}/></> : <ServiceRow label="来源目录" value={String(resource.config.sourcePath || '')} onOpen={trigger => open('来源目录', trigger)}/>}
    <ServiceManagementRow name={resource.name} enabled={resource.enabled} busy={toggleBusy} disabled={write.busy || write.resuming || !report || (resource.enabled && !report.canDisable)} onChange={enabled => void run(enabled ? 'enable' : 'disable')}/>
    <ServiceUseRow entries={names} loading={!report} error={reportError}/>
    <ResourceUseDetails entries={entries} roles={roles} {...useActions} busy={write.busy || write.resuming}/>
    <ServiceDeleteEntry id={deleteId} kind={kind} disabled={busy || write.busy || !report?.canDelete} activeNames={activeUsers.map(item => item.name)}
      blocker={report && !report.canDelete ? '资源仍在使用，请查看占用详情。' : undefined}/>
    {useActions.error && <p role="alert">{useActions.error}</p>}
    <ServiceSheet id={sheetId} active={active} count={count} busy={busy} onDiscard={discard}
      footer={<ServiceSheetActions count={count} busy={busy} invalid={invalid} blockedReason={report ? !report.canUpdate ? '请先解除正在使用的绑定或任务。' : undefined : reportError || '正在检查占用…'} error={writeError} pauseNames={pauseNames} onSubmit={() => void run('save')}/>}>
      {group => <><ExtensionFields kind={kind} group={group} name={name} onName={setName} command={command} onCommand={setCommand} args={args} onArgs={setArgs} env={env} onEnv={setEnv} source={sourcePath} onSource={setSourcePath} busy={busy}/></>}
    </ServiceSheet>
    <ServiceDeleteSheet id={deleteId} active={active} name={resource.name} occupied={names} busy={busy} disabled={!report?.canDelete || activeUsers.length > 0} error={deleteError} onRemove={() => void run('delete')}/>
  </div>;
}
