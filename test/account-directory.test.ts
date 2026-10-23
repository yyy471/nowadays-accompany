import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountDirectory } from '../src/profiles/account-directory.js';
import { createCore } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-account-directory-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('AccountDirectory', () => {
  it('resolves the default root, a running slot custom root, and an explicit base', async () => {
    const dataRoot = await tempRoot();
    const custom = path.join(dataRoot, 'custom-runtime');
    const directory = new AccountDirectory({
      dataRoot,
      specs: () => [{ accountId: '10001', dataDir: custom }]
    });

    expect(directory.path('10001')).toBe(path.join(custom, 'accounts', '10001'));
    expect(directory.path('10002')).toBe(path.join(dataRoot, 'accounts', '10002'));
    expect(directory.forSpec({ dataDir: path.join(dataRoot, 'other') }, '10003'))
      .toBe(path.join(dataRoot, 'other', 'accounts', '10003'));
  });

  it('does not create a directory when resolving an unknown account', async () => {
    const dataRoot = await tempRoot();
    const directory = new AccountDirectory({ dataRoot });

    expect(await directory.resolveExisting('99999')).toBeUndefined();
    await expect(fs.access(path.join(dataRoot, 'accounts', '99999'))).rejects.toThrow();

    const created = await directory.ensure('99999');
    expect(await directory.resolveExisting('99999')).toBe(created);
  });

  it('prefers an existing custom directory and falls back to the default root', async () => {
    const dataRoot = await tempRoot();
    const custom = path.join(dataRoot, 'custom-runtime');
    const directory = new AccountDirectory({
      dataRoot,
      specs: () => [
        { accountId: '10001', dataDir: custom },
        { accountId: '10002', dataDir: custom },
        { accountId: '10003', dataDir: custom },
        { accountId: '10004', dataDir: custom }
      ]
    });
    const defaultPath = (id: string) => path.join(dataRoot, 'accounts', id);
    const customPath = (id: string) => path.join(custom, 'accounts', id);

    await fs.mkdir(customPath('10001'), { recursive: true });
    await fs.mkdir(defaultPath('10002'), { recursive: true });
    await fs.mkdir(customPath('10002'), { recursive: true });
    await fs.mkdir(defaultPath('10003'), { recursive: true });

    await expect(directory.resolveExisting('10001')).resolves.toBe(customPath('10001'));
    await expect(directory.resolveExisting('10002')).resolves.toBe(customPath('10002'));
    await expect(directory.resolveExisting('10003')).resolves.toBe(defaultPath('10003'));
    await expect(directory.resolveExisting('10004')).resolves.toBeUndefined();
    await expect(fs.access(defaultPath('10001'))).rejects.toThrow();
    await expect(fs.access(customPath('10003'))).rejects.toThrow();
    await expect(fs.access(defaultPath('10004'))).rejects.toThrow();
    await expect(fs.access(customPath('10004'))).rejects.toThrow();
  });

  it('uses the slot dataDir for account reads and writes', async () => {
    const dataRoot = await tempRoot();
    const custom = path.join(dataRoot, 'custom-runtime');
    const core = await createCore({
      dataRoot,
      instances: [{ id: 'qq-10001', backend: 'fake', accountId: '10001', dataDir: custom }],
      logger: silentLogger('account-directory-core')
    });
    try {
      await core.saveAccountDisplay('10001', { nickname: 'custom-name' });
      expect((await core.getAccountDisplay('10001')).nickname).toBe('custom-name');
      const raw = JSON.parse(
        await fs.readFile(path.join(custom, 'accounts', '10001', 'display.json'), 'utf8')
      ) as { nickname: string };
      expect(raw.nickname).toBe('custom-name');
      await expect(fs.access(path.join(dataRoot, 'accounts', '10001'))).rejects.toThrow();

      const account = (await core.listAccounts()).find((item) => item.accountId === '10001');
      expect(account?.dir).toBe(path.join(custom, 'accounts', '10001'));
    } finally {
      await core.stop();
    }
  });

  it('lists accounts from the default and custom roots plus known slot specs', async () => {
    const dataRoot = await tempRoot();
    const custom = path.join(dataRoot, 'custom-runtime');
    await fs.mkdir(path.join(dataRoot, 'accounts', '10001'), { recursive: true });
    await fs.mkdir(path.join(custom, 'accounts', '10002'), { recursive: true });
    const directory = new AccountDirectory({
      dataRoot,
      specs: () => [{ accountId: '10003', dataDir: custom }]
    });

    expect((await directory.listKnown()).sort()).toEqual(['10001', '10002', '10003']);
    expect((await directory.accountsRoots()).sort()).toEqual([
      path.join(dataRoot, 'accounts'),
      path.join(custom, 'accounts')
    ].sort());
  });
});
