import { createHash } from 'node:crypto';
import { InvalidSpecError } from '../core/errors.js';
import { isCapabilityId, type CapabilityId } from '../policy/capabilities.js';
import type { ChatKind } from '../routing/identity.js';
import { validateToolInputSchema } from './schema.js';

export const EXTENSION_LIMITS = {
  maxPluginTools: 32,
  maxPluginHooks: 8,
  maxPluginSkills: 32,
  maxDescription: 4_000,
  maxSkillInstructions: 8_000,
  maxSkillDescription: 500,
  maxSkillTools: 8,
  maxToolArgumentBytes: 64 * 1024,
  defaultToolArgumentBytes: 16 * 1024,
  maxToolResultBytes: 8 * 1024,
  maxToolTimeoutMs: 120_000,
  defaultToolTimeoutMs: 30_000,
  maxHookTimeoutMs: 5_000,
  defaultHookTimeoutMs: 500,
  maxModelToolName: 64
} as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PLUGIN_KEY = /^(public|private)\/plugin\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLUGIN_SKILL_ID = /^(public|private)\/plugin\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/skill\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_ID = /^(builtin\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}|(?:public|private)\/plugin\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

export type PluginSource = 'public' | 'private';
export type ToolEffect = 'read' | 'action';
export type ToolOwner =
  | { kind: 'builtin' }
  | { kind: 'plugin'; source: PluginSource; pluginId: string };

export type ToolIdentity =
  | { kind: 'builtin'; toolId: string; id: string }
  | { kind: 'plugin'; source: PluginSource; pluginId: string; toolId: string; id: string };

export interface PluginToolDeclaration {
  /** Tool-local id; the runtime identity is namespaced by source and plugin id. */
  id: string;
  label?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  capability?: CapabilityId;
  timeoutMs: number;
  maxArgumentBytes: number;
  maxResultBytes: number;
}

export type PluginHookName = 'beforeContext' | 'afterTurn';

export interface PluginHookDeclaration {
  name: PluginHookName;
  timeoutMs: number;
}

export interface PluginSkillDeclaration {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  /** Built-in tool ids or this plugin's local tool ids; the catalog namespaces locals. */
  tools: string[];
  requires?: CapabilityId[];
  kinds?: ChatKind[];
  peers?: string[];
}

export interface PluginStateDeclaration {
  /** Changing this value requires an explicit migration; incompatible state is never silently discarded. */
  version: string;
  /** Default state remains isolated by kind + peer + role epoch. */
  accountShared: boolean;
}

export interface PluginDeclarations {
  tools: PluginToolDeclaration[];
  hooks: PluginHookDeclaration[];
  skills: PluginSkillDeclaration[];
  state: PluginStateDeclaration;
}

export type ToolInvocationStatus = 'ok' | 'error' | 'submitted' | 'unknown';

export interface ToolInvocationResult {
  invocationId: string;
  status: ToolInvocationStatus;
  /** Safe machine-readable code; never a stack trace or provider payload. */
  errorCode?: string;
  text?: string;
  data?: unknown;
  /** Set when the executor had to bound text/data before returning it to the model. */
  truncated?: boolean;
  jobId?: string;
  media?: { mediaId: string; kind: 'image' | 'audio' | 'video' | 'file'; mimeType?: string };
}

export function pluginKey(source: PluginSource, pluginId: string): string {
  return `${source}/plugin/${pluginId}`;
}

export function pluginToolId(source: PluginSource, pluginId: string, toolId: string): string {
  return `${source}/plugin/${pluginId}/${toolId}`;
}

export function pluginSkillId(source: PluginSource, pluginId: string, skillId: string): string {
  return `${source}/plugin/${pluginId}/skill/${skillId}`;
}

export function builtinToolId(toolId: string): string {
  return `builtin.${toolId}`;
}

export function isPluginKey(value: string): boolean {
  return PLUGIN_KEY.test(value);
}

export function isToolId(value: string): boolean {
  return TOOL_ID.test(value);
}

export function isPluginSkillId(value: string): boolean {
  return PLUGIN_SKILL_ID.test(value);
}

export function parseToolIdentity(id: string): ToolIdentity | undefined {
  const builtin = /^builtin\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(id);
  if (builtin) return { kind: 'builtin', toolId: builtin[1]!, id };
  const plugin = /^(public|private)\/plugin\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(id);
  if (!plugin) return undefined;
  return {
    kind: 'plugin',
    source: plugin[1] as PluginSource,
    pluginId: plugin[2]!,
    toolId: plugin[3]!,
    id
  };
}

export function assertModelToolName(name: string, path = 'tool.name'): string {
  if (!MODEL_NAME.test(name)) {
    throw new InvalidSpecError(`${path} 必须是 1 至 ${EXTENSION_LIMITS.maxModelToolName} 位字母、数字、下划线或短横线。`);
  }
  return name;
}

/**
 * Stable protocol name for a plugin tool. Built-in tools keep their explicit names; plugin names
 * are prefixed and hashed when truncation is required. Collisions are rejected by the registry.
 */
