import { AccompanyError } from '../core/errors.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { EffectivePolicy } from '../policy/policy.js';
import type { SkillConfig, SkillStatus, ToolDefinition, CapabilityHook, CapabilityHookEvent, HookName } from './types.js';

interface RegisteredHook {
  id: string;
  capabilities?: CapabilityId[];
  handler: CapabilityHook;
}

/** 进程内扩展注册表；无模块级单例，由 Core 持有并注入。 */
export class ExtensionRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #hooks = new Map<HookName, RegisteredHook[]>();

  registerTool(tool: ToolDefinition): void {
    if (this.#tools.has(tool.id)) throw new AccompanyError('duplicate_tool', `tool ${tool.id} is already registered`);
    this.#tools.set(tool.id, tool);
  }

  registerHook(name: HookName, hook: RegisteredHook): void {
    const hooks = this.#hooks.get(name) ?? [];
    if (hooks.some((entry) => entry.id === hook.id)) {
      throw new AccompanyError('duplicate_hook', `hook ${hook.id} is already registered for ${name}`);
    }
    hooks.push(hook);
    this.#hooks.set(name, hooks);
  }

  tool(id: string): ToolDefinition | undefined {
    return this.#tools.get(id);
  }

  listTools(): ToolDefinition[] {
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
    this.#hooks.clear();
  }
}

export interface SkillResolution {
  available: Array<SkillStatus & { instructions: string }>;
  unavailable: SkillStatus[];
}

/** Skill 只是受支持的说明/工具引用；可用性完全取决于同一套能力与工具授权。 */
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
    const accountSkills = policy.accountPolicy.skills;
    const disabled = new Set(accountSkills?.disabled ?? []);
    const explicitlyEnabled = new Set(accountSkills?.enabled ?? []);
    // 私有定义按 id 覆盖公用定义，且只在该账号的解析结果中出现。
    const definitions = new Map<string, { skill: SkillConfig; source: 'public' | 'private' }>();
    for (const skill of this.#skills()) definitions.set(skill.id, { skill, source: 'public' });
    for (const skill of accountSkills?.definitions ?? []) definitions.set(skill.id, { skill, source: 'private' });
    for (const id of explicitlyEnabled) {
      if (definitions.has(id)) continue;
      unavailable.push({ id, name: id, tools: [], available: false, reason: 'skill_not_found' });
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
      if (disabled.has(skill.id) || (skill.enabled === false && !explicitlyEnabled.has(skill.id))) {
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
