import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedPlugin } from '../src/artifacts/types.js';
import { silentLogger } from '../src/core/logger.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import type {
  PluginHookDeclaration,
  PluginSource,
  PluginStateDeclaration,
  PluginToolDeclaration
} from '../src/extensions/contracts.js';
import {
  ToolExecutor,
  type ToolBatchContext,
  type ToolCallRequest,
  type ToolHandlerOutcome
} from '../src/extensions/execution/executor.js';
import type { RegisteredToolDefinition } from '../src/extensions/types.js';
import { AccountPluginRuntime } from '../src/extensions/runtime/account-runtime.js';
import { PLUGIN_RUNTIME_LIMITS } from '../src/extensions/runtime/protocol.js';
import {
  PluginWorkerManager,
  type PluginHookInput,
  type PluginRuntimeLimits
} from '../src/extensions/runtime/plugin-worker.js';
import { PluginStateService, type PluginStateScope } from '../src/extensions/runtime/state.js';
import type { AccountExtensionPolicy, AccountPolicy } from '../src/providers/types.js';
import type { ChatKind, ConversationRef } from '../src/routing/identity.js';

const FIXTURES = path.resolve('test/fixtures/plugins');
const ACCOUNT = '10001';
const ARGS_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    note: { type: 'string' },
    refuse: { type: 'boolean' },
    delayMs: { type: 'integer' },
    blockMs: { type: 'integer' }
  },
  required: ['key'],
  additionalProperties: false
};

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-ext-runtime-'));
  roots.push(root);
  return root;
}

function accountPolicy(extensions?: Partial<AccountExtensionPolicy>): AccountPolicy {
  const suppliedDefaults = extensions?.defaults ?? {};
  const enabledPlugins: Record<string, 'on' | 'off' | 'inherit'> = {
    'public/plugin/demo': 'on',
    'private/plugin/demo': 'on',
    'public/plugin/hanging': 'on',
    'public/plugin/blocking': 'on',
    'public/plugin/slow': 'on',
    'public/plugin/submitted': 'on',
    'public/plugin/running-guard': 'on',
    'public/plugin/queued': 'on',
    'private/plugin/unsafe id': 'on',
    'public/plugin/forged': 'on',
    ...suppliedDefaults.plugins
  };
  return {
    allowedProviders: [],
    crossProviderFallback: false,
    media: { allowCloudUpload: false },
    byKind: {},
    byConversation: {},
    extensions: {
      ...extensions,
      defaults: { ...suppliedDefaults, plugins: enabledPlugins },
      byKind: extensions?.byKind ?? {},
      byConversation: extensions?.byConversation ?? {}
    }
  };
}

function bareAccountPolicy(): AccountPolicy {
  const base = accountPolicy();
  return { ...base, extensions: { defaults: {}, byKind: {}, byConversation: {} } };
}

function conv(accountId = ACCOUNT, kind: ChatKind = 'private', peerId = '42'): ConversationRef {
  return { accountId, kind, peerId };
}

function toolDeclaration(id: string, effect: 'read' | 'action', timeoutMs = 1_000): PluginToolDeclaration {
  return {
    id,
    description: `Fixture tool ${id}.`,
    inputSchema: ARGS_SCHEMA,
    effect,
    timeoutMs,
    maxArgumentBytes: 16 * 1024,
    maxResultBytes: 8 * 1024
  };
}

function hookDeclaration(name: 'beforeContext' | 'afterTurn', timeoutMs = 1_000): PluginHookDeclaration {
  return { name, timeoutMs };
}

interface FixtureOptions {
  source?: PluginSource;
  id?: string;
  revision?: string;
  tools?: PluginToolDeclaration[];
  hooks?: PluginHookDeclaration[];
  state?: PluginStateDeclaration;
  config?: Record<string, unknown>;
}

function fixture(fixtureDir: string, options: FixtureOptions = {}): ResolvedPlugin {
  const id = options.id ?? 'demo';
  const source = options.source ?? 'public';
  const revision = options.revision ?? 'r1';
  return {
    ref: { source, id, revision },
    manifest: {
      id,
      kind: 'plugin',
      revision,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.state ? { state: options.state } : {})
    },
    dir: path.join(FIXTURES, fixtureDir),
    entry: path.join(FIXTURES, fixtureDir, 'index.mjs'),
    apiVersion: 1,
    config: options.config ?? {}
  };
}

async function inlinePlugin(
  id: string,
  source: PluginSource,
  moduleSource: string,
  options: Pick<FixtureOptions, 'tools' | 'hooks' | 'state'> = {}
): Promise<ResolvedPlugin> {
  const dir = await tempRoot();
  const entry = path.join(dir, 'index.mjs');
  await fs.writeFile(entry, moduleSource, 'utf8');
  const base = fixture('offline-demo', { id, source, ...options });
  return { ...base, dir, entry };
}

const demoTools = [
  toolDeclaration('remember', 'action'),
  toolDeclaration('recall', 'read'),
  toolDeclaration('missing', 'read')
];
const demoHooks = [hookDeclaration('beforeContext'), hookDeclaration('afterTurn')];
const demoShape: FixtureOptions = { tools: demoTools, hooks: demoHooks, state: { version: '1', accountShared: false } };

interface ManagerHandle {
  manager: PluginWorkerManager;
  state: PluginStateService;
  accountDir: string;
}

async function openManager(
  plugin: ResolvedPlugin,
  options: {
    accountId?: string;
    accountDir?: string;
    policy?: AccountPolicy;
    limits?: PluginRuntimeLimits;
  } = {}
): Promise<ManagerHandle> {
  const accountDir = options.accountDir ?? path.join(await tempRoot(), 'accounts', options.accountId ?? ACCOUNT);
  const state = new PluginStateService(accountDir);
  const manager = new PluginWorkerManager(plugin, {
    accountId: options.accountId ?? ACCOUNT,
    state,
    logger: silentLogger('extension-runtime-test'),
    accountPolicy: () => options.policy ?? accountPolicy(),
    ...(options.limits ? { limits: options.limits } : {})
  });
  closers.push(() => manager.stop());
  await manager.start();
  return { manager, state, accountDir };
}

function scopeOf(plugin: ResolvedPlugin, conversation: ConversationRef, contextEpoch: string, accountShared: boolean): PluginStateScope {
  return scopeOfSource(plugin.ref.source, conversation, contextEpoch, accountShared, plugin.ref.id);
}

function scopeOfSource(
  source: PluginSource,
  conversation: ConversationRef,
  contextEpoch: string,
  accountShared: boolean,
  pluginId = 'demo'
): PluginStateScope {
  return {
    source,
    pluginId,
    kind: conversation.kind,
    peerId: conversation.peerId,
    contextEpoch,
    accountShared
  };
}

function hookInput(conversation: ConversationRef, contextEpoch = 'epoch-1', turnId = 'turn-1'): PluginHookInput {
  return { conversation, contextEpoch, turnId, history: [] };
}

function toolDefinition(id: string, effect: 'read' | 'action'): RegisteredToolDefinition {
  const segments = id.split('/');
  const source = segments[0] === 'private' ? 'private' : 'public';
  return {
    id,
    name: `p_${source}_${segments[2]}_${segments[3]}`,
    description: 'Fixture plugin tool.',
    inputSchema: ARGS_SCHEMA,
    owner: { kind: 'plugin', source, pluginId: segments[2]! },
    effect,
    timeoutMs: 1_000,
    maxArgumentBytes: 16 * 1024,
    maxResultBytes: 8 * 1024
  };
}

