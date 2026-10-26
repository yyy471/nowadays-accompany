import type { AccountExtensionPolicy, ExtensionRunPolicy, ExtensionSwitch } from '../providers/types.js';
import type { ConversationRef } from '../routing/identity.js';
import { conversationScopeKey } from '../providers/types.js';

export type ExtensionSwitchSection = 'plugins' | 'tools' | 'skills' | 'state';
export type ExtensionSwitchSource = 'account' | 'kind' | 'conversation' | 'default';

export interface ExtensionSwitchResolution {
  value: 'on' | 'off';
  source: ExtensionSwitchSource;
}

interface ScopeEntry {
  source: ExtensionSwitchSource;
  policy: ExtensionRunPolicy | undefined;
}

/** Minimal shape needed by the resolver; full AccountPolicy satisfies it. */
export interface ExtensionPolicyCarrier {
  extensions?: AccountExtensionPolicy;
}

function scopesFor(policy: ExtensionPolicyCarrier, conversation: ConversationRef): ScopeEntry[] {
  const extensions = policy.extensions;
  if (!extensions) return [];
  const conversationKey = conversationScopeKey(conversation.kind, conversation.peerId);
  return [
    { source: 'account', policy: extensions.defaults },
    { source: 'kind', policy: extensions.byKind[conversation.kind] },
    { source: 'conversation', policy: extensions.byConversation[conversationKey] }
  ];
}

/**
 * Resolves a soft extension switch with account → kind → conversation precedence. An absent or
 * `inherit` entry falls through; the hard installation/tool authorization is checked separately.
 */
export function resolveExtensionSwitch(
  accountPolicy: ExtensionPolicyCarrier,
  conversation: ConversationRef,
  section: ExtensionSwitchSection,
  key: string,
  fallback: 'on' | 'off'
): ExtensionSwitchResolution {
  let resolved: ExtensionSwitchResolution = { value: fallback, source: 'default' };
  for (const entry of scopesFor(accountPolicy, conversation)) {
    const value: ExtensionSwitch | undefined = entry.policy?.[section]?.[key];
    if (value === undefined || value === 'inherit') continue;
    // Later scopes override earlier ones; keep scanning to the conversation level.
    resolved = { value, source: entry.source };
  }
  return resolved;
}

/** Plugins and plugin hooks are disabled unless an account scope explicitly enables them. */
export function resolvePluginSwitch(
  accountPolicy: ExtensionPolicyCarrier,
  conversation: ConversationRef,
  key: string
): ExtensionSwitchResolution {
  return resolveExtensionSwitch(accountPolicy, conversation, 'plugins', key, 'off');
}

/** Keys that resolve to `on` for this conversation, used for diagnostics of missing definitions. */
export function enabledExtensionSwitches(
  accountPolicy: ExtensionPolicyCarrier,
  conversation: ConversationRef,
  section: ExtensionSwitchSection
): Array<{ key: string; source: ExtensionSwitchSource }> {
  const keys = new Set<string>();
  for (const entry of scopesFor(accountPolicy, conversation)) {
    for (const key of Object.keys(entry.policy?.[section] ?? {})) keys.add(key);
  }
  const result: Array<{ key: string; source: ExtensionSwitchSource }> = [];
  for (const key of keys) {
    const resolved = resolveExtensionSwitch(accountPolicy, conversation, section, key, 'off');
    if (resolved.value === 'on') result.push({ key, source: resolved.source });
  }
  return result;
}
