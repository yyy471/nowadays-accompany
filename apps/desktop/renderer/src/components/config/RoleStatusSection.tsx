import { useEffect, useState } from 'react';
import { api } from '../../api';
import { errorText } from '../../lib/error-text';
import { RolePortrait } from '../RolePortrait';
import { Button, Field, Input, StatusDot, Textarea } from '../../ui';
import { useSheet } from './sheet/sheet-context';
import { useWrite } from './write-runner';
import { Sheet } from './sheet/Sheet';
import { RoleExportModal, RoleTransferModal, exportRolePackage } from './RoleTransferModal';
import { SettingsRefresh, roleDisplayName, type Activity, type Resource } from './settings-shared';
import { T8, T19, T20, T21, T29, T32, T37 } from './config-texts';
import type { RoleDetail, RoleListItem } from '../../types';
import type { VoiceServiceItem } from '../../voice-config';
import type { ImageService } from '../image/ImageServiceEditor';

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

function RoleStatusCards({ roles, activities, resources, voiceServices, imageServices, loading, error, onRefresh, onRolesChanged, onChanged, onConfigure }: {
  roles: RoleListItem[]; activities: Activity[]; loading: boolean; error: string;
  resources: Resource[]; voiceServices: VoiceServiceItem[]; imageServices: ImageService[];
  onRefresh: (signal: AbortSignal) => Promise<boolean>; onRolesChanged: () => Promise<void>;
  onChanged: (activity: Activity) => void; onConfigure: (roleId: string) => void;
}) {
  const write = useWrite();
  const [pending, setPending] = useState<Record<string, 'stop' | 'resume'>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [exportRole, setExportRole] = useState<RoleListItem | null>(null);
  const [exporting, setExporting] = useState('');
  const refreshActivities = () => { void onRefresh(new AbortController().signal); };
  const exportPackage = async (role: RoleListItem, state: string | undefined) => {
    if (state !== 'stopped') {
      write.reportResult('请先停止角色活动再导出角色包', 'warning');
      return;
    }
    if (exporting) return;
    const chooser = window.nowadaysDesk?.chooseRoleExportFile;
    if (!chooser) {
      setExportRole(role);
      return;
    }
    setExporting(role.roleId);
    try {
      const file = await chooser(`${role.displayName || role.roleId}.json`);
      if (!file) return;
      await exportRolePackage(role.roleId, file);
      write.reportResult('已导出角色包');
    } catch (reason) {
      write.reportResult(`导出角色包未完成：${errorText(reason)}`, 'error');
    } finally {
      setExporting('');
    }
  };
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
  return <div className="config-prose config-status-page"><header className="config-sec-head"><h2 tabIndex={-1}>角色状态</h2><Button size="sm" onClick={() => setImportOpen(true)}>导入角色包</Button><SettingsRefresh label="刷新状态" success="状态已刷新" disabled={write.busy || write.resuming} onRefresh={onRefresh}/></header>
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
          <Button size="sm" variant="ghost" busy={exporting === role.roleId} disabled={write.busy || write.resuming || (!!exporting && exporting !== role.roleId)} onClick={() => void exportPackage(role, state)}>导出</Button>
          <button type="button" className="config-status-link" aria-label={`${role.displayName}的角色配置`} onClick={() => onConfigure(role.roleId)}>{T20.configure}</button></div>
        {errors[role.roleId] && <small className="config-status-error" role="alert">{errors[role.roleId]}</small>}
      </article>;
    })}</div>
    <RoleTransferModal open={importOpen} onClose={() => setImportOpen(false)} resources={resources} voiceServices={voiceServices} imageServices={imageServices}
      onImported={() => { void onRolesChanged(); refreshActivities(); }} onActivityChanged={refreshActivities}/>
    <RoleExportModal open={Boolean(exportRole)} role={exportRole} onClose={() => setExportRole(null)}/>
  </div>;
}

export { RoleFooterIdentity, RoleStatusCards, WorkspaceSheets };
