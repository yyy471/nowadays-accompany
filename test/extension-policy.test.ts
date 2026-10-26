import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionPolicyService } from '../src/application/extensions/extension-policy-service.js';
import type { ResolvedPlugin, ResolvedProfile } from '../src/artifacts/types.js';
import { registerBuiltInAgentTools } from '../src/agent/engine.js';
import { ExtensionRegistry, SkillRuntime } from '../src/extensions/registry.js';
import { resolveExtensionSwitch } from '../src/extensions/policy.js';
import { ConfigStore } from '../src/providers/config-store.js';
import { PolicyService } from '../src/policy/policy.js';
import { ProviderRouter } from '../src/providers/router.js';
import { FakeProviderAdapter } from '../src/providers/adapters/fake.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { silentLogger } from '../src/core/logger.js';
import { parseAccountPolicy } from '../src/providers/types.js';
import {
  accountPolicy,
  bind,
  fakeMediaProvider,
  fakeProvider,
  writePhase1Config
} from './phase1-helpers.js';
import type { ConversationRef } from '../src/routing/identity.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const imageTool = 'builtin.image.generate';
const echoTool = 'builtin.echo';

async function loadConfig(policy: Record<string, unknown>, skills: Array<Record<string, unknown>> = []): Promise<{ root: string; config: ConfigStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-ext-policy-'));
  roots.push(root);
  await writePhase1Config(root, {
    providers: [fakeProvider('chat'), fakeMediaProvider('media')],
    accountPolicies: {
      '10001': accountPolicy({
        allowedProviders: ['chat', 'media'],
        bindings: {
          chat: bind('chat', 'text-model'),
          'image.generate': bind('media', 'image-model')
        },
        ...policy
      })
    },
    skills
  });
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  return { root, config };
}

function conversation(kind: 'private' | 'group' = 'private', peerId = '42'): ConversationRef {
  return { accountId: '10001', kind, peerId };
}

function pluginProfile(revision = 'p1'): ResolvedProfile {
  const plugin: ResolvedPlugin = {
    ref: { source: 'public', id: 'demo', revision: 'r1' },
    manifest: {
      id: 'demo',
      kind: 'plugin',
      revision: 'r1',
      name: 'Demo',
      entry: 'index.mjs',
      apiVersion: 1,
      tools: [{
        id: 'lookup',
        description: 'Look up deterministic local data.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false
        },
        effect: 'read',
        timeoutMs: 30_000,
        maxArgumentBytes: 16 * 1024,
        maxResultBytes: 8 * 1024
      }],
      hooks: [{ name: 'beforeContext', timeoutMs: 500 }],
      skills: [{
        id: 'helper',
        name: 'Helper',
        instructions: 'Use lookup for deterministic data.',
        tools: ['lookup']
      }]
    },
    dir: path.join(os.tmpdir(), 'demo-plugin'),
    entry: path.join(os.tmpdir(), 'demo-plugin', 'index.mjs'),
    apiVersion: 1,
    config: {}
  };
  return { accountId: '10001', revision, plugins: [plugin] };
}

function registry(): ExtensionRegistry {
  const result = new ExtensionRegistry();
  registerBuiltInAgentTools(result);
  result.registerTool({
    id: echoTool,
    name: 'echo_tool',
    description: 'Echo a bounded value.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false }
  });
  return result;
}

