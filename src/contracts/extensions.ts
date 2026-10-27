import type { ExtensionCatalog } from '../extensions/catalog.js';
import type { EffectiveExtensions } from '../extensions/effective.js';
import type { ExtensionSwitchSource } from '../extensions/policy.js';
import type { PluginRuntimeStatus } from '../extensions/runtime/account-runtime.js';
import type { ExtensionRunPolicy, ExtensionSwitch } from '../providers/types.js';
import type { ChatKind, ConversationRef } from '../routing/identity.js';

export type ExtensionSwitchValue = ExtensionSwitch;
export type { ExtensionRunPolicy };

export type ExtensionChatKind = ChatKind;

/** Partial patch: provided keys merge, `inherit` removes an override. */
export interface ExtensionPolicyPatchDto {
  defaults?: ExtensionRunPolicy;
  byKind?: Partial<Record<ChatKind, ExtensionRunPolicy>>;
  byConversation?: Record<string, ExtensionRunPolicy>;
  /** Replaces the hard account tool authorization list. */
  authorizedTools?: string[];
}

export interface ExtensionPolicyUpdateDto {
  expectedRevision: string;
  expectedProfileRevision?: string;
  patch: ExtensionPolicyPatchDto;
}

/** Handshake state of this account's plugin Workers in the current process. */
export interface ExtensionRuntimeView {
  /** False until a handshake ran; false again after the account runtime was released. */
  synced: boolean;
  readyPlugins: string[];
  readyTools: string[];
  plugins: PluginRuntimeStatus[];
}

export interface ExtensionPolicyDto {
  accountId: string;
  /** Covers the extension subtree, hard tool authorization and installed plugin refs. */
  revision: string;
  profileRevision: string;
  configVersion: number;
  authorizedTools: string[];
  defaults: ExtensionRunPolicy;
  byKind: Partial<Record<ChatKind, ExtensionRunPolicy>>;
  byConversation: Record<string, ExtensionRunPolicy>;
  /** Plugin/tool/hook/Skill catalog from the installed profile, never includes plugin config values. */
  catalog: ExtensionCatalog;
  runtime: ExtensionRuntimeView;
}

export interface ExtensionEffectiveDto {
  accountId: string;
  conversation: ConversationRef;
  plugins: EffectiveExtensions['plugins'];
  tools: EffectiveExtensions['tools'];
  hooks: EffectiveExtensions['hooks'];
  skills: EffectiveExtensions['skills'];
  states: EffectiveExtensions['states'];
}

export interface ExtensionReloadDto {
  plugins: PluginRuntimeStatus[];
}

/** Scope a switch value was written at; `default` means the built-in fallback. */
export type ExtensionSwitchOrigin = ExtensionSwitchSource;
