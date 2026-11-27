import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { errorText } from '../../lib/error-text';
import type { RoleListItem } from '../../types';
import { Button, Field, Input, useConfirm } from '../../ui';
import { useSheet } from './sheet/sheet-context';
import { useWrite } from './write-runner';
import { captureSavedSummary } from './sheet/save-feedback';
import { ExtensionFields, SavedMcpProbe, parseExtensionEnv } from './ExtensionImport';
import { COMMAND_MCP_RISK, isCommandMcp } from './extension-import';
import { MediaGroup } from './MediaSheet';
import { ModelNamePicker } from '../model/ModelNamePicker';
import { SecretInput } from '../model/SecretInput';
import { useModelProbe, type ModelProbeTarget } from '../model/use-model-probe';
import {
  applyRevealedSecret,
  createSecretDraft,
  hasVertexSafety,
  hideUneditedSecret,
  modelAdapterOf,
  modelConnectionFields,
  modelCredentialScope,
  modelPresets,
  nextSecretDraftOnInput,
  resolveModelBaseUrlOnProtocolChange,
  SECRET_MASK_SENTINEL,
  secretOperationOf,
  vertexSafetyOf,
  visibleProbeNotice,
} from '../model/model-picker';
import { clearModelCache, providerCacheKey, writeModelCache } from '../model/model-cache';
import {
  ServiceDeleteEntry,
  ServiceDeleteSheet,
  ServiceHeading,
  ServiceManagementRow,
  ServiceProbeAction,
  ServiceRow,
  ServiceSheet,
  ServiceSheetActions,
  ServiceUseRow,
  serviceHost,
  serviceMaintenanceOf,
  serviceProbeNotice,
  serviceWriteFailure,
  useServiceSheetExit,
} from './ServiceParts';
import { T10, T12, T16, T32 } from './config-texts';
import {
  ModelConnectionInputs,
  modelAdapterLabel,
  roleDisplayName,
  savedModelNameOf,
  useModelAddress,
  type Activity,
  type Binding,
  type Resource,
} from './settings-shared';

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
  const confirm = useConfirm();
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
    const accepted = await confirm({
      title: '结束运行中的任务？',
      description: `结束任务 ${taskId}？后续步骤不再执行，已发出的调用按原任务结算。`,
      confirmLabel: '结束任务',
      cancelLabel: '取消',
      tone: 'danger',
    });
    if (!accepted) return;
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
    {isMcp && isCommandMcp(resource.config) && <p className="config-sheet-note">{COMMAND_MCP_RISK}</p>}
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

export { ResourceDetail };