export function pluginModelToolName(identity: Extract<ToolIdentity, { kind: 'plugin' }>): string {
  const readable = `p_${identity.source}_${identity.pluginId}_${identity.toolId}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (readable.length <= EXTENSION_LIMITS.maxModelToolName) return readable;
  const digest = createHash('sha1').update(identity.id).digest('hex').slice(0, 8);
  return `${readable.slice(0, 55)}_${digest}`;
}

export function parsePluginDeclarations(
  raw: { tools?: unknown; hooks?: unknown; skills?: unknown; state?: unknown },
  path = 'manifest'
): PluginDeclarations {
  const toolsRaw = raw.tools === undefined ? [] : raw.tools;
  if (!Array.isArray(toolsRaw)) throw new InvalidSpecError(`${path}.tools 必须是数组。`);
  if (toolsRaw.length > EXTENSION_LIMITS.maxPluginTools) {
    throw new InvalidSpecError(`${path}.tools 最多 ${EXTENSION_LIMITS.maxPluginTools} 项。`);
  }
  const tools: PluginToolDeclaration[] = [];
  const toolIds = new Set<string>();
  for (const [index, entry] of toolsRaw.entries()) {
    const tool = parsePluginTool(entry, `${path}.tools[${index}]`);
    if (toolIds.has(tool.id)) throw new InvalidSpecError(`${path}.tools 包含重复 id ${tool.id}。`);
    toolIds.add(tool.id);
    tools.push(tool);
  }

  const hooksRaw = raw.hooks === undefined ? [] : raw.hooks;
  if (!Array.isArray(hooksRaw)) throw new InvalidSpecError(`${path}.hooks 必须是数组。`);
  if (hooksRaw.length > EXTENSION_LIMITS.maxPluginHooks) {
    throw new InvalidSpecError(`${path}.hooks 最多 ${EXTENSION_LIMITS.maxPluginHooks} 项。`);
  }
  const hooks: PluginHookDeclaration[] = [];
  const hookNames = new Set<string>();
  for (const [index, entry] of hooksRaw.entries()) {
    const hook = parsePluginHook(entry, `${path}.hooks[${index}]`);
    if (hookNames.has(hook.name)) throw new InvalidSpecError(`${path}.hooks 包含重复 hook ${hook.name}。`);
    hookNames.add(hook.name);
    hooks.push(hook);
  }

  const skillsRaw = raw.skills === undefined ? [] : raw.skills;
  if (!Array.isArray(skillsRaw)) throw new InvalidSpecError(`${path}.skills 必须是数组。`);
  if (skillsRaw.length > EXTENSION_LIMITS.maxPluginSkills) {
    throw new InvalidSpecError(`${path}.skills 最多 ${EXTENSION_LIMITS.maxPluginSkills} 项。`);
  }
  const skills: PluginSkillDeclaration[] = [];
  const skillIds = new Set<string>();
  for (const [index, entry] of skillsRaw.entries()) {
    const skill = parsePluginSkill(entry, toolIds, `${path}.skills[${index}]`);
    if (skillIds.has(skill.id)) throw new InvalidSpecError(`${path}.skills 包含重复 id ${skill.id}。`);
    skillIds.add(skill.id);
    skills.push(skill);
  }
  return { tools, hooks, skills, state: parsePluginState(raw.state, `${path}.state`) };
}

function parsePluginState(raw: unknown, path: string): PluginStateDeclaration {
  if (raw === undefined) return { version: '1', accountShared: false };
  const value = object(raw, path);
  exactKeys(value, ['version', 'accountShared'], path);
  if (typeof value.version !== 'string' || !ID.test(value.version)) fail(`${path}.version`, `必须匹配 ${ID}`);
  if (value.accountShared !== undefined && typeof value.accountShared !== 'boolean') {
    fail(`${path}.accountShared`, '必须是布尔值');
  }
  return { version: value.version, accountShared: value.accountShared === true };
}

function parsePluginTool(raw: unknown, path: string): PluginToolDeclaration {
  const value = object(raw, path);
  exactKeys(value, ['id', 'label', 'description', 'inputSchema', 'effect', 'capability', 'timeoutMs', 'maxArgumentBytes', 'maxResultBytes'], path);
  const id = typeof value.id === 'string' && ID.test(value.id)
    ? value.id
    : fail(`${path}.id`, `必须匹配 ${ID}`);
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > EXTENSION_LIMITS.maxDescription) {
    fail(`${path}.description`, `必须是不超过 ${EXTENSION_LIMITS.maxDescription} 字符的非空文本`);
  }
  if (value.label !== undefined && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200)) {
    fail(`${path}.label`, '必须是不超过 200 字符的非空文本');
  }
  const inputSchema = validateToolInputSchema(value.inputSchema, `${path}.inputSchema`);
  let effect: ToolEffect = 'read';
  if (value.effect !== undefined) {
    if (value.effect !== 'read' && value.effect !== 'action') fail(`${path}.effect`, '必须是 read 或 action');
    effect = value.effect;
  }
  let capability: CapabilityId | undefined;
  if (value.capability !== undefined) {
    if (!isCapabilityId(value.capability)) fail(`${path}.capability`, '不是受支持的能力');
    capability = value.capability;
  }
  return {
    id,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    description: value.description,
    inputSchema,
    effect,
    ...(capability ? { capability } : {}),
    timeoutMs: boundedInt(value.timeoutMs, `${path}.timeoutMs`, EXTENSION_LIMITS.defaultToolTimeoutMs, 100, EXTENSION_LIMITS.maxToolTimeoutMs),
    maxArgumentBytes: boundedInt(
      value.maxArgumentBytes,
      `${path}.maxArgumentBytes`,
      EXTENSION_LIMITS.defaultToolArgumentBytes,
      1024,
      EXTENSION_LIMITS.maxToolArgumentBytes
    ),
    maxResultBytes: boundedInt(
      value.maxResultBytes,
      `${path}.maxResultBytes`,
      EXTENSION_LIMITS.maxToolResultBytes,
      512,
      EXTENSION_LIMITS.maxToolResultBytes
    )
  };
}

function parsePluginHook(raw: unknown, path: string): PluginHookDeclaration {
  const value = object(raw, path);
  exactKeys(value, ['name', 'timeoutMs'], path);
  if (value.name !== 'beforeContext' && value.name !== 'afterTurn') {
    fail(`${path}.name`, '必须是 beforeContext 或 afterTurn');
  }
  return {
    name: value.name,
    timeoutMs: boundedInt(value.timeoutMs, `${path}.timeoutMs`, EXTENSION_LIMITS.defaultHookTimeoutMs, 50, EXTENSION_LIMITS.maxHookTimeoutMs)
  };
}

function parsePluginSkill(raw: unknown, declaredTools: Set<string>, path: string): PluginSkillDeclaration {
  const value = object(raw, path);
  exactKeys(value, ['id', 'name', 'description', 'instructions', 'tools', 'requires', 'kinds', 'peers'], path);
  const id = typeof value.id === 'string' && ID.test(value.id) ? value.id : fail(`${path}.id`, `必须匹配 ${ID}`);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) fail(`${path}.name`, '必须是不超过 200 字符的非空文本');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > EXTENSION_LIMITS.maxSkillDescription)) {
    fail(`${path}.description`, `必须是不超过 ${EXTENSION_LIMITS.maxSkillDescription} 字符的文本`);
  }
  if (typeof value.instructions !== 'string' || !value.instructions.trim() || value.instructions.length > EXTENSION_LIMITS.maxSkillInstructions) {
    fail(`${path}.instructions`, `必须是不超过 ${EXTENSION_LIMITS.maxSkillInstructions} 字符的非空文本`);
  }
  if (!Array.isArray(value.tools) || value.tools.length > EXTENSION_LIMITS.maxSkillTools) {
    fail(`${path}.tools`, `必须是最多 ${EXTENSION_LIMITS.maxSkillTools} 项的数组`);
  }
  const tools: string[] = [];
  for (const entry of value.tools) {
    const toolId = resolvePluginToolReference(entry, declaredTools, path);
    if (!tools.includes(toolId)) tools.push(toolId);
  }
  const requires = parseCapabilities(value.requires, `${path}.requires`);
  const kinds = parseKinds(value.kinds, `${path}.kinds`);
  const peers = parsePeers(value.peers, `${path}.peers`);
  return {
    id,
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    instructions: value.instructions,
    tools,
    ...(requires.length > 0 ? { requires } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(peers.length > 0 ? { peers } : {})
  };
}

function resolvePluginToolReference(raw: unknown, declaredTools: Set<string>, path: string): string {
  if (typeof raw !== 'string') fail(`${path}.tools`, '工具引用必须是字符串');
  // Local ids stay local until catalog resolution, because the manifest does not know whether the
  // artifact will be installed as public or private.
  if (declaredTools.has(raw)) return raw;
  if (isToolId(raw) && raw.startsWith('builtin.')) return raw;
  fail(`${path}.tools`, `工具 ${raw} 未在本插件中声明，也不是受支持的内置工具`);
}

function parseCapabilities(raw: unknown, path: string): CapabilityId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, '必须是数组');
  const result: CapabilityId[] = [];
  for (const entry of raw) {
    if (!isCapabilityId(entry)) fail(path, `不支持的能力 ${String(entry)}`);
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function parseKinds(raw: unknown, path: string): ChatKind[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, '必须是数组');
  const result: ChatKind[] = [];
  for (const entry of raw) {
    if (entry !== 'private' && entry !== 'group') fail(path, `无效的聊天类型 ${String(entry)}`);
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function parsePeers(raw: unknown, path: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(path, '必须是数组');
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !ID.test(entry)) fail(path, `无效的 peer ${String(entry)}`);
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, '不受支持');
  }
}

function boundedInt(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `必须是 ${min} 到 ${max} 的整数`);
  }
  return value as number;
}

function fail(path: string, message: string): never {
  throw new InvalidSpecError(`${path}: ${message}`);
}
