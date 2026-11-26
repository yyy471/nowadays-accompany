import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { Button, Field, Input, Textarea } from '../../ui';
import { MediaGroup } from './MediaSheet';
import { useSheet } from './sheet/sheet-context';
import { ServiceSheet, ServiceSheetActions } from './ServiceParts';
import { useWrite } from './write-runner';
import { T11 } from './config-texts';
import { parseMcpImport, personalArgument, type McpDraft } from './extension-import';

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function parseExtensionEnv(value: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every(item => typeof item === 'string')) {
      return parsed as Record<string, string>;
    }
  } catch { return null; }
  return null;
}

export function ExtensionFields({ kind, group, name, onName, command, onCommand, args, onArgs, env, onEnv, source, onSource, busy, creating }: {
  kind: 'mcp' | 'skill'; group?: string; name: string; onName: (value: string) => void;
  command: string; onCommand: (value: string) => void; args: string; onArgs: (value: string) => void;
  env: string; onEnv: (value: string) => void; source: string; onSource: (value: string) => void; busy: boolean; creating?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState('');
  const chooser = window.nowadaysDesk?.chooseSkillDirectory;
  return <>
    <MediaGroup title="名称" group={group}><div className="config-service-field-one"><Field label="名称"><Input value={name} maxLength={200} disabled={busy} placeholder={creating ? '起一个好认的名字' : undefined} onChange={event => onName(event.target.value)}/></Field></div></MediaGroup>
    {kind === 'mcp' ? <>
      <MediaGroup title="启动" group={group}><div className="config-service-launch-command"><Field label="启动命令"><Input value={command} disabled={busy} placeholder="例如 npx、uvx、node" spellCheck={false} onChange={event => onCommand(event.target.value)}/></Field></div>
        <Field label="启动参数"><Textarea className="config-service-code" rows={3} value={args} disabled={busy} placeholder="每行一个参数" spellCheck={false} onChange={event => onArgs(event.target.value)}/></Field>
      </MediaGroup>
      <MediaGroup title="环境变量" group={group}><div className="config-service-unlabelled"><Field label="环境变量" error={parseExtensionEnv(env) ? undefined : T11}><Textarea className="config-service-code" rows={4} value={env} disabled={busy} placeholder='{"KEY": "value"}' spellCheck={false} onChange={event => onEnv(event.target.value)}/></Field></div></MediaGroup>
    </> : <MediaGroup title="来源目录" group={group}><div className="config-service-folder config-service-unlabelled"><Field label="来源目录"><Input value={source} disabled={busy || choosing} placeholder="SKILL.md 所在目录" spellCheck={false} onChange={event => onSource(event.target.value)}/></Field>
      {chooser && <Button size="sm" disabled={busy || choosing} onClick={async () => {
        setChoosing(true);
        setChooseError('');
        try { const picked = await chooser(); if (picked) onSource(picked); }
        catch (reason) { setChooseError(errorText(reason)); }
        finally { setChoosing(false); }
      }}>选择目录…</Button>}</div>{chooseError && <p className="config-sheet-error" role="alert">{chooseError}</p>}</MediaGroup>}
  </>;
}

type DiscoveredSkill = { name: string; description: string; directory: string };
type ToolInfo = { name: string; description: string };

function ToolList({ tools }: { tools: ToolInfo[] }) {
  return <div role="status">连接成功，发现 {tools.length} 个工具<ul>{tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong> {tool.description}</li>)}</ul></div>;
}

