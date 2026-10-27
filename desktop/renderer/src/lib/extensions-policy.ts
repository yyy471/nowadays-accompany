import type {
  ExtensionChatKind,
  ExtensionPolicyDto,
  ExtensionPolicyPatchDto,
  ExtensionRunPolicy,
  ExtensionSwitchValue
} from '../../../../src/contracts/extensions.js';

export type ExtensionScopeLevel = 'defaults' | 'kind' | 'conversation';

export type ExtensionScope =
  | { level: 'defaults' }
  | { level: 'kind'; kind: ExtensionChatKind }
  | { level: 'conversation'; kind: ExtensionChatKind; peerId: string };

export interface ExtensionPolicyDraft {
  authorizedTools: string[];
  defaults: ExtensionRunPolicy;
  byKind: Partial<Record<ExtensionChatKind, ExtensionRunPolicy>>;
  byConversation: Record<string, ExtensionRunPolicy>;
}

export type ExtensionSwitchSection = 'plugins' | 'tools' | 'skills' | 'state';
export type ExtensionSwitchSourceView = 'account' | 'kind' | 'conversation' | 'default';

const SECTIONS: ExtensionSwitchSection[] = ['plugins', 'tools', 'skills', 'state'];

export function conversationKey(kind: ExtensionChatKind, peerId: string): string {
  return `${kind}/${peerId.trim()}`;
}

export function draftFromPolicy(policy: ExtensionPolicyDto): ExtensionPolicyDraft {
  return {
    authorizedTools: [...policy.authorizedTools],
    defaults: cloneRunPolicy(policy.defaults),
    byKind: Object.fromEntries(Object.entries(policy.byKind).map(([kind, value]) => [kind, cloneRunPolicy(value)])),
    byConversation: Object.fromEntries(Object.entries(policy.byConversation).map(([key, value]) => [key, cloneRunPolicy(value)]))
  };
}

export function cloneRunPolicy(policy: ExtensionRunPolicy | undefined): ExtensionRunPolicy {
  if (!policy) return {};
  return {
    ...(policy.plugins ? { plugins: { ...policy.plugins } } : {}),
    ...(policy.tools ? { tools: { ...policy.tools } } : {}),
    ...(policy.skills ? { skills: { ...policy.skills } } : {}),
    ...(policy.state ? { state: { ...policy.state } } : {})
  };
}

export function draftSignature(draft: ExtensionPolicyDraft): string {
  return JSON.stringify({
    authorizedTools: [...new Set(draft.authorizedTools)].sort(),
    defaults: draft.defaults,
    byKind: draft.byKind,
    byConversation: draft.byConversation
  });
}

export function policyDraftDirty(draft: ExtensionPolicyDraft | undefined, baseline: ExtensionPolicyDraft | undefined): boolean {
  return Boolean(draft && baseline && draftSignature(draft) !== draftSignature(baseline));
}

export function scopePolicy(draft: ExtensionPolicyDraft, scope: ExtensionScope): ExtensionRunPolicy {
  if (scope.level === 'defaults') return draft.defaults;
  if (scope.level === 'kind') return draft.byKind[scope.kind] ?? {};
  return draft.byConversation[conversationKey(scope.kind, scope.peerId)] ?? {};
}

export function rawSwitchValue(draft: ExtensionPolicyDraft, scope: ExtensionScope, section: ExtensionSwitchSection, key: string): ExtensionSwitchValue {
  return scopePolicy(draft, scope)[section]?.[key] ?? 'inherit';
}

export function setScopeSwitch(
  draft: ExtensionPolicyDraft,
  scope: ExtensionScope,
  section: ExtensionSwitchSection,
  key: string,
  value: ExtensionSwitchValue
): ExtensionPolicyDraft {
  return editScope(draft, scope, (current) => {
    const next = cloneRunPolicy(current);
    const sectionValues = { ...(next[section] ?? {}) };
    if (value === 'inherit') delete sectionValues[key];
    else sectionValues[key] = value;
    if (Object.keys(sectionValues).length > 0) next[section] = sectionValues;
    else delete next[section];
    return next;
  });
}

function editScope(
  draft: ExtensionPolicyDraft,
  scope: ExtensionScope,
  edit: (current: ExtensionRunPolicy) => ExtensionRunPolicy
): ExtensionPolicyDraft {
  if (scope.level === 'defaults') return { ...draft, defaults: edit(draft.defaults) };
  if (scope.level === 'kind') {
    const byKind = { ...draft.byKind };
    const next = edit(byKind[scope.kind] ?? {});
    if (runPolicyEmpty(next)) delete byKind[scope.kind];
    else byKind[scope.kind] = next;
    return { ...draft, byKind };
  }
  const key = conversationKey(scope.kind, scope.peerId);
  const byConversation = { ...draft.byConversation };
  const next = edit(byConversation[key] ?? {});
  if (runPolicyEmpty(next)) delete byConversation[key];
  else byConversation[key] = next;
  return { ...draft, byConversation };
}

export function runPolicyEmpty(policy: ExtensionRunPolicy): boolean {
  return SECTIONS.every((section) => !policy[section] || Object.keys(policy[section]!).length === 0);
}

