import { PaperSkeleton } from '../components/PaperSkeleton';
import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Field, Select, Switch, UiThemeScope } from '../ui';
import { useSurfaceDismiss } from '../ui/surface-dismiss';
import { ExtensionSlotFrame, type Extension, type Slot } from './ExtensionSlotFrame';
import type { ExtensionState } from './use-extensions';
import type { RoleListItem } from '../types';
import { toolScopeLabel } from './tool-scope';
import type { RoleFaceImage } from '../components/RoleFace';
import { catalogForRole, catalogStatus, entries, resolveDesk, slotId, type DeskPosition } from './desk';
import { hasExtensionFault } from './repair-request';
import '../styles/extensions.css';

interface RepairTarget {
  seat: RoleListItem | undefined;
  repairs: ExtensionState['repairs'];
}

function RepairAction({ item, seat, repairs }: RepairTarget & { item: Extension }) {
  const record = repairs.read(seat, item);
  const result = record?.result;
  return <div className="extension-repair">
    <Button size="sm" busy={!!record?.flight} disabled={result?.sent}
      onClick={() => void repairs.send(seat, item)}>{result?.sent ? result.notice : '交给主角色修复'}</Button>
    {result && <p className={result.sent ? 'nd-visually-hidden' : undefined} role={result.sent ? 'status' : 'alert'}>{result.notice}</p>}
  </div>;
}

