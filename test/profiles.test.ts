import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { createCore } from '../src/core/core.js';
import { seedRoleCard, TEST_ROLE_CARD_CONTENT, TEST_ROLE_CARD_ID, TEST_ROLE_CARD_REVISION } from './helpers.js';
import type { ChannelFactory } from '../src/channels/contract.js';
import type { CoreEvents } from '../src/core/events.js';
import { textMessage } from '../src/routing/message.js';

const roots: string[] = [];
const cores: Core[] = [];

const ECHO_PLUGIN = String.raw`
export async function onSessionStart(ctx) {
  ctx.state.starts = (ctx.state.starts ?? 0) + 1;
}
export async function onMessage(ctx) {
  const count = (ctx.state.count ?? 0) + 1;
  ctx.state.count = count;
  ctx.state.historySeen = ctx.history.length;
  const text = (ctx.message.segments.find((segment) => segment.type === 'text')?.data?.text) ?? '';
  ctx.send({ segments: [{ type: 'text', data: { text: 'extra-' + count } }] });
  return { segments: [{ type: 'text', data: { text: ctx.profile.roleCard.content + '|' + text + '|' + count } }] };
}
`;

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function channels(bucket: Map<string, FakeChannel>): ChannelFactory {
  return (context) => {
    const channel = new FakeChannel(context, { selfId: context.spec.accountId ?? '10001' });
    bucket.set(context.instanceId, channel);
    return channel;
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met in time');
}

async function writeProfile(
  root: string,
  accountId: string,
  profile: Record<string, unknown>
): Promise<void> {
  const dir = path.join(root, 'accounts', accountId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`);
}

async function seedRoleCardRevision(root: string, revision: string, content: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'role-card', TEST_ROLE_CARD_ID, revision);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ id: TEST_ROLE_CARD_ID, kind: 'role-card', revision, content }, null, 2)}\n`
  );
}

async function setCatalog(root: string, key: string, revision: string): Promise<void> {
  const file = path.join(root, 'public', 'catalog.json');
  let catalog: { version: number; artifacts: Record<string, string> } = { version: 1, artifacts: {} };
  try {
    catalog = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // 首次写入
  }
  catalog.artifacts[key] = revision;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(catalog, null, 2)}\n`);
}

async function seedPlugin(root: string, id: string, source: string, revision = 'r1'): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'plugin', id, revision);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ id, kind: 'plugin', revision, entry: `${id}.mjs`, apiVersion: 1 }, null, 2)}\n`
  );
  await fs.writeFile(path.join(dir, `${id}.mjs`), source);
  await setCatalog(root, `plugin:${id}`, revision);
}

async function seedEchoPlugin(root: string): Promise<void> {
  await seedPlugin(root, 'echo', ECHO_PLUGIN);
}