/** Calls a plugin handler exactly the way ToolExecutor does, minus the ledger. */
async function invokeHandler(
  runtime: AccountPluginRuntime,
  toolId: string,
  args: Record<string, unknown>,
  options: {
    accountId?: string;
    conversation?: ConversationRef;
    contextEpoch?: string;
    invocationId: string;
    effect?: 'read' | 'action';
  }
): Promise<ToolHandlerOutcome | undefined> {
  const binding = runtime.handlers()(toolId);
  if (!binding) return undefined;
  return binding.handler(args, {
    accountId: options.accountId ?? ACCOUNT,
    conversation: options.conversation ?? conv(options.accountId ?? ACCOUNT),
    invocationId: options.invocationId,
    invocationKey: `key-${options.invocationId}`,
    tool: toolDefinition(toolId, options.effect ?? 'action'),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
    logger: silentLogger('extension-runtime-test'),
    ...(options.contextEpoch !== undefined ? { contextEpoch: options.contextEpoch } : {})
  });
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('plugin runtime handshake', () => {
  it('exposes only declared handlers under namespaced tool ids', async () => {
    const { manager } = await openManager(fixture('offline-demo', demoShape));

    expect(manager.readyTools).toEqual([
      'public/plugin/demo/remember',
      'public/plugin/demo/recall'
    ]);
    expect(manager.readyHooks).toEqual(['beforeContext', 'afterTurn']);
    expect(manager.hasTool('public/plugin/demo/missing')).toBe(false);
    expect(manager.hasTool('public/plugin/demo/undeclaredHandler')).toBe(false);
    expect(manager.toolBinding('public/plugin/demo/undeclaredHandler')).toBeUndefined();
    expect(manager.toolBinding('public/plugin/demo/remember')?.generation).toBe(
      `${manager.runtimeGeneration}:remember`
    );
    expect(manager.toolBinding('public/plugin/demo/missing')).toBeUndefined();
  });

  it('does not invent a numeric or zero role epoch when a tool binding has none', async () => {
    const { manager } = await openManager(fixture('offline-demo', demoShape));
    const binding = manager.toolBinding('public/plugin/demo/remember')!;
    const result = await binding.handler({ key: 'no-epoch', note: 'must not run' }, {
      accountId: ACCOUNT,
      conversation: conv(),
      invocationId: 'missing-epoch',
      invocationKey: 'missing-epoch-key',
      tool: toolDefinition('public/plugin/demo/remember', 'action'),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 1_000,
      logger: silentLogger('extension-runtime-test')
    });
    expect(result).toMatchObject({ status: 'error', errorCode: 'plugin_context_epoch_missing' });
  });

  it('handshakes with no ready handler when a declaration has no implementation', async () => {
    const { manager } = await openManager(fixture('silent', {
      id: 'silent',
      tools: [toolDeclaration('remember', 'action')],
      hooks: demoHooks
    }));

    expect(manager.readyTools).toEqual([]);
    expect(manager.readyHooks).toEqual([]);
    expect(manager.terminated).toBe(false);
    expect(manager.toolBinding('public/plugin/silent/remember')).toBeUndefined();
    expect(await manager.beforeContext(hookInput(conv()))).toEqual({ status: 'ok', additions: [] });
  });

  it('fails startup when the plugin module cannot initialize', async () => {
    await expect(openManager(fixture('broken', { id: 'broken', tools: demoTools })))
      .rejects.toMatchObject({ code: 'plugin_init_failed' });
  });

  it('reports an unusable plugin in sync while a healthy plugin keeps working', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    const statuses = await runtime.sync([
      fixture('broken', { id: 'broken', tools: demoTools }),
      fixture('offline-demo', demoShape)
    ]);

    const broken = statuses.find((status) => status.pluginKey === 'public/plugin/broken');
    const healthy = statuses.find((status) => status.pluginKey === 'public/plugin/demo');
    expect(broken).toMatchObject({ ready: false, tools: [], hooks: [] });
    expect(healthy?.ready).toBe(true);
    expect(healthy?.tools).toEqual(['public/plugin/demo/remember', 'public/plugin/demo/recall']);
    expect([...runtime.readyTools()]).toEqual(healthy?.tools);
    expect(runtime.readyPlugins()).toEqual(new Set(['public/plugin/demo']));
  });

  it('applies a host deadline to import and initialization and lets close interrupt sync', async () => {
    const stuckPlugins = [
      await inlinePlugin('spin-top', 'public', 'while (true) {}'),
      await inlinePlugin('await-top', 'public', 'await new Promise(() => {});'),
      await inlinePlugin('spin-init', 'public', 'export function init() { while (true) {} }')
    ];
    for (const stuck of stuckPlugins) {
      const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
      const runtime = new AccountPluginRuntime({
        accountId: ACCOUNT,
        logger: silentLogger('extension-runtime-test'),
        accountDir,
        accountPolicy: () => accountPolicy(),
        limits: { initTimeoutMs: 40, timeoutGraceMs: 20 }
      });
      closers.push(() => runtime.close());
      const statuses = await runtime.sync([stuck, fixture('offline-demo', demoShape)]);
      expect(statuses.find((status) => status.pluginKey.endsWith(stuck.ref.id))).toMatchObject({ ready: false });
      expect(statuses.find((status) => status.pluginKey === 'public/plugin/demo')).toMatchObject({ ready: true });
      expect(runtime.handlers()('public/plugin/demo/remember')).toBeDefined();
    }

    const never = await inlinePlugin('never-stop', 'public', 'await new Promise(() => {});');
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy(),
      limits: { initTimeoutMs: 2_000, timeoutGraceMs: 0 }
    });
    const syncing = runtime.sync([never]);
    await sleep(15);
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(250);
    await expect(syncing).resolves.toMatchObject([{ ready: false }]);
  });
});

