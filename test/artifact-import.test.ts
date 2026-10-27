import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactImportService } from '../src/application/artifacts/artifact-import-service.js';
import { LocalArtifactStore } from '../src/artifacts/local.js';
import { IMPORTED_ARTIFACT_MARKER, parseArtifactManifest } from '../src/artifacts/manifest.js';

let root: string, source: string, publicRoot: string, service: ArtifactImportService;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nowadays-import-test-'));
  source = path.join(root, 'source'); publicRoot = path.join(root, 'public');
  await fs.mkdir(source); service = new ArtifactImportService({ publicRoot });
});
afterEach(async () => {
  vi.restoreAllMocks();
  const absolute = path.resolve(root); const relative = path.relative(path.resolve(await fs.realpath(os.tmpdir())), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(absolute).startsWith('nowadays-import-test-')) throw new Error('Unsafe test cleanup target');
  await fs.rm(absolute, { recursive: true, force: true });
});
async function manifest(overrides: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ id: 'role-a', kind: 'role-card', revision: 'v2', name: 'Role A', content: 'Character', ...overrides }));
}
async function exists(file: string) { return fs.lstat(file).then(() => true, () => false); }
async function publicEntries() { return fs.readdir(publicRoot).catch(() => [] as string[]); }

it('previews without writes and imports a verified manifest directory without touching catalog', async () => {
  await manifest(); await fs.mkdir(path.join(source, 'assets')); await fs.writeFile(path.join(source, 'assets', 'readme.txt'), 'hello');
  const preview = await service.preview(source);
  expect(preview).toMatchObject({ kind: 'role-card', id: 'role-a', revision: 'v2', name: 'Role A', fileCount: 2, targetPath: path.join(publicRoot, 'artifacts/role-card/role-a/v2') });
  expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(preview.bytes).toBe((await fs.stat(path.join(source, 'manifest.json'))).size + 5);
  expect(await exists(publicRoot)).toBe(false);
  expect(await service.import(source, { expectedFingerprint: preview.fingerprint })).toEqual(preview);
  expect(await fs.readFile(path.join(preview.targetPath, 'assets/readme.txt'), 'utf8')).toBe('hello');
  expect(await exists(path.join(preview.targetPath, IMPORTED_ARTIFACT_MARKER))).toBe(true);
  expect(await publicEntries()).toEqual(['artifacts']);
  expect((await new LocalArtifactStore(publicRoot).listPublic()).map(artifact => artifact.ref)).toEqual([{ source: 'public', id: 'role-a', revision: 'v2' }]);
});

it('keeps imported revisions inactive for follow-current until explicitly deployed, retaining manual fallback', async () => {
  await manifest(); const store = new LocalArtifactStore(publicRoot);
  const manual = path.join(publicRoot, 'artifacts/role-card/role-a/v1'); await fs.mkdir(manual, { recursive: true });
  await fs.writeFile(path.join(manual, 'manifest.json'), JSON.stringify({ id: 'role-a', kind: 'role-card', revision: 'v1', content: 'old' }));
  await service.import(source);
  expect((await store.resolve('role-card', { source: 'public', id: 'role-a' }))?.ref.revision).toBe('v1');
  expect((await store.resolve('role-card', { source: 'public', id: 'role-a', revision: 'v2' }))?.ref.revision).toBe('v2');
  await manifest({ id: 'only-imported' }); await service.import(source);
  expect(await store.resolve('role-card', { source: 'public', id: 'only-imported' })).toBeUndefined();
  expect(await exists(path.join(publicRoot, 'catalog.json'))).toBe(false);
  await store.setPublicRevision('role-card', 'only-imported', 'v2');
  expect((await store.resolve('role-card', { source: 'public', id: 'only-imported' }))?.ref.revision).toBe('v2');
});

it('rejects duplicate revisions, including existing empty directories, without overwriting', async () => {
  await manifest(); const preview = await service.preview(source);
  await fs.mkdir(preview.targetPath, { recursive: true });
  await expect(service.import(source)).rejects.toThrow('revision'); expect(await fs.readdir(preview.targetPath)).toEqual([]);
  await fs.rmdir(preview.targetPath); await service.import(source);
  const before = await fs.readFile(path.join(preview.targetPath, 'manifest.json'));
  await manifest({ content: 'Changed' }); await expect(service.import(source)).rejects.toThrow('revision');
  expect(await fs.readFile(path.join(preview.targetPath, 'manifest.json'))).toEqual(before);
});

it('rejects changes after preview and preserves the destination', async () => {
  await manifest(); const preview = await service.preview(source);
  await fs.writeFile(path.join(source, 'new.txt'), 'new file');
  await expect(service.import(source, { expectedFingerprint: preview.fingerprint })).rejects.toThrow('发生变化');
  expect(await exists(publicRoot)).toBe(false);
});

