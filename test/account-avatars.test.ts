import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Core } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { createTestCore } from './helpers.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('account avatar pipeline', () => {
  it('resolves local display avatars first and falls back to the QQ avatar service', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-account-avatars-'));
    roots.push(root);
    let calls = 0;
    const remoteBytes = Buffer.from('remote-avatar');
    const core = await createTestCore({
      dataRoot: root,
      instances: [],
      persistSlots: true,
      avatarFetchImpl: (async () => {
        calls += 1;
        return new Response(remoteBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      }) as typeof fetch,
      logger: silentLogger('account-avatars')
    });
    cores.push(core);
    await core.saveAccountDisplay('10001', { nickname: '青禾' });

    const [remoteAccount] = await core.listAccounts({ avatars: true });
    expect(remoteAccount).toMatchObject({
      accountId: '10001',
      avatarSource: 'qq',
      avatarDataUrl: `data:image/png;base64,${remoteBytes.toString('base64')}`
    });
    expect(calls).toBe(1);

    const localAvatar = `data:image/png;base64,${Buffer.from('local-avatar').toString('base64')}`;
    await core.saveAccountDisplay('10001', { nickname: '青禾', avatarDataUrl: localAvatar });
    const [localAccount] = await core.listAccounts({ avatars: true });
    expect(localAccount).toMatchObject({ avatarSource: 'local', avatarDataUrl: localAvatar });
    expect(calls).toBe(1);

    const [withoutAvatars] = await core.listAccounts();
    expect(withoutAvatars).toMatchObject({ nickname: '青禾', signature: '' });
    expect(withoutAvatars?.avatarDataUrl).toBeUndefined();
  });
});