describe('plugin state namespaces', () => {
  it('uses the opaque role epoch in state semantics without placing it in the filename', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const state = new PluginStateService(accountDir);
    const plugin = fixture('offline-demo', demoShape);
    const epoch = 'binding:revision-7:public:role-card:role-id:artifact-rev:catalog-2';
    const scope = scopeOf(plugin, conv(), epoch, false);
    const filename = state.filePath(scope);
    expect(path.basename(filename)).not.toContain(':');
    expect(path.basename(filename)).not.toContain(epoch);
    await state.write(scope, '1', { value: 'same role' });
    expect(await state.read(scope, '1')).toMatchObject({ status: 'ready', state: { value: 'same role' } });
    expect(await state.read(scopeOf(plugin, conv(ACCOUNT, 'private', '43'), epoch, false), '1'))
      .toMatchObject({ status: 'missing' });
  });

  it('rejects an envelope copied into a different session namespace', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const state = new PluginStateService(accountDir);
    const plugin = fixture('offline-demo', demoShape);
    const source = scopeOf(plugin, conv(), 'binding:public:role:rev-1', false);
    const target = scopeOf(plugin, conv(ACCOUNT, 'group', '42'), 'binding:public:role:rev-1', false);
    await state.write(source, '1', { value: 'private namespace' });
    await fs.mkdir(path.dirname(state.filePath(target)), { recursive: true });
    await fs.copyFile(state.filePath(source), state.filePath(target));
    expect(await state.read(target, '1')).toMatchObject({ status: 'unavailable', reason: 'plugin_state_scope_mismatch' });
  });

  it('rechecks the execution guard at the atomic commit and preserves the previous state', async () => {
    const state = new PluginStateService(path.join(await tempRoot(), 'accounts', ACCOUNT));
    const scope = scopeOf(fixture('offline-demo', demoShape), conv(), 'binding:rev:role:artifact', false);
    await state.write(scope, '1', { value: 'before' });
    let checks = 0;
    await expect(state.write(scope, '1', { value: 'must not commit' }, Date.now(), {
      guard: () => ++checks < 2
    })).rejects.toMatchObject({ code: 'plugin_execution_guard_changed' });
    expect(await state.read(scope, '1')).toMatchObject({ status: 'ready', state: { value: 'before' } });
  });

  it('isolates default conversation state by kind, peer and context epoch', async () => {
    const plugin = fixture('offline-demo', demoShape);
    const { manager, state } = await openManager(plugin);
    const privateConv = conv(ACCOUNT, 'private', '42');
    const groupConv = conv(ACCOUNT, 'group', '42');
    const otherPeer = conv(ACCOUNT, 'private', '43');

    const remembered = await manager.callTool({
      conversation: privateConv,
      contextEpoch: 'epoch-7',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'tea', note: 'hot' }
    });
    expect(remembered).toMatchObject({ status: 'ok', text: '已记住 tea' });

    expect(await manager.beforeContext(hookInput(groupConv, 'epoch-7'))).toEqual({ status: 'ok', additions: [] });
    expect(await manager.beforeContext(hookInput(otherPeer, 'epoch-7'))).toEqual({ status: 'ok', additions: [] });
    expect(await manager.beforeContext(hookInput(privateConv, 'epoch-8'))).toEqual({ status: 'ok', additions: [] });

    const visible = await manager.beforeContext(hookInput(privateConv, 'epoch-7'));
    expect(visible.status).toBe('ok');
    expect(visible.status === 'ok' ? visible.additions[0]?.text : undefined)
      .toContain('offline notes=1 last=tea:hot scope=private/42/epoch-7/shared=false');

    const leaked = await manager.callTool({
      conversation: groupConv,
      contextEpoch: 'epoch-7',
      invocationId: 'i2',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'tea' }
    });
    expect(leaked).toMatchObject({ status: 'ok', text: '(none)', data: { total: 0 } });

    const same = await manager.callTool({
      conversation: privateConv,
      contextEpoch: 'epoch-7',
      invocationId: 'i3',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'tea' }
    });
    expect(same).toMatchObject({ status: 'ok', text: 'hot' });

    expect(await exists(state.filePath(scopeOf(plugin, privateConv, 'epoch-7', false)))).toBe(true);
    expect(await exists(state.filePath(scopeOf(plugin, groupConv, 'epoch-7', false)))).toBe(true);
    expect(await exists(state.filePath(scopeOf(plugin, privateConv, 'epoch-7', true)))).toBe(false);
  });

  it('uses the account namespace only when the manifest declares it and the account switch is on', async () => {
    const declared = fixture('offline-demo', {
      tools: demoTools,
      state: { version: '1', accountShared: true }
    });
    const switchOn = accountPolicy({ defaults: { state: { 'public/plugin/demo': 'on' } } });

    const undeclared = await openManager(fixture('offline-demo', {
      tools: demoTools,
      state: { version: '1', accountShared: false }
    }), { policy: switchOn });
    await undeclared.manager.callTool({
      conversation: conv(ACCOUNT, 'private', '42'),
      contextEpoch: 'epoch-3',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'tea', note: 'private-scope' }
    });
    const stillScoped = await undeclared.manager.callTool({
      conversation: conv(ACCOUNT, 'group', '42'),
      contextEpoch: 'epoch-3',
      invocationId: 'i2',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'tea' }
    });
    expect(stillScoped).toMatchObject({ status: 'ok', text: '(none)' });

    const declaredOff = await openManager(declared, {
      accountDir: undeclared.accountDir,
      policy: accountPolicy()
    });
    await declaredOff.manager.callTool({
      conversation: conv(ACCOUNT, 'private', '42'),
      contextEpoch: 'epoch-3',
      invocationId: 'i3',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'k2', note: 'kind-scoped' }
    });
    const offCross = await declaredOff.manager.callTool({
      conversation: conv(ACCOUNT, 'group', '42'),
      contextEpoch: 'epoch-3',
      invocationId: 'i4',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'k2' }
    });
    expect(offCross).toMatchObject({ status: 'ok', text: '(none)' });

    const shared = await openManager(declared, {
      accountDir: path.join(await tempRoot(), 'accounts', ACCOUNT),
      policy: switchOn
    });
    await shared.manager.callTool({
      conversation: conv(ACCOUNT, 'private', '42'),
      contextEpoch: 'epoch-3',
      invocationId: 'i5',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'k3', note: 'shared-note' }
    });
    const crossKind = await shared.manager.callTool({
      conversation: conv(ACCOUNT, 'group', '99'),
      contextEpoch: 'epoch-9',
      invocationId: 'i6',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'k3' }
    });
    expect(crossKind).toMatchObject({ status: 'ok', text: 'shared-note' });
    const sharedStateFile = path.join(shared.accountDir, 'plugin-state', 'public', 'demo', 'account.json');
    expect(await exists(sharedStateFile)).toBe(true);
    const sharedEnvelope = JSON.parse(await fs.readFile(sharedStateFile, 'utf8')) as { scope?: unknown };
    expect(sharedEnvelope.scope).toEqual({ accountShared: true });
  });

  it('refuses tasks whose persisted state version is incompatible and keeps the old file', async () => {
    const plugin = fixture('offline-demo', demoShape);
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const store = new PluginStateService(accountDir);
    const conversation = conv();
    const scope = scopeOf(plugin, conversation, 'epoch-7', false);
    await store.write(scope, '1', { entries: [{ key: 'kept', note: 'original' }] });

    const upgraded = await openManager(fixture('offline-demo', { tools: demoTools, hooks: demoHooks, state: { version: '2', accountShared: false } }), { accountDir });
    expect(await upgraded.manager.beforeContext(hookInput(conversation, 'epoch-7')))
      .toEqual({ status: 'unavailable', reason: 'plugin_state_version_conflict' });
    const blocked = await upgraded.manager.callTool({
      conversation,
      contextEpoch: 'epoch-7',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'new', note: 'overwrite' }
    });
    expect(blocked).toMatchObject({ status: 'error', errorCode: 'plugin_state_version_conflict' });

    const preserved = await store.read(scope, '1');
    expect(preserved.status).toBe('ready');
    expect(preserved.status === 'ready' ? preserved.state.entries : undefined).toEqual([{ key: 'kept', note: 'original' }]);
  });

  it('refuses tasks whose namespace has grown past the bounded size', async () => {
    const plugin = fixture('offline-demo', demoShape);
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const { manager, state } = await openManager(plugin, { accountDir });
    const conversation = conv();
    const scope = scopeOf(plugin, conversation, 'epoch-5', false);
    const file = state.filePath(scope);
    const padded = { blob: 'y'.repeat(PLUGIN_RUNTIME_LIMITS.maxStateBytes) };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, stateVersion: '1', updatedAt: 1, value: padded }), 'utf8');

    expect(await manager.beforeContext(hookInput(conversation, 'epoch-5')))
      .toEqual({ status: 'unavailable', reason: 'plugin_state_too_large' });
    expect(await manager.callTool({
      conversation,
      contextEpoch: 'epoch-5',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'any' }
    })).toMatchObject({ status: 'error', errorCode: 'plugin_state_too_large' });
    expect(manager.terminated).toBe(false);
  });

  it('serializes concurrent plugin tasks and state writes without losing updates', async () => {
    const plugin = fixture('offline-demo', demoShape);
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const { manager } = await openManager(plugin, { accountDir });
    const conversation = conv();

    const outcomes = await Promise.all([
      manager.callTool({ conversation, contextEpoch: 'epoch-5', invocationId: 'i1', toolId: 'public/plugin/demo/remember', args: { key: 'k1', note: 'n1' } }),
      manager.callTool({ conversation, contextEpoch: 'epoch-5', invocationId: 'i2', toolId: 'public/plugin/demo/remember', args: { key: 'k2', note: 'n2' } }),
      manager.beforeContext(hookInput(conversation, 'epoch-5'))
    ]);
    expect(outcomes.slice(0, 2).every((outcome) => outcome.status === 'ok')).toBe(true);

    const recalled = await manager.callTool({ conversation, contextEpoch: 'epoch-5', invocationId: 'i3', toolId: 'public/plugin/demo/recall', args: { key: 'k1' } });
    expect(recalled).toMatchObject({ status: 'ok', text: 'n1', data: { total: 2, hits: 1 } });

    const store = new PluginStateService(accountDir);
    const scope = scopeOf(plugin, conversation, 'epoch-5', false);
    await Promise.all(Array.from({ length: 8 }, (unused, index) => store.write(scope, '1', { seq: index })));
    const settled = await store.read(scope, '1');
    expect(settled).toMatchObject({ status: 'ready', state: { seq: 7 } });
    await expect(store.write(scope, '2', { seq: 'other' })).rejects.toMatchObject({ code: 'plugin_state_conflict' });
    expect(await store.read(scope, '1')).toMatchObject({ status: 'ready', state: { seq: 7 } });
    await store.close();
  });
});