it.each([
  { id: '../escape' }, { revision: '..' }, { revision: 'v2.' }, { id: 'CON' }, { kind: 'unknown' },
  { content: '' }, { content: 123 }, { unexpected: true }, { name: 123 },
  { kind: 'plugin', content: undefined, entry: '../outside.js', apiVersion: 1 },
  { kind: 'plugin', content: undefined, entry: 'C:\\outside.js', apiVersion: 1 },
  { kind: 'plugin', content: undefined, entry: 'nested\\outside.js', apiVersion: 1 },
  { kind: 'plugin', content: undefined, entry: 'missing.js', apiVersion: 1 },
  { kind: 'plugin', content: undefined, entry: 'index.js', apiVersion: 999 }
])('strictly rejects invalid manifest %j without destination writes', async overrides => {
  await manifest(overrides); await expect(service.import(source)).rejects.toThrow(); expect(await exists(publicRoot)).toBe(false);
});

it('accepts a plugin with a real safe entry while retaining legacy reader compatibility', async () => {
  await manifest({ kind: 'plugin', content: undefined, entry: 'lib/index.js', apiVersion: 1 });
  await fs.mkdir(path.join(source, 'lib')); await fs.writeFile(path.join(source, 'lib/index.js'), 'export default {};');
  expect((await service.import(source)).kind).toBe('plugin');
  expect(parseArtifactManifest({ id: '../legacy', kind: 'plugin', revision: 'old', custom: true })).toHaveProperty('custom', true);
});

it('rejects missing/broken manifests, wrong input types and reserved marker files', async () => {
  await expect(service.import(source)).rejects.toThrow('manifest');
  await fs.writeFile(path.join(source, 'manifest.json'), '{bad'); await expect(service.import(source)).rejects.toThrow('JSON');
  await expect(service.import(path.join(source, 'manifest.json'))).rejects.toThrow('目录');
  await manifest(); await fs.writeFile(path.join(source, IMPORTED_ARTIFACT_MARKER), 'spoof');
  await expect(service.import(source)).rejects.toThrow('保留'); expect(await exists(publicRoot)).toBe(false);
});

it.each([
  { maxFiles: 1 }, { maxFileBytes: 8 }, { maxTotalBytes: 10 }, { maxEntries: 1 }, { maxDepth: 1 }
])('enforces resource limits %j before writing', async limits => {
  await manifest(); await fs.mkdir(path.join(source, 'a/b'), { recursive: true }); await fs.writeFile(path.join(source, 'a/b/file'), 'test');
  const limited = new ArtifactImportService({ publicRoot, limits });
  await expect(limited.import(source)).rejects.toThrow('限制'); expect(await exists(publicRoot)).toBe(false);
});

it('rejects directory junctions including source roots and destination ancestors', async () => {
  await manifest(); const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(source, 'linked'), 'junction');
  await expect(service.import(source)).rejects.toThrow('链接'); await fs.rm(path.join(source, 'linked'), { force: true });
  const linkedSource = path.join(root, 'linked-source'); await fs.symlink(source, linkedSource, 'junction');
  await expect(service.preview(linkedSource)).rejects.toThrow('链接');
  await fs.symlink(outside, publicRoot, 'junction'); await expect(service.import(source)).rejects.toThrow('链接');
  expect(await fs.readdir(outside)).toEqual([]);
});

it('rejects file symlinks', async context => {
  await manifest(); const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'secret');
  try { await fs.symlink(outside, path.join(source, 'linked.txt'), 'file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
  await expect(service.import(source)).rejects.toThrow('链接'); expect(await exists(publicRoot)).toBe(false);
});

it('cleans staging after a copy failure and never exposes a partial revision', async () => {
  await manifest(); const preview = await service.preview(source);
  const original = fs.rename.bind(fs); vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('.artifact-import-')) throw new Error('simulated rename failure');
    return original(from, to);
  });
  await expect(service.import(source)).rejects.toThrow('simulated');
  expect(await exists(preview.targetPath)).toBe(false); expect(await publicEntries()).toEqual(['artifacts']);
  expect(await fs.readdir(path.dirname(preview.targetPath))).toEqual([]);
});

it('serializes concurrent attempts using a per-revision claim and never overwrites', async () => {
  await manifest(); const second = new ArtifactImportService({ publicRoot });
  const results = await Promise.allSettled([service.import(source), second.import(source)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(await publicEntries()).toEqual(['artifacts']);
});

it.each(['source-file', 'source-inventory', 'staged-file'])('rechecks %s changes during copy and removes staging', async mutation => {
  await manifest(); const preview = await service.preview(source);
  const original = fs.open.bind(fs); let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = String(args[0]); const flags = args[1];
    if (!changed && file.includes('.artifact-import-') && file.endsWith('manifest.json')
      && (mutation === 'staged-file' ? flags !== 'wx' : flags === 'wx')) {
      changed = true;
      if (mutation === 'source-file') await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ id: 'role-a', kind: 'role-card', revision: 'v2', content: 'changed' }));
      if (mutation === 'source-inventory') await fs.writeFile(path.join(source, 'added.txt'), 'unconfirmed content');
      if (mutation === 'staged-file') await fs.writeFile(file, '{tampered');
    }
    return original(...args);
  });
  await expect(service.import(source, { expectedFingerprint: preview.fingerprint })).rejects.toThrow();
  expect(changed).toBe(true); expect(await exists(preview.targetPath)).toBe(false);
  expect(await publicEntries()).toEqual(['artifacts']);
  expect(await fs.readdir(path.dirname(preview.targetPath))).toEqual([]);
});