describe('account profiles and plugin hosts', () => {
  it('persists stable role-context generations across restarts and advances them on deploy and rollback', async () => {
    const root = await tempRoot('accompany-role-generation-');
    await seedRoleCard(root);
    await seedRoleCardRevision(root, 'r2', 'version two');
    const options = { dataRoot: root, instances: [], logger: silentLogger() };
    const firstCore = await createCore(options);
    cores.push(firstCore);
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '555' };
    await firstCore.setConversationRoleBinding(conversation, { source: 'public', id: TEST_ROLE_CARD_ID });
    const first = await firstCore.resolveConversationRoleBinding('10001', conversation);
    expect(first).toBeDefined();
    await firstCore.stop();

    const restarted = await createCore(options);
    cores.push(restarted);
    const afterRestart = await restarted.resolveConversationRoleBinding('10001', conversation);
    expect(afterRestart?.revision).toBe(first?.revision);

    await restarted.deployArtifact('role-card', TEST_ROLE_CARD_ID, 'r2');
    const rolledForward = await restarted.resolveConversationRoleBinding('10001', conversation);
    expect(rolledForward?.revision).not.toBe(afterRestart?.revision);
    expect(rolledForward?.card.ref.revision).toBe('r2');

    await restarted.rollbackArtifacts();
    const rolledBack = await restarted.resolveConversationRoleBinding('10001', conversation);
    expect(rolledBack?.card.ref.revision).toBe(TEST_ROLE_CARD_REVISION);
    expect(rolledBack?.revision).not.toBe(afterRestart?.revision);
    expect(rolledBack?.revision).not.toBe(rolledForward?.revision);
  });

  it('starts without an account role card and keeps unbound conversations silent', async () => {
    const root = await tempRoot('accompany-profile-gate-');
    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);

    await core.start();
    expect(core.status().instances[0]).toMatchObject({
      state: 'online',
      accountId: '10001',
      profileState: 'ready'
    });
    expect(bucket.get('main')?.sent).toHaveLength(0);
    // 查询/启动不会为未知账号偷偷创建目录；保存资料时才创建。
    await expect(fs.access(path.join(root, 'accounts', '10001'))).rejects.toThrow();

    const saved = await core.saveAccountProfile('10001', {
      version: 1,
      plugins: []
    });
    expect(saved.reload).toEqual({ ok: true });
    await expect(fs.access(path.join(root, 'accounts', '10001'))).resolves.toBeUndefined();
    await waitFor(() => core.status().instances[0]?.state === 'online');
    expect(core.status().instances[0]).toMatchObject({ state: 'online', profileState: 'ready' });

    bucket.get('main')?.emitInbound({
      type: 'message', instanceId: 'main', selfId: '10001', kind: 'private', peerId: '555', senderId: '555',
      messageId: 'unbound', at: 1, segments: [{ type: 'text', data: { text: 'hello' } }], selfEcho: false
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bucket.get('main')?.sent).toHaveLength(0);

    await core.send('main', { accountId: '10001', kind: 'private', peerId: '555' }, textMessage('hello'));
    expect(bucket.get('main')?.sent).toHaveLength(1);
  });

  it('treats a malformed account profile as not ready instead of entering a restart loop', async () => {
    const root = await tempRoot('accompany-profile-invalid-');
    await writeProfile(root, '10001', { version: 2, plugins: [] });
    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.start();

    const status = core.status().instances[0];
    expect(status).toMatchObject({ state: 'awaiting_profile', profileState: 'missing' });
    expect(status?.profileError).toMatch(/version/);
  });

  it('passes the selected conversation role to each worker message with scoped state', async () => {
    const root = await tempRoot('accompany-worker-');
    await seedRoleCard(root);
    await seedEchoPlugin(root);
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [{ source: 'public', id: 'echo' }]
    });

    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'public', id: TEST_ROLE_CARD_ID });
    await core.start();
    expect(core.status().instances[0]?.state).toBe('online');

    const channel = bucket.get('main');
    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'p1',
      at: 1,
      segments: [{ type: 'text', data: { text: 'ping' } }],
      selfEcho: false
    });
    await waitFor(() => (channel?.sent.length ?? 0) === 2);
    expect(channel?.sent.map((item) => item.message.segments)).toEqual([
      [{ type: 'text', data: { text: 'extra-1' } }],
      [{ type: 'text', data: { text: `${TEST_ROLE_CARD_CONTENT}|ping|1` } }]
    ]);

    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'p2',
      at: 2,
      segments: [{ type: 'text', data: { text: 'again' } }],
      selfEcho: false
    });
    await waitFor(() => (channel?.sent.length ?? 0) === 4);
    expect(channel?.sent[3]?.message.segments).toEqual([
      { type: 'text', data: { text: `${TEST_ROLE_CARD_CONTENT}|again|2` } }
    ]);

    const stateFile = path.join(root, 'accounts', '10001', 'plugin-state', 'echo.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      starts: number;
      count: number;
      historySeen: number;
    };
    expect(state).toMatchObject({ starts: 1, count: 2 });
    expect(state.historySeen).toBeGreaterThanOrEqual(1);
  });

  it('resolves a private role card only through an explicit conversation binding', async () => {
    const root = await tempRoot('accompany-private-card-');
    const artifactDir = path.join(root, 'accounts', '10001', 'artifacts', 'role-card', 'personal', 'r1');
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, 'manifest.json'),
      `${JSON.stringify(
        { id: 'personal', kind: 'role-card', revision: 'r1', content: 'private persona' },
        null,
        2
      )}\n`
    );
    await fs.writeFile(
      path.join(root, 'accounts', '10001', 'catalog.json'),
      `${JSON.stringify({ version: 1, artifacts: { 'role-card:personal': 'r1' } }, null, 2)}\n`
    );
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'private', id: 'personal' },
      plugins: []
    });

    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'private', id: 'personal' });
    await core.start();

    expect(core.status().instances[0]).toMatchObject({ state: 'online' });
    await expect(core.resolveConversationRoleBinding('10001', { accountId: '10001', kind: 'private', peerId: '555' }))
      .resolves.toMatchObject({ card: { ref: { source: 'private', id: 'personal', revision: 'r1' }, content: 'private persona' } });
    expect(await core.listPublicArtifacts()).toEqual([]);
  });

  it('times out a hanging plugin without blocking later plugins', async () => {
    const root = await tempRoot('accompany-plugin-timeout-');
    await seedRoleCard(root);
    await seedPlugin(root, 'hang', 'export async function onMessage() { await new Promise(() => {}); }');
    await seedPlugin(
      root,
      'fast',
      "export async function onMessage() { return { segments: [{ type: 'text', data: { text: 'fast' } }] }; }"
    );
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [
        { source: 'public', id: 'hang' },
        { source: 'public', id: 'fast' }
      ]
    });

    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      limits: { pluginTimeoutMs: 50 },
      logger: silentLogger()
    });
    cores.push(core);
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'public', id: TEST_ROLE_CARD_ID });
    await core.start();

    const channel = bucket.get('main');
    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 't1',
      at: 1,
      segments: [{ type: 'text', data: { text: 'ping' } }],
      selfEcho: false
    });
    await waitFor(() => (channel?.sent.length ?? 0) === 1);
    expect(channel?.sent[0]?.message.segments).toEqual([{ type: 'text', data: { text: 'fast' } }]);
    expect(core.status().instances[0]?.state).toBe('online');
  });

  it('isolates a crashing plugin worker and respawns for the next message', async () => {
    const root = await tempRoot('accompany-plugin-crash-');
    await seedRoleCard(root);
    const marker = path.join(root, 'crash.marker');
    await seedPlugin(
      root,
      'crasher',
      String.raw`
import fs from 'node:fs';
export async function onMessage(ctx) {
  const marker = ctx.config.marker;
  if (marker && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, '1');
    process.exit(1);
  }
  return { segments: [{ type: 'text', data: { text: 'recovered' } }] };
}
`
    );
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [{ source: 'public', id: 'crasher', config: { marker } }]
    });

    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'public', id: TEST_ROLE_CARD_ID });
    await core.start();
    const errors: CoreEvents['instance:error'][] = [];
    core.bus.on('instance:error', (event) => errors.push(event));

    const channel = bucket.get('main');
    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'crash-1',
      at: 1,
      segments: [{ type: 'text', data: { text: 'first' } }],
      selfEcho: false
    });
    await waitFor(() => errors.some((event) => event.code === 'host_failed'));
    expect(channel?.sent).toHaveLength(0);
    expect(core.status().instances[0]?.state).toBe('online');

    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'crash-2',
      at: 2,
      segments: [{ type: 'text', data: { text: 'second' } }],
      selfEcho: false
    });
    await waitFor(() => (channel?.sent.length ?? 0) === 1);
    expect(channel?.sent[0]?.message.segments).toEqual([{ type: 'text', data: { text: 'recovered' } }]);
  });

  it('rejects an in-flight turn after the bound public card rolls to a new revision', async () => {
    const root = await tempRoot('accompany-revision-pin-');
    await seedRoleCard(root);
    await seedRoleCardRevision(root, 'r2', 'version two');
    const startedMarker = path.join(root, 'slow.started');
    await seedPlugin(
      root,
      'slow',
      String.raw`
import fs from 'node:fs';
export async function onMessage(ctx) {
  if (ctx.config.marker) fs.writeFileSync(ctx.config.marker, 'started');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const text = (ctx.message.segments.find((segment) => segment.type === 'text')?.data?.text) ?? '';
  return { segments: [{ type: 'text', data: { text: text + ':' + ctx.profile.roleCard.content } }] };
}
`
    );
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [{ source: 'public', id: 'slow', config: { marker: startedMarker } }]
    });

    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'main', backend: 'fake', accountId: '10001' }],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'public', id: TEST_ROLE_CARD_ID });
    await core.start();
    const channel = bucket.get('main');

    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'pin-1',
      at: 1,
      segments: [{ type: 'text', data: { text: 'first' } }],
      selfEcho: false
    });
    await waitFor(async () => {
      try {
        await fs.access(startedMarker);
        return true;
      } catch {
        return false;
      }
    });

    const deployment = await core.deployArtifact('role-card', TEST_ROLE_CARD_ID, 'r2');
    expect(deployment.ok).toBe(true);

    channel?.emitInbound({
      type: 'message',
      instanceId: 'main',
      selfId: '10001',
      kind: 'private',
      peerId: '555',
      senderId: '555',
      messageId: 'pin-2',
      at: 2,
      segments: [{ type: 'text', data: { text: 'second' } }],
      selfEcho: false
    });

    await waitFor(() => (channel?.sent.length ?? 0) === 1);
    const texts = (channel?.sent ?? []).map(
      (item) => (item.message.segments[0] as { data?: { text?: string } } | undefined)?.data?.text
    );
    expect(texts).toEqual(['second:version two']);
    await expect(core.resolveConversationRoleBinding('10001', { accountId: '10001', kind: 'private', peerId: '555' }))
      .resolves.toMatchObject({ card: { ref: { revision: 'r2' }, content: 'version two' } });
  });

  it('keeps conversation bindings following public current revisions independently of account plugins', async () => {
    const root = await tempRoot('accompany-rollout-');
    await seedRoleCard(root);
    await seedRoleCardRevision(root, 'r2', 'version two');
    await writeProfile(root, '10001', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: []
    });
    await writeProfile(root, '10002', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: []
    });

    const bucket = new Map<string, FakeChannel>();
    const core = await createCore({
      dataRoot: root,
      instances: [
        { id: 'a', backend: 'fake', accountId: '10001' },
        { id: 'b', backend: 'fake', accountId: '10002' }
      ],
      channelFactory: channels(bucket),
      logger: silentLogger()
    });
    cores.push(core);
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'public', id: TEST_ROLE_CARD_ID });
    await core.setConversationRoleBinding({ accountId: '10002', kind: 'private', peerId: '555' }, { source: 'public', id: TEST_ROLE_CARD_ID });
    await core.start();
    expect(core.status().instances.every((item) => item.state === 'online')).toBe(true);

    // 第二个账号的档案在部署前被改坏；滚动时它应保留旧 revision。
    await writeProfile(root, '10002', {
      version: 1,
      roleCard: { source: 'public', id: TEST_ROLE_CARD_ID },
      plugins: [{ source: 'public', id: 'missing-plugin' }]
    });

    const deployment = await core.deployArtifact('role-card', TEST_ROLE_CARD_ID, 'r2');
    expect(deployment.ok).toBe(false);
    expect(deployment.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: 'a', status: 'skipped' }),
      expect.objectContaining({ instanceId: 'b', status: 'failed' })
    ]));

    const statuses = core.status().instances;
    await expect(core.resolveConversationRoleBinding('10001', { accountId: '10001', kind: 'private', peerId: '555' }))
      .resolves.toMatchObject({ card: { ref: { revision: 'r2' } } });
    await expect(core.resolveConversationRoleBinding('10002', { accountId: '10002', kind: 'private', peerId: '555' }))
      .resolves.toMatchObject({ card: { ref: { revision: 'r2' } } });
    expect(statuses.find((item) => item.id === 'b')?.state).toBe('online');

    // 回滚只更改 public catalog；显式绑定解析到恢复后的当前版本。
    const rollback = await core.rollbackArtifacts();
    expect(rollback.entries.find((entry) => entry.instanceId === 'a')?.status).toBe('skipped');
    await expect(core.resolveConversationRoleBinding('10001', { accountId: '10001', kind: 'private', peerId: '555' }))
      .resolves.toMatchObject({ card: { ref: { revision: TEST_ROLE_CARD_REVISION } } });
  });
});
