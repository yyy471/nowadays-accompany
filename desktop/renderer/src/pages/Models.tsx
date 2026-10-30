import { useEffect, useMemo, useRef, useState } from 'react';
import { api, appVersion } from '../api';
import { errorMessage } from '../hooks';
import type { CapabilityId, ProviderDto, ProviderTestResult, ProvidersResponse } from '../types';
import { Button, Checkbox, ConfirmButton, ErrorNote, Field, Icon, Input, Select, Tag } from '../ui';
import { hashRevision } from '../lib/drafts/registry';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { MODEL_CAPABILITY_ROWS, type ServiceStatusMap } from '../lib/model-capabilities';
import type { ServiceWriteGuard } from '../lib/service-write-coordinator';
import { ProviderManager } from '../components/ProviderManager';

type SimpleDraft = {
  providerId: string;
  baseUrl: string;
  modelId: string;
  secret: string;
  adapterId: string;
  supportsTools: boolean;
  voice: string;
};
type SimpleSaveResponse = { ok: true; provider: ProviderDto };
type ModelsResponse = { ok: true; models: string[] };
type ValidateResponse = { ok: true; result: ProviderTestResult };
type RequestContext = { ticket: number; draft: string; provider: string | null };
const CAPABILITY_LABEL: Record<CapabilityId, string> = {
  chat: '文本模型',
  'image.understand': '视觉模型',
  'video.understand': '视频模型',
  'image.generate': '图片生成',
  'audio.generate': '语音生成'
};
const EMPTY_PROVIDERS: ProviderDto[] = [];

function adapterOptions(capability: CapabilityId): Array<{ id: string; label: string }> {
  const options = [{ id: 'openai-compatible-v1', label: 'OpenAI 兼容协议' }];
  if (capability === 'video.understand') options.push({ id: 'video-polling-v1', label: '视频轮询协议' });
  if (appVersion === 'dev') options.push({ id: 'fake-v1', label: '本地测试适配器' });
  return options;
}

function settingsModels(provider: ProviderDto): Partial<Record<CapabilityId, string>> {
  const options = provider.options as { settingsModels?: Partial<Record<CapabilityId, string>> } | undefined;
  return options?.settingsModels ?? {};
}

function candidateModels(provider: ProviderDto, capability: CapabilityId) {
  return provider.models.filter((model) => model.capabilities.includes(capability));
}

function resolveInitial(capability: CapabilityId, providers: ProviderDto[]): SimpleDraft {
  const marked = providers.flatMap((provider) => {
    const modelId = settingsModels(provider)[capability];
    return modelId && candidateModels(provider, capability).some((model) => model.id === modelId)
      ? [{ provider, modelId }]
      : [];
  });
  const compatible = providers.flatMap((provider) => candidateModels(provider, capability).map((model) => ({ provider, modelId: model.id })));
  const selected = marked.length === 1 ? marked[0] : marked.length === 0 && compatible.length === 1 ? compatible[0] : undefined;
  return {
    providerId: selected?.provider.id ?? '',
    baseUrl: selected?.provider.baseUrl ?? '',
    modelId: selected?.modelId ?? '',
    secret: '',
    adapterId: selected?.provider.adapterId ?? 'openai-compatible-v1',
    supportsTools: selected?.provider.models.find((model) => model.id === selected.modelId)?.supportsTools ?? false,
    voice: String(selected?.provider.models.find((model) => model.id === selected.modelId)?.parameters.voice ?? '')
  };
}

function origin(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}

function providerForDraft(draft: SimpleDraft, providers: ProviderDto[]): ProviderDto | undefined {
  return providers.find((provider) => provider.id === draft.providerId);
}

