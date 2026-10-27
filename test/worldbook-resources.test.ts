import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorldbookResourceService } from '../src/application/worldbooks/worldbook-resource-service.js';
import { ArtifactImportController } from '../desktop/artifact-import-controller.js';
import { publishArtifactRevision } from '../src/artifacts/publish.js';
import { createTestCore } from './helpers.js';
import { silentLogger } from '../src/core/logger.js';
import type { Core } from '../src/core/core.js';

const roots: string[] = [], cores: Core[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cores.splice(0).map(core => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(await fs.realpath(os.tmpdir())) || !path.basename(root).startsWith('nowadays-wb-resource-')) throw new Error('Unexpected root');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nowadays-wb-resource-')); roots.push(root);
  const publicRoot = path.join(root, 'public');
  return { root, publicRoot, service: new WorldbookResourceService({ publicRoot }) };
}
function request(revision = 'r1', requestId = `request-${revision}`, content = '花园有银杏') {
  return { requestId, manifest: { id: 'garden', kind: 'worldbook', revision, name: '花园', worldbook: { version: 1, entries: [{ id: 'a', keys: ['花园'], content }] } } };
}

it('creates immutable versions, returns bounded summaries, and retries across service restarts', async () => {
  const { service, publicRoot } = await setup();
  expect(await service.list()).toEqual({ items: [] });
  expect((await service.save(request())).created).toBe(true);
  const restarted = new WorldbookResourceService({ publicRoot });
  expect((await restarted.save(request())).created).toBe(false);
  expect((await restarted.detail('garden', 'r1')).manifest.worldbook.entries[0]?.content).toBe('花园有银杏');
  await restarted.save(request('r2'));
  const page = await service.list({ limit: 1 });
  expect(page.items).toHaveLength(1); expect(page.nextOffset).toBe(1);
  expect(JSON.stringify(page)).not.toContain('花园有银杏');
  expect((await service.list({ offset: 1, limit: 1 })).nextOffset).toBeUndefined();
  await expect(fs.stat(path.join(publicRoot, 'catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('binds a request id to the complete payload and rejects target replacement', async () => {
  const { service } = await setup();
  await service.save(request());
  await expect(service.save(request('r1', 'request-r1', 'changed'))).rejects.toMatchObject({ code: 'worldbook_conflict' });
  await expect(service.save(request('r2', 'request-r1'))).rejects.toMatchObject({ code: 'worldbook_conflict' });
  await expect(service.save(request('r1', 'another-request'))).rejects.toMatchObject({ code: 'worldbook_conflict' });
});

it('serializes same-request concurrent saves across instances and never overwrites a competing target', async () => {
  const { service, publicRoot } = await setup();
  const other = new WorldbookResourceService({ publicRoot });
  const same = await Promise.all([service.save(request()), other.save(request())]);
  expect(same.map(result => result.created).sort()).toEqual([false, true]);
  const competing = await Promise.allSettled([service.save(request('r2', 'x', 'X')), other.save(request('r2', 'y', 'Y'))]);
  expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(['X', 'Y']).toContain((await service.detail('garden', 'r2')).manifest.worldbook.entries[0]?.content);
});

it('derives multiple revisions without changing the base and checks external base changes', async () => {
  const { service, publicRoot } = await setup();
  const base = await service.save(request());
  const derived = (revision: string) => ({ ...request(revision), baseRef: { id: 'garden', revision: 'r1' }, expectedBaseFingerprint: base.fingerprint });
  await Promise.all([service.save(derived('r2')), service.save(derived('r3'))]);
  expect((await service.detail('garden', 'r2')).baseRef).toEqual({ id: 'garden', revision: 'r1' });
  const manifest = { ...base.manifest, name: 'changed externally' };
  await fs.writeFile(path.join(publicRoot, 'artifacts/worldbook/garden/r1/manifest.json'), JSON.stringify(manifest));
  await expect(service.save(derived('r4'))).rejects.toMatchObject({ code: 'worldbook_conflict' });
});

it('does not expose partial versions after a rename failure and safely retries the reserved request', async () => {
  const { service, publicRoot } = await setup();
  const originalRename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    if (String(destination).endsWith(path.join('garden', 'r1'))) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    return originalRename(source, destination);
  });
  await expect(service.save(request())).rejects.toMatchObject({ code: 'worldbook_io_error' });
  expect(await service.list()).toEqual({ items: [] });
  expect((await fs.readdir(publicRoot)).some(name => name.startsWith('.artifact-import-'))).toBe(false);
  vi.restoreAllMocks();
  expect((await service.save(request())).created).toBe(true);
});

it('keeps existing versions intact if a prepared directory cannot be completed', async () => {
  const { service, publicRoot } = await setup();
  const original = await service.save(request());
  await expect(publishArtifactRevision(publicRoot, path.join(publicRoot, 'artifacts/worldbook/garden/r2'), async temp => {
    await fs.writeFile(path.join(temp, 'manifest.json'), '{}'); throw new Error('prepare failed');
  })).rejects.toThrow('prepare failed');
  expect((await service.detail('garden', 'r1')).fingerprint).toBe(original.fingerprint);
  await expect(service.detail('garden', 'r2')).rejects.toMatchObject({ code: 'worldbook_not_found' });
});

it('fails closed on a manifest write failure and can recover using the identical request', async () => {
  const { service } = await setup();
  const write = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    if (String(file).endsWith('manifest.json')) throw Object.assign(new Error('private/path must not escape'), { code: 'ENOSPC' });
    return write(file, data, options);
  });
  await expect(service.save(request())).rejects.toMatchObject({ code: 'worldbook_io_error', message: '世界书读写失败，请检查文件和目录权限后重试。' });
  expect(await service.list()).toEqual({ items: [] });
  vi.restoreAllMocks();
  expect((await service.save(request())).created).toBe(true);
});