describe('extension switch resolution', () => {
  it('applies account → kind → conversation precedence with inherit fallback', () => {
    const policy = parseAccountPolicy(accountPolicy({
      enabledTools: [imageTool],
      extensions: {
        defaults: { tools: { [imageTool]: 'on' } },
        byKind: { group: { tools: { [imageTool]: 'off' } } },
        byConversation: { 'group/42': { tools: { [imageTool]: 'on' } } }
      }
    }), 'test.policy');

    expect(resolveExtensionSwitch(policy, conversation(), 'tools', imageTool, 'off')).toEqual({ value: 'on', source: 'account' });
    expect(resolveExtensionSwitch(policy, conversation('group', '43'), 'tools', imageTool, 'on')).toEqual({ value: 'off', source: 'kind' });
    expect(resolveExtensionSwitch(policy, conversation('group', '42'), 'tools', imageTool, 'off')).toEqual({ value: 'on', source: 'conversation' });
    expect(resolveExtensionSwitch(policy, conversation(), 'tools', echoTool, 'off')).toEqual({ value: 'off', source: 'default' });
  });

  it('migrates legacy skill enabled/disabled lists into extension switches', async () => {
    const parsed = parseAccountPolicy(accountPolicy({
      skills: {
        enabled: ['draw'],
        disabled: ['old'],
        definitions: [{ id: 'private', name: 'Private', instructions: 'Private only.', tools: [] }]
      }
    }), 'test.legacy');
    expect(parsed.skills).toEqual({
      definitions: [{ id: 'private', name: 'Private', instructions: 'Private only.', tools: [] }]
    });
    expect(parsed.extensions?.defaults.skills).toEqual({ draw: 'on', old: 'off' });

    const { config } = await loadConfig({}, [
      { id: 'draw', name: 'Draw', instructions: 'Draw.', tools: [] },
      { id: 'old', name: 'Old', instructions: 'Old.', tools: [] }
    ]);
    await config.setAccountPolicy('10001', parsed);
    const persisted = JSON.parse(await fs.readFile(config.filePath, 'utf8')) as {
      accountPolicies: Record<string, { skills?: Record<string, unknown>; extensions?: { defaults?: { skills?: Record<string, string> } } }>;
    };
    expect(persisted.accountPolicies['10001']?.skills).toEqual({
      definitions: [{ id: 'private', name: 'Private', instructions: 'Private only.', tools: [] }]
    });
    expect(persisted.accountPolicies['10001']?.extensions?.defaults?.skills).toEqual({ draw: 'on', old: 'off' });
  });

  it('migrates legacy top-level tool authorization into the extension subtree', () => {
    const parsed = parseAccountPolicy(accountPolicy({
      enabledTools: [imageTool, echoTool],
      extensions: { defaults: { tools: { [imageTool]: 'off' } } }
    }), 'test.tools');
    expect(parsed).not.toHaveProperty('enabledTools');
    expect(parsed.extensions).toMatchObject({
      authorizedTools: [imageTool, echoTool],
      defaults: { tools: { [imageTool]: 'off' } }
    });

    expect(() => parseAccountPolicy(accountPolicy({
      enabledTools: [imageTool],
      extensions: { authorizedTools: [echoTool] }
    }), 'test.dual')).toThrow(/cannot both be set/);
  });

  it('keeps SkillRuntime behavior while reading the single switch source', async () => {
    const { config } = await loadConfig(
      { skills: { disabled: ['old'] } },
      [
        { id: 'draw', name: 'Draw', instructions: 'Draw.', tools: [] },
        { id: 'old', name: 'Old', instructions: 'Old.', tools: [] }
      ]
    );
    const parsed = config.accountPolicy('10001')!;
    expect(parsed.skills).toBeUndefined();
    expect(parsed.extensions?.defaults.skills).toEqual({ old: 'off' });
    const runtime = new SkillRuntime(() => config.snapshot().skills);
    const policy = new PolicyService(config).resolve('10001', conversation());
    const resolution = runtime.resolve(policy, () => true, new Set());
    expect(resolution.available.map((skill) => skill.id)).toEqual(['draw']);
    expect(resolution.unavailable.find((skill) => skill.id === 'old')).toMatchObject({
      available: false,
      reason: 'skill_disabled'
    });
  });
});