export function SavedMcpProbe({ resourceId, enabled }: { resourceId: string; enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [error, setError] = useState('');
  async function probe() {
    setBusy(true); setError(''); setTools(null);
    try {
      const result = await api<{ tools: ToolInfo[] }>('/v1/resources/mcp/probe', { method: 'POST', body: { resourceId } });
      setTools(result.tools);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <div><Button size="sm" disabled={busy || !enabled} onClick={() => void probe()}>{busy ? '正在测试…' : '测试连接'}</Button>
    {error && <p role="alert">{error}</p>}{tools && <ToolList tools={tools}/>}</div>;
}

export function ExtensionCreate<R extends { resourceId: string; name: string }>({ kind, active, trigger, onCancel, onCreated }: {
  kind: 'mcp' | 'skill'; active: boolean; trigger: HTMLElement | null;
  onCancel: () => void; onCreated: (resources: R[]) => void;
}) {
  const sheet = useSheet();
  const write = useWrite();
  const id = 'new-extension:' + kind;
  const [json, setJson] = useState('');
  const [choices, setChoices] = useState<McpDraft[]>([]);
  const [choice, setChoice] = useState('');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState<string[]>([]);
  const [env, setEnv] = useState('{}');
  const [description, setDescription] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [source, setSource] = useState('');
  const [skills, setSkills] = useState<DiscoveredSkill[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(0);

  useEffect(() => {
    setBusy(false);
    if (active) sheet.open({ id, title: '添加 ' + (kind === 'mcp' ? 'MCP' : 'Skill'), shape: 'full', focusReturn: trigger });
    return () => { pending.current++; };
  }, [active]);

  const variables = parseExtensionEnv(env);
  const mcpValid = !!name.trim() && !!command.trim() && !!variables;
  const available = kind === 'mcp' ? mcpValid : selected.length > 0;
  const count = Number(!!(json || name || command || source));
  const config = { command: command.trim(), args, env: variables };

  function useServer(server?: McpDraft) {
    setChoice(server?.name ?? ''); setName(server?.name ?? ''); setCommand(server?.command ?? '');
    setArgs(server?.args ?? []); setEnv(JSON.stringify(server?.env ?? {}, null, 2));
    setDescription(server?.description ?? ''); setTools(null); setError('');
  }
  function reset() {
    setJson(''); setChoices([]); useServer(); setSource(''); setSkills([]); setSelected([]);
    setAdvanced(false); setBusy(false); pending.current++;
  }
  function recognize(text: string) {
    setJson(text);
    try {
      const servers = text.trim() ? parseMcpImport(text) : [];
      setChoices(servers); useServer(servers[0]);
    } catch (reason) {
      setChoices([]); useServer(); setError(errorText(reason));
    }
  }
  async function discover(picked: string) {
    setSource(picked); setSkills([]); setSelected([]); setError('');
    if (!picked.trim()) return;
    const seq = ++pending.current;
    setBusy(true);
    try {
      const result = await api<{ items: DiscoveredSkill[] }>('/v1/resources/skills/discover', { method: 'POST', body: { sourcePath: picked.trim() } });
      if (seq !== pending.current) return;
      setSkills(result.items); setSelected(result.items.length === 1 ? [result.items[0]!.directory] : []);
    } catch (reason) { if (seq === pending.current) setError(errorText(reason)); }
    finally { if (seq === pending.current) setBusy(false); }
  }
  async function probe() {
    const seq = ++pending.current;
    setBusy(true); setError(''); setTools(null);
    try {
      const result = await api<{ tools: ToolInfo[] }>('/v1/resources/mcp/probe', { method: 'POST', body: config });
      if (seq === pending.current) setTools(result.tools);
    } catch (reason) { if (seq === pending.current) setError(errorText(reason)); }
    finally { if (seq === pending.current) setBusy(false); }
  }
  async function save() {
    if (!available || busy) return;
    const finish = write.beginWrite();
    if (!finish) return;
    setBusy(true); setError('');
    try {
      const resources = kind === 'skill'
        ? (await api<{ items: R[] }>('/v1/resources/skills/import', { method: 'POST', body: { sourcePath: source.trim(), directories: selected } })).items
        : [await api<R>('/v1/resources', { method: 'POST', body: { kind, name: name.trim(), config: {
          ...config, description: (description.trim() || tools?.map(tool => tool.description.split('\n')[0] || tool.name).join('；') || '').slice(0, 2000),
        } } })];
      sheet.closeNow(() => { reset(); onCreated(resources); }, resources.map(item => item.name).join('、') + ' 已添加');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); finish(); }
  }
  function changeArg(index: number, value: string) {
    setArgs(args.map((arg, i) => i === index ? value : arg)); setTools(null);
  }
  const imported = choices.find(item => item.name === choice);
  return <ServiceSheet id={id} active={active} count={count} busy={busy} onDiscard={() => { reset(); onCancel(); }}
    footer={<ServiceSheetActions creating count={count} busy={busy} invalid={!available} error={error} onSubmit={() => void save()}/>}>
    {() => kind === 'mcp' ? <>
      <Field label="粘贴 MCP 配置" hint="从工具作者的说明中复制整段 JSON。"><Textarea aria-label="粘贴 MCP 配置" placeholder={'{"mcpServers": { … }}'} rows={4} value={json} disabled={busy} spellCheck={false} onChange={e => recognize(e.target.value)}/></Field>
      {choices.length > 1 && <Field label="本次添加的工具"><select aria-label="本次添加的工具" value={choice} disabled={busy} onChange={e => useServer(choices.find(item => item.name === e.target.value))}>{choices.map(item => <option key={item.name}>{item.name}</option>)}</select></Field>}
      {!advanced && imported && <>
        <Field label="工具名称"><Input value={name} disabled={busy} onChange={e => setName(e.target.value)}/></Field>
        {Object.entries(imported.env).filter(([key, initial]) => !initial || /key|secret|token|pass|credential/i.test(key) || personalArgument(initial)).map(([key]) =>
          <Field key={key} label={key} hint="按工具作者的说明填写。"><Input aria-label={key} type={/key|secret|token|pass|credential/i.test(key) ? 'password' : 'text'} value={variables?.[key] ?? ''} disabled={busy} onChange={e => { setTools(null); setEnv(JSON.stringify({ ...variables, [key]: e.target.value }, null, 2)); }}/></Field>)}
        {imported.args.map((arg, i) => personalArgument(arg) && <Field key={i} label={'路径或参数 ' + (i + 1)}><Input value={args[i] ?? ''} disabled={busy} onChange={e => changeArg(i, e.target.value)}/></Field>)}
      </>}
      <Button size="sm" variant="ghost" aria-expanded={advanced} disabled={busy} onClick={() => setAdvanced(!advanced)}>高级配置</Button>
      {advanced && <ExtensionFields kind="mcp" name={name} onName={setName} command={command} onCommand={s => { setCommand(s); setTools(null); }}
        args={args.join('\n')} onArgs={s => { setArgs(s ? s.split('\n') : []); setTools(null); }} env={env} onEnv={s => { setEnv(s); setTools(null); }}
        busy={busy} source="" onSource={() => {}} creating/>}
      {(advanced || imported) && <Field label="用途"><Input value={description} placeholder="例如：查找百科资料" disabled={busy} onChange={e => setDescription(e.target.value)}/></Field>}
      <Button size="sm" disabled={busy || !command.trim() || !variables} onClick={() => void probe()}>测试连接</Button>
      {tools && <ToolList tools={tools}/>}
    </> : <>
      <Field label="技能目录" hint="选择单个技能，或包含多个技能的文件夹。"><Input aria-label="技能目录" value={source} disabled={busy} onChange={e => { setSource(e.target.value); setSkills([]); setSelected([]); setError(''); }}/></Field>
      {window.nowadaysDesk?.chooseSkillDirectory && <Button size="sm" disabled={busy} onClick={async () => {
        try { const picked = await window.nowadaysDesk!.chooseSkillDirectory(); if (picked) await discover(picked); }
        catch (reason) { setError(errorText(reason)); }
      }}>选择目录…</Button>}
      <Button size="sm" disabled={busy || !source.trim()} onClick={() => void discover(source)}>识别技能</Button>
      {skills.map(skill => <label key={skill.directory} className="config-toggle-row"><input type="checkbox" checked={selected.includes(skill.directory)} disabled={busy}
        onChange={e => setSelected(e.target.checked ? [...selected, skill.directory] : selected.filter(item => item !== skill.directory))}/><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>)}
    </>}
  </ServiceSheet>;
}
