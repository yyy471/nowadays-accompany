import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAccountDisplay, saveAccountDisplay } from '../src/profiles/display.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('account display profile persistence', () => {
  it('keeps nickname, signature and local avatar isolated by account and supports restoring the default avatar', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-display-'));
    roots.push(root);
    const first = path.join(root, 'accounts', '10001');
    const second = path.join(root, 'accounts', '10002');
    const avatar = `data:image/jpeg;base64,${Buffer.from('local-avatar').toString('base64')}`;

    await saveAccountDisplay(first, { nickname: 'River', signature: 'keep it kind', avatarDataUrl: avatar });
    expect(await loadAccountDisplay(first)).toEqual({ nickname: 'River', signature: 'keep it kind', avatarDataUrl: avatar });
    expect(await loadAccountDisplay(second)).toEqual({ nickname: '', signature: '' });

    await saveAccountDisplay(first, { avatarDataUrl: null });
    expect(await loadAccountDisplay(first)).toEqual({ nickname: 'River', signature: 'keep it kind' });
  });

  it('rejects non-image and oversized avatar payloads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-display-'));
    roots.push(root);
    const account = path.join(root, 'accounts', '10001');
    await expect(saveAccountDisplay(account, { avatarDataUrl: 'data:text/plain;base64,aGk=' })).rejects.toThrow('JPEG, PNG, or WebP');
    const oversized = Buffer.alloc(512 * 1024 + 1).toString('base64');
    await expect(saveAccountDisplay(account, { avatarDataUrl: `data:image/png;base64,${oversized}` })).rejects.toThrow('between 1 byte');
  });
});
