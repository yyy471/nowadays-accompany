import type { CapabilityId } from '../policy/capabilities.js';
import type { AccountExtensionPolicy } from '../providers/types.js';
import type { ConversationRef } from '../routing/identity.js';
import type { CatalogHook, CatalogPlugin, CatalogSkill, CatalogTool, ExtensionCatalog } from './catalog.js';
import { pluginKey, type ToolOwner } from './contracts.js';
import { resolveExtensionSwitch, resolvePluginSwitch, type ExtensionSwitchSource } from './policy.js';

export type EffectiveIssueCode =
  | 'plugin_switch_off'
  | 'switch_off'
  | 'unauthorized'
  | 'handler_not_ready'
  | 'capability_unavailable'
  | 'requires_unavailable'
  | 'skill_tool_unavailable'
  | 'kind_scope'
  | 'peer_scope';

export interface EffectiveIssue {
  code: EffectiveIssueCode;
  /** Bounded identifier such as a tool id or capability; never a path or secret. */
  detail?: string;
}

export interface EffectiveToolStatus {
  tool: CatalogTool;
  enabled: boolean;
  authorized: boolean;
  switchSource: ExtensionSwitchSource;
  issues: EffectiveIssue[];
}

export interface EffectiveHookStatus {
  hook: CatalogHook;
  enabled: boolean;
  switchSource: ExtensionSwitchSource;
  issues: EffectiveIssue[];
}

export interface EffectiveSkillStatus {
  skill: CatalogSkill;
  enabled: boolean;
  switchSource: ExtensionSwitchSource;
  issues: EffectiveIssue[];
  unavailableTools: string[];
}

export interface EffectiveStateStatus {
  pluginKey: string;
  accountSharedState: boolean;
  enabled: boolean;
  switchSource: ExtensionSwitchSource;
}

export interface EffectiveExtensions {
  accountId: string;
  conversation: ConversationRef;
  plugins: CatalogPlugin[];
  tools: EffectiveToolStatus[];
  hooks: EffectiveHookStatus[];
  skills: EffectiveSkillStatus[];
  states: EffectiveStateStatus[];
}

export interface ResolveEffectiveExtensionsInput {
  accountId: string;
  conversation: ConversationRef;
  catalog: ExtensionCatalog;
  authorizedTools: readonly string[];
  extensions?: AccountExtensionPolicy;
  /** Actual capability resolution; omitted means "unknown, do not block on capability". */
  capabilityEnabled?: (capability: CapabilityId) => boolean;
}

export interface ToolGateInput {
  id: string;
  owner: ToolOwner;
  handlerReady: boolean;
  authorized: boolean;
  capability?: CapabilityId;
  conversation: ConversationRef;
  extensions?: AccountExtensionPolicy;
  capabilityEnabled?: (capability: CapabilityId) => boolean;
}

export interface ToolGate {
  enabled: boolean;
  switchSource: ExtensionSwitchSource;
  issues: EffectiveIssue[];
}

/** Plugin-owned tools and hooks stay off until the account explicitly enables their scope. */
export function defaultToolSwitch(owner: ToolOwner): 'on' | 'off' {
  return owner.kind === 'builtin' ? 'on' : 'off';
}

export function defaultSkillSwitch(skill: Pick<CatalogSkill, 'source' | 'defaultEnabled'>): 'on' | 'off' {
  return skill.defaultEnabled ? 'on' : 'off';
}

/** Hard authorization and capability checks are intentionally independent of the run switch. */
export function resolveToolGate(input: ToolGateInput): ToolGate {
  const issues: EffectiveIssue[] = [];
  const ownerPluginKey = input.owner.kind === 'plugin' ? pluginKey(input.owner.source, input.owner.pluginId) : undefined;
  if (ownerPluginKey) {
    const plugin = resolvePluginSwitch({ extensions: input.extensions }, input.conversation, ownerPluginKey);
    if (plugin.value === 'off') issues.push({ code: 'plugin_switch_off', detail: ownerPluginKey });
  }
  if (!input.handlerReady) issues.push({ code: 'handler_not_ready' });
  if (!input.authorized) issues.push({ code: 'unauthorized' });
  const run = resolveExtensionSwitch(
    { extensions: input.extensions },
    input.conversation,
    'tools',
    input.id,
    defaultToolSwitch(input.owner)
  );
  if (run.value === 'off') issues.push({ code: 'switch_off' });
  if (input.capability && input.capabilityEnabled && !input.capabilityEnabled(input.capability)) {
    issues.push({ code: 'capability_unavailable', detail: input.capability });
  }
  return { enabled: issues.length === 0, switchSource: run.source, issues };
}