describe('plugin hooks and bounded inputs', () => {
  it('defaults hooks off, applies kind and conversation overrides, and honors hard account off', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    let policy = bareAccountPolicy();
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => policy
    });
    closers.push(() => runtime.close());
    await runtime.sync([fixture('offline-demo', demoShape)]);
    const state = new PluginStateService(accountDir);
    const epoch = 'binding:role:artifact:rev-1';

    expect(await runtime.beforeContext(hookInput(conv(), epoch))).toEqual([]);
    await runtime.afterTurn({ ...hookInput(conv(), epoch), outcome: 'sent' });
    expect(await state.read(scopeOf(fixture('offline-demo', demoShape), conv(), epoch, false), '1')).toMatchObject({ status: 'missing' });

    policy = {
      ...bareAccountPolicy(),
      extensions: {
        defaults: {},
        byKind: { group: { plugins: { 'public/plugin/demo': 'off' } } },
        byConversation: { 'private/42': { plugins: { 'public/plugin/demo': 'on' } } }
      }
    };
    expect(await runtime.beforeContext(hookInput(conv(ACCOUNT, 'group', '42'), epoch))).toEqual([]);
    const privateResult = await runtime.beforeContext(hookInput(conv(), epoch));
    expect(privateResult).toMatchObject([{ pluginKey: 'public/plugin/demo', result: { status: 'ok' } }]);
    await runtime.afterTurn({ ...hookInput(conv(), epoch), outcome: 'suppressed' });
    const privateState = await state.read(scopeOf(fixture('offline-demo', demoShape), conv(), epoch, false), '1');
    expect(privateState).toMatchObject({ status: 'ready', state: { turns: 1, replies: 1, lastOutcome: 'suppressed' } });
    expect(await state.read(scopeOf(fixture('offline-demo', demoShape), conv(ACCOUNT, 'group', '42'), epoch, false), '1'))
      .toMatchObject({ status: 'missing' });

    policy = {
      ...bareAccountPolicy(),
      extensions: {
        defaults: { plugins: { 'public/plugin/demo': 'off' } },
        byKind: {},
        byConversation: { 'private/42': { plugins: { 'public/plugin/demo': 'on' } } }
      }
    };
    expect(await runtime.beforeContext(hookInput(conv(), epoch))).toMatchObject([
      { pluginKey: 'public/plugin/demo', result: { status: 'ok' } }
    ]);
    await runtime.afterTurn({ ...hookInput(conv(), epoch), outcome: 'sent' });
    expect(await state.read(scopeOf(fixture('offline-demo', demoShape), conv(), epoch, false), '1'))
      .toMatchObject({ status: 'ready', state: { turns: 2, replies: 2, lastOutcome: 'sent' } });

    await runtime.sync([]);
    expect(runtime.readyPlugins()).toEqual(new Set());
    expect(await runtime.beforeContext(hookInput(conv(), epoch))).toEqual([]);
    await runtime.afterTurn({ ...hookInput(conv(), epoch), outcome: 'failed' });
    expect(await state.read(scopeOf(fixture('offline-demo', demoShape), conv(), epoch, false), '1'))
      .toMatchObject({ status: 'ready', state: { turns: 2, replies: 2, lastOutcome: 'sent' } });
  });

  it('records the real turn outcome from afterTurn into the conversation namespace', async () => {
    const plugin = fixture('offline-demo', demoShape);
    const { manager, state } = await openManager(plugin);
    const conversation = conv();

    await manager.afterTurn({ ...hookInput(conversation, 'epoch-4'), outcome: 'sent', replyText: '好的' });
    await manager.afterTurn({ ...hookInput(conversation, 'epoch-4'), outcome: 'failed', errorCode: 'provider_error' });

    const saved = await state.read(scopeOf(plugin, conversation, 'epoch-4', false), '1');
    expect(saved).toMatchObject({ status: 'ready', state: { replies: 2, lastOutcome: 'failed' } });
  });

  it('skips afterTurn for a plugin that does not implement the hook', async () => {
    const plugin = fixture('hanging', { id: 'hanging', tools: [toolDeclaration('remember', 'action')] });
    const { manager, state } = await openManager(plugin);
    await manager.afterTurn({ ...hookInput(conv(), 'epoch-4'), outcome: 'sent' });
    expect(await state.read(scopeOf(plugin, conv(), 'epoch-4', false), '1')).toMatchObject({ status: 'missing' });
  });

  it('notifies every installed plugin of the same turn outcome', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    await runtime.sync([
      fixture('offline-demo', { ...demoShape, source: 'public' }),
      fixture('offline-demo', { ...demoShape, source: 'private' })
    ]);
    await runtime.afterTurn({ ...hookInput(conv(), 'epoch-6'), outcome: 'suppressed' });

    const store = new PluginStateService(accountDir);
    for (const source of ['public', 'private'] as const) {
      expect(await store.read(scopeOfSource(source, conv(), 'epoch-6', false), '1'))
        .toMatchObject({ status: 'ready', state: { replies: 1, lastOutcome: 'suppressed' } });
    }
  });

  it('finishes beforeContext hooks within the per-hook and shared turn budget', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    await runtime.sync([
      fixture('slow-hook', {
        id: 'slow',
        hooks: [hookDeclaration('beforeContext', 1_000)],
        state: { version: '1', accountShared: false }
      }),
      fixture('offline-demo', demoShape)
    ]);

    const started = Date.now();
    const results = await runtime.beforeContext(hookInput(conv(), 'epoch-8'));
    const elapsed = Date.now() - started;

    expect(results.map((entry) => entry.result.status)).toEqual(['ok', 'ok']);
    expect(elapsed).toBeLessThan(700);
  });

  it('does not let an expired queued hook terminate a Worker running a normal long tool', async () => {
    const root = await tempRoot();
    const markerPath = path.join(root, 'long-tool-started.marker');
    const base = await inlinePlugin('queued-hook', 'public', `
      import { writeFile } from 'node:fs/promises';
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      export async function beforeContext(ctx) {
        ctx.state.hookRuns = (ctx.state.hookRuns ?? 0) + 1;
        return { additions: [{ source: 'queue-test', text: 'hook ran' }] };
      }
      export const tools = {
        async hold(args, ctx) {
          await writeFile(ctx.config.markerPath, 'started', 'utf8');
          await delay(650);
          ctx.state.toolDone = true;
          return { status: 'ok', text: 'long tool completed' };
        }
      }`, {
      tools: [toolDeclaration('hold', 'read', 2_000)],
      hooks: [hookDeclaration('beforeContext', 5_000)],
      state: { version: '1', accountShared: false }
    });
    const plugin = { ...base, config: { markerPath } };
    const accountDir = path.join(root, 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy({ defaults: { plugins: { 'public/plugin/queued-hook': 'on' } } })
    });
    closers.push(() => runtime.close());
    await runtime.sync([plugin]);
    const toolId = 'public/plugin/queued-hook/hold';
    const running = invokeHandler(runtime, toolId, { key: 'hold' }, {
      invocationId: 'long-tool',
      contextEpoch: 'queue-epoch',
      effect: 'read'
    });
    for (let attempt = 0; attempt < 100 && !(await exists(markerPath)); attempt += 1) await sleep(10);
    expect(await exists(markerPath)).toBe(true);

    const hookStarted = Date.now();
    const queued = await runtime.beforeContext(hookInput(conv(), 'queue-epoch', 'queued-hook-turn'));
    expect(Date.now() - hookStarted).toBeLessThan(650);
    expect(queued[0]?.result).toMatchObject({ status: 'failed', reason: 'plugin_timeout' });
    expect(runtime.snapshot()[0]).toBeDefined();

    expect(await running).toMatchObject({ status: 'ok', text: 'long tool completed' });
    const fresh = await runtime.beforeContext(hookInput(conv(), 'queue-epoch', 'fresh-hook-turn'));
    expect(fresh[0]?.result).toMatchObject({ status: 'ok', additions: [{ source: 'queue-test', text: 'hook ran' }] });
    const persisted = await new PluginStateService(accountDir).read(scopeOf(plugin, conv(), 'queue-epoch', false), '1');
    expect(persisted).toMatchObject({ status: 'ready', state: { toolDone: true, hookRuns: 1 } });
  });

  it('replaces a same-revision Worker when the resolved plugin config changes', async () => {
    const moduleSource = `
      export async function beforeContext(ctx) {
        return { additions: [{ source: 'config', text: ctx.config.value }] };
      }`;
    const firstBase = await inlinePlugin('config-sensitive', 'public', moduleSource, {
      hooks: [hookDeclaration('beforeContext')],
      state: { version: '1', accountShared: false }
    });
    const first = { ...firstBase, config: { value: 'old-config' } };
    const second = { ...firstBase, config: { value: 'new-config' } };
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir: path.join(await tempRoot(), 'accounts', ACCOUNT),
      accountPolicy: () => accountPolicy({ defaults: { plugins: { 'public/plugin/config-sensitive': 'on' } } })
    });
    closers.push(() => runtime.close());
    await runtime.sync([first]);
    const firstGeneration = runtime.snapshot()[0]?.runtimeGeneration;
    const before = await runtime.beforeContext(hookInput(conv(), 'config-epoch', 'first-config-turn'));
    expect(before[0]?.result).toMatchObject({ status: 'ok', additions: [{ text: 'old-config' }] });

    await runtime.sync([second]);
    expect(runtime.snapshot()[0]?.runtimeGeneration).not.toBe(firstGeneration);
    const after = await runtime.beforeContext(hookInput(conv(), 'config-epoch', 'second-config-turn'));
    expect(after[0]?.result).toMatchObject({ status: 'ok', additions: [{ text: 'new-config' }] });
  });

  it('caps one hook at 500ms and shares the 2s budget across beforeContext and afterTurn', async () => {
    const slow = await inlinePlugin('single-timeout', 'public', `
      export async function beforeContext(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        ctx.state.late = true;
        return { additions: [] };
      }`, {
      hooks: [hookDeclaration('beforeContext', 5_000)],
      state: { version: '1', accountShared: false }
    });
    const slowAccountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const slowRuntime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir: slowAccountDir,
      accountPolicy: () => accountPolicy({ defaults: { plugins: { 'public/plugin/single-timeout': 'on' } } })
    });
    closers.push(() => slowRuntime.close());
    await slowRuntime.sync([slow]);
    const hookStarted = Date.now();
    const timeout = await slowRuntime.beforeContext(hookInput(conv(), 'single-timeout-epoch'));
    expect(Date.now() - hookStarted).toBeLessThan(650);
    expect(timeout[0]?.result).toMatchObject({ status: 'failed', reason: 'plugin_timeout' });
    expect(slowRuntime.snapshot()).toEqual([]);
    await sleep(750);
    const lateState = await new PluginStateService(slowAccountDir).read(scopeOf(slow, conv(), 'single-timeout-epoch', false), '1');
    expect(lateState.status).toBe('missing');

    const sharedModule = `
      const delay = () => new Promise((resolve) => setTimeout(resolve, 380));
      export async function beforeContext(ctx) { await delay(); return { additions: [] }; }
      export async function afterTurn(ctx) { await delay(); ctx.state.after = (ctx.state.after ?? 0) + 1; }
    `;
    const sharedPlugins = await Promise.all(['budget-a', 'budget-b', 'budget-c'].map(async (id) => {
      const base = await inlinePlugin(id, 'public', sharedModule, {
        hooks: [hookDeclaration('beforeContext', 5_000), hookDeclaration('afterTurn', 5_000)],
        state: { version: '1', accountShared: false }
      });
      return base;
    }));
    const sharedPolicy = accountPolicy({ defaults: { plugins: Object.fromEntries(sharedPlugins.map((plugin) => [`public/plugin/${plugin.ref.id}`, 'on' as const])) } });
    const sharedRuntime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir: path.join(await tempRoot(), 'accounts', `${ACCOUNT}-shared-budget`),
      accountPolicy: () => sharedPolicy
    });
    closers.push(() => sharedRuntime.close());
    await sharedRuntime.sync(sharedPlugins);
    const budget = { remainingMs: 2_000 };
    const sharedStarted = Date.now();
    await sharedRuntime.beforeContext(hookInput(conv(), 'shared-budget-epoch'), { budget });
    await sharedRuntime.afterTurn({ ...hookInput(conv(), 'shared-budget-epoch'), outcome: 'sent' }, { budget });
    expect(Date.now() - sharedStarted).toBeLessThan(2_350);
    expect(budget.remainingMs).toBe(0);
  });

  it('keeps one plugin task failure from removing another plugin additions', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    await runtime.sync([
      fixture('offline-demo', { ...demoShape, id: 'unsafe id', source: 'private' }),
      fixture('offline-demo', demoShape)
    ]);

    const results = await runtime.beforeContext(hookInput(conv(), 'epoch-7'));
    const byKey = new Map(results.map((entry) => [entry.pluginKey, entry.result]));
    expect(byKey.get('private/plugin/unsafe id')).toMatchObject({ status: 'failed', reason: 'invalid_plugin_state_scope' });
    expect(byKey.get('public/plugin/demo')).toMatchObject({ status: 'ok', additions: [] });
  });

  it('bounds hook context and request size before posting work to a plugin', async () => {
    const { manager } = await openManager(fixture('offline-demo', demoShape));
    const conversation = conv();

    const tooMany = await manager.beforeContext({
      ...hookInput(conversation, 'epoch-1'),
      history: Array.from({ length: PLUGIN_RUNTIME_LIMITS.maxHistoryItems + 1 }, () => ({ direction: 'in' as const, text: 'x' }))
    });
    expect(tooMany).toEqual({ status: 'unavailable', reason: 'plugin_hook_context_too_large' });

    const tooLong = await manager.beforeContext({
      ...hookInput(conversation, 'epoch-1'),
      message: { text: 'x'.repeat(PLUGIN_RUNTIME_LIMITS.maxMessageBytes + 1) }
    });
    expect(tooLong).toEqual({ status: 'unavailable', reason: 'plugin_hook_context_too_large' });

    const oversized = await manager.callTool({
      conversation,
      contextEpoch: 'epoch-1',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'x'.repeat(PLUGIN_RUNTIME_LIMITS.maxRequestBytes) }
    });
    expect(oversized).toMatchObject({ status: 'error', errorCode: 'plugin_request_too_large' });
    expect(manager.terminated).toBe(false);
  });
});

