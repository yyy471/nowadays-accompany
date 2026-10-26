import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type { AccountSummary, ArtifactItem, ArtifactsResponse, AccountsResponse, ArtifactRef } from '../types';
import { Button, CancelButton, Card, Checkbox, ConfirmButton, Empty, ErrorNote, Field, Icon, Input, LoadingNote, Select, Tag, copyText, useConfirm } from '../ui';
import { AccountAvatar } from '../components/AccountAvatar';
import { mergeAccountPlugins } from '../lib/account-plugins';
import { useAccountEntryFocus } from '../lib/use-account-entry-focus';
import { hashRevision } from '../lib/drafts/registry';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { useDraftProtection } from '../components/DraftProtectionProvider';
import { WorldbookSettings, type WorldbookOptions } from '../components/WorldbookSettings';
import type { ConversationWorldbookSource, EffectiveWorldbook } from '../../../../src/contracts/worldbook.js';

interface AccountsPageProps {
  locked?: boolean;
  view: 'roles' | 'plugins';
  accounts?: AccountsResponse;
  accountsLoading: boolean;
  accountsError?: string;
  artifacts?: ArtifactsResponse;
  artifactsLoading: boolean;
  artifactsError?: string;
  refresh: () => Promise<void>;
  onRetryArtifacts: () => Promise<void>;
  onGoSlots: () => void;
  onGoArtifacts: () => void;
  focusDisplay?: { accountId: string };
  onFocusDisplayHandled: () => void;
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
  worldbook?: WorldbookOptions;
  worldbookEntryCount?: number;
  worldbookDefaults?: { scanDepth: number; budgetChars: number };
  worldbookSource?: ConversationWorldbookSource;
  effectiveWorldbook?: EffectiveWorldbook;
}