/**
 * Single effective-state resolver shared by diagnostics, request construction and execution
 * admission. A soft switch never overrides an uninstalled plugin or a revoked hard authorization.
 */
export function resolveEffectiveExtensions(input: ResolveEffectiveExtensionsInput): EffectiveExtensions {
  const authorized = new Set(input.authorizedTools);
  const tools: EffectiveToolStatus[] = input.catalog.tools.map((tool) => {
    const gate = resolveToolGate({
      id: tool.id,
      owner: tool.owner,
      handlerReady: tool.handlerReady,
      authorized: authorized.has(tool.id),
      ...(tool.capability ? { capability: tool.capability } : {}),
      conversation: input.conversation,
      ...(input.extensions ? { extensions: input.extensions } : {}),
      ...(input.capabilityEnabled ? { capabilityEnabled: input.capabilityEnabled } : {})
    });
    return {
      tool,
      enabled: gate.enabled,
      authorized: authorized.has(tool.id),
      switchSource: gate.switchSource,
      issues: gate.issues
    };
  });
  const effectiveTools = new Map(tools.map((status) => [status.tool.id, status]));

  const hooks: EffectiveHookStatus[] = input.catalog.hooks.map((hook) => {
    const issues: EffectiveIssue[] = [];
    const plugin = resolvePluginSwitch({ extensions: input.extensions }, input.conversation, hook.pluginKey);
    if (plugin.value === 'off') issues.push({ code: 'plugin_switch_off', detail: hook.pluginKey });
    if (!hook.handlerReady) issues.push({ code: 'handler_not_ready' });
    return {
      hook,
      enabled: issues.length === 0,
      switchSource: plugin.source,
      issues
    };
  });

  const skills: EffectiveSkillStatus[] = input.catalog.skills.map((skill) => {
    const issues: EffectiveIssue[] = [];
    if (skill.kinds && !skill.kinds.includes(input.conversation.kind)) {
      issues.push({ code: 'kind_scope', detail: skill.kinds.join(',') });
    }
    if (skill.peers && !skill.peers.includes(input.conversation.peerId)) {
      issues.push({ code: 'peer_scope' });
    }
    if (skill.pluginKey) {
      const plugin = resolvePluginSwitch({ extensions: input.extensions }, input.conversation, skill.pluginKey);
      if (plugin.value === 'off') issues.push({ code: 'plugin_switch_off', detail: skill.pluginKey });
    }
    const run = resolveExtensionSwitch(
      { extensions: input.extensions },
      input.conversation,
      'skills',
      skill.id,
      defaultSkillSwitch(skill)
    );
    if (run.value === 'off') issues.push({ code: 'switch_off' });
    for (const capability of skill.requires ?? []) {
      if (input.capabilityEnabled && !input.capabilityEnabled(capability)) {
        issues.push({ code: 'requires_unavailable', detail: capability });
      }
    }
    const unavailableTools = skill.tools.filter((toolId) => !effectiveTools.get(toolId)?.enabled);
    for (const toolId of unavailableTools) {
      issues.push({ code: 'skill_tool_unavailable', detail: toolId });
    }
    return { skill, enabled: issues.length === 0, switchSource: run.source, issues, unavailableTools };
  });

  const states: EffectiveStateStatus[] = input.catalog.plugins.map((plugin) => {
    const run = resolveExtensionSwitch(
      { extensions: input.extensions },
      input.conversation,
      'state',
      plugin.key,
      'off'
    );
    return {
      pluginKey: plugin.key,
      accountSharedState: plugin.accountSharedState,
      enabled: plugin.accountSharedState && run.value === 'on',
      switchSource: run.source
    };
  });
  return { accountId: input.accountId, conversation: input.conversation, plugins: input.catalog.plugins, tools, hooks, skills, states };
}
