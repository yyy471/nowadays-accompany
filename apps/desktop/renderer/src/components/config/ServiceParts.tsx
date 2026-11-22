import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { Button, Icon, StatusDot, type DotStatus } from '../../ui';
import type { ProbeNotice } from '../model/model-picker';
import { SheetHost } from './MediaSheet';
import { Sheet } from './sheet/Sheet';
import { useSheet } from './sheet/sheet-context';
import { useWrite } from './write-runner';
import { ARIA, T8, T13, T14, T16, T17, T29, T31, T32, T35, T35_RETRY, T36 } from './config-texts';

export type ServiceKind = 'model' | 'voice' | 'image' | 'mcp' | 'skill';
export const SERVICE_NAMES: Record<ServiceKind, string> = { model: '模型服务', voice: '语音服务', image: '生图服务', mcp: 'MCP', skill: 'Skill' };
const SERVICE_ROW_COUNTS: Record<ServiceKind, number> = { model: 5, voice: 4, image: 5, mcp: 4, skill: 3 };
export const serviceAction = (verb: string, kind: ServiceKind) => `${verb}${kind === 'mcp' || kind === 'skill' ? ' ' : ''}${SERVICE_NAMES[kind]}`;

export function serviceHost(address: string): string {
  try { return new URL(address).host; } catch { return address.trim(); }
}

export function serviceStatus(enabled: boolean, tested?: boolean | null): [DotStatus, string] {
  if (!enabled) return ['off', '已全局停用'];
  if (tested === false) return ['error', '连接失败'];
  if (tested === true) return ['ok', '已启用 · 连接正常'];
  return tested === null ? ['off', '已启用 · 尚未测试'] : ['ok', '已启用'];
}

export interface ServiceIndexEntry {
  id: string;
  name: string;
  subtitle: string;
  status: [DotStatus, string];
}

export function ServiceIndex({ kind, entries, selected, loading, onSelect, onAdd }: {
  kind: ServiceKind;
  entries: ServiceIndexEntry[];
  selected: string;
  loading: boolean;
  onSelect: (id: string) => void;
  onAdd: (anchor: HTMLElement) => void;
}) {
  return <div className="config-index-list" aria-busy={loading || undefined}>
    {loading ? Array.from({ length: 3 }, (_, index) => <div key={index} className="config-index-item config-skel" aria-hidden="true"><i/><i className="short"/></div>) : <>
      {entries.map((entry, index) => <button type="button" className="config-index-item" key={entry.id} data-resource-id={entry.id} data-selected={entry.id === selected} aria-current={entry.id === selected ? 'true' : undefined} onClick={() => onSelect(entry.id)}>
        <small>{String(index + 1).padStart(2, '0')}</small>
        <strong title={entry.name}>{entry.name}</strong>
        <StatusDot status={entry.status[0]} label={entry.status[1]} bare/>
        <span className="config-index-sub" title={entry.subtitle}>{entry.subtitle}</span>
      </button>)}
      <button type="button" className="config-index-new" onClick={event => onAdd(event.currentTarget)}>＋ {serviceAction('添加', kind)}</button>
    </>}
  </div>;
}

export function ServiceIndexState({ kind, loading, error, onRetry, onAdd }: {
  kind: ServiceKind;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onAdd: (anchor: HTMLElement) => void;
}) {
  return <div className="config-prose">
    <header className="config-sec-head" aria-busy={loading || undefined}><h2 tabIndex={-1}>{SERVICE_NAMES[kind]}</h2></header>
    {loading ? <div aria-busy="true">{Array.from({ length: SERVICE_ROW_COUNTS[kind] }, (_, index) => <div key={index} className="config-sum config-skel" aria-hidden="true"><i/><span><i/><i className="short"/></span></div>)}</div>
      : error ? <div className="config-catalog-empty" role="alert"><StatusDot status="error" label={T35(error)}/><Button size="sm" onClick={onRetry}>{T35_RETRY}</Button></div>
      : <div className="config-catalog-empty"><p>{T36.kind(SERVICE_NAMES[kind])}</p><Button size="sm" data-empty-add onClick={event => onAdd(event.currentTarget)}>＋ {serviceAction('添加', kind)}</Button></div>}
  </div>;
}

