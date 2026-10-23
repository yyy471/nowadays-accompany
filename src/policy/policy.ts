import type { ConfigStore } from '../providers/config-store.js';
import type {
  AccountPolicy,
  CapabilityBinding,
  CapabilityTarget,
  ReplyMode,
  RuntimeConfigV2,
  ScopePolicy,
  VisionMode
} from '../providers/types.js';
import { accountPolicyFor, conversationScopeKey, defaultAccountPolicy } from '../providers/types.js';
import { InvalidSpecError } from '../core/errors.js';
import { CAPABILITY_IDS, type CapabilityId } from './capabilities.js';
import type { ChatKind, ConversationRef } from '../routing/identity.js';

export type PolicySource = 'account' | 'kind' | 'conversation' | 'default';

export interface EffectivePolicy {
  accountId: string;
  conversation: ConversationRef;
  accountPolicy: AccountPolicy;
  agentEnabled: boolean;
  agentSource: PolicySource;
  visionMode: VisionMode;
  visionSource: PolicySource;
  crossProviderFallback: boolean;
  allowCloudUpload: boolean;
  replyMode: ReplyMode;
  capabilities: Record<
    CapabilityId,
    {
      enabled: boolean;
      source: PolicySource;
      binding?: CapabilityBinding;
      bindingSource?: PolicySource;
    }
  >;
}

interface ScopeEntry {
  source: PolicySource;
  policy: ScopePolicy;
}

function scopesFor(accountPolicy: AccountPolicy, conversation: ConversationRef): ScopeEntry[] {
  const entries: ScopeEntry[] = [{ source: 'account', policy: accountPolicy }];
  const kindPolicy = accountPolicy.byKind[conversation.kind as ChatKind];
  if (kindPolicy) entries.push({ source: 'kind', policy: kindPolicy });
  const key = conversationScopeKey(conversation.kind, conversation.peerId);
  const conversationPolicy = accountPolicy.byConversation[key];
  if (conversationPolicy) entries.push({ source: 'conversation', policy: conversationPolicy });
  return entries;
}

/**
 * 只合并普通开关与绑定。账号硬授权（allowedProviders、云端媒体外发）不参与覆盖，
 * 由 CapabilityRouter 在解析 provider 时强制检查。
 */
export class PolicyService {
  readonly #config: ConfigStore;

  constructor(config: ConfigStore) {
    this.#config = config;
  }

  get configVersion(): number {
    return this.#config.version;
  }

  resolve(accountId: string, conversation: ConversationRef): EffectivePolicy {
    if (conversation.accountId !== accountId) {
      throw new Error(`policy scope account mismatch: ${accountId} vs ${conversation.accountId}`);
    }
    const config = this.#config.snapshot();
    return this.resolveWithConfig(config, accountId, conversation);
  }

  resolveWithConfig(config: RuntimeConfigV2, accountId: string, conversation: ConversationRef): EffectivePolicy {
    const accountPolicy = accountPolicyFor(config, accountId);
    const scopes = scopesFor(accountPolicy, conversation);

    let agentEnabled = true;
    let agentSource: PolicySource = 'default';
    let visionMode: VisionMode = 'external';
    let visionSource: PolicySource = 'default';
    const capabilityState = {} as EffectivePolicy['capabilities'];
    for (const capability of CAPABILITY_IDS) {
      capabilityState[capability] = { enabled: true, source: 'default' };
    }

    for (const entry of scopes) {
      if (entry.policy.agentEnabled !== undefined) {
        agentEnabled = entry.policy.agentEnabled;
        agentSource = entry.source;
      }
      if (entry.policy.visionMode !== undefined) {
        visionMode = entry.policy.visionMode;
        visionSource = entry.source;
      }
      // Model services and capability switches are account-level. Keep legacy
      // scoped values on disk for migration review, but never apply them.
      if (entry.source !== 'account') continue;
      for (const capability of CAPABILITY_IDS) {
        const enabled = entry.policy.capabilities?.[capability];
        if (enabled !== undefined) {
          capabilityState[capability].enabled = enabled;
          capabilityState[capability].source = entry.source;
        }
        const binding = entry.policy.bindings?.[capability];
        if (binding) {
          capabilityState[capability].binding = binding;
          capabilityState[capability].bindingSource = entry.source;
        }
      }
    }

    return {
      accountId,
      conversation,
      accountPolicy,
      agentEnabled,
      agentSource,
      visionMode,
      visionSource,
      crossProviderFallback: accountPolicy.crossProviderFallback,
      allowCloudUpload: accountPolicy.media.allowCloudUpload,
      replyMode: accountPolicy.replyMode ?? 'auto',
      capabilities: capabilityState
    };
  }

  resolveAccount(accountId: string): AccountPolicy {
    return accountPolicyFor(this.#config.snapshot(), accountId);
  }

  hasBindings(accountId: string): boolean {
    const policy = accountPolicyFor(this.#config.snapshot(), accountId);
    return hasBindingsInScope(policy);
  }

  hasAnyPolicy(accountId: string): boolean {
    const config = this.#config.snapshot();
    return Boolean(config.accountPolicies[accountId]);
  }

  replyModeFor(accountId: string, legacyPluginsPresent: boolean): 'agent' | 'plugins' {
    const requested = accountPolicyFor(this.#config.snapshot(), accountId).replyMode ?? 'auto';
    if (requested === 'agent') return 'agent';
    if (requested === 'plugins') return legacyPluginsPresent ? 'plugins' : 'agent';
    return legacyPluginsPresent ? 'plugins' : 'agent';
  }

  /** 精确列出 fallback 候选；跨服务授权由 router 再检查。 */
  targetsFor(policy: EffectivePolicy, capability: CapabilityId): CapabilityTarget[] {
    const binding = policy.capabilities[capability].binding;
    if (!binding) return [];
    const targets: CapabilityTarget[] = [{ providerId: binding.providerId, modelId: binding.modelId }];
    for (const target of binding.fallback ?? []) targets.push(target);
    return targets;
  }
}

function hasBindingsInScope(scope: ScopePolicy): boolean {
  return Object.keys(scope.bindings ?? {}).length > 0;
}

export function patchAgentEnabled(
  policy: AccountPolicy,
  enabled: boolean,
  scope?: { kind?: ChatKind; peerId?: string }
): AccountPolicy {
  const next = structuredClone(policy);
  if (scope?.kind && scope.peerId) {
    const key = conversationScopeKey(scope.kind, scope.peerId);
    next.byConversation[key] = { ...(next.byConversation[key] ?? {}), agentEnabled: enabled };
    return next;
  }
  if (scope?.kind) {
    next.byKind[scope.kind] = { ...(next.byKind[scope.kind] ?? {}), agentEnabled: enabled };
    return next;
  }
  next.agentEnabled = enabled;
  return next;
}

export function patchCapability(
  policy: AccountPolicy,
  capability: CapabilityId,
  enabled: boolean,
  scope?: { kind?: ChatKind; peerId?: string }
): AccountPolicy {
  if (scope?.kind || scope?.peerId) {
    throw new InvalidSpecError('capability and model settings can only be configured per account');
  }
  const next = structuredClone(policy);
  next.capabilities = { ...(next.capabilities ?? {}), [capability]: enabled };
  return next;
}

export function emptyPolicy(): AccountPolicy {
  return defaultAccountPolicy();
}

export type { CapabilityTarget };
