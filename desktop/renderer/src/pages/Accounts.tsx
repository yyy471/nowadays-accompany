import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type { AccountSummary, ArtifactItem, ArtifactsResponse, AccountsResponse, ArtifactRef } from '../types';
import { Button, CancelButton, Card, Checkbox, ConfirmButton, Empty, ErrorNote, Field, Icon, Input, Select, Tag, copyText } from '../ui';
import { AccountAvatar } from '../components/AccountAvatar';

interface AccountsPageProps {
  view: 'roles' | 'plugins';
  accounts?: AccountsResponse;
  accountsError?: string;
  artifacts?: ArtifactsResponse;
  refresh: () => Promise<void>;
  onGoSlots: () => void;
}

interface RoleBinding {
  accountId: string;
  kind: 'private' | 'group';
  peerId: string;
  roleCard: ArtifactRef;
  revision: string;
  updatedAt: number;
  state: 'ready' | 'missing';
  cardName?: string;
  resolvedRevision?: string;
}

interface RoleCardChoice {
  value: string;
  ref: ArtifactRef;
  label: string;
}

function currentArtifacts(items: ArtifactItem[], current: Record<string, string>, kind: 'plugin' | 'role-card'): ArtifactItem[] {
  const map = new Map<string, ArtifactItem>();
  for (const item of items) {
    if (item.manifest.kind !== kind) continue;
    const existing = map.get(`${item.ref.source}:${item.ref.id}`);
    const isCurrent = item.ref.source === 'public'
      ? current[`${kind}:${item.ref.id}`] === item.ref.revision
      : !existing || item.ref.revision.localeCompare(existing.ref.revision ?? '') > 0;
    if (!existing || isCurrent) map.set(`${item.ref.source}:${item.ref.id}`, item);
  }
  return [...map.values()].sort((left, right) =>
    (left.manifest.name ?? left.ref.id).localeCompare(right.manifest.name ?? right.ref.id)
  );
}

function accountStateLabel(state: AccountSummary['state']): string {
  return state === 'ready' ? '资料就绪' : '资料异常';
}

function bindingKey(binding: Pick<RoleBinding, 'kind' | 'peerId'>): string {
  return `${binding.kind}/${binding.peerId}`;
}

function roleCardValue(ref: ArtifactRef, mode: 'follow' | 'fixed'): string {
  return `${mode}|${ref.source}|${ref.id}|${mode === 'fixed' ? ref.revision ?? '' : ''}`;
}

function parseRoleCardValue(value: string): ArtifactRef | undefined {
  const [mode, source, id, revision] = value.split('|');
  if ((mode !== 'follow' && mode !== 'fixed') || (source !== 'public' && source !== 'private') || !id) return undefined;
  if (mode === 'fixed') return revision ? { source, id, revision } : undefined;
  return { source, id };
}

function roleCardChoices(versions: ArtifactItem[], current: ArtifactItem[]): RoleCardChoice[] {
  const choices: RoleCardChoice[] = [];
  for (const item of current) {
    const name = item.manifest.name ?? item.ref.id;
    choices.push({
      value: roleCardValue(item.ref, 'follow'),
      ref: { source: item.ref.source, id: item.ref.id },
      label: `${name} · ${item.ref.source === 'public' ? '公用' : '私有'} · 跟随当前（${item.ref.revision}）`
    });
  }
  for (const item of versions) {
    const name = item.manifest.name ?? item.ref.id;
    choices.push({
      value: roleCardValue(item.ref, 'fixed'),
      ref: item.ref,
      label: `${name} · ${item.ref.source === 'public' ? '公用' : '私有'} · 固定版本 @${item.ref.revision}`
    });
  }
  return choices.sort((left, right) => left.label.localeCompare(right.label));
}

