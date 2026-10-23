import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { createTestCore } from './helpers.js';

const roots: string[] = [];
const cores: Core[] = [];

const TOKEN = 'slot-token';

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('dynamic slots and profile control', () => {
  it('adds, binds, reloads and removes slots through the control API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-slots-'));
    roots.push(root);
    const channels = new Map<string, FakeChannel>();
    const selfIds = new Map([
      ['s1', '10001'],
      ['s2', '10002']
    ]);
    const core = await createTestCore(
      {
        dataRoot: root,
        instances: [],
        channelFactory: (context) => {
          const channel = new FakeChannel(context, { selfId: selfIds.get(context.instanceId) });
          channels.set(context.instanceId, channel);
          return channel;
        },
        api: { enabled: true, port: 0, token: TOKEN },
        logger: silentLogger('slots-test')
      },
      ['10001', '10002']
    );
    cores.push(core);
    await core.start();
    const url = core.status().apiUrl;
    if (!url) throw new Error('api url missing');

    const added = await fetch(`${url}/slots`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ id: 's1', backend: 'fake' })
    });
    expect(added.status).toBe(201);
    const addedBody = (await added.json()) as { instance: { id: string } };
    expect(addedBody.instance.id).toBe('s1');
    const first = core.status().instances.find((item) => item.id === 's1');
    expect(first).toMatchObject({ state: 'online', accountId: '10001', profileState: 'ready' });
    await core.setConversationRoleBinding({ accountId: '10001', kind: 'private', peerId: '555' }, { source: 'public', id: 'default' });

    const slots = await fetch(`${url}/slots`, { headers: auth() });
    expect(((await slots.json()) as { slots: Array<{ id: string }> }).slots.map((item) => item.id)).toEqual(['s1']);

    const artifacts = await fetch(`${url}/artifacts`, { headers: auth() });
    const artifactBody = (await artifacts.json()) as {
      artifacts: Array<{ ref: { revision: string }; manifest: { kind: string } }>;
    };
    expect(
      artifactBody.artifacts.some(
        (artifact) => artifact.manifest.kind === 'role-card' && artifact.ref.revision === 'r1'
      )
    ).toBe(true);

    const nextRevision = path.join(root, 'public', 'artifacts', 'role-card', 'default', 'r2');
    await fs.mkdir(nextRevision, { recursive: true });
    await fs.writeFile(
      path.join(nextRevision, 'manifest.json'),
      `${JSON.stringify(
        { id: 'default', kind: 'role-card', revision: 'r2', content: 'second persona' },
        null,
        2
      )}\n`
    );
    const deployed = await fetch(`${url}/artifacts/role-card/default/deploy`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ revision: 'r2' })
    });
    expect(deployed.status).toBe(200);
    await expect(core.resolveConversationRoleBinding('10001', { accountId: '10001', kind: 'private', peerId: '555' }))
      .resolves.toMatchObject({ card: { ref: { revision: 'r2' } } });
    const deployments = await fetch(`${url}/deployments`, { headers: auth() });
    expect(((await deployments.json()) as { deployments: unknown[] }).deployments).toHaveLength(1);

    const profile = await fetch(`${url}/accounts/10001/profile`, { headers: auth() });
    expect(await profile.json()).toMatchObject({
      ok: true,
      profile: { version: 1, roleCard: { source: 'public' } }
    });

    const saved = await fetch(`${url}/accounts/10001/profile`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({
        version: 1,
        roleCard: { source: 'public', id: 'default' },
        plugins: []
      })
    });
    expect(await saved.json()).toMatchObject({ ok: true, reload: { ok: true } });

    const reload = await fetch(`${url}/accounts/10001/reload`, { method: 'POST', headers: auth() });
    expect(await reload.json()).toMatchObject({
      ok: true,
      results: [{ instanceId: 's1', ok: true }]
    });

    const removed = await fetch(`${url}/slots/s1`, { method: 'DELETE', headers: auth() });
    expect(removed.status).toBe(200);
    expect(core.status().instances).toEqual([]);

    // s1 停止时释放了 10001；新槽位可以直接接管。
    const second = await fetch(`${url}/slots`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ id: 's2', backend: 'fake' })
    });
    expect(second.status).toBe(201);
    expect(core.status().instances.find((item) => item.id === 's2')).toMatchObject({
      state: 'online',
      accountId: '10002'
    });

    const stopped = await fetch(`${url}/slots/s2/stop`, { method: 'POST', headers: auth() });
    expect(stopped.status).toBe(200);
    expect(core.status().instances.find((item) => item.id === 's2')?.state).toBe('stopped');
    expect((await fetch(`${url}/slots/s2`, { method: 'DELETE', headers: auth() })).status).toBe(200);

    // 移除后的 id 和 desired 状态都已清理，可以重新创建。
    const again = await fetch(`${url}/slots`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ id: 's1', backend: 'fake' })
    });
    expect(again.status).toBe(201);
    expect(core.status().instances.find((item) => item.id === 's1')?.accountId).toBe('10001');
  });
});