describe('plugin tasks through the unified executor', () => {
  function batchContext(overrides: Partial<ToolBatchContext> = {}): ToolBatchContext {
    return {
      accountId: ACCOUNT,
      conversation: conv(),
      messageId: 'm1',
      turn: 0,
      toolIdsByModelName: new Map([
        ['p_public_demo_remember', 'public/plugin/demo/remember'],
        ['p_public_demo_recall', 'public/plugin/demo/recall']
      ]),
      signal: new AbortController().signal,
      contextEpoch: 'epoch-7',
      ...overrides
    };
  }

  async function setup() {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    await runtime.sync([fixture('offline-demo', demoShape)]);

    const registry = new ExtensionRegistry();
    registry.registerTool({
      id: 'public/plugin/demo/remember',
      description: 'Remember a bounded note.',
      inputSchema: ARGS_SCHEMA,
      effect: 'action',
      timeoutMs: 2_000
    });
    registry.registerTool({
      id: 'public/plugin/demo/recall',
      description: 'Recall a bounded note.',
      inputSchema: ARGS_SCHEMA,
      effect: 'read',
      timeoutMs: 2_000
    });
    const executor = new ToolExecutor({
      view: () => ({
        tools: registry.listTools(),
        authorized: new Set(['public/plugin/demo/remember', 'public/plugin/demo/recall'])
      }),
      handlers: runtime.handlers(),
      accountDir: () => accountDir,
      logger: silentLogger('extension-runtime-test'),
      limits: { drainTimeoutMs: 50 }
    });
    closers.push(() => executor.close());
    return { executor, runtime, accountDir };
  }

  it('executes a plugin action, records the ledger and reads the persisted state back', async () => {
    const { executor, accountDir } = await setup();
    const write = await executor.executeBatch(
      [{ callId: 'c1', name: 'p_public_demo_remember', arguments: { key: 'k-secret', note: 'v-secret' } }],
      batchContext()
    );
    expect(write.preflightFailed).toBe(false);
    expect(write.results[0]).toMatchObject({ invocationId: 'c1', status: 'ok', text: '已记住 k-secret' });

    const ledgerRaw = await fs.readFile(path.join(accountDir, 'state', 'tool-invocations.json'), 'utf8');
    expect(ledgerRaw).toContain('public/plugin/demo/remember');
    expect(ledgerRaw).not.toContain('v-secret');

    const read = await executor.executeBatch(
      [{ callId: 'c2', name: 'p_public_demo_recall', arguments: { key: 'k-secret' } }],
      batchContext({ messageId: 'm2' })
    );
    expect(read.results[0]).toMatchObject({ invocationId: 'c2', status: 'ok', text: 'v-secret' });
  });

  it('skips plugin actions queued behind a task when timeout, abort, close or guard invalidates them', async () => {
    const plugin = await inlinePlugin('queued', 'public', `
      export async function beforeContext(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 140));
        ctx.state.holds = (ctx.state.holds ?? 0) + 1;
        return { additions: [] };
      }
      export const tools = {
        remember(args, ctx) {
          ctx.state.actionCount = (ctx.state.actionCount ?? 0) + 1;
          return { status: 'ok', text: 'action ran' };
        }
      }`, {
      tools: [toolDeclaration('remember', 'action', 1_000)],
      hooks: [hookDeclaration('beforeContext', 1_000)]
    });
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    await runtime.sync([plugin]);
    const state = new PluginStateService(accountDir);
    const toolId = 'public/plugin/queued/remember';
    const registry = new ExtensionRegistry();
    registry.registerTool({
      id: toolId,
      description: 'Count a queued action.',
      inputSchema: ARGS_SCHEMA,
      effect: 'action',
      timeoutMs: 1_000
    });
    const epoch = 'binding:revision:role:artifact';

    for (const mode of ['timeout', 'abort', 'guard', 'authorization', 'close'] as const) {
      const controller = new AbortController();
      let allowed = true;
      let authorized = true;
      const executor = new ToolExecutor({
        view: () => ({ tools: registry.listTools(), authorized: authorized ? new Set([toolId]) : new Set() }),
        handlers: runtime.handlers(),
        accountDir: () => accountDir,
        logger: silentLogger('extension-runtime-test'),
        limits: { toolTimeoutMs: mode === 'timeout' ? 35 : 600, drainTimeoutMs: 20 }
      });
      const hold = runtime.beforeContext(hookInput(conv(), epoch, `hold-${mode}`));
      await sleep(5);
      const execution = executor.executeBatch([{ callId: `queued-${mode}`, name: 'queued_action', arguments: { key: mode } }], {
        accountId: ACCOUNT,
        conversation: conv(),
        messageId: `m-${mode}`,
        turn: 0,
        toolIdsByModelName: new Map([['queued_action', toolId]]),
        signal: controller.signal,
        contextEpoch: epoch,
        guard: () => allowed
      });
      if (mode === 'abort') setTimeout(() => controller.abort(), 10);
      if (mode === 'guard') setTimeout(() => { allowed = false; }, 10);
      if (mode === 'authorization') setTimeout(() => { authorized = false; }, 10);
      if (mode === 'close') {
        await sleep(10);
        await executor.close();
      }
      const result = await execution;
      await hold;
      await sleep(20);
      if (mode !== 'close') await executor.close();
      expect(result.results[0]?.status).not.toBe('ok');
      const persisted = await state.read(scopeOf(plugin, conv(), epoch, false), '1');
      expect(persisted).toMatchObject({ status: 'ready' });
      expect(persisted.status === 'ready' ? persisted.state.actionCount : undefined).toBeUndefined();
    }
  });

  it('replays a ledger hit and refuses work once the plugin generation is gone', async () => {
    const { executor, runtime } = await setup();
    const calls: ToolCallRequest[] = [{ callId: 'c1', name: 'p_public_demo_remember', arguments: { key: 'replay', note: 'once' } }];
    const first = await executor.executeBatch(calls, batchContext());
    const replay = await executor.executeBatch(calls, batchContext());
    expect(first.results[0]?.status).toBe('ok');
    expect(replay).toMatchObject({ executed: 0, replayed: 1 });
    expect(replay.results[0]).toMatchObject({ status: 'ok', text: '已记住 replay' });

    await runtime.close();
    const afterClose = await executor.executeBatch(
      [{ callId: 'c2', name: 'p_public_demo_remember', arguments: { key: 'after', note: 'closed' } }],
      batchContext({ messageId: 'm3' })
    );
    expect(afterClose.results[0]).toMatchObject({ status: 'error', errorCode: 'handler_not_ready' });
  });

  it('terminates the plugin generation after an internal handler timeout and discards late work', async () => {
    const plugin = fixture('hanging', { id: 'hanging', tools: [toolDeclaration('remember', 'action', 200)] });
    const { manager, state } = await openManager(plugin);
    const conversation = conv();

    const timedOut = await manager.callTool({
      conversation,
      contextEpoch: 'role-binding:public:role-card:rev-4:catalog-2',
      invocationId: 'i1',
      toolId: 'public/plugin/hanging/remember',
      args: { key: 'late', note: 'x', delayMs: 450 },
      deadlineAt: Date.now() + 5_000
    });
    expect(timedOut).toMatchObject({ status: 'unknown', errorCode: 'plugin_handler_timeout' });
    expect(manager.terminated).toBe(true);

    await sleep(500);
    const after = await state.read(scopeOf(plugin, conversation, 'role-binding:public:role-card:rev-4:catalog-2', false), '1');
    expect(after.status).toBe('missing');

    await expect(manager.callTool({
      conversation,
      contextEpoch: 'role-binding:public:role-card:rev-4:catalog-2',
      invocationId: 'i2',
      toolId: 'public/plugin/hanging/remember',
      args: { key: 'now', note: 'y', delayMs: 0 }
    })).rejects.toMatchObject({ code: 'plugin_runtime_terminated' });

    const healthy = await openManager(fixture('offline-demo', { ...demoShape, id: 'demo' }));
    const unaffected = await healthy.manager.callTool({
      conversation,
      contextEpoch: 'role-binding:public:role-card:rev-4:catalog-2',
      invocationId: 'i3',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'ok', note: 'unaffected' }
    });
    expect(unaffected).toMatchObject({ status: 'ok' });
  });

  it('does not return a submitted job when the plugin state commit fails', async () => {
    const plugin = await inlinePlugin('submitted', 'public', `
      export const tools = {
        submit(args, ctx) {
          ctx.state.count = (ctx.state.count ?? 0) + 1;
          return { status: 'submitted', text: 'job accepted', jobId: 'private-job-id' };
        }
      }`, { tools: [toolDeclaration('submit', 'action')] });
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const state = new PluginStateService(accountDir);
    const manager = new PluginWorkerManager(plugin, {
      accountId: ACCOUNT,
      state,
      logger: silentLogger('extension-runtime-test'),
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => manager.stop());
    await manager.start();
    Object.defineProperty(state, 'write', { value: async () => { throw new Error('injected state commit failure'); } });

    const result = await manager.callTool({
      conversation: conv(),
      contextEpoch: 'binding:rev:role:artifact',
      invocationId: 'submit-once',
      toolId: 'public/plugin/submitted/submit',
      args: { key: 'work' }
    });
    expect(result).toMatchObject({ status: 'unknown', errorCode: 'plugin_state_write_failed' });
    expect(result).not.toHaveProperty('jobId');
  });

  it('returns unknown when a dispatched action is interrupted by a revoked guard', async () => {
    const root = await tempRoot();
    const markerPath = path.join(root, 'action-started.marker');
    const original = await inlinePlugin('running-guard', 'public', `
      import { writeFile } from 'node:fs/promises';
      export const tools = {
        async submit(args, ctx) {
          await writeFile(ctx.config.markerPath, 'started', 'utf8');
          ctx.state.count = (ctx.state.count ?? 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { status: 'submitted', text: 'job accepted', jobId: 'must-not-escape' };
        }
      }`, { tools: [toolDeclaration('submit', 'action', 1_000)] });
    const plugin = { ...original, config: { markerPath } };
    const accountDir = path.join(root, 'accounts', ACCOUNT);
    const state = new PluginStateService(accountDir);
    const manager = new PluginWorkerManager(plugin, {
      accountId: ACCOUNT,
      state,
      logger: silentLogger('extension-runtime-test'),
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => manager.stop());
    await manager.start();

    const toolId = 'public/plugin/running-guard/submit';
    const registry = new ExtensionRegistry();
    registry.registerTool({
      id: toolId,
      description: 'Submit a guarded action.',
      inputSchema: ARGS_SCHEMA,
      effect: 'action',
      timeoutMs: 1_500
    });
    const executor = new ToolExecutor({
      view: () => ({ tools: registry.listTools(), authorized: new Set([toolId]) }),
      handlers: (id) => id === toolId ? manager.toolBinding(id) : undefined,
      accountDir: () => accountDir,
      logger: silentLogger('extension-runtime-test'),
      limits: { toolTimeoutMs: 1_500 }
    });
    closers.push(() => executor.close());
    let allowed = true;
    const execution = executor.executeBatch([{ callId: 'running-guard', name: 'submit_job', arguments: { key: 'guarded' } }], {
      accountId: ACCOUNT,
      conversation: conv(),
      messageId: 'm-running-guard',
      turn: 0,
      toolIdsByModelName: new Map([['submit_job', toolId]]),
      signal: new AbortController().signal,
      contextEpoch: 'role-binding:public:card:rev-8:catalog-2',
      guard: () => allowed
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fs.access(markerPath);
        break;
      } catch {
        await sleep(10);
      }
    }
    expect(await fs.readFile(markerPath, 'utf8')).toBe('started');
    allowed = false;

    const result = await execution;
    expect(result.results[0]).toMatchObject({ status: 'unknown', errorCode: 'plugin_execution_guard_changed' });
    expect(result.results[0]).not.toHaveProperty('jobId');
    expect(manager.terminated).toBe(true);
    const persisted = await state.read(scopeOf(plugin, conv(), 'role-binding:public:card:rev-8:catalog-2', false), '1');
    expect(persisted.status).toBe('missing');

    const ledgerPath = path.join(accountDir, 'state', 'tool-invocations.json');
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as { entries: Array<{ status: string; result?: { jobId?: string; text?: string } }> };
    expect(ledger.entries[0]).toMatchObject({ status: 'unknown', result: { status: 'unknown' } });
    expect(ledger.entries[0]?.result).not.toHaveProperty('jobId');
    expect(JSON.stringify(ledger)).not.toContain('must-not-escape');
  });

  it('terminates a generation that blocks past the host deadline and stops later work', async () => {
    const plugin = fixture('blocking', { id: 'blocking', tools: [toolDeclaration('remember', 'action', 30)] });
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const state = new PluginStateService(accountDir);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy(),
      limits: { timeoutGraceMs: 0 }
    });
    closers.push(() => runtime.close());
    await runtime.sync([
      plugin,
      fixture('offline-demo', demoShape)
    ]);

    const blocked = await invokeHandler(runtime, 'public/plugin/blocking/remember', { key: 'spin', blockMs: 600 }, {
      invocationId: 'i1',
      contextEpoch: 'epoch-6'
    });
    expect(blocked).toMatchObject({ status: 'unknown', errorCode: 'plugin_timeout' });
    expect(runtime.handlers()('public/plugin/blocking/remember')).toBeUndefined();
    expect([...runtime.readyTools()]).not.toContain('public/plugin/blocking/remember');

    const healthy = await invokeHandler(runtime, 'public/plugin/demo/remember', { key: 'still', note: 'works' }, {
      invocationId: 'i2',
      contextEpoch: 'epoch-6'
    });
    expect(healthy).toMatchObject({ status: 'ok' });

    await sleep(700);
    expect(await state.read(scopeOf(plugin, conv(), 'epoch-6', false), '1')).toMatchObject({ status: 'missing' });
  });
});