export function ServiceHeading({ title, address, enabled, tested, onEdit }: { title: string; address: string; enabled: boolean; tested?: boolean | null; onEdit: (anchor: HTMLElement) => void }) {
  const [status, label] = serviceStatus(enabled, tested);
  return <header className="config-sec-head config-service-head"><div className="config-service-line"><h2 tabIndex={-1} title={title}>{title}</h2><StatusDot status={status} label={label} bare faint/><button type="button" className="config-service-edit" aria-label={ARIA.editItem(title)} onClick={event => onEdit(event.currentTarget)}><Icon name="edit" size={13}/>编辑</button><p title={address}>{address}</p></div></header>;
}

export function ServiceRow({ label, value, fullValue, keys = [], status = 'ok', statusText = '已保存', onOpen, children }: { label: string; value: string; fullValue?: string; keys?: string[]; status?: DotStatus; statusText?: string; onOpen?: (anchor: HTMLElement) => void; children?: ReactNode }) {
  return <div className={`config-sum${onOpen ? '' : ' ro'}${children ? ' config-switch-row' : ''}${fullValue !== undefined ? ' config-use-row' : ''}`} data-service-group={label} onClick={onOpen ? event => onOpen(event.currentTarget) : undefined}>
    <span className="config-sum-name"><strong>{label}</strong></span><span className="config-sum-val"><b title={fullValue || value}>{value}</b>{keys.filter(Boolean).length > 0 && <span className="config-sum-keys">{keys.filter(Boolean).map((key, index) => <span key={index} title={key}>{key}</span>)}</span>}</span>
    <span className="config-sum-end"><StatusDot status={status} label={statusText} bare={status === 'ok' || status === 'none' || status === 'follow'} faint={status === 'ok' || status === 'none' || status === 'follow'}/><span className="config-sum-slot"><span className="config-sum-slot-ghost" aria-hidden="true"><Icon name="edit" size={13}/>编辑</span>{onOpen ? <button type="button" className="config-sum-edit" aria-label={`编辑${label}`} onClick={event => { event.stopPropagation(); onOpen(event.currentTarget); }}><Icon name="edit" size={13}/>编辑</button> : children}</span></span>
  </div>;
}

export function ServiceManagementRow({ name, enabled, busy, disabled, onChange }: { name: string; enabled: boolean; busy: boolean; disabled?: boolean; onChange: (enabled: boolean) => void }) {
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => { if (!busy) setPending(null); }, [busy]);
  const checked = busy ? pending ?? enabled : enabled;
  return <ServiceRow label="管理" value={enabled ? '全局启用' : '全局停用'} status={enabled ? 'ok' : 'off'} statusText={enabled ? '已启用' : '已全局停用'}>
    <input type="checkbox" className="config-service-switch" role="switch" aria-label={ARIA.enableService(name)} aria-busy={busy || undefined} aria-checked={checked} checked={checked} disabled={busy || disabled} onChange={event => { setPending(event.target.checked); onChange(event.target.checked); }}/>
  </ServiceRow>;
}

export function ServiceUseRow({ entries, loading, error }: { entries: string[]; loading?: boolean; error?: string }) {
  const full = entries.join('；');
  const short = entries.length > 3 ? `${entries.slice(0, 3).join('；')} …等 ${entries.length} 位` : full;
  return <ServiceRow label="占用" value={error ? '读取失败' : loading ? '正在读取…' : short || '无'} fullValue={full}
    status={error ? 'error' : entries.length ? 'ok' : 'none'} statusText={error ? error : loading ? '正在读取' : entries.length ? `${entries.length} 位角色在用` : '未被使用'}/>;
}

