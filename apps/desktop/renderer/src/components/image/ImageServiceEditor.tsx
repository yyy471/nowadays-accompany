import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Field, Input, announceLive } from '../../ui';
import type { RoleListItem } from '../../types';
import { MediaGroup } from '../config/MediaSheet';
import {
  ServiceDeleteEntry, ServiceDeleteSheet, ServiceHeading, ServiceManagementRow, ServicePauseNotice, ServiceProbeAction,
  ServiceRow, ServiceSheet, ServiceSheetActions, ServiceUseRow, serviceHost, serviceMaintenanceOf, serviceProbeNotice, serviceWriteFailure, useServiceSheetExit,
} from '../config/ServiceParts';
import { T10, T12, T16, T32 } from '../config/config-texts';
import { captureSavedSummary } from '../config/sheet/save-feedback';
import { useSheet } from '../config/sheet/sheet-context';
import { useMediaOccupancy } from '../config/use-media-occupancy';
import { useWrite } from '../config/write-runner';
import { SecretInput } from '../model/SecretInput';
import { createSecretDraft, nextSecretDraftOnInput, SECRET_MASK_SENTINEL, secretOperationOf } from '../model/model-picker';
import { ImageModelPicker } from './ImageModelPicker';
import { clearImageModelCache, imageServiceCacheKey, writeImageModelCache } from './image-cache';
import { useImageProbe, type ImageProbeTarget } from './use-image-probe';
import { describeImageFailure, savedImageModelOf } from '../../image-config';

export type ImageService = {
  serviceId: string;
  name: string;
  enabled: boolean;
  updatedAt?: string;
  config: { protocol?: 'comfyui'; baseUrl: string; modelName?: string; credentialRef?: string; timeoutMs?: number };
  credential: { status: string; reference?: string | null; resolvable?: boolean };
};

function imageErrorText(reason: unknown): string {
  return reason instanceof ApiError ? describeImageFailure(reason.code, reason.message) : reason instanceof Error ? reason.message : String(reason);
}

export function ImageServiceCreate({ trigger, onCancel, onCreated }: {
  trigger: HTMLElement | null;
  onCancel: () => void;
  onCreated: (service: ImageService, tested?: boolean | null) => void;
}) {
  return <ImageServiceEditor trigger={trigger} onCancel={onCancel} onCreated={onCreated}/>;
}

export function ImageServiceDetail({ service, roles, activities, tested, onTested, onUpdated, onRemoved }: {
  service?: ImageService;
  roles: RoleListItem[];
  activities: Array<{ roleId: string; state: 'active' | 'stopping' | 'stopped' }>;
  tested?: boolean | null;
  onTested: (tested: boolean | null) => void;
  onUpdated: (changedServiceId: string, updated?: ImageService) => void;
  onRemoved: (serviceId: string) => void;
}) {
  const occupancy = useMediaOccupancy('image', service?.serviceId ?? '', roles, activities);
  if (!service) return null;
  const label = (id: string) => roles.find(role => role.roleId === id)?.displayName ?? id;
  return <ImageServiceEditor service={service} occupancy={occupancy} roleName={label} tested={tested} onTested={onTested} onUpdated={onUpdated} onRemoved={onRemoved}/>;
}

