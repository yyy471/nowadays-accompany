import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type {
  AccountPolicy,
  AccountPolicyResponse,
  AccountsResponse,
  CapabilityId,
  EffectiveCapabilitiesDto,
  EffectiveResponse,
  ProviderDto,
  ProviderTestResult,
  ProvidersResponse,
  ReplyMode,
  SlotsResponse,
  VisionMode
} from '../types';
import { Button, CancelButton, Card, Checkbox, ConfirmButton, Empty, ErrorNote, Field, Icon, Select, Tag, useConfirm } from '../ui';

const CAPABILITIES: Array<{ id: CapabilityId; label: string }> = [
  { id: 'chat', label: '文字对话' },
  { id: 'image.understand', label: '图片理解' },
  { id: 'video.understand', label: '视频理解' },
  { id: 'image.generate', label: '图片生成' },
  { id: 'audio.generate', label: '语音生成' }
];

const REASON_LABELS: Record<string, string> = {
  not_configured: '未绑定',
  provider_not_found: '服务不存在',
  provider_not_authorized: '账号未授权该服务',
  model_not_found: '模型不存在',
  capability_unsupported: '模型不支持',
  adapter_not_found: '适配器未注册',
  adapter_unsupported: '适配器不支持',
  media_transport_unavailable: '媒体传输方式不允许',
  cloud_media_blocked: '未允许媒体上传云端',
  model_no_image_input: '模型不能直接接收图片',
  cross_provider_fallback_disabled: '未允许跨服务回退',
  execution_plan_stale: '服务配置已变化',
  credential_stale: '服务凭据已变化'
};

type CapabilityTestResult = { accountId: string; text: string; ok: boolean; sample?: ProviderTestResult['sample'] };

function legacyScopedModels(policy: AccountPolicy): number {
  const scopes = [...Object.values(policy.byKind), ...Object.values(policy.byConversation)];
  return scopes.reduce((count, scope) => count + Number(Boolean(scope?.bindings && Object.keys(scope.bindings).length)) + Number(Boolean(scope?.capabilities && Object.keys(scope.capabilities).length)), 0);
}