export function ServiceDeleteEntry({ id, kind, disabled, activeNames, blocker }: { id: string; kind: ServiceKind; disabled: boolean; activeNames: string[]; blocker?: string }) {
  const { open } = useSheet();
  const hint = activeNames.length > 0 ? T17(activeNames) : blocker;
  const hintId = `${id}-reason`;
  return <div className="config-danger-row"><Button variant="default" size="sm" className="config-danger-outline" disabled={disabled || activeNames.length > 0} aria-describedby={hint ? hintId : undefined}
    onClick={event => open({ id, title: T31.service.title(SERVICE_NAMES[kind]), shape: 'confirm', anchor: event.currentTarget.closest<HTMLElement>('.config-danger-row'), focusReturn: event.currentTarget })}>{serviceAction('删除', kind)}…</Button>
    {hint && <span id={hintId} className="config-inline-hint" title={hint}>{hint}</span>}
  </div>;
}

export function ServicePauseNotice({ names }: { names: string[] }) {
  return names.length ? <p className="config-service-form-note">{T13(names)}</p> : null;
}

export function serviceProbeNotice(notice: ProbeNotice | null, count: number): ProbeNotice | null {
  if (!notice) return null;
  const reason = notice.text.replace(/^(读取失败|测试失败|连接失败)[：:]\s*/, '');
  const text = notice.role === 'alert'
    ? notice.source === 'list' ? T16.readFail(reason) : T16.testFail(reason)
    : notice.source === 'list' ? T16.readOk(count) : `✓ ${notice.text}`;
  return { ...notice, text };
}

export function ServiceProbeAction({ label = '测试连接', busy = false, disabled, notice, onClick }: {
  label?: string; busy?: boolean; disabled?: boolean; notice?: { role: string; text: string } | null; onClick: () => void;
}) {
  return <div className="config-service-probe-action"><Button size="sm" disabled={busy || disabled} onClick={onClick}>{busy ? label === '探测服务' ? T16.probing : T16.testing : label}</Button>
    {notice && <p className={notice.role === 'alert' ? 'config-sheet-error' : 'config-muted'} role={notice.role === 'alert' ? 'alert' : 'status'}>{notice.text}</p>}
  </div>;
}

export function ServiceDeleteSheet({ id, active = true, name, occupied, voiceCopies = [], busy, disabled, error, onRemove }: {
  id: string; active?: boolean; name: string; occupied: string[]; voiceCopies?: string[]; busy: boolean; disabled?: boolean; error?: string; onRemove: () => void;
}) {
  const sheet = useSheet();
  const owned = active && sheet.sheet?.id === id;
  useEffect(() => { if (owned) sheet.setBusy(busy); }, [owned, busy, sheet.setBusy]);
  return <Sheet idPrefix={id} enabled={active} footer={<div className="config-sheet-actions config-service-delete-actions"><span className="config-sheet-spacer"/>
    <button type="button" data-sheet-focus disabled={busy} onClick={() => sheet.requestClose()}>{T31.cancel}</button>
    <Button variant="danger" disabled={busy || disabled} onClick={onRemove}>{busy ? T29.deleting : error ? T29.retry(T31.delete) : T31.delete}</Button>
  </div>}>
    <p className="config-service-delete-ask">{T31.service.ask(name)}</p>
    <p className="config-muted">{occupied.length ? T31.service.inUse(occupied.join('；')) : T31.service.unused}</p>
    {voiceCopies.length > 0 && <p className="config-muted">{T31.service.voiceCopies(voiceCopies.join('、'), voiceCopies.length)}</p>}
    {error && <p className="config-sheet-error" role="alert">{error}</p>}
  </Sheet>;
}

export function serviceMaintenanceOf(error: unknown): { paused: string[]; unconfirmed: string[] } {
  if (!(error instanceof ApiError) || typeof error.details !== 'object' || !error.details) return { paused: [], unconfirmed: [] };
  const details = error.details as { pausedRoleIds?: unknown; maintenance?: { pausedRoleIds?: unknown }; roles?: Array<{ roleId: string }> };
  const ids = details.maintenance?.pausedRoleIds ?? details.pausedRoleIds;
  return {
    paused: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
    unconfirmed: error.code === 'ROLES_NOT_STOPPED' && Array.isArray(details.roles) ? details.roles.map(role => role.roleId) : [],
  };
}

