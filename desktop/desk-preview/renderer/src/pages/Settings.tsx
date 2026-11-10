import { useEffect, useState } from 'react';
import { api } from '../api';
import type { RoleDetail, RoleListItem } from '../types';
import { Button, Field, Input, Textarea } from '../ui';
import { AppearancePanel } from '../components/appearance/AppearancePanel';
import { VoicePanel } from '../components/voice/VoicePanel';

type Binding = { capability: string; resourceId: string; modelName: string | null; enabled: boolean };
type Resource = { resourceId: string; kind: string; name: string; enabled: boolean };

type Props = {
  roles: RoleListItem[];
  detail?: RoleDetail;
  currentId: string;
  currentOutfitId?: string;
  onSelect: (id: string) => void;
  onRefresh: (id?: string) => Promise<void>;
};

/** 角色资料、外观和能力绑定从关系藏页移到这里，不另做一套管理台。 */
export function SettingsPage({ roles, detail, currentId, currentOutfitId, onSelect, onRefresh }: Props) {
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [revision, setRevision] = useState(0);
  const [payload, setPayload] = useState<Record<string, unknown>>({});
  const [creatingName, setCreatingName] = useState('');
  const [creatingDefinition, setCreatingDefinition] = useState('');
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!detail || detail.roleId !== currentId) return;
    setName(detail.displayName);
    setDefinition(detail.definition.text);
    setRevision(detail.definitionRevision);
    setPayload(detail.definition.payload);
  }, [detail, currentId]);

  useEffect(() => {
    let active = true;
    setBindings([]);
    if (!currentId) return;
    Promise.all([
      api<{ items: Binding[] }>(`/v1/roles/${encodeURIComponent(currentId)}/bindings`),
      api<{ items: Resource[] }>('/v1/resources')
    ]).then(([bound, available]) => {
      if (!active) return;
      setBindings(bound.items);
      setResources(available.items);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [currentId]);

  const save = async () => {
    if (!currentId || busy || !name.trim() || !definition.trim()) return;
    setBusy(true); setMessage(''); setError('');
    try {
      await api(`/v1/roles/${encodeURIComponent(currentId)}/definition`, {
        method: 'PATCH',
        body: { displayName: name.trim(), definition: { text: definition.trim(), payload }, expectedRevision: revision }
      });
      await onRefresh(currentId);
      setMessage('已保存角色设定。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (busy || !creatingName.trim() || !creatingDefinition.trim()) return;
    setBusy(true); setMessage(''); setError('');
    try {
      const role = await api<RoleDetail>('/v1/roles', { method: 'POST', body: { displayName: creatingName.trim(), definition: { text: creatingDefinition.trim() } } });
      setCreatingName(''); setCreatingDefinition('');
      await onRefresh(role.roleId);
      setMessage('已创建角色。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  return <div className="studio-settings">
    <header className="studio-page-heading"><h1>设置</h1><p>角色设定、外观和已绑定的能力放在这里。关系页只保留一起经过的日常。</p></header>
    {(message || error) && <p role={error ? 'alert' : 'status'}>{error || message}</p>}
    <section>
      <h2>当前角色</h2>
      {roles.length === 0 ? <p>还没有角色。</p> : <Field label="选择角色"><select value={currentId} onChange={event => onSelect(event.target.value)}>{roles.map(role => <option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}</select></Field>}
      {detail && detail.roleId === currentId && <>
        <Field label="名字"><Input value={name} maxLength={200} onChange={event => setName(event.target.value)} /></Field>
        <Field label="角色设定"><Textarea rows={8} value={definition} onChange={event => setDefinition(event.target.value)} /></Field>
        <Button disabled={busy || !name.trim() || !definition.trim()} onClick={() => void save()}>保存设定</Button>
      </>}
    </section>
    <section>
      <h2>添加角色</h2>
      <Field label="名字"><Input value={creatingName} maxLength={200} onChange={event => setCreatingName(event.target.value)} /></Field>
      <Field label="角色设定"><Textarea rows={6} value={creatingDefinition} onChange={event => setCreatingDefinition(event.target.value)} /></Field>
      <Button disabled={busy || !creatingName.trim() || !creatingDefinition.trim()} onClick={() => void create()}>创建角色</Button>
    </section>
    {currentId && <section>
      <h2>外观</h2>
      <AppearancePanel roleId={currentId} currentOutfitId={currentOutfitId} onChanged={() => { void onRefresh(); }} />
    </section>}
    {currentId && <section>
      <h2>声音</h2>
      <VoicePanel roleId={currentId} onChanged={() => { void onRefresh(); }} />
    </section>}
    <section>
      <h2>已绑定的能力</h2>
      {bindings.length === 0 ? <p>当前角色还没有绑定模型、MCP 或 Skill。</p> : bindings.map(binding => {
        const resource = resources.find(item => item.resourceId === binding.resourceId);
        return <div className="binding-row" key={binding.capability + binding.resourceId}><span>{resource?.name || '资源不可用'} · {binding.capability}{binding.modelName ? ` · ${binding.modelName}` : ''}</span><span>{binding.enabled && resource?.enabled ? '已启用' : '已停用'}</span></div>;
      })}
    </section>
  </div>;
}
