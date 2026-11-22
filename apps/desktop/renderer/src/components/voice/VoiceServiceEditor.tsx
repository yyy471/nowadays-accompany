import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Field, Input, Select, announceLive } from '../../ui';
import type { RoleListItem } from '../../types';
import { MediaGroup } from '../config/MediaSheet';
import {
  ServiceDeleteEntry, ServiceDeleteSheet, ServiceHeading, ServiceManagementRow, ServicePauseNotice, ServiceProbeAction,
  ServiceRow, ServiceSheet, ServiceSheetActions, ServiceUseRow, serviceMaintenanceOf, serviceWriteFailure, useServiceSheetExit,
} from '../config/ServiceParts';
import { useMediaOccupancy } from '../config/use-media-occupancy';
import { captureSavedSummary } from '../config/sheet/save-feedback';
import { useSheet } from '../config/sheet/sheet-context';
import { T10, T15, T16, T32 } from '../config/config-texts';
import { describeVoiceFailure, toVoiceServiceConfig, validateVoiceServiceDraft, type VoiceProtocol, type VoiceServiceItem } from '../../voice-config';
import { clearVoiceProbeCache, voiceServiceCacheKey, writeVoiceProbeCache } from './voice-cache';
import { useVoiceProbe, type VoiceProbeTarget } from './use-voice-probe';
import { useWrite } from '../config/write-runner';

const DEFAULT_PROTOCOL: VoiceProtocol = 'nowadays-tts-v1';

function voiceErrorText(reason: unknown): string {
  return describeVoiceFailure({ code: reason instanceof ApiError ? reason.code : undefined, message: reason instanceof Error ? reason.message : String(reason) });
}

type VoiceDraft = { name: string; protocol: VoiceProtocol; baseUrl: string; defaultEngine: string };
const toDraft = (service?: VoiceServiceItem): VoiceDraft => ({
  name: service?.name ?? '',
  protocol: service?.config.protocol ?? DEFAULT_PROTOCOL,
  baseUrl: service?.config.baseUrl ?? '',
  defaultEngine: service?.config.defaultEngine ?? '',
});

export function VoiceServiceCreate({ trigger, onCancel, onCreated }: {
  trigger: HTMLElement | null;
  onCancel: () => void;
  onCreated: (service: VoiceServiceItem, tested?: boolean | null) => void;
}) {
  return <VoiceServiceEditor trigger={trigger} onCancel={onCancel} onCreated={onCreated}/>;
}

export function VoiceServiceDetail({ service, roles, activities, tested, onTested, onUpdated, onRemoved }: {
  service?: VoiceServiceItem;
  roles: RoleListItem[];
  activities: Array<{ roleId: string; state: 'active' | 'stopping' | 'stopped' }>;
  tested?: boolean | null;
  onTested: (tested: boolean | null) => void;
  onUpdated: (changedServiceId: string, updated?: VoiceServiceItem) => void;
  onRemoved: (serviceId: string) => void;
}) {
  const occupancy = useMediaOccupancy('voice', service?.serviceId ?? '', roles, activities);
  if (!service) return null;
  const label = (id: string) => roles.find(role => role.roleId === id)?.displayName ?? id;
  return <VoiceServiceEditor service={service} occupancy={occupancy} roleName={label} tested={tested} onTested={onTested} onUpdated={onUpdated} onRemoved={onRemoved}/>;
}