describe('plugin reply identity', () => {
  async function forged(mode: 'identity' | 'scope' | 'stale' | 'tokenless') {
    const plugin = fixture('forged', {
      id: 'forged',
      tools: [toolDeclaration('remember', 'action')],
      config: { mode }
    });
    const { manager, state } = await openManager(plugin);
    const outcome = await manager.callTool({
      conversation: conv(),
      contextEpoch: 'epoch-2',
      invocationId: 'i1',
      toolId: 'public/plugin/forged/remember',
      args: { key: 'forge' }
    });
    return { plugin, manager, state, outcome };
  }

  it('rejects a reply that forges account, plugin key or generation', async () => {
    const { manager, state, plugin, outcome } = await forged('identity');
    expect(outcome).toMatchObject({ status: 'unknown', errorCode: 'plugin_protocol_mismatch' });
    expect(manager.terminated).toBe(true);
    expect(await state.read(scopeOf(plugin, conv(), 'epoch-2', false), '1')).toMatchObject({ status: 'missing' });
  });

  it('rejects a reply that carries a foreign scope token', async () => {
    const { manager, state, plugin, outcome } = await forged('scope');
    expect(outcome).toMatchObject({ status: 'unknown', errorCode: 'plugin_protocol_mismatch' });
    expect(manager.terminated).toBe(true);
    expect(await state.read(scopeOf(plugin, conv(), 'epoch-2', false), '1')).toMatchObject({ status: 'missing' });
  });

  it('rejects a reply that omits the scope token instead of assuming the request scope', async () => {
    const { manager, state, plugin, outcome } = await forged('tokenless');
    expect(outcome).toMatchObject({ status: 'unknown', errorCode: 'plugin_protocol_mismatch' });
    expect(manager.terminated).toBe(true);
    expect(await state.read(scopeOf(plugin, conv(), 'epoch-2', false), '1')).toMatchObject({ status: 'missing' });
  });

  it('discards a reply for an unknown request id and keeps the real result', async () => {
    const { manager, state, plugin, outcome } = await forged('stale');
    expect(outcome).toMatchObject({ status: 'ok', text: 'real reply' });
    expect(manager.terminated).toBe(false);
    const persisted = await state.read(scopeOf(plugin, conv(), 'epoch-2', false), '1');
    expect(persisted.status).toBe('missing');
  });
});

