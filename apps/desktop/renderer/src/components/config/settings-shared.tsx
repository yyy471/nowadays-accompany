import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, ControlButton, Field, Icon, Input, Select } from '../../ui';
import { useSheet } from './sheet/sheet-context';
import { useWrite } from './write-runner';
import { ServiceSheet, ServiceSheetActions } from './ServiceParts';
import { T29, T30, T31, T38 } from './config-texts';
import {
  defaultModelBaseUrl,
  hasVertexSafety,
  MODEL_ADAPTER_OPTIONS,
  parseVertexLocation,
  vertexLocationAddress,
  vertexSafetyOf,
  type VertexLocation,
  type VertexSafetyLevel,
} from '../model/model-picker';
import type { RoleListItem } from '../../types';

export type Resource = { resourceId: string; adminSeatOnly?: boolean; kind: 'model' | 'mcp' | 'skill'; name: string; enabled: boolean; config: Record<string, unknown>; credential?: { status: string; reference?: string | null; resolvable: boolean }; lastTest?: { ok: boolean; stale: boolean; modelName: string } | null };

export function savedModelNameOf(resource: Resource): string {
  if (typeof resource.config.modelName === 'string' && resource.config.modelName.trim()) {
    return resource.config.modelName.trim();
  }
  return resource.lastTest?.modelName ?? '';
}
export type Binding = { capability: string; resourceId: string; modelName: string | null; enabled: boolean };
export type Activity = { roleId: string; state: 'active' | 'stopping' | 'stopped'; running: boolean; initStatus: string };
export type RoleSection = 'profile' | 'look' | 'models' | 'ext' | 'quota' | 'done';
export type SettingsSection = 'model' | 'mcp' | 'skill' | 'roles' | 'usage' | 'local' | 'engineering';
export type OpenSettingsOptions = {
  modelKind?: 'model' | 'voice' | 'image';
  resourceId?: string;
  newImageService?: boolean;
  newVoiceService?: boolean;
};
export type Draft = { name: string; definition: string; revision: number; payload: Record<string, unknown>; isBuiltin: boolean; bio: string };
export const roleSections: Array<[RoleSection, string, string]> = [['profile', '设定', '关于这个人'], ['look', '外观', '立绘与服饰'], ['models', '模型', '对话与演出'], ['ext', '扩展', '工具与知识'], ['quota', '自主额度', '属于自己的时间'], ['done', '完成度', '慢慢补全']];
export const settingSections: Array<[SettingsSection, string, string]> = [['model', '模型', '服务与连接'], ['mcp', 'MCP', '工具服务'], ['skill', 'Skill', '方法与知识'], ['roles', '角色状态', '活动与停止'], ['usage', '用量', 'Token 消耗'], ['local', '本机', '此设备的偏好'], ['engineering', '工程', '工程模型与调度']];
export const wideSection = (id: string) => id === 'roles' || id === 'usage' || id === 'engineering';
export const modelBaseUrlPlaceholder = (adapter: string) => defaultModelBaseUrl(adapter) || 'https://…/v1';
export const modelAdapterLabel = (adapter: string) => MODEL_ADAPTER_OPTIONS.find(option => option.value === adapter)?.label ?? adapter;
export type RoleDirty = { profile: boolean; models: boolean; voice: boolean; image: boolean; ext: boolean; quota: boolean };
export type RoleEditorState = { dirty: RoleDirty; busy: boolean; profileCount: number; discardProfile: () => void; discard: () => void };
export type WorkspaceRequest = { kind: 'create' } | { kind: 'section'; section: 'models'; roleId: string }
  | { kind: 'section'; section: 'ext'; roleId: string; resourceId: string }
  | { kind: 'settings'; section: SettingsSection; modelKind?: 'model' | 'voice' | 'image' };
export type ConfigNavigationGuard = (next: string, proceed: () => void) => void;

export function useModelAddress(initial: string, initialRouting?: unknown) {
  const [raw, setRaw] = useState(initial);
  const [routing, setRouting] = useState(initialRouting);
  const [edited, setLocation] = useState<VertexLocation>();
  const parsed = parseVertexLocation(raw);
  const location = edited ?? (parsed && !parsed.region && routing === 'manual' ? { ...parsed, region: 'express' } : parsed);
  const { url, error } = edited ? vertexLocationAddress(edited) : { url: raw, error: '' };
  const setAddress = (value: string, mode?: unknown) => { setRaw(value); setRouting(mode); setLocation(undefined); };
  return { url, error, location, manualExpress: location?.region.trim() === 'express', setAddress, setLocation };
}

export function ModelConnectionInputs({ adapter, address, safety, disabled, onAdapter, onAddress, onSafety }: {
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

export function NewModelSheet({ active, trigger, count, busy, invalid, error, onSave, onCancel, children }: { active: boolean; trigger: HTMLElement | null; count: number; busy: boolean; invalid: string; error: string; onSave: () => void; onCancel: () => void; children: (group?: string) => ReactNode }) {
  const sheet = useSheet();
  useEffect(() => { if (active) sheet.open({ id: 'new-model-service', title: '添加模型服务', shape: 'full', focusReturn: trigger }); }, [active]);
  return <ServiceSheet id="new-model-service" active={active} count={count} busy={busy} onDiscard={onCancel} footer={<ServiceSheetActions creating count={count} busy={busy} invalid={invalid} error={error} onSubmit={onSave}/>}>{children}</ServiceSheet>;
}

export function SettingsRefresh({ label, success, disabled, onRefresh }: { label: string; success: string; disabled?: boolean; onRefresh: (signal: AbortSignal) => Promise<boolean> }) {
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

/** 为保存而暂停的角色提供一键恢复（T30），两页页脚右侧共用。 */
export function PausedRolesFooter({ roles, controller }: { roles: RoleListItem[]; controller: React.MutableRefObject<ReturnType<typeof useWrite> | null> }) {
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
export function RoleDeleteEntry({ roleCount, isBuiltin }: { roleCount: number; isBuiltin: boolean }) {
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

/** 将角色 ID 解析为用户可读的展示名，缺失时退回 ID。 */
export function roleDisplayName(roles: RoleListItem[], roleId: string): string {
  return roles.find(item => item.roleId === roleId)?.displayName || roleId;
}