function VoiceServiceEditor({ service, trigger, occupancy, roleName = id => id, tested, onTested, onCancel, onCreated, onUpdated, onRemoved }: {
  service?: VoiceServiceItem;
  trigger?: HTMLElement | null;
  occupancy?: ReturnType<typeof useMediaOccupancy>;
  roleName?: (id: string) => string;
  tested?: boolean | null;
  onTested?: (tested: boolean | null) => void;
  onCancel?: () => void;
  onCreated?: (service: VoiceServiceItem, tested?: boolean | null) => void;
  onUpdated?: (changedServiceId: string, updated?: VoiceServiceItem) => void;
  onRemoved?: (serviceId: string) => void;
}) {
  const sheet = useSheet();
  const write = useWrite();
  const saved = useRef(service);
  useEffect(() => { saved.current = service; }, [service]);
  const baseline = toDraft(service);
  const [draft, setDraft] = useState(baseline);
  const [operation, setOperation] = useState<'save' | 'toggle' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [probeAction, setProbeAction] = useState<'test' | 'probe' | null>(null);
  const [draftTest, setDraftTest] = useState<boolean | null>(null);
  const [probeNeedsUrl, setProbeNeedsUrl] = useState(false);
  const creating = !service;
  const sheetId = service ? `voice-form:${service.serviceId}` : 'new-voice-service';
  const deleteId = service ? `voice-delete:${service.serviceId}` : 'voice-delete';
  const savedKey = service ? voiceServiceCacheKey(service) : '';
  const matchesSaved = !!service && draft.protocol === baseline.protocol && draft.baseUrl.trim() === baseline.baseUrl;
  const probe = useVoiceProbe(matchesSaved ? savedKey : `${savedKey}|draft|${draft.protocol}|${draft.baseUrl}`, { shared: matchesSaved });
  const savedEngines = matchesSaved ? probe.result?.engines : undefined;
  useEffect(() => { if (creating) sheet.open({ id: sheetId, title: '添加语音服务', shape: 'full', focusReturn: trigger }); }, [creating, sheetId]);
  useServiceSheetExit(sheetId, () => { probe.cancelPending(); setProbeAction(null); setProbeNeedsUrl(false); });
  useServiceSheetExit(deleteId, () => setError(''));
  useEffect(() => () => { probe.cancelPending(); }, [probe.cancelPending]);

  const count = [
    draft.name.trim() !== baseline.name,
    draft.protocol !== baseline.protocol,
    draft.baseUrl.trim() !== baseline.baseUrl,
    draft.defaultEngine !== baseline.defaultEngine,
  ].filter(Boolean).length;
  const invalid = !draft.name.trim() ? T10.name : !draft.baseUrl.trim() ? T10.url : '';
  const affected = occupancy?.activeIds ?? [];
  const pauseNames = !creating && !matchesSaved ? affected.map(roleName) : [];
  const updateConnection = (patch: Partial<VoiceDraft>) => {
    setDraft(previous => ({ ...previous, ...patch }));
    setDraftTest(null);
    setProbeAction(null);
    setProbeNeedsUrl(false);
    setError('');
    probe.reset();
  };
  const runProbe = async (action: 'test' | 'probe') => {
    if (probe.busy || draft.protocol === 'indextts') return;
    setProbeAction(action);
    if (!draft.baseUrl.trim()) { setProbeNeedsUrl(true); return; }
    setProbeNeedsUrl(false);
    setError('');
    const target: VoiceProbeTarget = service && matchesSaved
      ? { kind: 'savedService', serviceId: service.serviceId, cacheKey: savedKey }
      : { kind: 'draft', config: { protocol: draft.protocol, baseUrl: draft.baseUrl } };
    await probe.run(target);
  };
  // 用探测日志确定真实成功或失败；取消或被更晚的字段变更取代时不会留下结果。
  useEffect(() => {
    if (!probe.notice || !probeAction) return;
    const success = probe.notice.kind === 'status';
    setDraftTest(success);
    if (matchesSaved) onTested?.(success);
  }, [probe.notice, probeAction, matchesSaved]);

  const submit = async () => {
    if (operation || invalid || !count) return;
    const problem = validateVoiceServiceDraft(draft);
    if (problem) { setError(problem); return; }
    const finish = write.beginWrite(pauseNames.length ? affected : []);
    if (!finish) return;
    const carriedProbe = probe.result;
    const nextStatus = draftTest ?? (matchesSaved ? tested : null);
    setOperation('save');
    setError('');
    try {
      const result = await api<{ service: VoiceServiceItem; maintenance?: { pausedRoleIds: string[] } }>(
        service ? `/v1/voice-services/${encodeURIComponent(service.serviceId)}` : '/v1/voice-services',
        { method: service ? 'PATCH' : 'POST', body: { name: draft.name.trim(), config: toVoiceServiceConfig(draft) } },
      );
      write.recordPaused(result.maintenance?.pausedRoleIds ?? []);
      saved.current = result.service;
      const nextKey = voiceServiceCacheKey(result.service);
      if (savedKey && nextKey !== savedKey) clearVoiceProbeCache(savedKey);
      if (carriedProbe !== null) writeVoiceProbeCache(nextKey, carriedProbe);
      if (service) {
        onUpdated?.(service.serviceId, result.service);
        if (nextStatus !== undefined) onTested?.(nextStatus);
        setDraft(toDraft(result.service));
        sheet.closeNow();
      } else {
        sheet.closeNow(() => onCreated?.(result.service, nextStatus));
      }
      announceLive(`${result.service.name} ${service ? '已保存' : '已添加'}`);
    } catch (reason) {
      write.recordPaused(serviceMaintenanceOf(reason).paused);
      setError(serviceWriteFailure(reason, service ? '保存' : '添加', voiceErrorText(reason), roleName));
    } finally { setOperation(null); finish(); }
  };

  const toggle = async (enabled: boolean) => {
    if (!service || operation) return;
    const finish = write.beginWrite(enabled ? [] : affected);
    if (!finish) return;
    const feedback = captureSavedSummary();
    setOperation('toggle');
    try {
      const result = await api<{ service: VoiceServiceItem; maintenance?: { pausedRoleIds: string[] } }>(
        `/v1/voice-services/${encodeURIComponent(service.serviceId)}`, { method: 'PATCH', body: { enabled } },
      );
      write.recordPaused(result.maintenance?.pausedRoleIds ?? []);
      if (!enabled) {
        clearVoiceProbeCache(savedKey);
        onTested?.(null);
      }
      onUpdated?.(service.serviceId, result.service);
      announceLive(`${service.name} ${enabled ? '已全局启用' : '已全局停用'}`);
      feedback();
    } catch (reason) {
      write.recordPaused(serviceMaintenanceOf(reason).paused);
      write.reportFailure(T32.toggleFail(enabled ? '启用' : '停用', voiceErrorText(reason)));
    } finally { setOperation(null); finish(); }
  };

  const remove = async () => {
    if (!service || operation || affected.length) return;
    const finish = write.beginWrite();
    if (!finish) return;
    setOperation('delete');
    setError('');
    try {
      await api(`/v1/voice-services/${encodeURIComponent(service.serviceId)}`, { method: 'DELETE' });
      clearVoiceProbeCache(savedKey);
      sheet.closeNow(() => onRemoved?.(service.serviceId));
      announceLive(`已删除语音服务「${service.name}」`);
    } catch (reason) { setError(T32.saveFail('删除', voiceErrorText(reason))); }
    finally { setOperation(null); finish(); }
  };

  const discard = () => { setDraft(toDraft(saved.current)); setError(''); setDraftTest(null); onCancel?.(); };
  const open = (group: string | undefined, trigger: HTMLElement) => {
    if (!service || write.busy) return;
    sheet.open({ id: sheetId, title: group ? `${service.name} · ${group}` : `编辑「${service.name}」`, shape: group ? 'compact' : 'full', group,
      anchor: trigger.closest<HTMLElement>('.config-sum') ?? trigger, focusReturn: trigger.matches('button') ? trigger : trigger.querySelector<HTMLElement>('.config-sum-edit') });
  };
  const names = (occupancy?.names ?? []).map(name => `${name} · 语音`);
  const engines = Object.keys(probe.result?.engines ?? {});
  const probeNotice = probeNeedsUrl ? { role: 'alert', text: T16.needUrl } : probe.notice && probeAction ? {
    role: probe.notice.kind,
    text: probe.notice.kind === 'alert' ? probeAction === 'test' ? T16.testFail(probe.notice.text) : T16.probeFail(probe.notice.text)
      : probeAction === 'test' && probe.notice.elapsedMs !== undefined ? T16.testOk(probe.notice.elapsedMs) : T16.probeOk(engines.length),
  } : null;
  const busy = operation !== null || write.busy;
  const supportsProbe = draft.protocol !== 'indextts';
  return <div className="config-prose">
    {service && <>
      <ServiceHeading title={service.name} address={service.config.baseUrl} enabled={service.enabled} tested={tested ?? undefined} onEdit={anchor => open(undefined, anchor)}/>
      <ServiceRow label="连接" value={service.config.protocol === 'indextts' ? '旧 IndexTTS 协议' : '统一语音协议'} keys={[service.config.baseUrl]} onOpen={anchor => open('连接', anchor)}/>
      <ServiceRow label="引擎" value={service.config.defaultEngine || '由服务决定'} keys={savedEngines ? [`${Object.keys(savedEngines).length} 个引擎`] : []}
        status={tested === false ? 'error' : savedEngines ? 'ok' : 'off'} statusText={tested === false ? '连接失败' : savedEngines ? '已探测' : '尚未探测'} onOpen={anchor => open('引擎', anchor)}/>
      <ServiceManagementRow name={service.name} enabled={service.enabled} busy={busy} onChange={enabled => void toggle(enabled)}/>
      <ServiceUseRow entries={names} loading={occupancy?.loading} error={occupancy?.error}/>
      <ServiceDeleteEntry id={deleteId} kind="voice" disabled={busy || !!occupancy?.loading || !!occupancy?.error} activeNames={affected.map(roleName)}/>
      <ServiceDeleteSheet id={deleteId} name={service.name} occupied={names} busy={operation === 'delete'} disabled={affected.length > 0}
        error={error} onRemove={() => void remove()}/>
    </>}
    <ServiceSheet id={sheetId} active count={count} busy={operation === 'save'} onDiscard={discard} footer={<ServiceSheetActions creating={creating} count={count} busy={operation === 'save'} invalid={invalid} error={error} pauseNames={pauseNames} onSubmit={() => void submit()}/>}>
      {group => <>
        <MediaGroup title="名称" group={group}><div className="config-service-field-one"><Field label="语音服务名称"><Input aria-label="语音服务名称" disabled={busy} maxLength={200} placeholder={creating ? '起一个好认的名字' : undefined} value={draft.name}
          onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))}/></Field></div></MediaGroup>
        <MediaGroup title="连接" group={group}>
          <div className="config-connection">
            <Field label="语音接口协议"><Select aria-label="语音接口协议" disabled={busy} value={draft.protocol} onChange={event => {
              const protocol = event.target.value as VoiceProtocol;
              updateConnection({ protocol, ...(protocol === 'indextts' ? { defaultEngine: '' } : {}) });
            }}><option value={DEFAULT_PROTOCOL}>统一语音协议（nowadays-tts-v1）</option><option value="indextts">旧 IndexTTS 协议</option></Select></Field>
            <Field label="语音服务地址"><Input aria-label="语音服务地址" disabled={busy} placeholder="http://127.0.0.1:9890" value={draft.baseUrl} spellCheck={false} onChange={event => updateConnection({ baseUrl: event.target.value })}/></Field>
          </div>
          <ServiceProbeAction busy={probe.busy && probeAction === 'test'} disabled={busy || probe.busy || !supportsProbe} notice={probeAction === 'test' ? probeNotice : null} onClick={() => void runProbe('test')}/>
          {affected.length > 0 && <div className="config-connection-feedback"><ServicePauseNotice names={pauseNames}/></div>}
        </MediaGroup>
        <MediaGroup title="引擎" group={group}>
          <div className="config-service-field-one"><Field label="默认引擎" hint={supportsProbe && !engines.length ? T15 : undefined}><Select aria-label="默认语音引擎" disabled={busy || !supportsProbe} value={draft.defaultEngine}
            onChange={event => setDraft(previous => ({ ...previous, defaultEngine: event.target.value }))}>
            <option value="">由服务决定</option>
            {engines.map(id => <option key={id} value={id}>{id}</option>)}
            {draft.defaultEngine && !engines.includes(draft.defaultEngine) && <option value={draft.defaultEngine}>{draft.defaultEngine}</option>}
          </Select></Field></div>
          <ServiceProbeAction label="探测服务" busy={probe.busy && probeAction === 'probe'} disabled={busy || probe.busy || !supportsProbe} notice={probeAction === 'probe' ? probeNotice : null} onClick={() => void runProbe('probe')}/>
        </MediaGroup>
      </>}
    </ServiceSheet>
  </div>;
}
