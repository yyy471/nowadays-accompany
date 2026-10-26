import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionPolicyService } from '../src/application/extensions/extension-policy-service.js';
import { ExtensionToolService } from '../src/application/extensions/extension-tool-service.js';
import type { ResolvedPlugin, ResolvedProfile } from '../src/artifacts/types.js';
import { silentLogger } from '../src/core/logger.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { ConfigStore } from '../src/providers/config-store.js';
import type { PluginRuntimeSnapshotEntry } from '../src/extensions/runtime/account-runtime.js';
import { writePhase1Config, accountPolicy, fakeProvider, fakeMediaProvider, bind } from './phase1-helpers.js';

const roots: string[] = [];
const ACCOUNT = '10001';
const PLUGIN_KEY = 'public/plugin/demo';
const TOOL_ID = `${PLUGIN_KEY}/lookup`;

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function addUnrelatedPlugin(profile: ResolvedProfile): ResolvedProfile {
  const base = profile.plugins[0]!;
  const unrelated: ResolvedPlugin = {
    ...base,
    ref: { source: 'public', id: 'unrelated', revision: 'u1' },
    manifest: {
      id: 'unrelated',
      kind: 'plugin',
      revision: 'u1',
      hooks: [{ name: 'beforeContext', timeoutMs: 500 }]
    },
    config: { value: 'unrelated-before' }
  };
  return { ...profile, plugins: [...profile.plugins, unrelated] };
}

describe('extension turn snapshots', () => {
  it('invalidates a relevant same-revision config change before runtime sync, while ignoring unrelated plugin config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-snapshot-'));
    roots.push(root);
    await writePhase1Config(root, {
      providers: [fakeProvider('chat'), fakeMediaProvider('media')],
      accountPolicies: {
        [ACCOUNT]: accountPolicy({
          allowedProviders: ['chat', 'media'],
          enabledTools: [TOOL_ID],
          bindings: { chat: bind('chat', 'text-model'), 'image.generate': bind('media', 'image-model') },
          extensions: { defaults: { plugins: { [PLUGIN_KEY]: 'on' }, tools: { [TOOL_ID]: 'on' } } }
        })
      }
    });
    const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
    const registry = new ExtensionRegistry();
    registry.registerTool({
      id: TOOL_ID,
      description: 'Look up deterministic local data.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      }
    });
    const demo: ResolvedPlugin = {
      ref: { source: 'public', id: 'demo', revision: 'r1' },
      manifest: {
        id: 'demo',
        kind: 'plugin',
        revision: 'r1',
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
        skills: [{ id: 'helper', name: 'Helper', instructions: 'Use lookup.', tools: ['lookup'] }]
      },
      dir: path.join(root, 'demo'),
      entry: path.join(root, 'demo', 'index.mjs'),
      apiVersion: 1,
      config: {}
    };
    let profile = addUnrelatedPlugin({
      accountId: ACCOUNT,
      revision: 'same-profile-revision',
      plugins: [{ ...demo, config: { value: 'relevant-old' } }]
    });
    const policy = new ExtensionPolicyService({
      config,
      registry,
      profiles: async () => profile,
      readyPlugins: () => new Set([PLUGIN_KEY]),
      readyTools: () => new Set([TOOL_ID])
    });
    const runtimeEntry: PluginRuntimeSnapshotEntry = {
      pluginKey: PLUGIN_KEY,
      revision: 'r1',
      configDigest: 'old-worker-config-digest',
      runtimeGeneration: 'old-worker-generation',
      tools: [TOOL_ID],
      hooks: ['beforeContext']
    };
    const extensions = new ExtensionToolService({
      policy,
      accountDir: () => path.join(root, 'accounts', ACCOUNT),
      logger: silentLogger('extension-snapshot-test'),
      capabilityEnabled: () => () => true,
      runtime: () => ({ handlers: () => () => undefined, snapshot: () => [runtimeEntry] })
    });
    const conversation = { accountId: ACCOUNT, kind: 'private' as const, peerId: '42' };
    const captured = await extensions.captureTurn(ACCOUNT, conversation);
    expect(captured.participatingPluginKeys).toEqual([PLUGIN_KEY]);

    profile = {
      ...profile,
      plugins: profile.plugins.map((plugin) => plugin.ref.id === 'unrelated'
        ? { ...plugin, config: { value: 'unrelated-after' } }
        : plugin)
    };
    expect(await extensions.isTurnPolicyCurrent(captured)).toBe(true);
    expect(await extensions.isTurnSnapshotCurrent(captured)).toBe(true);

    profile = {
      ...profile,
      plugins: profile.plugins.map((plugin) => plugin.ref.id === 'demo'
        ? { ...plugin, config: { value: 'relevant-new' } }
        : plugin)
    };
    expect(await extensions.isTurnPolicyCurrent(captured)).toBe(false);
    expect(await extensions.isTurnSnapshotCurrent(captured)).toBe(false);
    await extensions.close();
  });
});
