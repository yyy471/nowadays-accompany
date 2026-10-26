import { AccompanyError, InvalidSpecError } from '../core/errors.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { EffectivePolicy } from '../policy/policy.js';
import {
  EXTENSION_LIMITS,
  assertModelToolName,
  parseToolIdentity,
  pluginModelToolName,
  type ToolOwner
} from './contracts.js';
import { enabledExtensionSwitches, resolveExtensionSwitch } from './policy.js';
import { validateToolInputSchema } from './schema.js';
import type {
  SkillConfig,
  SkillStatus,
  ToolDefinition,
  RegisteredToolDefinition,
  CapabilityHook,
  CapabilityHookEvent,
  HookName
} from './types.js';

interface RegisteredHook {
  id: string;
  capabilities?: CapabilityId[];
  handler: CapabilityHook;
}

/** 进程内扩展注册表；无模块级单例，由 Core 持有并注入。 */
export class ExtensionRegistry {
  readonly #tools = new Map<string, RegisteredToolDefinition>();
  readonly #modelNames = new Map<string, string>();
  readonly #hooks = new Map<HookName, RegisteredHook[]>();

  registerTool(tool: ToolDefinition): void {
    const identity = parseToolIdentity(tool.id);
    if (!identity) {
      throw new InvalidSpecError(`tool ${tool.id} 必须使用 builtin.<id> 或 <source>/plugin/<pluginId>/<toolId> 身份。`);
    }
    if (tool.owner && !sameOwner(tool.owner, identityOwner(identity))) {
      throw new InvalidSpecError(`tool ${tool.id} 的 owner 与完整身份不一致。`);
    }
    if (this.#tools.has(tool.id)) {
      throw new AccompanyError('duplicate_tool', `tool ${tool.id} is already registered`);
    }
    const name = tool.name ?? (identity.kind === 'plugin'
      ? pluginModelToolName(identity)
      : (() => { throw new InvalidSpecError('builtin tool 必须显式声明稳定的模型工具名。'); })());
    assertModelToolName(name, `tool ${tool.id} name`);
    const conflict = this.#modelNames.get(name);
    if (conflict && conflict !== tool.id) {
      throw new AccompanyError('duplicate_tool_name', `tool name ${name} is already registered by ${conflict}`);
    }
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > EXTENSION_LIMITS.maxDescription) {
      throw new InvalidSpecError(`tool ${tool.id} description 必须是不超过 ${EXTENSION_LIMITS.maxDescription} 字符的非空文本。`);
    }
    if (tool.label !== undefined && (typeof tool.label !== 'string' || !tool.label.trim() || tool.label.length > 200)) {
      throw new InvalidSpecError(`tool ${tool.id} label 必须是不超过 200 字符的非空文本。`);
    }
    const inputSchema = validateToolInputSchema(tool.inputSchema, `tool ${tool.id} inputSchema`);
    const registered: RegisteredToolDefinition = {
      id: tool.id,
      name,
      ...(tool.label ? { label: tool.label } : {}),
      description: tool.description,
      ...(tool.capability ? { capability: tool.capability } : {}),
      inputSchema,
      owner: identityOwner(identity),
      effect: tool.effect ?? 'read',
      timeoutMs: boundedInt(tool.timeoutMs, `tool ${tool.id} timeoutMs`, EXTENSION_LIMITS.defaultToolTimeoutMs, 100, EXTENSION_LIMITS.maxToolTimeoutMs),
      maxArgumentBytes: boundedInt(
        tool.maxArgumentBytes,
        `tool ${tool.id} maxArgumentBytes`,
        EXTENSION_LIMITS.defaultToolArgumentBytes,
        1024,
        EXTENSION_LIMITS.maxToolArgumentBytes
      ),
      maxResultBytes: boundedInt(
        tool.maxResultBytes,
        `tool ${tool.id} maxResultBytes`,
        EXTENSION_LIMITS.maxToolResultBytes,
        512,
        EXTENSION_LIMITS.maxToolResultBytes
      )
    };
    if (registered.effect !== 'read' && registered.effect !== 'action') {
      throw new InvalidSpecError(`tool ${tool.id} effect 必须是 read 或 action。`);
    }
    this.#tools.set(tool.id, registered);
    this.#modelNames.set(name, tool.id);
  }

  registerHook(name: HookName, hook: RegisteredHook): void {
    const hooks = this.#hooks.get(name) ?? [];
    if (hooks.some((entry) => entry.id === hook.id)) {
      throw new AccompanyError('duplicate_hook', `hook ${hook.id} is already registered for ${name}`);
    }
    hooks.push(hook);
    this.#hooks.set(name, hooks);
  }

  tool(id: string): RegisteredToolDefinition | undefined {
    return this.#tools.get(id);
  }

  listTools(): RegisteredToolDefinition[] {
    return [...this.#tools.values()];
  }

  async dispatch(name: HookName, event: Omit<CapabilityHookEvent, 'hook' | 'at'>, now: () => number): Promise<void> {
    const hooks = this.#hooks.get(name) ?? [];
    for (const hook of hooks) {
      if (hook.capabilities && !hook.capabilities.includes(event.capability)) continue;
      await hook.handler({ ...event, hook: name, at: now() });
    }
  }

  clear(): void {
    this.#tools.clear();
    this.#modelNames.clear();
    this.#hooks.clear();
  }
}

