import { errorText } from '../lib/error-text';
import { ExtensionCreate } from '../components/config/ExtensionImport';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { api } from '../api';
import type { RoleDetail, RoleListItem } from '../types';
import { Field, Icon, Input, LiveAnnouncer, Select, StatusDot, readMotionTime, readMotionValue, useConfirm, useMotionPolicy } from '../ui';
import { readMotionPx, type MotionPreference } from '../ui/motion';
import { RolePortrait } from '../components/RolePortrait';
import { SheetProvider, type SheetContextValue } from '../components/config/sheet/sheet-context';
import { WriteProvider, WriteResultNotice, useWrite } from '../components/config/write-runner';
import { MediaGroup } from '../components/config/MediaSheet';
import {
  ServiceIndex,
  ServiceIndexState,
  serviceHost,
  serviceProbeNotice,
  serviceStatus,
  type ServiceIndexEntry,
  type ServiceKind,
} from '../components/config/ServiceParts';
import { sweepSavedElement } from '../components/config/sheet/save-feedback';
import { T6, T7, T10, T16, T26, T32 } from '../components/config/config-texts';
import { VoiceServiceCreate, VoiceServiceDetail } from '../components/voice/VoiceServiceEditor';
import { ImageServiceCreate, ImageServiceDetail, type ImageService } from '../components/image/ImageServiceEditor';
import { type VoiceServiceItem } from '../voice-config';
import { ModelNamePicker } from '../components/model/ModelNamePicker';
import { SecretInput } from '../components/model/SecretInput';
import { useModelProbe, type ModelProbeTarget } from '../components/model/use-model-probe';
import {
  hasVertexSafety,
  modelConnectionFields,
  modelCredentialScope,
  modelPresets,
  resolveModelBaseUrlOnProtocolChange,
  type VertexSafetyLevel,
} from '../components/model/model-picker';
import { providerCacheKey, writeModelCache } from '../components/model/model-cache';
import { savedImageModelOf } from '../image-config';
import { useThemePreset } from '../ui/presets';
import { ConfigThemeTransition } from '../ui/config-theme-transition';
import { TokenUsageSection } from '../components/config/TokenUsageSection';
import { EngineeringSection } from '../components/config/EngineeringSection';
import { MemoryEmbeddingGroup } from '../components/config/MemoryEmbeddingGroup';
import { isOrdinaryResource } from '../components/config/engineering-settings';
import {
  PausedRolesFooter,
  NewModelSheet,
  SettingsRefresh,
  ModelConnectionInputs,
  useModelAddress,
  savedModelNameOf,
  roleDisplayName,
  roleSections,
  settingSections,
  wideSection,
  type Activity,
  type ConfigNavigationGuard,
  type Draft,
  type OpenSettingsOptions,
  type Resource,
  type RoleDirty,
  type RoleEditorState,
  type RoleSection,
  type SettingsSection,
  type WorkspaceRequest,
} from '../components/config/settings-shared';
import { RoleEditor } from '../components/config/role/RoleEditor';
import { RoleFooterIdentity, RoleStatusCards, WorkspaceSheets } from '../components/config/RoleStatusSection';
import { ResourceDetail } from '../components/config/ResourceDetailSection';

export type { ConfigNavigationGuard, SettingsSection, WorkspaceRequest };

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
    // 分区用 hidden 切换，只聚焦当前可见的标题。
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
  const confirm = useConfirm();
  const leaveConfirmingRef = useRef(false);
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
      if (hasDrafts()) {
        if (leaveConfirmingRef.current) return;
        leaveConfirmingRef.current = true;
        void confirm({
          title: '放弃未保存的改动？',
          description: '还有改动没保存，要放弃修改并离开配置页吗？',
          confirmLabel: '放弃修改',
          cancelLabel: '继续编辑',
          tone: 'danger',
        }).then(accepted => {
          leaveConfirmingRef.current = false;
          if (!accepted) return;
          const leave = () => {
            editorActions.current.forEach(item => { if (Object.values(item.dirty).some(Boolean)) item.discard(); });
            proceed();
          };
          const currentController = sheetController.current;
          if (currentController?.sheet) currentController.discardNow(leave);
          else leave();
        });
        return;
      }
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
  }, [navigationGuard, confirm]);
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
    if (!workspaceRequest) return;
    if (handledWorkspaceKey.current === workspaceRequest.key) return;
    if (workspaceRequest.kind === 'settings') {
      if (page !== 'settings') return;
      handledWorkspaceKey.current = workspaceRequest.key;
      setNewModel(false);
      setNewExtension(null);
      setNewVoiceService(false);
      setNewImageService(false);
      if (workspaceRequest.modelKind) setModelKind(workspaceRequest.modelKind);
      setSettingsSection(workspaceRequest.section);
      focusSectionHeadingSoon();
      onWorkspaceRequestHandled?.(workspaceRequest.key);
      return;
    }
    if (page !== 'role-config') return;
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
    <h1 className="sr-only">{roleActive ? '角色配置' : '设置'}</h1>
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
          {settingsActive && settingsSection === 'roles' && <RoleStatusCards roles={roles} activities={activities} resources={resources} voiceServices={voiceServices} imageServices={imageServices} loading={!activityReady || activityRefreshing} error={activityError}
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
            <MemoryEmbeddingGroup active={settingsActive && settingsSection === 'local'} models={resources.filter(item => item.kind === 'model' && item.enabled).map(item => ({ resourceId: item.resourceId, name: item.name, protocol: typeof item.config?.protocol === 'string' ? item.config.protocol : undefined }))}/>
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
              }}/></div>{!window.nowadaysDesk?.isPackaged && <div><span>版本</span><b>{T26.version}</b></div>}
            </div></div></div>}

        </div>
        <footer className="config-leaf-foot" id="config-leaf-actions" data-empty={!roleActive || !dirtyScopes?.profile ? 'true' : undefined}><span className="config-leaf-foot-label">{roleActive && dirtyScopes?.profile ? roleSection === 'profile' ? T6.state(profileCounts[editId] ?? 0) : T7(['设定']) : ''}</span>{roleActive && dirtyScopes?.profile && roleSection !== 'profile' && <button type="button" className="config-sheet-link" onClick={() => changeSection('profile')}>回去保存</button>}</footer>
        {/* 工作区级纸笺（T37／新建角色）挂在右页内：与分区纸笺共用双层压暗、右页承载与外部点击关闭（R11-3）。 */}
        <WorkspaceSheets pendingSwitch={pendingSwitch} clearPendingSwitch={() => setPendingSwitch(null)} onSwitch={roleId => { editorActions.current.get(editId)?.discardProfile(); applyRoleAndFocus(roleId); }} onCreated={createFromSheet}/>
      </section>
    </div>
  </div></SheetProvider></WriteProvider>;
}
