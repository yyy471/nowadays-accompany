import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import type { Limits } from '../src/core/limits.js';
import { messageText, textMessage } from '../src/routing/message.js';
import type { AgentHost, AgentMessageContext } from '../src/host/contract.js';
import { textInbound, waitFor } from './phase1-helpers.js';

// Independent reviewer scenarios deliberately bypass createTestCore/default-card fixtures.
const roots: string[] = [];
const running: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFixture(onMessage: AgentHost['onMessage'], limits?: Partial<Limits>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-independent-'));
  roots.push(root);
  for (const [id, content] of [['a', 'ROLE_A'], ['b', 'ROLE_B']]) {
    const dir = path.join(root, 'public', 'artifacts', 'role-card', id!, 'r1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, kind: 'role-card', revision: 'r1', content }));
  }
  await fs.writeFile(path.join(root, 'public', 'catalog.json'), JSON.stringify({ version: 1, artifacts: { 'role-card:a': 'r1', 'role-card:b': 'r1' } }));
  const channels = new Map<string, FakeChannel>();
  const start = async (): Promise<Core> => {
    const core = await createCore({
      dataRoot: root,
      instances: [{ id: 'one', backend: 'fake', accountId: '10001' }, { id: 'two', backend: 'fake', accountId: '10002' }],
      channelFactory: (context) => {
        const channel = new FakeChannel(context);
        channels.set(context.instanceId, channel);
        return channel;
      },
      hostFactory: () => ({ onMessage }),
      ...(limits ? { limits } : {}),
      logger: silentLogger('independent-acceptance')
    });
    running.push(core);
    await core.start();
    await waitFor(() => core.status().instances.every((instance) => instance.state === 'online'));
    return core;
  };
  return { root, channels, start, core: await start() };
}

async function drained(core: Core): Promise<void> {
  await waitFor(() => core.status().instances.every((instance) => (instance.ingress?.pending ?? 0) === 0));
}

const card = (id: string) => ({ source: 'public' as const, id, revision: 'r1' });

describe('independent development acceptance', () => {
  it('starts without an account role card and records unbound messages without running a host', async () => {
    let calls = 0;
    const { core, channels } = await createFixture(() => { calls += 1; return textMessage('must not send'); });
    expect(await core.getAccountProfile('10001')).toBeUndefined();
    channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'unbound-1', 'unbound input'));
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '77' };
    await waitFor(async () => (await core.readMessages('10001', conversation)).length === 1);
    await drained(core);
    expect(calls).toBe(0);
    expect(channels.get('one')!.sent).toHaveLength(0);
  });

  it('resolves different explicit cards for equal peer numbers across kind and account', async () => {
    const observed: Array<{ account: string; kind: string; card: string }> = [];
    const { core, channels } = await createFixture((context) => {
      observed.push({ account: context.conversation.accountId, kind: context.conversation.kind, card: context.roleBinding!.card.content });
      return textMessage(context.roleBinding!.card.content);
    });
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'group', peerId: '77' }, card('a'));
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '77' }, card('b'));
    await core.setConversationRoleBinding({ accountId: '10002', kind: 'private', peerId: '77' }, card('a'));
    channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'group-1', 'group input', 'group'));
    channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'private-1', 'private input'));
    channels.get('two')!.emitInbound(textInbound('two', '10002', '77', 'other-account-1', 'other input'));
    await waitFor(() => observed.length === 3 && channels.get('one')!.sent.length === 2 && channels.get('two')!.sent.length === 1);
    expect(observed).toEqual(expect.arrayContaining([
      { account: '10001', kind: 'group', card: 'ROLE_A' },
      { account: '10001', kind: 'private', card: 'ROLE_B' },
      { account: '10002', kind: 'private', card: 'ROLE_A' }
    ]));
    expect(channels.get('one')!.sent.every((entry) => entry.conversation.accountId === '10001')).toBe(true);
    expect(channels.get('two')!.sent[0]!.conversation.accountId).toBe('10002');
  });

  it('does not deliver a host result after its role was unbound', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const { core, channels } = await createFixture(async () => { entered = true; await gate; return textMessage('stale role reply'); });
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '77' };
    await core.setConversationRoleBinding(conversation, card('a'));
    channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'late-1', 'wait for a reply'));
    await waitFor(() => entered);
    await core.setConversationRoleBinding(conversation, null);
    release();
    await drained(core);
    expect(channels.get('one')!.sent).toHaveLength(0);
  });

  it('revalidates a role after an automatic reply has waited for the outbound rate limiter', async () => {
    let entered = false;
    const { core, channels } = await createFixture(() => { entered = true; return textMessage('queued old role'); }, { sendRatePerSecond: 1, sendBurst: 1 });
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '77' };
    await core.setConversationRoleBinding(conversation, card('a'));
    await core.send('one', conversation, textMessage('manual rate-limit primer'));
    channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'queued-old-role', 'reply under role A'));
    await waitFor(() => entered && (core.status().instances.find((instance) => instance.id === 'one')?.egress?.pending ?? 0) > 0);
    await core.setConversationRoleBinding(conversation, card('b'));
    await drained(core);
    expect(channels.get('one')!.sent).toHaveLength(1);
    expect(messageText(channels.get('one')!.sent[0]!.message.segments)).toBe('manual rate-limit primer');
  });

  it('keeps the same explicit role context across a clean restart', async () => {
    const histories: string[] = [];
    const onMessage = async (context: AgentMessageContext) => {
      const records = await context.history({ beforeSeq: context.sequence });
      histories.push(records.map((record) => messageText(record.segments)).join('\n'));
      return textMessage('persisted response');
    };
    const fixture = await createFixture(onMessage);
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '77' };
    await fixture.core.setConversationRoleBinding(conversation, card('a'));
    fixture.channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'before-restart', 'remember before restart'));
    await waitFor(() => fixture.channels.get('one')!.sent.length === 1);
    await fixture.core.stop();
    const restarted = await fixture.start();
    fixture.channels.get('one')!.emitInbound(textInbound('one', '10001', '77', 'after-restart', 'continue after restart'));
    await waitFor(() => fixture.channels.get('one')!.sent.length === 1);
    await drained(restarted);
    expect(histories).toHaveLength(2);
    expect(histories[0]).not.toContain('remember before restart');
    expect(histories[1]).toContain('remember before restart');
    expect(histories[1]).toContain('persisted response');
  });

  it('changes follow-current context on deploy and rollback, while preserving the new epoch on restart', async () => {
    const fixture = await createFixture(() => undefined);
    const conversation = { accountId: '10001', kind: 'private' as const, peerId: '77' };
    await fixture.core.setConversationRoleBinding(conversation, { source: 'public', id: 'a' });
    const initial = await fixture.core.resolveConversationRoleBinding('10001', conversation);
    const dir = path.join(fixture.root, 'public', 'artifacts', 'role-card', 'a', 'r2');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'a', kind: 'role-card', revision: 'r2', content: 'ROLE_A_V2' }));
    await fixture.core.deployArtifact('role-card', 'a', 'r2');
    const updated = await fixture.core.resolveConversationRoleBinding('10001', conversation);
    expect(updated!.card.content).toBe('ROLE_A_V2');
    expect(updated!.revision).not.toBe(initial!.revision);
    await fixture.core.rollbackArtifacts();
    const rolledBack = await fixture.core.resolveConversationRoleBinding('10001', conversation);
    expect(rolledBack!.card.content).toBe('ROLE_A');
    expect(rolledBack!.revision).not.toBe(initial!.revision);
    expect(rolledBack!.revision).not.toBe(updated!.revision);
    await fixture.core.stop();
    const restarted = await fixture.start();
    expect((await restarted.resolveConversationRoleBinding('10001', conversation))!.revision).toBe(rolledBack!.revision);
  });
});
