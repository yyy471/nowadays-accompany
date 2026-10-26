import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalArtifactStore } from '../src/artifacts/local.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('nowadays-wb-store-')) throw new Error('Unexpected test root');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-wb-store-'));
  roots.push(root);
  const publicRoot = path.join(root, 'public');
  return { publicRoot, store: new LocalArtifactStore(publicRoot) };
}

async function writeManifest(publicRoot: string, id: string, revision: string, manifest: unknown) {
  const dir = path.join(publicRoot, 'artifacts', 'worldbook', id, revision);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('worldbook fixed-revision resolution', () => {
  it.each(['con', 'NUL.json', 'garden.'])('rejects unsafe fixed segments before disk access: %s', async segment => {
    const { store } = await setup();
    const open = vi.spyOn(fs, 'open');
    await expect(store.resolveWorldbook({ source: 'public', id: segment, revision: 'r1' })).rejects.toThrow();
    await expect(store.resolveWorldbook({ source: 'public', id: 'garden', revision: segment })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects oversized manifests before reading their contents', async () => {
    const { publicRoot, store } = await setup();
    const dir = await writeManifest(publicRoot, 'garden', 'huge', {});
    await fs.writeFile(path.join(dir, 'manifest.json'), ' '.repeat(2 * 1024 * 1024 + 1));
    const readFile = vi.spyOn(fs, 'readFile');
    expect(await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'huge' })).toEqual({ status: 'invalid' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects a linked ancestor before opening the manifest without depending on OS link privileges', async () => {
    const { store } = await setup();
    vi.spyOn(fs, 'lstat').mockResolvedValueOnce({ isSymbolicLink: () => true } as never);
    const open = vi.spyOn(fs, 'open');
    expect(await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'r1' })).toEqual({ status: 'invalid' });
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps real I/O failures distinct from a missing or malformed resource', async () => {
    const { publicRoot, store } = await setup();
    await writeManifest(publicRoot, 'garden', 'r1', {});
    vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'r1' })).toEqual({ status: 'error' });
  });

  it('resolves a ready book only at an explicit public revision and never follows catalog', async () => {
    const { publicRoot, store } = await setup();
    await writeManifest(publicRoot, 'garden', 'w-001', { id: 'garden', kind: 'worldbook', revision: 'w-001', worldbook: { version: 1, entries: [{ id: 'a', keys: ['花园'], content: '银杏' }] } });

    const ready = await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'w-001' });
    expect(ready.status).toBe('ready');
    if (ready.status === 'ready') expect(ready.worldbook.entries[0]?.id).toBe('a');

    // No revision and no catalog entry must NOT resolve to a followed latest version (R5).
    await expect(store.resolveWorldbook({ source: 'public', id: 'garden' })).rejects.toThrow();
  });

  it('distinguishes missing, invalid and mismatched manifests', async () => {
    const { publicRoot, store } = await setup();
    expect((await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'absent' })).status).toBe('missing');

    await writeManifest(publicRoot, 'garden', 'bad', { id: 'garden', kind: 'worldbook', revision: 'bad', worldbook: { version: 2, entries: [] } });
    expect((await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'bad' })).status).toBe('invalid');

    // Path revision differs from the manifest body revision -> invalid, not a silent success.
    await writeManifest(publicRoot, 'garden', 'w-002', { id: 'garden', kind: 'worldbook', revision: 'w-001', worldbook: { version: 1, entries: [] } });
    expect((await store.resolveWorldbook({ source: 'public', id: 'garden', revision: 'w-002' })).status).toBe('invalid');
  });

  it('rejects private sources and unsafe segments', async () => {
    const { store } = await setup();
    await expect(store.resolveWorldbook({ source: 'private', id: 'garden', revision: 'r1' })).rejects.toThrow();
    await expect(store.resolveWorldbook({ source: 'public', id: '../escape', revision: 'r1' })).rejects.toThrow();
  });

  it('keeps worldbook out of the catalog and the generic resolve/deploy paths', async () => {
    const { publicRoot, store } = await setup();
    await writeManifest(publicRoot, 'garden', 'w-001', { id: 'garden', kind: 'worldbook', revision: 'w-001', worldbook: { version: 1, entries: [] } });
    await expect(store.setPublicRevision('worldbook', 'garden', 'w-001')).rejects.toThrow();
    await expect(store.resolve('worldbook', { source: 'public', id: 'garden', revision: 'w-001' })).rejects.toThrow();

    // Generic role-card resolution and deployment stay unchanged.
    const cardDir = path.join(publicRoot, 'artifacts', 'role-card', 'card', 'r1');
    await fs.mkdir(cardDir, { recursive: true });
    await fs.writeFile(path.join(cardDir, 'manifest.json'), JSON.stringify({ id: 'card', kind: 'role-card', revision: 'r1', content: '设定' }));
    expect(await store.resolve('role-card', { source: 'public', id: 'card', revision: 'r1' })).toBeDefined();
    await expect(store.setPublicRevision('role-card', 'card', 'r1')).resolves.toMatchObject({ current: 'r1' });
  });

  it('lists worldbook directories for browsing but they never enter the catalog', async () => {
    const { publicRoot, store } = await setup();
    await writeManifest(publicRoot, 'garden', 'w-001', { id: 'garden', kind: 'worldbook', revision: 'w-001', worldbook: { version: 1, entries: [] } });
    const listed = await store.listPublic();
    expect(listed.map((artifact) => artifact.manifest.kind)).toContain('worldbook');
  });
});