describe('tool hard authorization and run switches', () => {
  it('requires explicit authorization even for tools without a capability', async () => {
    const { config } = await loadConfig({});
    const extensions = registry();
    const router = new ProviderRouter({
      config,
      policy: new PolicyService(config),
      skills: new SkillRuntime(() => config.snapshot().skills),
      extensions,
      vault: new MemoryCredentialVault(),
      adapters: [],
      logger: silentLogger()
    });
    expect(router.availableTools('10001', conversation())).toEqual([]);

    const { config: authorized } = await loadConfig({ enabledTools: [echoTool] });
    const router2 = new ProviderRouter({
      config: authorized,
      policy: new PolicyService(authorized),
      skills: new SkillRuntime(() => authorized.snapshot().skills),
      extensions: registry(),
      vault: new MemoryCredentialVault(),
      adapters: [],
      logger: silentLogger()
    });
    expect(router2.availableTools('10001', conversation()).map((tool) => tool.id)).toEqual([echoTool]);
  });

  it('applies tool run switches after hard authorization', async () => {
    const { config } = await loadConfig({
      enabledTools: [imageTool],
      extensions: {
        defaults: { tools: { [imageTool]: 'off' } },
        byKind: { group: { tools: { [imageTool]: 'on' } } },
        byConversation: { 'group/42': { tools: { [imageTool]: 'off' } } }
      }
    });
    const router = new ProviderRouter({
      config,
      policy: new PolicyService(config),
      skills: new SkillRuntime(() => config.snapshot().skills),
      extensions: registry(),
      vault: new MemoryCredentialVault(),
      adapters: [new FakeProviderAdapter()],
      logger: silentLogger()
    });
    expect(router.availableTools('10001', conversation()).map((tool) => tool.id)).toEqual([]);
    expect(router.availableTools('10001', conversation('group', '43')).map((tool) => tool.id)).toEqual([imageTool]);
    expect(router.availableTools('10001', conversation('group', '42')).map((tool) => tool.id)).toEqual([]);
  });
});

const pluginKey = 'public/plugin/demo';
const pluginTool = `${pluginKey}/lookup`;
const pluginSkill = `${pluginKey}/skill/helper`;

function readyPluginRegistry(withHandler = true): ExtensionRegistry {
  const extensions = registry();
  if (withHandler) {
    extensions.registerTool({
      id: pluginTool,
      description: 'Look up deterministic local data.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      }
    });
  }
  return extensions;
}

function serviceFor(
  config: ConfigStore,
  extensions: ExtensionRegistry,
  readyPlugins?: ReadonlySet<string>,
  readyTools?: ReadonlySet<string>
): ExtensionPolicyService {
  return new ExtensionPolicyService({
    config,
    registry: extensions,
    profiles: async () => pluginProfile(),
    ...(readyPlugins ? { readyPlugins: () => readyPlugins } : {}),
    ...(readyTools ? { readyTools: () => readyTools } : {})
  });
}

