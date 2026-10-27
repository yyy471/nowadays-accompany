import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { errorMessage } from '../hooks';
import type {
  AccountsResponse,
  ArtifactItem,
  ArtifactsResponse,
  ExtensionChatKind,
  ExtensionEffectiveDto,
  ExtensionPolicyDto,
  ExtensionSwitchValue,
  ExtensionsResponse,
  ExtensionEffectiveResponse,
  ExtensionReloadResponse,
  PrivateSkillList,
  PublicSkillList,
  SkillDefinitionView,
  SkillPreview
} from '../types';
import {
  Button,
  CancelButton,
  Card,
  Checkbox,
  ConfirmButton,
  ControlButton,
  Empty,
  ErrorNote,
  Field,
  Icon,
  Input,
  LoadingNote,
  Select,
  Tag,
  useConfirm
} from '../ui';
import { mergeAccountPlugins } from '../lib/account-plugins';
import {
  buildPolicyPatch,
  catalogKeys,
  defaultSwitchValue,
  draftFromPolicy,
  policyDraftDirty,
  rawSwitchValue,
  resolveBelowScope,
  setScopeSwitch,
  switchOriginLabel,
  type ExtensionPolicyDraft,
  type ExtensionScope,
  type ExtensionScopeLevel,
  type ExtensionSwitchSection
} from '../lib/extensions-policy';
import { extensionIssueLabel, skillSelectionReasonLabel } from '../lib/labels';
import { hashRevision } from '../lib/drafts/registry';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { useDraftProtection } from '../components/DraftProtectionProvider';
import { SkillDefinitionEditor } from '../components/SkillDefinitionEditor';

interface ExtensionsPageProps {
  locked?: boolean;
  accounts?: AccountsResponse;
  accountsLoading: boolean;
  accountsError?: string;
  artifacts?: ArtifactsResponse;
  artifactsLoading: boolean;
  artifactsError?: string;
  refresh: () => Promise<void>;
  onRetryArtifacts: () => Promise<void>;
  onGoSlots: () => void;
}

type ExtensionTab = 'plugins' | 'tools' | 'skills';

const TAB_LABELS: Record<ExtensionTab, string> = { plugins: '账号插件', tools: '工具授权', skills: 'Skill' };

function currentPublicPlugins(items: ArtifactItem[], current: Record<string, string>): ArtifactItem[] {
  const map = new Map<string, ArtifactItem>();
  for (const item of items) {
    if (item.manifest.kind !== 'plugin') continue;
    const existing = map.get(item.ref.id);
    const isCurrent = item.ref.source === 'public'
      ? current[`plugin:${item.ref.id}`] === item.ref.revision
      : !existing || (existing.ref.revision ?? '').localeCompare(item.ref.revision) < 0;
    if (!existing || isCurrent) map.set(item.ref.id, item);
  }
  return [...map.values()].sort((left, right) =>
    (left.manifest.name ?? left.ref.id).localeCompare(right.manifest.name ?? right.ref.id));
}

function installSignature(ids: string[]): string {
  return [...new Set(ids)].sort().join('|');
}

function policyContentSignature(policy: ExtensionPolicyDto): string {
  return JSON.stringify({
    authorizedTools: [...policy.authorizedTools].sort(),
    defaults: policy.defaults,
    byKind: policy.byKind,
    byConversation: policy.byConversation
  });
}

function skillSourceLabel(skill: ExtensionPolicyDto['catalog']['skills'][number]): string {
  if (skill.source === 'plugin') return '插件';
  if (skill.source === 'private') return skill.overrides === 'public' ? '私有覆盖公用' : '私有';
  return '公用';
}

function SwitchControl({
  value,
  inherited,
  disabled,
  onChange
}: {
  value: ExtensionSwitchValue;
  inherited: string;
  disabled: boolean;
  onChange: (value: ExtensionSwitchValue) => void;
}) {
  return (
    <Select
      className="extension-switch"
      value={value}
      disabled={disabled}
      aria-label="运行开关"
      onChange={(event) => onChange(event.target.value as ExtensionSwitchValue)}
    >
      <option value="inherit">继承（{inherited}）</option>
      <option value="on">开启</option>
      <option value="off">关闭</option>
    </Select>
  );
}

