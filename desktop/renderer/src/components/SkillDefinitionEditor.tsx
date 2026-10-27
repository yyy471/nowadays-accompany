import { useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type { SkillDefinitionView } from '../types';
import { Button, CancelButton, Checkbox, ConfirmButton, ErrorNote, Field, Icon, Input, Tag, Textarea } from '../ui';
import { hashRevision } from '../lib/drafts/registry';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { useDraftProtection } from '../components/DraftProtectionProvider';
import { skillPayloadOf, type SkillForm } from '../lib/skill-payload';

interface SkillDefinitionEditorProps {
  scope: 'public' | 'private';
  accountId?: string;
  revision: string;
  initial?: SkillDefinitionView;
  locked?: boolean;
  onSaved: (list: { revision: string; skills: SkillDefinitionView[] }) => void;
  onCancel: () => void;
}

function formOf(skill?: SkillDefinitionView): SkillForm {
  return {
    id: skill?.id ?? '',
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    instructions: skill?.instructions ?? '',
    tools: (skill?.tools ?? []).join(', '),
    kinds: [...(skill?.kinds ?? [])],
    peers: (skill?.peers ?? []).join(', ')
  };
}

function signature(form: SkillForm, requires: string[]): string {
  return JSON.stringify({ ...form, requires });
}

export function SkillDefinitionEditor({
  scope,
  accountId,
  revision,
  initial,
  locked = false,
  onSaved,
  onCancel
}: SkillDefinitionEditorProps) {
  const [form, setForm] = useState<SkillForm>(() => formOf(initial));
  const [baseline] = useState<SkillForm>(() => formOf(initial));
  const requires = initial?.requires ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { requestTransition } = useDraftProtection();
  const dirty = signature(form, requires) !== signature(baseline, requires);
  const ownerLabel = scope === 'public' ? '公用 Skill' : `账号 ${accountId} 的私有 Skill`;
  const registrationId = `skill-${scope}:${scope === 'private' ? accountId : 'public'}:${initial?.id ?? 'new'}`;

  useDraftRegistration({
    id: registrationId,
    owner: 'page',
    ...(scope === 'private' && accountId ? { accountId } : {}),
    label: initial ? `${ownerLabel} ${initial.id}` : `${ownerLabel}（新建）`,
    dirty,
    busy,
    revision: hashRevision(form),
    discard: () => { setForm(baseline); setError(undefined); },
    enabled: true
  });

  const update = <K extends keyof SkillForm>(key: K, value: SkillForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(undefined);
  };

  const close = async (): Promise<void> => {
    if (busy || locked) return;
    const result = await requestTransition({ scope: { kind: 'ids', ids: [registrationId] }, actionLabel: '关闭 Skill 编辑' });
    if (!result.ok) { if (result.message) setError(result.message); return; }
    onCancel();
  };

  const save = async (): Promise<void> => {
    if (busy || locked) return;
    const id = form.id.trim();
    if (!id || !form.name.trim() || !form.instructions.trim()) {
      setError('请填写 Skill id、名称和说明。');
      return;
    }
    if (scope === 'private' && !accountId) {
      setError('缺少账号上下文。');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const skill = skillPayloadOf(form, initial);
      const base = scope === 'public' ? '/skills' : `/accounts/${encodeURIComponent(accountId!)}/skills/private`;
      const response = initial
        ? await api<{ skills: { revision: string; skills: SkillDefinitionView[] } }>(`${base}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ skill, expectedRevision: revision })
        })
        : await api<{ skills: { revision: string; skills: SkillDefinitionView[] } }>(base, {
          method: 'POST',
          body: JSON.stringify({ skill, expectedRevision: revision })
        });
      onSaved(response.skills);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-editor extension-skill-editor">
      <div className="extension-skill-editor-head">
        <strong>{initial ? `编辑${scope === 'public' ? '公用' : '私有'} Skill · ${initial.id}` : `新建${scope === 'public' ? '公用' : '私有'} Skill`}</strong>
        <Tag tone={scope === 'public' ? 'ok' : 'idle'}>{scope === 'public' ? '所有账号可见' : `仅账号 ${accountId}`}</Tag>
      </div>
      {scope === 'public' ? <p className="field-hint">修改公用定义会影响所有引用它的账号。</p> : null}
      <p className="field-hint">
        {initial
          ? initial.enabled === false
            ? `${scope === 'public' ? '该公用定义当前默认关闭' : '该私有定义当前默认关闭'}；保存会保留此状态，账号仍可在 Skill 作用域中显式开启。`
            : `保存会保留当前默认启用状态${scope === 'public' ? '，也不会改变账号私有覆盖' : ''}。`
          : scope === 'public'
            ? '新建公用定义默认关闭；保存不会自动在任何账号启用。'
            : '新建私有定义默认关闭；保存不会自动在该账号启用。'}
      </p>
      {error ? <ErrorNote message={error} /> : null}
      <div className="form-grid">
        <Field label="Skill id" hint="保存后不可改名；字母、数字、点、下划线和短横线。">
          <Input value={form.id} disabled={Boolean(initial) || busy} maxLength={64} placeholder="例如 group-summary" onChange={(event) => update('id', event.target.value.trim())} />
        </Field>
        <Field label="名称">
          <Input value={form.name} disabled={busy} maxLength={200} onChange={(event) => update('name', event.target.value)} />
        </Field>
        <Field label="说明正文" hint="最多 8000 字符；内容会按提示词预算注入。">
          <Textarea value={form.instructions} disabled={busy} maxLength={8_000} rows={6} onChange={(event) => update('instructions', event.target.value)} />
        </Field>
        <Field label="引用工具" hint="填写工具完整 id，用逗号分隔；引用工具必须已授权且可用。">
          <Input value={form.tools} disabled={busy} placeholder="builtin.image.generate, public/plugin/demo/query" onChange={(event) => update('tools', event.target.value)} />
        </Field>
        <Field label="限定会话类型" hint="全部不选代表私聊和群聊都可使用。">
          <div className="check-row-wrap">
            {(['private', 'group'] as const).map((kind) => (
              <label className="check-row" key={kind}>
                <Checkbox disabled={busy} checked={form.kinds.includes(kind)} onChange={(event) => {
                  update('kinds', event.target.checked ? [...form.kinds, kind] : form.kinds.filter((item) => item !== kind));
                }} />
                <span><strong>{kind === 'private' ? '私聊' : '群聊'}</strong></span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="限定对象" hint="填写 QQ 号或群号，用逗号分隔；留空表示不限制对象。">
          <Input value={form.peers} disabled={busy} onChange={(event) => update('peers', event.target.value)} />
        </Field>
        {requires.length ? <Field label="所需模型能力"><span className="muted mono">{requires.join(', ')}</span></Field> : null}
      </div>
      <p className="field-hint">启用 Skill 不会自动开启它引用的工具；账号是否注入由 Skill 作用域开关决定。</p>
      <div className="form-submit">
        <CancelButton type="button" variant="ghost" disabled={busy} onClick={() => void close()}>取消</CancelButton>
        <ConfirmButton type="button" variant="primary" busy={busy} disabled={locked || busy} onClick={() => void save()}>
          <Icon name="check" size={14} />保存 Skill
        </ConfirmButton>
      </div>
    </div>
  );
}