export function PolicyPage({
  providers,
  accounts,
  slots,
  onGoModels
}: {
  providers?: ProvidersResponse;
  accounts?: AccountsResponse;
  slots?: SlotsResponse;
  onGoModels: () => void;
}) {
  const accountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const account of accounts?.accounts ?? []) ids.add(account.accountId);
    for (const slot of slots?.slots ?? []) if (slot.accountId) ids.add(slot.accountId);
    return [...ids].sort();
  }, [accounts, slots]);
  const [accountId, setAccountId] = useState('');
  const [loadedAccountId, setLoadedAccountId] = useState<string>();
  const [effectiveAccountId, setEffectiveAccountId] = useState<string>();
  const [policy, setPolicy] = useState<AccountPolicy>();
  const [draft, setDraft] = useState<AccountPolicy>();
  const [effective, setEffective] = useState<EffectiveCapabilitiesDto>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [testResults, setTestResults] = useState<Partial<Record<CapabilityId, CapabilityTestResult>>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [effectiveKey, setEffectiveKey] = useState(0);
  const accountRef = useRef(accountId);
  const accountGeneration = useRef(0);
  const providerList = providers?.providers ?? [];
  const confirm = useConfirm();

  const selectAccount = (next: string): void => {
    if (accountRef.current === next) return;
    accountRef.current = next;
    accountGeneration.current += 1;
    setAccountId(next);
    setLoadedAccountId(undefined);
    setEffectiveAccountId(undefined);
    setPolicy(undefined);
    setDraft(undefined);
    setEffective(undefined);
    setBusy(undefined);
    setError(undefined);
    setNotice(undefined);
    setTestResults({});
  };

  const isCurrentAccount = (id: string, generation: number): boolean =>
    accountRef.current === id && accountGeneration.current === generation;

  useEffect(() => {
    if (!accountId && accountIds.length) selectAccount(accountIds[0]!);
    if (accountId && !accountIds.includes(accountId)) selectAccount(accountIds[0] ?? '');
  }, [accountId, accountIds]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const targetAccount = accountId;
    const generation = accountGeneration.current;
    setBusy((current) => current ?? 'loading');
    setError(undefined);
    api<AccountPolicyResponse>(`/accounts/${encodeURIComponent(targetAccount)}/policy`)
      .then((response) => {
        if (cancelled || !isCurrentAccount(targetAccount, generation)) return;
        setPolicy(response.policy);
        setDraft(response.policy);
        setLoadedAccountId(targetAccount);
      })
      .catch((loadError: unknown) => { if (!cancelled && isCurrentAccount(targetAccount, generation)) setError(errorMessage(loadError)); })
      .finally(() => { if (!cancelled && isCurrentAccount(targetAccount, generation)) setBusy((current) => current === 'loading' ? undefined : current); });
    return () => { cancelled = true; };
  }, [accountId, reloadKey]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const targetAccount = accountId;
    const generation = accountGeneration.current;
    api<EffectiveResponse>(`/accounts/${encodeURIComponent(targetAccount)}/effective?kind=private&peerId=0`)
      .then((response) => {
        if (cancelled || !isCurrentAccount(targetAccount, generation)) return;
        setEffective(response.effective);
        setEffectiveAccountId(targetAccount);
      })
      .catch((loadError: unknown) => {
        if (!cancelled && isCurrentAccount(targetAccount, generation)) setEffective(undefined);
        if (!cancelled && isCurrentAccount(targetAccount, generation)) setError((current) => current ?? errorMessage(loadError));
      });
    return () => { cancelled = true; };
  }, [accountId, effectiveKey]);

  const activePolicy = loadedAccountId === accountId ? policy : undefined;
  const activeDraft = loadedAccountId === accountId ? draft : undefined;
  const activeEffective = effectiveAccountId === accountId ? effective : undefined;
  const dirty = Boolean(activePolicy && activeDraft && JSON.stringify(activePolicy) !== JSON.stringify(activeDraft));
  const legacyCount = activeDraft ? legacyScopedModels(activeDraft) : 0;

  const save = async (): Promise<AccountPolicy | undefined> => {
    const targetAccount = accountId;
    const targetDraft = activeDraft;
    const generation = accountGeneration.current;
    if (!targetAccount || !targetDraft || loadedAccountId !== targetAccount || (busy && busy !== 'loading')) return undefined;
    setBusy('save');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<AccountPolicyResponse>(`/accounts/${encodeURIComponent(targetAccount)}/policy`, {
        method: 'PUT', body: JSON.stringify({ policy: targetDraft })
      });
      if (!isCurrentAccount(targetAccount, generation)) return undefined;
      setPolicy(response.policy);
      setDraft(response.policy);
      setLoadedAccountId(targetAccount);
      setEffectiveKey((value) => value + 1);
      setNotice(`账号 ${targetAccount} 的模型、能力和授权已保存。`);
      return response.policy;
    } catch (saveError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(saveError));
      return undefined;
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const testCapability = async (capability: CapabilityId): Promise<void> => {
    const targetAccount = accountId;
    const generation = accountGeneration.current;
    if (!targetAccount || !activeDraft || loadedAccountId !== targetAccount || (busy && busy !== 'loading')) return;
    let savedPolicy = activePolicy;
    if (dirty) {
      savedPolicy = await save();
      if (!savedPolicy || !isCurrentAccount(targetAccount, generation)) return;
    }
    const binding = savedPolicy?.bindings?.[capability];
    if (!binding) {
      setTestResults((current) => ({ ...current, [capability]: { accountId: targetAccount, ok: false, text: '测试失败：请先保存该能力的服务和模型。' } }));
      return;
    }
    const provider = providerList.find((item) => item.id === binding.providerId);
    const confirmCost = provider?.location === 'cloud' || capability === 'image.generate' || capability === 'audio.generate';
    if (confirmCost && !(await confirm({
      title: '测试账号模型服务',
      description: `将直接测试账号 ${targetAccount} 的 ${capability}（${binding.providerId} / ${binding.modelId}）。该服务请求可能产生费用。继续？\n此测试不会向 QQ 发送消息。`,
      confirmLabel: '开始测试'
    }))) return;
    if (!isCurrentAccount(targetAccount, generation)) return;
    setBusy(`test:${capability}`);
    setError(undefined);
    setNotice(undefined);
    setTestResults((current) => ({ ...current, [capability]: { accountId: targetAccount, ok: false, text: '测试中…' } }));
    try {
      const response = await api<{ result: ProviderTestResult }>(`/accounts/${encodeURIComponent(targetAccount)}/capabilities/test`, {
        method: 'POST', body: JSON.stringify({ capability, confirmCost })
      });
      if (!isCurrentAccount(targetAccount, generation)) return;
      const result = response.result;
      setTestResults((current) => ({
        ...current,
        [capability]: {
          accountId: targetAccount,
          ok: result.ok,
          text: `${result.ok ? '测试通过' : '测试未通过'} · ${result.providerId ?? binding.providerId} / ${result.modelId ?? binding.modelId}${result.detail ? ` · ${result.detail}` : ''}${result.durationMs !== undefined ? ` · ${result.durationMs} ms` : ''}`,
          ...(result.sample ? { sample: result.sample } : {})
        }
      }));
    } catch (testError) {
      if (isCurrentAccount(targetAccount, generation)) setTestResults((current) => ({ ...current, [capability]: { accountId: targetAccount, ok: false, text: `测试失败：${errorMessage(testError)}` } }));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const toggleAgent = async (enabled: boolean): Promise<void> => {
    const targetAccount = accountId;
    const generation = accountGeneration.current;
    if (!targetAccount || loadedAccountId !== targetAccount || (busy && busy !== 'loading')) return;
    if (dirty && !(await confirm({
      title: enabled ? '恢复账号回复' : '暂停账号回复',
      description: '账号模型配置有未保存修改；暂停或恢复会重新读取已保存策略。继续？',
      confirmLabel: enabled ? '恢复回复' : '暂停回复'
    }))) return;
    if (!isCurrentAccount(targetAccount, generation)) return;
    setBusy('agent');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<AccountPolicyResponse>(`/accounts/${encodeURIComponent(targetAccount)}/agent`, {
        method: 'POST', body: JSON.stringify({ enabled })
      });
      if (!isCurrentAccount(targetAccount, generation)) return;
      setPolicy(response.policy);
      setDraft(response.policy);
      setLoadedAccountId(targetAccount);
      setEffectiveKey((value) => value + 1);
      setNotice(enabled ? '账号 Agent 已恢复；QQ 连接不受影响。' : '账号 Agent 已暂停；QQ 保持在线，人工发送仍可用。');
    } catch (agentError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(agentError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const setCapabilityEnabled = (capability: CapabilityId, enabled: boolean): void => {
    if (loadedAccountId !== accountId || (busy && busy !== 'loading')) return;
    setDraft((current) => current ? {
      ...current,
      capabilities: { ...(current.capabilities ?? {}), [capability]: enabled }
    } : current);
    setNotice(undefined);
  };

  const setBinding = (capability: CapabilityId, providerId: string, modelId?: string): void => {
    if (loadedAccountId !== accountId || (busy && busy !== 'loading')) return;
    setDraft((current) => {
      if (!current) return current;
      const bindings = { ...current.bindings };
      if (!providerId) delete bindings[capability];
      else {
        const provider = providerList.find((item) => item.id === providerId);
        const model = provider?.models.find((item) => item.id === modelId && item.capabilities.includes(capability))
          ?? provider?.models.find((item) => item.capabilities.includes(capability));
        if (model) {
          const previous = bindings[capability];
          bindings[capability] = {
            providerId,
            modelId: model.id,
            ...(previous?.providerId === providerId && previous.fallback ? { fallback: previous.fallback } : {})
          };
        }
      }
      return { ...current, bindings };
    });
    setNotice(undefined);
  };

  const toggleProvider = (providerId: string, enabled: boolean): void => {
    if (loadedAccountId !== accountId || (busy && busy !== 'loading')) return;
    setDraft((current) => {
      if (!current) return current;
      const allowedProviders = new Set(current.allowedProviders);
      if (enabled) allowedProviders.add(providerId);
      else allowedProviders.delete(providerId);
      return { ...current, allowedProviders: [...allowedProviders] };
    });
    setNotice(undefined);
  };

  return (
    <div className="page-stack">
      <div className="banner">
        <Icon name="shield" size={18} />
        <div>
          <strong>模型服務按 QQ 账号统一配置。</strong>
          <span>五类能力使用账号级服务绑定；群聊、私聊和具体会话不会覆盖模型。工具授权与服务配置分开保存。</span>
        </div>
      </div>
      {legacyCount > 0 ? <div className="notice notice-warn">检测到 {legacyCount} 组旧版会话级模型设置。它们仍保留在配置文件中供迁移检查，但不会再应用；请选择每个账号的服务绑定。保存不会删除这些旧字段。</div> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {accountIds.length === 0 ? (
        <Card><Empty icon="accounts" title="还没有可配置的账号" description="QQ 登录后会出现在这里。服务定义集中放在应用设置中维护。" action={<Button icon="bolt" onClick={onGoModels}>先配置模型服务</Button>} /></Card>
      ) : (
        <>
          <Card title="账号模型与授权" actions={<div className="row-actions"><Button size="sm" icon="refresh" disabled={Boolean(busy && busy !== 'loading')} onClick={() => setReloadKey((value) => value + 1)}>重新读取</Button><ConfirmButton size="sm" variant="primary" busy={busy === 'save'} disabled={!dirty || Boolean(busy && busy !== 'loading')} onClick={() => void save()}>保存账号配置</ConfirmButton><CancelButton size="sm" variant="ghost" disabled={!dirty || Boolean(busy && busy !== 'loading')} onClick={() => activePolicy && setDraft(activePolicy)}>撤销修改</CancelButton></div>}>
            <div className="policy-toolbar">
              <Field label="QQ 账号"><Select value={accountId} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => selectAccount(event.target.value)}>
                {accountIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </Select></Field>
              {activeDraft ? <div className="policy-head-actions">
                <Tag tone={activeDraft.agentEnabled === false ? 'warn' : 'ok'}>{activeDraft.agentEnabled === false ? 'Agent 已暂停' : 'Agent 已开启'}</Tag>
                <Button size="sm" variant={activeDraft.agentEnabled === false ? 'primary' : 'default'} icon={activeDraft.agentEnabled === false ? 'play' : 'stop'} busy={busy === 'agent'} disabled={Boolean(busy && busy !== 'loading')} onClick={() => void toggleAgent(activeDraft.agentEnabled === false)}>{activeDraft.agentEnabled === false ? '恢复账号回复' : '暂停账号回复'}</Button>
              </div> : null}
            </div>
            {!activeDraft ? <p className="muted">正在读取账号配置…</p> : (
              <div className="policy-editor">
                <div className="policy-section">
                  <h4>账号服务授权</h4>
                  <p className="muted">只允许此账号使用已勾选服务。云端媒体上传和跨服务回退也需要单独授权。</p>
                  <div className="check-row-wrap">
                    {providerList.length ? providerList.map((provider) => <label className="check-row" key={provider.id}>
                      <Checkbox checked={activeDraft.allowedProviders.includes(provider.id)} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => toggleProvider(provider.id, event.target.checked)} />
                      <span>{provider.models.map((model) => model.id).join(' / ')}<span className="muted"> · {provider.baseUrl}</span></span>
                    </label>) : <span className="muted">还没有注册服务，请到应用设置维护。</span>}
                  </div>
                  <div className="check-row-wrap">
                    <label className="check-row"><Checkbox checked={activeDraft.media.allowCloudUpload} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => setDraft({ ...activeDraft, media: { allowCloudUpload: event.target.checked } })} /><span>允许图片或视频上传到云端识别服务</span></label>
                    <label className="check-row"><Checkbox checked={activeDraft.crossProviderFallback} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => setDraft({ ...activeDraft, crossProviderFallback: event.target.checked })} /><span>允许跨服务回退</span></label>
                  </div>
                  <Field label="图片观察方式" hint="外部识图预处理附件；直接视觉仅用于声明支持图片输入的聊天模型。">
                    <Select value={activeDraft.visionMode ?? 'external'} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => setDraft({ ...activeDraft, visionMode: event.target.value as VisionMode })}>
                      <option value="external">外部识图</option><option value="direct">直接视觉</option>
                    </Select>
                  </Field>
                  <Field label="回复归属" hint="Skill 兼容插件可以接管会话；否则使用内置 Agent。">
                    <Select value={activeDraft.replyMode ?? 'auto'} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => setDraft({ ...activeDraft, replyMode: event.target.value as ReplyMode })}>
                      <option value="auto">自动选择</option><option value="agent">内置 Agent</option><option value="plugins">兼容插件</option>
                    </Select>
                  </Field>
                </div>

                <div className="policy-section">
                  <h4>允许 AI 调用的工具</h4>
                  <p className="muted">配置服务不会开放工具。勾选后，支持工具调用的对话模型才能在本轮按需请求。</p>
                  <div className="check-row-wrap">
                    {([['builtin.image.generate', '生图'], ['builtin.audio.generate', '语音生成']] as const).map(([toolId, label]) => <label className="check-row" key={toolId}>
                      <Checkbox checked={activeDraft.enabledTools?.includes(toolId) ?? false} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => {
                        const enabledTools = new Set(activeDraft.enabledTools ?? []);
                        if (event.target.checked) enabledTools.add(toolId); else enabledTools.delete(toolId);
                        setDraft({ ...activeDraft, enabledTools: [...enabledTools] });
                      }} />
                      <span>{label}</span>
                    </label>)}
                  </div>
                </div>

                <div className="policy-section wide">
                  <h4>五类模型服务</h4>
                  <p className="muted">每行“测试”会直连当前账号保存的服务配置；有未保存修改时先保存。云端服务、生图和语音测试会先确认费用，结果显示在对应能力行，不会向 QQ 发送消息。</p>
                  <div className="capability-table">
                    {CAPABILITIES.map((capability) => {
                      const binding = activeDraft.bindings?.[capability.id];
                      const enabled = activeDraft.capabilities?.[capability.id] !== false;
                      const capableProviders = providerList.filter((provider) => provider.models.some((model) => model.capabilities.includes(capability.id)));
                      const selectedProvider = providerList.find((provider) => provider.id === binding?.providerId);
                      const models = selectedProvider?.models.filter((model) => model.capabilities.includes(capability.id)) ?? [];
                      const testResult = testResults[capability.id]?.accountId === accountId ? testResults[capability.id] : undefined;
                      return <div className="capability-row" key={capability.id}>
                        <div className="capability-name"><strong>{capability.label}</strong><span className="muted mono">{capability.id}</span></div>
                        <label className="capability-enabled"><Checkbox checked={enabled} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => setCapabilityEnabled(capability.id, event.target.checked)} /><span>{enabled ? '启用' : '停用'}</span></label>
                        <Select aria-label={`${capability.label}服务`} value={binding?.providerId ?? ''} disabled={Boolean(busy && busy !== 'loading')} onChange={(event) => setBinding(capability.id, event.target.value)}>
                          <option value="">未绑定服务</option>
                          {capableProviders.map((provider) => <option key={provider.id} value={provider.id} disabled={!activeDraft.allowedProviders.includes(provider.id)}>{provider.models.filter((model) => model.capabilities.includes(capability.id)).map((model) => model.id).join(' / ')} · {provider.baseUrl}{activeDraft.allowedProviders.includes(provider.id) ? '' : '（账号未授权）'}</option>)}
                        </Select>
                        <Select aria-label={`${capability.label}模型`} value={binding?.modelId ?? ''} disabled={!binding || Boolean(busy && busy !== 'loading')} onChange={(event) => setBinding(capability.id, binding?.providerId ?? '', event.target.value)}>
                          {!binding ? <option value="">先选择服务</option> : null}
                          {models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
                        </Select>
                        <div className="capability-test">
                          <ConfirmButton size="sm" icon="bolt" busy={busy === `test:${capability.id}`} disabled={!binding || !enabled || Boolean(busy && busy !== `test:${capability.id}`)} onClick={() => void testCapability(capability.id)}>测试</ConfirmButton>
                          {testResult ? <div className={`capability-test-result${testResult.ok ? ' is-ok' : ' is-failed'}`}>
                            <span>{testResult.text}</span>
                            {testResult.sample?.kind === 'image' ? <img className="capability-test-image" src={`data:${testResult.sample.mimeType};base64,${testResult.sample.base64}`} alt="本次生图测试预览" /> : null}
                            {testResult.sample?.kind === 'audio' ? <audio className="capability-test-audio" controls preload="none" aria-label="本次语音测试试听" src={`data:${testResult.sample.mimeType};base64,${testResult.sample.base64}`} /> : null}
                          </div> : null}
                        </div>
                      </div>;
                    })}
                  </div>
                  <p className="field-hint">识图与视频识别可用于附件预处理；不支持图片输入的聊天模型仍能正常处理不含图片的对话。AI不会因服务已配置而自动生成媒体。</p>
                </div>
              </div>
            )}
          </Card>

          <div className="policy-grid">
            <Card title="生效结果" subtitle="按账号服务配置解析；会话类型不会覆盖服务绑定" actions={<Button size="sm" icon="refresh" disabled={Boolean(busy && busy !== 'loading')} onClick={() => setEffectiveKey((value) => value + 1)}>刷新</Button>}>
              {!activeEffective ? <p className="muted">暂无生效结果。</p> : <div className="effective-list">
                <div className="effective-summary"><Tag tone={activeEffective.agentEnabled ? 'ok' : 'warn'}>Agent {activeEffective.agentEnabled ? '开启' : '暂停'}</Tag><Tag tone="idle">回复 {activeEffective.replyMode}</Tag><Tag tone="idle">视觉 {activeEffective.visionMode}</Tag><Tag tone={activeEffective.allowCloudUpload ? 'warn' : 'ok'}>{activeEffective.allowCloudUpload ? '允许云端媒体' : '禁止云端媒体'}</Tag></div>
                {activeEffective.capabilities.map((capability) => <div className={`effective-row${capability.enabled ? '' : ' is-off'}`} key={capability.capability}>
                  <div className="effective-title"><strong>{capability.label}</strong><span className="muted mono">{capability.capability}</span></div>
                  <div className="effective-detail">{capability.enabled ? <><Tag tone="ok">可用</Tag><span className="mono">{capability.providerId ?? '?'} / {capability.modelId ?? '?'}</span>{capability.cancelMode ? <Tag tone="idle">取消 {capability.cancelMode}</Tag> : null}</> : <><Tag tone="warn">{REASON_LABELS[capability.reason ?? ''] ?? capability.reason ?? '不可用'}</Tag>{capability.detail ? <span className="muted">{capability.detail}</span> : null}</>}</div>
                </div>)}
              </div>}
            </Card>
            <Card title="Skill 可用性" subtitle="Skill 只提供提示与工具引用，不能绕过账号授权。">
              {!activeEffective ? <p className="muted">暂无数据。</p> : activeEffective.skills.available.length === 0 && activeEffective.skills.unavailable.length === 0 ? <p className="muted">当前账号没有可用 Skill。可在“插件与Skill”页检查账号插件资料；此版本暂未提供独立 Skill 声明入口。</p> : <div className="skill-list">
                {activeEffective.skills.available.map((skill) => <div className="skill-row" key={skill.id}><Tag tone="ok">可用</Tag><div><strong>{skill.name}</strong><span className="muted mono">{skill.id}</span><p className="muted">工具：{skill.tools.join('、') || '无'}</p></div></div>)}
                {activeEffective.skills.unavailable.map((skill) => <div className="skill-row is-off" key={skill.id}><Tag tone="warn">不可用</Tag><div><strong>{skill.name}</strong><span className="muted mono">{skill.id}</span><p className="muted">{skill.reason ?? '未知原因'}</p></div></div>)}
              </div>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