interface RoleCardChoice {
  value: string;
  ref: ArtifactRef;
  label: string;
  mode: 'follow' | 'fixed';
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
      label: `${name} · ${item.ref.source === 'public' ? '公用' : '私有'} · 当前 ${item.ref.revision}`,
      mode: 'follow'
    });
  }
  for (const item of versions) {
    const name = item.manifest.name ?? item.ref.id;
    choices.push({
      value: roleCardValue(item.ref, 'fixed'),
      ref: item.ref,
      label: `${name} · ${item.ref.source === 'public' ? '公用' : '私有'} · @${item.ref.revision}`,
      mode: 'fixed'
    });
  }
  return choices.sort((left, right) => {
    if (left.mode !== right.mode) return left.mode === 'follow' ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

export function AccountsPage({ view, accounts, accountsLoading, accountsError, artifacts, artifactsLoading, artifactsError, refresh, onRetryArtifacts, onGoSlots, onGoArtifacts, focusDisplay, onFocusDisplayHandled, locked = false }: AccountsPageProps) {
  const list = accounts?.accounts ?? [];
  const confirm = useConfirm();
  const { requestTransition, registry } = useDraftProtection();
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const displayRef = useRef<HTMLDivElement>(null);
  const publicItems = artifacts?.artifacts ?? [];
  const [selectedAccount, setSelectedAccount] = useState('');
  const [loadedAccountId, setLoadedAccountId] = useState<string>();
  const [privateItems, setPrivateItems] = useState<ArtifactItem[]>([]);
  const [bindings, setBindings] = useState<RoleBinding[]>([]);
  const [bindingsError, setBindingsError] = useState<string>();
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [entryWarning, setEntryWarning] = useState<string>();
  const [bindingKind, setBindingKind] = useState<'private' | 'group'>('private');
  const [peerId, setPeerId] = useState('');
  const [roleCard, setRoleCard] = useState('');
  const [editing, setEditing] = useState<string>();
  const editingRef = useRef<string | undefined>(undefined);
  const [pluginIds, setPluginIds] = useState<string[]>([]);
  const [pluginBaseline, setPluginBaseline] = useState<string[]>([]);
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
  const publicResourcesLoaded = artifacts !== undefined;
  const resourcesReady = publicResourcesLoaded && loadedAccountId === selectedAccount && !bindingsLoading;
  const roleDraftDirty = Boolean(peerId.trim() || roleCard);
  const pluginDraftDirty = Boolean(editing) && [...new Set(pluginIds)].sort().join('|') !== [...new Set(pluginBaseline)].sort().join('|');

  useDraftRegistration({
    id: `role-binding:${selectedAccount || 'none'}`,
    owner: 'page',
    accountId: selectedAccount || undefined,
    label: selectedAccount ? `账号 ${selectedAccount} 的会话角色绑定` : '会话角色绑定',
    dirty: roleDraftDirty,
    busy: busy === 'binding' || Boolean(busy?.startsWith('remove:')),
    revision: hashRevision({ bindingKind, peerId, roleCard }),
    discard: () => { setPeerId(''); setRoleCard(''); setBindingKind('private'); },
    // 绑定表单state随AccountsPage常驻；插件视图仅隐藏，草稿继续登记，离开Accounts时统一检查。
    enabled: Boolean(selectedAccount)
  });

  useDraftRegistration({
    id: `plugins:${editing ?? 'none'}`,
    owner: 'page',
    accountId: editing,
    label: editing ? `账号 ${editing} 的插件资料` : '插件资料',
    dirty: pluginDraftDirty,
    busy: Boolean(editing && busy === `${editing}:save`),
    revision: hashRevision({ editing: editing ?? '', pluginIds: [...new Set(pluginIds)].sort() }),
    discard: () => {
      editingRef.current = undefined;
      setEditing(undefined);
      setPluginBaseline([]);
    },
    enabled: Boolean(editing)
  });

  const selectAccount = (next: string): void => {
    if (accountRef.current === next) return;
    accountRef.current = next;
    accountGeneration.current += 1;
    setSelectedAccount(next);
    setLoadedAccountId(undefined);
    setBindings([]);
    setBindingsError(undefined);
    setBindingsLoading(false);
    setPrivateItems([]);
    setRoleCard('');
    setPeerId('');
    setPluginIds([]);
    setPluginBaseline([]);
    setEditing(undefined);
    editingRef.current = undefined;
    setBusy(undefined);
    setError(undefined);
    setNotice(undefined);
  };

  const isCurrentAccount = (id: string, generation: number): boolean =>
    accountRef.current === id && accountGeneration.current === generation;

  const reloadBindingsWithGuard = async (): Promise<void> => {
    if (lockedRef.current || busy || bindingsLoading) return;
    const targetAccount = accountRef.current;
    const generation = accountGeneration.current;
    const ids = registry.snapshot({ kind: 'account', accountId: targetAccount }).filter(entry => entry.id.startsWith('worldbook:')).map(entry => entry.id);
    const result = await requestTransition({ scope: { kind: 'ids', ids }, actionLabel: '重新读取会话绑定' });
    if (lockedRef.current || !isCurrentAccount(targetAccount, generation)) return;
    if (result.ok) setReloadKey(value => value + 1);
    else if (result.message) setError(result.message);
  };

  const accountIds = useMemo(() => accounts?.accounts.map((account) => account.accountId), [accounts]);
  useAccountEntryFocus({
    accountIds,
    selectedAccount,
    focusAccountId: focusDisplay?.accountId,
    entryWarning,
    displayRef,
    selectAccount,
    setEntryWarning,
    onHandled: onFocusDisplayHandled
  });

  useEffect(() => {
    if (!selectedAccount) return;
    let cancelled = false;
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    setError(undefined);
    setBindingsError(undefined);
    setBindingsLoading(true);
    Promise.all([
      api<{ bindings: RoleBinding[] }>(`/accounts/${encodeURIComponent(targetAccount)}/role-bindings`),
      api<{ artifacts: ArtifactItem[] }>(`/accounts/${encodeURIComponent(targetAccount)}/artifacts`)
    ]).then(([bindingResponse, artifactResponse]) => {
      if (cancelled || !isCurrentAccount(targetAccount, generation)) return;
      setBindings(bindingResponse.bindings);
      setPrivateItems(artifactResponse.artifacts);
      setLoadedAccountId(targetAccount);
    }).catch((loadError: unknown) => {
      if (!cancelled && isCurrentAccount(targetAccount, generation)) setBindingsError(errorMessage(loadError));
    }).finally(() => {
      if (!cancelled && isCurrentAccount(targetAccount, generation)) setBindingsLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedAccount, reloadKey]);

  const selectAccountWithGuard = async (next: string): Promise<void> => {
    if (accountRef.current === next) return;
    const ids = [`role-binding:${accountRef.current}`];
    ids.push(...registry.snapshot({ kind: 'account', accountId: accountRef.current }).filter(entry => entry.id.startsWith('worldbook:')).map(entry => entry.id));
    if (editingRef.current) ids.push(`plugins:${editingRef.current}`);
    const result = await requestTransition({ scope: { kind: 'ids', ids }, actionLabel: '切换账号' });
    if (!result.ok) {
      if (result.message) setError(result.message);
      return;
    }
    setEntryWarning(undefined);
    selectAccount(next);
  };

  const closeEditor = (): void => {
    editingRef.current = undefined;
    setEditing(undefined);
    setPluginBaseline([]);
  };

  const beginEdit = async (account: AccountSummary): Promise<void> => {
    if (busy) return;
    if (editingRef.current && editingRef.current !== account.accountId) {
      const result = await requestTransition({
        scope: { kind: 'ids', ids: [`plugins:${editingRef.current}`] },
        actionLabel: '编辑另一个账号的插件'
      });
      if (!result.ok) {
        if (result.message) setError(result.message);
        return;
      }
    }
    const selectedIds = (account.file?.plugins ?? []).filter((plugin) => plugin.enabled !== false && plugin.source === 'public').map((plugin) => plugin.id);
    editingRef.current = account.accountId;
    setEditing(account.accountId);
    setPluginIds(selectedIds);
    setPluginBaseline(selectedIds);
    setError(undefined);
    setNotice(undefined);
  };

  const cancelEdit = async (): Promise<void> => {
    const target = editingRef.current;
    if (!target) return;
    const result = await requestTransition({
      scope: { kind: 'ids', ids: [`plugins:${target}`] },
      actionLabel: '取消编辑'
    });
    if (!result.ok) {
      if (result.message) setError(result.message);
      return;
    }
    closeEditor();
  };

  const saveProfile = async (account: AccountSummary): Promise<void> => {
    const targetAccount = account.accountId;
    const targetPluginIds = [...pluginIds];
    const operation = `${targetAccount}:save`;
    if (editingRef.current !== targetAccount || busy) return;
    if (!artifacts) {
      setError('资源库尚未读取完成，请稍后再保存插件资料。');
      return;
    }
    setBusy(operation);
    setError(undefined);
    setNotice(undefined);
    try {
      const existing = account.file?.plugins ?? [];
      const nextPlugins = mergeAccountPlugins(existing, plugins.map((plugin) => plugin.ref.id), targetPluginIds);
      const profile = {
        version: 1,
        ...(account.file?.roleCard ? { roleCard: account.file.roleCard } : {}),
        plugins: nextPlugins
      };
      const result = await api<{ reload?: { ok: boolean; error?: string } }>(`/accounts/${encodeURIComponent(targetAccount)}/profile`, {
        method: 'PUT', body: JSON.stringify({ profile })
      });
      if (editingRef.current !== targetAccount) return;
      if (result.reload && !result.reload.ok) setError(`资料已保存，但热加载失败：${result.reload.error ?? '未知错误'}`);
      else {
        setNotice(`账号 ${targetAccount} 的插件资料已保存${result.reload ? '并热加载' : ''}。`);
        closeEditor();
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
    if (!targetAccount || loadedAccountId !== targetAccount || !peerId.trim() || !card || busy || bindingsLoading) {
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
    if (binding.accountId !== targetAccount || loadedAccountId !== targetAccount || busy || bindingsLoading) return;
    const leave = await requestTransition({ scope: { kind: 'ids', ids: [`worldbook:${binding.accountId}/${binding.kind}/${binding.peerId}`] }, actionLabel: '解除角色绑定' });
    if (!leave.ok) { if (leave.message) setError(leave.message); return; }
    if (!isCurrentAccount(targetAccount, generation)) return;
    if (!await confirm({
      title: '解除角色绑定',
      description: `解除${binding.kind === 'private' ? '私聊' : '群聊'} ${binding.peerId} 的角色绑定？该会话将停止自动回复，直到重新绑定。`,
      confirmLabel: '解除绑定',
      cancelLabel: '保留绑定',
      tone: 'danger'
    })) return;
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
          <strong>每个私聊或群聊需要单独绑定角色卡。</strong>
          <span>未绑定或角色卡失效时，不会自动回复，也不会调用模型或工具。</span>
        </div>
      </div> : null}
      {accountsError && list.length > 0 ? <ErrorNote message={`账号资料刷新失败：${accountsError}，当前显示上次读取的数据。`} onRetry={() => void refresh()} /> : null}
      {artifactsError ? <ErrorNote message={artifacts ? `资源库刷新失败：${artifactsError}，当前显示上次读取的数据。` : `无法读取资源库：${artifactsError}`} onRetry={() => void onRetryArtifacts()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {list.length === 0 ? (
        accountsLoading ? <Card><LoadingNote label="正在读取账号…" /></Card>
          : accountsError ? <Card><Empty icon="accounts" title="无法读取账号" description={accountsError} action={<Button icon="refresh" onClick={() => void refresh()}>重试</Button>} /></Card>
            : <Card><Empty icon="accounts" title="还没有可用的 QQ 账号" description="在“实例与监听”中注入并开始监听后，账号会出现在这里。" action={<Button variant="primary" icon="slots" onClick={onGoSlots}>去实例与监听</Button>} /></Card>
      ) : (
        <>
          {view === 'roles' && entryWarning ? <div className="notice notice-warn" role="status">{entryWarning}</div> : null}
          {view === 'roles' && list.length ? <div className="policy-toolbar account-context-toolbar">
            <Field label="当前 QQ 账号"><Select value={selectedAccount} disabled={Boolean(busy)} onChange={(event) => void selectAccountWithGuard(event.target.value)}>
              {selected ? null : <option value="">请选择账号…</option>}
              {list.map((account) => <option key={account.accountId} value={account.accountId}>{account.nickname ? `${account.nickname}（${account.accountId}）` : account.accountId}</option>)}
            </Select></Field>
            <span className="muted">下方展示资料与会话角色绑定均针对该账号。</span>
          </div> : null}
          {selected ? (
            <div hidden={view !== 'roles'}><Card title="会话角色绑定" actions={<Button size="sm" icon="refresh" busy={bindingsLoading} disabled={Boolean(busy) || bindingsLoading || locked} onClick={() => void reloadBindingsWithGuard()}>重新读取</Button>}>
              <div className="policy-toolbar">
                <Field label="会话类型"><Select disabled={Boolean(busy)} value={bindingKind} onChange={(event) => setBindingKind(event.target.value as 'private' | 'group')}><option value="private">私聊</option><option value="group">群聊</option></Select></Field>
                <Field label={bindingKind === 'private' ? '对方 QQ' : '群号'}><Input disabled={Boolean(busy)} value={peerId} onChange={(event) => setPeerId(event.target.value.replace(/[^0-9A-Za-z_-]/g, ''))} placeholder={bindingKind === 'private' ? '输入私聊 QQ 号' : '输入群号'} /></Field>
                <Field label="角色卡"><Select disabled={Boolean(busy)} value={roleCard} onChange={(event) => setRoleCard(event.target.value)}><option value="">选择角色卡…</option>
                  {roleChoices.some((choice) => choice.mode === 'follow') ? <optgroup label="跟随当前版本">
                    {roleChoices.filter((choice) => choice.mode === 'follow').map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </optgroup> : null}
                  {roleChoices.some((choice) => choice.mode === 'fixed') ? <optgroup label="固定版本">
                    {roleChoices.filter((choice) => choice.mode === 'fixed').map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                  </optgroup> : null}
                </Select></Field>
                <ConfirmButton variant="primary" busy={busy === 'binding'} disabled={loadedAccountId !== selectedAccount || Boolean(busy) || bindingsLoading} onClick={() => void saveBinding()}>保存绑定</ConfirmButton>
              </div>
              {bindingsError ? <ErrorNote message={loadedAccountId === selectedAccount ? `无法重新读取会话绑定或私有资源：${bindingsError}，当前显示上次读取的数据。` : `无法读取会话绑定或私有资源：${bindingsError}`} onRetry={() => void reloadBindingsWithGuard()} /> : null}
              {bindingsLoading ? <LoadingNote label={loadedAccountId === selectedAccount ? '正在重新读取会话绑定…' : '正在读取该账号的会话绑定…'} /> : null}
              {loadedAccountId === selectedAccount ? (
                activeBindings.length ? <div className="binding-list">{activeBindings.map((binding) => (
                  <div key={`${binding.accountId}/${bindingKey(binding)}`}><div className="binding-row">
                    <div className="binding-row-info"><strong>{binding.kind === 'private' ? '私聊' : '群聊'} {binding.peerId}</strong><span>{binding.cardName ?? binding.roleCard.id} · {binding.roleCard.source === 'public' ? '公用' : '私有'} · {binding.roleCard.revision ? `固定版本 @${binding.roleCard.revision}` : `跟随当前${binding.resolvedRevision ? `（${binding.resolvedRevision}）` : ''}`}</span></div>
                    <Tag tone={binding.state === 'ready' ? 'ok' : 'bad'}>{binding.state === 'ready' ? '已解析' : '缺少角色卡'}</Tag>
                    <Button size="sm" variant="ghost" busy={busy === `remove:${bindingKey(binding)}`} disabled={Boolean(busy) || bindingsLoading || binding.accountId !== selectedAccount} onClick={() => void removeBinding(binding)}>解除</Button>
                  </div><WorldbookSettings binding={binding} locked={locked} visible={view === 'roles'} disabled={Boolean(busy) || bindingsLoading || binding.accountId !== selectedAccount}
                    onSaved={updated => { if (accountRef.current === binding.accountId) setBindings(current => current.map(item => bindingKey(item) === bindingKey(binding) && item.accountId === binding.accountId ? { ...item, ...updated } : item)); }}
                    onReload={() => { if (!lockedRef.current && accountRef.current === binding.accountId) setReloadKey(value => value + 1); }}
                  /></div>
                ))}</div> : <p className="muted">该账号还没有会话角色绑定。未绑定会话不会自动处理。</p>
              ) : bindingsError || bindingsLoading ? null : <LoadingNote label="正在读取该账号的会话绑定…" />}
              {!publicResourcesLoaded && artifactsLoading ? <LoadingNote label="正在读取公用资源…" /> : null}
              {!roleChoices.length && resourcesReady ? <div className="notice notice-warn"><span>当前没有可选角色卡，请先在资源库添加角色卡。</span><Button size="sm" variant="ghost" onClick={onGoArtifacts}>去资源库</Button></div> : null}
            </Card></div>
          ) : null}
          {selected ? <div ref={displayRef} className="display-profile-anchor" hidden={view !== 'roles'}>
            <AccountDisplayEditor
              accountId={selectedAccount}
              fallbackAvatarDataUrl={list.find((account) => account.accountId === selectedAccount)?.avatarDataUrl}
              onSaved={refresh}
            />
          </div> : null}
          {view === 'plugins' ? <Card title="账号插件资料">
            <div className="account-list">{list.map((account) => {
              const isEditing = editing === account.accountId;
              const privatePlugins = (account.file?.plugins ?? []).filter((plugin) => plugin.source !== 'public');
              return <div key={account.accountId} className="account-card">
                <div className="account-head">
                  <div className="account-identity"><AccountAvatar dataUrl={account.avatarDataUrl} label={`${account.accountId} 头像`} className="avatar" iconSize={16} /><div><h3>{account.nickname || account.accountId}</h3><span className="muted mono">QQ {account.accountId}</span></div></div>
                  <div className="account-head-actions"><Tag tone={account.state === 'ready' ? 'ok' : 'bad'}>{accountStateLabel(account.state)}</Tag></div>
                </div>
                <div className="account-body"><div className="account-profile-summary">
                  {account.file?.roleCard ? <p className="muted">旧默认卡 {account.file.roleCard.source}:{account.file.roleCard.id}（仅迁移信息，不参与自动处理）</p> : null}
                  <div className="meta-label plugin-label">插件</div><div className="chip-row">{account.file?.plugins?.length ? account.file.plugins.map((plugin) => <span className="chip" key={`${plugin.source}:${plugin.id}`}>{plugin.id}<span className="muted"> · {plugin.source === 'public' ? '公用' : '私有'}</span>{plugin.enabled === false ? <span className="muted"> · 停用</span> : null}</span>) : <span className="muted">未启用插件</span>}</div>
                  {account.error ? <p className="inline-error">{account.error}</p> : null}
                </div><div className="account-actions">
                  {isEditing ? <CancelButton size="sm" icon="close" disabled={Boolean(busy)} onClick={() => void cancelEdit()}>取消编辑</CancelButton> : <Button size="sm" icon="settings" disabled={Boolean(busy)} onClick={() => void beginEdit(account)}>编辑插件</Button>}
                  <Button size="sm" icon="refresh" busy={busy === `${account.accountId}:reload`} disabled={Boolean(busy)} onClick={() => void reload(account.accountId)}>应用到运行实例</Button>
                  <Button size="sm" icon="copy" onClick={() => void copyText(account.dir)}>复制目录</Button>
                </div></div>
                <details className="inline-details account-details">
                  <summary>目录与运行实例</summary>
                  <p className="muted mono">{account.dir}</p>
                  <p className="muted">{account.slots.length ? `运行实例：${account.slots.join('、')}` : '当前没有运行实例。'}</p>
                </details>
                {isEditing ? <form className="profile-editor" onSubmit={(event) => { event.preventDefault(); void saveProfile(account); }}>
                  <div className="plugin-picker">{artifacts === undefined ? (artifactsError ? <span className="inline-error">资源库读取失败，暂不能保存插件资料。</span> : <span className="muted">正在读取资源库…</span>) : plugins.length ? plugins.map((plugin) => <label className="check-row" key={plugin.ref.id}><Checkbox disabled={Boolean(busy)} checked={pluginIds.includes(plugin.ref.id)} onChange={(event) => setPluginIds((current) => event.target.checked ? [...current, plugin.ref.id] : current.filter((id) => id !== plugin.ref.id))} /><span><strong>{plugin.manifest.name ?? plugin.ref.id}</strong><span className="muted mono"> @{plugin.ref.revision}</span>{plugin.manifest.description ? <span className="check-desc">{plugin.manifest.description}</span> : null}</span></label>) : <span className="muted">资源库中还没有公用插件</span>}</div>
                  {privatePlugins.length ? <p className="field-hint">私有插件由账号目录维护，保存时会原样保留：{privatePlugins.map((plugin) => plugin.id).join('、')}</p> : null}
                  <div className="form-submit"><CancelButton type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => void cancelEdit()}>取消</CancelButton><ConfirmButton type="submit" variant="primary" busy={busy === `${account.accountId}:save`} disabled={Boolean(busy) || artifacts === undefined}>保存插件资料</ConfirmButton></div>
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
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [busyFor, setBusyFor] = useState<string>();
  const [processingAvatar, setProcessingAvatar] = useState(false);
  const [feedback, setFeedback] = useState<{ accountId: string; text: string; error?: boolean }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const requestGeneration = useRef(0);
  const confirm = useConfirm();
  const loaded = profiles[accountId] !== undefined;
  const loadError = loadErrors[accountId];
  const saved = profiles[accountId] ?? EMPTY_DISPLAY;
  const draft = drafts[accountId] ?? saved;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const previewAvatarDataUrl = draft.avatarDataUrl ?? fallbackAvatarDataUrl;
  const previewAvatarLabel = draft.avatarDataUrl ? `${accountId} 本地展示头像` : `${accountId} QQ 头像`;
  const draftAccountIds = Object.keys(drafts)
    .filter((id) => JSON.stringify(drafts[id]) !== JSON.stringify(profiles[id] ?? EMPTY_DISPLAY))
    .sort();

  useDraftRegistration({
    id: 'display-profiles',
    owner: 'page',
    label: draftAccountIds.length === 1
      ? `账号 ${draftAccountIds[0]} 的展示资料`
      : draftAccountIds.length > 1
        ? `账号 ${draftAccountIds.slice(0, 2).join('、')}${draftAccountIds.length > 2 ? ` 等 ${draftAccountIds.length} 个账号` : ''}的展示资料`
        : '展示资料',
    dirty: draftAccountIds.length > 0,
    busy: Boolean(busyFor) || processingAvatar,
    revision: hashRevision(Object.fromEntries(Object.keys(drafts).sort().map((id) => [id, drafts[id]]))),
    discard: () => { setDrafts({}); setFeedback(undefined); }
  });

  useEffect(() => {
    if (profiles[accountId]) return;
    setLoadErrors((current) => {
      if (!(accountId in current)) return current;
      const next = { ...current };
      delete next[accountId];
      return next;
    });
    const generation = ++requestGeneration.current;
    api<{ display: DisplayProfile }>(`/accounts/${encodeURIComponent(accountId)}/display`)
      .then(({ display }) => {
        if (generation !== requestGeneration.current) return;
        setProfiles((current) => ({ ...current, [accountId]: display }));
        setLoadErrors((current) => {
          if (!(accountId in current)) return current;
          const next = { ...current };
          delete next[accountId];
          return next;
        });
      })
      .catch((error: unknown) => {
        if (generation !== requestGeneration.current) return;
        setLoadErrors((current) => ({ ...current, [accountId]: errorMessage(error) }));
      });
    return () => { requestGeneration.current += 1; };
  }, [accountId, profiles, reloadKey]);

  const retryLoad = (): void => {
    setLoadErrors((current) => {
      if (!(accountId in current)) return current;
      const next = { ...current };
      delete next[accountId];
      return next;
    });
    setReloadKey((value) => value + 1);
  };

  const updateDraft = (update: (current: DisplayProfile) => DisplayProfile): void => {
    setDrafts((current) => ({ ...current, [accountId]: update(current[accountId] ?? saved) }));
  };

  const frozen = busyFor === accountId || processingAvatar;

  const save = async (): Promise<void> => {
    if (!loaded || frozen) return;
    const targetAccount = accountId;
    const submittedDraft = draft;
    const submittedKey = JSON.stringify(submittedDraft);
    setBusyFor(targetAccount);
    setFeedback(undefined);
    try {
      const result = await api<{ display: DisplayProfile }>(`/accounts/${encodeURIComponent(targetAccount)}/display`, {
        method: 'PUT', body: JSON.stringify({ display: submittedDraft })
      });
      setProfiles((current) => ({ ...current, [targetAccount]: result.display }));
      setDrafts((current) => {
        const next = { ...current };
        // 仅当返回后该账号草稿仍是本次提交版本时才清除；期间的任何新编辑都要保留并继续标记为脏。
        if (next[targetAccount] === undefined || JSON.stringify(next[targetAccount]) === submittedKey) {
          delete next[targetAccount];
        }
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
    if (busyFor === accountId) return;
    const targetAccount = accountId;
    setProcessingAvatar(true);
    try {
      const avatarDataUrl = await optimizeAvatar(file);
      setDrafts((current) => ({ ...current, [targetAccount]: { ...(current[targetAccount] ?? profiles[targetAccount] ?? EMPTY_DISPLAY), avatarDataUrl } }));
      setFeedback({ accountId: targetAccount, text: '头像已载入预览；保存后会按 QQ 账号持久化。' });
    } catch (error) {
      setFeedback({ accountId: targetAccount, text: errorMessage(error), error: true });
    } finally {
      setProcessingAvatar(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const resetAvatar = async (): Promise<void> => {
    if (!draft.avatarDataUrl) return;
    if (!await confirm({
      title: '恢复默认头像？',
      description: '当前选择的本地头像尚未保存，恢复后会从草稿中移除。',
      confirmLabel: '恢复默认头像',
      cancelLabel: '保留预览',
      tone: 'danger'
    })) return;
    updateDraft((current) => {
      const next = { ...current };
      delete next.avatarDataUrl;
      return next;
    });
    setFeedback({ accountId, text: '已选择恢复本地默认头像；保存后生效。' });
  };

  return (
    <Card title={`账号展示资料 · QQ ${accountId}`} subtitle="仅用于 nowadays 主页展示，不读取或修改 QQ 个人资料。昵称、签名和本地头像都按账号保存。">
      {!loaded ? (
        <div className="display-profile-loading">
          {loadError ? <ErrorNote message={`无法读取展示资料：${loadError}`} onRetry={retryLoad} /> : <LoadingNote label="正在读取展示资料…" />}
        </div>
      ) : (
      <div className="display-profile-editor">
        <AccountAvatar dataUrl={previewAvatarDataUrl} label={previewAvatarLabel} className="account-avatar large" iconSize={42} />
        <div className="display-profile-fields">
          <div className="form-grid">
            <Field label="主页昵称（本地展示）"><Input maxLength={64} disabled={frozen} value={draft.nickname} onChange={(event) => updateDraft((current) => ({ ...current, nickname: event.target.value }))} placeholder="例如：晚风" /></Field>
            <Field label="主页签名（本地展示）"><Input maxLength={160} disabled={frozen} value={draft.signature} onChange={(event) => updateDraft((current) => ({ ...current, signature: event.target.value }))} placeholder="写一句主页签名" /></Field>
          </div>
          <Input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void chooseAvatar(event.target.files?.[0])} />
          <div className="display-profile-actions">
            <Button size="sm" variant="ghost" icon="folder" disabled={frozen} onClick={() => fileInput.current?.click()}>选择本地头像</Button>
            {draft.avatarDataUrl ? <Button size="sm" variant="ghost" disabled={frozen} onClick={() => void resetAvatar()}>恢复默认头像</Button> : null}
            <ConfirmButton size="sm" variant="primary" busy={busyFor === accountId} disabled={!dirty || frozen} onClick={() => void save()}>保存展示资料</ConfirmButton>
          </div>
          {!draft.avatarDataUrl && fallbackAvatarDataUrl ? <span className="field-hint">未设置本地头像时显示 QQ 公开头像；选择本地头像后优先使用本地图片。</span> : null}
          {feedback?.accountId === accountId ? <div className={feedback.error ? 'inline-error' : 'muted'}>{feedback.text}</div> : null}
        </div>
      </div>
      )}
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
