import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactImportController } from '../desktop/artifact-import-controller.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test root');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-import-bridge-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const publicRoot = path.join(root, 'public');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ kind: 'role-card', id: 'alice', revision: 'v1', name: 'Alice', content: 'Hello' }));
  return { source, publicRoot };
}

it('imports only the selected preview once and does not activate the resource', async () => {
  const { source, publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  const preview = await controller.preview(async () => source);
  expect(preview).toMatchObject({ kind: 'role-card', id: 'alice', revision: 'v1', fileCount: 1 });
  expect(preview).not.toHaveProperty('fingerprint');
  expect(preview).not.toHaveProperty('source');
  await expect(controller.commit('forged')).rejects.toThrow('失效');
  expect(await controller.commit(preview!.token)).toEqual({ kind: 'role-card', id: 'alice', revision: 'v1' });
  expect(await fs.readFile(path.join(preview!.targetPath, 'manifest.json'), 'utf8')).toContain('Alice');
  await expect(fs.access(path.join(publicRoot, 'catalog.json'))).rejects.toThrow();
  await expect(controller.commit(preview!.token)).rejects.toThrow('失效');
});

it('expires preview tokens and cancellation invalidates the preceding selection', async () => {
  const { source, publicRoot } = await setup();
  let now = 0;
  const controller = new ArtifactImportController(publicRoot, () => now);
  const first = await controller.preview(async () => source);
  now = 300_000;
  await expect(controller.commit(first!.token)).rejects.toThrow('失效');
  const second = await controller.preview(async () => source);
  expect(await controller.preview(async () => undefined)).toBeUndefined();
  await expect(controller.commit(second!.token)).rejects.toThrow('失效');
});

it('rejects source changes after preview and consumes failed commit tokens', async () => {
  const { source, publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  const preview = await controller.preview(async () => source);
  await fs.writeFile(path.join(source, 'extra.txt'), 'changed');
  await expect(controller.commit(preview!.token)).rejects.toThrow();
  await expect(fs.access(preview!.targetPath)).rejects.toThrow();
  await expect(controller.commit(preview!.token)).rejects.toThrow('失效');
});

it('rejects overlapping native selections', async () => {
  const { publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  let release!: (value: undefined) => void;
  const pending = controller.preview(() => new Promise(resolve => { release = resolve; }));
  await expect(controller.preview(async () => undefined)).rejects.toThrow('正在进行');
  await expect(controller.commit('any')).rejects.toThrow('正在进行');
  release(undefined);
  await expect(pending).resolves.toBeUndefined();
});

it.each([false, true])('waits for an accepted publication during shutdown (failure=%s)', async failure => {
  const { source, publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  const preview = await controller.preview(async () => source);
  let announce!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    announce(); await blocked;
    if (failure) throw new Error('publication blocked');
    return original(from, to);
  });
  const commit = controller.commit(preview!.token).then(() => 'success', () => 'failure');
  await entered;
  let drained = false;
  const draining = controller.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  release();
  expect(await commit).toBe(failure ? 'failure' : 'success');
  await draining; expect(drained).toBe(true);
});
