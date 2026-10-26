import { useEffect, useMemo, useRef, useState } from 'react';
import { api, appVersion } from '../api';
import { errorMessage } from '../hooks';
import type { CapabilityId, ProviderDto, ProviderTestResult, ProvidersResponse } from '../types';
import { Button, Card, Checkbox, ConfirmButton, ControlButton, ErrorNote, Field, Icon, Input, Select, Tag } from '../ui';
import { hashRevision } from '../lib/drafts/registry';
import { useDraftRegistration } from '../lib/use-draft-registration';
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
type CapabilityRow = { id: CapabilityId; title: string; description: string; primary?: boolean };
type SimpleSaveResponse = { ok: true; provider: ProviderDto };
type ModelsResponse = { ok: true; models: string[] };
type ValidateResponse = { ok: true; result: ProviderTestResult };

const PRIMARY_ROWS: CapabilityRow[] = [
  { id: 'chat', title: '文本模型', description: '负责普通对话回复。', primary: true },
  { id: 'image.understand', title: '视觉模型', description: '理解图片附件；不会要求文本模型支持图像输入。', primary: true },
  { id: 'video.understand', title: '视频模型', description: '分析视频附件或短片段。', primary: true }
];
const EXTENSION_ROWS: CapabilityRow[] = [
  { id: 'image.generate', title: '图片生成', description: '作为可授权的对话工具按需调用。' },
  { id: 'audio.generate', title: '语音生成', description: '作为可授权的对话工具按需调用。' }
];
const ALL_ROWS = [...PRIMARY_ROWS, ...EXTENSION_ROWS];
const CAPABILITY_LABEL: Record<CapabilityId, string> = {
  chat: '文本模型',
  'image.understand': '视觉模型',
  'video.understand': '视频模型',
  'image.generate': '图片生成',
  'audio.generate': '语音生成'
};

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
  onGoAccountModels
}: {
  data?: ProvidersResponse;
  error?: string;
  refresh: () => Promise<unknown>;
  onGoAccountModels?: () => void;
}) {
  const providers = data?.providers ?? [];
  const [drafts, setDrafts] = useState<Partial<Record<CapabilityId, SimpleDraft>>>({});
  const [baseline, setBaseline] = useState<Partial<Record<CapabilityId, string>>>({});
  const [expanded, setExpanded] = useState<CapabilityId>();
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [modelsByCapability, setModelsByCapability] = useState<Partial<Record<CapabilityId, string[]>>>({});
  const [modelsFingerprint, setModelsFingerprint] = useState<Partial<Record<CapabilityId, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<CapabilityId, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<CapabilityId, string>>>({});
  const [notices, setNotices] = useState<Partial<Record<CapabilityId, string>>>({});
  const [results, setResults] = useState<Partial<Record<CapabilityId, ProviderTestResult>>>({});
  const [resultsFingerprint, setResultsFingerprint] = useState<Partial<Record<CapabilityId, string>>>({});
  const [initialized, setInitialized] = useState(false);
  const providerFingerprint = useRef('');
  const previousProviderById = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    const fingerprint = JSON.stringify(providers);
    if (fingerprint === providerFingerprint.current) return;
    const firstLoad = !initialized;
    providerFingerprint.current = fingerprint;
    const nextProviderById = Object.fromEntries(providers.map((provider) => [provider.id, JSON.stringify(provider)]));
    const nextDrafts = { ...drafts };
    const nextBaseline = { ...baseline };
    const nextNotices: Partial<Record<CapabilityId, string>> = {};
    for (const row of [...PRIMARY_ROWS, ...EXTENSION_ROWS]) {
      const old = drafts[row.id];
      const oldBaseline = baseline[row.id];
      const oldDirty = Boolean(old && (old.secret || (oldBaseline && JSON.stringify({ ...old, secret: '' }) !== oldBaseline)));
      if (!firstLoad && oldDirty) {
        if (old?.providerId && previousProviderById.current[old.providerId] !== nextProviderById[old.providerId]) {
          nextNotices[row.id] = nextProviderById[old.providerId]
            ? '此服务已在其他位置更新；当前草稿保留，请核对后再保存。'
            : '此服务已不存在；当前草稿保留，请重新选择来源或新建服务。';
        }
        continue;
      }
      const fresh = resolveInitial(row.id, providers);
      nextDrafts[row.id] = fresh;
      nextBaseline[row.id] = JSON.stringify(fresh);
    }
    setDrafts(nextDrafts);
    setBaseline(nextBaseline);
    if (Object.keys(nextNotices).length > 0) setNotices((current) => ({ ...current, ...nextNotices }));
    setModelsByCapability({});
    setModelsFingerprint({});
    setResults({});
    setResultsFingerprint({});
    previousProviderById.current = nextProviderById;
    if (firstLoad) setInitialized(true);
  }, [data, providers, initialized, baseline, drafts]);

  const dirtyCapabilities = useMemo(() => {
    const dirty = new Set<CapabilityId>();
    for (const row of ALL_ROWS) {
      const draft = drafts[row.id];
      if (!draft) continue;
      const value = JSON.stringify({ ...draft, secret: '' });
      if (draft.secret.length > 0 || (baseline[row.id] !== undefined && baseline[row.id] !== value)) dirty.add(row.id);
    }
    return dirty;
  }, [drafts, baseline]);
  const hasBusyAction = Object.values(busy).some(Boolean);

  const discardDrafts = (): void => {
    setDrafts((current) => {
      const next = { ...current };
      for (const row of ALL_ROWS) {
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
    setModelsByCapability({});
    setModelsFingerprint({});
    setResults({});
    setResultsFingerprint({});
  };

  useDraftRegistration({
    id: 'settings:models',
    owner: 'settings',
    label: '模型服务设置',
    dirty: dirtyCapabilities.size > 0,
    busy: hasBusyAction,
    revision: hashRevision({ drafts, baseline }),
    discard: discardDrafts
  });

  const updateDraft = (capability: CapabilityId, update: Partial<SimpleDraft>): void => {
    setDrafts((current) => ({
      ...current,
      [capability]: { ...resolveInitial(capability, providers), ...current[capability], ...update }
    }));
    setErrors((current) => ({ ...current, [capability]: undefined }));
    setNotices((current) => ({ ...current, [capability]: undefined }));
    setModelsByCapability((current) => ({ ...current, [capability]: undefined }));
    setModelsFingerprint((current) => ({ ...current, [capability]: undefined }));
    setResults((current) => ({ ...current, [capability]: undefined }));
    setResultsFingerprint((current) => ({ ...current, [capability]: undefined }));
  };

  const chooseProvider = (capability: CapabilityId, providerId: string): void => {
    const provider = providers.find((item) => item.id === providerId);
    const models = provider ? candidateModels(provider, capability) : [];
    const marker = provider ? settingsModels(provider)[capability] : undefined;
    const modelId = marker && models.some((model) => model.id === marker) ? marker : models.length === 1 ? models[0]!.id : '';
    setDrafts((current) => ({
      ...current,
      [capability]: {
        providerId,
        baseUrl: provider?.baseUrl ?? '',
        modelId,
        secret: '',
        adapterId: provider?.adapterId ?? 'openai-compatible-v1',
        supportsTools: provider?.models.find((model) => model.id === modelId)?.supportsTools ?? false,
        voice: String(provider?.models.find((model) => model.id === modelId)?.parameters.voice ?? '')
      }
    }));
    setErrors((current) => ({ ...current, [capability]: undefined }));
    setNotices((current) => ({ ...current, [capability]: undefined }));
    setModelsByCapability((current) => ({ ...current, [capability]: undefined }));
    setModelsFingerprint((current) => ({ ...current, [capability]: undefined }));
    setResults((current) => ({ ...current, [capability]: undefined }));
    setResultsFingerprint((current) => ({ ...current, [capability]: undefined }));
  };

  const requestBody = (capability: CapabilityId, draft: SimpleDraft, confirmCost = false) => ({
    ...(draft.providerId ? { providerId: draft.providerId } : {}),
    capability,
    baseUrl: draft.baseUrl.trim(),
    modelId: draft.modelId.trim(),
    ...(draft.secret ? { secret: draft.secret } : {}),
    adapterId: draft.adapterId,
    supportsTools: draft.supportsTools,
    parameters: capability === 'audio.generate' ? { voice: draft.voice.trim() } : {},
    ...(confirmCost ? { confirmCost: true } : {})
  });

  const checkOriginCredential = (draft: SimpleDraft): string | undefined => {
    const provider = providerForDraft(draft, providers);
    if (provider?.credential.configured && origin(provider.baseUrl) !== origin(draft.baseUrl) && !draft.secret) {
      return '更换地址后请重新输入 API Key；旧凭据不会发送到新地址。';
    }
    return undefined;
  };

  const fetchModels = async (capability: CapabilityId): Promise<void> => {
    const draft = drafts[capability];
    if (!draft) return;
    const requestFingerprint = JSON.stringify(draft);
    const originError = checkOriginCredential(draft);
    if (originError) { setErrors((current) => ({ ...current, [capability]: originError })); return; }
    setBusy((current) => ({ ...current, [capability]: 'models' }));
    setErrors((current) => ({ ...current, [capability]: undefined }));
    try {
      const response = await api<ModelsResponse>('/providers/models', {
        method: 'POST', body: JSON.stringify({ ...(draft.providerId ? { providerId: draft.providerId } : {}), baseUrl: draft.baseUrl.trim(), ...(draft.secret ? { secret: draft.secret } : {}) })
      });
      setModelsByCapability((current) => ({ ...current, [capability]: response.models }));
      setModelsFingerprint((current) => ({ ...current, [capability]: requestFingerprint }));
      setNotices((current) => ({
        ...current,
        [capability]: response.models.length === 0
          ? '服务没有返回模型列表，可直接手动填写模型名。'
          : `已获取 ${response.models.length} 个模型，可在模型名中选择或手动输入。`
      }));
    } catch (requestError) {
      setErrors((current) => ({ ...current, [capability]: `${errorMessage(requestError)}；仍可手动填写模型名。` }));
    } finally {
      setBusy((current) => ({ ...current, [capability]: undefined }));
    }
  };

  const validate = async (capability: CapabilityId): Promise<void> => {
    const draft = drafts[capability];
    if (!draft || !draft.baseUrl.trim() || !draft.modelId.trim()) return;
    const originError = checkOriginCredential(draft);
    if (originError) { setErrors((current) => ({ ...current, [capability]: originError })); return; }
    setBusy((current) => ({ ...current, [capability]: 'validate' }));
    setErrors((current) => ({ ...current, [capability]: undefined }));
    setNotices((current) => ({ ...current, [capability]: undefined }));
    setResults((current) => ({ ...current, [capability]: undefined }));
    setResultsFingerprint((current) => ({ ...current, [capability]: undefined }));
    const requestFingerprint = JSON.stringify(draft);
    try {
      const response = await api<ValidateResponse>('/providers/validate', {
        method: 'POST', body: JSON.stringify(requestBody(capability, draft, true))
      });
      setResults((current) => ({ ...current, [capability]: response.result }));
      setResultsFingerprint((current) => ({ ...current, [capability]: requestFingerprint }));
      setNotices((current) => ({ ...current, [capability]: response.result.ok ? '测试请求成功；配置尚未保存。' : response.result.detail ?? '测试请求失败。' }));
    } catch (requestError) {
      setErrors((current) => ({ ...current, [capability]: errorMessage(requestError) }));
    } finally {
      setBusy((current) => ({ ...current, [capability]: undefined }));
    }
  };

  const save = async (capability: CapabilityId): Promise<void> => {
    const draft = drafts[capability];
    if (!draft || !draft.baseUrl.trim() || !draft.modelId.trim()) return;
    const originError = checkOriginCredential(draft);
    if (originError) { setErrors((current) => ({ ...current, [capability]: originError })); return; }
    setBusy((current) => ({ ...current, [capability]: 'save' }));
    setErrors((current) => ({ ...current, [capability]: undefined }));
    setNotices((current) => ({ ...current, [capability]: undefined }));
    try {
      const response = await api<SimpleSaveResponse>('/providers/simple', {
        method: 'POST', body: JSON.stringify(requestBody(capability, draft))
      });
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
      setDrafts((current) => ({ ...current, [capability]: saved }));
      setBaseline((current) => ({ ...current, [capability]: JSON.stringify(saved) }));
      setNotices((current) => ({ ...current, [capability]: '模型服务已保存。账号授权仍需在“模型配置”中单独设置。' }));
      await refresh();
    } catch (requestError) {
      setErrors((current) => ({ ...current, [capability]: errorMessage(requestError) }));
    } finally {
      setBusy((current) => ({ ...current, [capability]: undefined }));
    }
  };

  const renderRow = (row: CapabilityRow) => {
    const draft = drafts[row.id] ?? resolveInitial(row.id, providers);
    const activeProvider = providerForDraft(draft, providers);
    const compatible = providers.filter((provider) => candidateModels(provider, row.id).length > 0);
    const selectedModel = activeProvider?.models.find((model) => model.id === draft.modelId && model.capabilities.includes(row.id));
    const compatibleModels = providers.flatMap((provider) => candidateModels(provider, row.id).map((model) => ({ provider, model })));
    const ambiguous = !draft.providerId && (compatible.length > 1 || compatibleModels.length > 1);
    const adapterChoices = adapterOptions(row.id);
    const adapterKnown = adapterChoices.some((option) => option.id === draft.adapterId);
    const summary = draft.providerId
      ? `${draft.baseUrl || '已选择来源'}${draft.modelId ? ` · ${draft.modelId}` : ''}`
      : ambiguous ? '有多个已有模型，请选择' : '尚未配置';
    const isExpanded = expanded === row.id;
    const rowBusy = Boolean(busy[row.id]);
    const draftFingerprint = JSON.stringify(draft);
    const rowDirty = dirtyCapabilities.has(row.id);
    const rowStatus = rowDirty
      ? { tone: 'warn', label: '待保存' }
      : selectedModel
        ? { tone: 'ok', label: '已配置' }
        : { tone: 'idle', label: '未配置' };
    const datalistId = `model-options-${row.id.replaceAll('.', '-')}`;
    const compatibleModelIds = activeProvider ? candidateModels(activeProvider, row.id).map((model) => model.id) : [];
    const availableModelIds = [...new Set([...(modelsFingerprint[row.id] === draftFingerprint ? modelsByCapability[row.id] ?? [] : []), ...compatibleModelIds])];
    return (
      <section className={`simple-model-row${isExpanded ? ' is-expanded' : ''}`} key={row.id}>
        <ControlButton type="button" className="simple-model-summary" aria-expanded={isExpanded} onClick={() => setExpanded(isExpanded ? undefined : row.id)}>
          <span className="simple-model-main"><strong>{row.title}</strong><small>{row.description}</small></span>
          <span className="simple-model-value">{summary}</span>
          <Tag tone={rowStatus.tone}>{rowStatus.label}</Tag>
          <Icon name="chevron" size={18} className={isExpanded ? 'rotate-180' : undefined} />
        </ControlButton>
        {isExpanded ? (
          <div className="simple-model-editor">
            {ambiguous ? <p className="notice notice-warn">检测到多个支持此能力的服务或模型。请选择来源和模型，或新建服务；不会自动绑定其中一个。</p> : null}
            <div className="model-fields">
              {providers.length > 0 ? <Field label="服务来源" hint="可沿用已有服务，也可新建；保存会保留原服务的其他模型与绑定。">
                <Select value={draft.providerId} disabled={rowBusy} onChange={(event) => chooseProvider(row.id, event.target.value)}>
                  <option value="">新建服务</option>
                  {providers.map((provider) => {
                    const models = candidateModels(provider, row.id);
                    const label = models.length ? models.map((model) => model.id).join(', ') : '已有其他能力';
                    return <option key={provider.id} value={provider.id}>{provider.id} · {label} · {provider.baseUrl}</option>;
                  })}
                </Select>
              </Field> : null}
              <Field label="Base URL">
                <Input value={draft.baseUrl} disabled={rowBusy} onChange={(event) => updateDraft(row.id, { baseUrl: event.target.value })} placeholder="https://api.example.com/v1" autoComplete="url" />
              </Field>
              <Field label="API Key" hint={activeProvider?.credential.configured ? '已保存密钥不会回填；留空表示同地址保持现有密钥。' : '密钥由本地凭据库加密保存，界面不会回显。'}>
                <Input type="password" value={draft.secret} disabled={rowBusy} onChange={(event) => updateDraft(row.id, { secret: event.target.value })} placeholder={activeProvider?.credential.configured ? '已保存（留空保持）' : '输入 API Key'} autoComplete="new-password" />
              </Field>
              <Field label="模型名" hint="支持手动输入；也可尝试从服务获取候选列表。">
                <div className="model-id-control">
                  <Input list={datalistId} value={draft.modelId} disabled={rowBusy} onChange={(event) => updateDraft(row.id, { modelId: event.target.value })} placeholder="例如 model-name" />
                  <datalist id={datalistId}>{availableModelIds.map((model) => <option value={model} key={model} />)}</datalist>
                  <Button type="button" size="sm" variant="ghost" busy={busy[row.id] === 'models'} disabled={rowBusy || !draft.baseUrl.trim()} onClick={() => void fetchModels(row.id)}>获取列表</Button>
                </div>
              </Field>
            </div>
            <details className="simple-model-advanced">
              <summary>协议与能力高级设置</summary>
              <div className="model-fields model-fields-advanced">
                <Field label="适配器">
                  <Select value={draft.adapterId} disabled={rowBusy} onChange={(event) => updateDraft(row.id, { adapterId: event.target.value })}>
                    {!adapterKnown ? <option value={draft.adapterId}>{draft.adapterId || '未选择'}（当前适配器）</option> : null}
                    {adapterChoices.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}
                  </Select>
                  {!adapterKnown ? <p className="inline-error">当前适配器不在该能力的可用列表；保存前请选择支持此能力的适配器。</p> : null}
                </Field>
                {row.id === 'chat' ? (
                  <label className="model-checkbox"><Checkbox disabled={rowBusy} checked={draft.supportsTools} onChange={(event) => updateDraft(row.id, { supportsTools: event.target.checked })} /><span>该文本模型支持工具调用</span></label>
                ) : null}
                {row.id === 'audio.generate' ? (
                  <Field label="默认音色" hint="工具本轮未指定音色时使用。">
                    <Input value={draft.voice} disabled={rowBusy} onChange={(event) => updateDraft(row.id, { voice: event.target.value })} placeholder="例如 alloy" />
                  </Field>
                ) : null}
                {selectedModel && !row.primary ? <span className="muted">该服务已声明模型能力：{selectedModel.capabilities.map((cap) => CAPABILITY_LABEL[cap]).join('、')}</span> : null}
              </div>
            </details>
            <div className="model-editor-actions">
              <span className="model-test-cost-note">验证会实际调用服务，可能产生少量费用；不会保存，也不会发送 QQ。</span>
              <ConfirmButton type="button" variant="ghost" busy={busy[row.id] === 'validate'} disabled={rowBusy || !draft.baseUrl.trim() || !draft.modelId.trim()} onClick={() => void validate(row.id)}>验证</ConfirmButton>
              <ConfirmButton type="button" variant="primary" busy={busy[row.id] === 'save'} disabled={rowBusy || !draft.baseUrl.trim() || !draft.modelId.trim()} onClick={() => void save(row.id)}>保存模型服务</ConfirmButton>
            </div>
            {errors[row.id] ? <ErrorNote message={errors[row.id]!} /> : null}
            {notices[row.id] ? <div className="notice" role="status">{notices[row.id]}</div> : null}
            {notices[row.id]?.startsWith('模型服务已保存') && onGoAccountModels ? <Button disabled={hasBusyAction} onClick={onGoAccountModels}>去账号模型配置</Button> : null}
            {resultsFingerprint[row.id] === draftFingerprint && results[row.id]?.sample?.kind === 'image' ? <img className="provider-test-image" src={`data:${results[row.id]!.sample!.mimeType};base64,${results[row.id]!.sample!.base64}`} alt="模型测试生成的图片" /> : null}
            {resultsFingerprint[row.id] === draftFingerprint && results[row.id]?.sample?.kind === 'audio' ? <audio className="provider-test-audio" controls preload="metadata" src={`data:${results[row.id]!.sample!.mimeType};base64,${results[row.id]!.sample!.base64}`} /> : null}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div className="page-stack model-settings-page">
      {error ? <ErrorNote message={error} /> : null}
      <Card title="基础模型服务" subtitle="固定配置文本、视觉和视频理解服务。未配置时也保留对应入口；服务保存后，还需在账号模型配置中授权与选择。">
        {!data ? error ? <Button onClick={() => void refresh()}>重试读取模型服务</Button> : <p className="muted">正在读取模型服务…</p> : <div className="simple-model-list">{PRIMARY_ROWS.map(renderRow)}</div>}
      </Card>
      <Card title="扩展模型" subtitle="仅在需要相应能力时配置。服务可用不代表已向对话 AI 开放，账号工具授权需单独设置。">
        <ControlButton type="button" className="extension-toggle" aria-expanded={extensionsOpen} onClick={() => setExtensionsOpen((open) => !open)}>
          <span><Icon name="plus" size={16} /> 添加扩展模型</span><Icon name="chevron" size={18} className={extensionsOpen ? 'rotate-180' : undefined} />
        </ControlButton>
        {extensionsOpen ? <div className="simple-model-list simple-model-list-extension">{EXTENSION_ROWS.map(renderRow)}</div> : null}
      </Card>
      {data ? <ProviderManager providers={providers} refresh={refresh} onGoAccountModels={onGoAccountModels} /> : null}
      <p className="settings-note"><Icon name="shield" size={15} /><span>测试会发送一次最小服务请求并可能产生少量费用；验证按钮旁会再次提示。测试不会保存配置或向 QQ 发消息。模型服务、账号授权、AI 工具开放和本轮实际调用是彼此独立的设置。</span></p>
    </div>
  );
}
