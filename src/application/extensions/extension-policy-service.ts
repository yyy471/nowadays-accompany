import { createHash } from 'node:crypto';
import type { ResolvedProfile } from '../../artifacts/types.js';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';
import { buildExtensionCatalog, type ExtensionCatalog } from '../../extensions/catalog.js';
import { isToolId, type PluginSource } from '../../extensions/contracts.js';
import { resolveEffectiveExtensions, type EffectiveExtensions } from '../../extensions/effective.js';
import type { ExtensionRegistry } from '../../extensions/registry.js';
import type { CapabilityId } from '../../policy/capabilities.js';
import type { ConfigStore } from '../../providers/config-store.js';
import type {
  AccountExtensionPolicy,
  AccountPolicy,
  ExtensionRunPolicy,
  ExtensionSwitch
} from '../../providers/types.js';
import { defaultAccountPolicy, stableStringify } from '../../providers/types.js';
import type { ChatKind, ConversationRef } from '../../routing/identity.js';

export interface ExtensionRunPolicyPatch {
  plugins?: Record<string, ExtensionSwitch>;
  tools?: Record<string, ExtensionSwitch>;
  skills?: Record<string, ExtensionSwitch>;
  state?: Record<string, ExtensionSwitch>;
}

/** Patch merges only the provided keys; `inherit` removes an override. */
export interface ExtensionPolicyPatch {
  defaults?: ExtensionRunPolicyPatch;
  byKind?: Partial<Record<ChatKind, ExtensionRunPolicyPatch>>;
  byConversation?: Record<string, ExtensionRunPolicyPatch>;
  /** Replaces the hard tool authorization list when provided. */
  authorizedTools?: string[];
}

export interface UpdateExtensionPolicyInput {
  expectedRevision: string;
  expectedProfileRevision?: string;
  patch: ExtensionPolicyPatch;
}

export interface ExtensionPolicyView {
  accountId: string;
  /** Computed from the extension subtree, hard tool authorization and installed plugin refs. */
  revision: string;
  profileRevision: string;
  /** Store version that must still match when the patch is committed. */
  configVersion: number;
  authorizedTools: string[];
  defaults: ExtensionRunPolicy;
  byKind: Partial<Record<ChatKind, ExtensionRunPolicy>>;
  byConversation: Record<string, ExtensionRunPolicy>;
  catalog: ExtensionCatalog;
}

export interface ExtensionPolicyServiceOptions {
  config: ConfigStore;
  registry: ExtensionRegistry;
  profiles: (accountId: string) => Promise<ResolvedProfile>;
  /** Account-scoped handshake results; a 0-arg provider is a process-wide constant. */
  readyPlugins?: (accountId: string) => ReadonlySet<string>;
  readyTools?: (accountId: string) => ReadonlySet<string>;
}

/**
 * Single read/write entry for extension policy. It validates run-switch keys and hard tool grants
 * against the current catalog, and commits with a config-version CAS. Cross-file profile freshness
 * is a logical check only; the profile file and config are not claimed to be physically atomic.
 */
export class ExtensionPolicyService {
  readonly #options: ExtensionPolicyServiceOptions;

  constructor(options: ExtensionPolicyServiceOptions) {
    this.#options = options;
  }