/**
 * Resolves the draft for one conversation with account → kind → conversation precedence. It is
 * only a display helper for inherited values; the backend resolver remains authoritative.
 */
export function resolveDraftSwitch(
  draft: ExtensionPolicyDraft,
  conversation: { kind: ExtensionChatKind; peerId: string } | undefined,
  section: ExtensionSwitchSection,
  key: string,
  fallback: 'on' | 'off'
): { value: 'on' | 'off'; source: ExtensionSwitchSourceView } {
  let value: 'on' | 'off' = fallback;
  let source: ExtensionSwitchSourceView = 'default';
  const account = draft.defaults[section]?.[key];
  if (account === 'on' || account === 'off') {
    value = account;
    source = 'account';
  }
  if (!conversation) return { value, source };
  const kind = draft.byKind[conversation.kind]?.[section]?.[key];
  if (kind === 'on' || kind === 'off') {
    value = kind;
    source = 'kind';
  }
  const peer = draft.byConversation[conversationKey(conversation.kind, conversation.peerId)]?.[section]?.[key];
  if (peer === 'on' || peer === 'off') {
    value = peer;
    source = 'conversation';
  }
  return { value, source };
}

/**
 * Resolves only the levels below the selected scope, so the editor can label what `inherit`
 * would currently mean without hiding an explicit value at the selected level.
 */
export function resolveBelowScope(
  draft: ExtensionPolicyDraft,
  scope: ExtensionScope,
  section: ExtensionSwitchSection,
  key: string,
  fallback: 'on' | 'off'
): { value: 'on' | 'off'; source: ExtensionSwitchSourceView } {
  let value: 'on' | 'off' = fallback;
  let source: ExtensionSwitchSourceView = 'default';
  const account = draft.defaults[section]?.[key];
  if (account === 'on' || account === 'off') {
    value = account;
    source = 'account';
  }
  if (scope.level === 'defaults') return { value, source };
  if (scope.level === 'kind') return { value, source };
  const kind = draft.byKind[scope.kind]?.[section]?.[key];
  if (kind === 'on' || kind === 'off') {
    value = kind;
    source = 'kind';
  }
  return { value, source };
}

export interface ExtensionCatalogKeys {
  plugins: string[];
  tools: string[];
  skills: string[];
  state: string[];
}

export function catalogKeys(catalog: ExtensionPolicyDto['catalog']): ExtensionCatalogKeys {
  return {
    plugins: catalog.plugins.map((plugin) => plugin.key),
    tools: catalog.tools.map((tool) => tool.id),
    skills: catalog.skills.map((skill) => skill.id),
    state: catalog.plugins.filter((plugin) => plugin.accountSharedState).map((plugin) => plugin.key)
  };
}

export function defaultSwitchValue(
  section: ExtensionSwitchSection,
  catalog: ExtensionPolicyDto['catalog'],
  key: string
): 'on' | 'off' {
  if (section === 'tools') {
    return catalog.tools.find((tool) => tool.id === key)?.owner.kind === 'builtin' ? 'on' : 'off';
  }
  if (section === 'skills') {
    return catalog.skills.find((skill) => skill.id === key)?.defaultEnabled === false ? 'off' : 'on';
  }
  return 'off';
}

/**
 * Builds a patch that reproduces the draft exactly: every key known to the catalog or already
 * stored is written as its draft value or `inherit`, which also removes stale overrides.
 */
export function buildPolicyPatch(
  draft: ExtensionPolicyDraft,
  current: ExtensionPolicyDto,
  keys: ExtensionCatalogKeys
): ExtensionPolicyPatchDto {
  const byKind: NonNullable<ExtensionPolicyPatchDto['byKind']> = {};
  for (const kind of new Set<ExtensionChatKind>([...Object.keys(current.byKind) as ExtensionChatKind[], ...Object.keys(draft.byKind) as ExtensionChatKind[]])) {
    byKind[kind] = exactScope(draft.byKind[kind] ?? {}, keys);
  }
  const byConversation: Record<string, ExtensionRunPolicy> = {};
  for (const key of new Set([...Object.keys(current.byConversation), ...Object.keys(draft.byConversation)])) {
    byConversation[key] = exactScope(draft.byConversation[key] ?? {}, keys);
  }
  return {
    authorizedTools: [...new Set(draft.authorizedTools)].sort(),
    defaults: exactScope(draft.defaults, keys),
    byKind,
    byConversation
  };
}

function exactScope(policy: ExtensionRunPolicy, keys: ExtensionCatalogKeys): ExtensionRunPolicy {
  const result: ExtensionRunPolicy = {};
  for (const section of SECTIONS) {
    const all = new Set([...keys[section], ...Object.keys(policy[section] ?? {})]);
    if (all.size === 0) continue;
    const values: Record<string, ExtensionSwitchValue> = {};
    for (const key of all) values[key] = policy[section]?.[key] ?? 'inherit';
    result[section] = values;
  }
  return result;
}

export function switchOriginLabel(source: ExtensionSwitchSourceView): string {
  switch (source) {
    case 'account': return '账号默认';
    case 'kind': return '会话类型';
    case 'conversation': return '指定会话';
    default: return '默认值';
  }
}
