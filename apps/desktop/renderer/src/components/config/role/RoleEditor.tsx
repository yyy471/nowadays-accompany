import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../../api';
import { errorText } from '../../../lib/error-text';
import type { Outfit, RoleDetail } from '../../../types';
import { Button, Field, Icon, Input, Select, StatusDot, Switch, Textarea, announceLive, readMotionTime, readMotionValue } from '../../../ui';
import { AppearancePanel } from '../../appearance/AppearancePanel';
import { useSheet } from '../sheet/sheet-context';
import { useWrite } from '../write-runner';
import { RoleSheetHost } from './RoleSheetHost';
import { WorldbooksPanel } from './WorldbooksPanel';
import { WorkspaceNotesPanel } from './WorkspaceNotesPanel';
import { ProbeFeedback } from '../ProbeFeedback';
import { Sheet } from '../sheet/Sheet';
import { chatRowStatus, memoryRowStatus, quotaLimitBad, rowDotVisible } from '../summary';
import { MediaStateRow, RoleSaveActions, type MediaSummaryStatus } from '../MediaSheet';
import { T1, T2, T6, T19, T23, T25, T28, T29, T33, T34, T36 } from '../config-texts';
import { VoicePanel } from '../../voice/VoicePanel';
import { ImagePanel } from '../../image/ImagePanel';
import { ModelNamePicker } from '../../model/ModelNamePicker';
import { useModelProbe } from '../../model/use-model-probe';
import { modelAdapterOf, modelPresets, visibleProbeNotice } from '../../model/model-picker';
import { providerCacheKey } from '../../model/model-cache';
import { mergeBindingDrafts } from '../../model/binding-merge';
import { isCommandMcp, COMMAND_MCP_RISK } from '../extension-import';
import { shouldDefaultEnableOnChatBind } from '../role-write-tier';
import type { ConfigDraftState } from '../../config-draft';
import {
  RoleDeleteEntry,
  modelAdapterLabel,
  savedModelNameOf,
  type Activity,
  type Binding,
  type Draft,
  type OpenSettingsOptions,
  type Resource,
  type RoleEditorState,
  type RoleSection,
  type SettingsSection,
} from '../settings-shared';