export function AccountsPage({ view, accounts, accountsError, artifacts, refresh, onGoSlots }: AccountsPageProps) {
  const list = accounts?.accounts ?? [];
  const publicItems = artifacts?.artifacts ?? [];
  const [selectedAccount, setSelectedAccount] = useState('');
  const [loadedAccountId, setLoadedAccountId] = useState<string>();
  const [privateItems, setPrivateItems] = useState<ArtifactItem[]>([]);
  const [bindings, setBindings] = useState<RoleBinding[]>([]);
  const [bindingKind, setBindingKind] = useState<'private' | 'group'>('private');
  const [peerId, setPeerId] = useState('');
  const [roleCard, setRoleCard] = useState('');
  const [editing, setEditing] = useState<string>();
  const editingRef = useRef<string | undefined>(undefined);
  const [pluginIds, setPluginIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const accountRef = useRef(selectedAccount);
  const accountGeneration = useRef(0);
  const activePrivateItems = loadedAccountId === selectedAccount ? privateItems : [];
  const activeBindings = loadedAccountId === selectedAccount ? bindings.filter((binding) => binding.accountId === selectedAccount) : [];
  const roleCardVersions = useMemo(() => [...publicItems, ...activePrivateItems].filter((item) => item.manifest.kind === 'role-card'), [publicItems, activePrivateItems]);
  const currentRoleCards = useMemo(() => currentArtifacts(roleCardVersions, artifacts?.current ?? {}, 'role-card'), [roleCardVersions, artifacts?.current]);
  const roleChoices = useMemo(() => roleCardChoices(roleCardVersions, currentRoleCards), [roleCardVersions, currentRoleCards]);
  const plugins = useMemo(() => currentArtifacts(publicItems, artifacts?.current ?? {}, 'plugin'), [publicItems, artifacts?.current]);
  const selected = list.find((account) => account.accountId === selectedAccount);

  const selectAccount = (next: string): void => {
    if (accountRef.current === next) return;
    accountRef.current = next;
    accountGeneration.current += 1;
    setSelectedAccount(next);
    setLoadedAccountId(undefined);
    setBindings([]);
    setPrivateItems([]);
    setRoleCard('');
    setPeerId('');
    setPluginIds([]);
    setEditing(undefined);
    editingRef.current = undefined;
    setBusy(undefined);
    setError(undefined);
    setNotice(undefined);
  };

  const isCurrentAccount = (id: string, generation: number): boolean =>
    accountRef.current === id && accountGeneration.current === generation;

  useEffect(() => {
    if (!selectedAccount && list.length) selectAccount(list[0]!.accountId);
    if (selectedAccount && !list.some((account) => account.accountId === selectedAccount)) selectAccount(list[0]?.accountId ?? '');
  }, [selectedAccount, list]);

  useEffect(() => {
    if (!selectedAccount) return;
    let cancelled = false;
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    setError(undefined);
    Promise.all([
      api<{ bindings: RoleBinding[] }>(`/accounts/${encodeURIComponent(targetAccount)}/role-bindings`),
      api<{ artifacts: ArtifactItem[] }>(`/accounts/${encodeURIComponent(targetAccount)}/artifacts`)
    ]).then(([bindingResponse, artifactResponse]) => {
      if (cancelled || !isCurrentAccount(targetAccount, generation)) return;
      setBindings(bindingResponse.bindings);
      setPrivateItems(artifactResponse.artifacts);
      setLoadedAccountId(targetAccount);
    }).catch((loadError: unknown) => {
      if (!cancelled && isCurrentAccount(targetAccount, generation)) setError(errorMessage(loadError));
    });
    return () => { cancelled = true; };
  }, [selectedAccount, reloadKey]);

  const beginEdit = (account: AccountSummary): void => {
    if (busy) return;
    editingRef.current = account.accountId;
    setEditing(account.accountId);
    setPluginIds((account.file?.plugins ?? []).filter((plugin) => plugin.enabled !== false && plugin.source === 'public').map((plugin) => plugin.id));
    setError(undefined);
    setNotice(undefined);
  };

  const cancelEdit = (): void => {
    editingRef.current = undefined;
    setEditing(undefined);
  };

  const saveProfile = async (account: AccountSummary): Promise<void> => {
    const targetAccount = account.accountId;
    const targetPluginIds = [...pluginIds];
    const operation = `${targetAccount}:save`;
    if (editingRef.current !== targetAccount || busy) return;
    setBusy(operation);
    setError(undefined);
    setNotice(undefined);
    try {
      const profile = {
        version: 1,
        ...(account.file?.roleCard ? { roleCard: account.file.roleCard } : {}),
        plugins: targetPluginIds.map((id) => ({ source: 'public', id, enabled: true }))
      };
      const result = await api<{ reload?: { ok: boolean; error?: string } }>(`/accounts/${encodeURIComponent(targetAccount)}/profile`, {
        method: 'PUT', body: JSON.stringify({ profile })
      });
      if (editingRef.current !== targetAccount) return;
      if (result.reload && !result.reload.ok) setError(`资料已保存，但热加载失败：${result.reload.error ?? '未知错误'}`);
      else {
        setNotice(`账号 ${targetAccount} 的插件资料已保存${result.reload ? '并热加载' : ''}。`);
        cancelEdit();
      }
    } catch (saveError) {
      if (editingRef.current === targetAccount) setError(errorMessage(saveError));
    } finally {
      setBusy((current) => current === operation ? undefined : current);
      await refresh();
    }
  };

  const saveBinding = async (): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    const card = parseRoleCardValue(roleCard);
    if (!targetAccount || loadedAccountId !== targetAccount || !peerId.trim() || !card || busy) {
      setError('请填写会话 QQ / 群号，并选择一张角色卡。');
      return;
    }
    setBusy('binding');
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/accounts/${encodeURIComponent(targetAccount)}/role-bindings/${bindingKind}/${encodeURIComponent(peerId.trim())}`, {
        method: 'PUT', body: JSON.stringify({ roleCard: card })
      });
      if (!isCurrentAccount(targetAccount, generation)) return;
      setNotice(`${bindingKind === 'private' ? '私聊' : '群聊'} ${peerId.trim()} 的角色绑定已保存。`);
      setRoleCard('');
      setPeerId('');
      setReloadKey((value) => value + 1);
    } catch (saveError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(saveError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const removeBinding = async (binding: RoleBinding): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    if (binding.accountId !== targetAccount || loadedAccountId !== targetAccount || busy) return;
    setBusy(`remove:${bindingKey(binding)}`);
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/accounts/${encodeURIComponent(binding.accountId)}/role-bindings/${binding.kind}/${encodeURIComponent(binding.peerId)}`, { method: 'DELETE' });
      if (!isCurrentAccount(targetAccount, generation)) return;
      setNotice(`已解除 ${binding.kind === 'private' ? '私聊' : '群聊'} ${binding.peerId} 的角色绑定；自动回复会保持关闭。`);
      setReloadKey((value) => value + 1);
    } catch (removeError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(removeError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const reload = async (accountId: string): Promise<void> => {
    const operation = `${accountId}:reload`;
    if (busy) return;
    setBusy(operation);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api<{ ok: boolean; results: Array<{ instanceId: string; ok: boolean; error?: string }> }>(`/accounts/${encodeURIComponent(accountId)}/reload`, { method: 'POST' });
      if (!result.results.length) setNotice(`账号 ${accountId} 当前没有被运行槽位占用，插件资料会在下次启动后生效。`);
      else if (result.ok) setNotice(`账号 ${accountId} 已重新加载 ${result.results.length} 个实例的插件资料。`);
      else setError(result.results.map((item) => `${item.instanceId}: ${item.error ?? '失败'}`).join('；'));
    } catch (reloadError) {
      setError(errorMessage(reloadError));
    } finally {
      setBusy((current) => current === operation ? undefined : current);
      await refresh();
    }
  };

  return (
    <div className="page-stack">
      {view === 'roles' ? <div className="banner">
        <Icon name="shield" size={18} />
        <div>
          <strong>角色绑定针对每个账号、私聊或群聊分别设置。</strong>
          <span>没有显式绑定或角色卡失效时，不会自动回复，也不会调用模型或工具。旧 profile.json 中的 roleCard 仅保留为迁移信息。</span>
        </div>
      </div> : null}
      {accountsError ? <ErrorNote message={accountsError} onRetry={() => void refresh()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {list.length === 0 ? (
        <Card><Empty icon="accounts" title="还没有已绑定的 QQ 账号" description="登录后账号会出现在这里。QQ 由你自行启动；应用只检测，并在你明确点击后注入或监听。" action={<Button variant="primary" icon="slots" onClick={onGoSlots}>去槽位页</Button>} /></Card>
      ) : (
        <>
          {view === 'roles' && selected ? <div className="policy-toolbar account-context-toolbar">
            <Field label="当前 QQ 账号"><Select value={selectedAccount} disabled={Boolean(busy)} onChange={(event) => selectAccount(event.target.value)}>
              {list.map((account) => <option key={account.accountId} value={account.accountId}>{account.accountId}</option>)}
            </Select></Field>
            <span className="muted">下方展示资料与会话角色绑定均针对该账号。</span>
          </div> : null}
          {view === 'roles' && selected ? <AccountDisplayEditor
            accountId={selectedAccount}
            fallbackAvatarDataUrl={list.find((account) => account.accountId === selectedAccount)?.avatarDataUrl}
            onSaved={refresh}
          /> : null}
          {view === 'roles' && selected ? (
            <Card title="会话角色绑定" actions={<Button size="sm" icon="refresh" disabled={Boolean(busy)} onClick={() => setReloadKey((value) => value + 1)}>重新读取</Button>}>
              <div className="policy-toolbar">
                <Field label="会话类型"><Select disabled={Boolean(busy)} value={bindingKind} onChange={(event) => setBindingKind(event.target.value as 'private' | 'group')}><option value="private">私聊</option><option value="group">群聊</option></Select></Field>
                <Field label={bindingKind === 'private' ? '对方 QQ' : '群号'}><Input disabled={Boolean(busy)} value={peerId} onChange={(event) => setPeerId(event.target.value.replace(/[^0-9A-Za-z_-]/g, ''))} placeholder={bindingKind === 'private' ? '输入私聊 QQ 号' : '输入群号'} /></Field>
                <Field label="角色卡"><Select disabled={Boolean(busy)} value={roleCard} onChange={(event) => setRoleCard(event.target.value)}><option value="">选择角色卡…</option>{roleChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select></Field>
                <ConfirmButton variant="primary" busy={busy === 'binding'} disabled={loadedAccountId !== selectedAccount || Boolean(busy)} onClick={() => void saveBinding()}>保存绑定</ConfirmButton>
              </div>
              {loadedAccountId !== selectedAccount ? <p className="muted">正在读取该账号的会话绑定…</p> : activeBindings.length ? <div className="binding-list">{activeBindings.map((binding) => (
                <div className="binding-row" key={`${binding.accountId}/${bindingKey(binding)}`}>
                  <div className="binding-row-info"><strong>{binding.kind === 'private' ? '私聊' : '群聊'} {binding.peerId}</strong><span>{binding.cardName ?? binding.roleCard.id} · {binding.roleCard.source === 'public' ? '公用' : '私有'} · {binding.roleCard.revision ? `固定版本 @${binding.roleCard.revision}` : `跟随当前${binding.resolvedRevision ? `（${binding.resolvedRevision}）` : ''}`}</span></div>
                  <Tag tone={binding.state === 'ready' ? 'ok' : 'bad'}>{binding.state === 'ready' ? '已解析' : '缺少角色卡'}</Tag>
                  <Button size="sm" variant="ghost" busy={busy === `remove:${bindingKey(binding)}`} disabled={Boolean(busy) || binding.accountId !== selectedAccount} onClick={() => void removeBinding(binding)}>解除</Button>
                </div>
              ))}</div> : <p className="muted">该账号还没有会话角色绑定。未绑定会话不会自动处理。</p>}
              {!roleChoices.length ? <div className="notice notice-warn">当前没有可选角色卡，请先将角色卡制品加入资源库。</div> : null}
            </Card>
          ) : null}
          {view === 'plugins' ? <Card title="账号插件资料">
            <div className="account-list">{list.map((account) => {
              const isEditing = editing === account.accountId;
              return <div key={account.accountId} className="account-card">
                <div className="account-head">
                  <div className="account-identity"><AccountAvatar dataUrl={account.avatarDataUrl} label={`${account.accountId} 头像`} className="avatar" iconSize={16} /><div><h3>{account.accountId}</h3><span className="muted mono">{account.dir}</span></div></div>
                  <div className="account-head-actions"><Tag tone={account.state === 'ready' ? 'ok' : 'bad'}>{accountStateLabel(account.state)}</Tag>{account.slots.length ? <Tag tone="idle">槽位 {account.slots.join('、')}</Tag> : <Tag tone="idle">未占用槽位</Tag>}</div>
                </div>
                <div className="account-body"><div className="account-profile-summary">
                  <div className="meta-label">会话绑定数</div><div className="profile-line"><Icon name="user" size={15} /><span>角色卡绑定由上方会话列表单独管理</span></div>
                  {account.file?.roleCard ? <p className="muted">旧默认卡 {account.file.roleCard.source}:{account.file.roleCard.id}（仅迁移信息，不参与自动处理）</p> : null}
                  <div className="meta-label plugin-label">插件</div><div className="chip-row">{account.file?.plugins?.length ? account.file.plugins.map((plugin) => <span className="chip" key={`${plugin.source}:${plugin.id}`}>{plugin.id}<span className="muted"> · {plugin.source === 'public' ? '公用' : '私有'}</span>{plugin.enabled === false ? <span className="muted"> · 停用</span> : null}</span>) : <span className="muted">未启用插件</span>}</div>
                  {account.error ? <p className="inline-error">{account.error}</p> : null}
                </div><div className="account-actions">
                  {isEditing ? <CancelButton size="sm" icon="close" disabled={Boolean(busy)} onClick={cancelEdit}>取消编辑</CancelButton> : <Button size="sm" icon="settings" disabled={Boolean(busy)} onClick={() => beginEdit(account)}>编辑插件</Button>}
                  <Button size="sm" icon="refresh" busy={busy === `${account.accountId}:reload`} disabled={Boolean(busy)} onClick={() => void reload(account.accountId)}>重新加载</Button>
                  <Button size="sm" icon="copy" onClick={() => void copyText(account.dir)}>复制目录</Button>
                </div></div>
                {isEditing ? <form className="profile-editor" onSubmit={(event) => { event.preventDefault(); void saveProfile(account); }}>
                  <div className="plugin-picker">{plugins.length ? plugins.map((plugin) => <label className="check-row" key={plugin.ref.id}><Checkbox disabled={Boolean(busy)} checked={pluginIds.includes(plugin.ref.id)} onChange={(event) => setPluginIds((current) => event.target.checked ? [...current, plugin.ref.id] : current.filter((id) => id !== plugin.ref.id))} /><span><strong>{plugin.manifest.name ?? plugin.ref.id}</strong><span className="muted mono"> @{plugin.ref.revision}</span>{plugin.manifest.description ? <span className="check-desc">{plugin.manifest.description}</span> : null}</span></label>) : <span className="muted">资源库中还没有公用插件</span>}</div>
                  <div className="form-submit"><CancelButton type="button" variant="ghost" disabled={Boolean(busy)} onClick={cancelEdit}>取消</CancelButton><ConfirmButton type="submit" variant="primary" busy={busy === `${account.accountId}:save`}>保存插件资料</ConfirmButton></div>
                </form> : null}
              </div>;
            })}</div>
          </Card> : null}
        </>
      )}
    </div>
  );
}

interface DisplayProfile {
  nickname: string;
  signature: string;
  avatarDataUrl?: string;
}

const EMPTY_DISPLAY: DisplayProfile = { nickname: '', signature: '' };

function AccountDisplayEditor({ accountId, fallbackAvatarDataUrl, onSaved }: {
  accountId: string;
  fallbackAvatarDataUrl?: string;
  onSaved?: () => Promise<void>;
}) {
  const [profiles, setProfiles] = useState<Record<string, DisplayProfile>>({});
  const [drafts, setDrafts] = useState<Record<string, DisplayProfile>>({});
  const [busyFor, setBusyFor] = useState<string>();
  const [feedback, setFeedback] = useState<{ accountId: string; text: string; error?: boolean }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const requestGeneration = useRef(0);
  const saved = profiles[accountId] ?? EMPTY_DISPLAY;
  const draft = drafts[accountId] ?? saved;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const previewAvatarDataUrl = draft.avatarDataUrl ?? fallbackAvatarDataUrl;
  const previewAvatarLabel = draft.avatarDataUrl ? `${accountId} 本地展示头像` : `${accountId} QQ 头像`;

  useEffect(() => {
    if (profiles[accountId]) return;
    const generation = ++requestGeneration.current;
    api<{ display: DisplayProfile }>(`/accounts/${encodeURIComponent(accountId)}/display`)
      .then(({ display }) => {
        if (generation !== requestGeneration.current) return;
        setProfiles((current) => ({ ...current, [accountId]: display }));
      })
      .catch((error: unknown) => {
        if (generation === requestGeneration.current) setFeedback({ accountId, text: errorMessage(error), error: true });
      });
    return () => { requestGeneration.current += 1; };
  }, [accountId, profiles]);

  const updateDraft = (update: (current: DisplayProfile) => DisplayProfile): void => {
    setDrafts((current) => ({ ...current, [accountId]: update(current[accountId] ?? saved) }));
  };

  const save = async (): Promise<void> => {
    const targetAccount = accountId;
    const targetDraft = draft;
    setBusyFor(targetAccount);
    setFeedback(undefined);
    try {
      const result = await api<{ display: DisplayProfile }>(`/accounts/${encodeURIComponent(targetAccount)}/display`, {
        method: 'PUT', body: JSON.stringify({ display: targetDraft })
      });
      setProfiles((current) => ({ ...current, [targetAccount]: result.display }));
      setDrafts((current) => {
        const next = { ...current };
        delete next[targetAccount];
        return next;
      });
      setFeedback({ accountId: targetAccount, text: '本地主页展示资料已保存。' });
      void onSaved?.();
    } catch (error) {
      setFeedback({ accountId: targetAccount, text: errorMessage(error), error: true });
    } finally {
      setBusyFor((current) => current === targetAccount ? undefined : current);
    }
  };

  const chooseAvatar = async (file?: File): Promise<void> => {
    if (!file) return;
    const targetAccount = accountId;
    try {
      const avatarDataUrl = await optimizeAvatar(file);
      setDrafts((current) => ({ ...current, [targetAccount]: { ...(current[targetAccount] ?? profiles[targetAccount] ?? EMPTY_DISPLAY), avatarDataUrl } }));
      setFeedback({ accountId: targetAccount, text: '头像已载入预览；保存后会按 QQ 账号持久化。' });
    } catch (error) {
      setFeedback({ accountId: targetAccount, text: errorMessage(error), error: true });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const resetAvatar = (): void => {
    updateDraft((current) => {
      const next = { ...current };
      delete next.avatarDataUrl;
      return next;
    });
    setFeedback({ accountId, text: '已选择恢复本地默认头像；保存后生效。' });
  };

  return (
    <Card title={`账号展示资料 · QQ ${accountId}`} subtitle="仅用于 nowadays 主页展示，不读取或修改 QQ 个人资料。昵称、签名和本地头像都按账号保存。">
      <div className="display-profile-editor">
        <AccountAvatar dataUrl={previewAvatarDataUrl} label={previewAvatarLabel} className="account-avatar large" iconSize={42} />
        <div className="display-profile-fields">
          <div className="form-grid">
            <Field label="主页昵称（本地展示）"><Input maxLength={64} value={draft.nickname} onChange={(event) => updateDraft((current) => ({ ...current, nickname: event.target.value }))} placeholder="例如：晚风" /></Field>
            <Field label="主页签名（本地展示）"><Input maxLength={160} value={draft.signature} onChange={(event) => updateDraft((current) => ({ ...current, signature: event.target.value }))} placeholder="写一句主页签名" /></Field>
          </div>
          <Input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void chooseAvatar(event.target.files?.[0])} />
          <div className="display-profile-actions">
            <Button size="sm" variant="ghost" icon="folder" onClick={() => fileInput.current?.click()}>选择本地头像</Button>
            {draft.avatarDataUrl ? <Button size="sm" variant="ghost" onClick={resetAvatar}>恢复默认头像</Button> : null}
            <ConfirmButton size="sm" variant="primary" busy={busyFor === accountId} disabled={!dirty || busyFor === accountId} onClick={() => void save()}>保存展示资料</ConfirmButton>
          </div>
          {!draft.avatarDataUrl && fallbackAvatarDataUrl ? <span className="field-hint">未设置本地头像时显示 QQ 公开头像；选择本地头像后优先使用本地图片。</span> : null}
          {feedback?.accountId === accountId ? <div className={feedback.error ? 'inline-error' : 'muted'}>{feedback.text}</div> : null}
        </div>
      </div>
    </Card>
  );
}

async function optimizeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理所选图片。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.84, 0.68, 0.5, 0.34]) {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('图片压缩失败。')), 'image/jpeg', quality));
      if (blob.size <= 512 * 1024) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('读取图片失败。'));
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败。'));
          reader.readAsDataURL(blob);
        });
      }
    }
    throw new Error('头像图片过大，请选择较小的图片。');
  } finally {
    bitmap.close();
  }
}
