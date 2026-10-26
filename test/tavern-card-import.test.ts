import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TavernCardImportService } from '../src/application/artifacts/tavern-card-import-service.js';
import { ArtifactImportController } from '../desktop/artifact-import-controller.js';
import { LocalArtifactStore } from '../src/artifacts/local.js';
import { createCore } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { buildChatContext } from '../src/agent/context.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('nowadays-tavern-test-')) throw new Error('Unexpected test root');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-tavern-test-'));
  roots.push(root);
  const source = path.join(root, '角色卡.json'), publicRoot = path.join(root, 'public');
  const original = JSON.stringify({ name: 'Alice', description: 'You are {{char}}.', personality: 'Kind', scenario: '', first_mes: 'Hello', mes_example: '',
    character_book: { entries: [{ content: 'unimplemented world entry' }] }, extensions: { script: 'do not run this', url: 'https://example.invalid/no-fetch' } });
  await fs.writeFile(source, original);
  return { root, source, publicRoot, original, service: new TavernCardImportService({ publicRoot }) };
}
it('previews, archives original bytes and publishes through the inactive artifact pipeline', async () => {
  const { source, publicRoot, original, service } = await setup();
  const preview = await service.preview(source);
  expect(preview).toMatchObject({ sourceFormat: 'tavern-v1', kind: 'role-card', name: 'Alice', fileCount: 2 });
  expect(preview.id).toMatch(/^tavern-[a-f0-9]{16}$/); expect(preview.revision).toMatch(/^r-[a-f0-9]{16}$/);
  expect(preview.contentPreview).toContain('You are Alice.');
  expect(preview.contentPreview).not.toContain('unimplemented world entry');
  await expect(fs.access(publicRoot)).rejects.toThrow();
  const result = await service.import(source, { expectedFingerprint: preview.fingerprint });
  expect(result).toEqual(preview);
  expect(await fs.readFile(path.join(result.targetPath, 'source-card.json'), 'utf8')).toBe(original);
  const store = new LocalArtifactStore(publicRoot);
  expect(await store.resolve('role-card', { source: 'public', id: result.id })).toBeUndefined();
  expect(await store.resolve('role-card', { source: 'public', id: result.id, revision: result.revision })).toBeDefined();
  await expect(fs.access(path.join(publicRoot, 'catalog.json'))).rejects.toThrow();
  await expect(service.import(source)).rejects.toThrow('已存在');
  expect(await fs.readFile(path.join(result.targetPath, 'source-card.json'), 'utf8')).toBe(original);
});
it('rejects changed source content before writing and creates a new revision for a new snapshot', async () => {
  const { source, service, publicRoot } = await setup();
  const preview = await service.preview(source);
  await fs.writeFile(source, JSON.stringify({ name: 'Alice', description: 'changed' }));
  await expect(service.import(source, { expectedFingerprint: preview.fingerprint })).rejects.toThrow('变化');
  await expect(fs.access(publicRoot)).rejects.toThrow();
  const next = await service.preview(source);
  expect(next.id).toBe(preview.id); expect(next.revision).not.toBe(preview.revision);
});
it('rejects unsupported extensions, linked source directories and malformed cards', async () => {
  const { root, source, service, publicRoot } = await setup();
  await expect(service.preview(path.join(root, 'card.zip'))).rejects.toThrow('JSON');
  const junction = path.join(root, 'linked');
  await fs.symlink(path.dirname(source), junction, 'junction');
  await expect(service.preview(path.join(junction, path.basename(source)))).rejects.toThrow('链接');
  await fs.writeFile(source, '{bad json');
  await expect(service.import(source)).rejects.toThrow();
  await expect(fs.access(publicRoot)).rejects.toThrow();
});
it('keeps file-card metadata in the existing expiring single-use desktop token', async () => {
  const { source, publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  const preview = await controller.preview(async () => source, 'tavern-card');
  expect(preview?.sourceFormat).toBe('tavern-v1');
  expect(preview?.warnings?.length).toBeGreaterThan(0);
  expect(preview).not.toHaveProperty('source'); expect(preview).not.toHaveProperty('fingerprint');
  expect(await controller.commit(preview!.token)).toMatchObject({ kind: 'role-card', id: preview!.id, revision: preview!.revision });
  await expect(controller.commit(preview!.token)).rejects.toThrow('失效');
});
it('cannot commit a file card changed since its desktop preview', async () => {
  const { source, publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  const preview = await controller.preview(async () => source, 'tavern-card');
  await fs.writeFile(source, JSON.stringify({ name: 'Different' }));
  await expect(controller.commit(preview!.token)).rejects.toThrow('变化');
  await expect(fs.access(publicRoot)).rejects.toThrow();
});

it('uses converted cards in the existing per-account and per-conversation role chain', async () => {
  const { root, source, service } = await setup();
  const alice = await service.import(source);
  await fs.writeFile(source, JSON.stringify({ name: 'Bob', description: 'Another independent role' }));
  const bob = await service.import(source);
  for (const id of ['10001', '10002']) {
    await fs.mkdir(path.join(root, 'accounts', id), { recursive: true });
    await fs.writeFile(path.join(root, 'accounts', id, 'profile.json'), JSON.stringify({ version: 1, plugins: [] }));
  }
  const core = await createCore({ dataRoot: root, instances: [], manualStartOnly: true, autoStartSnowLuma: false, logger: silentLogger() });
  try {
    await core.start();
    const aPrivate = { accountId: '10001', kind: 'private' as const, peerId: '777' };
    const aGroup = { accountId: '10001', kind: 'group' as const, peerId: '777' };
    const bPrivate = { accountId: '10002', kind: 'private' as const, peerId: '777' };
    const ref = (card: typeof alice) => ({ source: 'public' as const, id: card.id, revision: card.revision });
    await core.setConversationRoleBinding(aPrivate, ref(alice));
    await core.setConversationRoleBinding(aGroup, ref(bob));
    await core.setConversationRoleBinding(bPrivate, ref(bob));
    const binding = await core.resolveConversationRoleBinding('10001', aPrivate);
    expect(binding?.card.manifest.name).toBe('Alice');
    expect((await core.resolveConversationRoleBinding('10001', aGroup))?.card.manifest.name).toBe('Bob');
    expect((await core.resolveConversationRoleBinding('10002', bPrivate))?.card.manifest.name).toBe('Bob');
    expect(await core.resolveConversationRoleBinding('10001', { ...aPrivate, peerId: '888' })).toBeUndefined();
    const context = buildChatContext({ roleCard: binding!.card.content, skills: [], history: [], currentText: 'Hi', kind: 'private', observations: [], maxHistoryMessages: 5, maxHistoryChars: 1000 });
    expect(context.messages[0]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('You are Alice.') })]));
    expect(JSON.stringify(context.messages)).not.toContain('unimplemented world entry');
  } finally { await core.stop(); }
});
