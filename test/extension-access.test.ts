import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/core/core.js';
import { silentLogger } from '../src/core/logger.js';
import { createTestCore } from './helpers.js';

const roots: string[] = [];
const cores: Core[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  if (savedEnv.MARKER !== undefined) process.env.ACCOMPANY_IMPORT_MARKER = savedEnv.MARKER;
  else delete process.env.ACCOMPANY_IMPORT_MARKER;
});

async function setup(): Promise<{ core: Core; base: string; headers: Record<string, string>; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-extension-access-'));
  roots.push(root);
  const core = await createTestCore({
    dataRoot: root,
    instances: [],
    api: { enabled: true, port: 0, token: 'extension-access-fixture' },
    logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(core);
  await core.start();
  return {
    core,
    root,
    base: core.status().apiUrl!,
    headers: { authorization: 'Bearer extension-access-fixture', 'content-type': 'application/json' }
  };
}

async function request(base: string, headers: Record<string, string>, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${pathname}`, { ...init, headers });
  return { status: response.status, body: await response.json() as any };
}

async function copyExample(root: string, kind: 'plugins' | 'skills', name: string): Promise<void> {
  const source = path.join(process.cwd(), 'examples', 'extensions', name);
  await fs.cp(source, path.join(root, 'imports', kind, name), { recursive: true });
}

async function writePlugin(root: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, 'imports', 'plugins', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), content, 'utf8');
  }
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id: 'broken-js',
    kind: 'plugin',
    revision: 'r1',
    entry: 'index.mjs',
    apiVersion: 1,
    tools: [{
      id: 'run',
      description: 'Offline fixture tool.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read'
    }],
    ...overrides
  }, null, 2)}\n`;
}

async function imports(base: string, headers: Record<string, string>, kind: 'plugin' | 'skill') {
  const scan = await request(base, headers, '/extensions/imports/scan', { method: 'POST', body: '{}' });
  expect(scan.status).toBe(200);
  return scan.body.entries.filter((entry: { kind: string }) => entry.kind === kind);
}

async function importSkill(
  base: string,
  headers: Record<string, string>,
  sourceDirectory: string,
  expectedRevision: string,
  target: Record<string, unknown> = { source: 'public' }
) {
  return request(base, headers, '/extensions/imports', {
    method: 'POST',
    body: JSON.stringify({ kind: 'skill', sourceDirectory, target, expectedRevision })
  });
}

describe('extension file import', () => {
  it('scans, previews and imports plugins without executing module code', async () => {
    const { base, headers, root } = await setup();
    const marker = path.join(root, 'plugin-top-level-executed');
    savedEnv.MARKER = process.env.ACCOMPANY_IMPORT_MARKER;
    process.env.ACCOMPANY_IMPORT_MARKER = marker;
    await copyExample(root, 'plugins', 'weather');
    await writePlugin(root, 'broken-js', { 'manifest.json': manifest(), 'index.mjs': 'export const tools = {\n' });
    await writePlugin(root, 'side-effect', {
      'manifest.json': manifest({ id: 'side-effect' }),
      'index.mjs': [
        "import fs from 'node:fs';",
        'if (process.env.ACCOMPANY_IMPORT_MARKER) fs.writeFileSync(process.env.ACCOMPANY_IMPORT_MARKER, "loaded");',
        'export const tools = { run: async () => ({ status: "ok", text: "ran" }) };'
      ].join('\n')
    });
    await writePlugin(root, 'missing-entry', {
      'manifest.json': manifest({ id: 'missing-entry', entry: 'nope.mjs' }),
      'index.mjs': 'export const tools = {};\n'
    });

    const entries = await imports(base, headers, 'plugin');
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual(
      expect.arrayContaining(['weather', 'broken-js', 'side-effect', 'missing-entry'])
    );
    expect(entries.find((entry: { name: string }) => entry.name === 'weather')).toMatchObject({
      status: 'ready',
      plugin: { id: 'weather', revision: 'r1', fileCount: 3 }
    });
    expect(entries.find((entry: { name: string }) => entry.name === 'broken-js')).toMatchObject({ status: 'ready' });
    expect(entries.find((entry: { name: string }) => entry.name === 'missing-entry')).toMatchObject({
      status: 'invalid'
    });
    await expect(fs.access(marker)).rejects.toThrow();

    const weatherDir = path.join(root, 'imports', 'plugins', 'weather');
    const preview = await request(base, headers, '/extensions/imports/preview', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plugin', sourceDirectory: weatherDir })
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({
      kind: 'plugin',
      id: 'weather',
      revision: 'r1',
      totalBytes: expect.any(Number)
    });
    await expect(fs.access(marker)).rejects.toThrow();

    const brokenPreview = await request(base, headers, '/extensions/imports/preview', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plugin', sourceDirectory: path.join(root, 'imports', 'plugins', 'broken-js') })
    });
    expect(brokenPreview.status).toBe(200);
    expect(brokenPreview.body.preview).toMatchObject({ kind: 'plugin', id: 'broken-js' });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('imports public/private plugins with fixed revisions and keeps duplicate rules', async () => {
    const { core, base, headers, root } = await setup();
    await copyExample(root, 'plugins', 'weather');
    const source = path.join(root, 'imports', 'plugins', 'weather');

    const publicImport = await request(base, headers, '/extensions/imports', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plugin', sourceDirectory: source, target: { source: 'public' } })
    });
    expect(publicImport.status).toBe(200);
    expect(publicImport.body.imported).toMatchObject({ kind: 'plugin', id: 'weather', revision: 'r1', target: { source: 'public' } });
    const publicArtifact = await core.listPublicArtifacts();
    expect(publicArtifact.some((artifact) => artifact.ref.id === 'weather' && artifact.ref.revision === 'r1')).toBe(true);

    const privateImport = await request(base, headers, '/extensions/imports', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'plugin',
        sourceDirectory: source,
        target: { source: 'private', accountId: '10001' }
      })
    });
    expect(privateImport.status).toBe(200);
    await expect(fs.access(path.join(root, 'accounts', '10001', 'artifacts', 'plugin', 'weather', 'r1', 'manifest.json'))).resolves.toBeUndefined();
    const privateDir = path.join(root, 'accounts', '10002', 'artifacts', 'plugin', 'weather', 'r1');
    await expect(fs.access(privateDir)).rejects.toThrow();

    const duplicate = await request(base, headers, '/extensions/imports', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plugin', sourceDirectory: source, target: { source: 'public' } })
    });
    expect(duplicate.status).toBe(409);

    const missingAccount = await request(base, headers, '/extensions/imports', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'plugin',
        sourceDirectory: source,
        target: { source: 'private', accountId: '99999' }
      })
    });
    expect(missingAccount.status).toBe(404);
    expect(missingAccount.body.code).toBe('extension_account_not_found');
  });

  it('converts SKILL.md with optional skill.json into existing definitions and honors CAS', async () => {
    const { core, base, headers, root } = await setup();
    await copyExample(root, 'skills', 'travel-planning');
    const withMetadata = path.join(root, 'imports', 'skills', 'travel-planning');
    const bareDir = path.join(root, 'imports', 'skills', 'bare-skill');
    await fs.mkdir(bareDir, { recursive: true });
    await fs.writeFile(path.join(bareDir, 'SKILL.md'), '# 裸 Skill\n\n只使用目录名和标题。\n', 'utf8');

    const entries = await imports(base, headers, 'skill');
    expect(entries.find((entry: { name: string }) => entry.name === 'travel-planning')).toMatchObject({
      status: 'ready',
      skill: { id: 'travel-planning', name: '旅行规划', tools: ['public/plugin/weather/query'] }
    });
    expect(entries.find((entry: { name: string }) => entry.name === 'bare-skill')).toMatchObject({
      status: 'ready',
      skill: { id: 'bare-skill', name: '裸 Skill', tools: [] }
    });

    const publicSkills = core.listPublicSkills();
    const imported = await importSkill(base, headers, withMetadata, publicSkills.revision);
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toMatchObject({ kind: 'skill', id: 'travel-planning', target: { source: 'public' } });
    const after = core.listPublicSkills();
    expect(after.skills.find((skill) => skill.id === 'travel-planning')).toMatchObject({
      name: '旅行规划',
      enabled: false,
      tools: ['public/plugin/weather/query']
    });

    const bare = await importSkill(base, headers, bareDir, after.revision);
    expect(bare.status).toBe(200);
    expect(core.listPublicSkills().skills.find((skill) => skill.id === 'bare-skill')).toMatchObject({
      name: '裸 Skill',
      enabled: false
    });

    const stale = await importSkill(base, headers, withMetadata, publicSkills.revision);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('skill_conflict');

    const privateBefore = core.listPrivateSkills('10002');
    const privateImport = await importSkill(base, headers, withMetadata, privateBefore.revision, {
      source: 'private',
      accountId: '10002'
    });
    expect(privateImport.status).toBe(200);
    expect(core.listPrivateSkills('10002').skills.find((skill) => skill.id === 'travel-planning')).toMatchObject({
      enabled: false,
      source: 'private'
    });
    expect(core.listPrivateSkills('10001').skills).toHaveLength(0);
  });

  it('keeps unrelated scan entries when one package is invalid and rejects malformed manifests', async () => {
    const { base, headers, root } = await setup();
    await copyExample(root, 'plugins', 'weather');
    await writePlugin(root, 'no-manifest', { 'index.mjs': 'export const tools = {};\n' });
    await writePlugin(root, 'bad-version', {
      'manifest.json': manifest({ id: 'bad-version', apiVersion: 2 }),
      'index.mjs': 'export const tools = {};\n'
    });
    await writePlugin(root, 'bad-declarations', {
      'manifest.json': manifest({ id: 'bad-declarations', tools: 'nope' }),
      'index.mjs': 'export const tools = {};\n'
    });
    const entries = await imports(base, headers, 'plugin');
    expect(entries.find((entry: { name: string }) => entry.name === 'weather')).toMatchObject({ status: 'ready' });
    foreachInvalid(entries, ['no-manifest', 'bad-version', 'bad-declarations']);
    const bad = await request(base, headers, '/extensions/imports/preview', {
      method: 'POST',
      body: JSON.stringify({ kind: 'plugin', sourceDirectory: path.join(root, 'imports', 'plugins', 'bad-version') })
    });
    expect(bad.status).toBe(400);
  });

  it('imports a Skill with a missing tool reference without installing or authorizing it', async () => {
    const { core, base, headers, root } = await setup();
    const dir = path.join(root, 'imports', 'skills', 'missing-tool');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# 缺工具\n\n尝试使用不存在的工具。\n', 'utf8');
    await fs.writeFile(path.join(dir, 'skill.json'), `${JSON.stringify({
      id: 'missing-tool',
      name: '缺工具',
      tools: ['public/plugin/absent/query']
    }, null, 2)}\n`, 'utf8');

    const imported = await importSkill(base, headers, dir, core.listPublicSkills().revision);
    expect(imported.status).toBe(200);
    const view = await core.getExtensionPolicy('10001');
    await core.updateExtensionPolicy('10001', {
      expectedRevision: view.revision,
      expectedProfileRevision: view.profileRevision,
      patch: { defaults: { skills: { 'missing-tool': 'on' } } }
    });

    const preview = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: 'extension-test' });
    const entry = preview.skills.find((skill) => skill.id === 'missing-tool');
    expect(entry).toMatchObject({ enabled: false, selected: false });
    expect(entry?.issues).toContainEqual({ code: 'skill_tool_unavailable', detail: 'public/plugin/absent/query' });
    expect(entry?.unavailableTools).toContain('public/plugin/absent/query');
    expect((await core.getExtensionPolicy('10001')).authorizedTools).toEqual([]);
  });
});

