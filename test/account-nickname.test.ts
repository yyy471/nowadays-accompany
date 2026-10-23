import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FakeChannel } from '../src/channels/fake.js';
import { silentLogger } from '../src/core/logger.js';
import { createTestCore } from './helpers.js';

it('retains the verified channel nickname and clears it when the account is released', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-nickname-'));
  const core = await createTestCore({
    dataRoot: root, instances: [{ id: 'qq', backend: 'fake', accountId: '10001' }],
    logger: silentLogger('nickname-test'),
    channelFactory: (context) => {
      const channel = new FakeChannel(context, { selfId: '10001' });
      const connect = channel.connect.bind(channel);
      channel.connect = async () => {
        await connect();
        context.onStatus?.({ connected: true, selfId: '10001', nickname: '青禾' });
      };
      return channel;
    }
  });
  try {
    await core.start();
    expect(core.status().instances[0]).toMatchObject({ accountId: '10001', accountNickname: '青禾' });
    await core.stop();
    expect(core.status().instances[0]?.accountNickname).toBeUndefined();
  } finally {
    await core.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
