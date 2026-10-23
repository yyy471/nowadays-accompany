import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountDisplayStore } from '../src/profiles/display.js';

const roots: string[] = [];
const stores: AccountDisplayStore[] = [];

function store(): AccountDisplayStore {
  const value = new AccountDisplayStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((value) => value.close()));
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('account display profile persistence', () => {
  it('keeps nickname, signature and local avatar isolated by account and supports restoring the default avatar', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-display-'));
    roots.push(root);
    const first = path.join(root, 'accounts', '10001');
    const second = path.join(root, 'accounts', '10002');
    const avatar = `data:image/jpeg;base64,${Buffer.from('local-avatar').toString('base64')}`;
    const displays = store();

    await displays.save(first, { nickname: 'River', signature: 'keep it kind', avatarDataUrl: avatar });
    expect(await displays.load(first)).toEqual({ nickname: 'River', signature: 'keep it kind', avatarDataUrl: avatar });
    expect(await displays.load(second)).toEqual({ nickname: '', signature: '' });

    await displays.save(first, { avatarDataUrl: null });
    expect(await displays.load(first)).toEqual({ nickname: 'River', signature: 'keep it kind' });
  });

  it('merges concurrent field updates for one account', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-display-'));
    roots.push(root);
    const account = path.join(root, 'accounts', '10001');
    const displays = store();

    await Promise.all([
      displays.save(account, { nickname: 'River' }),
      displays.save(account, { signature: 'keep it kind' })
    ]);
    expect(await displays.load(account)).toEqual({ nickname: 'River', signature: 'keep it kind' });
  });

  it('does not publish a failed update and recovers for the next write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-display-'));
    roots.push(root);
    const account = path.join(root, 'accounts', '10001');
    const displays = store();

    await expect(displays.save(account, { avatarDataUrl: 'data:text/plain;base64,aGk=' }))
      .rejects.toThrow('JPEG, PNG, or WebP');
    expect(await displays.load(account)).toEqual({ nickname: '', signature: '' });

    await displays.save(account, { nickname: 'after-failure' });
    expect(await displays.load(account)).toEqual({ nickname: 'after-failure', signature: '' });
  });

  it('rejects non-image and oversized avatar payloads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-display-'));
    roots.push(root);
    const account = path.join(root, 'accounts', '10001');
    const displays = store();
    await expect(displays.save(account, { avatarDataUrl: 'data:text/plain;base64,aGk=' }))
      .rejects.toThrow('JPEG, PNG, or WebP');
    const oversized = Buffer.alloc(512 * 1024 + 1).toString('base64');
    await expect(displays.save(account, { avatarDataUrl: `data:image/png;base64,${oversized}` }))
      .rejects.toThrow('between 1 byte');
  });
});