export interface SkillResolution {
  available: Array<SkillStatus & { instructions: string }>;
  unavailable: SkillStatus[];
}

/** Skill 只是受支持的说明/工具引用；可用性完全取决于同一套能力、工具授权与运行开关。 */
export class SkillRuntime {
  readonly #skills: () => SkillConfig[];

  constructor(skills: () => SkillConfig[]) {
    this.#skills = skills;
  }

  resolve(
    policy: EffectivePolicy,
    capabilityEnabled: (capability: CapabilityId) => boolean,
    availableTools: Set<string>
  ): SkillResolution {
    const available: Array<SkillStatus & { instructions: string }> = [];
    const unavailable: SkillStatus[] = [];
    const accountPolicy = policy.accountPolicy;
    // 私有定义按 id 覆盖公用定义，且只在该账号的解析结果中出现。
    const definitions = new Map<string, { skill: SkillConfig; source: 'public' | 'private' }>();
    for (const skill of this.#skills()) definitions.set(skill.id, { skill, source: 'public' });
    for (const skill of accountPolicy.skills?.definitions ?? []) definitions.set(skill.id, { skill, source: 'private' });
    for (const { key } of enabledExtensionSwitches(accountPolicy, policy.conversation, 'skills')) {
      if (definitions.has(key)) continue;
      unavailable.push({ id: key, name: key, tools: [], available: false, reason: 'skill_not_found' });
    }
    for (const { skill, source } of definitions.values()) {
      const base: SkillStatus = {
        id: skill.id,
        name: skill.name,
        tools: [...skill.tools],
        ...(skill.requires?.length ? { requires: [...skill.requires] } : {}),
        available: false,
        source
      };
      const enabled = resolveExtensionSwitch(
        accountPolicy,
        policy.conversation,
        'skills',
        skill.id,
        skill.enabled === false ? 'off' : 'on'
      );
      if (enabled.value === 'off') {
        unavailable.push({ ...base, reason: 'skill_disabled' });
        continue;
      }
      if (skill.kinds && !skill.kinds.includes(policy.conversation.kind)) {
        unavailable.push({ ...base, reason: 'scope_mismatch' });
        continue;
      }
      if (skill.peers && !skill.peers.includes(policy.conversation.peerId)) {
        unavailable.push({ ...base, reason: 'scope_mismatch' });
        continue;
      }
      const missingCapability = (skill.requires ?? []).find((capability) => !capabilityEnabled(capability));
      if (missingCapability) {
        unavailable.push({ ...base, reason: `capability_unavailable:${missingCapability}` });
        continue;
      }
      const missingTool = skill.tools.find((tool) => !availableTools.has(tool));
      if (missingTool) {
        unavailable.push({ ...base, reason: `tool_unavailable:${missingTool}` });
        continue;
      }
      available.push({ ...base, available: true, instructions: skill.instructions });
    }
    return { available, unavailable };
  }
}

function identityOwner(identity: NonNullable<ReturnType<typeof parseToolIdentity>>): ToolOwner {
  return identity.kind === 'builtin'
    ? { kind: 'builtin' }
    : { kind: 'plugin', source: identity.source, pluginId: identity.pluginId };
}

function sameOwner(left: ToolOwner, right: ToolOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'builtin') return true;
  return right.kind === 'plugin' && left.source === right.source && left.pluginId === right.pluginId;
}

function boundedInt(value: number | undefined, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidSpecError(`${path} 必须是 ${min} 到 ${max} 的整数。`);
  }
  return value;
}