function ImageServiceEditor({ service, trigger, occupancy, roleName = id => id, tested, onTested, onCancel, onCreated, onUpdated, onRemoved }: {
  service?: ImageService;
  trigger?: HTMLElement | null;
  occupancy?: ReturnType<typeof useMediaOccupancy>;
  roleName?: (id: string) => string;
  tested?: boolean | null;
  onTested?: (tested: boolean | null) => void;
  onCancel?: () => void;
  onCreated?: (service: ImageService, tested?: boolean | null) => void;
  onUpdated?: (changedServiceId: string, updated?: ImageService) => void;
  onRemoved?: (serviceId: string) => void;
}) {
  const sheet = useSheet();
  const write = useWrite();
  const saved = useRef(service);
  useEffect(() => { saved.current = service; }, [service]);
  const [name, setName] = useState(service?.name ?? '');
  const [url, setUrl] = useState(service?.config.baseUrl ?? '');
  const [model, setModel] = useState(savedImageModelOf(service));
  const [secret, setSecret] = useState(() => createSecretDraft(service?.credential.status));
  const [visible, setVisible] = useState(false);
  const [secretUpdated, setSecretUpdated] = useState(false);
  const [operation, setOperation] = useState<'save' | 'toggle' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [draftTest, setDraftTest] = useState<boolean | null>(null);
  const [probeGroup, setProbeGroup] = useState<'connection' | 'model'>('model');
  const [probeNeedsUrl, setProbeNeedsUrl] = useState<'test' | 'list' | null>(null);
  const creating = !service;
  const sheetId = service ? `image-form:${service.serviceId}` : 'new-image-service';
  const deleteId = service ? `image-delete:${service.serviceId}` : 'image-delete';
  const savedKey = service ? imageServiceCacheKey(service) : '';
  const secretOp = secretOperationOf(secret);
  const testKey = secretOp.action === 'replace' ? secretOp.secret : secretOp.action;
  const connectionChanged = url.trim() !== (service?.config.baseUrl ?? '') || secretOp.action !== 'keep';
  const matchesSaved = !!service && !connectionChanged;
  const probe = useImageProbe(matchesSaved ? savedKey : `${savedKey}|draft|${url}|${testKey}`, { shared: matchesSaved });
  useEffect(() => { if (creating) sheet.open({ id: sheetId, title: '添加生图服务', shape: 'full', focusReturn: trigger }); }, [creating, sheetId]);
  useServiceSheetExit(sheetId, () => { probe.cancelPending(); setVisible(false); setProbeNeedsUrl(null); });
  useServiceSheetExit(deleteId, () => setError(''));
  useEffect(() => () => { probe.cancelPending(); }, [probe.cancelPending]);

  const modelChanged = model.trim() !== savedImageModelOf(service);
  const count = [name.trim() !== (service?.name ?? ''), url.trim() !== (service?.config.baseUrl ?? ''), modelChanged, secretOp.action !== 'keep'].filter(Boolean).length;
  const invalid = !name.trim() ? T10.name : !url.trim() ? T10.url : '';
  const mustReplace = !!service && !!url.trim() && secret.hasExisting && serviceHost(url) !== serviceHost(service.config.baseUrl) && secretOp.action === 'keep';
  const affected = occupancy?.activeIds ?? [];
  const pauseNames = service && connectionChanged ? affected.map(roleName) : [];
  const target = (): ImageProbeTarget => service && matchesSaved ? { kind: 'savedService', serviceId: service.serviceId, cacheKey: savedKey } : {
    kind: 'draft',
    config: {
      ...(service && secretOp.action === 'keep' ? { serviceId: service.serviceId, credentialRef: service.config.credentialRef } : {}),
      baseUrl: url.trim(),
      ...(secretOp.action === 'replace' ? { secret: secretOp.secret } : {}),
      ...(service?.config.timeoutMs !== undefined ? { timeoutMs: service.config.timeoutMs } : {}),
      ...(model.trim() ? { modelName: model.trim() } : {}),
    },
  };
  useEffect(() => {
    if (!probe.notice || probe.notice.source !== 'test') return;
    const success = probe.notice.role === 'status';
    setDraftTest(success);
    if (matchesSaved && !modelChanged) onTested?.(success);
  }, [probe.notice, matchesSaved, modelChanged]);

  const submit = async () => {
    if (operation || invalid || mustReplace || !count) return;
    const finish = write.beginWrite(pauseNames.length ? affected : []);
    if (!finish) return;
    const carriedModels = probe.listLoaded ? [...probe.models] : null;
    const nextStatus = draftTest ?? (matchesSaved && !modelChanged ? tested : null);
    setOperation('save');
    setError('');
    try {
      const config = {
        protocol: 'comfyui',
        baseUrl: url.trim(),
        ...(model.trim() ? { modelName: model.trim() } : {}),
        ...(secretOp.action === 'keep' && service?.config.credentialRef ? { credentialRef: service.config.credentialRef } : {}),
        ...(service?.config.timeoutMs !== undefined ? { timeoutMs: service.config.timeoutMs } : {}),
      };
      const result = await api<{ service: ImageService; maintenance?: { pausedRoleIds: string[] } }>(
        service ? `/v1/image-services/${encodeURIComponent(service.serviceId)}` : '/v1/image-services',
        { method: service ? 'PATCH' : 'POST', body: { name: name.trim(), config, ...(secretOp.action === 'replace' ? { secret: secretOp.secret } : secretOp.action === 'clear' ? { secret: null } : {}) } },
      );
      write.recordPaused(result.maintenance?.pausedRoleIds ?? []);
      saved.current = result.service;
      const nextKey = imageServiceCacheKey(result.service);
      if (savedKey && (secretOp.action !== 'keep' || nextKey !== savedKey)) clearImageModelCache(savedKey);
      if (secretOp.action !== 'keep' && nextKey !== savedKey) clearImageModelCache(nextKey);
      if (carriedModels !== null) writeImageModelCache(nextKey, carriedModels);
      if (service) {
        onUpdated?.(service.serviceId, result.service);
        if (nextStatus !== undefined) onTested?.(nextStatus);
        setName(result.service.name);
        setUrl(result.service.config.baseUrl);
        setModel(savedImageModelOf(result.service));
        setSecret(createSecretDraft(result.service.credential.status));
        if (secretOp.action !== 'keep') setSecretUpdated(secretOp.action === 'replace');
        sheet.closeNow();
      } else {
        sheet.closeNow(() => onCreated?.(result.service, nextStatus));
      }
      announceLive(`${result.service.name} ${service ? '已保存' : '已添加'}`);
    } catch (reason) {
      write.recordPaused(serviceMaintenanceOf(reason).paused);
      setError(serviceWriteFailure(reason, service ? '保存' : '添加', imageErrorText(reason), roleName));
    } finally { setOperation(null); finish(); }
  };
  const toggle = async (enabled: boolean) => {
    if (!service || operation) return;
    const finish = write.beginWrite(enabled ? [] : affected);
    if (!finish) return;
    const feedback = captureSavedSummary();
    setOperation('toggle');
    try {
      const result = await api<{ service: ImageService; maintenance?: { pausedRoleIds: string[] } }>(
        `/v1/image-services/${encodeURIComponent(service.serviceId)}`, { method: 'PATCH', body: { enabled } },
      );
      write.recordPaused(result.maintenance?.pausedRoleIds ?? []);
      if (!enabled) {
        clearImageModelCache(savedKey);
        onTested?.(null);
      }
      onUpdated?.(service.serviceId, result.service);
      announceLive(`${service.name} ${enabled ? '已全局启用' : '已全局停用'}`);
      feedback();
    } catch (reason) {
      write.recordPaused(serviceMaintenanceOf(reason).paused);
      write.reportFailure(T32.toggleFail(enabled ? '启用' : '停用', imageErrorText(reason)));
    } finally { setOperation(null); finish(); }
  };
  const remove = async () => {
    if (!service || operation || affected.length) return;
    const finish = write.beginWrite();
    if (!finish) return;
    setOperation('delete');
    setError('');
    try {
      await api(`/v1/image-services/${encodeURIComponent(service.serviceId)}`, { method: 'DELETE' });
      clearImageModelCache(savedKey);
      sheet.closeNow(() => onRemoved?.(service.serviceId));
      announceLive(`已删除生图服务「${service.name}」`);
    } catch (reason) { setError(T32.saveFail('删除', imageErrorText(reason))); } finally { setOperation(null); finish(); }
  };

  const discard = () => {
    setName(saved.current?.name ?? '');
    setUrl(saved.current?.config.baseUrl ?? '');
    setModel(savedImageModelOf(saved.current));
    setSecret(createSecretDraft(saved.current?.credential.status));
    setVisible(false);
    setError('');
    setDraftTest(null);
    onCancel?.();
  };
  const open = (group: string | undefined, trigger: HTMLElement) => {
    if (!service || write.busy) return;
    sheet.open({ id: sheetId, title: group ? `${service.name} · ${group}` : `编辑「${service.name}」`, shape: group ? 'compact' : 'full', group,
      anchor: trigger.closest<HTMLElement>('.config-sum') ?? trigger, focusReturn: trigger.matches('button') ? trigger : trigger.querySelector<HTMLElement>('.config-sum-edit') });
  };
  const names = (occupancy?.names ?? []).map(name => `${name} · 生图`);
  const savedModel = savedImageModelOf(service);
  const hasSecret = !!service && service.credential.status !== 'missing';
  const busy = operation !== null || write.busy;
  const runProbe = (action: 'test' | 'list', group: 'connection' | 'model' = 'model') => {
    setProbeGroup(group);
    if (!url.trim()) { setProbeNeedsUrl(action); return; }
    setProbeNeedsUrl(null);
    if (action === 'list') void probe.refresh(target());
    else void probe.test(target(), model);
  };
  const probeNotice = probeNeedsUrl ? { role: 'alert', source: probeNeedsUrl, text: T16.needUrl } as const : serviceProbeNotice(probe.notice, probe.models.length);
  return <div className="config-prose">
    {service && <>
      <ServiceHeading title={service.name} address={service.config.baseUrl} enabled={service.enabled} tested={tested ?? null} onEdit={anchor => open(undefined, anchor)}/>
      <ServiceRow label="连接" value="ComfyUI" keys={[service.config.baseUrl]} onOpen={anchor => open('连接', anchor)}/>
      <ServiceRow label="密钥" value={hasSecret ? '已设置' : '未设置'} keys={secretUpdated ? ['刚刚更新'] : []} status={hasSecret ? 'ok' : 'none'}
        statusText={hasSecret ? '已设置' : '未设置（选填）'} onOpen={anchor => open('密钥', anchor)}/>
      <ServiceRow label="默认模型" value={savedModel || '未设置'} keys={matchesSaved && probe.listLoaded ? [`${probe.models.length} 个可选`] : []}
        status={tested === false ? 'error' : tested ? 'ok' : 'off'} statusText={tested === false ? '连接失败' : tested ? '连接正常' : savedModel ? '尚未测试' : '未设置'} onOpen={anchor => open('默认模型', anchor)}/>
      <ServiceManagementRow name={service.name} enabled={service.enabled} busy={busy} onChange={enabled => void toggle(enabled)}/>
      <ServiceUseRow entries={names} loading={occupancy?.loading} error={occupancy?.error}/>
      <ServiceDeleteEntry id={deleteId} kind="image" disabled={busy || !!occupancy?.loading || !!occupancy?.error} activeNames={affected.map(roleName)}/>
      <ServiceDeleteSheet id={deleteId} name={service.name} occupied={names} busy={operation === 'delete'} disabled={affected.length > 0}
        error={error} onRemove={() => void remove()}/>
    </>}
    <ServiceSheet id={sheetId} active count={count} busy={operation === 'save'} onDiscard={discard} footer={<ServiceSheetActions creating={creating} count={count} busy={operation === 'save'} invalid={invalid || mustReplace} error={error} pauseNames={pauseNames} onSubmit={() => void submit()}/>}>
      {group => <>
        <MediaGroup title="名称" group={group}><div className="config-service-field-one"><Field label="生图服务名称"><Input aria-label="生图服务名称" maxLength={200} value={name} disabled={busy} placeholder={creating ? '起一个好认的名字' : undefined} onChange={event => setName(event.target.value)}/></Field></div></MediaGroup>
        <MediaGroup title="连接" group={group}>
          <div className="config-service-unlabelled"><Field label="服务地址"><Input spellCheck={false} value={url} disabled={busy} placeholder="http://127.0.0.1:8188" onChange={event => { setUrl(event.target.value); setDraftTest(null); setProbeNeedsUrl(null); probe.reset(); }}/></Field></div>
          <ServiceProbeAction busy={probe.testBusy} disabled={busy || mustReplace || probe.listBusy} notice={probeGroup === 'connection' ? probeNotice : null}
            onClick={() => runProbe('test', 'connection')}/>
          {mustReplace && <p className="config-service-form-note">{T12}</p>}
          <ServicePauseNotice names={pauseNames}/>
        </MediaGroup>
        <MediaGroup title="密钥" group={group}><SecretInput aria-label="生图密钥" placeholder={secret.hasExisting ? '留空则保留原密钥' : '选填'} disabled={busy}
          value={secret.value} visible={visible} onToggleVisible={() => setVisible(previous => !previous)}
          onFocus={event => { if (!secret.dirty && secret.value === SECRET_MASK_SENTINEL) event.currentTarget.select(); }}
          onChange={value => { setSecret(previous => nextSecretDraftOnInput(previous, value)); setDraftTest(null); probe.reset(); }}/>
          <ServicePauseNotice names={pauseNames}/>
        </MediaGroup>
        <MediaGroup title="默认模型" group={group}><ImageModelPicker settings label="默认模型" placeholder="可选，如 xxx.safetensors" value={model} onChange={value => { setModel(value); setDraftTest(null); probe.invalidateTest(); }}
          models={probe.models} listBusy={probe.listBusy} testBusy={probe.testBusy} notice={probeGroup === 'model' ? probeNotice : null}
          onRefresh={() => runProbe('list')} onTest={() => runProbe('test')} probeDisabled={mustReplace} disabled={busy}/>
        </MediaGroup>
      </>}
    </ServiceSheet>
  </div>;
}
