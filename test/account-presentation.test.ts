import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountPresentation } from '../src/application/accounts/account-presentation.js';
import { AccountDisplayStore } from '../src/profiles/display.js';
import type { QqAvatarCache } from '../src/injection/qq-avatar.js';

const roots: string[] = [];
const stores: AccountDisplayStore[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function presentation(): { displays: AccountDisplayStore; view: AccountPresentation } {
  const displays = new AccountDisplayStore();
  stores.push(displays);
  const avatars = {
    get: async (accountId: string) => `data:qq/${accountId}`
  } as unknown as QqAvatarCache;
  return { displays, view: new AccountPresentation({ displays, avatars }) };
}

describe('AccountPresentation', () => {
  it('keeps the real nickname separate from the local display name and does not cross accounts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-account-presentation-'));
    roots.push(root);
    const first = path.join(root, 'accounts', '10001');
    const second = path.join(root, 'accounts', '10002');
    const localAvatar = 'data:image/png;base64,bG9jYWw=';
    const { displays, view } = presentation();
    await displays.save(first, { nickname: '本地青禾', signature: '签名一', avatarDataUrl: localAvatar });
    await displays.save(second, { nickname: '本地暮风', signature: '签名二' });

    await expect(view.process('10001', first, '真实青禾')).resolves.toMatchObject({
      nickname: '真实青禾',
      displayName: '本地青禾',
      avatarDataUrl: localAvatar,
      avatarSource: 'local'
    });
    await expect(view.process('10002', second, undefined, { avatars: true })).resolves.toMatchObject({
      displayName: '本地暮风',
      avatarDataUrl: 'data:qq/10002',
      avatarSource: 'qq'
    });
    await expect(view.local('10001', first, { avatars: false })).resolves.toMatchObject({
      display: { nickname: '本地青禾', signature: '签名一' }
    });
  });
});
