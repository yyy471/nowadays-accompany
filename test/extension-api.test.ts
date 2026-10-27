import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestCore } from './helpers.js';
import { silentLogger } from '../src/core/logger.js';
import type { Core } from '../src/core/core.js';

const roots: string[] = [];
const cores: Core[] = [];

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).map((core) => core.stop()));
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('nowadays-extension-api-')) {
      throw new Error('Unexpected test root');
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

const PLUGIN_ID = 'demo';
const PLUGIN_KEY = `public/plugin/${PLUGIN_ID}`;
const PLUGIN_TOOL = `${PLUGIN_KEY}/query`;
const SECRET = 'DO_NOT_LEAK_PLUGIN_CONFIG';

async function writePluginArtifact(root: string): Promise<void> {
  const dir = path.join(root, 'public', 'artifacts', 'plugin', PLUGIN_ID, 'r1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.mjs'), 'export default {};\n', 'utf8');
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: PLUGIN_ID,
    kind: 'plugin',
    revision: 'r1',
    entry: 'index.mjs',
    apiVersion: 1,
    tools: [{
      id: 'query',
      description: 'Looks up deterministic local data.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      effect: 'read',
      timeoutMs: 1_000,
      maxArgumentBytes: 4_096,
      maxResultBytes: 4_096
    }],
    state: { version: '1', accountShared: true }
  }, null, 2) + '\n', 'utf8');
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nowadays-extension-api-'));
  roots.push(root);
  const uiDir = path.join(root, 'ui');
  await fs.mkdir(uiDir, { recursive: true });
  await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><div id="root">fixture</div>\n', 'utf8');
  const core = await createTestCore({
    dataRoot: root,
    instances: [],
    api: { enabled: true, port: 0, token: 'extension-fixture', uiDir },
    logger: silentLogger()
  }, ['10001', '10002']);
  cores.push(core);
  await writePluginArtifact(root);
  await core.saveAccountProfile('10001', {
    version: 1,
    roleCard: { source: 'public', id: 'default', revision: 'r1' },
    plugins: [{ source: 'public', id: PLUGIN_ID, revision: 'r1', config: { secret: SECRET } }]
  });
  await core.start();
  const headers = { authorization: 'Bearer extension-fixture', 'content-type': 'application/json' };
  const base = core.status().apiUrl!;
  return { core, headers, base };
}