export function RoleEditor({ roleId, roleCount, active, activity, activityLoading = false, voiceServiceVersion = 0, voiceServiceEpochs = {}, imageServiceVersion = 0, imageServiceEpochs = {}, section, draft, setDraft, resources, removedResources, resourceError, onEditorState, onOpenSettings, onStartConversation, onPreviewOutfit, onPreviewAsset, onClearPreview, onDeleted, onRefresh, onChangeSection }: { roleId: string; roleCount: number; active: boolean; activity?: Activity; activityLoading?: boolean; voiceServiceVersion?: number; voiceServiceEpochs?: Record<string, number>; imageServiceVersion?: number; imageServiceEpochs?: Record<string, number>; section: RoleSection; draft?: Draft; setDraft: (draft: Draft) => void; resources: Resource[]; removedResources: string[]; resourceError: string; onEditorState: (roleId: string, state: RoleEditorState | null) => void; onOpenSettings: (section: SettingsSection, options?: OpenSettingsOptions) => void; onStartConversation?: (roleId: string) => void; onPreviewOutfit: (outfit: Outfit) => void; onPreviewAsset: (assetId: string) => void; onClearPreview: () => void; onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void>; onRefresh: () => Promise<void>; onChangeSection: (section: RoleSection) => void }) {

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
  const saveBindings = async (scope: 'models' | 'ext', options?: { enableAfterSave?: boolean }) => {
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
      // 首次绑定对话模型：保存后直接恢复活动，省掉手动「恢复活动」。
      if (scope === 'models' && options?.enableAfterSave === true && activity?.state === 'stopped'
        && result.items.some(item => item.capability === 'chat_model' && item.enabled)) {
        try {
          await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, { method: 'POST' });
        } catch (error) {
          sheetApi.closeNow(undefined, `已保存模型选择，但角色未启用：${errorText(error)}`);
          return;
        }
        write.forgetPaused(roleId);
        await onRefresh().catch(() => { /* 绑定与启用已完成，列表同步失败由工作区提示。 */ });
        sheetApi.closeNow(undefined, '已保存模型选择并启用角色');
        return;
      }
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
      const result = await api<NonNullable<typeof budget>>(`/v1/roles/${encodeURIComponent(roleId)}/autonomy/budget`, { method: 'PUT', body });
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
      <ModelSheetHost active={active && section === 'models'} draft={modelDraft} setDraft={setModelDraft} resources={resources} bindings={bindings} loaded={bindingLoaded} notice={bindingNotice} error={bindingError} chatProbe={chatProbe} memoryProbe={memoryProbe} chatKey={chatKey} memoryKey={memoryKey} onOpenSettings={onOpenSettings} pause={activity?.state !== "stopped"} canEnableAfterSave={activity?.state === 'stopped' && !savedChat} busy={bindingBusy} onReload={needsBindingRead ? reloadBindings : undefined} onSave={saveBindings}/>
      {loaded.image && <ImagePanel roleId={roleId} active={active && section === 'models'} serviceRefreshVersion={imageServiceVersion} serviceEpochs={imageServiceEpochs} outfitRefreshVersion={lookVersion} onOpenImageSettings={target => sheetApi.requestClose(() => onOpenSettings('model', { modelKind: 'image', ...(target?.serviceId ? { resourceId: target.serviceId } : {}), ...(target?.createNew ? { newImageService: true } : {}) }))} guardWrite={async action => action()} pausedWrite={false} onSummaryStatus={setImageSummary} onDraftStateChange={setImageDraft} onChanged={() => { void onRefresh(); }}/>}
      {loaded.voice && <VoicePanel roleId={roleId} active={active && section === 'models'} serviceRefreshVersion={voiceServiceVersion} serviceEpochs={voiceServiceEpochs} onOpenVoiceSettings={target => sheetApi.requestClose(() => onOpenSettings('model', { modelKind: 'voice', ...(target?.serviceId ? { resourceId: target.serviceId } : {}), ...(target?.createNew ? { newVoiceService: true } : {}) }))} guardWrite={guardAction} pausedWrite={activity?.state !== 'stopped'} onSummaryStatus={setVoiceSummary} onDraftStateChange={setVoiceDraft} onChanged={() => { void onRefresh(); }}/>}
    </div>
    <div hidden={!active || section !== 'ext'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>扩展</h2></header>
      <WorldbooksPanel roleId={roleId} active={active && section === 'ext'} pausedWrite={false} guardWrite={async action => action()} onDraftChange={setWorldbookDraft}/>
      {bindingAlert}
      {!firstReadError && (['mcp','skill'] as const).map(kind => <ExtensionRow key={kind} kind={kind} resources={resources.filter(item => item.kind === kind)} draft={extensionDraft} bindings={bindings} loaded={bindingLoaded} busy={bindingBusy || !bindingRevision || !!resourceError} onOpen={trigger => openExtension(kind, trigger)}/>)}
      {bindingNotice && <p role="status">{bindingNotice}</p>}
      <ExtSheetHosts active={active && section === 'ext'} resources={resources} draft={extensionDraft} setDraft={setExtensionDraft} bindings={bindings} loaded={bindingLoaded} notice={bindingNotice} error={bindingError} pause={activity?.state !== "stopped"} busy={bindingBusy} onReload={needsBindingRead ? reloadBindings : undefined} onSave={saveBindings} onManage={onOpenSettings}/>
      <WorkspaceNotesPanel roleId={roleId} active={active && section === 'ext'}/>
    </div>
    <div hidden={!active || section !== 'quota'} className="config-prose"><header className="config-sec-head"><h2 tabIndex={-1}>自主额度</h2></header>
      {budget ? <><div className="config-sum" data-edit="quota" onClick={event => openQuota(event.currentTarget.querySelector<HTMLElement>('.config-sum-edit') ?? event.currentTarget)}>
        <span className="config-sum-name"><strong>今日</strong></span>
        <span className="config-sum-val"><b>今日已用 {budget.usedPoints} / {budget.unlimited ? '不限' : budget.dailyLimit} 点</b><span className="config-sum-keys"><span>{budget.unlimited ? '不限额' : `每日 ${budget.dailyLimit} 点`}</span><span>{budget.localDate}</span><span>本机 00:00 重置</span></span></span>
        <span className="config-sum-end"><StatusDot status="ok" label="生效中" bare faint/><span className="config-sum-slot"><button type="button" className="config-sum-edit" onClick={event => { event.stopPropagation(); openQuota(event.currentTarget); }} aria-label="编辑今日额度"><Icon name="edit" size={13}/>编辑</button><span className="config-sum-slot-ghost" aria-hidden="true"><Icon name="edit" size={13}/>编辑</span></span></span>
      </div>
      <QuotaSheetHost active={active && section === 'quota'} budget={budget} draft={budgetDraft} setDraft={setBudgetDraft} notice={budgetNotice} error={budgetError} pause={false} busy={budgetBusy} onSave={saveBudget}/></> : <MediaStateRow label="自主额度" loading={!budgetError} error={budgetError} onRetry={() => setBudgetRead(previous => previous + 1)}/>}
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
            {list.map(item => { const commandRisk = item.kind === 'mcp' && isCommandMcp(item.config); return <div className="config-toggle-row" data-unavailable={!item.enabled || undefined} key={item.resourceId}
              data-located={sheet?.resourceId === item.resourceId || undefined}
              data-sheet-focus={sheet?.resourceId === item.resourceId || undefined}
              tabIndex={sheet?.resourceId === item.resourceId ? 0 : undefined}
              onFocus={event => { if (sheet?.resourceId === item.resourceId) event.currentTarget.scrollIntoView({ block: 'nearest' }); }}>
              <span><strong>{item.name}</strong>{typeof item.config.description === 'string' && item.config.description && <small>{item.config.description}</small>}{commandRisk && <small id={`extension-risk-${item.resourceId}`}>{COMMAND_MCP_RISK}</small>}{!item.enabled && <small id={`extension-disabled-${item.resourceId}`}>{T33.switchNote}</small>}</span>
              <Switch checked={!!draft[item.resourceId]} disabled={!item.enabled || !loaded} aria-describedby={[commandRisk && `extension-risk-${item.resourceId}`, !item.enabled && `extension-disabled-${item.resourceId}`].filter(Boolean).join(' ') || undefined} label={`为角色开启${item.name}`} onCheckedChange={checked => setDraft({ ...draft, [item.resourceId]: checked })}/>
            </div>; })}
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
function ModelSheetHost({ active, draft, setDraft, resources, bindings, loaded, notice, error, chatProbe, memoryProbe, chatKey, memoryKey, onOpenSettings, pause, canEnableAfterSave = false, busy, onReload, onSave }: {
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
  /** 停机且从未保存过对话模型：首次绑定默认「保存并立即启用角色」。 */
  canEnableAfterSave?: boolean;
  busy: boolean;
  onReload?: () => Promise<void>;
  onSave: (scope: 'models' | 'ext', options?: { enableAfterSave?: boolean }) => Promise<void>;
}) {
  const { sheet, requestClose, setDirty, setBusy, discardToken, closedId } = useSheet();
  const kind = active && sheet !== null && sheet.id.startsWith('model:') ? (sheet.id.startsWith('model:chat') ? 'chat' : 'memory') : null;
  const group = kind === 'chat' ? (sheet?.id === 'model:chat:test' ? 'test' : sheet?.id === 'model:chat:service' ? 'service' : null) : null;
  const defaultEnableAfterSave = shouldDefaultEnableOnChatBind({
    activityState: canEnableAfterSave ? 'stopped' : 'active',
    hasSavedChat: !canEnableAfterSave,
  });
  // 未触碰时跟随默认勾选；每次打开对话纸笺重新回到默认。
  const [enableAfterSave, setEnableAfterSave] = useState<boolean | null>(null);
  const openedChatId = useRef<string | null>(null);
  useEffect(() => {
    const id = sheet?.id ?? null;
    if (!id || !id.startsWith('model:chat')) { openedChatId.current = null; return; }
    if (openedChatId.current === id) return;
    openedChatId.current = id;
    setEnableAfterSave(null);
  }, [sheet?.id]);
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
  const canBindAndEnable = kind === 'chat' && canEnableAfterSave && !!resourceId && !missing && !!modelName.trim();
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
      {canBindAndEnable && <label className="config-sheet-check"><input type="checkbox" disabled={busy} checked={enableAfterSave ?? defaultEnableAfterSave} onChange={event => setEnableAfterSave(event.target.checked)} /> 保存并立即启用角色</label>}
    </div>
  </div>;
  return <Sheet idPrefix="model:" enabled={active} footer={<RoleSaveActions count={count} pause={pause} busy={busy} invalid={!loaded || !!onReload || Boolean(resourceId && !modelName.trim())} error={error} onSave={() => void onSave('models', canBindAndEnable ? { enableAfterSave: enableAfterSave ?? defaultEnableAfterSave } : undefined)}/>}>
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
