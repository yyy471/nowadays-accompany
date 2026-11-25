import { useState } from 'react';
import { api } from '../api';
import { Button, Select, Switch, UiThemeScope } from '../ui';
import { ExtensionSlotFrame, type Extension, type Slot } from './ExtensionSlotFrame';
import type { ExtensionState } from './use-extensions';
import '../styles/extensions.css';

function entries(items: Extension[], kind: string) {
  return items.filter(item => item.status === 'enabled').flatMap(extension =>
    extension.ui.filter(entry => entry.slot === kind).map(entry => ({
      extension, entry, key: [extension.extId, extension.version, entry.file].join('/')
    })));
}

function ExtensionRow({ item }: { item: Extension }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { await api('/v1/extensions/' + item.extId + (enabled ? '/enable' : '/disable'), { method: 'POST' }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <li><Switch label={item.extId} checked={item.status === 'enabled'} busy={busy || item.status === 'starting'}
    onCheckedChange={enabled => void toggle(enabled)}/><small>{item.version}</small>
    {(error || item.lastError) && <span role="status">{error || item.lastError?.message}</span>}</li>;
}

export function ExtensionsPage({ state }: { state: ExtensionState }) {
  const [selection, setSelection] = useState('');
  const pages = entries(state.items, 'page');
  const id = (extension: Extension, entry: Slot) => extension.extId + '/' + entry.file;
  const selected = pages.find(({ extension, entry }) => id(extension, entry) === selection) ?? pages[0];
  const widgets = entries(state.items, 'widget');
  return <UiThemeScope theme="xiacheng" className="extension-page">
    <h1>扩展</h1><section aria-label="已安装扩展">
      {state.items.length ? <ul>{state.items.map(item => <ExtensionRow key={item.extId} item={item}/>)}</ul> :
        <p role="status">{state.status || '尚未安装扩展。'}</p>}
    </section>
    {selected && <section aria-label="扩展微页">
      <label>微页 <Select value={id(selected.extension, selected.entry)} onChange={event => setSelection(event.target.value)}>
        {pages.map(({ extension, entry, key }) => <option key={key} value={id(extension, entry)}>{extension.extId} · {entry.file}</option>)}
      </Select></label>
      <ExtensionSlotFrame key={selected.key} extension={selected.extension} entry={selected.entry}/>
    </section>}
    {widgets.length > 0 && <section aria-label="扩展挂件"><h2>挂件</h2>{widgets.map(({ key, ...slot }) =>
      <ExtensionSlotFrame key={key} {...slot}/>)}</section>}
  </UiThemeScope>;
}

function Overlay({ extension, entry }: { extension: Extension; entry: Slot }) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  const dismiss = () => setClosed(true);
  return <article><header><strong>{extension.extId}</strong><Button onClick={dismiss}>关闭浮层</Button></header>
    <ExtensionSlotFrame extension={extension} entry={entry} dismiss={dismiss}/></article>;
}

export function ExtensionOverlays({ state }: { state: ExtensionState }) {
  const slots = entries(state.items, 'overlay');
  const notices = Object.values(state.notices);
  if (!slots.length && !notices.length) return null;
  return <UiThemeScope theme="xiacheng" className="extension-overlays">
    {notices.map(notice => <article key={notice.extId}><header><strong>{notice.extId}</strong>
      <Button onClick={() => state.dismiss(notice.extId)}>关闭提示</Button></header><p role="status">{notice.message}</p></article>)}
    {slots.map(({ key, ...slot }) => <Overlay key={key} {...slot}/>)}
  </UiThemeScope>;
}
