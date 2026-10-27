import type { ChatKind } from '../routing/identity.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { ToolEffect, ToolOwner } from './contracts.js';

/** 受支持的 Skill 内容：说明、工具引用、依赖能力与作用域；不是任意 JS 的别名。 */
export interface SkillConfig {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  tools: string[];
  requires?: CapabilityId[];
  kinds?: ChatKind[];
  peers?: string[];
  enabled?: boolean;
}

export interface ToolDefinition {
  /** Full identity: `builtin.<id>` or `<source>/plugin/<pluginId>/<toolId>`. */
  id: string;
  /** Protocol-facing stable model tool name; derived for plugin tools when omitted. */
  name?: string;
  label?: string;
  description: string;
  capability?: CapabilityId;
  inputSchema: Record<string, unknown>;
  owner?: ToolOwner;
  effect?: ToolEffect;
  timeoutMs?: number;
  maxArgumentBytes?: number;
  maxResultBytes?: number;
}

export interface RegisteredToolDefinition extends ToolDefinition {
  name: string;
  owner: ToolOwner;
  effect: ToolEffect;
  timeoutMs: number;
  maxArgumentBytes: number;
  maxResultBytes: number;
}

export interface SkillStatus {
  id: string;
  name: string;
  tools: string[];
  requires?: CapabilityId[];
  available: boolean;
  reason?: string;
  source?: 'public' | 'private' | 'plugin';
  /** Effective scope says yes, but the standard prompt budget did not select it. */
  selected?: boolean;
  selectionReason?: string;
}

export type HookName = 'capability:before' | 'capability:after';

export interface CapabilityHookEvent {
  hook: HookName;
  capability: CapabilityId;
  accountId: string;
  kind: ChatKind;
  peerId: string;
  providerId: string;
  modelId: string;
  at: number;
}

export type CapabilityHook = (event: CapabilityHookEvent) => void | Promise<void>;
