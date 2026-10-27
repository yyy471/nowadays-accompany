import { useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type { AccountsResponse, PrivateSkillList, PublicSkillList, SkillImpact, SkillDefinitionView } from '../types';
import { Button, Card, ConfirmButton, ErrorNote, LoadingNote, Select, Tag, useConfirm } from '../ui';
import { SkillDefinitionEditor } from './SkillDefinitionEditor';

interface PublicSkillLibraryProps {
  accounts?: AccountsResponse;
  locked?: boolean;
}

function impactDescription(impact: SkillImpact): string {
  if (impact.accounts.length === 0 && !impact.defaultScopesAffected) {
    return '当前没有账号引用该公用 Skill。删除后不可恢复。';
  }
  const accounts = impact.accounts
    .map((account) => `${account.accountId}${account.privateOverride ? '（私有覆盖）' : ''}${account.switches.length ? `（${account.switches.map((item) => `${item.scope === 'defaults' ? '账号默认' : item.kind ?? '会话'} ${item.value === 'on' ? '开启' : '关闭'}`).join('、')}）` : ''}`)
    .join('；');
  return `${impact.defaultScopesAffected ? '默认启用的会话也会受影响。' : ''}${accounts ? `引用账号：${accounts}。` : ''}删除后不可恢复。`;
}

export function PublicSkillLibrary({ accounts, locked = false }: PublicSkillLibraryProps) {
  const skills = usePoll<PublicSkillList>('/skills', 0);
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ skill?: SkillDefinitionView; revision: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [copyFrom, setCopyFrom] = useState('');
  const [copyAccount, setCopyAccount] = useState('');
  const accountList = accounts?.accounts ?? [];

  const saveEditor = async (saved: { revision: string }): Promise<void> => {
    setEditing(undefined);
    setNotice('公用 Skill 已保存。');
    await skills.refresh();
  };

  const remove = async (skill: SkillDefinitionView): Promise<void> => {
    if (!skills.data || busy || locked) return;
    setBusy(`delete:${skill.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const impactResponse = await api<{ impact: SkillImpact }>(`/skills/${encodeURIComponent(skill.id)}/impact`);
      if (!(await confirm({
        title: '删除公用 Skill',
        description: `删除公用 Skill「${skill.name}」（${skill.id}）？${impactDescription(impactResponse.impact)}`,
        confirmLabel: '删除 Skill',
        tone: 'danger'
      }))) return;
      const result = await api<{ removed: boolean; impact: SkillImpact }>(`/skills/${encodeURIComponent(skill.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: skills.data.revision })
      });
      setNotice(`已删除公用 Skill ${skill.id}${result.impact.accounts.length ? `；${result.impact.accounts.length} 个账号的引用已失效` : ''}。`);
      await skills.refresh();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(undefined);
    }
  };

  const copy = async (): Promise<void> => {
    if (!copyFrom || !copyAccount || busy || locked) return;
    setBusy('copy');
    setError(undefined);
    setNotice(undefined);
    try {
      const privateList = await api<PrivateSkillList>(`/accounts/${encodeURIComponent(copyAccount)}/skills/private`);
      const replaces = privateList.skills.some((skill) => skill.id === copyFrom);
      if (replaces && !(await confirm({
        title: '覆盖账号私有 Skill',
        description: `账号 ${copyAccount} 已有私有 Skill ${copyFrom}，复制会覆盖它的说明和工具引用。继续？`,
        confirmLabel: '覆盖并复制',
        tone: 'danger'
      }))) return;
      const result = await api<{ copied: boolean; replaced: boolean }>(`/accounts/${encodeURIComponent(copyAccount)}/skills/private`, {
        method: 'POST',
        body: JSON.stringify({ copyFrom, expectedRevision: privateList.revision })
      });
      setNotice(`已将公用 Skill ${copyFrom} 复制到账号 ${copyAccount}${result.replaced ? '（覆盖原私有定义）' : ''}；还需在该账号的 Skill 作用域中启用。`);
    } catch (copyError) {
      setError(errorMessage(copyError));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card
      title="公用 Skill"
      subtitle="公用定义只分发说明和工具引用；复制为私有后才可单独编辑"
      actions={<Button size="sm" variant="ghost" icon="refresh" disabled={Boolean(busy)} onClick={() => void skills.refresh()}>刷新</Button>}
    >
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {skills.error ? <ErrorNote message={`无法读取公用 Skill：${skills.error}`} onRetry={() => void skills.refresh()} /> : null}
      {skills.data === undefined ? (skills.loading ? <LoadingNote label="正在读取公用 Skill…" /> : null) : skills.data.skills.length === 0 ? (
        <p className="muted">还没有公用 Skill。可以新建，或在“插件与Skill”页查看插件提供的 Skill。</p>
      ) : (
        <div className="extension-rows">
          {skills.data.skills.map((skill) => (
            <div className="extension-row" key={skill.id}>
              <div className="extension-row-main">
                <div className="extension-row-title">
                  <strong>{skill.name}</strong>
                  <Tag tone="ok">公用</Tag>
                  {skill.enabled === false ? <Tag tone="idle">默认关闭</Tag> : null}
                </div>
                <span className="muted mono">{skill.id}</span>
                <span className="muted">
                  工具 {skill.tools.length} · 说明 {skill.instructions.length} 字符
                  {skill.kinds?.length ? ` · 仅 ${skill.kinds.map((kind) => kind === 'private' ? '私聊' : '群聊').join('、')}` : ''}
                  {skill.peers?.length ? ` · 指定 ${skill.peers.join('、')}` : ''}
                </span>
              </div>
              <div className="extension-row-state">
                <Button size="sm" icon="settings" disabled={Boolean(busy) || locked || Boolean(editing)} onClick={() => skills.data && setEditing({ skill, revision: skills.data.revision })}>编辑</Button>
                <Button size="sm" variant="ghost" busy={busy === `delete:${skill.id}`} disabled={Boolean(busy) || locked || Boolean(editing)} onClick={() => void remove(skill)}>删除</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="extension-inline-actions">
        <Button size="sm" icon="plus" disabled={Boolean(busy) || locked || Boolean(editing) || !skills.data} onClick={() => skills.data && setEditing({ revision: skills.data.revision })}>新建公用 Skill</Button>
        <Select value={copyFrom} disabled={Boolean(busy) || locked || !skills.data?.skills.length} aria-label="选择公用 Skill" onChange={(event) => setCopyFrom(event.target.value)}>
          <option value="">选择公用 Skill…</option>
          {(skills.data?.skills ?? []).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}（{skill.id}）</option>)}
        </Select>
        <Select value={copyAccount} disabled={Boolean(busy) || locked || !accountList.length} aria-label="复制目标账号" onChange={(event) => setCopyAccount(event.target.value)}>
          <option value="">复制到账号…</option>
          {accountList.map((account) => <option key={account.accountId} value={account.accountId}>{account.nickname ? `${account.nickname}（${account.accountId}）` : account.accountId}</option>)}
        </Select>
        <Button size="sm" icon="copy" busy={busy === 'copy'} disabled={Boolean(busy) || locked || !copyFrom || !copyAccount} onClick={() => void copy()}>复制为私有</Button>
      </div>

      {editing && skills.data ? (
        <SkillDefinitionEditor
          key={editing.skill?.id ?? 'new-public'}
          scope="public"
          revision={editing.revision}
          {...(editing.skill ? { initial: editing.skill } : {})}
          locked={locked}
          onSaved={(saved) => void saveEditor(saved)}
          onCancel={() => setEditing(undefined)}
        />
      ) : null}
    </Card>
  );
}
