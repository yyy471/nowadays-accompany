import crypto from 'node:crypto';
import type { ResolvedPlugin, ResolvedProfile } from '../artifacts/types.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { ChatKind } from '../routing/identity.js';
import type { ExtensionRegistry } from './registry.js';
import type { RegisteredToolDefinition, SkillConfig } from './types.js';
import { stableStringify } from '../providers/types.js';
import {
  pluginKey,
  pluginModelToolName,
  pluginSkillId,
  pluginToolId,
  type PluginHookName,
  type PluginSource,
  type ToolEffect,
  type ToolOwner
} from './contracts.js';

export type CatalogSkillSource = 'public' | 'private' | 'plugin';

export interface CatalogTool {
  id: string;
  name: string;
  label?: string;
  description: string;
  owner: ToolOwner;
  effect: ToolEffect;
  inputSchema: Record<string, unknown>;
  capability?: CapabilityId;
  timeoutMs: number;
  maxArgumentBytes: number;
  maxResultBytes: number;
  handlerReady: boolean;
  pluginKey?: string;
}

export interface CatalogHook {
  name: PluginHookName;
  timeoutMs: number;
  pluginKey: string;
  handlerReady: boolean;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  tools: string[];
  requires?: CapabilityId[];
  kinds?: ChatKind[];
  peers?: string[];
  source: CatalogSkillSource;
  pluginKey?: string;
  /** Set on a private definition that replaces a public definition with the same id. */
  overrides?: 'public';
  /** User definitions default on unless their definition disables it; plugin Skills need an explicit scope. */
  defaultEnabled: boolean;
}

export interface CatalogPlugin {
  key: string;
  source: PluginSource;
  id: string;
  revision: string;
  /** Hash only; config values never leave the resolved profile boundary. */
  configDigest: string;
  name?: string;
  tools: string[];
  hooks: PluginHookName[];
  skills: string[];
  stateVersion: string;
  accountSharedState: boolean;
}

export interface ExtensionCatalog {
  plugins: CatalogPlugin[];
  tools: CatalogTool[];
  hooks: CatalogHook[];
  skills: CatalogSkill[];
}

export interface BuildExtensionCatalogInput {
  profile: ResolvedProfile;
  registry: ExtensionRegistry;
  /** Global Skill definitions from ConfigStore. */
  publicSkills: SkillConfig[];
  /** Account-private definitions parsed under the account policy. */
  privateSkills: SkillConfig[];
  /** Plugin keys whose worker completed its declaration/handler handshake. */
  readyPlugins?: ReadonlySet<string>;
  /** Full plugin tool ids whose worker handshake found a handler. */
  readyTools?: ReadonlySet<string>;
}

/**
 * Builds the single catalog consumed by policy validation and effective resolution. Declarations
 * without a matching runtime handler stay visible but are never marked ready.
 */
export function buildExtensionCatalog(input: BuildExtensionCatalogInput): ExtensionCatalog {
  const tools: CatalogTool[] = [];
  const hooks: CatalogHook[] = [];
  const skills: CatalogSkill[] = [];
  const plugins: CatalogPlugin[] = [];
  const builtins = input.registry.listTools().filter((tool) => tool.owner.kind === 'builtin');
  for (const tool of builtins) {
    tools.push({
      id: tool.id,
      name: tool.name,
      ...(tool.label ? { label: tool.label } : {}),
      description: tool.description,
      owner: tool.owner,
      effect: tool.effect,
      inputSchema: tool.inputSchema,
      ...(tool.capability ? { capability: tool.capability } : {}),
      timeoutMs: tool.timeoutMs,
      maxArgumentBytes: tool.maxArgumentBytes,
      maxResultBytes: tool.maxResultBytes,
      handlerReady: true
    });
  }

  for (const plugin of input.profile.plugins) {
    plugins.push(buildPlugin(plugin, input.readyPlugins, input.readyTools, tools, hooks, skills));
  }

  const definitions = new Map<string, { skill: SkillConfig; source: 'public' | 'private' }>();
  const publicIds = new Set(input.publicSkills.map((skill) => skill.id));
  for (const skill of input.publicSkills) definitions.set(skill.id, { skill, source: 'public' });
  for (const skill of input.privateSkills) definitions.set(skill.id, { skill, source: 'private' });
  for (const { skill, source } of definitions.values()) {
    skills.push({
      id: skill.id,
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      instructions: skill.instructions,
      tools: [...skill.tools],
      ...(skill.requires?.length ? { requires: [...skill.requires] } : {}),
      ...(skill.kinds?.length ? { kinds: [...skill.kinds] } : {}),
      ...(skill.peers?.length ? { peers: [...skill.peers] } : {}),
      source,
      ...(source === 'private' && publicIds.has(skill.id) ? { overrides: 'public' as const } : {}),
      defaultEnabled: skill.enabled !== false
    });
  }

  return { plugins, tools, hooks, skills };
}