it('imports JSON through a read-only fingerprint preview, archives originals and deduplicates retries', async () => {
  const { root, service, publicRoot } = await setup();
  const file = path.join(root, '中文 世界书.json');
  const bytes = JSON.stringify({ entries: [{ keys: ['花园'], content: '原始正文' }] });
  await fs.writeFile(file, bytes);
  const preview = await service.previewFile(file);
  await expect(fs.stat(publicRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  const saved = await service.importFile(file, preview.fingerprint);
  expect(saved.created).toBe(true);
  expect((await service.importFile(file, preview.fingerprint)).created).toBe(false);
  expect(await fs.readFile(path.join(publicRoot, 'artifacts/worldbook', saved.manifest.id, saved.manifest.revision, 'source-worldbook.json'), 'utf8')).toBe(bytes);
  await fs.writeFile(file, '{}');
  await expect(service.importFile(file, preview.fingerprint)).rejects.toThrow();
});

it('rejects unsafe, unsupported and oversized imports without a formal resource', async () => {
  const { root, service } = await setup();
  const file = path.join(root, 'huge.json');
  await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
  await expect(service.previewFile(file)).rejects.toThrow();
  await expect(service.previewFile(path.join(root, 'archive.zip'))).rejects.toThrow();
  await expect(service.save({ ...request(), manifest: { ...request().manifest, id: '../escape' } })).rejects.toThrow();
  await expect(service.save({ ...request(), unknown: true })).rejects.toThrow();
  await expect(service.list({ limit: 101 })).rejects.toThrow();
});

it('uses single-use desktop capability, validates changed sources and allows picker cancellation', async () => {
  const { root, publicRoot } = await setup();
  const controller = new ArtifactImportController(publicRoot);
  expect(await controller.preview(async () => undefined, 'worldbook')).toBeUndefined();
  const file = path.join(root, 'book.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, entries: [] }));
  const preview = await controller.preview(async () => file, 'worldbook');
  expect(preview?.kind).toBe('worldbook');
  const committed = await controller.commit(preview!.token);
  expect(committed.kind).toBe('worldbook');
  await expect(controller.commit(preview!.token)).rejects.toThrow('失效');
  const changed = await controller.preview(async () => file, 'worldbook');
  await fs.writeFile(file, JSON.stringify({ version: 1, name: 'changed', entries: [] }));
  await expect(controller.commit(changed!.token)).rejects.toThrow();
});

it('evaluates an unsaved draft with book defaults without touching resources or history', async () => {
  const { service, publicRoot } = await setup();
  const book = { version: 1, scanDepth: 0, budgetChars: 40,
    entries: [
      { id: 'orchard', keys: ['果园'], content: '果园里有梨树。', enabled: true, constant: false, caseSensitive: false, priority: 0, position: 'after-role' },
      { id: 'always', keys: [], content: '常驻设定', enabled: true, constant: true, caseSensitive: false, priority: 0, position: 'before-role' }
    ] };
  const evaluation = await service.previewDraft({ book, text: '我走进果园。' });
  expect(evaluation.selectedIds).toEqual(['orchard', 'always']);
  expect(evaluation.beforeRole).toContain('常驻设定');
  const overridden = await service.previewDraft({ book, text: '我走进果园。', scanDepth: 2, budgetChars: 1 });
  expect(overridden.selectedIds).toEqual([]);
  expect(overridden.skippedIds).toEqual(['orchard', 'always']);
  expect(await service.list()).toEqual({ items: [] });
  await expect(fs.stat(publicRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(service.previewDraft({ book, text: 'x'.repeat(16001) })).rejects.toThrow('16000');
  await expect(service.previewDraft({ book, text: 'x', historyTexts: [] })).rejects.toThrow('不支持的字段');
  await expect(service.previewDraft({ book: { version: 2 }, text: 'x' })).rejects.toThrow();
  await expect(service.previewDraft({ book, text: 'x', budgetChars: -1 })).rejects.toThrow();
});

it('serves authenticated draft previews without creating a version', async () => {
  const { root, publicRoot } = await setup();
  const uiDir = path.join(root, 'ui'); await fs.mkdir(uiDir); await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>ui</title>');
  const core = await createTestCore({ dataRoot: root, instances: [], api: { enabled: true, port: 0, token: 'preview-fixture', uiDir }, logger: silentLogger() }, ['10001']);
  cores.push(core); await core.start();
  const base = core.status().apiUrl, headers = { authorization: 'Bearer preview-fixture', 'content-type': 'application/json' };
  const body = { book: { version: 1, scanDepth: 4, budgetChars: 2000, entries: [{ id: 'a', keys: ['花园'], content: '正文' }] }, text: '花园' };
  expect((await fetch(`${base}/worldbooks/preview`, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401);
  const response = await fetch(`${base}/worldbooks/preview`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ evaluation: { selectedIds: ['a'], usedChars: expect.any(Number) } });
  expect((await fetch(`${base}/worldbooks/preview`, { method: 'POST', headers, body: JSON.stringify({ ...body, text: 'x'.repeat(16001) }) })).status).toBe(400);
  expect((await fetch(`${base}/worldbooks/preview`, { method: 'POST', headers, body: JSON.stringify({ ...body, book: { version: 1, entries: 'no' } }) })).status).toBe(400);
  expect((await fetch(`${base}/worldbooks`, { headers })).status).toBe(200);
  const listed = await fetch(`${base}/worldbooks`, { headers });
  expect(listed.headers.get('content-type')).toContain('application/json');
  expect((await listed.json()).items).toEqual([]);
  await expect(fs.stat(path.join(publicRoot, 'artifacts/worldbook'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('authenticates API, preserves accounts and catalog, maps conflicts and drains public work', async () => {
  const { root, publicRoot } = await setup();
  const core = await createTestCore({ dataRoot: root, instances: [], api: { enabled: true, port: 0, token: 'resource-fixture' }, logger: silentLogger() }, ['10001']);
  cores.push(core); await core.start();
  const catalogBefore = await fs.readFile(path.join(publicRoot, 'catalog.json'), 'utf8');
  const base = core.status().apiUrl, headers = { authorization: 'Bearer resource-fixture', 'content-type': 'application/json' };
  expect((await fetch(`${base}/worldbooks`)).status).toBe(401);
  const accountsBefore = await core.listConversationRoleBindings('10001');
  const post = (body = request()) => fetch(`${base}/worldbooks/revisions`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect((await post()).status).toBe(201); expect((await post()).status).toBe(200);
  expect((await post(request('r1', 'other'))).status).toBe(409);
  expect((await fetch(`${base}/worldbooks/garden/revisions/absent`, { headers })).status).toBe(404);
  expect((await fetch(`${base}/worldbooks?limit=101`, { headers })).status).toBe(400);
  const listed = await (await fetch(`${base}/worldbooks?limit=1`, { headers })).json();
  expect(listed.items).toHaveLength(1); expect(listed.items[0]).not.toHaveProperty('manifest');
  const detailResponse = await fetch(`${base}/worldbooks/garden/revisions/r1`, { headers });
  expect(detailResponse.status).toBe(200);
  expect((await detailResponse.json()).manifest.worldbook.entries).toHaveLength(1);
  const all = await (await fetch(`${base}/artifacts`, { headers })).json();
  expect(all.artifacts.find((item: { manifest: { kind: string } }) => item.manifest.kind === 'worldbook').manifest).not.toHaveProperty('worldbook');
  expect(await core.listConversationRoleBindings('10001')).toEqual(accountsBefore);
  expect(await fs.readFile(path.join(publicRoot, 'catalog.json'), 'utf8')).toBe(catalogBefore);
  let unblock!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const originalRename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (source, dest) => {
    if (String(dest).endsWith(path.join('garden', 'r2'))) { entered(); await gate; }
    return originalRename(source, dest);
  });
  const saving = core.saveWorldbook(request('r2')); await waiting;
  let stopped = false; const stopping = core.stop().then(() => { stopped = true; });
  await expect(core.saveWorldbook(request('r3'))).rejects.toMatchObject({ code: 'core_stopped' });
  expect(stopped).toBe(false); unblock(); await saving; await stopping;
  expect((await new WorldbookResourceService({ publicRoot }).detail('garden', 'r2')).manifest.revision).toBe('r2');
});