export function serviceWriteFailure(error: unknown, verb: string, reason: string, label: (id: string) => string): string {
  const { paused, unconfirmed } = serviceMaintenanceOf(error);
  if (unconfirmed.length) return T32.pauseFail(unconfirmed.map(label));
  return paused.length ? T32.saveFailPaused(verb, reason, paused.map(label)) : T32.saveFail(verb, reason);
}

export function ServiceSheetActions({ count, creating, busy, invalid, blockedReason, error, pauseNames = [], onSubmit }: {
  count: number; creating?: boolean; busy: boolean; invalid?: string | boolean; blockedReason?: string; error?: string; pauseNames?: string[]; onSubmit: () => void;
}) {
  const { requestClose } = useSheet();
  const write = useWrite();
  const reasonId = useId();
  const waiting = pauseNames.length > 0;
  const pausing = busy && waiting && write.phase === 'pause';
  const blocked = busy || write.busy || write.resuming || !!invalid || !!blockedReason || count === 0;
  const showCount = !creating && count > 0 && !invalid && !busy && !error;
  const showBlockedReason = !busy && !error && !invalid && count > 0 && !!blockedReason;
  const label = busy ? pausing ? T29.pausing : T29.saving : error ? T29.retry(creating ? '添加' : '保存') : creating ? T29.add : waiting ? '暂停并保存' : '保存';
  return <div className="config-sheet-actions config-service-actions">
    <div className="config-service-action-status">
      {error ? <span className="config-sheet-error" role="alert">{error}</span> : busy ? pausing ? T29.pausingRoles(pauseNames) : T29.saving : typeof invalid === 'string' && invalid && count ? invalid : showBlockedReason ? <span id={reasonId}>{blockedReason}</span> : count ? creating ? T8.filled(count) : T8.dirty(count) : null}
    </div>
    {!busy && !error && waiting && <span className="config-service-action-dep" title={pauseNames.join('、')}>{T14(pauseNames)}</span>}
    <button className="config-sheet-cancel" type="button" disabled={busy} onClick={() => requestClose()}>取消</button>
    <button className="config-save-btn" type="button" data-on={count > 0 && !invalid && !blockedReason || undefined} disabled={blocked} onClick={onSubmit} aria-describedby={showBlockedReason ? reasonId : undefined}
      aria-label={!busy && !error ? creating ? invalid ? ARIA.addNeedRequired : undefined : count === 0 ? ARIA.saveIdle : invalid ? ARIA.saveInvalid : waiting ? T29.pauseAndSave(count) : ARIA.saveCount(count) : undefined}>{label}{!creating && <span className="config-save-n" data-count-hidden={!showCount || undefined} aria-hidden="true">{showCount ? ` ${count}` : ''}</span>}</button>
  </div>;
}

export function ServiceSheet({ id, active, dirty, count, busy, onDiscard, footer, children }: { id: string; active: boolean; dirty?: boolean; count?: number; busy: boolean; onDiscard: () => void; footer: ReactNode; children: (group?: string) => ReactNode }) {
  const changes = count ?? (dirty ? 1 : 0);
  return <SheetHost id={id} active={active} state={{ dirty: changes > 0, count: changes, busy, discard: onDiscard }} footer={footer}>{group => <div className="config-service-form">{children(group)}</div>}</SheetHost>;
}

export function useServiceSheetExit(id: string, onExit: () => void) {
  const { sheet } = useSheet();
  const wasOpen = useRef(false);
  const exit = useRef(onExit);
  exit.current = onExit;
  const open = sheet?.id === id;
  useEffect(() => {
    if (wasOpen.current && !open) exit.current();
    wasOpen.current = open;
  }, [open]);
}
