import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ExtensionPolicyService } from '../src/application/extensions/extension-policy-service.js';
import { PluginRuntimeService } from '../src/application/extensions/plugin-runtime-service.js';
import type { ResolvedPlugin, ResolvedProfile } from '../src/artifacts/types.js';
import { silentLogger } from '../src/core/logger.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { ConfigStore } from '../src/providers/config-store.js';
import type { AccountPolicy } from '../src/providers/types.js';
import { accountPolicy, fakeMediaProvider, fakeProvider, writePhase1Config } from './phase1-helpers.js';

const ACCOUNT = '10001';
const PLUGIN_KEY = 'public/plugin/hang';
const TOOL_ID = `${PLUGIN_KEY}/hold`;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

it('marks a terminated worker not ready in the policy DTO until an explicit reload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-readiness-'));
  roots.push(root);
  await writePhase1Config(root, {
    providers: [fakeProvider('chat'), fakeMediaProvider('media')],
    accountPolicies: { [ACCOUNT]: accountPolicy() }
  });
  const pluginDir = path.join(root, 'plugin');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(path.join(root, 'accounts', ACCOUNT), { recursive: true });
  await fs.writeFile(path.join(pluginDir, 'index.mjs'), [
    'export const tools = {',
    '  async hold() {',
    '    await new Promise((resolve) => setTimeout(resolve, 450));',
    '    return { status: "ok", text: "late result" };',
    '  }',
    '};',
    ''
  ].join('\n'), 'utf8');
  const plugin: ResolvedPlugin = {
    ref: { source: 'public', id: 'hang', revision: 'r1' },
    manifest: {
      id: 'hang',
      kind: 'plugin',
      revision: 'r1',
      entry: 'index.mjs',
      apiVersion: 1,
      tools: [{
        id: 'hold',
        description: 'Blocks past its handler deadline.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        effect: 'read',
        timeoutMs: 200,
        maxArgumentBytes: 4_096,
        maxResultBytes: 4_096
      }],
      state: { version: '1', accountShared: false }
    },
    dir: pluginDir,
    entry: path.join(pluginDir, 'index.mjs'),
    apiVersion: 1,
    config: {}
  };
  const profile: ResolvedProfile = { accountId: ACCOUNT, revision: 'profile-r4', plugins: [plugin] };
  const config = await ConfigStore.load({ filePath: path.join(root, 'config.v2.json') });
  const runtimePolicy = accountPolicy({
    byKind: {},
    byConversation: {},
    extensions: {
      defaults: { plugins: { [PLUGIN_KEY]: 'on' }, tools: { [TOOL_ID]: 'on' } },
      byKind: {},
      byConversation: {}
    }
  }) as unknown as AccountPolicy;
  const runtimes = new PluginRuntimeService({
    accountDir: (accountId) => path.join(root, 'accounts', accountId),
    profiles: async () => profile,
    accountPolicy: () => runtimePolicy,
    logger: silentLogger('extension-readiness')
  });
  try {
    const statuses = await runtimes.sync(ACCOUNT);
    expect(statuses).toEqual([expect.objectContaining({ pluginKey: PLUGIN_KEY, ready: true })]);
    expect(runtimes.readyPlugins(ACCOUNT).has(PLUGIN_KEY)).toBe(true);
    expect(runtimes.readyTools(ACCOUNT).has(TOOL_ID)).toBe(true);

    const binding = runtimes.port(ACCOUNT)?.handlers()(TOOL_ID);
    expect(binding).toBeDefined();
    const result = await binding!.handler({}, {
      accountId: ACCOUNT,
      conversation: { accountId: ACCOUNT, kind: 'private', peerId: '42' },
      invocationId: 'r4-1',
      invocationKey: 'r4-key',
      tool: {
        id: TOOL_ID,
        name: 'p_public_hang_hold',
        description: 'Blocks past its handler deadline.',
        owner: { kind: 'plugin', source: 'public', pluginId: 'hang' },
        effect: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        timeoutMs: 200,
        maxArgumentBytes: 4_096,
        maxResultBytes: 4_096
      },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5_000,
      logger: silentLogger('extension-readiness'),
      contextEpoch: 'epoch-r4'
    });
    expect(result).toMatchObject({ status: 'error', errorCode: 'plugin_handler_timeout' });

    expect([...runtimes.readyPlugins(ACCOUNT)]).toEqual([]);
    expect([...runtimes.readyTools(ACCOUNT)]).toEqual([]);
    expect(runtimes.statuses(ACCOUNT)).toMatchObject({
      synced: true,
      plugins: [{ pluginKey: PLUGIN_KEY, ready: true }]
    });

    const policy = new ExtensionPolicyService({
      config,
      registry: new ExtensionRegistry(),
      profiles: async () => profile,
      readyPlugins: (accountId) => runtimes.readyPlugins(accountId),
      readyTools: (accountId) => runtimes.readyTools(accountId),
      pluginRuntime: (accountId) => runtimes.statuses(accountId)
    });
    const stale = await policy.read(ACCOUNT);
    expect(stale.runtime.readyPlugins).toEqual([]);
    expect(stale.runtime.readyTools).toEqual([]);
    expect(stale.runtime.plugins).toEqual([expect.objectContaining({ pluginKey: PLUGIN_KEY, ready: true })]);
    expect(stale.catalog.tools.find((tool) => tool.id === TOOL_ID)?.handlerReady).toBe(false);

    await runtimes.close(ACCOUNT);
    const restarted = await runtimes.sync(ACCOUNT);
    expect(restarted).toEqual([expect.objectContaining({ pluginKey: PLUGIN_KEY, ready: true })]);
    const fresh = await policy.read(ACCOUNT);
    expect(fresh.runtime.readyPlugins).toEqual([PLUGIN_KEY]);
    expect(fresh.runtime.readyTools).toEqual([TOOL_ID]);
    expect(fresh.catalog.tools.find((tool) => tool.id === TOOL_ID)?.handlerReady).toBe(true);
  } finally {
    await runtimes.close();
  }
});