describe('effective extension state', () => {
  it('keeps plugin tools, hooks and Skills off until their scope is explicitly enabled', async () => {
    const { config } = await loadConfig({
      enabledTools: [pluginTool],
      extensions: {
        defaults: { plugins: { [pluginKey]: 'on' } },
        byKind: {
          group: {
            tools: { [pluginTool]: 'on' },
            skills: { [pluginSkill]: 'on' }
          }
        },
        byConversation: { 'group/42': { plugins: { [pluginKey]: 'off' } } }
      }
    });
    const service = serviceFor(config, readyPluginRegistry(), new Set([pluginKey]), new Set([pluginTool]));

    const privateState = await service.effective('10001', conversation());
    expect(privateState.tools.find((entry) => entry.tool.id === pluginTool)).toMatchObject({
      enabled: false,
      authorized: true,
      issues: [{ code: 'switch_off' }]
    });
    expect(privateState.skills.find((entry) => entry.skill.id === pluginSkill)).toMatchObject({
      enabled: false,
      issues: [
        { code: 'switch_off' },
        { code: 'skill_tool_unavailable', detail: pluginTool }
      ]
    });
    expect(privateState.hooks.find((entry) => entry.hook.pluginKey === pluginKey)).toMatchObject({ enabled: true });

    const groupState = await service.effective('10001', conversation('group', '43'));
    expect(groupState.tools.find((entry) => entry.tool.id === pluginTool)).toMatchObject({ enabled: true, issues: [] });
    expect(groupState.skills.find((entry) => entry.skill.id === pluginSkill)).toMatchObject({ enabled: true, issues: [] });

    const disabledState = await service.effective('10001', conversation('group', '42'));
    expect(disabledState.tools.find((entry) => entry.tool.id === pluginTool)?.issues).toEqual([
      { code: 'plugin_switch_off', detail: pluginKey }
    ]);
    expect(disabledState.skills.find((entry) => entry.skill.id === pluginSkill)?.issues).toEqual([
      { code: 'plugin_switch_off', detail: pluginKey },
      { code: 'skill_tool_unavailable', detail: pluginTool }
    ]);
    expect(disabledState.hooks.find((entry) => entry.hook.pluginKey === pluginKey)?.issues).toEqual([
      { code: 'plugin_switch_off', detail: pluginKey }
    ]);
  });

  it('reports handshake, authorization and capability reasons without bypassing a hard stop', async () => {
    const { config } = await loadConfig({
      enabledTools: [imageTool],
      extensions: {
        defaults: {
          plugins: { [pluginKey]: 'on' },
          tools: { [pluginTool]: 'on', [imageTool]: 'on' }
        }
      }
    });
    const unready = serviceFor(config, readyPluginRegistry(false), new Set([pluginKey]));
    const before = await unready.effective('10001', conversation(), () => false);
    expect(before.tools.find((entry) => entry.tool.id === pluginTool)?.issues).toEqual([
      { code: 'handler_not_ready' },
      { code: 'unauthorized' }
    ]);
    expect(before.tools.find((entry) => entry.tool.id === imageTool)?.issues).toEqual([
      { code: 'capability_unavailable', detail: 'image.generate' }
    ]);

    const ready = serviceFor(config, readyPluginRegistry(), new Set([pluginKey]), new Set([pluginTool]));
    const afterHandler = await ready.effective('10001', conversation(), () => true);
    expect(afterHandler.tools.find((entry) => entry.tool.id === pluginTool)?.issues).toEqual([
      { code: 'unauthorized' }
    ]);
    expect(afterHandler.tools.find((entry) => entry.tool.id === imageTool)?.enabled).toBe(true);
  });

  it('keeps user Skill defaults and reports dependency failures', async () => {
    const { config } = await loadConfig(
      {
        enabledTools: [imageTool],
        extensions: { defaults: { tools: { [imageTool]: 'on' } } }
      },
      [
        { id: 'dependent', name: 'Dependent', instructions: 'Needs the lookup tool.', tools: [pluginTool] },
        { id: 'visual', name: 'Visual', instructions: 'Needs image generation.', tools: [], requires: ['image.generate'] }
      ]
    );
    const service = serviceFor(config, readyPluginRegistry(), new Set([pluginKey]), new Set([pluginTool]));
    const state = await service.effective('10001', conversation(), () => false);
    expect(state.skills.find((entry) => entry.skill.id === 'dependent')).toMatchObject({
      enabled: false,
      unavailableTools: [pluginTool],
      issues: [{ code: 'skill_tool_unavailable', detail: pluginTool }]
    });
    expect(state.skills.find((entry) => entry.skill.id === 'visual')?.issues).toEqual([
      { code: 'requires_unavailable', detail: 'image.generate' }
    ]);
  });

  it('applies the same plugin default to router-visible tools', async () => {
    const { config } = await loadConfig({ enabledTools: [pluginTool] });
    const off = new ProviderRouter({
      config,
      policy: new PolicyService(config),
      skills: new SkillRuntime(() => config.snapshot().skills),
      extensions: readyPluginRegistry(),
      vault: new MemoryCredentialVault(),
      adapters: [],
      logger: silentLogger()
    });
    expect(off.availableTools('10001', conversation())).toEqual([]);

    const { config: enabled } = await loadConfig({
      enabledTools: [pluginTool],
      extensions: { defaults: { plugins: { [pluginKey]: 'on' }, tools: { [pluginTool]: 'on' } } }
    });
    const on = new ProviderRouter({
      config: enabled,
      policy: new PolicyService(enabled),
      skills: new SkillRuntime(() => enabled.snapshot().skills),
      extensions: readyPluginRegistry(),
      vault: new MemoryCredentialVault(),
      adapters: [],
      logger: silentLogger()
    });
    expect(on.availableTools('10001', conversation()).map((tool) => tool.id)).toEqual([pluginTool]);
  });

  it('defaults plugin scopes off, allows narrower opt-in, and keeps uninstalled plugins unavailable', async () => {
    const { config } = await loadConfig({ enabledTools: [pluginTool] });
    const service = serviceFor(config, readyPluginRegistry(), new Set([pluginKey]), new Set([pluginTool]));
    const defaultOff = await service.effective('10001', conversation());
    expect(defaultOff.hooks[0]).toMatchObject({ enabled: false, issues: [{ code: 'plugin_switch_off' }] });

    const { config: scoped } = await loadConfig({
      enabledTools: [pluginTool],
      extensions: {
        byConversation: {
          'private/42': {
            plugins: { [pluginKey]: 'on' },
            tools: { [pluginTool]: 'on' }
          }
        }
      }
    });
    const scopedService = serviceFor(scoped, readyPluginRegistry(), new Set([pluginKey]), new Set([pluginTool]));
    const scopedState = await scopedService.effective('10001', conversation());
    expect(scopedState.hooks[0]?.enabled).toBe(true);
    expect(scopedState.tools.find((entry) => entry.tool.id === pluginTool)?.enabled).toBe(true);

    const { config: hardOff } = await loadConfig({
      enabledTools: [pluginTool],
      extensions: {
        defaults: {
          plugins: { [pluginKey]: 'off' },
          tools: { [pluginTool]: 'on' }
        },
        byConversation: {
          'private/42': {
            plugins: { [pluginKey]: 'on' },
            tools: { [pluginTool]: 'on' }
          }
        }
      }
    });
    const accountOffService = serviceFor(hardOff, readyPluginRegistry(), new Set([pluginKey]), new Set([pluginTool]));
    const accountOffState = await accountOffService.effective('10001', conversation());
    expect(accountOffState.hooks[0]?.enabled).toBe(true);
    expect(accountOffState.tools.find((entry) => entry.tool.id === pluginTool)?.enabled).toBe(true);

    const removed = new ExtensionPolicyService({
      config: hardOff,
      registry: readyPluginRegistry(),
      profiles: async () => ({ ...pluginProfile(), plugins: [] }),
      readyPlugins: () => new Set(),
      readyTools: () => new Set()
    });
    const removedView = await removed.read('10001');
    expect(removedView.catalog.plugins).toEqual([]);
    expect(removedView.catalog.tools.some((entry) => entry.id === pluginTool)).toBe(false);
  });
});