export function ExtensionsPage({
  accounts,
  accountsLoading,
  accountsError,
  artifacts,
  artifactsLoading,
  artifactsError,
  refresh,
  onRetryArtifacts,
  onGoSlots,
  locked = false
}: ExtensionsPageProps) {
  const list = accounts?.accounts ?? [];
  const confirm = useConfirm();
  const { requestTransition } = useDraftProtection();
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const accountRef = useRef('');
  const accountGeneration = useRef(0);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [loadedAccountId, setLoadedAccountId] = useState<string>();
  const [policy, setPolicy] = useState<ExtensionPolicyDto>();
  const [draft, setDraft] = useState<ExtensionPolicyDraft>();
  const [baseline, setBaseline] = useState<ExtensionPolicyDraft>();
  const [privateSkills, setPrivateSkills] = useState<PrivateSkillList>();
  const [publicSkills, setPublicSkills] = useState<PublicSkillList>();
  const [editingSkill, setEditingSkill] = useState<{ skill?: SkillDefinitionView; revision: string }>();
  const [copyFrom, setCopyFrom] = useState('');
  const [installIds, setInstallIds] = useState<string[]>([]);
  const [installBaseline, setInstallBaseline] = useState<string[]>([]);
  const [tab, setTab] = useState<ExtensionTab>('plugins');
  const [scopeLevel, setScopeLevel] = useState<ExtensionScopeLevel>('defaults');
  const [scopeKind, setScopeKind] = useState<ExtensionChatKind>('private');
  const [peerId, setPeerId] = useState('');
  const [effective, setEffective] = useState<ExtensionEffectiveDto>();
  const [preview, setPreview] = useState<SkillPreview>();
  const [effectiveLoading, setEffectiveLoading] = useState(false);
  const [effectiveError, setEffectiveError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [skillsError, setSkillsError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [effectiveKey, setEffectiveKey] = useState(0);
  const policyRef = useRef(policy);
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  policyRef.current = policy;
  draftRef.current = draft;
  baselineRef.current = baseline;

  const selected = list.find((account) => account.accountId === selectedAccount);
  const publicPlugins = useMemo(() => currentPublicPlugins(artifacts?.artifacts ?? [], artifacts?.current ?? {}), [artifacts]);
  const policyDirty = policyDraftDirty(draft, baseline);
  const installDirty = Boolean(loadedAccountId === selectedAccount)
    && installSignature(installIds) !== installSignature(installBaseline);
  const targetPeer = peerId.trim();
  const targetKind = scopeKind;
  const scope: ExtensionScope | undefined = scopeLevel === 'defaults'
    ? { level: 'defaults' }
    : scopeLevel === 'kind'
      ? { level: 'kind', kind: scopeKind }
      : targetPeer
        ? { level: 'conversation', kind: scopeKind, peerId: targetPeer }
        : undefined;

  const selectAccount = (next: string): void => {
    if (accountRef.current === next) return;
    accountRef.current = next;
    accountGeneration.current += 1;
    setSelectedAccount(next);
    setLoadedAccountId(undefined);
    setPolicy(undefined);
    setDraft(undefined);
    setBaseline(undefined);
    setPrivateSkills(undefined);
    setPublicSkills(undefined);
    setEditingSkill(undefined);
    setCopyFrom('');
    setInstallIds([]);
    setInstallBaseline([]);
    setEffective(undefined);
    setPreview(undefined);
    setEffectiveError(undefined);
    setLoadError(undefined);
    setSkillsError(undefined);
    setError(undefined);
    setNotice(undefined);
    setConflict(false);
    setBusy(undefined);
    setLoading(false);
    setScopeLevel('defaults');
    setScopeKind('private');
    setPeerId('');
  };

  const isCurrentAccount = (id: string, generation: number): boolean =>
    accountRef.current === id && accountGeneration.current === generation;

  const applyRuntimeView = (extensions: ExtensionPolicyDto): void => {
    setPolicy((current) => current ? { ...current, catalog: extensions.catalog, runtime: extensions.runtime } : current);
  };

  /**
   * Refreshes the catalog/runtime without touching the policy draft. A concurrent external policy
   * change is reported as a conflict instead of letting an old draft inherit the new revision.
   */
  const refreshPolicyView = async (): Promise<void> => {
    const targetAccount = accountRef.current;
    if (!targetAccount) return;
    const generation = accountGeneration.current;
    try {
      const response = await api<ExtensionsResponse>(`/accounts/${encodeURIComponent(targetAccount)}/extensions`);
      if (!isCurrentAccount(targetAccount, generation)) return;
      const fetched = response.extensions;
      const current = policyRef.current;
      if (!current) {
        setPolicy(fetched);
        return;
      }
      const dirty = policyDraftDirty(draftRef.current, baselineRef.current);
      if (dirty && policyContentSignature(current) !== policyContentSignature(fetched)) {
        setConflict(true);
        return;
      }
      setPolicy(fetched);
      if (dirty) {
        setBaseline(draftFromPolicy(fetched));
      } else {
        const next = draftFromPolicy(fetched);
        setDraft(next);
        setBaseline(next);
      }
    } catch (refreshError) {
      if (isCurrentAccount(targetAccount, generation)) {
        setSkillsError(`扩展策略刷新失败：${errorMessage(refreshError)}`);
      }
    }
  };

  const refreshRuntime = async (): Promise<void> => {
    const targetAccount = accountRef.current;
    if (!targetAccount) return;
    const generation = accountGeneration.current;
    setBusy('runtime');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<ExtensionsResponse>(`/accounts/${encodeURIComponent(targetAccount)}/extensions`);
      if (!isCurrentAccount(targetAccount, generation)) return;
      applyRuntimeView(response.extensions);
      setNotice('已刷新插件运行状态。');
      setEffectiveKey((value) => value + 1);
    } catch (refreshError) {
      if (isCurrentAccount(targetAccount, generation)) setError(`无法刷新运行状态：${errorMessage(refreshError)}`);
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  useEffect(() => {
    if (!selectedAccount && list.length > 0) {
      selectAccount(list[0]!.accountId);
      return;
    }
    if (selectedAccount && list.length > 0 && !list.some((account) => account.accountId === selectedAccount)) {
      if (policyDirty || installDirty || editingSkill) {
        setError(`账号 ${selectedAccount} 已不在当前账号列表中，请先保存或撤销草稿后重新选择账号。`);
        return;
      }
      selectAccount(list[0]!.accountId);
    }
  }, [list, selectedAccount, policyDirty, installDirty, editingSkill]);

  useEffect(() => {
    if (!selectedAccount) return;
    let cancelled = false;
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    setLoading(true);
    setLoadError(undefined);
    setSkillsError(undefined);
    Promise.allSettled([
      api<ExtensionsResponse>(`/accounts/${encodeURIComponent(targetAccount)}/extensions`),
      api<PrivateSkillList>(`/accounts/${encodeURIComponent(targetAccount)}/skills/private`),
      api<PublicSkillList>('/skills')
    ]).then(([extensionsResult, privateResult, publicResult]) => {
      if (cancelled || !isCurrentAccount(targetAccount, generation)) return;
      if (extensionsResult.status !== 'fulfilled') {
        setLoadError(errorMessage(extensionsResult.reason));
        return;
      }
      setPolicy(extensionsResult.value.extensions);
      setDraft(draftFromPolicy(extensionsResult.value.extensions));
      setBaseline(draftFromPolicy(extensionsResult.value.extensions));
      const skillFailures: string[] = [];
      if (privateResult.status === 'fulfilled') setPrivateSkills(privateResult.value);
      else skillFailures.push(`私有 Skill：${errorMessage(privateResult.reason)}`);
      if (publicResult.status === 'fulfilled') setPublicSkills(publicResult.value);
      else skillFailures.push(`公用 Skill：${errorMessage(publicResult.reason)}`);
      setSkillsError(skillFailures.length ? skillFailures.join('；') : undefined);
      setLoadedAccountId(targetAccount);
      const account = list.find((item) => item.accountId === targetAccount);
      const installed = (account?.file?.plugins ?? [])
        .filter((plugin) => plugin.enabled !== false && plugin.source === 'public')
        .map((plugin) => plugin.id);
      setInstallIds(installed);
      setInstallBaseline(installed);
    }).catch((loadFailure: unknown) => {
      if (!cancelled && isCurrentAccount(targetAccount, generation)) setLoadError(errorMessage(loadFailure));
    }).finally(() => {
      if (!cancelled && isCurrentAccount(targetAccount, generation)) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedAccount, reloadKey]);

  useEffect(() => {
    if (!selectedAccount || !targetPeer) {
      setEffective(undefined);
      setPreview(undefined);
      setEffectiveError(undefined);
      return;
    }
    let cancelled = false;
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    const kind = targetKind;
    const peer = targetPeer;
    setEffectiveLoading(true);
    setEffectiveError(undefined);
    Promise.allSettled([
      api<ExtensionEffectiveResponse>(`/accounts/${encodeURIComponent(targetAccount)}/extensions/effective?kind=${kind}&peerId=${encodeURIComponent(peer)}`),
      api<{ ok: true; preview: SkillPreview }>(`/accounts/${encodeURIComponent(targetAccount)}/skills/effective?kind=${kind}&peerId=${encodeURIComponent(peer)}`)
    ]).then(([effectiveResult, previewResult]) => {
      if (cancelled || !isCurrentAccount(targetAccount, generation)) return;
      if (effectiveResult.status === 'fulfilled') setEffective(effectiveResult.value.effective);
      else setEffective(undefined);
      if (previewResult.status === 'fulfilled') setPreview(previewResult.value.preview);
      else setPreview(undefined);
      const failures = [effectiveResult, previewResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => errorMessage(result.reason));
      setEffectiveError(failures.length ? [...new Set(failures)].join('；') : undefined);
    }).finally(() => {
      if (!cancelled && isCurrentAccount(targetAccount, generation)) setEffectiveLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedAccount, targetKind, targetPeer, effectiveKey]);

  useDraftRegistration({
    id: `extensions-policy:${selectedAccount || 'none'}`,
    owner: 'page',
    accountId: selectedAccount || undefined,
    label: selectedAccount ? `账号 ${selectedAccount} 的扩展策略` : '扩展策略',
    dirty: policyDirty,
    busy: busy === 'save',
    revision: hashRevision({ draft, baseline }),
    discard: () => { if (baseline) setDraft(baseline); setConflict(false); setError(undefined); },
    enabled: Boolean(selectedAccount && draft)
  });

  useDraftRegistration({
    id: `extensions-install:${selectedAccount || 'none'}`,
    owner: 'page',
    accountId: selectedAccount || undefined,
    label: selectedAccount ? `账号 ${selectedAccount} 的插件启用` : '插件启用',
    dirty: installDirty,
    busy: busy === 'install',
    revision: hashRevision({ installIds, installBaseline }),
    discard: () => { setInstallIds(installBaseline); setError(undefined); },
    enabled: Boolean(loadedAccountId === selectedAccount)
  });

  const skillEditorId = (accountId = accountRef.current): string =>
    `skill-private:${accountId}:${editingSkill?.skill?.id ?? 'new'}`;

  const selectAccountWithGuard = async (next: string): Promise<void> => {
    if (accountRef.current === next) return;
    const ids = [`extensions-policy:${accountRef.current}`, `extensions-install:${accountRef.current}`];
    if (editingSkill) ids.push(skillEditorId());
    const result = await requestTransition({ scope: { kind: 'ids', ids }, actionLabel: '切换账号' });
    if (!result.ok) { if (result.message) setError(result.message); return; }
    selectAccount(next);
  };

  const changeTab = async (next: ExtensionTab): Promise<void> => {
    if (next === tab) return;
    if (editingSkill) {
      const result = await requestTransition({ scope: { kind: 'ids', ids: [skillEditorId()] }, actionLabel: '切换标签' });
      if (!result.ok) { if (result.message) setError(result.message); return; }
      setEditingSkill(undefined);
    }
    setTab(next);
  };

  const reloadPolicy = async (): Promise<void> => {
    const ids = [`extensions-policy:${accountRef.current}`, `extensions-install:${accountRef.current}`];
    if (editingSkill) ids.push(skillEditorId());
    const result = await requestTransition({ scope: { kind: 'ids', ids }, actionLabel: '重新读取扩展策略' });
    if (!result.ok) { if (result.message) setError(result.message); return; }
    setEditingSkill(undefined);
    setConflict(false);
    setReloadKey((value) => value + 1);
    setEffectiveKey((value) => value + 1);
  };

  const discardPolicy = async (): Promise<void> => {
    const result = await requestTransition({
      scope: { kind: 'ids', ids: [`extensions-policy:${accountRef.current}`] },
      actionLabel: '撤销扩展策略修改',
      title: '撤销未保存的扩展策略？',
      description: '撤销后，插件开关、工具授权和 Skill 开关会恢复为上次保存的配置。',
      confirmLabel: '撤销修改'
    });
    if (!result.ok) { if (result.message) setError(result.message); return; }
    setConflict(false);
  };

  const savePolicy = async (): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    const currentPolicy = policy;
    const currentDraft = draft;
    if (!targetAccount || !currentPolicy || !currentDraft || busy || locked || loadedAccountId !== targetAccount) return;
    setBusy('save');
    setError(undefined);
    setNotice(undefined);
    setConflict(false);
    try {
      const response = await api<ExtensionsResponse>(`/accounts/${encodeURIComponent(targetAccount)}/extensions/policy`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: currentPolicy.revision,
          expectedProfileRevision: currentPolicy.profileRevision,
          patch: buildPolicyPatch(currentDraft, currentPolicy, catalogKeys(currentPolicy.catalog))
        })
      });
      if (!isCurrentAccount(targetAccount, generation)) return;
      setPolicy(response.extensions);
      const next = draftFromPolicy(response.extensions);
      setDraft(next);
      setBaseline(next);
      setNotice(`账号 ${targetAccount} 的扩展策略已保存。`);
      setEffectiveKey((value) => value + 1);
    } catch (saveError) {
      if (!isCurrentAccount(targetAccount, generation)) return;
      setError(errorMessage(saveError));
      if (saveError instanceof ApiError && saveError.code === 'extension_conflict') setConflict(true);
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const saveInstall = async (): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    const account = list.find((item) => item.accountId === targetAccount);
    if (!targetAccount || !account || busy || locked || loadedAccountId !== targetAccount) return;
    if (!artifacts) {
      setError('资源库尚未读取完成，请稍后再保存插件启用。');
      return;
    }
    setBusy('install');
    setError(undefined);
    setNotice(undefined);
    try {
      const existing = account.file?.plugins ?? [];
      const nextPlugins = mergeAccountPlugins(existing, publicPlugins.map((plugin) => plugin.ref.id), installIds);
      const result = await api<{ profile?: unknown; reload?: { ok: boolean; error?: string } }>(`/accounts/${encodeURIComponent(targetAccount)}/profile`, {
        method: 'PUT',
        body: JSON.stringify({
          profile: {
            version: 1,
            ...(account.file?.roleCard ? { roleCard: account.file.roleCard } : {}),
            plugins: nextPlugins
          }
        })
      });
      if (!isCurrentAccount(targetAccount, generation)) return;
      if (result.reload && !result.reload.ok) setError(`插件启用已保存，但热加载失败：${result.reload.error ?? '未知错误'}`);
      else setNotice(`账号 ${targetAccount} 的插件启用已保存${result.reload ? '并热加载' : ''}。`);
      setInstallBaseline([...installIds]);
      await refreshPolicyView();
      setEffectiveKey((value) => value + 1);
    } catch (installError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(installError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
      await refresh();
    }
  };

  const reloadPlugins = async (): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    if (!targetAccount || busy || locked) return;
    setBusy('reload');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<ExtensionReloadResponse>(`/accounts/${encodeURIComponent(targetAccount)}/extensions/reload`, { method: 'POST' });
      if (!isCurrentAccount(targetAccount, generation)) return;
      const statuses = response.reload.plugins;
      const readyToolIds = new Set(statuses.filter((plugin) => plugin.ready).flatMap((plugin) => plugin.tools));
      setPolicy((current) => current ? {
        ...current,
        catalog: {
          ...current.catalog,
          tools: current.catalog.tools.map((tool) => tool.pluginKey
            ? { ...tool, handlerReady: readyToolIds.has(tool.id) }
            : tool)
        },
        runtime: {
          synced: true,
          readyPlugins: statuses.filter((plugin) => plugin.ready).map((plugin) => plugin.pluginKey).sort(),
          readyTools: [...readyToolIds].sort(),
          plugins: statuses
        }
      } : current);
      const failed = statuses.filter((plugin) => !plugin.ready);
      setNotice(failed.length
        ? `已重载 ${statuses.length} 个插件，其中 ${failed.length} 个启动失败：${failed.map((plugin) => `${plugin.pluginKey}（${plugin.reason ?? '未知原因'}）`).join('；')}`
        : statuses.length
          ? `已重载 ${statuses.length} 个插件，全部就绪。`
          : `账号 ${targetAccount} 当前没有已安装插件。`);
      setEffectiveKey((value) => value + 1);
    } catch (reloadError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(reloadError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const setAuthorized = (toolId: string, authorized: boolean): void => {
    if (!draft) return;
    setDraft({
      ...draft,
      authorizedTools: authorized
        ? [...new Set([...draft.authorizedTools, toolId])]
        : draft.authorizedTools.filter((id) => id !== toolId)
    });
    setNotice(undefined);
  };

  const setSwitch = (section: ExtensionSwitchSection, key: string, value: ExtensionSwitchValue): void => {
    if (!draft || !scope) return;
    setDraft(setScopeSwitch(draft, scope, section, key, value));
    setNotice(undefined);
  };

  const copySkill = async (): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    if (!targetAccount || !privateSkills || !copyFrom || busy) return;
    const replaces = privateSkills.skills.some((skill) => skill.id === copyFrom);
    if (replaces && !(await confirm({
      title: '覆盖账号私有 Skill',
      description: `账号 ${targetAccount} 已有私有 Skill ${copyFrom}，复制会覆盖它的说明和工具引用。继续？`,
      confirmLabel: '覆盖并复制',
      tone: 'danger'
    }))) return;
    setBusy('copy-skill');
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<{ skills: PrivateSkillList; copied: boolean; replaced: boolean }>(
        `/accounts/${encodeURIComponent(targetAccount)}/skills/private`,
        { method: 'POST', body: JSON.stringify({ copyFrom, expectedRevision: privateSkills.revision }) }
      );
      if (!isCurrentAccount(targetAccount, generation)) return;
      setPrivateSkills(response.skills);
      setNotice(`已将公用 Skill ${copyFrom} 复制为账号私有${response.replaced ? '（覆盖原定义）' : ''}。`);
      await refreshPolicyView();
      setEffectiveKey((value) => value + 1);
    } catch (copyError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(copyError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const deleteSkill = async (skill: SkillDefinitionView): Promise<void> => {
    const targetAccount = selectedAccount;
    const generation = accountGeneration.current;
    if (!targetAccount || !privateSkills || busy) return;
    if (!(await confirm({
      title: '删除私有 Skill',
      description: `删除账号 ${targetAccount} 的私有 Skill ${skill.id}？引用它的会话将不再注入该说明。`,
      confirmLabel: '删除 Skill',
      tone: 'danger'
    }))) return;
    setBusy(`delete-skill:${skill.id}`);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<{ skills: PrivateSkillList }>(
        `/accounts/${encodeURIComponent(targetAccount)}/skills/private/${encodeURIComponent(skill.id)}`,
        { method: 'DELETE', body: JSON.stringify({ expectedRevision: privateSkills.revision }) }
      );
      if (!isCurrentAccount(targetAccount, generation)) return;
      setPrivateSkills(response.skills);
      if (editingSkill?.skill?.id === skill.id) setEditingSkill(undefined);
      setNotice(`已删除私有 Skill ${skill.id}。`);
      await refreshPolicyView();
      setEffectiveKey((value) => value + 1);
    } catch (deleteError) {
      if (isCurrentAccount(targetAccount, generation)) setError(errorMessage(deleteError));
    } finally {
      if (isCurrentAccount(targetAccount, generation)) setBusy(undefined);
    }
  };

  const skillSaved = (skills: PrivateSkillList): void => {
    setPrivateSkills(skills);
    setEditingSkill(undefined);
    setNotice(`账号 ${selectedAccount} 的私有 Skill 已保存。`);
    void refreshPolicyView();
    setEffectiveKey((value) => value + 1);
  };

  const activeSkillDraft = Boolean(editingSkill);
  const totalSkills = policy?.catalog.skills.length ?? 0;

  return (
    <div className="page-stack">
      <div className="banner">
        <Icon name="package" size={18} />
        <div>
          <strong>插件、工具授权和 Skill 共用一套账号级策略。</strong>
          <span>作用域按账号默认 → 私聊/群聊 → 指定会话覆盖；继承不会绕过账号授权、插件安装或模型能力。</span>
        </div>
      </div>
      {accountsError && list.length > 0 ? <ErrorNote message={`账号资料刷新失败：${accountsError}，当前显示上次读取的数据。`} onRetry={() => void refresh()} /> : null}
      {artifactsError && tab === 'plugins' ? <ErrorNote message={artifacts ? `资源库刷新失败：${artifactsError}，当前显示上次读取的数据。` : `无法读取资源库：${artifactsError}`} onRetry={() => void onRetryArtifacts()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      {list.length === 0 ? (
        accountsLoading ? <Card><LoadingNote label="正在读取账号…" /></Card>
          : accountsError ? <Card><Empty icon="accounts" title="无法读取账号" description={accountsError} action={<Button icon="refresh" onClick={() => void refresh()}>重试</Button>} /></Card>
            : <Card><Empty icon="accounts" title="还没有可配置的 QQ 账号" description="在“实例与监听”中注入并开始监听后，账号会出现在这里。" action={<Button variant="primary" icon="slots" onClick={onGoSlots}>去实例与监听</Button>} /></Card>
      ) : (
        <>
          <div className="policy-toolbar account-context-toolbar">
            <Field label="当前 QQ 账号">
              <Select value={selectedAccount} disabled={Boolean(busy)} onChange={(event) => void selectAccountWithGuard(event.target.value)}>
                {selected ? null : <option value="">请选择账号…</option>}
                {list.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.nickname ? `${account.nickname}（${account.accountId}）` : account.accountId}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="目标会话">
              <div className="conversation-scope">
                <Select value={scopeKind} disabled={Boolean(busy)} aria-label="目标会话类型" onChange={(event) => setScopeKind(event.target.value as ExtensionChatKind)}>
                  <option value="private">私聊</option>
                  <option value="group">群聊</option>
                </Select>
                <Input
                  value={peerId}
                  disabled={Boolean(busy)}
                  aria-label="目标会话 QQ 或群号"
                  placeholder={scopeKind === 'private' ? '对方 QQ' : '群号'}
                  onChange={(event) => setPeerId(event.target.value.replace(/[^0-9A-Za-z_-]/g, ''))}
                />
              </div>
            </Field>
            <span className="muted">插件、授权与 Skill 均按该账号隔离；填写目标会话后可查看实际有效状态。</span>
            <Button size="sm" variant="ghost" icon="refresh" busy={busy === 'runtime'} disabled={!selectedAccount || Boolean(busy) || locked} onClick={() => void refreshRuntime()}>刷新状态</Button>
          </div>

          {loadError ? <ErrorNote message={policy ? `无法重新读取扩展策略：${loadError}，当前显示上次读取的数据。` : `无法读取扩展策略：${loadError}`} onRetry={() => void reloadPolicy()} /> : null}
          {loading && !policy ? <Card><LoadingNote label="正在读取账号扩展策略…" /></Card> : null}
          {selectedAccount && !policy && !loading && !loadError ? <Card><LoadingNote label="正在读取账号扩展策略…" /></Card> : null}

          {selected && policy && draft && baseline ? (
            <>
              <Card
                title="扩展策略"
                subtitle={selected.nickname ? `${selected.nickname} · QQ ${selected.accountId}` : `QQ ${selected.accountId}`}
                actions={
                  <div className="row-actions">
                    <Button size="sm" icon="refresh" disabled={Boolean(busy)} onClick={() => void reloadPolicy()}>重新读取</Button>
                    <ConfirmButton size="sm" variant="primary" busy={busy === 'save'} disabled={!policyDirty || Boolean(busy) || locked} onClick={() => void savePolicy()}>保存扩展策略</ConfirmButton>
                    <CancelButton size="sm" variant="ghost" disabled={!policyDirty || Boolean(busy)} onClick={() => void discardPolicy()}>撤销修改</CancelButton>
                  </div>
                }
              >
                {conflict ? <div className="notice notice-warn">配置已在其他窗口变化。请重新读取后再保存；当前草稿仍保留。</div> : null}
                <div className="policy-toolbar extension-scope-toolbar">
                  <Field label="配置作用域">
                    <Select value={scopeLevel} disabled={Boolean(busy)} onChange={(event) => setScopeLevel(event.target.value as ExtensionScopeLevel)}>
                      <option value="defaults">账号默认</option>
                      <option value="kind">会话类型默认</option>
                      <option value="conversation">指定会话</option>
                    </Select>
                  </Field>
                  {scopeLevel !== 'defaults' ? (
                    <Field label="会话类型">
                      <Select value={scopeKind} disabled={Boolean(busy)} onChange={(event) => setScopeKind(event.target.value as ExtensionChatKind)}>
                        <option value="private">私聊</option>
                        <option value="group">群聊</option>
                      </Select>
                    </Field>
                  ) : null}
                  {scopeLevel === 'conversation' ? (
                    <Field label={scopeKind === 'private' ? '对方 QQ' : '群号'}>
                      <Input value={peerId} disabled={Boolean(busy)} placeholder={scopeKind === 'private' ? '输入 QQ 号' : '输入群号'} onChange={(event) => setPeerId(event.target.value.replace(/[^0-9A-Za-z_-]/g, ''))} />
                    </Field>
                  ) : null}
                  <span className="muted extension-scope-hint">
                    {scopeLevel === 'defaults'
                      ? '未覆盖的项使用内置默认。'
                      : scopeLevel === 'kind'
                        ? '继承值来自账号默认。'
                        : targetPeer ? '继承值来自会话类型与账号默认。' : '填写 QQ 号或群号后编辑该会话。'}
                  </span>
                </div>

                <div className="scope-tabs" role="tablist" aria-label="扩展管理标签">
                  {(Object.keys(TAB_LABELS) as ExtensionTab[]).map((id) => (
                    <ControlButton
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      className={`scope-tab${tab === id ? ' active' : ''}`}
                      disabled={Boolean(busy)}
                      onClick={() => void changeTab(id)}
                    >
                      {TAB_LABELS[id]}
                    </ControlButton>
                  ))}
                </div>

                {!scope ? <div className="notice">指定会话需要填写 QQ 号或群号。</div> : null}

                {scope && tab === 'plugins' ? (
                  <div className="extension-section">
                    <h4>插件运行开关</h4>
                    <p className="muted">插件默认关闭；切换只影响该作用域，未安装或启动失败时不会执行。</p>
                    {policy.catalog.plugins.length === 0 ? <p className="muted">该账号还没有安装插件。</p> : (
                      <div className="extension-rows">
                        {policy.catalog.plugins.map((plugin) => {
                          const status = policy.runtime.plugins.find((item) => item.pluginKey === plugin.key);
                          const liveReady = policy.runtime.readyPlugins.includes(plugin.key);
                          const stopped = policy.runtime.synced && status?.ready === true && !liveReady;
                          const tag = liveReady ? '已就绪' : policy.runtime.synced ? (stopped ? '已停止' : '未就绪') : '未加载';
                          const value = rawSwitchValue(draft, scope, 'plugins', plugin.key);
                          const inherited = resolveBelowScope(draft, scope, 'plugins', plugin.key, 'off');
                          return (
                            <div className="extension-row" key={plugin.key}>
                              <div className="extension-row-main">
                                <div className="extension-row-title">
                                  <strong>{plugin.name ?? plugin.id}</strong>
                                  <Tag tone={plugin.source === 'public' ? 'ok' : 'idle'}>{plugin.source === 'public' ? '公用' : '私有'}</Tag>
                                  <Tag tone={liveReady ? 'ok' : policy.runtime.synced ? 'bad' : 'idle'}>{tag}</Tag>
                                </div>
                                <span className="muted mono">{plugin.key} @{plugin.revision}</span>
                                <span className="muted">工具 {plugin.tools.length} · 钩子 {plugin.hooks.length} · Skill {plugin.skills.length}</span>
                                {stopped ? <span className="inline-error">上次启动成功后 Worker 已停止；重载插件后恢复。</span> : null}
                                {!stopped && status?.reason ? <span className="inline-error">启动失败：{status.reason}</span> : null}
                              </div>
                              <div className="extension-row-state">
                                <SwitchControl value={value} inherited={`${inherited.value === 'on' ? '开启' : '关闭'} · ${switchOriginLabel(inherited.source)}`} disabled={Boolean(busy) || locked} onChange={(next) => setSwitch('plugins', plugin.key, next)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {policy.catalog.plugins.some((plugin) => plugin.accountSharedState) ? (
                      <>
                        <h4>账号共享状态</h4>
                        <p className="muted">仅对声明了账号共享状态的插件有效；关闭后不会读写共享状态。</p>
                        <div className="extension-rows">
                          {policy.catalog.plugins.filter((plugin) => plugin.accountSharedState).map((plugin) => {
                            const value = rawSwitchValue(draft, scope, 'state', plugin.key);
                            const inherited = resolveBelowScope(draft, scope, 'state', plugin.key, 'off');
                            return (
                              <div className="extension-row" key={plugin.key}>
                                <div className="extension-row-main">
                                  <div className="extension-row-title"><strong>{plugin.name ?? plugin.id}</strong><Tag tone="idle">共享状态</Tag></div>
                                  <span className="muted mono">{plugin.key}</span>
                                </div>
                                <div className="extension-row-state">
                                  <SwitchControl value={value} inherited={`${inherited.value === 'on' ? '开启' : '关闭'} · ${switchOriginLabel(inherited.source)}`} disabled={Boolean(busy) || locked} onChange={(next) => setSwitch('state', plugin.key, next)} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : null}

                    <div className="extension-inline-actions">
                      <Button size="sm" icon="refresh" busy={busy === 'reload'} disabled={Boolean(busy) || locked} onClick={() => void reloadPlugins()}>重载插件</Button>
                      <span className="muted">重载只重新建立插件 Worker，不重放工具调用。</span>
                    </div>
                  </div>
                ) : null}

                {scope && tab === 'tools' ? (
                  <div className="extension-section">
                    <h4>工具授权与运行开关</h4>
                    <p className="muted">账号授权是硬边界；会话开关只能在已授权的工具中收窄，不会自动开启任何工具。</p>
                    {policy.catalog.tools.length === 0 ? <p className="muted">当前没有可用工具。</p> : (
                      <div className="extension-rows">
                        {policy.catalog.tools.map((tool) => {
                          const authorized = draft.authorizedTools.includes(tool.id);
                          const value = rawSwitchValue(draft, scope, 'tools', tool.id);
                          const inherited = resolveBelowScope(draft, scope, 'tools', tool.id, defaultSwitchValue('tools', policy.catalog, tool.id));
                          const effectiveStatus = effective?.tools.find((item) => item.tool.id === tool.id);
                          return (
                            <div className="extension-row" key={tool.id}>
                              <div className="extension-row-main">
                                <div className="extension-row-title">
                                  <strong>{tool.label ?? tool.name}</strong>
                                  <Tag tone={tool.owner.kind === 'builtin' ? 'ok' : 'idle'}>{tool.owner.kind === 'builtin' ? '内置' : '插件'}</Tag>
                                  <Tag tone={tool.effect === 'action' ? 'warn' : 'idle'}>{tool.effect === 'action' ? '有副作用' : '只读'}</Tag>
                                  {!tool.handlerReady ? <Tag tone="bad">未就绪</Tag> : null}
                                  {tool.capability ? <Tag tone="idle">{tool.capability}</Tag> : null}
                                </div>
                                <span className="muted mono">{tool.id}</span>
                                <span className="muted">{tool.description}</span>
                                {effectiveStatus && targetPeer ? (
                                  <span className="extension-effective-line">
                                    <Tag tone={effectiveStatus.enabled ? 'ok' : 'idle'}>{effectiveStatus.enabled ? '目标会话有效' : '目标会话不生效'}</Tag>
                                    <span className="muted">来源：{switchOriginLabel(effectiveStatus.switchSource)}</span>
                                    {effectiveStatus.issues.length ? <span className="inline-error">{effectiveStatus.issues.map((issue) => extensionIssueLabel(issue.code, issue.detail)).join('；')}</span> : null}
                                  </span>
                                ) : null}
                              </div>
                              <div className="extension-row-state">
                                <label className="check-row extension-auth">
                                  <Checkbox checked={authorized} disabled={Boolean(busy) || locked} onChange={(event) => setAuthorized(tool.id, event.target.checked)} />
                                  <span><strong>账号授权</strong></span>
                                </label>
                                <SwitchControl value={value} inherited={`${inherited.value === 'on' ? '开启' : '关闭'} · ${switchOriginLabel(inherited.source)}`} disabled={Boolean(busy) || locked} onChange={(next) => setSwitch('tools', tool.id, next)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}

                {scope && tab === 'skills' ? (
                  <div className="extension-section">
                    <h4>Skill 运行开关</h4>
                    <p className="muted">Skill 只提供说明和工具引用，不执行代码，也不会自动开启工具。共用同一提示词预算。</p>
                    {policy.catalog.skills.length === 0 ? <p className="muted">当前没有可用 Skill。</p> : (
                      <div className="extension-rows">
                        {policy.catalog.skills.map((skill) => {
                          const value = rawSwitchValue(draft, scope, 'skills', skill.id);
                          const inherited = resolveBelowScope(draft, scope, 'skills', skill.id, defaultSwitchValue('skills', policy.catalog, skill.id));
                          const previewEntry = preview?.skills.find((entry) => entry.id === skill.id);
                          return (
                            <div className="extension-row" key={skill.id}>
                              <div className="extension-row-main">
                                <div className="extension-row-title">
                                  <strong>{skill.name}</strong>
                                  <Tag tone={skill.pluginKey ? 'idle' : skill.source === 'private' ? 'warn' : 'ok'}>{skillSourceLabel(skill)}</Tag>
                                  {skill.overrides === 'public' ? <Tag tone="warn">覆盖公用</Tag> : null}
                                  {previewEntry ? <Tag tone={previewEntry.selected ? 'ok' : 'idle'}>{previewEntry.selected ? '已注入' : '未注入'}</Tag> : null}
                                </div>
                                <span className="muted mono">{skill.id}</span>
                                <span className="muted">工具 {skill.tools.length} · 说明 {skill.instructions.length} 字符{skill.requires?.length ? ` · 需要 ${skill.requires.join('、')}` : ''}</span>
                                {previewEntry?.selectionReason ? <span className="inline-error">未注入原因：{skillSelectionReasonLabel(previewEntry.selectionReason)}</span> : null}
                              </div>
                              <div className="extension-row-state">
                                <SwitchControl value={value} inherited={`${inherited.value === 'on' ? '开启' : '关闭'} · ${switchOriginLabel(inherited.source)}`} disabled={Boolean(busy) || locked} onChange={(next) => setSwitch('skills', skill.id, next)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="extension-skills-manage">
                      <div className="extension-row-title">
                        <h4>账号私有 Skill</h4>
                        <span className="muted">共 {totalSkills} 个定义（含公用、私有和插件）</span>
                      </div>
                      {skillsError ? <ErrorNote message={`无法读取私有 Skill：${skillsError}`} onRetry={() => void reloadPolicy()} /> : null}
                      {!privateSkills ? <LoadingNote label="正在读取私有 Skill…" /> : (
                        <>
                          {privateSkills.skills.length === 0 ? <p className="muted">该账号还没有私有 Skill。可以从公用定义复制，或直接新建。</p> : (
                            <div className="extension-rows">
                              {privateSkills.skills.map((skill) => (
                                <div className="extension-row" key={skill.id}>
                                  <div className="extension-row-main">
                                    <div className="extension-row-title">
                                      <strong>{skill.name}</strong>
                                      <Tag tone="warn">私有</Tag>
                                      {skill.overrides === 'public' ? <Tag tone="warn">覆盖公用</Tag> : null}
                                    </div>
                                    <span className="muted mono">{skill.id}</span>
                                    <span className="muted">工具 {skill.tools.length} · 说明 {skill.instructions.length} 字符{skill.enabled === false ? ' · 默认关闭' : ''}</span>
                                  </div>
                                  <div className="extension-row-state">
                                    <Button size="sm" icon="settings" disabled={Boolean(busy) || locked || activeSkillDraft} onClick={() => setEditingSkill({ skill, revision: privateSkills.revision })}>编辑</Button>
                                    <Button size="sm" variant="ghost" busy={busy === `delete-skill:${skill.id}`} disabled={Boolean(busy) || locked || activeSkillDraft} onClick={() => void deleteSkill(skill)}>删除</Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="extension-inline-actions">
                            <Button size="sm" icon="plus" disabled={Boolean(busy) || locked || activeSkillDraft} onClick={() => setEditingSkill({ revision: privateSkills.revision })}>新建私有 Skill</Button>
                            <Select value={copyFrom} disabled={Boolean(busy) || locked || activeSkillDraft || !publicSkills?.skills.length} aria-label="选择公用 Skill" onChange={(event) => setCopyFrom(event.target.value)}>
                              <option value="">从公用 Skill 复制…</option>
                              {(publicSkills?.skills ?? []).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}（{skill.id}）</option>)}
                            </Select>
                            <Button size="sm" icon="copy" busy={busy === 'copy-skill'} disabled={Boolean(busy) || locked || activeSkillDraft || !copyFrom} onClick={() => void copySkill()}>复制到账号</Button>
                          </div>
                          {editingSkill && privateSkills ? (
                            <SkillDefinitionEditor
                              key={`${selectedAccount}:${editingSkill.skill?.id ?? 'new'}`}
                              scope="private"
                              accountId={selectedAccount}
                              revision={editingSkill.revision}
                              {...(editingSkill.skill ? { initial: editingSkill.skill } : {})}
                              locked={locked}
                              onSaved={(saved) => skillSaved({ revision: saved.revision, accountId: selectedAccount, skills: saved.skills, limits: privateSkills.limits })}
                              onCancel={() => setEditingSkill(undefined)}
                            />
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
              </Card>

              {tab === 'plugins' ? (
                <Card
                  title="插件启用"
                  subtitle="只修改当前账号 profile 中的公用插件选择；私有插件原样保留"
                  actions={<ConfirmButton variant="primary" busy={busy === 'install'} disabled={!installDirty || Boolean(busy) || locked} onClick={() => void saveInstall()}>保存插件启用</ConfirmButton>}
                >
                  {artifacts === undefined ? (
                    artifactsError ? <ErrorNote message="资源库读取失败，暂不能保存插件启用。" onRetry={() => void onRetryArtifacts()} />
                      : <LoadingNote label="正在读取公用插件…" />
                  ) : publicPlugins.length === 0 ? <p className="muted">资源库中还没有公用插件。</p> : (
                    <div className="plugin-picker">
                      {publicPlugins.map((plugin) => (
                        <label className="check-row" key={plugin.ref.id}>
                          <Checkbox
                            checked={installIds.includes(plugin.ref.id)}
                            disabled={Boolean(busy) || locked}
                            onChange={(event) => setInstallIds((current) => event.target.checked
                              ? [...current, plugin.ref.id]
                              : current.filter((id) => id !== plugin.ref.id))}
                          />
                          <span>
                            <strong>{plugin.manifest.name ?? plugin.ref.id}</strong>
                            <span className="muted mono"> @{plugin.ref.revision}</span>
                            {plugin.manifest.description ? <span className="check-desc">{plugin.manifest.description}</span> : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {(selected?.file?.plugins ?? []).some((plugin) => plugin.source !== 'public') ? (
                    <p className="field-hint">私有插件由账号目录维护，保存时原样保留：{(selected?.file?.plugins ?? []).filter((plugin) => plugin.source !== 'public').map((plugin) => plugin.id).join('、')}</p>
                  ) : null}
                  {artifactsLoading ? <span className="muted">正在刷新资源库…</span> : null}
                </Card>
              ) : null}

              {targetPeer ? (
                <Card title="目标会话有效状态" subtitle={`${targetKind === 'private' ? '私聊' : '群聊'} ${targetPeer}`}>
                  {effectiveLoading ? <LoadingNote label="正在解析有效状态…" /> : null}
                  {effectiveError ? <ErrorNote message={`无法读取有效状态：${effectiveError}`} onRetry={() => setEffectiveKey((value) => value + 1)} /> : null}
                  {effective ? (
                    <>
                      <div className="extension-effective-summary">
                        <Tag tone="ok">工具 {effective.tools.filter((tool) => tool.enabled).length}/{effective.tools.length}</Tag>
                        <Tag tone="ok">钩子 {effective.hooks.filter((hook) => hook.enabled).length}/{effective.hooks.length}</Tag>
                        <Tag tone="ok">Skill {effective.skills.filter((skill) => skill.enabled).length}/{effective.skills.length}</Tag>
                        <Tag tone={effective.states.some((state) => state.enabled) ? 'ok' : 'idle'}>共享状态 {effective.states.filter((state) => state.enabled).length}/{effective.states.length}</Tag>
                      </div>
                      {preview ? (
                        <div className="extension-preview">
                          <p className="muted">
                            提示词选择：已注入 {preview.included.length} 个 Skill · 说明 {preview.instructionsChars} 字符
                            {preview.runtimeMayTrim ? ' · 实际请求仍可能按总上下文预算裁剪' : ''}
                          </p>
                          {preview.excluded.length ? (
                            <p className="notice notice-warn">未注入：{preview.excluded.map((entry) => `${entry.id}（${skillSelectionReasonLabel(entry.reason)}）`).join('、')}</p>
                          ) : null}
                        </div>
                      ) : null}
                      <p className="field-hint">该视图只解析当前会话，不调用模型、不执行工具，也不修改配置。</p>
                    </>
                  ) : null}
                </Card>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
