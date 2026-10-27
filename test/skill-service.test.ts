import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionPolicyService } from '../src/application/extensions/extension-policy-service.js';
import { ExtensionToolService } from '../src/application/extensions/extension-tool-service.js';
import { SkillService } from '../src/application/extensions/skill-service.js';
import type { ResolvedPlugin, ResolvedProfile } from '../src/artifacts/types.js';
import { registerBuiltInAgentTools } from '../src/agent/engine.js';
import { silentLogger } from '../src/core/logger.js';
import { pluginKey, pluginSkillId, pluginToolId, type PluginSource } from '../src/extensions/contracts.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { selectSkillsForPrompt } from '../src/extensions/skill-selection.js';
import { ConfigStore } from '../src/providers/config-store.js';
import type { CapabilityId } from '../src/policy/capabilities.js';
import type { ConversationRef } from '../src/routing/identity.js';
import {
  accountPolicy,
  bind,
  fakeMediaProvider,
  fakeProvider,
  writePhase1Config
} from './phase1-helpers.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const ACCOUNT = '10001';

function conversation(accountId = ACCOUNT, kind: 'private' | 'group' = 'private', peerId = '42'): ConversationRef {
  return { accountId, kind, peerId };
}

function definition(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id.toUpperCase(), instructions: `INSTRUCTION:${id}`, tools: [], ...overrides };
}

interface SetupOptions {
  publicSkills?: Array<Record<string, unknown>>;
  accountPolicies?: Record<string, Record<string, unknown>>;
  profile?: (accountId: string) => ResolvedProfile;
  capability?: (capability: CapabilityId) => boolean;
}

async function setup(options: SetupOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-skill-service-'));
  roots.push(root);
  await writePhase1Config(root, {
    providers: [fakeProvider('chat'), fakeMediaProvider('media')],
    accountPolicies: options.accountPolicies ?? {},
    skills: options.publicSkills ?? []
  });
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  const registry = new ExtensionRegistry();
  registerBuiltInAgentTools(registry);
  const profile = options.profile ?? ((accountId: string): ResolvedProfile => ({ accountId, revision: 'profile-1', plugins: [] }));
  const policy = new ExtensionPolicyService({
    config,
    registry,
    profiles: async (accountId) => profile(accountId),
    readyPlugins: (accountId) => new Set(profile(accountId).plugins.map((plugin) => pluginKey(plugin.ref.source as PluginSource, plugin.ref.id))),
    readyTools: (accountId) => new Set(profile(accountId).plugins.flatMap((plugin) =>
      (plugin.manifest.tools ?? []).map((tool) => pluginToolId(plugin.ref.source as PluginSource, plugin.ref.id, tool.id))))
  });
  const capability = options.capability ?? (() => true);
  const service = new SkillService({
    config,
    policy,
    capabilityEnabled: () => capability
  });
  return { root, config, registry, policy, service };
}

const PLUGIN_ID = 'demo';
const PLUGIN_KEY = pluginKey('public', PLUGIN_ID);
const PLUGIN_TOOL_ID = pluginToolId('public', PLUGIN_ID, 'lookup');
const PLUGIN_SKILL_ID = pluginSkillId('public', PLUGIN_ID, 'helper');