describe('extension policy CAS and catalog validation', () => {  it('reads the catalog and commits a localized patch with revision checks', async () => {
    const { config } = await loadConfig(
      { enabledTools: [imageTool] },
      [{ id: 'public-skill', name: 'Public', instructions: 'Public.', tools: [] }]
    );
    const extensions = registry();
    const profiles: ResolvedProfile[] = [pluginProfile()];
    const service = new ExtensionPolicyService({
      config,
      registry: extensions,
      profiles: async () => profiles[0]!
    });
    const before = await service.read('10001');
    expect(before.catalog.plugins.map((plugin) => plugin.key)).toEqual(['public/plugin/demo']);
    expect(before.catalog.tools.find((tool) => tool.id === 'public/plugin/demo/lookup')).toMatchObject({
      handlerReady: false,
      owner: { kind: 'plugin', source: 'public', pluginId: 'demo' }
    });
    expect(before.catalog.skills.find((skill) => skill.id === 'public/plugin/demo/skill/helper')?.tools)
      .toEqual(['public/plugin/demo/lookup']);
    expect(before.catalog.skills.find((skill) => skill.id === 'public-skill')?.source).toBe('public');

    const updated = await service.update('10001', {
      expectedRevision: before.revision,
      expectedProfileRevision: before.profileRevision,
      patch: {
        defaults: {
          tools: { [imageTool]: 'off', [echoTool]: 'on' },
          plugins: { 'public/plugin/demo': 'on' },
          skills: { 'public/plugin/demo/skill/helper': 'on' }
        },
        byKind: { group: { plugins: { 'public/plugin/demo': 'off' } } },
        authorizedTools: [imageTool, echoTool, 'public/plugin/demo/lookup']
      }
    });
    expect(updated.authorizedTools).toEqual([imageTool, echoTool, 'public/plugin/demo/lookup']);
    expect(updated.defaults).toEqual({
      tools: { [imageTool]: 'off', [echoTool]: 'on' },
      plugins: { 'public/plugin/demo': 'on' },
      skills: { 'public/plugin/demo/skill/helper': 'on' }
    });
    expect(updated.byKind.group).toEqual({ plugins: { 'public/plugin/demo': 'off' } });
    expect(updated.revision).not.toBe(before.revision);

    const persisted = config.accountPolicy('10001')!;
    expect(persisted.allowedProviders).toEqual(['chat', 'media']);
    expect(persisted.bindings?.chat).toEqual({ providerId: 'chat', modelId: 'text-model' });
    expect(persisted.extensions?.authorizedTools).toEqual([imageTool, echoTool, 'public/plugin/demo/lookup']);
    expect(persisted.extensions?.defaults.tools).toEqual({ [imageTool]: 'off', [echoTool]: 'on' });

    const persistedFile = JSON.parse(await fs.readFile(config.filePath, 'utf8')) as {
      accountPolicies: Record<string, { enabledTools?: unknown; extensions?: { authorizedTools?: string[] } }>;
    };
    expect(persistedFile.accountPolicies['10001']?.enabledTools).toBeUndefined();
    expect(persistedFile.accountPolicies['10001']?.extensions?.authorizedTools)
      .toEqual([imageTool, echoTool, 'public/plugin/demo/lookup']);

    await expect(service.update('10001', {
      expectedRevision: before.revision,
      patch: { defaults: { tools: { [echoTool]: 'off' } } }
    })).rejects.toMatchObject({ code: 'extension_conflict' });
  });

  it('rejects unknown catalog keys, stale profile revisions and validates handler readiness', async () => {
    const { config } = await loadConfig({}, []);
    const extensions = registry();
    let profile = pluginProfile();
    let readyTools = new Set<string>();
    const service = new ExtensionPolicyService({
      config,
      registry: extensions,
      profiles: async () => profile,
      readyTools: () => readyTools
    });
    const current = await service.read('10001');

    await expect(service.update('10001', {
      expectedRevision: current.revision,
      patch: { defaults: { tools: { 'builtin.missing': 'on' } } }
    })).rejects.toMatchObject({ code: 'invalid_spec' });

    await expect(service.update('10001', {
      expectedRevision: current.revision,
      patch: { authorizedTools: ['builtin.missing'] }
    })).rejects.toMatchObject({ code: 'invalid_spec' });

    await expect(service.update('10001', {
      expectedRevision: current.revision,
      expectedProfileRevision: 'stale-profile',
      patch: {}
    })).rejects.toMatchObject({ code: 'extension_conflict' });

    // A successful worker handshake makes the declared plugin tool ready without changing the declaration.
    readyTools = new Set([pluginTool]);
    const ready = await service.read('10001');
    expect(ready.catalog.tools.find((tool) => tool.id === pluginTool)?.handlerReady).toBe(true);
    expect(ready.catalog.tools.find((tool) => tool.id === pluginTool)?.name).toBe('p_public_demo_lookup');
    expect(ready.catalog.tools.find((tool) => tool.id === pluginTool)?.inputSchema).toMatchObject({ type: 'object' });

    profile = pluginProfile('p2');
    const afterProfile = await service.read('10001');
    await expect(service.update('10001', {
      expectedRevision: current.revision,
      expectedProfileRevision: current.profileRevision,
      patch: {}
    })).rejects.toMatchObject({ code: 'extension_conflict' });
    expect(afterProfile.profileRevision).toBe('p2');
  });

  it('rechecks the profile revision at the config commit boundary', async () => {
    const { config } = await loadConfig({});
    let calls = 0;
    const service = new ExtensionPolicyService({
      config,
      registry: registry(),
      profiles: async () => pluginProfile(++calls <= 2 ? 'p1' : 'p2')
    });
    const before = await service.read('10001');
    expect(before.profileRevision).toBe('p1');

    await expect(service.update('10001', {
      expectedRevision: before.revision,
      expectedProfileRevision: before.profileRevision,
      patch: { defaults: { tools: { [echoTool]: 'on' } } }
    })).rejects.toMatchObject({ code: 'extension_conflict' });
    expect(config.accountPolicy('10001')?.extensions).toBeUndefined();
  });

  it('removes switch overrides with inherit and drops an empty extension subtree', async () => {
    const { config } = await loadConfig({
      extensions: { defaults: { tools: { [imageTool]: 'off' } } }
    });
    const service = new ExtensionPolicyService({
      config,
      registry: registry(),
      profiles: async () => ({ accountId: '10001', revision: 'p1', plugins: [] })
    });
    const before = await service.read('10001');
    const cleared = await service.update('10001', {
      expectedRevision: before.revision,
      patch: { defaults: { tools: { [imageTool]: 'inherit' } } }
    });
    expect(cleared.defaults).toEqual({});
    expect(config.accountPolicy('10001')?.extensions).toBeUndefined();
  });
});