async function request(base: string, headers: Record<string, string>, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${pathname}`, { ...init, headers });
  return { status: response.status, body: await response.json() as any };
}

it('serves the extension catalog, CAS patches and scoped effective state', async () => {
  const { headers, base } = await setup();
  const ui = await fetch(`${base}/`);
  expect(ui.status).toBe(200);
  expect(await ui.text()).toContain('fixture');
  const publicSkills = await request(base, headers, '/skills');
  expect(publicSkills.status).toBe(200);
  expect(publicSkills.body).toMatchObject({ ok: true, skills: [] });

  const initial = await request(base, headers, '/accounts/10001/extensions');
  expect(initial.status).toBe(200);
  expect(initial.body.extensions).toMatchObject({
    accountId: '10001',
    authorizedTools: [],
    defaults: {},
    byKind: {},
    byConversation: {},
    runtime: { synced: false, readyPlugins: [], readyTools: [], plugins: [] }
  });
  expect(initial.body.extensions.catalog.plugins).toEqual([
    expect.objectContaining({ key: PLUGIN_KEY, source: 'public', id: PLUGIN_ID, revision: 'r1', accountSharedState: true })
  ]);
  expect(initial.body.extensions.catalog.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: PLUGIN_TOOL, handlerReady: false, pluginKey: PLUGIN_KEY }),
    expect.objectContaining({ id: 'builtin.image.generate' }),
    expect.objectContaining({ id: 'builtin.audio.generate' })
  ]));
  expect(JSON.stringify(initial.body.extensions)).not.toContain(SECRET);

  const revision = initial.body.extensions.revision as string;
  expect(revision).toMatch(/^[a-f0-9]{16}$/);

  const saved = await request(base, headers, '/accounts/10001/extensions/policy', {
    method: 'PUT',
    body: JSON.stringify({
      expectedRevision: revision,
      expectedProfileRevision: initial.body.extensions.profileRevision,
      patch: {
        authorizedTools: ['builtin.image.generate', PLUGIN_TOOL],
        defaults: { tools: { 'builtin.image.generate': 'off' }, state: { [PLUGIN_KEY]: 'on' } },
        byKind: { private: { tools: { 'builtin.image.generate': 'on' } } },
        byConversation: { 'private/555': { tools: { 'builtin.image.generate': 'off' } } }
      }
    })
  });
  expect(saved.status).toBe(200);
  expect(saved.body.extensions.authorizedTools).toEqual(['builtin.image.generate', PLUGIN_TOOL]);
  expect(saved.body.extensions.defaults.state).toEqual({ [PLUGIN_KEY]: 'on' });
  expect(saved.body.extensions.revision).not.toBe(revision);

  const stale = await request(base, headers, '/accounts/10001/extensions/policy', {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision: revision, patch: { defaults: {} } })
  });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('extension_conflict');

  const invalidTool = await request(base, headers, '/accounts/10001/extensions/policy', {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision: saved.body.extensions.revision, patch: { authorizedTools: ['builtin.missing'] } })
  });
  expect(invalidTool.status).toBe(400);

  const conversation = await request(base, headers, '/accounts/10001/extensions/effective?kind=private&peerId=555');
  expect(conversation.status).toBe(200);
  const conversationTool = conversation.body.effective.tools.find((tool: { tool: { id: string } }) => tool.tool.id === 'builtin.image.generate');
  expect(conversationTool).toMatchObject({
    authorized: true,
    switchSource: 'conversation',
    issues: expect.arrayContaining([{ code: 'switch_off' }, { code: 'capability_unavailable', detail: 'image.generate' }])
  });
  expect(conversation.body.effective.tools.find((tool: { tool: { id: string } }) => tool.tool.id === PLUGIN_TOOL)).toMatchObject({
    authorized: true,
    switchSource: 'default',
    issues: expect.arrayContaining([{ code: 'handler_not_ready' }])
  });
  expect(conversation.body.effective.states).toEqual([
    { pluginKey: PLUGIN_KEY, accountSharedState: true, enabled: true, switchSource: 'account' }
  ]);

  const otherPeer = await request(base, headers, '/accounts/10001/extensions/effective?kind=private&peerId=666');
  expect(otherPeer.body.effective.tools.find((tool: { tool: { id: string } }) => tool.tool.id === 'builtin.image.generate'))
    .toMatchObject({ switchSource: 'kind' });

  const cleared = await request(base, headers, '/accounts/10001/extensions/policy', {
    method: 'PUT',
    body: JSON.stringify({
      expectedRevision: saved.body.extensions.revision,
      patch: { byConversation: { 'private/555': { tools: { 'builtin.image.generate': 'inherit' } } } }
    })
  });
  expect(cleared.status).toBe(200);
  expect(cleared.body.extensions.byConversation).toEqual({});

  // The model page still sends a full AccountPolicy; it must not overwrite extension state.
  const modelSave = await request(base, headers, '/accounts/10001/policy', {
    method: 'PUT',
    body: JSON.stringify({
      policy: {
        allowedProviders: [],
        crossProviderFallback: false,
        media: { allowCloudUpload: false },
        extensions: {
          authorizedTools: ['builtin.audio.generate'],
          defaults: { tools: { 'builtin.image.generate': 'off' } },
          byKind: {},
          byConversation: {}
        }
      }
    })
  });
  expect(modelSave.status).toBe(200);
  expect(modelSave.body.policy.extensions).toMatchObject({
    authorizedTools: ['builtin.image.generate', PLUGIN_TOOL],
    defaults: { tools: { 'builtin.image.generate': 'off' }, state: { [PLUGIN_KEY]: 'on' } }
  });
  const preserved = await request(base, headers, '/accounts/10001/extensions');
  expect(preserved.body.extensions.authorizedTools).toEqual(['builtin.image.generate', PLUGIN_TOOL]);
  expect(preserved.body.extensions.defaults.state).toEqual({ [PLUGIN_KEY]: 'on' });

  const missingScope = await request(base, headers, '/accounts/10001/extensions/effective');
  expect(missingScope.status).toBe(400);
  expect(missingScope.body.code).toBe('invalid_scope');

  const missingRevision = await request(base, headers, '/accounts/10001/extensions/policy', {
    method: 'PUT',
    body: JSON.stringify({ patch: {} })
  });
  expect(missingRevision.status).toBe(400);
  expect(missingRevision.body.code).toBe('invalid_revision');
});

it('reloads the account runtime explicitly and reports the new status without replaying work', async () => {
  const { headers, base } = await setup();
  const before = await request(base, headers, '/accounts/10002/extensions');
  expect(before.body.extensions.runtime.synced).toBe(false);

  const reloaded = await request(base, headers, '/accounts/10002/extensions/reload', { method: 'POST' });
  expect(reloaded.status).toBe(200);
  expect(reloaded.body.reload.plugins).toEqual([]);

  const after = await request(base, headers, '/accounts/10002/extensions');
  expect(after.body.extensions.runtime).toMatchObject({ synced: true, readyPlugins: [], plugins: [] });
});