function pluginProfile(accountId: string): ResolvedProfile {
  const plugin: ResolvedPlugin = {
    ref: { source: 'public', id: PLUGIN_ID, revision: 'r1' },
    manifest: {
      id: PLUGIN_ID,
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
  return { accountId, revision: 'profile-1', plugins: [plugin] };
}

describe('public Skill definitions', () => {
  it('creates, updates, deletes and reloads with a CAS revision', async () => {
    const { config, service } = await setup();
    const empty = service.listPublic();
    expect(empty.skills).toEqual([]);

    const saved = await service.savePublic(definition('draw'), empty.revision);
    expect(saved.skills).toEqual([expect.objectContaining({ id: 'draw', source: 'public' })]);

    await expect(service.savePublic(definition('stale'), empty.revision)).rejects.toMatchObject({ code: 'skill_conflict' });
    expect(service.listPublic().skills.map((skill) => skill.id)).toEqual(['draw']);

    const updated = await service.savePublic(definition('draw', { instructions: 'UPDATED' }), saved.revision);
    expect(updated.skills[0]?.instructions).toBe('UPDATED');

    const reloaded = await ConfigStore.load({ filePath: config.filePath });
    expect(reloaded.snapshot().skills).toEqual([expect.objectContaining({ id: 'draw', instructions: 'UPDATED' })]);

    const impact = service.impact('draw');
    expect(impact).toMatchObject({ skillId: 'draw', exists: true, defaultEnabled: true, defaultScopesAffected: true, accounts: [] });
    const removed = await service.deletePublic('draw', service.listPublic().revision);
    expect(removed.removed).toBe(true);
    expect(removed.impact.exists).toBe(true);
    expect(service.listPublic().skills).toEqual([]);
    await expect(service.deletePublic('draw', service.listPublic().revision)).rejects.toMatchObject({ code: 'skill_not_found' });
  });

  it('rejects definitions over the per-Skill limits', async () => {
    const { service } = await setup();
    const revision = service.listPublic().revision;
    await expect(service.savePublic(definition('long', { instructions: 'x'.repeat(8_001) }), revision))
      .rejects.toThrow(/8000/);
    await expect(service.savePublic(definition('many', { tools: Array.from({ length: 9 }, (_, index) => `tool-${index}`) }), revision))
      .rejects.toThrow(/8/);
    await expect(service.savePublic(definition('named', { name: '名'.repeat(201) }), revision))
      .rejects.toThrow(/200/);
    expect(service.listPublic().skills).toEqual([]);
  });
});

describe('multi-source Skill resolution', () => {
  it('keeps private-overrides-public while plugin Skills stay in their own namespace', async () => {
    const { service } = await setup({
      publicSkills: [definition('shared', { instructions: 'PUBLIC BODY' })],
      accountPolicies: {
        [ACCOUNT]: accountPolicy({
          skills: { definitions: [definition('shared', { instructions: 'PRIVATE BODY' })] },
          extensions: {
            authorizedTools: [PLUGIN_TOOL_ID],
            defaults: {
              plugins: { [PLUGIN_KEY]: 'on' },
              skills: { [PLUGIN_SKILL_ID]: 'on' },
              tools: { [PLUGIN_TOOL_ID]: 'on' }
            }
          }
        })
      },
      profile: pluginProfile
    });
    const preview = await service.preview(ACCOUNT, conversation());
    const shared = preview.skills.find((skill) => skill.id === 'shared');
    expect(shared).toMatchObject({ source: 'private', overrides: 'public', enabled: true, selected: true });
    const plugin = preview.skills.find((skill) => skill.id === PLUGIN_SKILL_ID);
    expect(plugin).toMatchObject({ source: 'plugin', enabled: true, selected: true });
    expect(plugin?.overrides).toBeUndefined();
    expect(preview.included).toEqual(['shared', PLUGIN_SKILL_ID]);

    const privateList = service.listPrivate(ACCOUNT);
    expect(privateList.skills).toEqual([expect.objectContaining({ id: 'shared', source: 'private', overrides: 'public' })]);
    const publicList = service.listPublic();
    expect(publicList.skills).toEqual([expect.objectContaining({ id: 'shared', source: 'public', instructions: 'PUBLIC BODY' })]);
  });

  it('reports missing tool authorization and capabilities without granting them', async () => {
    const { service, policy } = await setup({
      publicSkills: [
        definition('visual', { tools: ['builtin.image.generate'], requires: ['audio.generate'] })
      ],
      capability: (capability) => capability !== 'audio.generate'
    });
    const preview = await service.preview(ACCOUNT, conversation());
    const visual = preview.skills.find((skill) => skill.id === 'visual');
    expect(visual).toMatchObject({ enabled: false, selected: false });
    expect(visual?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['requires_unavailable', 'skill_tool_unavailable'])
    );
    expect(visual?.issues.find((issue) => issue.code === 'requires_unavailable')?.detail).toBe('audio.generate');
    expect(preview.included).toEqual([]);
    expect((await policy.read(ACCOUNT)).authorizedTools).toEqual([]);
  });

  it('intersects definition scope with account kind and conversation switches', async () => {
    const { service } = await setup({
      publicSkills: [definition('scoped', { kinds: ['group'], peers: ['42'] })],
      accountPolicies: {
        [ACCOUNT]: accountPolicy({
          extensions: {
            byKind: { group: { skills: { scoped: 'off' } } },
            byConversation: { 'group/42': { skills: { scoped: 'on' } } }
          }
        })
      }
    });
    const privateScope = await service.preview(ACCOUNT, conversation(ACCOUNT, 'private', '42'));
    expect(privateScope.skills.find((skill) => skill.id === 'scoped')).toMatchObject({ enabled: false, selected: false });
    expect(privateScope.skills.find((skill) => skill.id === 'scoped')?.issues.map((issue) => issue.code)).toContain('kind_scope');

    const groupAllowed = await service.preview(ACCOUNT, conversation(ACCOUNT, 'group', '42'));
    expect(groupAllowed.skills.find((skill) => skill.id === 'scoped')).toMatchObject({ enabled: true, selected: true });

    const groupOther = await service.preview(ACCOUNT, conversation(ACCOUNT, 'group', '43'));
    const other = groupOther.skills.find((skill) => skill.id === 'scoped');
    expect(other?.enabled).toBe(false);
    expect(other?.issues.map((issue) => issue.code)).toContain('peer_scope');
    expect(groupOther.included).toEqual([]);
  });
});

describe('prompt budget selection', () => {
  it('selects private → public → plugin, orders by id and marks scope-limit omissions', async () => {
    const publicSkills = Array.from({ length: 10 }, (_, index) => definition(`s${String(index + 1).padStart(2, '0')}`));
    const { service } = await setup({
      publicSkills,
      accountPolicies: {
        [ACCOUNT]: accountPolicy({ skills: { definitions: [definition('zz-private')] } })
      }
    });
    const preview = await service.preview(ACCOUNT, conversation());
    expect(preview.included).toEqual([
      'zz-private',
      's01', 's02', 's03', 's04', 's05', 's06', 's07'
    ]);
    expect(preview.excluded).toEqual([
      { id: 's08', reason: 'skill_limit' },
      { id: 's09', reason: 'skill_limit' },
      { id: 's10', reason: 'skill_limit' }
    ]);
    expect(preview.skills.find((skill) => skill.id === 's08')).toMatchObject({
      enabled: true,
      selected: false,
      selectionReason: 'skill_limit'
    });
    const again = await service.preview(ACCOUNT, conversation());
    expect(again.included).toEqual(preview.included);
    expect(again.excluded).toEqual(preview.excluded);
  });

  it('caps cumulative instructions at 16000 characters and reports over-long legacy definitions', async () => {
    const body = (character: string) => character.repeat(6_000);
    const { service } = await setup({
      publicSkills: [
        definition('a', { instructions: body('a') }),
        definition('b', { instructions: body('b') }),
        definition('c', { instructions: body('c') })
      ]
    });
    const preview = await service.preview(ACCOUNT, conversation());
    expect(preview.included).toEqual(['a', 'b']);
    expect(preview.instructionsChars).toBe(12_000);
    expect(preview.excluded).toEqual([{ id: 'c', reason: 'instructions_budget' }]);

    const legacy = await setup({
      publicSkills: [
        definition('long-name', { name: 'n'.repeat(201) }),
        definition('too-long', { instructions: 'x'.repeat(8_001) })
      ]
    });
    const legacyPreview = await legacy.service.preview(ACCOUNT, conversation());
    expect(legacyPreview.excluded).toEqual([
      { id: 'long-name', reason: 'name_too_long' },
      { id: 'too-long', reason: 'instructions_too_long' }
    ]);
    expect(legacyPreview.included).toEqual([]);
  });

  it('exposes the shared selector with the same ordering and reasons', () => {
    const selection = selectSkillsForPrompt([
      { id: 'public-b', name: 'Public B', source: 'public', instructions: 'b', tools: [] },
      { id: 'plugin-a', name: 'Plugin A', source: 'plugin', instructions: 'p', tools: [] },
      { id: 'private-c', name: 'Private C', source: 'private', instructions: 'c', tools: [] },
      { id: 'public-a', name: 'Public A', source: 'public', instructions: 'a', tools: [] }
    ]);
    expect(selection.included.map((skill) => skill.id)).toEqual(['private-c', 'public-a', 'public-b', 'plugin-a']);
    const bounded = selectSkillsForPrompt([
      { id: 'a', name: 'A', source: 'public', instructions: 'aaaa', tools: [] },
      { id: 'b', name: 'B', source: 'public', instructions: 'bbbb', tools: [] }
    ], { maxTotalInstructionsChars: 10 });
    expect(bounded.included.map((skill) => skill.id)).toEqual(['a']);
    expect(bounded.excluded).toEqual([{ id: 'b', name: 'B', source: 'public', reason: 'instructions_budget' }]);
    const tooManyTools = selectSkillsForPrompt([
      { id: 'tools', name: 'Tools', source: 'public', instructions: 'x', tools: Array.from({ length: 9 }, (_, index) => `t${index}`) }
    ]);
    expect(tooManyTools.excluded).toEqual([
      { id: 'tools', name: 'Tools', source: 'public', reason: 'too_many_tools' }
    ]);
    const longName = selectSkillsForPrompt([
      { id: 'named', name: 'n'.repeat(201), source: 'public', instructions: 'x', tools: [] }
    ]);
    expect(longName.excluded).toEqual([{ id: 'named', name: 'n'.repeat(201), source: 'public', reason: 'name_too_long' }]);
    // Once the cumulative budget is exhausted, later short entries stay out instead of jumping ahead.
    const monotone = selectSkillsForPrompt([
      { id: 'a', name: 'A', source: 'public', instructions: 'a'.repeat(7_995), tools: [] },
      { id: 'b', name: 'B', source: 'public', instructions: 'b'.repeat(7_995), tools: [] },
      { id: 'c', name: 'C', source: 'public', instructions: 'c', tools: [] }
    ]);
    expect(monotone.included.map((skill) => skill.id)).toEqual(['a']);
    expect(monotone.excluded.map((skill) => `${skill.id}:${skill.reason}`)).toEqual([
      'b:instructions_budget',
      'c:instructions_budget'
    ]);
  });
});

describe('Skill impact, copy and read-only preview', () => {
  it('lists explicit references before deletion and keeps preview free of writes', async () => {
    const { config, service } = await setup({
      publicSkills: [definition('shared', { enabled: false })],
      accountPolicies: {
        '10001': accountPolicy({ extensions: { defaults: { skills: { shared: 'on' } } } }),
        '10002': accountPolicy({ extensions: { defaults: { skills: { shared: 'off' } } } }),
        '10003': accountPolicy({ skills: { definitions: [definition('shared')] } }),
        '10004': accountPolicy({})
      }
    });
    const impact = service.impact('shared');
    expect(impact).toMatchObject({ skillId: 'shared', exists: true, defaultEnabled: false });
    expect(impact.accounts).toEqual([
      { accountId: '10001', privateOverride: false, switches: [{ scope: 'defaults', value: 'on' }] },
      { accountId: '10002', privateOverride: false, switches: [{ scope: 'defaults', value: 'off' }] },
      { accountId: '10003', privateOverride: true, switches: [] }
    ]);

    const filePath = config.filePath;
    const before = { version: config.version, content: await fs.readFile(filePath, 'utf8') };
    const preview = await service.preview('10001', conversation('10001'));
    expect(preview.included).toEqual(['shared']);
    expect(config.version).toBe(before.version);
    expect(await fs.readFile(filePath, 'utf8')).toBe(before.content);

    const withoutSwitch = await service.preview('10004', conversation('10004'));
    expect(withoutSwitch.included).toEqual([]);
  });

  it('invalidates only conversations whose effective Skill set changed', async () => {
    const { root, service, policy } = await setup({
      publicSkills: [definition('shared', { enabled: false })],
      accountPolicies: {
        '10001': accountPolicy({ extensions: { defaults: { skills: { shared: 'on' } } } }),
        '10002': accountPolicy({ extensions: { defaults: { skills: { shared: 'off' } } } }),
        '10004': accountPolicy({})
      }
    });
    const tools = new ExtensionToolService({
      policy,
      accountDir: () => root,
      logger: silentLogger('skill-guard'),
      capabilityEnabled: () => () => true
    });
    try {
      const beforeA = await tools.captureTurn('10001', conversation('10001'));
      const beforeB = await tools.captureTurn('10002', conversation('10002'));
      const beforeC = await tools.captureTurn('10004', conversation('10004'));
      expect(beforeA.skills.map((skill) => skill.id)).toEqual(['shared']);

      await service.savePublic(definition('shared', { enabled: false, instructions: 'CHANGED BODY' }), service.listPublic().revision);

      const afterA = await tools.captureTurn('10001', conversation('10001'));
      const afterB = await tools.captureTurn('10002', conversation('10002'));
      const afterC = await tools.captureTurn('10004', conversation('10004'));
      expect(afterA.token).not.toBe(beforeA.token);
      expect(afterB.token).toBe(beforeB.token);
      expect(afterC.token).toBe(beforeC.token);
    } finally {
      await tools.close();
    }
  });

  it('refuses to copy a legacy public definition that exceeds the save limits', async () => {
    const { service } = await setup({
      publicSkills: [definition('legacy-long', { instructions: 'x'.repeat(8_001) })]
    });
    await expect(service.copyPublicToPrivate(ACCOUNT, 'legacy-long', service.listPrivate(ACCOUNT).revision))
      .rejects.toThrow(/8000/);
    expect(service.listPrivate(ACCOUNT).skills).toEqual([]);
  });

  it('copies a public definition off by default and reveals the fallback after deletion', async () => {
    const { service, policy } = await setup({
      publicSkills: [
        definition('draw', { instructions: 'PUBLIC BODY' }),
        definition('disabled-copy', { enabled: false })
      ]
    });
    const privateEmpty = service.listPrivate(ACCOUNT);
    expect(privateEmpty.skills).toEqual([]);

    const copied = await service.copyPublicToPrivate(ACCOUNT, 'draw', privateEmpty.revision);
    expect(copied).toMatchObject({ copied: true, replaced: false });
    expect(copied.skills.skills).toEqual([
      expect.objectContaining({ id: 'draw', source: 'private', overrides: 'public', enabled: false, instructions: 'PUBLIC BODY' })
    ]);
    expect((await service.preview(ACCOUNT, conversation())).included).toEqual([]);

    const copiedAgain = await service.copyPublicToPrivate(ACCOUNT, 'draw', copied.skills.revision);
    expect(copiedAgain.replaced).toBe(true);

    const edited = await service.savePrivate(
      ACCOUNT,
      definition('draw', { enabled: false, instructions: 'PRIVATE BODY' }),
      copiedAgain.skills.revision
    );
    expect(edited.skills.skills[0]).toMatchObject({ id: 'draw', enabled: false, instructions: 'PRIVATE BODY' });
    expect((await service.preview(ACCOUNT, conversation())).included).toEqual([]);

    const view = await policy.read(ACCOUNT);
    await policy.update(ACCOUNT, {
      expectedRevision: view.revision,
      patch: { defaults: { skills: { draw: 'on' } } }
    });
    const overridden = await service.preview(ACCOUNT, conversation());
    expect(overridden.included).toEqual(['draw']);
    expect(overridden.skills.filter((skill) => skill.id === 'draw')).toEqual([
      expect.objectContaining({ id: 'draw', source: 'private', overrides: 'public', selected: true })
    ]);
    const body = await service.listPrivate(ACCOUNT);
    expect(body.skills[0]?.instructions).toBe('PRIVATE BODY');

    const removed = await service.deletePrivate(ACCOUNT, 'draw', edited.skills.revision);
    expect(removed.removed).toBe(true);
    const fallback = await service.preview(ACCOUNT, conversation());
    expect(fallback.skills.filter((skill) => skill.id === 'draw')).toEqual([
      expect.objectContaining({ id: 'draw', source: 'public' })
    ]);
    const missing = await service.deletePrivate(ACCOUNT, 'draw', service.listPrivate(ACCOUNT).revision);
    expect(missing.removed).toBe(false);

    const disabledCopy = await service.copyPublicToPrivate(ACCOUNT, 'disabled-copy', service.listPrivate(ACCOUNT).revision);
    const copiedDefinition = disabledCopy.skills.skills.find((skill) => skill.id === 'disabled-copy');
    expect(copiedDefinition).toBeDefined();
    expect(copiedDefinition?.enabled).toBe(false);
    const savedDisabled = await service.savePrivate(
      ACCOUNT,
      definition('manual-disabled', { enabled: false }),
      disabledCopy.skills.revision
    );
    expect(savedDisabled.skills.skills.find((skill) => skill.id === 'manual-disabled')).toMatchObject({ enabled: false });
  });

  it('rejects a preview scoped to another account', async () => {
    const { service } = await setup();
    await expect(service.preview('10002', conversation('10001'))).rejects.toMatchObject({ code: 'isolation_violation' });
  });
});

describe('private Skill CAS', () => {
  it('rejects a stale private revision and preserves other account policy fields', async () => {
    const { config, policy, service } = await setup({
      accountPolicies: {
        [ACCOUNT]: accountPolicy({
          allowedProviders: ['chat'],
          bindings: { chat: bind('chat', 'text-model') },
          agentEnabled: false
        })
      }
    });
    const empty = service.listPrivate(ACCOUNT);
    const saved = await service.savePrivate(ACCOUNT, definition('mine'), empty.revision);
    expect(saved.replaced).toBe(false);
    await expect(service.savePrivate(ACCOUNT, definition('other'), empty.revision))
      .rejects.toMatchObject({ code: 'skill_conflict' });

    expect((await policy.read(ACCOUNT)).authorizedTools).toEqual([]);
    expect((await policy.read(ACCOUNT)).catalog.skills.map((skill) => skill.id)).toContain('mine');
    expect(service.listPrivate(ACCOUNT).skills.map((skill) => skill.id)).toEqual(['mine']);
    expect(config.accountPolicy(ACCOUNT)).toMatchObject({
      allowedProviders: ['chat'],
      agentEnabled: false,
      bindings: { chat: { providerId: 'chat', modelId: 'text-model' } }
    });
  });

  it('translates a concurrent private-definition write into skill_conflict', async () => {
    const { config, service } = await setup();
    const empty = service.listPrivate(ACCOUNT);
    await config.updateAccountPolicy(ACCOUNT, config.version, (policy) => ({
      ...policy,
      skills: { definitions: [definition('raced') as never] }
    }));
    await expect(service.savePrivate(ACCOUNT, definition('mine'), empty.revision))
      .rejects.toMatchObject({ code: 'skill_conflict' });
    expect(service.listPrivate(ACCOUNT).skills.map((skill) => skill.id)).toEqual(['raced']);
  });
});