function ExtensionRow({ item, roles, seat, repairs }: RepairTarget & { item: Extension; roles: RoleListItem[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { await api('/v1/extensions/' + item.extId + (enabled ? '/enable' : '/disable'), { method: 'POST' }); }
    catch { setError(enabled ? '暂时无法启用此扩展。' : '暂时无法停用此扩展。'); }
    finally { setBusy(false); }
  };
  const [summary, ...trace] = (item.lastError?.message.trim() || '扩展运行失败').split(/\r?\n/);
  const diagnostic = <span className="extension-error" role="status">{summary}</span>;
  return <li>
    <Switch label={item.extId} checked={item.status === 'enabled'} busy={busy || item.status === 'starting'}
      onCheckedChange={enabled => void toggle(enabled)}/>
    <div className="extension-metadata"><small className="extension-version" title={item.version}>{item.version}</small>
      {item.tools.map(tool => <p key={tool.name} className="extension-tool">{tool.name} → {toolScopeLabel(tool, roles)}</p>)}
    </div>
    {error && <span className="extension-error" role="alert">{error}</span>}
    {hasExtensionFault(item) && <>
      {trace.length ? <details className="extension-diagnostic"><summary>{diagnostic}</summary>
        <pre>{trace.join('\n')}</pre></details> : diagnostic}
      <RepairAction item={item} seat={seat} repairs={repairs}/>
    </>}
  </li>;
}

export function ExtensionsPage({ state, roles, seat, image, initial, onPosition, onIdea }: {
  state: ExtensionState; roles: RoleListItem[]; seat?: RoleListItem; image?: RoleFaceImage; initial?: DeskPosition;
  onPosition: (position: DeskPosition) => void; onIdea: () => void;
}) {
  const [position, setPosition] = useState(initial);
  const [selection, setSelection] = useState('');
  const [roleId, setRoleId] = useState('');
  const restore = useRef(initial);
  const { pages, widgets, page, view, target } = resolveDesk(state.items, position, !!restore.current);
  const selected = pages.find(s => slotId(s.extension, s.entry) === selection) ?? page;
  const hasSlots = !!(selected || widgets.length);
  const role = roles.find(item => item.roleId === roleId);
  const catalog = catalogForRole(state.items, role);
  const status = catalogStatus(state.connection, state.items.length);
  const root = useRef<HTMLDivElement>(null);
  const currentTarget = target?.entry.slot === 'widget' ? target : selected ?? target;
  const extId = currentTarget?.extension.extId, file = currentTarget?.entry.file;
  useLayoutEffect(() => {
    if (state.connection === 'ready') onPosition({ view, extId, file });
  }, [state.connection, view, extId, file, onPosition]);
  useLayoutEffect(() => {
    if (!restore.current || state.connection !== 'ready') return;
    restore.current = undefined;
    setPosition({ view, extId, file });
    const node = view === 'catalog' ? root.current?.querySelector<HTMLElement>('.extension-catalog') :
      Array.from(root.current?.querySelectorAll<HTMLElement>('[data-desk-file]') ?? [])
        .find(el => el.dataset.deskExtension === extId && el.dataset.deskFile === file);
    node?.focus({ preventScroll: true });
    node?.scrollIntoView({ block: 'nearest' });
  }, [state.connection, view, extId, file]);
  function visit(extension: Extension, entry: Slot) {
    setPosition({ view: 'desk', extId: extension.extId, file: entry.file });
  }
  function slotFrame(slot: typeof pages[number]) {
    return <div key={slot.key} tabIndex={-1} data-desk-extension={slot.extension.extId} data-desk-file={slot.entry.file}
      onFocusCapture={() => visit(slot.extension, slot.entry)} onPointerDownCapture={() => visit(slot.extension, slot.entry)}>
      <ExtensionSlotFrame extension={slot.extension} entry={slot.entry} roles={roles} image={image}
        onFrameFocus={() => visit(slot.extension, slot.entry)}/>
    </div>;
  }
  return <UiThemeScope theme="xiacheng" className="extension-page">
    <h1>扩展</h1>
    {hasSlots && <div className="extension-view-switch" role="group" aria-label="扩展视图">
      {(['desk', 'catalog'] as const).map(next => <Button key={next} size="sm" aria-pressed={view === next}
        onClick={() => setPosition({ view: next, extId, file })}>{next === 'desk' ? '台面' : '已安装'}</Button>)}
    </div>}
    <div ref={root} className="extension-layout" data-view={view} data-has-slots={hasSlots || undefined}>
      <section className="extension-catalog" tabIndex={-1} aria-labelledby="extension-catalog-heading">
        <h2 id="extension-catalog-heading">已安装扩展</h2>
        {status === 'empty' ? <div className="extension-invitation">
          <h3>台面还空着</h3><p>这里会摆放角色为你做的小工具、桌面挂件与小游戏，随时可以在对话里提一个想法。</p>
          <Button size="sm" variant="default" onClick={onIdea}>去对话里提一个想法</Button>
        </div> : status === 'loading' ? <PaperSkeleton label="正在读取扩展…"/>
          : status !== 'installed' ? <p role="status">扩展连接中断，正在重连…</p> : <>
          <div className="extension-filter" role="group" aria-label="按角色查看工具">
            <Button size="sm" aria-pressed={!role} onClick={() => setRoleId('')}>全部</Button>
            {roles.map(r => <Button key={r.roleId} size="sm" aria-pressed={r === role}
              onClick={() => setRoleId(r.roleId)}>{r.displayName}</Button>)}
          </div>
          {catalog.length ? <ul>{catalog.map(item => <ExtensionRow key={item.extId} item={item} roles={roles} seat={seat}
            repairs={state.repairs}/>)}</ul> : <p>此角色暂无可用工具。</p>}
        </>}
      </section>
      {hasSlots && <div className="extension-slots">
        {selected && <section aria-label="扩展微页">
          <Field label="微页">
            <Select value={slotId(selected.extension, selected.entry)} onChange={event => {
              const next = pages.find(s => slotId(s.extension, s.entry) === event.target.value);
              if (next) { setSelection(event.target.value); visit(next.extension, next.entry); }
            }}>
              {pages.map(({ extension, entry, key }) => <option key={key} value={slotId(extension, entry)}>{extension.extId} · {entry.file}</option>)}
            </Select>
          </Field>
          {slotFrame(selected)}
        </section>}
        {widgets.length > 0 && <section aria-labelledby="extension-widget-heading">
          <h2 id="extension-widget-heading">挂件</h2>
          <div className="extension-widget-grid">{widgets.map(slotFrame)}</div>
        </section>}
      </div>}
    </div>
  </UiThemeScope>;
}

function Overlay({ extension, entry, roles, image, dismiss }: { extension: Extension; entry: Slot; roles: RoleListItem[]; image?: RoleFaceImage; dismiss: () => void }) {
  const { surface, closing, close } = useSurfaceDismiss<HTMLElement>(dismiss);
  return <article ref={surface} className="ui-floating-surface" data-closing={closing || undefined} inert={closing}>
    <header><strong>{extension.extId}</strong><Button aria-label="关闭扩展浮层" onClick={close}>关闭</Button></header>
    <ExtensionSlotFrame image={image} roles={roles} extension={extension} entry={entry} dismiss={close}/>
  </article>;
}

function ExtensionNotice({ notice, dismiss }: { notice: ExtensionState['notices'][string]; dismiss: () => void }) {
  const { surface, closing, close } = useSurfaceDismiss<HTMLElement>(dismiss);
  return <article ref={surface} className="ui-floating-surface" data-closing={closing || undefined} inert={closing}>
    <header><strong>{notice.extId}</strong><Button onClick={close}>关闭提示</Button></header>
    <p role="status">{notice.message}</p>
  </article>;
}

export function ExtensionOverlays({ state, roles, image }: { state: ExtensionState; image?: RoleFaceImage; roles: RoleListItem[] }) {
  const [closed, setClosed] = useState<string[]>([]);
  const slots = entries(state.items, 'overlay').filter(slot => !closed.includes(slot.key));
  const notices = Object.values(state.notices);
  if (!slots.length && !notices.length) return null;
  return <UiThemeScope theme="xiacheng" className="extension-overlays">
    {notices.map(notice => <ExtensionNotice key={notice.receiptId} notice={notice} dismiss={() => state.dismiss(notice)}/>)}
    {slots.map(({ key, ...slot }) => <Overlay key={key} image={image} roles={roles} {...slot} dismiss={() => setClosed(previous => [...previous, key])}/>)}
  </UiThemeScope>;
}