  async read(accountId: string): Promise<ExtensionPolicyView> {
    const profile = await this.#options.profiles(accountId);
    // Read the version first: a concurrent commit then makes the CAS fail instead of accepting
    // an update computed from a snapshot the caller has not observed.
    const configVersion = this.#options.config.version;
    const snapshot = this.#options.config.snapshot();
    const policy = snapshot.accountPolicies[accountId] ?? defaultAccountPolicy();
    const catalog = buildExtensionCatalog({
      profile,
      registry: this.#options.registry,
      publicSkills: snapshot.skills,
      privateSkills: policy.skills?.definitions ?? [],
      ...(this.#options.readyPlugins ? { readyPlugins: this.#options.readyPlugins(accountId) } : {}),
      ...(this.#options.readyTools ? { readyTools: this.#options.readyTools(accountId) } : {})
    });
    return {
      accountId,
      revision: extensionPolicyRevision(accountId, profile, policy),
      profileRevision: profile.revision,
      configVersion,
      authorizedTools: [...(policy.extensions?.authorizedTools ?? [])],
      defaults: cloneRunPolicy(policy.extensions?.defaults ?? {}),
      byKind: cloneByKind(policy.extensions?.byKind ?? {}),
      byConversation: cloneByConversation(policy.extensions?.byConversation ?? {}),
      catalog
    };
  }

  /** Resolves the same catalog and policy snapshot the UI and runtime must share. */
  async effective(
    accountId: string,
    conversation: ConversationRef,
    capabilityEnabled?: (capability: CapabilityId) => boolean
  ): Promise<EffectiveExtensions> {
    const view = await this.read(accountId);
    const extensions = extensionTree(view);
    return resolveEffectiveExtensions({
      accountId,
      conversation,
      catalog: view.catalog,
      authorizedTools: view.authorizedTools,
      ...(extensions ? { extensions } : {}),
      ...(capabilityEnabled ? { capabilityEnabled } : {})
    });
  }

  async update(accountId: string, input: UpdateExtensionPolicyInput): Promise<ExtensionPolicyView> {
    if (typeof input.expectedRevision !== 'string' || !input.expectedRevision) {
      throw new InvalidSpecError('expectedRevision 必须是当前扩展策略 revision。');
    }
    const current = await this.read(accountId);
    if (current.revision !== input.expectedRevision) {
      throw new AccompanyError('extension_conflict', '扩展策略已被修改，请刷新后重试。');
    }
    if (input.expectedProfileRevision !== undefined && input.expectedProfileRevision !== current.profileRevision) {
      throw new AccompanyError('extension_conflict', '账号插件版本已变化，请刷新后重试。');
    }
    const knownTools = new Set(current.catalog.tools.map((tool) => tool.id));
    const currentAuthorized = new Set(current.authorizedTools);
    if (input.patch.authorizedTools !== undefined) {
      if (!Array.isArray(input.patch.authorizedTools)) {
        throw new InvalidSpecError('authorizedTools 必须是数组。');
      }
      for (const id of input.patch.authorizedTools) {
        if (!isToolId(id)) throw new InvalidSpecError(`authorizedTools 包含无效工具 ${String(id)}。`);
        if (!knownTools.has(id) && !currentAuthorized.has(id)) {
          throw new InvalidSpecError(`工具 ${id} 未安装或未声明，不能授权。`);
        }
      }
    }
    await this.#options.config.updateAccountPolicy(accountId, current.configVersion, (base) => {
      const next = structuredClone(base);
      const defaults = mergeRunPolicy(next.extensions?.defaults ?? {}, input.patch.defaults, current.catalog, 'defaults');
      const byKind = mergeByKind(next.extensions?.byKind ?? {}, input.patch.byKind, current.catalog);
      const byConversation = mergeByConversation(
        next.extensions?.byConversation ?? {},
        input.patch.byConversation,
        current.catalog
      );
      const authorizedTools = input.patch.authorizedTools === undefined
        ? next.extensions?.authorizedTools
        : [...new Set(input.patch.authorizedTools)];
      const extensions = pruneExtensions({
        ...(authorizedTools && authorizedTools.length > 0 ? { authorizedTools } : {}),
        defaults,
        byKind,
        byConversation
      });
      if (extensions) next.extensions = extensions;
      else delete next.extensions;
      return next;
    }, async () => {
      const latest = await this.#options.profiles(accountId);
      if (latest.revision !== current.profileRevision) {
        throw new AccompanyError('extension_conflict', '账号插件版本在保存期间发生变化，请刷新后重试。');
      }
    });
    return this.read(accountId);
  }
}

function mergeRunPolicy(
  base: ExtensionRunPolicy,
  patch: ExtensionRunPolicyPatch | undefined,
  catalog: ExtensionCatalog,
  scope: string
): ExtensionRunPolicy {
  const next: ExtensionRunPolicy = cloneRunPolicy(base);
  if (!patch) return next;
  mergeSection(next, 'plugins', patch.plugins, new Set(catalog.plugins.map((plugin) => plugin.key)), scope);
  mergeSection(next, 'tools', patch.tools, new Set(catalog.tools.map((tool) => tool.id)), scope);
  mergeSection(next, 'skills', patch.skills, new Set(catalog.skills.map((skill) => skill.id)), scope);
  mergeSection(next, 'state', patch.state, new Set(catalog.plugins.filter((plugin) => plugin.accountSharedState).map((plugin) => plugin.key)), scope);
  return next;
}

function mergeSection(
  policy: ExtensionRunPolicy,
  section: 'plugins' | 'tools' | 'skills' | 'state',
  patch: Record<string, ExtensionSwitch> | undefined,
  known: Set<string>,
  scope: string
): void {
  if (!patch) return;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new InvalidSpecError(`${scope}.${section} 必须是对象。`);
  }
  const current = { ...(policy[section] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== 'inherit' && value !== 'on' && value !== 'off') {
      throw new InvalidSpecError(`${scope}.${section}.${key} 必须是 inherit、on 或 off。`);
    }
    if (value !== 'inherit' && !known.has(key)) {
      throw new InvalidSpecError(`${scope}.${section}.${key} 不在当前插件/工具/Skill 目录中。`);
    }
    if (value === 'inherit') delete current[key];
    else current[key] = value;
  }
  if (Object.keys(current).length > 0) policy[section] = current;
  else delete policy[section];
}

