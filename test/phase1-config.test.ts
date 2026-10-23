import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/providers/config-store.js';
import { parseRuntimeConfig, redactProvider } from '../src/providers/types.js';
import { UnavailableCredentialVault } from '../src/secrets/vault.js';
import { fakeProvider } from './phase1-helpers.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-p1-config-'));
  roots.push(dir);
  return dir;
}

describe('phase 1 config schema', () => {
  it('rejects inline credentials, unknown fields and unsupported capabilities', () => {
    expect(() =>
      parseRuntimeConfig({
        schemaVersion: 2,
        providers: [fakeProvider('p1', { apiKey: 'sk-live-should-not-be-here' })],
        accountPolicies: {}
      })
    ).toThrow(/inline credentials/i);

    expect(() =>
      parseRuntimeConfig({
        schemaVersion: 2,
        providers: [{ ...fakeProvider('p1'), unexpected: true }],
        accountPolicies: {}
      })
    ).toThrow(/unknown field/i);

    expect(() =>
      parseRuntimeConfig({
        schemaVersion: 2,
        providers: [
          fakeProvider('p1', {}, { models: [{ id: 'm', capabilities: ['audio.transcribe'] }] })
        ],
        accountPolicies: {}
      })
    ).toThrow(/unsupported capability/i);
  });

  it('keeps only credentialRef and reports masked credential state', async () => {
    const dir = await root();
    const store = await ConfigStore.load({ filePath: path.join(dir, 'config.v2.json') });
    const saved = await store.upsertProvider(
      fakeProvider('cloud-chat', {}, {
        credentialRef: 'provider/cloud-chat',
        location: 'cloud',
        baseUrl: 'https://example.invalid/v1'
      })
    );
    expect(saved.credentialRef).toBe('provider/cloud-chat');
    const file = await fs.readFile(path.join(dir, 'config.v2.json'), 'utf8');
    expect(file).toContain('provider/cloud-chat');
    expect(file).not.toMatch(/sk-|Bearer\s/i);

    const dto = redactProvider(saved, true);
    expect(dto.credential).toEqual({ ref: 'provider/cloud-chat', configured: true });
    expect(JSON.stringify(dto)).not.toContain('sk-');
    expect(JSON.stringify(dto)).not.toContain('authorization');
  });

  it('writes atomically, backs up the previous config and can restore it', async () => {
    const dir = await root();
    const file = path.join(dir, 'config.v2.json');
    const store = await ConfigStore.load({ filePath: file });
    await store.upsertProvider(fakeProvider('a'));
    await store.upsertProvider(fakeProvider('b'));

    const backup = JSON.parse(await fs.readFile(store.backupPath, 'utf8')) as {
      providers: Array<{ id: string }>;
    };
    expect(backup.providers.map((provider) => provider.id)).toEqual(['a']);

    const current = JSON.parse(await fs.readFile(file, 'utf8')) as { providers: Array<{ id: string }> };
    expect(current.providers.map((provider) => provider.id)).toEqual(['a', 'b']);

    const restored = await store.restoreBackup();
    expect(restored.providers.map((provider) => provider.id)).toEqual(['a']);
  });

  it('leaves an invalid config file untouched and reports a clear error', async () => {
    const dir = await root();
    const file = path.join(dir, 'config.v2.json');
    const invalid = '{"schemaVersion":2,"providers":"broken"}\n';
    await fs.writeFile(file, invalid, 'utf8');
    await expect(ConfigStore.load({ filePath: file })).rejects.toThrow(/invalid_config|must be an array/i);
    expect(await fs.readFile(file, 'utf8')).toBe(invalid);
  });

  it('backs up legacy config.json on first v2 load without enabling external services', async () => {
    const dir = await root();
    const legacy = path.join(dir, 'config.json');
    await fs.writeFile(legacy, '{"plugin":{"enabled":true}}\n', 'utf8');
    const store = await ConfigStore.load({
      filePath: path.join(dir, 'config.v2.json'),
      legacyFile: legacy
    });
    expect(store.snapshot().providers).toEqual([]);
    expect(store.legacyBackupPath).toBe(`${legacy}.backup.json`);
    expect(await fs.readFile(legacy, 'utf8')).toBe('{"plugin":{"enabled":true}}\n');
    expect(await fs.readFile(`${legacy}.backup.json`, 'utf8')).toBe('{"plugin":{"enabled":true}}\n');
  });

  it('refuses plaintext credential storage when system protection is unavailable', async () => {
    const vault = new UnavailableCredentialVault();
    await expect(vault.set('provider/x', 'secret')).rejects.toMatchObject({
      code: 'credential_store_unavailable'
    });
    expect(vault.available).toBe(false);
  });
});
