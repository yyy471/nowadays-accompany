import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Icon, StatusDot } from '../../ui';
import { Sheet } from './sheet/Sheet';
import { useSheet } from './sheet/sheet-context';
import { useWrite } from './write-runner';
import { ARIA, T8, T29, T35, T35_RETRY } from './config-texts';
import { rowDotVisible } from './summary';
import type { ConfigDraftState } from '../config-draft';

type Status = 'ok' | 'off' | 'error' | 'dirty' | 'none';
export type MediaSummaryStatus = { status: Status; label: string };

/** 生图／语音共用摘要及纸笺：字段和真实写入仍由各面板持有。 */
export function MediaRow({ id, label, value, keys, status, statusText }: {
  id: string; label: string; value: string; keys: Array<{ label: string; value: string; group: string }>;
  status: Status; statusText: string;
}) {
  const { open } = useSheet();
  const show = (group?: string, anchor?: HTMLElement) => open({ id: `media:${id}`, title: group ? `${label} · ${group}` : `编辑${label}`, shape: group ? 'compact' : 'full', group, anchor: anchor?.closest<HTMLElement>('.config-sum') ?? anchor, focusReturn: anchor?.matches('button') ? anchor : anchor?.querySelector<HTMLElement>('.config-sum-edit') });
  return <div className="config-sum" data-edit={`media:${id}`}
    onClick={event => show(undefined, event.currentTarget)}>
    <span className="config-sum-name"><strong>{label}</strong></span>
    <span className="config-sum-val"><b><button type="button" className="config-chip-v" onClick={event => { event.stopPropagation(); show('服务', event.currentTarget); }} onKeyDown={event => event.stopPropagation()}>{value}</button></b>
      {keys.length > 0 && <span className="config-sum-keys">{keys.map(key => <button type="button" className="config-chip-k" key={key.label} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); show(key.group, event.currentTarget); }}>{key.value}</button>)}</span>}
    </span>
    <span className="config-sum-end"><StatusDot status={status} label={statusText} bare={!rowDotVisible(status)} faint={!rowDotVisible(status)}/><span className="config-sum-slot"><button type="button" className="config-sum-edit" onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); show(undefined, event.currentTarget); }} aria-label={`编辑${label}`}><Icon name="edit" size={13}/>编辑</button><span className="config-sum-slot-ghost" aria-hidden="true"><Icon name="edit" size={13}/>编辑</span></span></span>
  </div>;
}

export function MediaStateRow({ label, loading, error, onRetry }: { label: string; loading: boolean; error: string; onRetry: () => void }) {
  if (!loading) return <div className="config-load-err" role="alert"><StatusDot status="error" label={T35(error)}/><Button size="sm" onClick={onRetry}>{T35_RETRY}</Button></div>;
  return <div className="config-sum config-skel" aria-busy="true" aria-label={label}><span className="config-sum-name"><i/></span><span className="config-sum-val"><i/><i className="short"/></span></div>;
}

export function MediaGroup({ title, group, children }: { title: string; group?: string; children: ReactNode }) {
  return <div className="config-grp" data-config-group={title} data-sheet-group={group === title || undefined} hidden={Boolean(group && group !== title)}>
    <div className="config-grp-label"><b>{title}</b></div><div className="config-grp-fields">{children}</div>
  </div>;
}

export function SheetHost({ id, active, state, children, footer }: { id: string; active: boolean; state: ConfigDraftState; children: (group?: string) => ReactNode; footer: ReactNode }) {
  const { sheet, setDirty, setBusy, discardToken, closedSaved } = useSheet();
  const owned = active && sheet?.id === id;
  const lastGroup = useRef<string | undefined>(undefined);
  const ownsDiscard = useRef(false);
  const latestState = useRef(state);
  latestState.current = state;
  if (owned) { lastGroup.current = sheet?.group; ownsDiscard.current = true; }
  else if (sheet) ownsDiscard.current = false;
  useEffect(() => { if (owned) { setDirty(state.dirty, state.count ?? (state.dirty ? 1 : 0)); setBusy(state.busy); } }, [owned, state.dirty, state.count, state.busy, setDirty, setBusy]);
  useEffect(() => {
    if (!discardToken || !ownsDiscard.current) return;
    ownsDiscard.current = false;
    if (!closedSaved) latestState.current.discard();
  }, [discardToken, closedSaved]);
  return <Sheet idPrefix={id} enabled={active} footer={footer}><div className="config-sheet-groups">{children(lastGroup.current)}</div></Sheet>;
}

export function MediaSheet({ id, active, state, children, footer }: { id: string; active: boolean; state: ConfigDraftState; children: (group?: string) => ReactNode; footer: ReactNode }) {
  return <SheetHost id={`media:${id}`} active={active} state={state} footer={footer}>{children}</SheetHost>;
}

export function RoleSaveActions({ count, pause, busy, invalid = false, error, onSave }: {
  count: number; pause: boolean; busy: boolean; invalid?: boolean; error?: string; onSave: () => void;
}) {
  const { requestClose } = useSheet();
  const write = useWrite();
  const enabled = count > 0 && !invalid;
  const pausing = busy && pause && write.phase === 'pause';
  const status = busy ? pausing ? T29.pausing : T29.saving : error ? T29.retry('保存') : pause && count > 0 ? '暂停并保存' : '保存';
  return <div className="config-sheet-actions config-role-save-actions">
    <div className="config-sheet-spacer" role={error ? 'alert' : undefined}>{error || (pausing ? write.pauseNotice || status : busy ? status : count > 0 ? T8.dirty(count) : '')}</div>
    <button className="config-sheet-cancel" type="button" disabled={busy || write.busy} onClick={() => requestClose()}>取消</button>
    <button className="config-save-btn" type="button" data-on={enabled || undefined} disabled={!enabled || busy || write.busy} onClick={onSave}
      aria-label={busy || error ? undefined : count === 0 ? ARIA.saveIdle : invalid ? ARIA.saveInvalid : pause ? T29.pauseAndSave(count) : ARIA.saveCount(count)}>
      {status}<span className="config-save-n" aria-hidden="true">{!busy && !error && enabled ? count : ''}</span>
    </button>
  </div>;
}
