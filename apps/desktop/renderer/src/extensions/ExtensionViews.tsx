import { useState } from 'react';
import { api } from '../api';
import { Button, Field, Select, Switch, UiThemeScope } from '../ui';
import { useSurfaceDismiss } from '../ui/surface-dismiss';
import { ExtensionSlotFrame, type Extension, type Slot } from './ExtensionSlotFrame';
import type { ExtensionState } from './use-extensions';
import type { RoleListItem } from '../types';
import { toolScopeLabel } from './tool-scope';
import { faultFingerprint, hasExtensionFault } from './repair-request';
import '../styles/extensions.css';

function entries(items: Extension[], kind: string) {
  return items.filter(item => item.status === 'enabled').flatMap(extension =>
    extension.ui.filter(entry => entry.slot === kind).map(entry => ({
      extension, entry, key: [extension.extId, extension.version, entry.file].join('/')
    })));
}

interface RepairTarget {
  seat: RoleListItem | undefined;
  sendRepair: ExtensionState['sendRepair'];
}

function RepairAction({ item, seat, sendRepair }: RepairTarget & { item: Extension }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof sendRepair>>>();
  async function send() {
    setBusy(true);
    setResult(await sendRepair(seat, item));
    setBusy(false);
  }
  return <div className="extension-repair">
    <Button size="sm" busy={busy} disabled={busy || result?.sent} onClick={() => void send()}>交给主角色修复</Button>
    <p role="status">{result?.notice}</p>
  </div>;
}

function ExtensionRow({ item, roles, seat, sendRepair }: RepairTarget & { item: Extension; roles: RoleListItem[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { await api('/v1/extensions/' + item.extId + (enabled ? '/enable' : '/disable'), { method: 'POST' }); }
    catch { setError(enabled ? '暂时无法启用此扩展。' : '暂时无法停用此扩展。'); }
    finally { setBusy(false); }
  };
  return <li>
    <Switch label={item.extId} checked={item.status === 'enabled'} busy={busy || item.status === 'starting'}
      onCheckedChange={enabled => void toggle(enabled)}/>
    <small className="extension-version" title={item.version}>{item.version}</small>
    {item.tools.map(tool => <p key={tool.name} className="extension-tool">{tool.name} → {toolScopeLabel(tool, roles)}</p>)}
    {(error || item.lastError) && <span className="extension-error" role="status">{error || item.lastError?.message}</span>}
    {hasExtensionFault(item) && <RepairAction key={faultFingerprint(item)} item={item} seat={seat} sendRepair={sendRepair}/>}
  </li>;
}

export function ExtensionsPage({ state, roles, seat }: { state: ExtensionState; roles: RoleListItem[]; seat: RepairTarget['seat'] }) {
  const [selection, setSelection] = useState('');
  const pages = entries(state.items, 'page');
  const id = (extension: Extension, entry: Slot) => extension.extId + '/' + entry.file;
  const selected = pages.find(({ extension, entry }) => id(extension, entry) === selection) ?? pages[0];
  const widgets = entries(state.items, 'widget');
  const hasSlots = Boolean(selected || widgets.length);
  return <UiThemeScope theme="xiacheng" className="extension-page">
    <h1>扩展</h1>
    <div className="extension-layout" data-has-slots={hasSlots || undefined}>
      <section className="extension-catalog" aria-labelledby="extension-catalog-heading">
        <h2 id="extension-catalog-heading">已安装扩展</h2>
        {state.items.length ? <ul>{state.items.map(item =>
          <ExtensionRow key={item.extId} item={item} roles={roles} seat={seat} sendRepair={state.sendRepair}/>)}</ul> :
          <p role="status">{state.status || '尚未安装扩展。'}</p>}
      </section>
      {hasSlots && <div className="extension-slots">
        {selected && <section aria-label="扩展微页">
          <Field label="微页">
            <Select value={id(selected.extension, selected.entry)} onChange={event => setSelection(event.target.value)}>
              {pages.map(({ extension, entry, key }) => <option key={key} value={id(extension, entry)}>{extension.extId} · {entry.file}</option>)}
            </Select>
          </Field>
          <ExtensionSlotFrame key={selected.key} roles={roles} extension={selected.extension} entry={selected.entry}/>
        </section>}
        {widgets.length > 0 && <section aria-labelledby="extension-widget-heading">
          <h2 id="extension-widget-heading">挂件</h2>
          <div className="extension-widget-grid">
            {widgets.map(({ key, ...slot }) => <ExtensionSlotFrame key={key} roles={roles} {...slot}/>)}
          </div>
        </section>}
      </div>}
    </div>
  </UiThemeScope>;
}

function Overlay({ extension, entry, roles, dismiss }: { extension: Extension; entry: Slot; roles: RoleListItem[]; dismiss: () => void }) {
  const { surface, closing, close } = useSurfaceDismiss<HTMLElement>(dismiss);
  return <article ref={surface} className="ui-floating-surface" data-closing={closing || undefined} inert={closing}>
    <header><strong>{extension.extId}</strong><Button aria-label="关闭扩展浮层" onClick={close}>关闭</Button></header>
    <ExtensionSlotFrame roles={roles} extension={extension} entry={entry} dismiss={close}/>
  </article>;
}

function ExtensionNotice({ notice, dismiss }: { notice: ExtensionState['notices'][string]; dismiss: () => void }) {
  const { surface, closing, close } = useSurfaceDismiss<HTMLElement>(dismiss);
  return <article ref={surface} className="ui-floating-surface" data-closing={closing || undefined} inert={closing}>
    <header><strong>{notice.extId}</strong><Button onClick={close}>关闭提示</Button></header>
    <p role="status">{notice.message}</p>
  </article>;
}

export function ExtensionOverlays({ state, roles }: { state: ExtensionState; roles: RoleListItem[] }) {
  const [closed, setClosed] = useState<string[]>([]);
  const slots = entries(state.items, 'overlay').filter(slot => !closed.includes(slot.key));
  const notices = Object.values(state.notices);
  if (!slots.length && !notices.length) return null;
  return <UiThemeScope theme="xiacheng" className="extension-overlays">
    {notices.map(notice => <ExtensionNotice key={notice.receiptId} notice={notice} dismiss={() => state.dismiss(notice)}/>)}
    {slots.map(({ key, ...slot }) => <Overlay key={key} roles={roles} {...slot} dismiss={() => setClosed(previous => [...previous, key])}/>)}
  </UiThemeScope>;
}