export function catalogToolDefinition(tool: CatalogTool): RegisteredToolDefinition {
  return {
    id: tool.id,
    name: tool.name,
    ...(tool.label ? { label: tool.label } : {}),
    description: tool.description,
    ...(tool.capability ? { capability: tool.capability } : {}),
    inputSchema: tool.inputSchema,
    owner: tool.owner,
    effect: tool.effect,
    timeoutMs: tool.timeoutMs,
    maxArgumentBytes: tool.maxArgumentBytes,
    maxResultBytes: tool.maxResultBytes
  };
}

function buildPlugin(
  plugin: ResolvedPlugin,
  readyPlugins: ReadonlySet<string> | undefined,
  readyTools: ReadonlySet<string> | undefined,
  tools: CatalogTool[],
  hooks: CatalogHook[],
  skills: CatalogSkill[]
): CatalogPlugin {
  const source = plugin.ref.source as PluginSource;
  const key = pluginKey(source, plugin.ref.id);
  const ready = readyPlugins?.has(key) === true;
  const declaredTools = plugin.manifest.tools ?? [];
  const declaredHooks = plugin.manifest.hooks ?? [];
  const declaredSkills = plugin.manifest.skills ?? [];
  const state = plugin.manifest.state ?? { version: '1', accountShared: false };
  const toolIds = new Set<string>();
  const toolNames: string[] = [];
  for (const declaration of declaredTools) {
    const id = pluginToolId(source, plugin.ref.id, declaration.id);
    toolIds.add(id);
    if (toolNames.includes(id)) continue;
    toolNames.push(id);
    tools.push({
      id,
      name: pluginModelToolName({ kind: 'plugin', source, pluginId: plugin.ref.id, toolId: declaration.id, id }),
      ...(declaration.label ? { label: declaration.label } : {}),
      description: declaration.description,
      owner: { kind: 'plugin', source, pluginId: plugin.ref.id },
      effect: declaration.effect,
      inputSchema: declaration.inputSchema,
      ...(declaration.capability ? { capability: declaration.capability } : {}),
      timeoutMs: declaration.timeoutMs,
      maxArgumentBytes: declaration.maxArgumentBytes,
      maxResultBytes: declaration.maxResultBytes,
      handlerReady: readyTools?.has(id) === true,
      pluginKey: key
    });
  }
  for (const declaration of declaredHooks) {
    hooks.push({ name: declaration.name, timeoutMs: declaration.timeoutMs, pluginKey: key, handlerReady: ready });
  }
  for (const declaration of declaredSkills) {
    skills.push({
      id: pluginSkillId(source, plugin.ref.id, declaration.id),
      name: declaration.name,
      ...(declaration.description ? { description: declaration.description } : {}),
      instructions: declaration.instructions,
      tools: declaration.tools.map((tool) => toolIds.has(pluginToolId(source, plugin.ref.id, tool))
        ? pluginToolId(source, plugin.ref.id, tool)
        : tool),
      ...(declaration.requires?.length ? { requires: [...declaration.requires] } : {}),
      ...(declaration.kinds?.length ? { kinds: [...declaration.kinds] } : {}),
      ...(declaration.peers?.length ? { peers: [...declaration.peers] } : {}),
      source: 'plugin',
      pluginKey: key,
      defaultEnabled: false
    });
  }
  return {
    key,
    source,
    id: plugin.ref.id,
    revision: plugin.ref.revision,
    configDigest: crypto.createHash('sha256').update(stableStringify(plugin.config)).digest('hex').slice(0, 32),
    ...(plugin.manifest.name ? { name: plugin.manifest.name } : {}),
    tools: toolNames,
    hooks: declaredHooks.map((hook) => hook.name),
    skills: declaredSkills.map((skill) => pluginSkillId(source, plugin.ref.id, skill.id)),
    stateVersion: state.version,
    accountSharedState: state.accountShared
  };
}