export function ModelsPage({
  data,
  error,
  refresh,
  onGoAccountModels,
  capability,
  writeGuard,
  onStatusChange,
  onBusyChange
}: {
  data?: ProvidersResponse;
  error?: string;
  refresh: () => Promise<unknown>;
  onGoAccountModels?: () => void;
  capability: CapabilityId;
  writeGuard: ServiceWriteGuard;
  onStatusChange?: (statuses: ServiceStatusMap) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const providers = data?.providers ?? EMPTY_PROVIDERS;
  const [drafts, setDrafts] = useState<Partial<Record<CapabilityId, SimpleDraft>>>({});
  const [baseline, setBaseline] = useState<Partial<Record<CapabilityId, string>>>({});
  const [modelsByCapability, setModelsByCapability] = useState<Partial<Record<CapabilityId, string[]>>>({});
  const [modelsFingerprint, setModelsFingerprint] = useState<Partial<Record<CapabilityId, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<CapabilityId, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<CapabilityId, string>>>({});
  const [notices, setNotices] = useState<Partial<Record<CapabilityId, string>>>({});
  const [requestNotices, setRequestNotices] = useState<Partial<Record<CapabilityId, string>>>({});
  const [sourceStale, setSourceStale] = useState<Partial<Record<CapabilityId, true>>>({});
  const [results, setResults] = useState<Partial<Record<CapabilityId, ProviderTestResult>>>({});
  const [resultsFingerprint, setResultsFingerprint] = useState<Partial<Record<CapabilityId, string>>>({});
  const [revealedSecrets, setRevealedSecrets] = useState<Partial<Record<CapabilityId, boolean>>>({});
  const [saveFeedback, setSaveFeedback] = useState<Partial<Record<CapabilityId, 'success' | 'error'>>>({});
  const [saveRevision, setSaveRevision] = useState<Partial<Record<CapabilityId, number>>>({});
  const [initialized, setInitialized] = useState(false);
  const providerFingerprint = useRef('');
  const previousProviderById = useRef(new Map<string, string>());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const requestTickets = useRef<Partial<Record<CapabilityId, number>>>({});
  const actionGates = useRef<Partial<Record<CapabilityId, string>>>({});

  useEffect(() => {
    if (!data) return;
    const fingerprint = JSON.stringify(providers);
    if (fingerprint === providerFingerprint.current) return;
    const firstLoad = !initialized;
    providerFingerprint.current = fingerprint;
    const nextProviderById = new Map(providers.map((provider) => [provider.id, JSON.stringify(provider)] as [string, string]));
    const nextDrafts = { ...drafts };
    const nextBaseline = { ...baseline };
    const nextSourceStale = { ...sourceStale };
    const staleRows = new Set<CapabilityId>();
    for (const row of MODEL_CAPABILITY_ROWS) {
      const old = drafts[row.id];
      const oldBaseline = baseline[row.id];
      const oldDirty = Boolean(old && (old.secret || (oldBaseline && JSON.stringify({ ...old, secret: '' }) !== oldBaseline)));
      if (!firstLoad && oldDirty) {
        if (old?.providerId && previousProviderById.current.get(old.providerId) !== nextProviderById.get(old.providerId)) {
          nextSourceStale[row.id] = true;
          staleRows.add(row.id);
        }
        continue;
      }
      delete nextSourceStale[row.id];
      const fresh = resolveInitial(row.id, providers);
      nextDrafts[row.id] = fresh;
      nextBaseline[row.id] = JSON.stringify(fresh);
    }
    setDrafts(nextDrafts);
    setBaseline(nextBaseline);
    setSourceStale(nextSourceStale);
    if (staleRows.size > 0) setNotices((current) => {
      const next = { ...current };
      for (const id of staleRows) delete next[id];
      return next;
    });
    setRequestNotices({});
    setErrors({});
    setModelsByCapability({});
    setModelsFingerprint({});
    setResults({});
    setResultsFingerprint({});
    previousProviderById.current = nextProviderById;
    if (firstLoad) setInitialized(true);
  }, [data, providers, initialized, baseline, drafts, sourceStale]);

  const dirtyCapabilities = useMemo(() => {
    const dirty = new Set<CapabilityId>();
    for (const row of MODEL_CAPABILITY_ROWS) {
      const draft = drafts[row.id];
      if (!draft) continue;
      const value = JSON.stringify({ ...draft, secret: '' });
      if (draft.secret.length > 0 || (baseline[row.id] !== undefined && baseline[row.id] !== value)) dirty.add(row.id);
    }
    return dirty;
  }, [drafts, baseline]);
  const hasBusyAction = Object.values(busy).some(Boolean);
  const dirtyProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of MODEL_CAPABILITY_ROWS) {
      if (!dirtyCapabilities.has(row.id)) continue;
      const providerId = drafts[row.id]?.providerId;
      if (providerId) ids.add(providerId);
    }
    return [...ids].sort();
  }, [dirtyCapabilities, drafts]);
  useEffect(() => { writeGuard.setIntents('models', dirtyProviderIds); }, [writeGuard.setIntents, dirtyProviderIds]);
  useEffect(() => () => { writeGuard.setIntents('models', []); }, [writeGuard.setIntents]);

  const statuses = useMemo<ServiceStatusMap>(() => {
    const next: ServiceStatusMap = {};
    for (const row of MODEL_CAPABILITY_ROWS) {
      if (!data) {
        next[row.id] = error
          ? { tone: 'bad', label: '读取失败', summary: '模型服务暂时不可用' }
          : { tone: 'idle', label: '读取中', summary: '正在读取模型服务' };
        continue;
      }
      const draft = drafts[row.id] ?? resolveInitial(row.id, providers);
      const provider = providerForDraft(draft, providers);
      const selected = provider?.models.find((model) => model.id === draft.modelId && model.capabilities.includes(row.id));
      const dirty = dirtyCapabilities.has(row.id);
      next[row.id] = dirty
        ? { tone: 'warn', label: '待保存', summary: '有未保存的修改' }
        : selected
          ? { tone: 'ok', label: '已配置', summary: `${provider?.id ?? draft.providerId} · ${selected.id}` }
          : { tone: 'idle', label: '未配置', summary: draft.providerId ? '已选择来源，待选择模型' : '尚未配置服务' };
    }
    return next;
  }, [data, error, drafts, providers, dirtyCapabilities]);

  useEffect(() => { onStatusChange?.(statuses); }, [statuses, onStatusChange]);
  useEffect(() => { onBusyChange?.(hasBusyAction); }, [hasBusyAction, onBusyChange]);

  const discardDrafts = (): void => {
    setDrafts((current) => {
      const next = { ...current };
      for (const row of MODEL_CAPABILITY_ROWS) {
        const stored = baseline[row.id];
        let base = resolveInitial(row.id, providers);
        if (stored) {
          try { base = JSON.parse(stored) as SimpleDraft; } catch { base = resolveInitial(row.id, providers); }
        }
        next[row.id] = { ...base, secret: '' };
      }
      return next;
    });
    setErrors({});
    setNotices({});
    setRequestNotices({});
    setSourceStale({});
    setModelsByCapability({});
    setModelsFingerprint({});
    setResults({});
    setResultsFingerprint({});
    setSaveFeedback({});
  };

  useDraftRegistration({
    id: 'models:services',
    owner: 'page',
    label: '模型服务设置',
    dirty: dirtyCapabilities.size > 0,
    busy: hasBusyAction,
    revision: hashRevision({ drafts, baseline }),
    discard: discardDrafts
  });

  const clearCapabilityState = (target: CapabilityId): void => {
    setErrors((current) => ({ ...current, [target]: undefined }));
    setNotices((current) => ({ ...current, [target]: undefined }));
    setRequestNotices((current) => ({ ...current, [target]: undefined }));
    setModelsByCapability((current) => ({ ...current, [target]: undefined }));
    setModelsFingerprint((current) => ({ ...current, [target]: undefined }));
    setResults((current) => ({ ...current, [target]: undefined }));
    setResultsFingerprint((current) => ({ ...current, [target]: undefined }));
    setSaveFeedback((current) => ({ ...current, [target]: undefined }));
  };
  const clearSourceStale = (target: CapabilityId): void => {
    setSourceStale((current) => {
      if (!current[target]) return current;
      const next = { ...current };
      delete next[target];
      return next;
    });
  };
  const beginAction = (target: CapabilityId, action: string): boolean => {
    if (actionGates.current[target]) return false;
    actionGates.current[target] = action;
    return true;
  };
  const endAction = (target: CapabilityId, action: string): void => {
    if (actionGates.current[target] === action) delete actionGates.current[target];
  };
  const captureRequest = (target: CapabilityId, draft: SimpleDraft): RequestContext => {
    const ticket = (requestTickets.current[target] ?? 0) + 1;
    requestTickets.current[target] = ticket;
    const provider = draft.providerId ? providers.find((item) => item.id === draft.providerId) : undefined;
    return { ticket, draft: JSON.stringify(draft), provider: draft.providerId ? JSON.stringify(provider ?? null) : null };
  };
  const requestCurrent = (target: CapabilityId, context: RequestContext): boolean =>
    requestTickets.current[target] === context.ticket;
  const requestStale = (target: CapabilityId, context: RequestContext): boolean => {
    const draft = draftsRef.current[target];
    const provider = draft?.providerId ? providersRef.current.find((item) => item.id === draft.providerId) : undefined;
    const providerChanged = draft?.providerId ? JSON.stringify(provider ?? null) !== context.provider : false;
    return JSON.stringify(draft ?? null) !== context.draft || providerChanged;
  };
  const markStaleRequest = (target: CapabilityId, message: string): void => {
    setRequestNotices((current) => ({ ...current, [target]: message }));
  };

  const updateDraft = (target: CapabilityId, update: Partial<SimpleDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [target]: { ...resolveInitial(target, providers), ...current[target], ...update }
    }));
    clearCapabilityState(target);
  };

  const chooseProvider = (target: CapabilityId, providerId: string): void => {
    const provider = providers.find((item) => item.id === providerId);
    const models = provider ? candidateModels(provider, target) : [];
    const marker = provider ? settingsModels(provider)[target] : undefined;
    const modelId = marker && models.some((model) => model.id === marker) ? marker : models.length === 1 ? models[0]!.id : '';
    setDrafts((current) => ({
      ...current,
      [target]: {
        providerId,
        baseUrl: provider?.baseUrl ?? '',
        modelId,
        secret: '',
        adapterId: provider?.adapterId ?? 'openai-compatible-v1',
        supportsTools: provider?.models.find((model) => model.id === modelId)?.supportsTools ?? false,
        voice: String(provider?.models.find((model) => model.id === modelId)?.parameters.voice ?? '')
      }
    }));
    clearCapabilityState(target);
    clearSourceStale(target);
  };

  const requestBody = (target: CapabilityId, draft: SimpleDraft, confirmCost = false) => ({
    ...(draft.providerId ? { providerId: draft.providerId } : {}),
    capability: target,
    baseUrl: draft.baseUrl.trim(),
    modelId: draft.modelId.trim(),
    ...(draft.secret ? { secret: draft.secret } : {}),
    adapterId: draft.adapterId,
    supportsTools: draft.supportsTools,
    parameters: target === 'audio.generate' ? { voice: draft.voice.trim() } : {},
    ...(confirmCost ? { confirmCost: true } : {})
  });

  const checkOriginCredential = (draft: SimpleDraft): string | undefined => {
    const provider = providerForDraft(draft, providers);
    if (provider?.credential.configured && origin(provider.baseUrl) !== origin(draft.baseUrl) && !draft.secret) {
      return '更换地址后请重新输入 API Key；旧凭据不会发送到新地址。';
    }
    return undefined;
  };

  const fetchModels = async (target: CapabilityId): Promise<void> => {
    const draft = drafts[target];
    if (!draft) return;
    const requestFingerprint = JSON.stringify(draft);
    const originError = checkOriginCredential(draft);
    if (originError) { setErrors((current) => ({ ...current, [target]: originError })); return; }
    if (!beginAction(target, 'models')) return;
    const context = captureRequest(target, draft);
    setBusy((current) => ({ ...current, [target]: 'models' }));
    setErrors((current) => ({ ...current, [target]: undefined }));
    setRequestNotices((current) => ({ ...current, [target]: undefined }));
    try {
      const response = await api<ModelsResponse>('/providers/models', {
        method: 'POST', body: JSON.stringify({ ...(draft.providerId ? { providerId: draft.providerId } : {}), baseUrl: draft.baseUrl.trim(), ...(draft.secret ? { secret: draft.secret } : {}) })
      });
      if (!requestCurrent(target, context)) return;
      if (requestStale(target, context)) {
        markStaleRequest(target, '服务配置已变化，模型列表已作废，请重新获取。');
        return;
      }
      setModelsByCapability((current) => ({ ...current, [target]: response.models }));
      setModelsFingerprint((current) => ({ ...current, [target]: requestFingerprint }));
      setRequestNotices((current) => ({
        ...current,
        [target]: response.models.length === 0
          ? '服务没有返回模型列表，可直接手动填写模型名。'
          : `已获取 ${response.models.length} 个模型，可在模型名中选择或手动输入。`
      }));
    } catch (requestError) {
      if (!requestCurrent(target, context)) return;
      if (requestStale(target, context)) {
        markStaleRequest(target, '服务配置已变化，本次模型读取已作废，请重新获取。');
        return;
      }
      setErrors((current) => ({ ...current, [target]: `${errorMessage(requestError)}；仍可手动填写模型名。` }));
    } finally {
      endAction(target, 'models');
      if (requestCurrent(target, context)) setBusy((current) => ({ ...current, [target]: undefined }));
    }
  };

  const validate = async (target: CapabilityId): Promise<void> => {
    const draft = drafts[target];
    if (!draft || !draft.baseUrl.trim() || !draft.modelId.trim()) return;
    const originError = checkOriginCredential(draft);
    if (originError) { setErrors((current) => ({ ...current, [target]: originError })); return; }
    if (sourceStale[target]) { markStaleRequest(target, '服务配置已变化，请使用最新服务信息后再测试。'); return; }
    if (!beginAction(target, 'validate')) return;
    const context = captureRequest(target, draft);
    setBusy((current) => ({ ...current, [target]: 'validate' }));
    setErrors((current) => ({ ...current, [target]: undefined }));
    setNotices((current) => ({ ...current, [target]: undefined }));
    setRequestNotices((current) => ({ ...current, [target]: undefined }));
    setResults((current) => ({ ...current, [target]: undefined }));
    setResultsFingerprint((current) => ({ ...current, [target]: undefined }));
    setSaveFeedback((current) => ({ ...current, [target]: undefined }));
    const requestFingerprint = JSON.stringify(draft);
    try {
      const response = await api<ValidateResponse>('/providers/validate', {
        method: 'POST', body: JSON.stringify(requestBody(target, draft, true))
      });
      if (!requestCurrent(target, context)) return;
      if (requestStale(target, context)) {
        markStaleRequest(target, '服务配置已变化，本次测试结果已作废，请重新测试。');
        return;
      }
      setResults((current) => ({ ...current, [target]: response.result }));
      setResultsFingerprint((current) => ({ ...current, [target]: requestFingerprint }));
      setRequestNotices((current) => ({ ...current, [target]: response.result.ok ? '测试请求成功；配置尚未保存。' : response.result.detail ?? '测试请求失败。' }));
    } catch (requestError) {
      if (!requestCurrent(target, context)) return;
      if (requestStale(target, context)) {
        markStaleRequest(target, '服务配置已变化，本次测试已作废，请重新测试。');
        return;
      }
      setErrors((current) => ({ ...current, [target]: errorMessage(requestError) }));
    } finally {
      endAction(target, 'validate');
      if (requestCurrent(target, context)) setBusy((current) => ({ ...current, [target]: undefined }));
    }
  };

  const save = async (target: CapabilityId): Promise<void> => {
    const draft = drafts[target];
    if (!draft || !draft.baseUrl.trim() || !draft.modelId.trim()) return;
    const originError = checkOriginCredential(draft);
    if (originError) { setErrors((current) => ({ ...current, [target]: originError })); return; }
    if (sourceStale[target]) { markStaleRequest(target, '服务配置已变化，请使用最新服务信息后再保存。'); return; }
    if (!beginAction(target, 'save')) return;
    const providerId = draft.providerId;
    const lock = providerId && Object.hasOwn(writeGuard.locks, providerId) ? writeGuard.locks[providerId] : undefined;
    const writer = providerId && Object.hasOwn(writeGuard.writes, providerId) ? writeGuard.writes[providerId] : undefined;
    if (providerId && ((lock && lock !== 'models') || (writer && writer !== 'models'))) {
      setRequestNotices((current) => ({ ...current, [target]: '该服务在高级管理中有未保存修改或正在写入，请先处理高级草稿。' }));
      endAction(target, 'save');
      return;
    }
    let claimed = '';
    let context: RequestContext | undefined;
    try {
      if (providerId) {
        if (!writeGuard.begin(providerId, 'models')) {
          setRequestNotices((current) => ({ ...current, [target]: '该服务正在被其他编辑保存，请稍后再试。' }));
          return;
        }
        claimed = providerId;
      }
      context = captureRequest(target, draft);
      setBusy((current) => ({ ...current, [target]: 'save' }));
      setErrors((current) => ({ ...current, [target]: undefined }));
      setNotices((current) => ({ ...current, [target]: undefined }));
      setRequestNotices((current) => ({ ...current, [target]: undefined }));
      setSaveFeedback((current) => ({ ...current, [target]: undefined }));
      try {
        const response = await api<SimpleSaveResponse>('/providers/simple', {
          method: 'POST', body: JSON.stringify(requestBody(target, draft))
        });
        if (!requestCurrent(target, context)) return;
        if (requestStale(target, context)) {
          markStaleRequest(target, '保存请求已完成，但服务配置已变化；请刷新核对结果，没有自动重提。');
          await refresh();
          return;
        }
        const model = response.provider.models.find((item) => item.id === draft.modelId.trim());
        const saved: SimpleDraft = {
          ...draft,
          providerId: response.provider.id,
          baseUrl: response.provider.baseUrl,
          modelId: draft.modelId.trim(),
          secret: '',
          adapterId: response.provider.adapterId,
          supportsTools: model?.supportsTools ?? draft.supportsTools,
          voice: String(model?.parameters.voice ?? draft.voice)
        };
        setDrafts((current) => ({ ...current, [target]: saved }));
        setBaseline((current) => ({ ...current, [target]: JSON.stringify(saved) }));
        setNotices((current) => ({ ...current, [target]: '模型服务已保存。账号授权仍需在“账号使用”中单独设置。' }));
        setSaveFeedback((current) => ({ ...current, [target]: 'success' }));
        setSaveRevision((current) => ({ ...current, [target]: (current[target] ?? 0) + 1 }));
        clearSourceStale(target);
        await refresh();
      } catch (requestError) {
        if (!requestCurrent(target, context)) return;
        if (requestStale(target, context)) {
          markStaleRequest(target, '保存结果未确认且服务配置已变化；请刷新后核对，没有自动重提。');
          return;
        }
        setErrors((current) => ({ ...current, [target]: errorMessage(requestError) }));
        setSaveFeedback((current) => ({ ...current, [target]: 'error' }));
      }
    } finally {
      endAction(target, 'save');
      if (claimed) writeGuard.end(claimed, 'models');
      if (context && requestCurrent(target, context)) setBusy((current) => ({ ...current, [target]: undefined }));
    }
  };

  const activeRow = MODEL_CAPABILITY_ROWS.find((row) => row.id === capability) ?? MODEL_CAPABILITY_ROWS[0]!;
  const draft = drafts[activeRow.id] ?? resolveInitial(activeRow.id, providers);
  const activeProvider = providerForDraft(draft, providers);
  const compatible = providers.filter((provider) => candidateModels(provider, activeRow.id).length > 0);
  const selectedModel = activeProvider?.models.find((model) => model.id === draft.modelId && model.capabilities.includes(activeRow.id));
  const compatibleModels = providers.flatMap((provider) => candidateModels(provider, activeRow.id).map((model) => ({ provider, model })));
  const ambiguous = !draft.providerId && (compatible.length > 1 || compatibleModels.length > 1);
  const adapterChoices = adapterOptions(activeRow.id);
  const adapterKnown = adapterChoices.some((option) => option.id === draft.adapterId);
  const rowBusy = Boolean(busy[activeRow.id]);
  const draftFingerprint = JSON.stringify(draft);
  const rowDirty = dirtyCapabilities.has(activeRow.id);
  const rowStatus = rowDirty
    ? { tone: 'warn', label: '待保存' }
    : selectedModel
      ? { tone: 'ok', label: '已配置' }
      : { tone: 'idle', label: '未配置' };
  const datalistId = `model-options-${activeRow.id.replaceAll('.', '-')}`;
  const compatibleModelIds = activeProvider ? candidateModels(activeProvider, activeRow.id).map((model) => model.id) : [];
  const availableModelIds = [...new Set([...(modelsFingerprint[activeRow.id] === draftFingerprint ? modelsByCapability[activeRow.id] ?? [] : []), ...compatibleModelIds])];
  const activeResult = resultsFingerprint[activeRow.id] === draftFingerprint ? results[activeRow.id] : undefined;
  const activeSourceStale = Boolean(sourceStale[activeRow.id]);
  const guardProviderId = draft.providerId;
  const lockOwner = guardProviderId && Object.hasOwn(writeGuard.locks, guardProviderId) ? writeGuard.locks[guardProviderId] : undefined;
  const writeOwner = guardProviderId && Object.hasOwn(writeGuard.writes, guardProviderId) ? writeGuard.writes[guardProviderId] : undefined;
  const providerLocked = Boolean(guardProviderId && ((lockOwner && lockOwner !== 'models') || (writeOwner && writeOwner !== 'models')));
  const activeRequestNotice = requestNotices[activeRow.id];
  const displayNumber = String(MODEL_CAPABILITY_ROWS.findIndex((row) => row.id === activeRow.id) + 1).padStart(2, '0');
  const convertToNewProvider = (): void => {
    const target = activeRow.id;
    setDrafts((current) => ({
      ...current,
      [target]: { ...(current[target] ?? draft), providerId: '' }
    }));
    clearCapabilityState(target);
    clearSourceStale(target);
  };
  const applyLatestProvider = (): void => {
    const target = activeRow.id;
    if (!activeProvider) { convertToNewProvider(); return; }
    setDrafts((current) => ({
      ...current,
      [target]: { ...(current[target] ?? draft), baseUrl: activeProvider.baseUrl, adapterId: activeProvider.adapterId }
    }));
    clearSourceStale(target);
    setRequestNotices((current) => ({ ...current, [target]: undefined }));
  };

  return (
    <div className="model-service-page">
      {error ? <ErrorNote message={error} onRetry={() => void refresh()} /> : null}
      <section className="model-paper" aria-label={`${activeRow.title}配置`}>
        <header className="model-paper-head">
          <div>
            <div className="model-paper-heading"><span className="model-paper-serial">{displayNumber}</span><h2>{activeRow.title}</h2></div>
            <p>{activeRow.description}</p>
          </div>
          <div className="model-paper-meta"><Tag tone={rowStatus.tone}>{rowStatus.label}</Tag><span className="mono">{activeRow.id}</span></div>
        </header>
        {!data ? (
          error ? <div className="model-paper-empty"><p className="muted">模型服务暂不可用；仍可重试读取后继续编辑。</p></div>
            : <div className="model-paper-empty"><p className="muted">正在读取模型服务…</p></div>
        ) : (
          <div className="model-paper-body">
            {ambiguous ? <p className="notice notice-warn">检测到多个支持此能力的服务或模型。请选择来源和模型，或新建服务；不会自动绑定其中一个。</p> : null}
            <div className="model-paper-columns">
              <section className="model-paper-block" aria-label="服务接入">
                <h3 className="model-paper-label"><span>01</span>连接到模型服务</h3>
                <div className="model-paper-fields">
                  {providers.length > 0 ? <Field label="服务来源" hint="可沿用已有服务，也可新建；保存会保留原服务的其他模型与绑定。">
                    <Select value={draft.providerId} disabled={rowBusy} onChange={(event) => chooseProvider(activeRow.id, event.target.value)}>
                      <option value="">新建服务</option>
                      {providers.map((provider) => {
                        const models = candidateModels(provider, activeRow.id);
                        const label = models.length ? models.map((model) => model.id).join(', ') : '已有其他能力';
                        return <option key={provider.id} value={provider.id}>{provider.id} · {label} · {provider.baseUrl}</option>;
                      })}
                    </Select>
                  </Field> : null}
                  <Field label="服务地址" hint="填写服务提供的 API 基础地址；保留真实地址，不强制补 /v1。">
                    <Input value={draft.baseUrl} disabled={rowBusy} onChange={(event) => updateDraft(activeRow.id, { baseUrl: event.target.value })} placeholder="https://api.example.com/v1" autoComplete="url" />
                  </Field>
                  <Field label="API Key" hint={activeProvider?.credential.configured ? '已保存密钥不会回填；留空表示同地址保持现有密钥。' : '密钥由本地凭据库加密保存，界面不会回显。'} error={checkOriginCredential(draft)}>
                    <div className="model-secret-field">
                      <Input type={revealedSecrets[activeRow.id] ? 'text' : 'password'} value={draft.secret} disabled={rowBusy} onChange={(event) => updateDraft(activeRow.id, { secret: event.target.value })} placeholder={activeProvider?.credential.configured ? '已保存（留空保持）' : '输入 API Key'} autoComplete="new-password" />
                      <Button type="button" size="sm" variant="ghost" aria-pressed={Boolean(revealedSecrets[activeRow.id])} disabled={rowBusy} onClick={() => setRevealedSecrets((current) => ({ ...current, [activeRow.id]: !current[activeRow.id] }))}>{revealedSecrets[activeRow.id] ? '隐藏' : '显示'}</Button>
                    </div>
                  </Field>
                  <Field label="接入协议" hint={adapterKnown ? undefined : '当前适配器不在该能力的可用列表；保存前请选择支持此能力的适配器。'}>
                    <Select value={draft.adapterId} disabled={rowBusy} onChange={(event) => updateDraft(activeRow.id, { adapterId: event.target.value })}>
                      {!adapterKnown ? <option value={draft.adapterId}>{draft.adapterId || '未选择'}（当前适配器）</option> : null}
                      {adapterChoices.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                    </Select>
                  </Field>
                </div>
              </section>
              <section className="model-paper-block" aria-label="模型选择与测试">
                <h3 className="model-paper-label"><span>02</span>选择一个合适的模型</h3>
                <div className="model-paper-fields">
                  <Field label="模型名" hint="支持手动输入；也可尝试从服务获取候选列表。">
                    <div className="model-id-control">
                      <Input list={datalistId} value={draft.modelId} disabled={rowBusy} onChange={(event) => updateDraft(activeRow.id, { modelId: event.target.value })} placeholder="例如 model-name" />
                      <datalist id={datalistId}>{availableModelIds.map((model) => <option value={model} key={model} />)}</datalist>
                      <Button type="button" size="sm" variant="ghost" busy={busy[activeRow.id] === 'models'} disabled={rowBusy || activeSourceStale || !draft.baseUrl.trim()} onClick={() => void fetchModels(activeRow.id)}>获取模型</Button>
                    </div>
                  </Field>
                  {activeRow.id === 'chat' ? (
                    <label className="model-checkbox"><Checkbox checked={draft.supportsTools} disabled={rowBusy} onChange={(event) => updateDraft(activeRow.id, { supportsTools: event.target.checked })} /><span>该文本模型支持工具调用</span></label>
                  ) : null}
                  {activeRow.id === 'audio.generate' ? (
                    <Field label="默认音色" hint="工具本轮未指定音色时使用。">
                      <Input value={draft.voice} disabled={rowBusy} onChange={(event) => updateDraft(activeRow.id, { voice: event.target.value })} placeholder="例如 alloy" />
                    </Field>
                  ) : null}
                  {selectedModel && !activeRow.primary ? <p className="muted">该服务已声明模型能力：{selectedModel.capabilities.map((cap) => CAPABILITY_LABEL[cap]).join('、')}</p> : null}
                </div>
                <section className="model-test-block" aria-label="连通性测试">
                  <h4>连通性测试</h4>
                  <p className="muted">验证会实际调用服务，可能产生少量费用；不会保存，也不会发送 QQ。</p>
                  {activeResult?.sample?.kind === 'image' ? <img className="provider-test-image" src={`data:${activeResult.sample.mimeType};base64,${activeResult.sample.base64}`} alt="模型测试生成的图片" /> : null}
                  {activeResult?.sample?.kind === 'audio' ? <audio className="provider-test-audio" controls preload="metadata" src={`data:${activeResult.sample.mimeType};base64,${activeResult.sample.base64}`} /> : null}
                </section>
              </section>
            </div>
            {activeSourceStale ? <div className="notice notice-warn model-source-stale">
              <p>{activeProvider ? '此服务已在其他位置更新；当前草稿保留。使用最新地址和协议核对后再保存。' : '此服务已不存在；当前草稿保留。转为新建服务可保留地址、模型名和已填密钥，核对后再保存。'}</p>
              {activeProvider
                ? <Button type="button" size="sm" variant="ghost" onClick={applyLatestProvider}>使用最新服务信息</Button>
                : <Button type="button" size="sm" variant="ghost" onClick={convertToNewProvider}>转为新建服务</Button>}
            </div> : null}
            {providerLocked ? <p className="notice notice-warn">该服务在高级管理中有未保存修改或正在写入；请先保存或撤销高级草稿，再保存此能力。</p> : null}
            {errors[activeRow.id] ? <ErrorNote message={errors[activeRow.id]!} /> : null}
            {activeRequestNotice ?? notices[activeRow.id] ? <div className="notice" role="status">{activeRequestNotice ?? notices[activeRow.id]}</div> : null}
          </div>
        )}
        {data ? <footer className="model-paper-footer">
          <span className="model-test-cost-note"><Icon name="shield" size={15} />测试与保存彼此独立；测试不会保存配置。</span>
          <div className="model-paper-actions">
            {saveFeedback[activeRow.id] === 'success' && onGoAccountModels ? <Button disabled={hasBusyAction} onClick={onGoAccountModels}>去分配给账号</Button> : null}
            <ConfirmButton type="button" variant="ghost" busy={busy[activeRow.id] === 'validate'} disabled={rowBusy || activeSourceStale || !draft.baseUrl.trim() || !draft.modelId.trim()} onClick={() => void validate(activeRow.id)}>测试连接</ConfirmButton>
            <ConfirmButton type="button" variant="primary" busy={busy[activeRow.id] === 'save'} feedback={saveFeedback[activeRow.id]} feedbackKey={`${activeRow.id}:${saveRevision[activeRow.id] ?? 0}`} resultLabel="模型服务已保存" disabled={rowBusy || activeSourceStale || providerLocked || !draft.baseUrl.trim() || !draft.modelId.trim()} onClick={() => void save(activeRow.id)}>保存模型服务</ConfirmButton>
          </div>
        </footer> : null}
      </section>
      {data ? <div className="model-advanced"><ProviderManager providers={providers} refresh={refresh} writeGuard={writeGuard} onGoAccountModels={onGoAccountModels} /></div> : null}
      <p className="model-service-note"><Icon name="shield" size={15} /><span>服务配置只有在账号使用中授权并绑定后才会生效。模型服务、账号授权、AI 工具开放和本轮实际调用是彼此独立的设置。</span></p>
    </div>
  );
}