function mergeByKind(
  base: Partial<Record<ChatKind, ExtensionRunPolicy>>,
  patch: Partial<Record<ChatKind, ExtensionRunPolicyPatch>> | undefined,
  catalog: ExtensionCatalog
): Partial<Record<ChatKind, ExtensionRunPolicy>> {
  const next = cloneByKind(base);
  if (!patch) return next;
  for (const kind of ['private', 'group'] as const) {
    const entry = patch[kind];
    if (entry === undefined) continue;
    const merged = mergeRunPolicy(next[kind] ?? {}, entry, catalog, `byKind.${kind}`);
    if (runPolicyEmpty(merged)) delete next[kind];
    else next[kind] = merged;
  }
  const unknown = Object.keys(patch).find((key) => key !== 'private' && key !== 'group');
  if (unknown) throw new InvalidSpecError(`byKind.${unknown} 不是受支持的会话类型。`);
  return next;
}

function mergeByConversation(
  base: Record<string, ExtensionRunPolicy>,
  patch: Record<string, ExtensionRunPolicyPatch> | undefined,
  catalog: ExtensionCatalog
): Record<string, ExtensionRunPolicy> {
  const next = cloneByConversation(base);
  if (!patch) return next;
  for (const [key, entry] of Object.entries(patch)) {
    assertConversationKey(key);
    const merged = mergeRunPolicy(next[key] ?? {}, entry, catalog, `byConversation.${key}`);
    if (runPolicyEmpty(merged)) delete next[key];
    else next[key] = merged;
  }
  return next;
}

function pruneExtensions(policy: AccountExtensionPolicy): AccountExtensionPolicy | undefined {
  const authorizedTools = policy.authorizedTools && policy.authorizedTools.length > 0
    ? [...policy.authorizedTools]
    : undefined;
  const byKind = cloneByKind(policy.byKind);
  const byConversation = cloneByConversation(policy.byConversation);
  if (runPolicyEmpty(policy.defaults) && Object.keys(byKind).length === 0 && Object.keys(byConversation).length === 0) {
    if (!authorizedTools) return undefined;
    return { authorizedTools, defaults: {}, byKind: {}, byConversation: {} };
  }
  return {
    ...(authorizedTools ? { authorizedTools } : {}),
    defaults: cloneRunPolicy(policy.defaults),
    byKind,
    byConversation
  };
}

function assertConversationKey(key: string): void {
  const [kind, peerId, ...rest] = key.split('/');
  if (rest.length > 0 || (kind !== 'private' && kind !== 'group') || !peerId) {
    throw new InvalidSpecError(`byConversation.${key} 必须使用 private/<peerId> 或 group/<peerId>。`);
  }
}

function cloneRunPolicy(policy: ExtensionRunPolicy): ExtensionRunPolicy {
  return {
    ...(policy.plugins ? { plugins: { ...policy.plugins } } : {}),
    ...(policy.tools ? { tools: { ...policy.tools } } : {}),
    ...(policy.skills ? { skills: { ...policy.skills } } : {}),
    ...(policy.state ? { state: { ...policy.state } } : {})
  };
}

function cloneByKind(input: Partial<Record<ChatKind, ExtensionRunPolicy>>): Partial<Record<ChatKind, ExtensionRunPolicy>> {
  return Object.fromEntries(Object.entries(input).map(([kind, policy]) => [kind, cloneRunPolicy(policy)]));
}

function cloneByConversation(input: Record<string, ExtensionRunPolicy>): Record<string, ExtensionRunPolicy> {
  return Object.fromEntries(Object.entries(input).map(([key, policy]) => [key, cloneRunPolicy(policy)]));
}

function runPolicyEmpty(policy: ExtensionRunPolicy): boolean {
  return !policy.plugins && !policy.tools && !policy.skills && !policy.state;
}

function extensionTree(view: ExtensionPolicyView): AccountExtensionPolicy | undefined {
  if (runPolicyEmpty(view.defaults) && Object.keys(view.byKind).length === 0 && Object.keys(view.byConversation).length === 0) {
    return undefined;
  }
  return {
    defaults: cloneRunPolicy(view.defaults),
    byKind: cloneByKind(view.byKind),
    byConversation: cloneByConversation(view.byConversation)
  };
}

function extensionPolicyRevision(accountId: string, profile: ResolvedProfile, policy: AccountPolicy): string {
  const extensions = policy.extensions
    ? {
      ...policy.extensions,
      ...(policy.extensions.authorizedTools
        ? { authorizedTools: [...policy.extensions.authorizedTools].sort() }
        : {})
    }
    : null;
  return createHash('sha256')
    .update(stableStringify({
      accountId,
      profile: profile.plugins.map((plugin) => [plugin.ref.source as PluginSource, plugin.ref.id, plugin.ref.revision]),
      extensions
    }))
    .digest('hex')
    .slice(0, 16);
}