describe('plugin runtime isolation and lifecycle', () => {
  it('keeps same-id public and private plugins apart inside one account', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    await runtime.sync([
      fixture('offline-demo', { ...demoShape, source: 'public' }),
      fixture('offline-demo', { ...demoShape, source: 'private' })
    ]);

    const store = new PluginStateService(accountDir);
    const conversation = conv();
    expect(await store.read(scopeOfSource('public', conversation, 'epoch-1', false), '1')).toMatchObject({ status: 'missing' });

    const writePublic = await invokeHandler(runtime, 'public/plugin/demo/remember', { key: 'scope', note: 'public-value' }, {
      invocationId: 'i1',
      contextEpoch: 'epoch-1'
    });
    expect(writePublic).toMatchObject({ status: 'ok' });

    const readPrivate = await invokeHandler(runtime, 'private/plugin/demo/recall', { key: 'scope' }, {
      invocationId: 'i2',
      contextEpoch: 'epoch-1',
      effect: 'read'
    });
    expect(readPrivate).toMatchObject({ status: 'ok', text: '(none)', data: { total: 0 } });

    const readOwnPublic = await invokeHandler(runtime, 'public/plugin/demo/recall', { key: 'scope' }, {
      invocationId: 'i3',
      contextEpoch: 'epoch-1',
      effect: 'read'
    });
    expect(readOwnPublic).toMatchObject({ status: 'ok', text: 'public-value' });

    expect(await store.read(scopeOfSource('public', conversation, 'epoch-1', false), '1')).toMatchObject({ status: 'ready' });
    expect(await store.read(scopeOfSource('private', conversation, 'epoch-1', false), '1')).toMatchObject({ status: 'missing' });
    expect(await exists(path.join(accountDir, 'plugin-state', 'private', 'demo'))).toBe(false);
    expect(runtime.readyPlugins()).toEqual(new Set(['public/plugin/demo', 'private/plugin/demo']));
  });

  it('keeps per-account plugin state and handlers separate for the same artifact', async () => {
    const root = await tempRoot();
    const first = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir: path.join(root, 'accounts', ACCOUNT),
      accountPolicy: () => accountPolicy()
    });
    const second = new AccountPluginRuntime({
      accountId: '10002',
      logger: silentLogger('extension-runtime-test'),
      accountDir: path.join(root, 'accounts', '10002'),
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => first.close(), () => second.close());
    await first.sync([fixture('offline-demo', demoShape)]);
    await second.sync([fixture('offline-demo', demoShape)]);
    expect(first.handlers()('public/plugin/demo/remember')?.generation)
      .not.toBe(second.handlers()('public/plugin/demo/remember')?.generation);

    const writeFirst = await invokeHandler(first, 'public/plugin/demo/remember', { key: 'tea', note: 'account-a' }, {
      accountId: ACCOUNT,
      invocationId: 'i1',
      contextEpoch: 'epoch-1'
    });
    expect(writeFirst).toMatchObject({ status: 'ok' });

    const readSecond = await invokeHandler(second, 'public/plugin/demo/recall', { key: 'tea' }, {
      accountId: '10002',
      invocationId: 'i2',
      contextEpoch: 'epoch-1',
      effect: 'read'
    });
    expect(readSecond).toMatchObject({ status: 'ok', text: '(none)', data: { total: 0 } });

    const publicState = new PluginStateService(path.join(root, 'accounts', ACCOUNT));
    expect(await exists(publicState.filePath(scopeOfSource('public', conv(), 'epoch-1', false)))).toBe(true);
    expect(await exists(path.join(root, 'accounts', '10002', 'plugin-state'))).toBe(false);
  });

  it('replaces the worker on a new revision while keeping the persisted namespace', async () => {
    const accountDir = path.join(await tempRoot(), 'accounts', ACCOUNT);
    const runtime = new AccountPluginRuntime({
      accountId: ACCOUNT,
      logger: silentLogger('extension-runtime-test'),
      accountDir,
      accountPolicy: () => accountPolicy()
    });
    closers.push(() => runtime.close());
    const firstSync = await runtime.sync([fixture('offline-demo', { ...demoShape, revision: 'r1' })]);
    const generation = runtime.handlers()('public/plugin/demo/remember')?.generation;
    expect(firstSync[0]).toMatchObject({ pluginKey: 'public/plugin/demo', revision: 'r1', ready: true });

    const remembered = await invokeHandler(runtime, 'public/plugin/demo/remember', { key: 'across', note: 'revision switch' }, {
      invocationId: 'i1',
      contextEpoch: 'epoch-3'
    });
    expect(remembered).toMatchObject({ status: 'ok' });
    const hookRun = await runtime.beforeContext(hookInput(conv(), 'epoch-3'));
    expect(hookRun[0]?.result.status === 'ok' ? hookRun[0]?.result.additions : undefined)
      .toEqual([{ source: 'offline-demo', text: 'offline notes=1 last=across:revision switch scope=private/42/epoch-3/shared=false' }]);

    const secondSync = await runtime.sync([fixture('offline-demo', { ...demoShape, revision: 'r2' })]);
    expect(secondSync[0]).toMatchObject({ revision: 'r2', ready: true });
    expect(runtime.handlers()('public/plugin/demo/remember')?.generation).not.toBe(generation);

    const afterUpgrade = await invokeHandler(runtime, 'public/plugin/demo/recall', { key: 'across' }, {
      invocationId: 'i9',
      contextEpoch: 'epoch-3',
      effect: 'read'
    });
    expect(afterUpgrade).toMatchObject({ status: 'ok', text: 'revision switch', data: { total: 1 } });
  });

  it('stops cleanly and hands persisted state to the next generation', async () => {
    const plugin = fixture('offline-demo', demoShape);
    const { manager, accountDir } = await openManager(plugin);
    const remembered = await manager.callTool({
      conversation: conv(),
      contextEpoch: 'epoch-11',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'keep', note: 'across generations' }
    });
    expect(remembered.status).toBe('ok');
    await manager.stop();
    expect(manager.terminated).toBe(true);
    await expect(manager.callTool({
      conversation: conv(),
      contextEpoch: 'epoch-11',
      invocationId: 'i2',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'keep' }
    })).rejects.toMatchObject({ code: 'plugin_runtime_terminated' });

    const reopened = await openManager(plugin, { accountDir });
    const recalled = await reopened.manager.callTool({
      conversation: conv(),
      contextEpoch: 'epoch-11',
      invocationId: 'i3',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'keep' }
    });
    expect(recalled).toMatchObject({ status: 'ok', text: 'across generations' });
  });

  it('surfaces a handler failure without dropping the earlier state write', async () => {
    const { manager } = await openManager(fixture('offline-demo', demoShape));
    const conversation = conv();
    await manager.callTool({
      conversation,
      contextEpoch: 'epoch-12',
      invocationId: 'i1',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'first', note: 'kept' }
    });
    const failed = await manager.callTool({
      conversation,
      contextEpoch: 'epoch-12',
      invocationId: 'i2',
      toolId: 'public/plugin/demo/remember',
      args: { key: 'second', note: 'refused', refuse: true }
    });
    expect(failed).toMatchObject({ status: 'error', errorCode: 'plugin_handler_failed' });

    const recalled = await manager.callTool({
      conversation,
      contextEpoch: 'epoch-12',
      invocationId: 'i3',
      toolId: 'public/plugin/demo/recall',
      args: { key: 'first' }
    });
    expect(recalled).toMatchObject({ status: 'ok', text: 'kept', data: { total: 1 } });
  });
});