function foreachInvalid(entries: Array<{ name: string; status: string; error?: string }>, names: string[]): void {
  for (const name of names) {
    const entry = entries.find((candidate) => candidate.name === name);
    expect(entry, name).toMatchObject({ status: 'invalid' });
    expect(entry?.error).toBeTruthy();
  }
}

describe('account extension configuration', () => {
  async function importedWeather() {
    const context = await setup();
    await copyExample(context.root, 'plugins', 'weather');
    const imported = await request(context.base, context.headers, '/extensions/imports', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'plugin',
        sourceDirectory: path.join(context.root, 'imports', 'plugins', 'weather'),
        target: { source: 'public' }
      })
    });
    expect(imported.status).toBe(200);
    await context.core.saveAccountProfile('10001', {
      version: 1,
      roleCard: { source: 'public', id: 'default', revision: 'r1' },
      plugins: [{ source: 'public', id: 'weather', revision: 'r1', enabled: true }]
    });
    await context.core.saveAccountProfile('10002', {
      version: 1,
      plugins: [{ source: 'public', id: 'weather', revision: 'r1', enabled: true }]
    });
    return context;
  }

  it('stores plugin config per account with an entry revision and preserves unrelated fields', async () => {
    const { core, base, headers } = await importedWeather();
    const id = 'public/plugin/weather';
    const initial = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ ok: true, kind: 'plugin', id, config: {} });

    const saved = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: initial.body.revision })
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ config: { city: '杭州' } });
    expect(saved.body.revision).not.toBe(initial.body.revision);

    const stale = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '上海' }, expectedRevision: initial.body.revision })
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('extension_config_conflict');

    const second = await request(base, headers, `/accounts/10002/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '上海' }, expectedRevision: initial.body.revision })
    });
    expect(second.status).toBe(200);
    expect((await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`)).body.config).toEqual({ city: '杭州' });
    expect((await request(base, headers, `/accounts/10002/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`)).body.config).toEqual({ city: '上海' });

    const profile = await core.getAccountProfile('10001');
    expect(profile).toMatchObject({
      version: 1,
      roleCard: { source: 'public', id: 'default', revision: 'r1' },
      plugins: [{ source: 'public', id: 'weather', revision: 'r1', enabled: true, config: { city: '杭州' } }]
    });

    const bad = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: saved.body.revision })
    });
    expect(bad.status).toBe(200);
    const arrayConfig = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: [], expectedRevision: bad.body.revision })
    });
    expect(arrayConfig.status).toBe(400);
  });

  it('keeps plugin config across a Core restart', async () => {
    const first = await importedWeather();
    const id = 'public/plugin/weather';
    const initial = await request(first.base, first.headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`);
    await request(first.base, first.headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: initial.body.revision })
    });
    await first.core.stop();
    cores.splice(cores.indexOf(first.core), 1);
    // Recreate the same data root and verify the value came from disk, not memory.
    const core = await createCore({
      dataRoot: first.root,
      instances: [],
      api: { enabled: true, port: 0, token: 'extension-access-fixture' },
      logger: silentLogger()
    });
    cores.push(core);
    await core.start();
    const base = core.status().apiUrl!;
    const headers = { authorization: 'Bearer extension-access-fixture', 'content-type': 'application/json' };
    const read = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(id)}`);
    expect(read.body.config).toEqual({ city: '杭州' });
    expect((await core.listPublicArtifacts()).some((artifact) => artifact.ref.id === 'weather')).toBe(true);
  });

  it('preserves other installed plugins and profile fields when one plugin config changes', async () => {
    const { core, base, headers, root } = await setup();
    await copyExample(root, 'plugins', 'weather');
    await writePlugin(root, 'clock', {
      'manifest.json': manifest({ id: 'clock' }),
      'index.mjs': 'export const tools = { run: async () => ({ status: "ok", text: "tick" }) };\n'
    });
    for (const name of ['weather', 'clock']) {
      const imported = await request(base, headers, '/extensions/imports', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'plugin',
          sourceDirectory: path.join(root, 'imports', 'plugins', name),
          target: { source: 'public' }
        })
      });
      expect(imported.status).toBe(200);
    }
    await core.saveAccountProfile('10001', {
      version: 1,
      roleCard: { source: 'public', id: 'default', revision: 'r1' },
      plugins: [
        { source: 'public', id: 'weather', revision: 'r1', enabled: true },
        { source: 'public', id: 'clock', revision: 'r1', enabled: false }
      ]
    });

    const weatherId = 'public/plugin/weather';
    const initial = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(weatherId)}`);
    const saved = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(weatherId)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: initial.body.revision })
    });
    expect(saved.status).toBe(200);

    const clockId = 'public/plugin/clock';
    const clockInitial = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(clockId)}`);
    expect(clockInitial.status).toBe(200);
    const clockSaved = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(clockId)}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { zone: 'local' }, expectedRevision: clockInitial.body.revision })
    });
    expect(clockSaved.status).toBe(200);

    const profile = await core.getAccountProfile('10001');
    expect(profile).toMatchObject({
      version: 1,
      roleCard: { source: 'public', id: 'default', revision: 'r1' },
      plugins: [
        { source: 'public', id: 'weather', revision: 'r1', enabled: true, config: { city: '杭州' } },
        { source: 'public', id: 'clock', revision: 'r1', enabled: false, config: { zone: 'local' } }
      ]
    });
  });

  it('serializes concurrent plugin config writes and preserves Skill configs across definition edits', async () => {
    const { core, base, headers } = await importedWeather();
    const pluginId = 'public/plugin/weather';
    const current = await request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(pluginId)}`);
    const [left, right] = await Promise.all([
      request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(pluginId)}`, {
        method: 'PUT',
        body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: current.body.revision })
      }),
      request(base, headers, `/accounts/10001/extensions/config?kind=plugin&id=${encodeURIComponent(pluginId)}`, {
        method: 'PUT',
        body: JSON.stringify({ config: { city: '苏州' }, expectedRevision: current.body.revision })
      })
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);

    const publicSkills = core.listPublicSkills();
    await core.savePublicSkill({
      id: 'config-skill',
      name: '配置测试',
      instructions: '正文',
      tools: []
    }, publicSkills.revision);
    const skillId = 'config-skill';
    const initial = await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`);
    expect(initial.body).toMatchObject({ config: {} });
    const saved = await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州', language: '中文' }, expectedRevision: initial.body.revision })
    });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toEqual({ city: '杭州', language: '中文' });

    const beforeEdit = core.listPublicSkills();
    await core.savePublicSkill({
      id: 'config-skill',
      name: '配置测试 2',
      instructions: '新的正文',
      tools: []
    }, beforeEdit.revision);
    expect((await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`)).body.config).toEqual({
      city: '杭州',
      language: '中文'
    });

    const beforeDelete = core.listPublicSkills();
    await core.deletePublicSkill('config-skill', beforeDelete.revision);
    expect((await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`)).body.config).toEqual({
      city: '杭州',
      language: '中文'
    });

    const orphan = await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`);
    const cleared = await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`, {
      method: 'PUT',
      body: JSON.stringify({ config: {}, expectedRevision: orphan.body.revision })
    });
    expect(cleared.status).toBe(200);
    expect((await request(base, headers, `/accounts/10001/extensions/config?kind=skill&id=${skillId}`)).body.config).toEqual({});
  });

  it('applies one account config to the effective private override', async () => {
    const { core } = await setup();
    const publicSkills = core.listPublicSkills();
    await core.savePublicSkill({
      id: 'override-skill',
      name: '公用版本',
      instructions: 'PUBLIC_INSTRUCTIONS',
      tools: []
    }, publicSkills.revision);
    const privateBefore = core.listPrivateSkills('10001');
    await core.savePrivateSkill('10001', {
      id: 'override-skill',
      name: '私有版本',
      instructions: 'PRIVATE_INSTRUCTIONS',
      tools: []
    }, privateBefore.revision);
    const configPath = '/accounts/10001/extensions/config?kind=skill&id=override-skill';
    const current = await request(core.status().apiUrl!, { authorization: 'Bearer extension-access-fixture', 'content-type': 'application/json' }, configPath);
    const saved = await request(core.status().apiUrl!, { authorization: 'Bearer extension-access-fixture', 'content-type': 'application/json' }, configPath, {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: current.body.revision })
    });
    expect(saved.status).toBe(200);
    const preview = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: 'extension-test' });
    const entry = preview.skills.find((skill) => skill.id === 'override-skill');
    expect(entry).toMatchObject({
      source: 'private',
      overrides: 'public',
      config: { city: '杭州' }
    });
    expect(entry?.renderedInstructions).toContain('PRIVATE_INSTRUCTIONS');
    expect(entry?.renderedInstructions).not.toContain('PUBLIC_INSTRUCTIONS');
    expect(entry?.renderedInstructions).toContain('"city":"杭州"');
  });

  it('counts Skill config in the injection budget and reports exclusion', async () => {
    const { core, base, headers } = await setup();
    const publicSkills = core.listPublicSkills();
    await core.savePublicSkill({
      id: 'long-config',
      name: '长配置',
      instructions: 'x'.repeat(200),
      tools: []
    }, publicSkills.revision);
    const configPath = '/accounts/10001/extensions/config?kind=skill&id=long-config';
    const initial = await request(base, headers, configPath);
    const saved = await request(base, headers, configPath, {
      method: 'PUT',
      body: JSON.stringify({ config: { blob: 'y'.repeat(7_900) }, expectedRevision: initial.body.revision })
    });
    expect(saved.status).toBe(200);
    const preview = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: 'extension-test' });
    const entry = preview.skills.find((skill) => skill.id === 'long-config');
    expect(entry).toMatchObject({ enabled: true, selected: false, selectionReason: 'instructions_too_long' });
    expect(entry!.instructionsChars).toBeGreaterThan(8_000);
    expect(preview.included).not.toContain('long-config');
    expect(preview.excluded).toContainEqual({ id: 'long-config', reason: 'instructions_too_long' });
  });

  it('reads and writes Skill ids that collide with Object.prototype names without affecting siblings', async () => {
    const { core, base, headers } = await setup();
    let revision = core.listPublicSkills().revision;
    for (const id of ['constructor', 'toString']) {
      await core.savePublicSkill({
        id,
        name: `原型名 ${id}`,
        instructions: '合法标识必须按自有键读取。',
        tools: [],
        enabled: true
      }, revision);
      revision = core.listPublicSkills().revision;
    }
    await core.savePublicSkill({
      id: 'safe-skill',
      name: '安全 Skill',
      instructions: '不受其他配置键影响。',
      tools: [],
      enabled: true
    }, revision);

    const initial = await request(base, headers, '/accounts/10001/extensions/config?kind=skill&id=constructor');
    expect(initial.status).toBe(200);
    expect(initial.body.config).toEqual({});
    const saved = await request(base, headers, '/accounts/10001/extensions/config?kind=skill&id=constructor', {
      method: 'PUT',
      body: JSON.stringify({ config: { city: '杭州' }, expectedRevision: initial.body.revision })
    });
    expect(saved.status).toBe(200);
    const preview = await core.previewSkills('10001', { accountId: '10001', kind: 'private', peerId: 'extension-test' });
    expect(preview.skills.find((skill) => skill.id === 'constructor')).toMatchObject({ config: { city: '杭州' } });
    expect(preview.skills.find((skill) => skill.id === 'toString')).not.toHaveProperty('config');
    expect(preview.skills.find((skill) => skill.id === 'safe-skill')).not.toHaveProperty('config');

    const cleared = await request(base, headers, '/accounts/10001/extensions/config?kind=skill&id=constructor', {
      method: 'PUT',
      body: JSON.stringify({ config: {}, expectedRevision: saved.body.revision })
    });
    expect(cleared.status).toBe(200);
    const readAgain = await request(base, headers, '/accounts/10001/extensions/config?kind=skill&id=constructor');
    expect(readAgain.body.config).toEqual({});
  });
});
