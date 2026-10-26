import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { defaultAccountPolicy } from '../src/providers/types.js';
import { MemoryCredentialVault } from '../src/secrets/vault.js';
import { fakeProvider } from './phase1-helpers.js';

const cores: Core[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test directory');
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-impact-'));
  roots.push(root);
  const vault = new MemoryCredentialVault();
  const core = await createCore({ dataRoot: root, instances: [], manualStartOnly: true, credentialVault: vault,
    api: { enabled: true, port: 0, token: 'fixture-impact-token' }, logger: silentLogger() });
  cores.push(core); await core.start();
  return { root, core, vault, url: core.status().apiUrl!, headers: { authorization: 'Bearer fixture-impact-token' } };
}

it('previews all affected policy scopes without writing, then matches actual deletion', async () => {
  const { core, url, headers, vault } = await setup();
  await core.upsertProvider(fakeProvider('target'), 'fixture-secret');
  await core.upsertProvider(fakeProvider('other'));
  await core.setAccountPolicy('10001', { ...defaultAccountPolicy(), allowedProviders: ['target'] });
  await core.setAccountPolicy('10002', { ...defaultAccountPolicy(), bindings: { chat: { providerId: 'target', modelId: 'chat' } } });
  await core.setAccountPolicy('10003', { ...defaultAccountPolicy(), byKind: { group: { bindings: { chat: {
    providerId: 'other', modelId: 'chat', fallback: [{ providerId: 'target', modelId: 'chat' }]
  } } } } });
  await core.setAccountPolicy('10004', { ...defaultAccountPolicy(), byConversation: { 'private/777': { bindings: { chat: {
    providerId: 'target', modelId: 'chat'
  } } } } });
  await core.setAccountPolicy('10005', { ...defaultAccountPolicy(), allowedProviders: ['other'] });
  const before = await fs.readFile(core.configV2.filePath, 'utf8');
  const backup = await fs.readFile(core.configV2.backupPath, 'utf8');
  const version = core.configV2.version;
  const unauthorized = await fetch(`${url}/providers/target/impact`);
  expect(unauthorized.status).toBe(401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${url}/providers/target/impact`, { headers });
    expect(response.status).toBe(200);
    const preview = await response.json() as { exists: boolean; affectedAccounts: string[] };
    expect(preview).toMatchObject({ exists: true, affectedAccounts: ['10001', '10002', '10003', '10004'] });
    expect(JSON.stringify(preview)).not.toContain('fixture-secret');
  }
  expect(await fs.readFile(core.configV2.filePath, 'utf8')).toBe(before);
  expect(await fs.readFile(core.configV2.backupPath, 'utf8')).toBe(backup);
  expect(core.configV2.version).toBe(version);
  expect(await vault.get('provider/target')).toBe('fixture-secret');
  const response = await fetch(`${url}/providers/target`, { method: 'DELETE', headers });
  expect(await response.json()).toMatchObject({ removed: true, affectedAccounts: ['10001', '10002', '10003', '10004'] });
  expect(core.configV2.provider('target')).toBeUndefined();
  expect(core.configV2.accountPolicy('10005')?.allowedProviders).toEqual(['other']);
});

it('reports a missing provider without creating a config file', async () => {
  const { core, url, headers } = await setup();
  const before = core.configV2.snapshot();
  const response = await fetch(`${url}/providers/missing/impact`, { headers });
  expect(await response.json()).toEqual({ ok: true, providerId: 'missing', exists: false, affectedAccounts: [] });
  expect(core.configV2.snapshot()).toEqual(before);
  await expect(fs.access(core.configV2.filePath)).rejects.toThrow();
});

it('infers network policy from edited URLs only when the simplified editor opts in', async () => {
  const { core, url, headers } = await setup();
  const provider = fakeProvider('edited');
  const save = (body: unknown) => fetch(`${url}/providers/edited`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  for (const [baseUrl, location] of [['https://models.example.com/v1', 'cloud'], ['http://127.0.0.1:11434/v1', 'local']] as const) {
    const response = await save({ provider: { ...provider, baseUrl, location: location === 'cloud' ? 'local' : 'cloud' }, inferLocationFromUrl: true });
    expect(response.status).toBe(200);
    expect(core.configV2.provider('edited')?.location).toBe(location);
  }
  // Existing advanced API clients retain their explicit location semantics.
  const response = await save({ provider: { ...provider, baseUrl: 'https://models.example.com/v1', location: 'local' } });
  expect(response.status).toBe(200);
  expect(core.configV2.provider('edited')?.location).toBe('local');
  const version = core.configV2.version;
  expect((await save({ provider, inferLocationFromUrl: 'yes' })).status).toBe(400);
  expect((await save({ provider: { ...provider, baseUrl: 'invalid' }, inferLocationFromUrl: true })).status).toBe(400);
  expect(core.configV2.version).toBe(version);
});
